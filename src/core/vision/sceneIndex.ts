/**
 * Per-scene lookups for the vision engine: level order, terrain samplers, ground height (identical
 * to core/scene groundHeightAt, without its O(objects) scan) and the sampleable surfaces of each
 * level (docs/ARCHITECTURE.md §5.2 "Samples"): effective floors (flat levels) or heightfield solid
 * cells (levels with a heightmap), stairs/ramp/ladder footprints on their lower level, and the top
 * row of a stairs/ramp (or a ladder cell) on the level it arrives at.
 */
import { connectorRows } from "../occlusion/build"
import { heightfieldSurfaceAt, primitiveBounds } from "../occlusion/primitives"
import { TerrainSampler } from "../occlusion/terrain"
import type { Heightfield, OcclusionWorld } from "../occlusion/types"
import { connectorProgress, effectiveFloorRects, rectContains, sortedLevels, type EffectiveFloor } from "../scene/queries"
import type { ConnectorObject, GridSettings, Id, Level, Rect, SceneLike, Vec2 } from "../scene/types"

/**
 * Items bucketed by the grid cells their XZ rect overlaps, for fast point lookups. Items reaching
 * outside the grid extent are also kept in `outside`, scanned for points beyond the grid.
 */
export class CellBuckets<T> {
  private readonly lists: (T[] | undefined)[]
  private readonly outside: T[] = []
  private readonly width: number
  private readonly depth: number
  private readonly cellSize: number

  constructor(width: number, depth: number, cellSize: number) {
    this.width = width
    this.depth = depth
    this.cellSize = cellSize
    this.lists = new Array<T[] | undefined>(width * depth)
  }

  add(r: Rect, item: T): void {
    const s = this.cellSize
    if (r.x < 0 || r.z < 0 || r.x + r.w > this.width * s || r.z + r.d > this.depth * s) this.outside.push(item)
    const i0 = Math.max(0, Math.floor(r.x / s))
    const j0 = Math.max(0, Math.floor(r.z / s))
    const i1 = Math.min(this.width - 1, Math.ceil((r.x + r.w) / s) - 1)
    const j1 = Math.min(this.depth - 1, Math.ceil((r.z + r.d) / s) - 1)
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * this.width + i
        const list = this.lists[k]
        if (list) list.push(item)
        else this.lists[k] = [item]
      }
    }
  }

  /** Candidates for a point (a superset of the items whose rect contains it). */
  at(x: number, z: number): readonly T[] | undefined {
    const i = Math.floor(x / this.cellSize)
    const j = Math.floor(z / this.cellSize)
    if (i < 0 || j < 0 || i >= this.width || j >= this.depth) return this.outside.length > 0 ? this.outside : undefined
    return this.lists[j * this.width + i]
  }
}

const byId = <T extends { id: Id }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export class SceneIndex {
  scene: SceneLike
  readonly grid: GridSettings
  /** Levels in (elevation, id) order; fixed for the lifetime of the index (level changes rebuild it). */
  readonly levels: readonly Level[]
  readonly levelIdx: ReadonlyMap<Id, number>
  private readonly samplers = new Map<Id, { level: Level; sampler: TerrainSampler }>()
  /** Stairs/ramps by lower level (sorted by id, like connectorsAt). */
  private stairs: CellBuckets<ConnectorObject>[] = []
  /** Ladders by lower level and by upper level. */
  private laddersLower: CellBuckets<ConnectorObject>[] = []
  private laddersUpper: CellBuckets<ConnectorObject>[] = []
  /** Top rows of stairs/ramps by the level they arrive at. */
  private topRows: CellBuckets<Rect>[] = []
  /** Flat levels: effective floor rects. Heightmap levels: floor heightfields. */
  private floors: CellBuckets<Rect>[] = []
  private fields: CellBuckets<Heightfield>[] = []
  private effective = new Map<Id, EffectiveFloor[]>()
  /** Bumped whenever floors / connectors are re-indexed (footprint caches key on it). */
  floorsEpoch = 0

  constructor(scene: SceneLike, world: OcclusionWorld) {
    this.scene = scene
    this.grid = { ...scene.grid }
    this.levels = [...sortedLevels(scene)]
    this.levelIdx = new Map(this.levels.map((l, k) => [l.id, k]))
    this.refreshConnectors()
    this.refreshFloors(world)
  }

  /** Point the index at a new scene revision (same grid and levels). */
  setScene(scene: SceneLike): void {
    this.scene = scene
  }

  private buckets<T>(): CellBuckets<T> {
    return new CellBuckets<T>(this.grid.width, this.grid.depth, this.grid.cellSize)
  }

  /** Re-index connectors (after connector edits). */
  refreshConnectors(): void {
    const n = this.levels.length
    this.stairs = Array.from({ length: n }, () => this.buckets<ConnectorObject>())
    this.laddersLower = Array.from({ length: n }, () => this.buckets<ConnectorObject>())
    this.laddersUpper = Array.from({ length: n }, () => this.buckets<ConnectorObject>())
    this.topRows = Array.from({ length: n }, () => this.buckets<Rect>())
    const connectors: ConnectorObject[] = []
    for (const o of Object.values(this.scene.objects)) if (o.type === "connector") connectors.push(o)
    connectors.sort(byId)
    for (const c of connectors) {
      const lo = this.levelIdx.get(c.levelId)
      const hi = this.levelIdx.get(c.toLevelId)
      if (c.style === "ladder") {
        if (lo !== undefined) this.laddersLower[lo].add(c.rect, c)
        if (hi !== undefined) this.laddersUpper[hi].add(c.rect, c)
        continue
      }
      if (lo !== undefined) this.stairs[lo].add(c.rect, c)
      if (hi !== undefined) {
        const rows = connectorRows(c, this.grid.cellSize)
        const row = rows[rows.length - 1]
        this.topRows[hi].add(row, row)
      }
    }
    this.floorsEpoch++
  }

  /** Re-index floors (after floor / connector / terrain edits: heightfields are replaced on terrain edits). */
  refreshFloors(world: OcclusionWorld): void {
    const n = this.levels.length
    this.floors = Array.from({ length: n }, () => this.buckets<Rect>())
    this.fields = Array.from({ length: n }, () => this.buckets<Heightfield>())
    this.effective = new Map()
    for (let li = 0; li < n; li++) {
      const id = this.levels[li].id
      const eff = effectiveFloorRects(this.scene, id)
      this.effective.set(id, eff)
      for (const f of eff) this.floors[li].add(f.rect, f.rect)
    }
    for (const p of world.primitives) {
      if (p.shape !== "heightfield") continue
      const li = this.levelIdx.get(p.levelId)
      if (li === undefined) continue
      const b = primitiveBounds(p)
      if (b.minX > b.maxX) continue
      this.fields[li].add({ x: b.minX, z: b.minZ, w: b.maxX - b.minX, d: b.maxZ - b.minZ }, p)
    }
    this.floorsEpoch++
  }

  /** Effective floor rects of a level (connector cutouts removed). */
  effectiveFloors(levelId: Id): readonly EffectiveFloor[] {
    return this.effective.get(levelId) ?? []
  }

  levelById(id: Id): Level | undefined {
    return Object.hasOwn(this.scene.levels, id) ? this.scene.levels[id] : undefined
  }

  /** Terrain sampler of a level (recreated when the level object changes, e.g. after a terrain edit). */
  sampler(level: Level): TerrainSampler {
    const hit = this.samplers.get(level.id)
    if (hit && hit.level === level) return hit.sampler
    const sampler = new TerrainSampler(level, this.grid)
    this.samplers.set(level.id, { level, sampler })
    return sampler
  }

  /** core/scene levelGround: elevation + heightmap, 0 for a missing level. */
  levelGround(levelId: Id, x: number, z: number): number {
    const level = this.levelById(levelId)
    return level ? this.sampler(level).heightAt(x, z) : 0
  }

  /** core/scene connectorGround, using the cached samplers. */
  connectorGround(c: ConnectorObject, x: number, z: number): number {
    const p: Vec2 = { x, z }
    const t = connectorProgress(c, p)
    const r = c.rect
    const fx = c.direction === 1 ? 1 : c.direction === 3 ? -1 : 0
    const fz = c.direction === 0 ? 1 : c.direction === 2 ? -1 : 0
    const cx = Math.min(Math.max(x, r.x), r.x + r.w)
    const cz = Math.min(Math.max(z, r.z), r.z + r.d)
    const bx = fx > 0 ? r.x : fx < 0 ? r.x + r.w : cx
    const bz = fz > 0 ? r.z : fz < 0 ? r.z + r.d : cz
    const tx = fx > 0 ? r.x + r.w : fx < 0 ? r.x : cx
    const tz = fz > 0 ? r.z + r.d : fz < 0 ? r.z : cz
    const bottom = this.levelGround(c.levelId, bx, bz)
    const top = this.levelGround(c.toLevelId, tx, tz)
    return bottom + (top - bottom) * t
  }

  private stairsAt(li: number, x: number, z: number): ConnectorObject | null {
    const list = this.stairs[li].at(x, z)
    if (!list) return null
    const p = { x, z }
    for (const c of list) if (rectContains(c.rect, p)) return c
    return null
  }

  /** core/scene groundHeightAt for a level index (stairs/ramp runs interpolate). */
  groundAt(li: number, x: number, z: number): number {
    const c = this.stairsAt(li, x, z)
    if (c) return this.connectorGround(c, x, z)
    return this.levelGround(this.levels[li].id, x, z)
  }

  /** groundHeightAt by level id (0 for unknown levels, like core/scene). */
  groundAtLevel(levelId: Id, x: number, z: number): number {
    const li = this.levelIdx.get(levelId)
    return li === undefined ? this.levelGround(levelId, x, z) : this.groundAt(li, x, z)
  }

  private floorCovers(li: number, x: number, z: number): boolean {
    const level = this.levels[li]
    const current = this.levelById(level.id)
    if (current?.heightmap) {
      const list = this.fields[li].at(x, z)
      if (!list) return false
      for (const hf of list) if (heightfieldSurfaceAt(hf, x, z) !== null) return true
      return false
    }
    const list = this.floors[li].at(x, z)
    if (!list) return false
    const p = { x, z }
    for (const r of list) if (rectContains(r, p)) return true
    return false
  }

  /**
   * World Y of the sampleable surface of level `li` at (x, z), or NaN when nothing a token could
   * stand on covers the point on that level.
   */
  surfaceAt(li: number, x: number, z: number): number {
    const stairs = this.stairsAt(li, x, z)
    if (stairs) return this.connectorGround(stairs, x, z)
    const id = this.levels[li].id
    const p = { x, z }
    const lower = this.laddersLower[li].at(x, z)
    if (lower) for (const c of lower) if (rectContains(c.rect, p)) return this.levelGround(id, x, z)
    if (this.floorCovers(li, x, z)) return this.levelGround(id, x, z)
    // Ladder cells and the top row of stairs/ramps on the level they arrive at: groundHeightAt on
    // that level is its own ground (runs interpolate only on their lower level), i.e. the samples
    // sit in the opening at the upper floor's height.
    const upper = this.laddersUpper[li].at(x, z)
    if (upper) for (const c of upper) if (rectContains(c.rect, p)) return this.levelGround(id, x, z)
    const rows = this.topRows[li].at(x, z)
    if (rows) for (const r of rows) if (rectContains(r, p)) return this.levelGround(id, x, z)
    return NaN
  }
}
