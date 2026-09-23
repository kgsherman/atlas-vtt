/**
 * Per-search state for movement: connector spans, ground masks and heights per level, and the swept
 * footprint test against core/occlusion's movement blockers. One context serves one token profile
 * (size + height) over one scene/world snapshot; validateMove and findPath each create their own, and
 * findPath relies on its caches (every directed step is swept at most once per search).
 */
import { footprintOverlapsPolygon, footprintOverlapsRect, primitiveBounds } from "../occlusion/primitives"
import type { OccluderPrimitive, OcclusionWorld } from "../occlusion/types"
import { connectorGround, effectiveFloorRects, levelGround, rectContains } from "../scene/queries"
import type { Cell, ConnectorObject, GridSettings, Id, Rect, SceneLike, Token, Vec2 } from "../scene/types"
import { anchorCenter, bodySide, footprintCells, footprintInBounds } from "./footprint"

/**
 * Clearance (feet per side) removed from a token's body square before it is swept against movement
 * blockers. A medium token (5 ft) sweeps a 3.8 ft square: it fits a 4 ft door centred on its cell and
 * passes walls on its cell edges (default thickness 0.5 → 0.25 ft into the cell), while a large token
 * (8.8 ft) does not fit a 4 ft door. (docs/ARCHITECTURE.md §5.3 quotes 0.35 ft, which leaves a 4.3 ft
 * square that cannot pass a 4 ft door; 0.6 ft is what makes the documented behaviour hold.)
 */
export const MOVE_CLEARANCE = 0.6
/** Blockers whose top is at most this far above the token's ground are stepped over. */
export const STEP_UP_HEIGHT = 0.5
/** Smallest half-side (feet) of a swept square (tiny tokens with a large clearance). */
const MIN_SWEEP_HALF = 0.1
/** Tokens are at least this tall for collision purposes (a zero-height token would pass everything). */
const MIN_BODY_HEIGHT = 1

const hasOwn = (o: object, k: string) => Object.hasOwn(o, k)

// ---------------------------------------------------------------------------
// Connector spans (cell-aligned rects, see ConnectorObject)
// ---------------------------------------------------------------------------

/**
 * A connector's rect in cells plus its run frame. `along` grows in the ascending direction; the top
 * row is the row with the largest `along` inside the rect, and the "beyond" row is top + 1.
 */
export interface ConnectorSpan {
  c: ConnectorObject
  /** Inclusive cell range of the rect. */
  i0: number
  j0: number
  i1: number
  j1: number
  /** Run along ±Z (directions 0, 2) or ±X (1, 3). */
  alongZ: boolean
  /** +1 when ascending towards +Z / +X, −1 towards −Z / −X. */
  sign: 1 | -1
  /** Ascending step in cells. */
  fwd: Cell
  /** `along` of the top row. */
  top: number
  /** Lateral (across the run) cell range of the rect. */
  latLo: number
  latHi: number
}

export function connectorSpan(c: ConnectorObject, cellSize: number): ConnectorSpan | null {
  const r = c.rect
  const i0 = Math.round(r.x / cellSize)
  const j0 = Math.round(r.z / cellSize)
  const i1 = Math.round((r.x + r.w) / cellSize) - 1
  const j1 = Math.round((r.z + r.d) / cellSize) - 1
  if (i1 < i0 || j1 < j0 || c.levelId === c.toLevelId) return null
  const alongZ = c.direction === 0 || c.direction === 2
  const sign = c.direction === 0 || c.direction === 1 ? 1 : -1
  const fwd = [
    { i: 0, j: 1 },
    { i: 1, j: 0 },
    { i: 0, j: -1 },
    { i: -1, j: 0 },
  ][c.direction]
  const top = alongZ ? (sign > 0 ? j1 : -j0) : sign > 0 ? i1 : -i0
  return { c, i0, j0, i1, j1, alongZ, sign, fwd, top, latLo: alongZ ? i0 : j0, latHi: alongZ ? i1 : j1 }
}

export const spanContains = (sp: ConnectorSpan, i: number, j: number): boolean =>
  i >= sp.i0 && i <= sp.i1 && j >= sp.j0 && j <= sp.j1

/** Position of a cell along the run (grows in the ascending direction). */
export const spanAlong = (sp: ConnectorSpan, i: number, j: number): number => sp.sign * (sp.alongZ ? j : i)

/** Along-run range [lo, hi] of a k × k footprint anchored at `a`. */
export function footprintAlong(sp: ConnectorSpan, a: Cell, k: number): { lo: number; hi: number } {
  const p = sp.alongZ ? a.j : a.i
  const u = sp.sign * p
  const v = sp.sign * (p + k - 1)
  return u < v ? { lo: u, hi: v } : { lo: v, hi: u }
}

/** True when a k × k footprint lies laterally within the connector's width. */
export function footprintWithinLateral(sp: ConnectorSpan, a: Cell, k: number): boolean {
  const p = sp.alongZ ? a.i : a.j
  return p >= sp.latLo && p + k - 1 <= sp.latHi
}

/** True when a k × k footprint anchored at `a` overlaps the connector's rect. */
export function footprintOverlapsSpan(sp: ConnectorSpan, a: Cell, k: number): boolean {
  return a.i <= sp.i1 && a.i + k - 1 >= sp.i0 && a.j <= sp.j1 && a.j + k - 1 >= sp.j0
}

/** World point on the top edge of a stairs/ramp run, level with `p` across the run. */
export function topEdgePoint(sp: ConnectorSpan, p: Vec2, cellSize: number): Vec2 {
  if (sp.alongZ) return { x: p.x, z: (sp.sign > 0 ? sp.j1 + 1 : sp.j0) * cellSize }
  return { x: (sp.sign > 0 ? sp.i1 + 1 : sp.i0) * cellSize, z: p.z }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/** Vertical extent of a primitive (world Y). */
function verticalRange(p: OccluderPrimitive): [number, number] {
  switch (p.shape) {
    case "box":
      return [p.center.y - p.halfExtents.y, p.center.y + p.halfExtents.y]
    case "cylinder":
      return [p.base.y, p.base.y + p.height]
    case "heightfield": {
      const b = primitiveBounds(p)
      return [b.minY, b.maxY]
    }
  }
}

/** Direction index 0..7 of an 8-neighbour step (di, dj ∈ {−1, 0, 1}, not both 0). */
function dirIndex(di: number, dj: number): number {
  const k = (di + 1) * 3 + (dj + 1)
  return k < 4 ? k : k - 1
}

export class MoveContext {
  readonly scene: SceneLike
  readonly world: OcclusionWorld
  readonly grid: GridSettings
  readonly size: Token["size"]
  /** Footprint side in cells. */
  readonly k: number
  /** Half side (feet) of the swept square. */
  readonly sweepHalf: number
  /** Body height used for the vertical overlap test. */
  readonly height: number
  /** Every connector of the scene, sorted by id. */
  readonly connectors: ConnectorObject[]
  /** Every connector with a valid span, sorted by id. */
  readonly spans: ConnectorSpan[]
  /** Stairs/ramps (not ladders) with a valid span, by lower level, sorted by id. */
  private readonly runsByLevel = new Map<Id, ConnectorSpan[]>()
  /** Every stairs/ramp by lower level, sorted by id: they define ground heights (as groundHeightAt). */
  private readonly groundRuns = new Map<Id, ConnectorObject[]>()
  private readonly masks = new Map<Id, Uint8Array>()
  private readonly groundYs = new Map<Id, Float64Array>()
  /** Directed same-level step results per level: 0 = unknown, 1 = free, 2 = blocked. */
  private readonly edges = new Map<Id, Uint8Array>()

  constructor(scene: SceneLike, world: OcclusionWorld, token: Pick<Token, "size" | "height">) {
    this.scene = scene
    this.world = world
    this.grid = scene.grid
    this.size = token.size
    this.k = footprintCells(token.size)
    this.sweepHalf = Math.max(MIN_SWEEP_HALF, bodySide(scene.grid, token.size) / 2 - MOVE_CLEARANCE)
    this.height = Math.max(MIN_BODY_HEIGHT, Number.isFinite(token.height) ? token.height : MIN_BODY_HEIGHT)
    // Only connectors are sorted (by id, like connectorsAt), so construction stays O(objects).
    const connectors: ConnectorObject[] = []
    for (const o of Object.values(scene.objects)) if (o.type === "connector") connectors.push(o)
    connectors.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0))
    this.connectors = connectors
    const spans: ConnectorSpan[] = []
    for (const o of connectors) {
      if (o.style !== "ladder") {
        let runs = this.groundRuns.get(o.levelId)
        if (!runs) this.groundRuns.set(o.levelId, (runs = []))
        runs.push(o)
      }
      const sp = connectorSpan(o, scene.grid.cellSize)
      if (!sp) continue
      spans.push(sp)
      if (o.style !== "ladder") {
        let list = this.runsByLevel.get(o.levelId)
        if (!list) this.runsByLevel.set(o.levelId, (list = []))
        list.push(sp)
      }
    }
    this.spans = spans
  }

  hasLevel(id: Id): boolean {
    return hasOwn(this.scene.levels, id)
  }

  inBounds(anchor: Cell): boolean {
    return footprintInBounds(this.grid, this.k, anchor)
  }

  center(anchor: Cell): Vec2 {
    return anchorCenter(this.grid, this.size, anchor)
  }

  // -------------------------------------------------------------------------
  // Ground
  // -------------------------------------------------------------------------

  /**
   * Per-cell "has ground at the cell centre" for a level: exactly hasGroundAt() (effective floor rects,
   * stairs/ramps of this level, ladders touching it) evaluated at every cell centre.
   */
  groundMask(levelId: Id): Uint8Array {
    const cached = this.masks.get(levelId)
    if (cached) return cached
    const { width, depth, cellSize: s } = this.grid
    const mask = new Uint8Array(width * depth)
    const mark = (r: Rect) => {
      const i0 = Math.max(0, Math.floor(r.x / s))
      const j0 = Math.max(0, Math.floor(r.z / s))
      const i1 = Math.min(width - 1, Math.ceil((r.x + r.w) / s))
      const j1 = Math.min(depth - 1, Math.ceil((r.z + r.d) / s))
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          if (rectContains(r, { x: (i + 0.5) * s, z: (j + 0.5) * s })) mask[j * width + i] = 1
        }
      }
    }
    for (const f of effectiveFloorRects(this.scene, levelId)) mark(f.rect)
    for (const o of this.connectors) {
      const applies = o.style === "ladder" ? o.levelId === levelId || o.toLevelId === levelId : o.levelId === levelId
      if (applies) mark(o.rect)
    }
    this.masks.set(levelId, mask)
    return mask
  }

  /**
   * Every footprint cell centre has ground on the level. Exception for multi-cell tokens standing on
   * the upper level across a stairs/ramp top edge (they have just climbed it): cells over the run
   * count as supported when the footprint straddles the top edge and lies within the run's width.
   */
  footprintGrounded(levelId: Id, anchor: Cell): boolean {
    const mask = this.groundMask(levelId)
    const w = this.grid.width
    for (let j = anchor.j; j < anchor.j + this.k; j++) {
      for (let i = anchor.i; i < anchor.i + this.k; i++) {
        if (mask[j * w + i]) continue
        if (!this.straddleSupports(levelId, anchor, i, j)) return false
      }
    }
    return true
  }

  private straddleSupports(levelId: Id, anchor: Cell, i: number, j: number): boolean {
    if (this.k < 2) return false
    for (const sp of this.spans) {
      if (sp.c.style === "ladder" || sp.c.toLevelId !== levelId || !spanContains(sp, i, j)) continue
      const al = footprintAlong(sp, anchor, this.k)
      if (al.lo <= sp.top && al.hi > sp.top && footprintWithinLateral(sp, anchor, this.k)) return true
    }
    return false
  }

  /** Ground (world Y) at a point of a level, including stairs/ramp runs: same as groundHeightAt(). */
  groundAt(levelId: Id, p: Vec2): number {
    for (const c of this.groundRuns.get(levelId) ?? []) {
      if (rectContains(c.rect, p)) return connectorGround(this.scene, c, p)
    }
    return levelGround(this.scene, levelId, p.x, p.z)
  }

  /** Ground under the token centre for an anchor (cached per level for in-bounds anchors). */
  groundAtAnchor(levelId: Id, anchor: Cell): number {
    if (!this.inBounds(anchor)) return this.groundAt(levelId, this.center(anchor))
    let arr = this.groundYs.get(levelId)
    if (!arr) {
      arr = new Float64Array(this.grid.width * this.grid.depth).fill(NaN)
      this.groundYs.set(levelId, arr)
    }
    const idx = anchor.j * this.grid.width + anchor.i
    let y = arr[idx]
    if (Number.isNaN(y)) y = arr[idx] = this.groundAt(levelId, this.center(anchor))
    return y
  }

  // -------------------------------------------------------------------------
  // Blocking
  // -------------------------------------------------------------------------

  /**
   * Levels whose blockers matter for a same-level step: the level itself, plus the upper level of any
   * stairs/ramp run of this level that the footprint touches (a token near the top of a run is at the
   * upper level's height, so walls there can be in its way; the vertical test sorts it out).
   */
  private stepLevels(levelId: Id, a: Cell, b: Cell): Id[] {
    const out = [levelId]
    for (const sp of this.runsByLevel.get(levelId) ?? []) {
      const up = sp.c.toLevelId
      if (out.includes(up) || !this.hasLevel(up)) continue
      if (footprintOverlapsSpan(sp, a, this.k) || footprintOverlapsSpan(sp, b, this.k)) out.push(up)
    }
    return out
  }

  /** Same-level 8-neighbour step a → a + (di, dj) sweeps into a movement blocker. Cached per search. */
  moveBlocked(levelId: Id, a: Cell, di: number, dj: number): boolean {
    const cacheable = this.inBounds(a)
    let cache: Uint8Array | undefined
    let idx = 0
    if (cacheable) {
      cache = this.edges.get(levelId)
      if (!cache) {
        cache = new Uint8Array(this.grid.width * this.grid.depth * 8)
        this.edges.set(levelId, cache)
      }
      idx = (a.j * this.grid.width + a.i) * 8 + dirIndex(di, dj)
      if (cache[idx]) return cache[idx] === 2
    }
    const b = { i: a.i + di, j: a.j + dj }
    const gA = this.groundAtAnchor(levelId, a)
    const gB = this.groundAtAnchor(levelId, b)
    const blocked = this.sweepBlocked(
      this.stepLevels(levelId, a, b),
      this.center(a),
      this.center(b),
      Math.min(gA, gB) + STEP_UP_HEIGHT,
      Math.max(gA, gB) + this.height,
      gA
    )
    if (cache) cache[idx] = blocked ? 2 : 1
    return blocked
  }

  /**
   * Sweep the token's square (half side sweepHalf) from `from` to `to` against movement blockers on
   * `levels` whose vertical extent overlaps [yLo, yHi]. Blockers the token already overlaps at the
   * start (XZ, and vertically at its start ground `startGround`) are ignored, mirroring occlusion's
   * "segments starting inside a primitive ignore it" rule, so a token placed on a prop can walk off it.
   */
  sweepBlocked(levels: readonly Id[], from: Vec2, to: Vec2, yLo: number, yHi: number, startGround: number): boolean {
    const h = this.sweepHalf
    const bbox: Rect = {
      x: Math.min(from.x, to.x) - h,
      z: Math.min(from.z, to.z) - h,
      w: Math.abs(to.x - from.x) + 2 * h,
      d: Math.abs(to.z - from.z) + 2 * h,
    }
    // Axis-aligned moves (and in-place checks) sweep exactly the bbox, which queryRect tests exactly.
    // Diagonal moves sweep a hexagon: the two squares' convex hull.
    const dx = to.x - from.x
    const dz = to.z - from.z
    let hexagon: Vec2[] | null = null
    if (dx !== 0 && dz !== 0) {
      const sx = Math.sign(dx) * h
      const sz = Math.sign(dz) * h
      hexagon = [
        { x: from.x - sx, z: from.z - sz },
        { x: from.x + sx, z: from.z - sz },
        { x: to.x + sx, z: to.z - sz },
        { x: to.x + sx, z: to.z + sz },
        { x: to.x - sx, z: to.z + sz },
        { x: from.x - sx, z: from.z + sz },
      ]
    }
    const startRect: Rect = { x: from.x - h, z: from.z - h, w: 2 * h, d: 2 * h }
    const startLo = startGround + STEP_UP_HEIGHT
    const startHi = startGround + this.height
    for (const levelId of levels) {
      for (const p of this.world.queryRect(levelId, bbox)) {
        if (!p.blocks.movement) continue
        const [y0, y1] = verticalRange(p)
        if (!(y0 < yHi && y1 > yLo)) continue
        if (hexagon && !footprintOverlapsPolygon(p, hexagon)) continue
        if (y0 < startHi && y1 > startLo && footprintOverlapsRect(p, startRect)) continue
        return true
      }
    }
    return false
  }
}
