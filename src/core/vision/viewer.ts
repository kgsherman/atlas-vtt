/**
 * Per-viewer caches and perception grading (docs/ARCHITECTURE.md §5.2 "Perception" and "Caches").
 *
 * ViewerState holds, for one viewer (token):
 *  - `los`: line of sight per sample (0 untested, 1 blocked, 2 seen), valid for the viewer's eye and
 *    the occlusion state it was tested against. Only samples that could be perceived (lit, or within
 *    darkvision / blindsight range) are ever tested, so darkness is cheap. Occluder changes reset the
 *    entries whose segment crosses a dirty box.
 *  - `grades`: perception grade per sample; `cellGrades` / `cellMask`: per cell grade and, for cells
 *    whose samples disagree (some perceived, some not), the 4×4 sub-cell mask of perceived sub-cells.
 *  - `subLos`: line of sight of refined sub-cell centres.
 * Cells are re-evaluated only when their light changed (LightField.cellVersion) or their LOS was
 * invalidated.
 */
import type { AABB3 } from "../geometry/box"
import { createInterval, lineAABB3 } from "../geometry/ray"
import type { OcclusionWorld } from "../occlusion/types"
import type { Id, Vec3 } from "../scene/types"
import { BlockerCache, hitEntersContaining } from "./blockers"
import type { LightField } from "./lightField"
import { SAMPLE_DX, SAMPLE_DZ, SUBS_PER_CELL, type InsideInfo, type SampleLayout } from "./layout"
import { FULL_SUBMASK } from "./mask"
import { SAMPLES_PER_CELL, SUBCELLS, type Perception, type Viewer } from "./types"

const LOS_UNTESTED = 0
const LOS_BLOCKED = 1
const LOS_SEEN = 2
/** A side probe sits this far in front of the point where the ray enters the buried sample's blocker. */
export const PROBE_PULLBACK = 0.1
/** Dirty boxes are inflated by this margin (feet) before invalidating line-of-sight entries. */
const DIRTY_MARGIN = 0.01
/** Beyond this many pending dirty boxes a viewer's line of sight is simply recomputed. */
const MAX_PENDING_BOXES = 48

interface SubLos {
  los: Uint8Array
  /** Effective distance of buried sub-cell points (probe distance). */
  dist: Float64Array
}

export interface PendingChanges {
  boxes: AABB3[]
  /** Samples whose position or blocker status changed. */
  samples: number[]
  /** Cells whose sub-cell layout was rebuilt. */
  cells: number[]
}

export class ViewerState {
  readonly tokenId: Id
  levelId: Id = ""
  eye: Vec3 = { x: 0, y: 0, z: 0 }
  darkvision = 0
  blindsight = 0
  blind = false
  footprint: ReadonlySet<number> = new Set()
  /** Eye + level: validity key of the line-of-sight entries. */
  eyeKey = ""
  /** eyeKey + senses + footprint: validity key of the grades. */
  gradeKey = ""
  readonly los: Uint8Array
  readonly probeDist = new Map<number, number>()
  readonly grades: Uint8Array
  readonly cellGrades: Uint8Array
  readonly cellMask = new Map<number, number>()
  readonly subLos = new Map<number, SubLos>()
  lightVersion = 0
  evaluated = false
  pending: PendingChanges = { boxes: [], samples: [], cells: [] }
  readonly dirty = new Set<number>()
  lastUsed = 0

  constructor(tokenId: Id, nSamples: number, nCells: number) {
    this.tokenId = tokenId
    this.los = new Uint8Array(nSamples)
    this.grades = new Uint8Array(nSamples)
    this.cellGrades = new Uint8Array(nCells)
  }

  /** Forget line of sight (the eye moved). */
  resetLos(): void {
    this.los.fill(0)
    this.probeDist.clear()
    this.subLos.clear()
    this.pending = { boxes: [], samples: [], cells: [] }
    this.dirty.clear()
    this.evaluated = false
  }

  configure(v: Viewer, footprint: ReadonlySet<number>, eyeKey: string, gradeKey: string): void {
    if (eyeKey !== this.eyeKey) this.resetLos()
    else if (gradeKey !== this.gradeKey) this.evaluated = false
    this.eyeKey = eyeKey
    this.gradeKey = gradeKey
    this.levelId = v.levelId
    this.eye = { x: v.eye.x, y: v.eye.y, z: v.eye.z }
    this.darkvision = Math.max(0, v.vision.darkvision || 0)
    this.blindsight = Math.max(0, v.vision.blindsight || 0)
    this.blind = !!v.vision.blind
    this.footprint = footprint
  }
}

/** Sub-cell bit(s) that contain sample k (the centre sample sits on the 4 central sub-cells). */
function sampleSubmasks(cellSize: number, offset: number): number[] {
  const q = cellSize / SUBCELLS
  const out: number[] = []
  for (let k = 0; k < SAMPLES_PER_CELL; k++) {
    if (k === 0) {
      const lo = SUBCELLS / 2 - 1
      const hi = SUBCELLS / 2
      out.push((1 << (lo * SUBCELLS + lo)) | (1 << (lo * SUBCELLS + hi)) | (1 << (hi * SUBCELLS + lo)) | (1 << (hi * SUBCELLS + hi)))
      continue
    }
    const sx = Math.min(SUBCELLS - 1, Math.max(0, Math.floor((cellSize / 2 + SAMPLE_DX[k] * offset) / q)))
    const sz = Math.min(SUBCELLS - 1, Math.max(0, Math.floor((cellSize / 2 + SAMPLE_DZ[k] * offset) / q)))
    out.push(1 << (sz * SUBCELLS + sx))
  }
  return out
}

const interval = createInterval()

function segmentMeetsBox(a: Vec3, bx: number, by: number, bz: number, box: AABB3): boolean {
  const m = DIRTY_MARGIN
  if (
    !lineAABB3(a.x, a.y, a.z, bx - a.x, by - a.y, bz - a.z, box.minX - m, box.minY - m, box.minZ - m, box.maxX + m, box.maxY + m, box.maxZ + m, interval)
  ) {
    return false
  }
  return interval.t1 >= 0 && interval.t0 <= 1
}

export class Evaluator {
  private readonly world: OcclusionWorld
  private readonly layout: SampleLayout
  private readonly light: LightField
  private readonly sight: BlockerCache
  private readonly subOfSample: number[]
  private readonly p: Vec3 = { x: 0, y: 0, z: 0 }
  private outLos = 0
  private outDist = 0

  constructor(world: OcclusionWorld, layout: SampleLayout, light: LightField) {
    this.world = world
    this.layout = layout
    this.light = light
    this.sight = new BlockerCache(world, "sight")
    this.subOfSample = sampleSubmasks(layout.cellSize, layout.offset)
  }

  /** Bring a viewer's caches up to date with the light field and occluders. */
  sync(st: ViewerState): void {
    this.applyPending(st)
    const nCells = this.layout.nCells
    if (!st.evaluated) {
      for (let g = 0; g < nCells; g++) this.evalCell(st, g)
      st.evaluated = true
    } else {
      const versions = this.light.cellVersion
      const since = st.lightVersion
      for (let g = 0; g < nCells; g++) {
        if (versions[g] > since) {
          this.evalCell(st, g)
          st.dirty.delete(g)
        }
      }
      for (const g of st.dirty) this.evalCell(st, g)
    }
    st.dirty.clear()
    st.lightVersion = this.light.version
  }

  /** Reset line-of-sight entries invalidated by occluder / layout changes since the last sync. */
  private applyPending(st: ViewerState): void {
    const { boxes, samples, cells } = st.pending
    if (boxes.length === 0 && samples.length === 0 && cells.length === 0) return
    st.pending = { boxes: [], samples: [], cells: [] }
    if (boxes.length > MAX_PENDING_BOXES) {
      st.resetLos()
      return
    }
    const L = this.layout
    const eye = st.eye
    for (const s of samples) {
      st.los[s] = LOS_UNTESTED
      st.probeDist.delete(s)
      st.dirty.add(Math.floor(s / SAMPLES_PER_CELL))
    }
    for (const g of cells) {
      st.subLos.delete(g)
      st.dirty.add(g)
    }
    if (boxes.length === 0) return
    const los = st.los
    for (let s = 0; s < los.length; s++) {
      if (los[s] === LOS_UNTESTED) continue
      const x = L.sampleX(s)
      const y = L.y[s]
      const z = L.sampleZ(s)
      const top = L.insideOf(s)?.top
      for (const box of boxes) {
        if (segmentMeetsBox(eye, x, y, z, box) || (top && segmentMeetsBox(eye, top.x, top.y, top.z, box))) {
          los[s] = LOS_UNTESTED
          st.probeDist.delete(s)
          st.dirty.add(Math.floor(s / SAMPLES_PER_CELL))
          break
        }
      }
    }
    for (const [g, entry] of st.subLos) {
      const sub = L.subLayout(g)
      for (let q = 0; q < SUBS_PER_CELL; q++) {
        if (entry.los[q] === LOS_UNTESTED) continue
        const x = L.subX(g, q)
        const z = L.subZ(g, q)
        const top = sub.inside[q]?.top
        for (const box of boxes) {
          if (segmentMeetsBox(eye, x, sub.y[q], z, box) || (top && segmentMeetsBox(eye, top.x, top.y, top.z, box))) {
            entry.los[q] = LOS_UNTESTED
            st.dirty.add(g)
            break
          }
        }
      }
    }
  }

  /** Grade a viewer could have at light level L and distance d, before line of sight. */
  private candidate(st: ViewerState, L: number, d: number): Perception {
    if (!st.blind && L >= 1) return 3
    if (!st.blind && d <= st.darkvision) return 2
    if (d <= st.blindsight) return 1
    return 0
  }

  /**
   * Distance from the eye at which a buried point is seen (side probe: the ray's first hit is one
   * of the blockers containing it; else the top probe), or −1 when it is not seen.
   */
  private buriedDistance(st: ViewerState, x: number, y: number, z: number, ins: InsideInfo): number {
    const eye = st.eye
    const p = this.p
    p.x = x
    p.y = y
    p.z = z
    const len = Math.hypot(x - eye.x, y - eye.y, z - eye.z)
    const hit = this.world.raycast(eye, p, { channel: "sight" })
    if (hit === null) return len
    if (hitEntersContaining(this.world, eye, p, hit, ins.sight, "sight")) return Math.max(0, hit.t * len - PROBE_PULLBACK)
    const top = ins.top
    if (top !== null && !this.sight.blocked(eye, top)) return Math.hypot(top.x - eye.x, top.y - eye.y, top.z - eye.z)
    return -1
  }

  /**
   * Grade of a point for a viewer given its light level, cached line-of-sight state `los` and cached
   * effective distance `dist` (buried points). The updated cache values are left in outLos / outDist.
   */
  private gradeAt(st: ViewerState, x: number, y: number, z: number, L: number, ins: InsideInfo | null, los: number, dist: number): Perception {
    this.outLos = los
    this.outDist = dist
    const eye = st.eye
    if (ins === null || ins.sight.size === 0) {
      const c = this.candidate(st, L, Math.hypot(x - eye.x, y - eye.y, z - eye.z))
      if (c === 0) return 0
      if (los === LOS_UNTESTED) {
        const p = this.p
        p.x = x
        p.y = y
        p.z = z
        los = this.sight.blocked(eye, p) ? LOS_BLOCKED : LOS_SEEN
        this.outLos = los
      }
      return los === LOS_SEEN ? c : 0
    }
    // Buried: the effective distance is only known after the probes, so test first when anything
    // could be perceived at all.
    if (!(L >= 1 && !st.blind) && st.darkvision <= 0 && st.blindsight <= 0) return 0
    if (los === LOS_UNTESTED) {
      dist = this.buriedDistance(st, x, y, z, ins)
      los = dist < 0 ? LOS_BLOCKED : LOS_SEEN
      this.outLos = los
      this.outDist = dist
    }
    return los === LOS_SEEN ? this.candidate(st, L, dist) : 0
  }

  private gradeSample(st: ViewerState, s: number): Perception {
    const L = this.layout
    if (!L.valid[s]) return 0
    const ins = L.insideOf(s)
    const g = this.gradeAt(st, L.sampleX(s), L.y[s], L.sampleZ(s), this.light.level(s), ins, st.los[s], ins ? (st.probeDist.get(s) ?? 0) : 0)
    st.los[s] = this.outLos
    if (ins !== null && this.outLos === LOS_SEEN) st.probeDist.set(s, this.outDist)
    return g
  }

  /** Sub-cell refinement of a cell: mask of perceived sub-cells and their best grade. */
  private refine(st: ViewerState, g: number): { mask: number; grade: Perception } {
    const L = this.layout
    const sub = L.subLayout(g)
    const levels = this.light.subLevels(g)
    let entry = st.subLos.get(g)
    if (!entry) {
      entry = { los: new Uint8Array(SUBS_PER_CELL), dist: new Float64Array(SUBS_PER_CELL) }
      st.subLos.set(g, entry)
    }
    let mask = 0
    let grade: Perception = 0
    for (let q = 0; q < SUBS_PER_CELL; q++) {
      if (!sub.valid[q]) continue
      const gr = this.gradeAt(st, L.subX(g, q), sub.y[q], L.subZ(g, q), levels[q], sub.inside[q], entry.los[q], entry.dist[q])
      entry.los[q] = this.outLos
      entry.dist[q] = this.outDist
      if (gr > 0) {
        mask |= 1 << q
        if (gr > grade) grade = gr
      }
    }
    return { mask, grade }
  }

  private evalCell(st: ViewerState, g: number): void {
    const base = g * SAMPLES_PER_CELL
    let grade: Perception = 0
    let seen = 0
    let unseen = 0
    let sampleMask = 0
    for (let k = 0; k < SAMPLES_PER_CELL; k++) {
      const gr = this.gradeSample(st, base + k)
      st.grades[base + k] = gr
      if (gr > 0) {
        seen++
        sampleMask |= this.subOfSample[k]
        if (gr > grade) grade = gr
      } else {
        unseen++
      }
    }
    // Uniform unless the samples disagree between perceived and not perceived.
    let mask = -1
    if (seen > 0 && unseen > 0) {
      const r = this.refine(st, g)
      if (r.grade > grade) grade = r.grade
      mask = r.mask === 0 ? sampleMask : r.mask
      if (mask === FULL_SUBMASK) mask = -1
    } else {
      st.subLos.delete(g)
    }
    // Every viewer perceives its own footprint at least by touch.
    if (st.footprint.has(g)) {
      if (grade < 1) grade = 1
      mask = -1
    }
    st.cellGrades[g] = grade
    if (grade > 0 && mask >= 0) st.cellMask.set(g, mask)
    else st.cellMask.delete(g)
  }

  /**
   * Whether a viewer perceives an arbitrary point (token test points): same grading rules, with
   * `lightAt` evaluated only when light matters.
   */
  perceivesPoint(st: ViewerState, p: Vec3, lightAt: () => number): boolean {
    const eye = st.eye
    const d = Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z)
    const inRange = (!st.blind && d <= st.darkvision) || d <= st.blindsight
    if (!inRange && (st.blind || lightAt() < 1)) return false
    return !this.sight.blocked(eye, p)
  }
}
