/**
 * LightField: the viewer-independent light level of every sample (docs/ARCHITECTURE.md §5.2
 * "Light level" and "Caches").
 *
 *   light(p) = max(ambientAt(p), sun(p), max_i light_i(p))
 *
 * - ambientAt: env.skyLevel where a vertical light-channel ray escapes above everything, else
 *   env.ambientLevel (no rays at all when both are equal);
 * - sun: the directional light's `grants` level where a light-channel ray toward it escapes the
 *   scene bounds;
 * - light_i: lights that are on and not effectively hidden, 3D distance against the static radii,
 *   blocked only when `castsShadows` and the light-channel segment is blocked (the light's own id is
 *   ignored).
 *
 * Samples buried in a light blocker P are reached when the ray's FIRST hit is P (the light reaches
 * P's surface); samples with a top probe take the max over the sample and the probe.
 *
 * Point lights are stored as per-light contribution lists plus per-sample bright/dim counters, so a
 * light that moves, toggles or changes radius only touches its old and new spheres. Every cell whose
 * light may have changed gets `cellVersion[g] = version` (viewer caches re-evaluate those cells).
 */
import type { AABB3 } from "../geometry/box"
import type { OcclusionWorld } from "../occlusion/types"
import type { AmbientLevel, Environment, GridSettings, Id, Level, Vec3 } from "../scene/types"
import { BlockerCache } from "./blockers"
import { SUBS_PER_CELL, type InsideInfo, type SampleLayout } from "./layout"
import { SAMPLES_PER_CELL, type LightLevel } from "./types"

export const LIGHT_LEVEL: Record<AmbientLevel, LightLevel> = { dark: 0, dim: 1, bright: 2 }

/** A light as vision sees it: on, not effectively hidden, resolved to world space. */
export interface LightSource {
  id: Id
  levelId: Id
  pos: Vec3
  bright: number
  dim: number
  castsShadows: boolean
}

export interface LightRecord extends LightSource {
  sig: string
  ignore: ReadonlySet<Id>
  /** Samples this light reaches with the level it grants there (1 dim, 2 bright). */
  samples: Int32Array
  levels: Uint8Array
  /** Level indices whose cells were touched when the contribution was computed. */
  touched: number[]
}

export function lightSignature(src: LightSource): string {
  const p = src.pos
  return `${src.levelId}|${p.x},${p.y},${p.z}|${src.bright}|${src.dim}|${src.castsShadows ? 1 : 0}`
}

/** Extent used to decide that sky and sun rays have escaped the scene. */
export interface SceneBounds {
  minX: number
  maxX: number
  minZ: number
  maxZ: number
  /** Above every level top and every primitive. */
  topY: number
}

export function sceneBounds(grid: GridSettings, levels: readonly Level[], world: OcclusionWorld): SceneBounds {
  const b: SceneBounds = { minX: 0, maxX: grid.width * grid.cellSize, minZ: 0, maxZ: grid.depth * grid.cellSize, topY: 0 }
  let top = -Infinity
  for (const l of levels) top = Math.max(top, l.elevation + l.height)
  for (const p of world.primitives) {
    const y = p.shape === "box" ? p.center.y + p.halfExtents.y : p.shape === "cylinder" ? p.base.y + p.height : -Infinity
    if (y > top) top = y
    if (p.shape === "heightfield") {
      for (let k = 0; k < p.heights.length; k++) if (p.heights[k] > top) top = p.heights[k]
    }
  }
  b.topY = (Number.isFinite(top) ? top : 0) + 1
  return b
}

/** Grow bounds so they contain a (dirty) box. */
export function expandBounds(b: SceneBounds, box: AABB3): void {
  if (box.minX > box.maxX) return
  b.minX = Math.min(b.minX, box.minX)
  b.maxX = Math.max(b.maxX, box.maxX)
  b.minZ = Math.min(b.minZ, box.minZ)
  b.maxZ = Math.max(b.maxZ, box.maxZ)
  b.topY = Math.max(b.topY, box.maxY + 1)
}

interface EnvParams {
  sky: LightLevel
  ambient: LightLevel
  /** Sky exposure matters only when the sky and cover levels differ. */
  needSky: boolean
  sunOn: boolean
  sunGrant: LightLevel
  /** Unit vector toward the directional light. */
  dx: number
  dy: number
  dz: number
}

function envParams(env: Environment): EnvParams {
  const d = env.directional
  const el = Math.min(Math.PI / 2, Math.max(0.1, d.elevation))
  const sky = LIGHT_LEVEL[env.skyLevel] ?? 0
  const ambient = LIGHT_LEVEL[env.ambientLevel] ?? 0
  return {
    sky,
    ambient,
    needSky: sky !== ambient,
    sunOn: d.enabled,
    sunGrant: LIGHT_LEVEL[d.grants] ?? 0,
    dx: Math.sin(d.azimuth) * Math.cos(el),
    dy: Math.sin(el),
    dz: Math.cos(d.azimuth) * Math.cos(el),
  }
}

/** Signature of the environment fields vision depends on. */
export function environmentSignature(env: Environment): string {
  const d = env.directional
  return `${env.skyLevel}|${env.ambientLevel}|${d.enabled}|${d.azimuth}|${d.elevation}|${d.grants}`
}

export class LightField {
  /** max(ambientAt, sun) per sample. */
  readonly base: Uint8Array
  /** 1 = reached by the directional light. */
  readonly sun: Uint8Array
  /** Number of point lights granting bright / exactly dim light per sample. */
  readonly bright: Uint16Array
  readonly dim: Uint16Array
  /** Version at which each cell's light last (possibly) changed. */
  readonly cellVersion: Uint32Array
  version = 1
  readonly bounds: SceneBounds
  private env: EnvParams
  private readonly records = new Map<Id, LightRecord>()
  private readonly subCache = new Map<number, Uint8Array>()
  private readonly world: OcclusionWorld
  private readonly layout: SampleLayout
  private readonly skyCache: BlockerCache
  private readonly sunCache: BlockerCache
  private readonly lightCache: BlockerCache
  private readonly from: Vec3 = { x: 0, y: 0, z: 0 }
  private readonly to: Vec3 = { x: 0, y: 0, z: 0 }

  constructor(world: OcclusionWorld, layout: SampleLayout, env: Environment, bounds: SceneBounds) {
    this.world = world
    this.layout = layout
    this.bounds = bounds
    this.env = envParams(env)
    const n = layout.nSamples
    this.base = new Uint8Array(n)
    this.sun = new Uint8Array(n)
    this.bright = new Uint16Array(n)
    this.dim = new Uint16Array(n)
    this.cellVersion = new Uint32Array(layout.nCells).fill(1)
    this.skyCache = new BlockerCache(world, "light")
    this.sunCache = new BlockerCache(world, "light")
    this.lightCache = new BlockerCache(world, "light")
    this.computeAllBase()
  }

  /** Final light level of sample s. */
  level(s: number): LightLevel {
    const b = this.base[s]
    const p = this.bright[s] > 0 ? 2 : this.dim[s] > 0 ? 1 : 0
    return (b > p ? b : p) as LightLevel
  }

  get lights(): IterableIterator<LightRecord> {
    return this.records.values()
  }

  lightRecord(id: Id): LightRecord | undefined {
    return this.records.get(id)
  }

  lightIds(): Id[] {
    return [...this.records.keys()]
  }

  private touch(g: number): void {
    this.cellVersion[g] = this.version
    this.subCache.delete(g)
  }

  // -------------------------------------------------------------------------
  // Sky and sun
  // -------------------------------------------------------------------------

  skyExposed(x: number, y: number, z: number): boolean {
    const top = this.bounds.topY
    if (y >= top) return true
    this.from.x = x
    this.from.y = y
    this.from.z = z
    this.to.x = x
    this.to.y = top
    this.to.z = z
    return !this.skyCache.blocked(this.from, this.to)
  }

  sunReached(x: number, y: number, z: number): boolean {
    const e = this.env
    const b = this.bounds
    // Distance along the sun direction to leave the scene box (1 ft margin).
    let t = (b.topY - y) / e.dy
    if (e.dx > 1e-12) t = Math.min(t, (b.maxX + 1 - x) / e.dx)
    else if (e.dx < -1e-12) t = Math.min(t, (b.minX - 1 - x) / e.dx)
    if (e.dz > 1e-12) t = Math.min(t, (b.maxZ + 1 - z) / e.dz)
    else if (e.dz < -1e-12) t = Math.min(t, (b.minZ - 1 - z) / e.dz)
    if (!(t > 0)) return true
    this.from.x = x
    this.from.y = y
    this.from.z = z
    this.to.x = x + e.dx * t
    this.to.y = y + e.dy * t
    this.to.z = z + e.dz * t
    return !this.sunCache.blocked(this.from, this.to)
  }

  /** Ambient/sky and sun at a point (with its top probe): base level | (sun reached << 2). */
  private baseAt(x: number, y: number, z: number, top: Vec3 | null): number {
    const e = this.env
    let amb = e.ambient
    if (e.needSky && (this.skyExposed(x, y, z) || (top !== null && this.skyExposed(top.x, top.y, top.z)))) amb = e.sky
    const sun = e.sunOn && (this.sunReached(x, y, z) || (top !== null && this.sunReached(top.x, top.y, top.z)))
    const lvl = sun && e.sunGrant > amb ? e.sunGrant : amb
    return lvl | (sun ? 4 : 0)
  }

  private computeBase(s: number): number {
    if (!this.layout.valid[s]) return 0
    const top = this.layout.insideOf(s)?.top ?? null
    return this.baseAt(this.layout.sampleX(s), this.layout.y[s], this.layout.sampleZ(s), top)
  }

  private computeAllBase(): void {
    for (let s = 0; s < this.layout.nSamples; s++) {
      const v = this.computeBase(s)
      this.base[s] = v & 3
      this.sun[s] = v >> 2
    }
  }

  /** New environment: recompute sky/sun for every sample. */
  setEnvironment(env: Environment): void {
    this.env = envParams(env)
    this.version++
    this.subCache.clear()
    for (let s = 0; s < this.layout.nSamples; s++) this.storeBase(s)
  }

  private storeBase(s: number): void {
    const v = this.computeBase(s)
    const b = v & 3
    const sun = v >> 2
    if (b !== this.base[s] || sun !== this.sun[s]) {
      this.base[s] = b
      this.sun[s] = sun
      this.touch(Math.floor(s / SAMPLES_PER_CELL))
    }
  }

  /**
   * Occluders changed inside `boxes` (and the samples in `changedSamples` moved or changed blocker
   * status): recompute sky bits under the boxes, sun bits whose rays may cross them, and the base
   * of the changed samples.
   */
  refreshBase(boxes: readonly AABB3[], changedSamples: readonly number[]): void {
    this.version++
    for (const s of changedSamples) {
      this.storeBase(s)
      this.touch(Math.floor(s / SAMPLES_PER_CELL))
    }
    const e = this.env
    if (!e.needSky && !e.sunOn) return
    const L = this.layout
    for (const box of boxes) {
      if (box.minX > box.maxX) continue
      for (let li = 0; li < L.nLevels; li++) {
        if (L.minY[li] > L.maxY[li] || L.minY[li] > box.maxY) continue
        // Sky rays are vertical: only samples under the box. Sun rays climb toward the sun, so a
        // sample at height y reaches the box's Y range after a horizontal run of (Δy / tan el).
        let x0 = box.minX
        let x1 = box.maxX
        let z0 = box.minZ
        let z1 = box.maxZ
        if (e.sunOn) {
          const run = Math.max(0, box.maxY - L.minY[li]) / e.dy
          const sx = -e.dx * run
          const sz = -e.dz * run
          x0 = Math.min(x0, box.minX + sx)
          x1 = Math.max(x1, box.maxX + sx)
          z0 = Math.min(z0, box.minZ + sz)
          z1 = Math.max(z1, box.maxZ + sz)
        }
        this.forCells(li, x0, z0, x1, z1, (g) => {
          for (let k = 0; k < SAMPLES_PER_CELL; k++) this.storeBase(g * SAMPLES_PER_CELL + k)
        })
      }
    }
  }

  /** Cells of level li whose closed square meets [x0, x1] × [z0, z1] (1 ft margin). */
  private forCells(li: number, x0: number, z0: number, x1: number, z1: number, fn: (g: number) => void): void {
    const L = this.layout
    const s = L.cellSize
    const i0 = Math.max(0, Math.floor((x0 - 1) / s))
    const j0 = Math.max(0, Math.floor((z0 - 1) / s))
    const i1 = Math.min(L.width - 1, Math.floor((x1 + 1) / s))
    const j1 = Math.min(L.depth - 1, Math.floor((z1 + 1) / s))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(li * L.cellsPerLevel + j * L.width + i)
  }

  // -------------------------------------------------------------------------
  // Point lights
  // -------------------------------------------------------------------------

  /** Whether a light reaches a point (buried points: the first hit must be a blocker containing it). */
  private reaches(rec: LightRecord, x: number, y: number, z: number, ins: InsideInfo | null): boolean {
    if (!rec.castsShadows) return true
    this.to.x = x
    this.to.y = y
    this.to.z = z
    if (ins !== null && ins.light.size > 0) {
      const hit = this.world.raycast(rec.pos, this.to, { channel: "light", ignoreSourceIds: rec.ignore })
      return hit === null || ins.light.has(hit.primitive.key)
    }
    return !this.lightCache.blocked(rec.pos, this.to, rec.ignore)
  }

  /** Level (0..2) one light grants at a point (and at its top probe, when buried). */
  private lightLevelAt(rec: LightRecord, x: number, y: number, z: number, ins: InsideInfo | null): LightLevel {
    const p = rec.pos
    const d = Math.hypot(x - p.x, y - p.y, z - p.z)
    const lvl: LightLevel = d <= rec.bright ? 2 : d <= rec.dim ? 1 : 0
    let best: LightLevel = 0
    if (lvl > 0 && this.reaches(rec, x, y, z, ins)) best = lvl
    const top = ins?.top
    if (top && best < 2) {
      const dt = Math.hypot(top.x - p.x, top.y - p.y, top.z - p.z)
      const lt: LightLevel = dt <= rec.bright ? 2 : dt <= rec.dim ? 1 : 0
      if (lt > best && this.reaches(rec, top.x, top.y, top.z, null)) best = lt
    }
    return best
  }

  /** Cells of level li within the light's dim circle (XZ); calls fn(g). */
  private forCircle(li: number, rec: LightSource, fn: (g: number) => void): void {
    const L = this.layout
    const s = L.cellSize
    const R = rec.dim
    const cx = rec.pos.x
    const cz = rec.pos.z
    const i0 = Math.max(0, Math.floor((cx - R) / s))
    const j0 = Math.max(0, Math.floor((cz - R) / s))
    const i1 = Math.min(L.width - 1, Math.floor((cx + R) / s))
    const j1 = Math.min(L.depth - 1, Math.floor((cz + R) / s))
    for (let j = j0; j <= j1; j++) {
      const dz = Math.max(j * s - cz, 0, cz - (j + 1) * s)
      for (let i = i0; i <= i1; i++) {
        const dx = Math.max(i * s - cx, 0, cx - (i + 1) * s)
        if (dx * dx + dz * dz > R * R) continue
        fn(li * L.cellsPerLevel + j * L.width + i)
      }
    }
  }

  private levelsInRange(src: LightSource): number[] {
    const L = this.layout
    const out: number[] = []
    for (let li = 0; li < L.nLevels; li++) {
      if (L.minY[li] > L.maxY[li]) continue
      if (src.pos.y - src.dim > L.maxY[li] || src.pos.y + src.dim < L.minY[li]) continue
      out.push(li)
    }
    return out
  }

  private computeContribution(rec: LightRecord): void {
    const L = this.layout
    const samples: number[] = []
    const levels: number[] = []
    rec.touched = this.levelsInRange(rec)
    for (const li of rec.touched) {
      this.forCircle(li, rec, (g) => {
        this.touch(g)
        for (let k = 0; k < SAMPLES_PER_CELL; k++) {
          const s = g * SAMPLES_PER_CELL + k
          if (!L.valid[s]) continue
          const lvl = this.lightLevelAt(rec, L.sampleX(s), L.y[s], L.sampleZ(s), L.insideOf(s))
          if (lvl === 0) continue
          samples.push(s)
          levels.push(lvl)
          if (lvl === 2) this.bright[s]++
          else this.dim[s]++
        }
      })
    }
    rec.samples = Int32Array.from(samples)
    rec.levels = Uint8Array.from(levels)
  }

  private removeContribution(rec: LightRecord): void {
    for (let k = 0; k < rec.samples.length; k++) {
      const s = rec.samples[k]
      if (rec.levels[k] === 2) this.bright[s]--
      else this.dim[s]--
    }
    for (const li of rec.touched) this.forCircle(li, rec, (g) => this.touch(g))
  }

  /**
   * Add, move, change or remove (src = null) a light. Returns whether anything was recomputed.
   * `force` recomputes an unchanged light (occluders near it changed).
   */
  setLight(id: Id, src: LightSource | null, force = false): boolean {
    const old = this.records.get(id)
    const sig = src ? lightSignature(src) : ""
    if (!force && (old ? src !== null && old.sig === sig : src === null)) return false
    this.version++
    if (old) {
      this.removeContribution(old)
      this.records.delete(id)
    }
    if (src) {
      const rec: LightRecord = {
        ...src,
        dim: Math.max(src.dim, src.bright),
        sig,
        ignore: new Set([id]),
        samples: new Int32Array(0),
        levels: new Uint8Array(0),
        touched: [],
      }
      this.computeContribution(rec)
      this.records.set(id, rec)
    }
    return true
  }

  /** Drop cached sub-cell light of cells whose sub-cell layout was rebuilt. */
  forgetSubCells(cells: readonly number[]): void {
    for (const g of cells) this.subCache.delete(g)
  }

  /** Lights whose dim sphere meets any of the boxes. */
  lightsMeeting(boxes: readonly AABB3[]): Id[] {
    const out: Id[] = []
    for (const rec of this.records.values()) {
      const p = rec.pos
      for (const b of boxes) {
        const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX)
        const dy = Math.max(b.minY - p.y, 0, p.y - b.maxY)
        const dz = Math.max(b.minZ - p.z, 0, p.z - b.maxZ)
        if (dx * dx + dy * dy + dz * dz <= rec.dim * rec.dim) {
          out.push(rec.id)
          break
        }
      }
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Arbitrary points and sub-cells
  // -------------------------------------------------------------------------

  /** Light level and sun reach at an arbitrary point (token test points, sub-cell centres). */
  levelAtPoint(x: number, y: number, z: number, ins: InsideInfo | null): LightLevel {
    const v = this.baseAt(x, y, z, ins?.top ?? null)
    let level = (v & 3) as LightLevel
    if (level >= 2) return level
    for (const rec of this.records.values()) {
      const p = rec.pos
      // Cheap sphere rejection before any ray.
      const dx = x - p.x
      const dy = y - p.y
      const dz = z - p.z
      const top = ins?.top
      if (dx * dx + dy * dy + dz * dz > rec.dim * rec.dim) {
        if (!top || (top.x - p.x) ** 2 + (top.y - p.y) ** 2 + (top.z - p.z) ** 2 > rec.dim * rec.dim) continue
      }
      const lvl = this.lightLevelAt(rec, x, y, z, ins)
      if (lvl > level) {
        level = lvl
        if (level >= 2) break
      }
    }
    return level
  }

  /**
   * Light level of the 16 sub-cell centres of cell g (0 for unsampleable ones). When the cell's
   * valid samples all agree, the sub-cells take that level without casting rays.
   */
  subLevels(g: number): Uint8Array {
    const hit = this.subCache.get(g)
    if (hit) return hit
    const L = this.layout
    const out = new Uint8Array(SUBS_PER_CELL)
    let common = -1
    let uniform = true
    for (let k = 0; k < SAMPLES_PER_CELL; k++) {
      const s = g * SAMPLES_PER_CELL + k
      if (!L.valid[s]) continue
      const lvl = this.level(s)
      if (common < 0) common = lvl
      else if (common !== lvl) uniform = false
    }
    const sub = L.subLayout(g)
    for (let q = 0; q < SUBS_PER_CELL; q++) {
      if (!sub.valid[q]) continue
      out[q] = uniform && common >= 0 ? common : this.levelAtPoint(L.subX(g, q), sub.y[q], L.subZ(g, q), sub.inside[q])
    }
    this.subCache.set(g, out)
    return out
  }
}
