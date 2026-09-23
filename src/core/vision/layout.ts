/**
 * Viewer-independent sample layout (docs/ARCHITECTURE.md §5.2 "Samples").
 *
 * Every (level, cell) has SAMPLES_PER_CELL samples: the centre and 4 points inset
 * VISION_SAMPLE_INSET from the cell edges, at the sampleable surface + VISION_SAMPLE_HEIGHT.
 * Indices: global cell g = levelIndex·(width·depth) + j·width + i; sample s = g·5 + k with
 * k = 0 centre, 1 (−x,−z), 2 (+x,−z), 3 (−x,+z), 4 (+x,+z).
 *
 * Samples that lie inside a sight or light blocker P keep the keys of the containing primitives
 * (the side-probe rule: a ray whose FIRST hit is P reaches the sample's surface) and a top probe
 * `top(P) + 0.25` when that point is free and below the next ceiling.
 *
 * Sub-cell layouts (4×4 lattice of sub-cell centres, bit = sz·4 + sx) are built lazily for cells
 * that need refinement.
 */
import { primitiveTopAt } from "../occlusion/primitives"
import type { OccluderPrimitive, OcclusionWorld } from "../occlusion/types"
import type { Id, Vec3 } from "../scene/types"
import type { SceneIndex } from "./sceneIndex"
import { SAMPLES_PER_CELL, SUBCELLS, VISION_SAMPLE_HEIGHT, VISION_SAMPLE_INSET } from "./types"

/** Sign of the X / Z offset of sample k (k = 0 is the centre). */
export const SAMPLE_DX: readonly number[] = [0, -1, 1, -1, 1]
export const SAMPLE_DZ: readonly number[] = [0, -1, -1, 1, 1]
/** Height of a top probe above the top of the blocker a sample is buried in (feet). */
export const TOP_PROBE_HEIGHT = 0.25
/** Stacked blockers climbed at most this many times when placing a top probe. */
const TOP_PROBE_CLIMBS = 4
export const SUBS_PER_CELL = SUBCELLS * SUBCELLS

export interface InsideInfo {
  /** Keys of the sight blockers containing the point. */
  sight: ReadonlySet<string>
  /** Keys of the light blockers containing the point. */
  light: ReadonlySet<string>
  /** Top probe (free point above the blocker stack, below the next ceiling), if any. */
  top: Vec3 | null
}

export interface SubLayout {
  /** 1 = the sub-cell centre is on a sampleable surface. */
  valid: Uint8Array
  y: Float64Array
  inside: (InsideInfo | null)[]
}

const EMPTY: ReadonlySet<string> = new Set()

const isSlab = (p: OccluderPrimitive): boolean => p.sourceType === "floor" || p.sourceType === "terrain"

/**
 * Top probe for a point buried in `stack` (its containing sight blockers): climb to the top of the
 * stack (+0.25, repeatedly while the probe is inside another blocker), fail if the climb reaches a
 * floor slab or the column from the point to the probe crosses anything else (a ceiling).
 */
function topProbe(world: OcclusionWorld, x: number, y: number, z: number, stack: OccluderPrimitive[]): Vec3 | null {
  const climbed = new Set<Id>()
  let top = -Infinity
  for (const p of stack) {
    if (isSlab(p)) return null
    const t = primitiveTopAt(p, x, z)
    if (t !== null && t > top) top = t
    climbed.add(p.sourceId)
  }
  if (top === -Infinity) return null
  const probe = { x, y: top + TOP_PROBE_HEIGHT, z }
  for (let climb = 0; ; climb++) {
    const inside = world.containing(probe, "sight")
    if (inside.length === 0) break
    if (climb >= TOP_PROBE_CLIMBS) return null
    let next = -Infinity
    for (const p of inside) {
      if (isSlab(p)) return null
      const t = primitiveTopAt(p, x, z)
      if (t !== null && t > next) next = t
      climbed.add(p.sourceId)
    }
    if (next === -Infinity) return null
    probe.y = next + TOP_PROBE_HEIGHT
  }
  if (world.segmentBlocked({ x, y, z }, probe, { channel: "sight", ignoreSourceIds: climbed })) return null
  return probe
}

/** Blockers containing a point, or null when it is free (for sight and light). */
export function insideInfoAt(world: OcclusionWorld, x: number, y: number, z: number): InsideInfo | null {
  const prims = world.containing({ x, y, z })
  if (prims.length === 0) return null
  const stack: OccluderPrimitive[] = []
  const light = new Set<string>()
  for (const p of prims) {
    if (p.blocks.sight) stack.push(p)
    if (p.blocks.light) light.add(p.key)
  }
  if (stack.length === 0 && light.size === 0) return null
  return {
    sight: stack.length > 0 ? new Set(stack.map((p) => p.key)) : EMPTY,
    light: light.size > 0 ? light : EMPTY,
    top: stack.length > 0 ? topProbe(world, x, y, z, stack) : null,
  }
}

function sameKeys(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const k of a) if (!b.has(k)) return false
  return true
}

function sameInside(a: InsideInfo | null | undefined, b: InsideInfo | null | undefined): boolean {
  if (!a || !b) return !a && !b
  if (!sameKeys(a.sight, b.sight) || !sameKeys(a.light, b.light)) return false
  if (!a.top || !b.top) return !a.top && !b.top
  return a.top.y === b.top.y
}

export class SampleLayout {
  readonly width: number
  readonly depth: number
  readonly cellSize: number
  readonly nLevels: number
  readonly cellsPerLevel: number
  readonly nCells: number
  readonly nSamples: number
  /** Offset of the 4 outer samples from the cell centre (feet). */
  readonly offset: number
  /** 1 = sampleable. */
  readonly valid: Uint8Array
  /** World Y of each sample (surface + VISION_SAMPLE_HEIGHT). */
  readonly y: Float64Array
  /** Samples buried in blockers (with `buried[s] = 1`, a cheap pre-check for the hot loops). */
  readonly inside = new Map<number, InsideInfo>()
  readonly buried: Uint8Array
  /** Per level: conservative min / max Y of its samples and top probes (Infinity / −Infinity when empty). */
  readonly minY: Float64Array
  readonly maxY: Float64Array
  private readonly subs = new Map<number, SubLayout>()
  private readonly index: SceneIndex
  private readonly world: OcclusionWorld

  constructor(index: SceneIndex, world: OcclusionWorld) {
    this.index = index
    this.world = world
    this.width = index.grid.width
    this.depth = index.grid.depth
    this.cellSize = index.grid.cellSize
    this.nLevels = index.levels.length
    this.cellsPerLevel = this.width * this.depth
    this.nCells = this.cellsPerLevel * this.nLevels
    this.nSamples = this.nCells * SAMPLES_PER_CELL
    this.offset = Math.max(0, this.cellSize / 2 - VISION_SAMPLE_INSET)
    this.valid = new Uint8Array(this.nSamples)
    this.y = new Float64Array(this.nSamples)
    this.buried = new Uint8Array(this.nSamples)
    this.minY = new Float64Array(this.nLevels).fill(Infinity)
    this.maxY = new Float64Array(this.nLevels).fill(-Infinity)
    for (let li = 0; li < this.nLevels; li++) this.rebuildRect(li, 0, 0, this.width - 1, this.depth - 1, null)
  }

  levelOf(g: number): number {
    return Math.floor(g / this.cellsPerLevel)
  }

  cellX(g: number): number {
    return ((g % this.cellsPerLevel) % this.width) * this.cellSize
  }

  cellZ(g: number): number {
    return Math.floor((g % this.cellsPerLevel) / this.width) * this.cellSize
  }

  sampleX(s: number): number {
    const g = Math.floor(s / SAMPLES_PER_CELL)
    return this.cellX(g) + this.cellSize / 2 + SAMPLE_DX[s - g * SAMPLES_PER_CELL] * this.offset
  }

  sampleZ(s: number): number {
    const g = Math.floor(s / SAMPLES_PER_CELL)
    return this.cellZ(g) + this.cellSize / 2 + SAMPLE_DZ[s - g * SAMPLES_PER_CELL] * this.offset
  }

  /** Sub-cell centre (q = sz·4 + sx) of cell g. */
  subX(g: number, q: number): number {
    return this.cellX(g) + ((q % SUBCELLS) + 0.5) * (this.cellSize / SUBCELLS)
  }

  subZ(g: number, q: number): number {
    return this.cellZ(g) + (Math.floor(q / SUBCELLS) + 0.5) * (this.cellSize / SUBCELLS)
  }

  /**
   * Recompute the samples of the cells [i0, i1] × [j0, j1] of level li. Indices of samples whose
   * validity, height or blocker status changed are appended to `changed` (when given).
   */
  rebuildRect(li: number, i0: number, j0: number, i1: number, j1: number, changed: number[] | null): void {
    i0 = Math.max(0, i0)
    j0 = Math.max(0, j0)
    i1 = Math.min(this.width - 1, i1)
    j1 = Math.min(this.depth - 1, j1)
    const s5 = SAMPLES_PER_CELL
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const g = li * this.cellsPerLevel + j * this.width + i
        this.subs.delete(g)
        const cx = (i + 0.5) * this.cellSize
        const cz = (j + 0.5) * this.cellSize
        for (let k = 0; k < s5; k++) {
          const s = g * s5 + k
          const x = cx + SAMPLE_DX[k] * this.offset
          const z = cz + SAMPLE_DZ[k] * this.offset
          const surface = this.index.surfaceAt(li, x, z)
          const valid = Number.isNaN(surface) ? 0 : 1
          const y = valid ? surface + VISION_SAMPLE_HEIGHT : 0
          const ins = valid ? insideInfoAt(this.world, x, y, z) : null
          const before = this.inside.get(s)
          if (changed && (this.valid[s] !== valid || this.y[s] !== y || !sameInside(before, ins))) changed.push(s)
          this.valid[s] = valid
          this.y[s] = y
          if (ins) this.inside.set(s, ins)
          else if (before) this.inside.delete(s)
          this.buried[s] = ins ? 1 : 0
          if (valid) this.extendY(li, y, ins)
        }
      }
    }
  }

  private extendY(li: number, y: number, ins: InsideInfo | null): void {
    if (y < this.minY[li]) this.minY[li] = y
    const top = ins?.top ? Math.max(y, ins.top.y) : y
    if (top > this.maxY[li]) this.maxY[li] = top
  }

  /** Blocker info of sample s, or null when it is free. */
  insideOf(s: number): InsideInfo | null {
    return this.buried[s] ? (this.inside.get(s) ?? null) : null
  }

  /** Sub-cell layout of cell g (cached until the cell is rebuilt). */
  subLayout(g: number): SubLayout {
    const hit = this.subs.get(g)
    if (hit) return hit
    const li = this.levelOf(g)
    const valid = new Uint8Array(SUBS_PER_CELL)
    const y = new Float64Array(SUBS_PER_CELL)
    const inside: (InsideInfo | null)[] = []
    for (let q = 0; q < SUBS_PER_CELL; q++) {
      const x = this.subX(g, q)
      const z = this.subZ(g, q)
      const surface = this.index.surfaceAt(li, x, z)
      if (Number.isNaN(surface)) {
        inside.push(null)
        continue
      }
      valid[q] = 1
      y[q] = surface + VISION_SAMPLE_HEIGHT
      inside.push(insideInfoAt(this.world, x, y[q], z))
    }
    const sub = { valid, y, inside }
    this.subs.set(g, sub)
    return sub
  }
}
