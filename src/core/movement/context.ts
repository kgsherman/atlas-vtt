/**
 * Per-search state for movement: connector spans, ground masks and heights per level, and the swept
 * footprint test against core/occlusion's movement blockers. One context serves one token profile
 * (size + height) over one scene/world snapshot; validateMove and findPath each create their own, and
 * findPath relies on its caches (every directed step is swept at most once per search).
 */
import { footprintOverlapsCapsule, footprintOverlapsCircle, primitiveBounds, stripMaxTop } from "../occlusion/primitives"
import type { OccluderPrimitive, OcclusionWorld } from "../occlusion/types"
import { connectorGround, effectiveFloorRects, levelGround, rectContains } from "../scene/queries"
import type { Cell, ConnectorObject, GridSettings, Id, Rect, SceneLike, Token, Vec2, WallObject } from "../scene/types"
import { anchorCenter, bodySide, footprintCells, footprintInBounds } from "./footprint"

/**
 * Clearance (feet) removed from a token's body before it is swept against movement blockers: a token
 * sweeps a disc whose diameter is its body side (footprint × cell) less twice this. A medium token (5 ft)
 * sweeps a 3.8 ft disc: it fits a 4 ft door centred on its cell and passes walls on its cell edges
 * (default thickness 0.5 → 0.25 ft into the cell), while a large token (8.8 ft) does not fit a 4 ft door.
 * A disc rather than the body's square keeps collisions independent of wall direction: in a building
 * rotated on a battlemap, a square's corners would reach 1.4× further into walls at 45°.
 */
export const MOVE_CLEARANCE = 0.6
/** Blockers whose top is at most this far above the token's ground are stepped over. */
export const STEP_UP_HEIGHT = 0.5
/**
 * Open doorways. Grid steps rarely cross a door at its centre (always so in a rotated wall), where the
 * disc would clip a jamb although the token clearly fits through the door. A step passes the host
 * wall's full-height pieces (the jambs; lintels and sills still block) when an open door at least as wide
 * as the disc is on it and, over the whole part of the step where the disc can touch the wall, the
 * token's centre stays at least this far inside the door's opening.
 */
export const DOORWAY_MARGIN = 0.5
/** Smallest radius (feet) of a swept disc (tiny tokens with a large clearance). */
const MIN_SWEEP_RADIUS = 0.1
/** Tokens are at least this tall for collision purposes (a zero-height token would pass everything). */
const MIN_BODY_HEIGHT = 1

const hasOwn = (o: object, k: string) => Object.hasOwn(o, k)

/** Radius (feet) of the disc a token of `size` sweeps: half its body side less MOVE_CLEARANCE. */
export function sweepRadius(grid: Pick<GridSettings, "cellSize">, size: Token["size"]): number {
  return Math.max(MIN_SWEEP_RADIUS, bodySide(grid, size) / 2 - MOVE_CLEARANCE)
}

/** Kept between a snapped door's edge and the walk's drift, so the doorway test is not decided by rounding. */
const DOORWAY_SNAP_SLACK = 0.1

/** Grid step directions (unit vectors) a straight walk can take, up to sign. */
const WALK_DIRECTIONS: readonly Vec2[] = [
  { x: 1, z: 0 },
  { x: 0, z: 1 },
  { x: Math.SQRT1_2, z: Math.SQRT1_2 },
  { x: Math.SQRT1_2, z: -Math.SQRT1_2 },
]

/**
 * Where to put a door of `width` on a wall that is not grid-aligned so that a token of `size` can walk
 * straight through it on the grid (the doorway rule, DOORWAY_MARGIN): a straight line of cell centres in
 * one of the 8 grid directions crosses the wall at c, and while that line is close enough to touch the
 * wall it stays within the opening when the door's centre is within c ± tolerance. Returns the offset
 * along the wall nearest to `desired` that satisfies this for some crossing within a few cells and for
 * which `fits` holds (no overlap with other openings), or null (grid-aligned wall, door narrower than
 * the token, or no crossing nearby).
 */
export function walkableDoorOffset(
  grid: Pick<GridSettings, "cellSize">,
  wall: Pick<WallObject, "a" | "b" | "thickness">,
  desired: number,
  width: number,
  size: Token["size"],
  fits: (offset: number) => boolean
): number | null {
  const len = Math.hypot(wall.b.x - wall.a.x, wall.b.z - wall.a.z)
  if (len < 1e-9) return null
  const ux = (wall.b.x - wall.a.x) / len
  const uz = (wall.b.z - wall.a.z) / len
  if (Math.abs(ux) < 1e-3 || Math.abs(uz) < 1e-3) return null
  const h = sweepRadius(grid, size)
  if (width < 2 * h) return null
  const reach = h + wall.thickness / 2
  const cs = grid.cellSize
  const px = wall.a.x + ux * desired
  const pz = wall.a.z + uz * desired
  const i0 = Math.floor(px / cs)
  const j0 = Math.floor(pz / cs)
  let best: number | null = null
  for (const d of WALK_DIRECTIONS) {
    // d · normal = cos of the angle between the walk and the wall's normal; the walk drifts along the
    // wall by reach · tan(angle) on either side of the crossing while it is within reach of the wall.
    const cos = Math.abs(d.x * -uz + d.z * ux)
    if (cos < 1e-6) continue
    const tolerance = width / 2 - DOORWAY_MARGIN - (reach * Math.sqrt(1 - cos * cos)) / cos - DOORWAY_SNAP_SLACK
    if (tolerance < 0) continue
    const den = d.x * uz - d.z * ux
    for (let i = i0 - 3; i <= i0 + 3; i++) {
      for (let j = j0 - 3; j <= j0 + 3; j++) {
        // Crossing of the line (cell centre + t·d) with the wall line (a + s·u): its offset s.
        const wx = (i + 0.5) * cs - wall.a.x
        const wz = (j + 0.5) * cs - wall.a.z
        const crossing = (wx * d.z - wz * d.x) / -den
        let offset = Math.min(Math.max(desired, crossing - tolerance), crossing + tolerance)
        if (!fits(offset)) {
          if (!fits(crossing)) continue
          offset = crossing
        }
        if (best === null || Math.abs(offset - desired) < Math.abs(best - desired)) best = offset
      }
    }
  }
  return best
}

/** A segment between two token centres. */
export interface Segment {
  a: Vec2
  b: Vec2
}

/** An open door's passable span [lo, hi] along its host wall (margins applied), in the wall's frame. */
interface Doorway {
  a: Vec2
  ux: number
  uz: number
  halfThickness: number
  lo: number
  hi: number
}

/** A wall, door or window piece that is not aligned with the grid (a rotated building's architecture). */
function offGridArchitecture(p: OccluderPrimitive): boolean {
  return (
    (p.shape === "box" || p.shape === "strip") &&
    (p.sourceType === "wall" || p.sourceType === "door" || p.sourceType === "window") &&
    Math.abs(Math.sin(2 * p.yaw)) > 1e-3
  )
}

/**
 * The centre segment from → to of a disc of radius `h` goes through the doorway: over the part of the
 * segment where the disc can touch the wall's slab, the centre stays within [lo, hi] along the wall.
 */
function passesDoorway(d: Doorway, from: Vec2, to: Vec2, h: number): boolean {
  const reach = h + d.halfThickness
  const d0 = (from.x - d.a.x) * -d.uz + (from.z - d.a.z) * d.ux
  const d1 = (to.x - d.a.x) * -d.uz + (to.z - d.a.z) * d.ux
  let t0 = 0
  let t1 = 1
  if (Math.abs(d1 - d0) > 1e-9) {
    const ta = (-reach - d0) / (d1 - d0)
    const tb = (reach - d0) / (d1 - d0)
    t0 = Math.max(0, Math.min(ta, tb))
    t1 = Math.min(1, Math.max(ta, tb))
    if (t0 > t1) return false
  } else if (Math.abs(d0) > reach) return false
  const along = (t: number) => (from.x + (to.x - from.x) * t - d.a.x) * d.ux + (from.z + (to.z - from.z) * t - d.a.z) * d.uz
  const s0 = along(t0)
  const s1 = along(t1)
  return Math.min(s0, s1) >= d.lo && Math.max(s0, s1) <= d.hi
}

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

/**
 * Vertical extent (world Y) of a primitive where a disc of radius `h` swept from a to b can touch it.
 * Strips (wall pieces following the terrain) take their highest top over the sweep's local-x span, so a
 * low wall on a slope is judged by its height where the token crosses it, not by its highest point.
 */
function verticalRange(p: OccluderPrimitive, a: Vec2, b: Vec2, h: number): [number, number] {
  switch (p.shape) {
    case "box":
      return [p.center.y - p.halfExtents.y, p.center.y + p.halfExtents.y]
    case "cylinder":
      return [p.base.y, p.base.y + p.height]
    case "heightfield": {
      const bb = primitiveBounds(p)
      return [bb.minY, bb.maxY]
    }
    case "strip": {
      const c = Math.cos(p.yaw)
      const s = Math.sin(p.yaw)
      const la = c * (a.x - p.center.x) - s * (a.z - p.center.z)
      const lb = c * (b.x - p.center.x) - s * (b.z - p.center.z)
      const hx = p.halfExtents.x
      const lo = Math.min(hx, Math.max(-hx, Math.min(la, lb) - h))
      const hi = Math.min(hx, Math.max(-hx, Math.max(la, lb) + h))
      return [p.bottom, stripMaxTop(p, lo, hi)]
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
  /** Radius (feet) of the swept disc (see MOVE_CLEARANCE). */
  readonly sweepRadius: number
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
  /** Open doors wide enough for this token, by host wall id (built on first use). */
  private doorways: Map<Id, Doorway[]> | null = null

  constructor(scene: SceneLike, world: OcclusionWorld, token: Pick<Token, "size" | "height">) {
    this.scene = scene
    this.world = world
    this.grid = scene.grid
    this.size = token.size
    this.k = footprintCells(token.size)
    this.sweepRadius = sweepRadius(scene.grid, token.size)
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
    const blocked = this.stepSweepBlocked(levelId, a, di, dj, null)
    if (cache) cache[idx] = blocked ? 2 : 1
    return blocked
  }

  /**
   * moveBlocked for an orthogonal leg of the diagonal step `diagonal`, for the corner-cutting rule
   * (uncached): only grid-aligned architecture and other blockers count. Walls, doors and windows that are
   * not grid-aligned are left to the diagonal's own sweep (they have no corners on the grid to cut: in a
   * rotated corridor the legs would clip its walls although the diagonal runs clear down the middle), and
   * so are the jambs of an open doorway the diagonal goes through.
   */
  legBlocked(levelId: Id, a: Cell, di: number, dj: number, diagonal: Segment): boolean {
    return this.stepSweepBlocked(levelId, a, di, dj, diagonal)
  }

  private stepSweepBlocked(levelId: Id, a: Cell, di: number, dj: number, legOf: Segment | null): boolean {
    const b = { i: a.i + di, j: a.j + dj }
    const gA = this.groundAtAnchor(levelId, a)
    const gB = this.groundAtAnchor(levelId, b)
    return this.sweepBlocked(
      this.stepLevels(levelId, a, b),
      this.center(a),
      this.center(b),
      Math.min(gA, gB) + STEP_UP_HEIGHT,
      Math.max(gA, gB) + this.height,
      gA,
      legOf
    )
  }

  /**
   * Sweep the token's disc (radius sweepRadius) from `from` to `to` against movement blockers on `levels`
   * whose vertical extent overlaps [yLo, yHi]. Blockers the token already overlaps at the start (XZ, and
   * vertically at its start ground `startGround`) are ignored, mirroring occlusion's "segments starting
   * inside a primitive ignore it" rule, so a token placed on a prop can walk off it. Wall pieces beside an
   * open door the step goes through are ignored too (DOORWAY_MARGIN). With `legOf`, the step is a
   * corner-cutting leg of that diagonal (see legBlocked).
   */
  sweepBlocked(
    levels: readonly Id[],
    from: Vec2,
    to: Vec2,
    yLo: number,
    yHi: number,
    startGround: number,
    legOf: Segment | null = null
  ): boolean {
    const h = this.sweepRadius
    const bbox: Rect = {
      x: Math.min(from.x, to.x) - h,
      z: Math.min(from.z, to.z) - h,
      w: Math.abs(to.x - from.x) + 2 * h,
      d: Math.abs(to.z - from.z) + 2 * h,
    }
    const startLo = startGround + STEP_UP_HEIGHT
    const startHi = startGround + this.height
    for (const levelId of levels) {
      for (const p of this.world.queryRect(levelId, bbox)) {
        if (!p.blocks.movement) continue
        const [y0, y1] = verticalRange(p, from, to, h)
        if (!(y0 < yHi && y1 > yLo)) continue
        if (!footprintOverlapsCapsule(p, from, to, h)) continue
        // Overlapping the token at its start: ignored (a strip by its extent under the start disc).
        const s1 = p.shape === "strip" ? verticalRange(p, from, from, h)[1] : y1
        if (y0 < startHi && s1 > startLo && footprintOverlapsCircle(p, from, h)) continue
        // Jambs of an open doorway the step goes through (lintels and sills still block).
        if (p.sourceType === "wall" && this.throughDoorway(p, from, to)) continue
        if (legOf !== null && (offGridArchitecture(p) || (p.sourceType === "wall" && this.throughDoorway(p, legOf.a, legOf.b)))) continue
        return true
      }
    }
    return false
  }

  /**
   * The token's disc standing at `p` overlaps a movement blocker on `levels` whose vertical extent
   * overlaps [yLo, yHi]. Unlike sweepBlocked there is no "already overlapping" exemption: this judges a
   * position the token arrives at without walking (a jump).
   */
  discBlocked(levels: readonly Id[], p: Vec2, yLo: number, yHi: number): boolean {
    const h = this.sweepRadius
    const bbox: Rect = { x: p.x - h, z: p.z - h, w: 2 * h, d: 2 * h }
    for (const levelId of levels) {
      for (const q of this.world.queryRect(levelId, bbox)) {
        if (!q.blocks.movement) continue
        const [y0, y1] = verticalRange(q, p, p, h)
        if (y0 < yHi && y1 > yLo && footprintOverlapsCircle(q, p, h)) return true
      }
    }
    return false
  }

  /** The step from → to goes through an open doorway of the wall that `p` (one of its full-height pieces) belongs to. */
  private throughDoorway(p: OccluderPrimitive, from: Vec2, to: Vec2): boolean {
    const wallId = p.sourceId
    if (p.key !== wallId && !p.key.startsWith(`${wallId}#after:`)) return false
    const doors = this.openDoorways().get(wallId)
    return doors !== undefined && doors.some((d) => passesDoorway(d, from, to, this.sweepRadius))
  }

  /** Open doors at least as wide as the token's disc, by host wall id (built on first use). */
  private openDoorways(): Map<Id, Doorway[]> {
    if (this.doorways) return this.doorways
    const out = new Map<Id, Doorway[]>()
    for (const o of Object.values(this.scene.objects)) {
      if (o.type !== "door" || o.state !== "open" || o.width < 2 * this.sweepRadius) continue
      const wall = hasOwn(this.scene.objects, o.wallId) ? this.scene.objects[o.wallId] : undefined
      if (!wall || wall.type !== "wall") continue
      const len = Math.hypot(wall.b.x - wall.a.x, wall.b.z - wall.a.z)
      if (len < 1e-9) continue
      const lo = Math.max(0, o.offset - o.width / 2) + DOORWAY_MARGIN
      const hi = Math.min(len, o.offset + o.width / 2) - DOORWAY_MARGIN
      if (hi < lo) continue
      let list = out.get(o.wallId)
      if (!list) out.set(o.wallId, (list = []))
      list.push({ a: wall.a, ux: (wall.b.x - wall.a.x) / len, uz: (wall.b.z - wall.a.z) / len, halfThickness: wall.thickness / 2, lo, hi })
    }
    this.doorways = out
    return out
  }
}
