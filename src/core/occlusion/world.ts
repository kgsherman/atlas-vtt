/**
 * OcclusionWorld implementation: primitives from ./build registered in a 2D uniform grid over XZ
 * (cells of grid.cellSize feet). Segment queries walk the grid with a 2D DDA, cull whole cells by
 * the segment's Y range, test each primitive once per query (mailboxing with a query stamp), and run
 * the exact entry tests of ./primitives.
 *
 * Incremental updates rebuild a closure of affected sources, diff the result against the current
 * primitives by key and value, and report dirty regions (old and new bounds) only for primitives
 * that actually changed.
 */
import { aabb3ContainsPoint, aabb3Union, circleOverlapsAABB2, inflateRect, orientedRectOverlapsAABB2, type AABB3 } from "../geometry/box"
import { createInterval, lineAABB3 } from "../geometry/ray"
import { clipSegmentToBox2Into } from "../geometry/segment"
import { EPS } from "../geometry/vec"
import { rectsOverlap, structureSignature } from "../scene/queries"
import type { Id, Rect, SceneLike, Vec2, Vec3 } from "../scene/types"
import {
  BuildContext,
  buildSource,
  OCCLUDER_TYPES,
  objectFootprintRect,
  openingSignature,
  sourceInfo,
  type SourceInfo,
} from "./build"
import {
  boxEntry,
  cylinderEntry,
  footprintOverlapsCircle,
  footprintOverlapsRect,
  heightfieldCellsX,
  heightfieldCellsZ,
  heightfieldEntry,
  primitiveBounds,
  primitiveContains,
  stripEntry,
  stripMaxTop,
} from "./primitives"
import type {
  BlockChannel,
  BlockFlags,
  DirtyRegion,
  Heightfield,
  OccluderPrimitive,
  OcclusionWorld,
  RayHit,
  SegmentQueryOptions,
  WallStrip,
} from "./types"

const CHANNEL_BIT: Record<BlockChannel, number> = { movement: 1, sight: 2, light: 4 }
/** Registration tolerance (feet): primitives are registered in cells they come within this distance of. */
const REG_EPS = 1e-4
/** Upper bound on grid cells; very large extents coarsen the grid instead. */
const MAX_GRID_CELLS = 1 << 20
/** Grid margin (cells) around the scene extent and primitive bounds. */
const GRID_MARGIN = 2
/** Above this many dirty regions on one level, they are collapsed into one box. */
const MAX_REGIONS_PER_LEVEL = 64

const maskOf = (b: BlockFlags): number => (b.movement ? 1 : 0) | (b.sight ? 2 : 0) | (b.light ? 4 : 0)

interface Entry {
  prim: OccluderPrimitive
  bounds: AABB3
  mask: number
  /** cos/sin of the yaw (boxes and strips). */
  cos: number
  sin: number
  /** Query stamp (mailboxing). */
  stamp: number
  /** Grid cell indices this entry is registered in. */
  cells: number[]
}

interface Cell {
  entries: Entry[]
  /** Per-entry Y range within this cell (heightfields are tighter than their global bounds). */
  minYs: number[]
  maxYs: number[]
  minY: number
  maxY: number
  mask: number
}

interface GridParams {
  x0: number
  z0: number
  size: number
  nx: number
  nz: number
}

const scratch = createInterval()
const clipRange = createInterval()

// ---------------------------------------------------------------------------
// Primitive equality and dirty regions
// ---------------------------------------------------------------------------

function sameArray(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false
  return true
}

function sameHeightfieldLayout(a: Heightfield, b: Heightfield): boolean {
  return (
    a.originX === b.originX &&
    a.originZ === b.originZ &&
    a.spacing === b.spacing &&
    a.samplesX === b.samplesX &&
    a.samplesZ === b.samplesZ &&
    a.thickness === b.thickness
  )
}

export function primitivesEqual(a: OccluderPrimitive, b: OccluderPrimitive): boolean {
  if (
    a.key !== b.key ||
    a.sourceId !== b.sourceId ||
    a.sourceType !== b.sourceType ||
    a.levelId !== b.levelId ||
    a.blocks.movement !== b.blocks.movement ||
    a.blocks.sight !== b.blocks.sight ||
    a.blocks.light !== b.blocks.light
  ) {
    return false
  }
  if (a.shape === "box" && b.shape === "box") {
    return (
      a.yaw === b.yaw &&
      a.center.x === b.center.x &&
      a.center.y === b.center.y &&
      a.center.z === b.center.z &&
      a.halfExtents.x === b.halfExtents.x &&
      a.halfExtents.y === b.halfExtents.y &&
      a.halfExtents.z === b.halfExtents.z
    )
  }
  if (a.shape === "cylinder" && b.shape === "cylinder") {
    return a.radius === b.radius && a.height === b.height && a.base.x === b.base.x && a.base.y === b.base.y && a.base.z === b.base.z
  }
  if (a.shape === "heightfield" && b.shape === "heightfield") {
    return sameHeightfieldLayout(a, b) && sameArray(a.heights, b.heights) && sameArray(a.solid, b.solid)
  }
  if (a.shape === "strip" && b.shape === "strip") {
    return (
      a.yaw === b.yaw &&
      a.center.x === b.center.x &&
      a.center.z === b.center.z &&
      a.halfExtents.x === b.halfExtents.x &&
      a.halfExtents.z === b.halfExtents.z &&
      a.bottom === b.bottom &&
      sameArray(a.knots, b.knots) &&
      sameArray(a.top, b.top)
    )
  }
  return false
}

const regionOf = (levelId: Id, b: AABB3): DirtyRegion => ({
  levelId,
  min: { x: b.minX, y: b.minY, z: b.minZ },
  max: { x: b.maxX, y: b.maxY, z: b.maxZ },
})

/** Bounding box of the lattice region whose samples or solid flags differ between two same-layout heightfields. */
function heightfieldDiffBounds(a: Heightfield, b: Heightfield): AABB3 | null {
  const sx = a.samplesX
  const cx = heightfieldCellsX(a)
  let i0 = Infinity
  let j0 = Infinity
  let i1 = -Infinity
  let j1 = -Infinity
  const mark = (ci0: number, cj0: number, ci1: number, cj1: number) => {
    if (ci0 < i0) i0 = ci0
    if (cj0 < j0) j0 = cj0
    if (ci1 > i1) i1 = ci1
    if (cj1 > j1) j1 = cj1
  }
  for (let k = 0; k < a.heights.length; k++) {
    if (a.heights[k] === b.heights[k]) continue
    const i = k % sx
    const j = (k - i) / sx
    // A sample belongs to the (up to) four cells around it.
    mark(i - 1, j - 1, i, j)
  }
  for (let k = 0; k < a.solid.length; k++) {
    if (a.solid[k] === b.solid[k]) continue
    const i = k % cx
    const j = (k - i) / cx
    mark(i, j, i, j)
  }
  if (i0 === Infinity) return null
  i0 = Math.max(0, i0)
  j0 = Math.max(0, j0)
  i1 = Math.min(cx - 1, i1)
  j1 = Math.min(heightfieldCellsZ(a) - 1, j1)
  let minY = Infinity
  let maxY = -Infinity
  for (let j = j0; j <= j1 + 1; j++) {
    for (let i = i0; i <= i1 + 1; i++) {
      const ha = a.heights[j * sx + i]
      const hb = b.heights[j * sx + i]
      minY = Math.min(minY, ha, hb)
      maxY = Math.max(maxY, ha, hb)
    }
  }
  const s = a.spacing
  return {
    minX: a.originX + i0 * s,
    minY: minY - Math.max(a.thickness, b.thickness),
    minZ: a.originZ + j0 * s,
    maxX: a.originX + (i1 + 1) * s,
    maxY,
    maxZ: a.originZ + (j1 + 1) * s,
  }
}

function changeRegions(old: OccluderPrimitive | undefined, neu: OccluderPrimitive | undefined): DirtyRegion[] {
  if (
    old &&
    neu &&
    old.shape === "heightfield" &&
    neu.shape === "heightfield" &&
    old.levelId === neu.levelId &&
    sameHeightfieldLayout(old, neu) &&
    maskOf(old.blocks) === maskOf(neu.blocks)
  ) {
    const b = heightfieldDiffBounds(old, neu)
    return b ? [regionOf(old.levelId, b)] : []
  }
  if (old && neu && old.levelId === neu.levelId) return [regionOf(old.levelId, aabb3Union(primitiveBounds(old), primitiveBounds(neu)))]
  const out: DirtyRegion[] = []
  if (old) out.push(regionOf(old.levelId, primitiveBounds(old)))
  if (neu) out.push(regionOf(neu.levelId, primitiveBounds(neu)))
  return out
}

const regionsOverlap = (a: DirtyRegion, b: DirtyRegion): boolean =>
  a.min.x <= b.max.x && b.min.x <= a.max.x && a.min.y <= b.max.y && b.min.y <= a.max.y && a.min.z <= b.max.z && b.min.z <= a.max.z

function unionRegion(a: DirtyRegion, b: DirtyRegion): DirtyRegion {
  return {
    levelId: a.levelId,
    min: { x: Math.min(a.min.x, b.min.x), y: Math.min(a.min.y, b.min.y), z: Math.min(a.min.z, b.min.z) },
    max: { x: Math.max(a.max.x, b.max.x), y: Math.max(a.max.y, b.max.y), z: Math.max(a.max.z, b.max.z) },
  }
}

/** Merge overlapping regions per level (many regions on one level collapse into their union). */
export function mergeRegions(regions: DirtyRegion[]): DirtyRegion[] {
  const byLevel = new Map<Id, DirtyRegion[]>()
  for (const r of regions) {
    let list = byLevel.get(r.levelId)
    if (!list) byLevel.set(r.levelId, (list = []))
    list.push(r)
  }
  const out: DirtyRegion[] = []
  for (const list of byLevel.values()) {
    if (list.length > MAX_REGIONS_PER_LEVEL) {
      out.push(list.reduce(unionRegion))
      continue
    }
    const merged = [...list]
    let changed = true
    while (changed) {
      changed = false
      for (let a = 0; a < merged.length && !changed; a++) {
        for (let b = a + 1; b < merged.length; b++) {
          if (regionsOverlap(merged[a], merged[b])) {
            merged[a] = unionRegion(merged[a], merged[b])
            merged.splice(b, 1)
            changed = true
            break
          }
        }
      }
    }
    out.push(...merged)
  }
  return out
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export class GridOcclusionWorld implements OcclusionWorld {
  private _version = 0
  private readonly entries = new Map<string, Entry>()
  private readonly bySource = new Map<Id, Set<string>>()
  private readonly infos = new Map<Id, SourceInfo>()
  /** Reverse index of opening infos: wall id → opening ids hosted at the last build. */
  private readonly openingsByWall = new Map<Id, Set<Id>>()
  private levelIds = new Set<Id>()
  private signature = ""
  private grid: GridParams = { x0: 0, z0: 0, size: 5, nx: 1, nz: 1 }
  private cells: (Cell | null)[] = [null]
  private stamp = 0
  private primitivesCache: OccluderPrimitive[] | null = null
  private hitT = Infinity

  constructor(scene: SceneLike) {
    this.resetGrid(scene, null)
    this.rebuildAll(scene)
    this._version = 1
  }

  get version(): number {
    return this._version
  }

  get primitives(): ReadonlyArray<OccluderPrimitive> {
    if (!this.primitivesCache) {
      this.primitivesCache = [...this.entries.values()].map((e) => e.prim).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    }
    return this.primitivesCache
  }

  /** Counts for diagnostics and benchmarks. */
  stats(): { primitives: number; cells: number; occupiedCells: number; registrations: number } {
    let occupied = 0
    let registrations = 0
    for (const c of this.cells) {
      if (c && c.entries.length > 0) {
        occupied++
        registrations += c.entries.length
      }
    }
    return { primitives: this.entries.size, cells: this.cells.length, occupiedCells: occupied, registrations }
  }

  // -------------------------------------------------------------------------
  // Segment queries
  // -------------------------------------------------------------------------

  segmentBlocked(from: Vec3, to: Vec3, opts: SegmentQueryOptions): boolean {
    return this.traverse(from, to, opts, false) !== null
  }

  raycast(from: Vec3, to: Vec3, opts: SegmentQueryOptions): RayHit | null {
    const e = this.traverse(from, to, opts, true)
    return e ? { t: this.hitT, primitive: e.prim } : null
  }

  private entryT(e: Entry, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, len: number): number {
    const p = e.prim
    switch (p.shape) {
      case "box":
        return boxEntry(p, e.cos, e.sin, ox, oy, oz, dx, dy, dz, len)
      case "cylinder":
        return cylinderEntry(p, ox, oy, oz, dx, dy, dz, len)
      case "heightfield":
        return heightfieldEntry(p, ox, oy, oz, dx, dy, dz, len)
      case "strip":
        return stripEntry(p, e.cos, e.sin, e.bounds.maxY, ox, oy, oz, dx, dy, dz, len)
    }
  }

  /**
   * Walk the grid cells along from→to. Returns the first blocking entry (any, or the nearest when
   * `nearest`), with its entry parameter in this.hitT.
   */
  private traverse(from: Vec3, to: Vec3, opts: SegmentQueryOptions, nearest: boolean): Entry | null {
    const ox = from.x
    const oy = from.y
    const oz = from.z
    const dx = to.x - ox
    const dy = to.y - oy
    const dz = to.z - oz
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (!(len > 0)) return null
    const bit = CHANNEL_BIT[opts.channel]
    const ignore = opts.ignoreSourceIds && opts.ignoreSourceIds.size > 0 ? opts.ignoreSourceIds : null
    const { x0, z0, size, nx, nz } = this.grid
    if (!clipSegmentToBox2Into(ox, oz, ox + dx, oz + dz, x0, z0, x0 + nx * size, z0 + nz * size, clipRange)) return null
    const ta = clipRange.t0
    const tb = clipRange.t1
    const stamp = ++this.stamp
    const cells = this.cells

    let i = Math.floor((ox + dx * ta - x0) / size)
    let j = Math.floor((oz + dz * ta - z0) / size)
    i = i < 0 ? 0 : i >= nx ? nx - 1 : i
    j = j < 0 ? 0 : j >= nz ? nz - 1 : j
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
    const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0
    const tDeltaX = dx !== 0 ? size / Math.abs(dx) : Infinity
    const tDeltaZ = dz !== 0 ? size / Math.abs(dz) : Infinity
    let tMaxX = dx > 0 ? (x0 + (i + 1) * size - ox) / dx : dx < 0 ? (x0 + i * size - ox) / dx : Infinity
    let tMaxZ = dz > 0 ? (z0 + (j + 1) * size - oz) / dz : dz < 0 ? (z0 + j * size - oz) / dz : Infinity
    let tc0 = ta
    let best = Infinity
    let bestEntry: Entry | null = null

    for (;;) {
      const tc1 = tMaxX < tMaxZ ? (tMaxX < tb ? tMaxX : tb) : tMaxZ < tb ? tMaxZ : tb
      const cell = cells[j * nx + i]
      if (cell !== null && (cell.mask & bit) !== 0) {
        const ya = oy + dy * tc0
        const yb = oy + dy * tc1
        const lo = ya < yb ? ya : yb
        const hi = ya < yb ? yb : ya
        if (hi >= cell.minY - EPS && lo <= cell.maxY + EPS) {
          const list = cell.entries
          for (let k = 0; k < list.length; k++) {
            const e = list[k]
            if (e.stamp === stamp) continue
            e.stamp = stamp
            if ((e.mask & bit) === 0) continue
            if (ignore !== null && ignore.has(e.prim.sourceId)) continue
            const b = e.bounds
            if (
              !lineAABB3(ox, oy, oz, dx, dy, dz, b.minX - EPS, b.minY - EPS, b.minZ - EPS, b.maxX + EPS, b.maxY + EPS, b.maxZ + EPS, scratch) ||
              scratch.t1 < 0 ||
              scratch.t0 > 1 ||
              scratch.t0 >= best
            ) {
              continue
            }
            const t = this.entryT(e, ox, oy, oz, dx, dy, dz, len)
            if (t > 0 && t < 1) {
              if (!nearest) {
                this.hitT = t
                return e
              }
              // Exact ties (coplanar faces) go to the smallest key, so the reported primitive does
              // not depend on registration order (edit history).
              if (t < best || (t === best && bestEntry !== null && e.prim.key < bestEntry.prim.key)) {
                best = t
                bestEntry = e
              }
            }
          }
        }
      }
      // Any primitive entered before this cell's exit has been tested (its entry point lies in a
      // visited cell), so the nearest hit is final once it precedes the exit.
      if (bestEntry !== null && best <= tc1) break
      if (tc1 >= tb) break
      if (tMaxX < tMaxZ) {
        i += stepX
        if (i < 0 || i >= nx) break
        tc0 = tMaxX
        tMaxX += tDeltaX
      } else {
        j += stepZ
        if (j < 0 || j >= nz) break
        tc0 = tMaxZ
        tMaxZ += tDeltaZ
      }
    }
    this.hitT = best
    return bestEntry
  }

  // -------------------------------------------------------------------------
  // Point and area queries
  // -------------------------------------------------------------------------

  containing(p: Vec3, channel?: BlockChannel): OccluderPrimitive[] {
    const { x0, z0, size, nx, nz } = this.grid
    const i = Math.floor((p.x - x0) / size)
    const j = Math.floor((p.z - z0) / size)
    if (i < 0 || j < 0 || i >= nx || j >= nz) return []
    const cell = this.cells[j * nx + i]
    if (!cell) return []
    const bit = channel ? CHANNEL_BIT[channel] : 7
    const out: OccluderPrimitive[] = []
    for (const e of cell.entries) {
      if ((e.mask & bit) === 0) continue
      if (!aabb3ContainsPoint(e.bounds, p, EPS)) continue
      if (primitiveContains(e.prim, p)) out.push(e.prim)
    }
    return out
  }

  queryCircle(levelId: Id | null, center: Vec2, radius: number): OccluderPrimitive[] {
    const r = Math.max(0, radius)
    return this.queryArea(
      levelId,
      { x: center.x - r, z: center.z - r, w: 2 * r, d: 2 * r },
      (e) => footprintOverlapsCircle(e.prim, center, r)
    )
  }

  queryRect(levelId: Id | null, rect: Rect): OccluderPrimitive[] {
    return this.queryArea(levelId, rect, (e) => footprintOverlapsRect(e.prim, rect))
  }

  private queryArea(levelId: Id | null, box: Rect, test: (e: Entry) => boolean): OccluderPrimitive[] {
    const { x0, z0, size, nx, nz } = this.grid
    const i0 = Math.max(0, Math.floor((box.x - x0) / size))
    const j0 = Math.max(0, Math.floor((box.z - z0) / size))
    const i1 = Math.min(nx - 1, Math.floor((box.x + box.w - x0) / size))
    const j1 = Math.min(nz - 1, Math.floor((box.z + box.d - z0) / size))
    const stamp = ++this.stamp
    const out: OccluderPrimitive[] = []
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cell = this.cells[j * nx + i]
        if (!cell) continue
        for (const e of cell.entries) {
          if (e.stamp === stamp) continue
          e.stamp = stamp
          if (levelId !== null && e.prim.levelId !== levelId) continue
          const b = e.bounds
          if (b.maxX <= box.x || b.minX >= box.x + box.w || b.maxZ <= box.z || b.minZ >= box.z + box.d) continue
          if (test(e)) out.push(e.prim)
        }
      }
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Updates
  // -------------------------------------------------------------------------

  update(scene: SceneLike, changedSourceIds: Iterable<Id>): DirtyRegion[] {
    const ids = [...changedSourceIds]
    if (structureSignature(scene) !== this.signature || ids.some((id) => Object.hasOwn(scene.levels, id) || this.levelIds.has(id))) {
      return this.rebuildAll(scene)
    }
    const ctx = new BuildContext(scene)
    const set = new Set<Id>()
    for (const id of ids) this.expand(ctx, id, set)
    return this.rebuildSources(ctx, set)
  }

  updateTerrain(scene: SceneLike, levelId: Id, rect: Rect): DirtyRegion[] {
    if (structureSignature(scene) !== this.signature) return this.rebuildAll(scene)
    if (!Object.hasOwn(scene.levels, levelId)) return []
    const ctx = new BuildContext(scene)
    const r = inflateRect(rect, ctx.terrain(levelId).spacing + 0.1)
    const set = new Set<Id>()
    for (const o of ctx.objectsOn(levelId)) {
      if (!OCCLUDER_TYPES.has(o.type) || o.type === "door" || o.type === "window") continue
      const fp = objectFootprintRect(o)
      if (!fp || !rectsOverlap(fp, r)) continue
      set.add(o.id)
      if (o.type === "wall") for (const op of ctx.openingsOf(o.id)) set.add(op.id)
    }
    // Stairs/ramps arriving on this level interpolate up to its ground.
    for (const o of Object.values(scene.objects)) {
      if (o.type === "connector" && o.toLevelId === levelId && rectsOverlap(o.rect, r)) set.add(o.id)
    }
    return this.rebuildSources(ctx, set)
  }

  /** Add a changed source and the sources whose primitives depend on it. */
  private expand(ctx: BuildContext, id: Id, set: Set<Id>): void {
    const old = this.infos.get(id)
    const neu = ctx.object(id)
    const neuRelevant = neu !== undefined && OCCLUDER_TYPES.has(neu.type)
    if (!old && !neuRelevant) return
    set.add(id)

    // Walls: their openings (door leaves / window boxes follow the wall) and the walls whose joints change.
    if (old?.type === "wall" || neu?.type === "wall") {
      for (const o of ctx.openingsOf(id)) set.add(o.id)
      for (const o of this.openingsByWall.get(id) ?? []) set.add(o)
      if (old?.type === "wall" && old.a && old.b && ctx.hasLevel(old.levelId)) {
        for (const p of [old.a, old.b]) for (const w of ctx.wallsWithEndpointAt(old.levelId, p, id)) set.add(w)
      }
      if (neu?.type === "wall") {
        for (const p of [neu.a, neu.b]) for (const w of ctx.wallsWithEndpointAt(neu.levelId, p, id)) set.add(w)
      }
    }

    // Openings: the host wall's pieces depend on position/size (not on door state or style).
    if (old?.type === "door" || old?.type === "window" || neu?.type === "door" || neu?.type === "window") {
      const newSig = neu && (neu.type === "door" || neu.type === "window") ? openingSignature(neu) : undefined
      if (old?.openingSig !== newSig) {
        if (old?.wallId) set.add(old.wallId)
        if (neu && (neu.type === "door" || neu.type === "window")) set.add(neu.wallId)
      }
    }

    // Connectors cut the floors of every level their rise passes through.
    if (old?.type === "connector" || neu?.type === "connector") {
      const spans: [Id, Id][] = []
      if (old?.type === "connector" && old.toLevelId) spans.push([old.levelId, old.toLevelId])
      if (neu?.type === "connector") spans.push([neu.levelId, neu.toLevelId])
      for (const [a, b] of spans) {
        if (!ctx.hasLevel(a) || !ctx.hasLevel(b)) continue
        const ea = ctx.scene.levels[a].elevation
        const eb = ctx.scene.levels[b].elevation
        const lo = Math.min(ea, eb)
        const hi = Math.max(ea, eb)
        for (const level of Object.values(ctx.scene.levels)) {
          if (!(lo < level.elevation && level.elevation <= hi)) continue
          for (const o of ctx.objectsOn(level.id)) if (o.type === "floor") set.add(o.id)
        }
      }
    }
  }

  private rebuildAll(scene: SceneLike): DirtyRegion[] {
    const ctx = new BuildContext(scene)
    const size = gridCellSize(scene)
    if (size !== this.grid.size) this.resetGrid(scene, null)
    const set = new Set<Id>(Object.keys(scene.objects))
    for (const id of this.infos.keys()) set.add(id)
    for (const id of this.bySource.keys()) set.add(id)
    const dirty = this.rebuildSources(ctx, set)
    this.signature = structureSignature(scene)
    this.levelIds = new Set(Object.keys(scene.levels))
    return dirty
  }

  /** Rebuild the primitives of `sources`, apply the differences, and return merged dirty regions. */
  private rebuildSources(ctx: BuildContext, sources: Iterable<Id>): DirtyRegion[] {
    const changes: { key: string; old?: OccluderPrimitive; neu?: OccluderPrimitive }[] = []
    for (const id of [...sources].sort()) {
      const prims = buildSource(ctx, id)
      const newKeys = new Set<string>()
      for (const p of prims) {
        newKeys.add(p.key)
        const old = this.entries.get(p.key)
        if (old && primitivesEqual(old.prim, p)) continue
        changes.push({ key: p.key, old: old?.prim, neu: p })
      }
      const oldKeys = this.bySource.get(id)
      if (oldKeys) {
        for (const k of oldKeys) {
          if (!newKeys.has(k)) changes.push({ key: k, old: this.entries.get(k)?.prim })
        }
      }
      if (newKeys.size > 0) this.bySource.set(id, newKeys)
      else this.bySource.delete(id)
      const o = ctx.object(id)
      this.setInfo(id, o ? sourceInfo(o) : null)
    }
    if (changes.length === 0) return []

    const added: Entry[] = []
    const regions: DirtyRegion[] = []
    for (const c of changes) {
      // Terrain edits keep a heightfield's layout and solid mask: patch the entry in place so only
      // the grid cells over the changed lattice region are touched.
      const entry = c.old && c.neu ? this.entries.get(c.key) : undefined
      if (entry && c.old?.shape === "heightfield" && c.neu?.shape === "heightfield" && heightfieldPatchable(c.old, c.neu)) {
        const diff = heightfieldDiffBounds(c.old, c.neu)
        if (diff) regions.push(regionOf(c.neu.levelId, diff))
        if (this.patchHeightfield(entry, c.neu, diff)) continue
        this.removeEntry(c.key)
        added.push(this.createEntry(c.neu))
        continue
      }
      regions.push(...changeRegions(c.old, c.neu))
      if (c.old) this.removeEntry(c.key)
      if (c.neu) added.push(this.createEntry(c.neu))
    }
    // Grow the grid if a new primitive lies outside it, else register the new entries in place.
    const outside = added.some((e) => !this.gridCovers(e.bounds))
    for (const e of added) this.entries.set(e.prim.key, e)
    if (outside) this.resetGrid(ctx.scene, added)
    else for (const e of added) this.register(e)

    this._version++
    this.primitivesCache = null
    return mergeRegions(regions)
  }

  /**
   * Swap a heightfield entry's primitive for one with the same layout and solid mask, updating the
   * per-cell Y ranges of the grid cells over `diff` only. Returns false (nothing changed) when the
   * set of registered cells would differ, so the caller re-registers the entry instead.
   */
  private patchHeightfield(e: Entry, hf: Heightfield, diff: AABB3 | null): boolean {
    if (diff) {
      const { x0, z0, size, nx, nz } = this.grid
      const gi0 = Math.max(0, Math.floor((diff.minX - REG_EPS - x0) / size))
      const gj0 = Math.max(0, Math.floor((diff.minZ - REG_EPS - z0) / size))
      const gi1 = Math.min(nx - 1, Math.floor((diff.maxX + REG_EPS - x0) / size))
      const gj1 = Math.min(nz - 1, Math.floor((diff.maxZ + REG_EPS - z0) / size))
      const w = gi1 - gi0 + 1
      const ranges = w > 0 && gj1 >= gj0 ? this.heightfieldCellRanges(hf, gi0, gj0, gi1, gj1) : null
      if (ranges) {
        const slots: number[] = []
        for (let gj = gj0; gj <= gj1; gj++) {
          for (let gi = gi0; gi <= gi1; gi++) {
            const m = (gj - gj0) * w + (gi - gi0)
            const cell = this.cells[gj * nx + gi]
            const k = cell ? cell.entries.indexOf(e) : -1
            if (ranges.lo[m] <= ranges.hi[m] !== k >= 0) return false
            slots.push(k)
          }
        }
        let s = 0
        for (let gj = gj0; gj <= gj1; gj++) {
          for (let gi = gi0; gi <= gi1; gi++, s++) {
            const k = slots[s]
            if (k < 0) continue
            const m = (gj - gj0) * w + (gi - gi0)
            const cell = this.cells[gj * nx + gi]!
            cell.minYs[k] = ranges.lo[m]
            cell.maxYs[k] = ranges.hi[m]
            summarizeCell(cell)
          }
        }
      }
    }
    e.prim = hf
    e.bounds = primitiveBounds(hf)
    return true
  }

  private setInfo(id: Id, info: SourceInfo | null): void {
    const prev = this.infos.get(id)
    if (prev?.wallId) {
      const set = this.openingsByWall.get(prev.wallId)
      set?.delete(id)
      if (set && set.size === 0) this.openingsByWall.delete(prev.wallId)
    }
    if (!info) {
      this.infos.delete(id)
      return
    }
    this.infos.set(id, info)
    if (info.wallId) {
      let set = this.openingsByWall.get(info.wallId)
      if (!set) this.openingsByWall.set(info.wallId, (set = new Set()))
      set.add(id)
    }
  }

  // -------------------------------------------------------------------------
  // Grid maintenance
  // -------------------------------------------------------------------------

  private createEntry(prim: OccluderPrimitive): Entry {
    const yaw = prim.shape === "box" || prim.shape === "strip" ? prim.yaw : 0
    return { prim, bounds: primitiveBounds(prim), mask: maskOf(prim.blocks), cos: Math.cos(yaw), sin: Math.sin(yaw), stamp: 0, cells: [] }
  }

  private removeEntry(key: string): void {
    const e = this.entries.get(key)
    if (!e) return
    this.entries.delete(key)
    this.unregister(e)
  }

  private gridCovers(b: AABB3): boolean {
    const g = this.grid
    if (b.minX > b.maxX) return true
    return b.minX >= g.x0 && b.minZ >= g.z0 && b.maxX <= g.x0 + g.nx * g.size && b.maxZ <= g.z0 + g.nz * g.size
  }

  /**
   * (Re)create the grid to cover the scene extent, every current entry and `extra`, then register
   * all entries.
   */
  private resetGrid(scene: SceneLike, extra: Entry[] | null): void {
    let size = gridCellSize(scene)
    let minX = 0
    let minZ = 0
    let maxX = scene.grid.width * scene.grid.cellSize
    let maxZ = scene.grid.depth * scene.grid.cellSize
    const grow = (b: AABB3) => {
      if (b.minX > b.maxX) return
      minX = Math.min(minX, b.minX)
      minZ = Math.min(minZ, b.minZ)
      maxX = Math.max(maxX, b.maxX)
      maxZ = Math.max(maxZ, b.maxZ)
    }
    for (const e of this.entries.values()) grow(e.bounds)
    if (extra) for (const e of extra) grow(e.bounds)
    const layout = (sz: number): GridParams => {
      const x0 = (Math.floor(minX / sz) - GRID_MARGIN) * sz
      const z0 = (Math.floor(minZ / sz) - GRID_MARGIN) * sz
      return { x0, z0, size: sz, nx: Math.ceil((maxX - x0) / sz) + GRID_MARGIN, nz: Math.ceil((maxZ - z0) / sz) + GRID_MARGIN }
    }
    let g = layout(size)
    while (g.nx * g.nz > MAX_GRID_CELLS) {
      size *= 2
      g = layout(size)
    }
    this.grid = g
    this.cells = new Array<Cell | null>(g.nx * g.nz).fill(null)
    for (const e of this.entries.values()) {
      e.cells = []
      this.register(e)
    }
  }

  private cellAt(index: number): Cell {
    let c = this.cells[index]
    if (!c) {
      c = { entries: [], minYs: [], maxYs: [], minY: Infinity, maxY: -Infinity, mask: 0 }
      this.cells[index] = c
    }
    return c
  }

  private addToCell(index: number, e: Entry, minY: number, maxY: number): void {
    const c = this.cellAt(index)
    c.entries.push(e)
    c.minYs.push(minY)
    c.maxYs.push(maxY)
    if (minY < c.minY) c.minY = minY
    if (maxY > c.maxY) c.maxY = maxY
    c.mask |= e.mask
    e.cells.push(index)
  }

  private register(e: Entry): void {
    const { x0, z0, size, nx, nz } = this.grid
    const b = e.bounds
    if (b.minX > b.maxX) return
    const i0 = Math.max(0, Math.floor((b.minX - REG_EPS - x0) / size))
    const j0 = Math.max(0, Math.floor((b.minZ - REG_EPS - z0) / size))
    const i1 = Math.min(nx - 1, Math.floor((b.maxX + REG_EPS - x0) / size))
    const j1 = Math.min(nz - 1, Math.floor((b.maxZ + REG_EPS - z0) / size))
    const p = e.prim
    if (p.shape === "heightfield") {
      this.registerHeightfield(e, p, i0, j0, i1, j1)
      return
    }
    if (p.shape === "strip") {
      this.registerStrip(e, p, i0, j0, i1, j1)
      return
    }
    // Axis-aligned boxes fill their AABB; rotated boxes and cylinders are tested per cell.
    const exact = p.shape === "cylinder" || (Math.abs(e.sin) > 1e-12 && Math.abs(e.cos) > 1e-12)
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (exact) {
          const cellBox = { minX: x0 + i * size, minZ: z0 + j * size, maxX: x0 + (i + 1) * size, maxZ: z0 + (j + 1) * size }
          const hit =
            p.shape === "cylinder"
              ? circleOverlapsAABB2({ x: p.base.x, z: p.base.z }, p.radius + REG_EPS, cellBox)
              : orientedRectOverlapsAABB2({ x: p.center.x, z: p.center.z }, p.halfExtents.x, p.halfExtents.z, p.yaw, cellBox, -REG_EPS)
          if (!hit) continue
        }
        this.addToCell(j * nx + i, e, b.minY, b.maxY)
      }
    }
  }

  /**
   * Register a strip in the cells its footprint overlaps (exact for rotated strips), each with the Y
   * range [bottom, highest top over the part of the strip whose local x the cell spans].
   */
  private registerStrip(e: Entry, st: WallStrip, i0: number, j0: number, i1: number, j1: number): void {
    const { x0, z0, size, nx } = this.grid
    const c = e.cos
    const s = e.sin
    const rotated = Math.abs(s) > 1e-12 && Math.abs(c) > 1e-12
    const hx = st.halfExtents.x
    // Half the extent of a cell projected onto the strip's local x axis.
    const reach = (size / 2) * (Math.abs(c) + Math.abs(s)) + REG_EPS
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const cellBox = { minX: x0 + i * size, minZ: z0 + j * size, maxX: x0 + (i + 1) * size, maxZ: z0 + (j + 1) * size }
        if (rotated && !orientedRectOverlapsAABB2(st.center, hx, st.halfExtents.z, st.yaw, cellBox, -REG_EPS)) continue
        const mid = c * (x0 + (i + 0.5) * size - st.center.x) - s * (z0 + (j + 0.5) * size - st.center.z)
        const lo = Math.max(-hx, mid - reach)
        const hi = Math.min(hx, mid + reach)
        this.addToCell(j * nx + i, e, st.bottom, lo <= hi ? stripMaxTop(st, lo, hi) : e.bounds.maxY)
      }
    }
  }

  /** Register a heightfield in the cells overlapping its solid lattice cells, with per-cell Y ranges. */
  private registerHeightfield(e: Entry, hf: Heightfield, i0: number, j0: number, i1: number, j1: number): void {
    const w = i1 - i0 + 1
    const d = j1 - j0 + 1
    if (w <= 0 || d <= 0) return
    const { lo, hi } = this.heightfieldCellRanges(hf, i0, j0, i1, j1)
    const nx = this.grid.nx
    for (let gj = 0; gj < d; gj++) {
      for (let gi = 0; gi < w; gi++) {
        const m = gj * w + gi
        if (lo[m] <= hi[m]) this.addToCell((j0 + gj) * nx + (i0 + gi), e, lo[m], hi[m])
      }
    }
  }

  /**
   * Y range of a heightfield's solid lattice cells within each grid cell of [i0, i1] × [j0, j1]
   * (row-major over that range; empty cells have lo > hi). A lattice cell counts for every grid cell
   * its footprint, inflated by REG_EPS, overlaps.
   */
  private heightfieldCellRanges(hf: Heightfield, i0: number, j0: number, i1: number, j1: number): { lo: Float64Array; hi: Float64Array } {
    const { x0, z0, size } = this.grid
    const w = i1 - i0 + 1
    const d = j1 - j0 + 1
    const lo = new Float64Array(w * d).fill(Infinity)
    const hi = new Float64Array(w * d).fill(-Infinity)
    const s = hf.spacing
    const cx = heightfieldCellsX(hf)
    const cz = heightfieldCellsZ(hf)
    const sx = hf.samplesX
    // Lattice cells that can reach the grid range (one lattice cell of slack on each side).
    const li0 = Math.max(0, Math.floor((x0 + i0 * size - hf.originX) / s) - 1)
    const li1 = Math.min(cx - 1, Math.floor((x0 + (i1 + 1) * size - hf.originX) / s) + 1)
    const lj0 = Math.max(0, Math.floor((z0 + j0 * size - hf.originZ) / s) - 1)
    const lj1 = Math.min(cz - 1, Math.floor((z0 + (j1 + 1) * size - hf.originZ) / s) + 1)
    for (let lj = lj0; lj <= lj1; lj++) {
      for (let li = li0; li <= li1; li++) {
        if (!hf.solid[lj * cx + li]) continue
        const k = lj * sx + li
        const h00 = hf.heights[k]
        const h10 = hf.heights[k + 1]
        const h01 = hf.heights[k + sx]
        const h11 = hf.heights[k + sx + 1]
        const cellLo = Math.min(h00, h10, h01, h11) - hf.thickness
        const cellHi = Math.max(h00, h10, h01, h11)
        const lx = hf.originX + li * s
        const lz = hf.originZ + lj * s
        const gi0 = Math.max(i0, Math.floor((lx - REG_EPS - x0) / size))
        const gi1 = Math.min(i1, Math.floor((lx + s + REG_EPS - x0) / size))
        const gj0 = Math.max(j0, Math.floor((lz - REG_EPS - z0) / size))
        const gj1 = Math.min(j1, Math.floor((lz + s + REG_EPS - z0) / size))
        for (let gj = gj0; gj <= gj1; gj++) {
          for (let gi = gi0; gi <= gi1; gi++) {
            const m = (gj - j0) * w + (gi - i0)
            if (cellLo < lo[m]) lo[m] = cellLo
            if (cellHi > hi[m]) hi[m] = cellHi
          }
        }
      }
    }
    return { lo, hi }
  }

  private unregister(e: Entry): void {
    for (const index of e.cells) {
      const c = this.cells[index]
      if (!c) continue
      const k = c.entries.indexOf(e)
      if (k < 0) continue
      const last = c.entries.length - 1
      c.entries[k] = c.entries[last]
      c.minYs[k] = c.minYs[last]
      c.maxYs[k] = c.maxYs[last]
      c.entries.pop()
      c.minYs.pop()
      c.maxYs.pop()
      if (c.entries.length === 0) this.cells[index] = null
      else summarizeCell(c)
    }
    e.cells = []
  }
}

/** Recompute a cell's Y range and channel mask from its entries. */
function summarizeCell(c: Cell): void {
  c.minY = Infinity
  c.maxY = -Infinity
  c.mask = 0
  for (let m = 0; m < c.entries.length; m++) {
    if (c.minYs[m] < c.minY) c.minY = c.minYs[m]
    if (c.maxYs[m] > c.maxY) c.maxY = c.maxYs[m]
    c.mask |= c.entries[m].mask
  }
}

/** Same level, lattice layout, channels and solid mask: only heights differ (a terrain edit). */
function heightfieldPatchable(a: Heightfield, b: Heightfield): boolean {
  return a.levelId === b.levelId && sameHeightfieldLayout(a, b) && maskOf(a.blocks) === maskOf(b.blocks) && sameArray(a.solid, b.solid)
}

function gridCellSize(scene: SceneLike): number {
  const s = scene.grid.cellSize
  return s > 0 && Number.isFinite(s) ? s : 5
}
