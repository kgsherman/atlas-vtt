/**
 * Editor snapping rules (docs/ARCHITECTURE.md §7): cell centre / vertex / half / free for the
 * pointer, plus wall endpoints and wall centrelines for the wall tool, token footprint anchoring,
 * and opening placement along a host wall.
 */
import { snapPoint, type SnapMode } from "@/core/grid/grid"
import { walkableDoorOffset } from "@/core/movement"
import { SIZE_FOOTPRINT } from "@/core/scene/defaults"
import { OPENING_FIT_EPS } from "@/core/scene/integrity"
import { objectsOfType, wallDirection, wallLength, wallOpenings } from "@/core/scene/queries"
import type { CreatureSize, GridSettings, Id, Rect, SceneLike, Vec2, WallObject } from "@/core/scene/types"

/** Alt held = free placement. */
export function effectiveSnapMode(mode: SnapMode, alt: boolean): SnapMode {
  return alt ? "free" : mode
}

/**
 * Snap mode for things that live on grid LINES (walls, floor and connector edges): cell centres make
 * no sense there, so "center" means "vertex".
 */
export function edgeSnapMode(mode: SnapMode): SnapMode {
  return mode === "center" ? "vertex" : mode
}

/** Snap a ground point with the given mode (Alt → free). */
export function snapGround(grid: GridSettings, p: Vec2, mode: SnapMode, alt = false): Vec2 {
  return snapPoint(grid, p, effectiveSnapMode(mode, alt))
}

/** Scene extent on XZ (feet). */
export function extentRect(grid: GridSettings): Rect {
  return { x: 0, z: 0, w: grid.width * grid.cellSize, d: grid.depth * grid.cellSize }
}

/** Closed containment in the scene extent grown by `margin` feet. */
export function insideExtent(grid: GridSettings, p: Vec2, margin = 0): boolean {
  const e = extentRect(grid)
  return p.x >= -margin && p.z >= -margin && p.x <= e.w + margin && p.z <= e.d + margin
}

export function clampToExtent(grid: GridSettings, p: Vec2): Vec2 {
  const e = extentRect(grid)
  return { x: Math.min(Math.max(p.x, 0), e.w), z: Math.min(Math.max(p.z, 0), e.d) }
}

/** Footprint side in cells used for anchoring tokens (tiny tokens reserve a whole cell). */
export function tokenFootprintCells(size: CreatureSize): number {
  return Math.max(1, SIZE_FOOTPRINT[size])
}

/**
 * Token centre for a pointer position: the footprint's min corner sits on a cell corner (half-cell
 * corner in "half" mode), so medium tokens centre on cells and large ones on vertices.
 */
export function snapTokenPosition(grid: GridSettings, p: Vec2, size: CreatureSize, mode: SnapMode): Vec2 {
  if (mode === "free") return { x: p.x, z: p.z }
  const s = grid.cellSize
  const step = mode === "half" ? s / 2 : s
  const side = tokenFootprintCells(size) * s
  const x0 = Math.round((p.x - side / 2) / step) * step
  const z0 = Math.round((p.z - side / 2) / step) * step
  return { x: x0 + side / 2, z: z0 + side / 2 }
}

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

/** Closest point to p on segment a→b, and its parameter t ∈ [0, 1]. */
export function closestOnSegment(a: Vec2, b: Vec2, p: Vec2): { point: Vec2; t: number; distance: number } {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len2 = dx * dx + dz * dz
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0
  const point = { x: a.x + dx * t, z: a.z + dz * t }
  return { point, t, distance: Math.hypot(p.x - point.x, p.z - point.z) }
}

export interface WallSnapOptions {
  mode: SnapMode
  /** Capture radius for endpoints and centrelines, feet (default: 0.3 cell). */
  radius?: number
  /** Additional endpoint candidates (e.g. the start of the polyline being drawn). */
  extraPoints?: Vec2[]
  /** Walls to ignore. */
  excludeIds?: Id[]
}

export interface WallSnapResult {
  point: Vec2
  kind: "endpoint" | "centerline" | "grid" | "free"
  /** Wall whose endpoint / centreline was snapped to. */
  wallId: Id | null
}

/**
 * Snap a point for the wall tool. Priority: existing wall endpoints → wall centrelines (preferring
 * the grid point on the centreline when there is one within reach) → the grid → free.
 * mode "free" (Alt) disables every snap.
 */
export function snapWallPoint(scene: Pick<SceneLike, "objects" | "grid">, levelId: Id, p: Vec2, opts: WallSnapOptions): WallSnapResult {
  if (opts.mode === "free") return { point: { x: p.x, z: p.z }, kind: "free", wallId: null }
  const grid = scene.grid
  const radius = opts.radius ?? grid.cellSize * 0.3
  const exclude = new Set(opts.excludeIds ?? [])
  const walls = objectsOfType(scene, "wall", levelId).filter((w) => !exclude.has(w.id))

  let best: { point: Vec2; d: number; wallId: Id | null } | null = null
  const consider = (q: Vec2, wallId: Id | null) => {
    const d = Math.hypot(q.x - p.x, q.z - p.z)
    if (d <= radius && (!best || d < best.d)) best = { point: { x: q.x, z: q.z }, d, wallId }
  }
  for (const w of walls) {
    consider(w.a, w.id)
    consider(w.b, w.id)
  }
  for (const q of opts.extraPoints ?? []) consider(q, null)
  if (best) {
    const b = best as { point: Vec2; wallId: Id | null }
    return { point: b.point, kind: "endpoint", wallId: b.wallId }
  }

  const gridPoint = snapPoint(grid, p, edgeSnapMode(opts.mode))
  let line: { point: Vec2; d: number; wall: WallObject } | null = null
  for (const w of walls) {
    const c = closestOnSegment(w.a, w.b, p)
    if (c.distance <= radius && (!line || c.distance < line.d)) line = { point: c.point, d: c.distance, wall: w }
  }
  if (line) {
    const l = line as { point: Vec2; wall: WallObject }
    // A grid point lying on this centreline (T-junction on the grid) beats the raw projection.
    const onLine = closestOnSegment(l.wall.a, l.wall.b, gridPoint)
    if (onLine.distance <= 1e-6 && Math.hypot(gridPoint.x - p.x, gridPoint.z - p.z) <= radius) {
      return { point: gridPoint, kind: "grid", wallId: l.wall.id }
    }
    return { point: l.point, kind: "centerline", wallId: l.wall.id }
  }
  return { point: gridPoint, kind: "grid", wallId: null }
}

/**
 * Constrain `p` to the nearest 45° ray from `from` (Shift while drawing walls). The length is rounded
 * to half cells unless mode is "free".
 */
export function constrainAngle(grid: GridSettings, from: Vec2, p: Vec2, mode: SnapMode): Vec2 {
  const dx = p.x - from.x
  const dz = p.z - from.z
  const len = Math.hypot(dx, dz)
  if (len === 0) return { x: from.x, z: from.z }
  const step = Math.PI / 4
  const angle = Math.round(Math.atan2(dz, dx) / step) * step
  const dir = { x: Math.cos(angle), z: Math.sin(angle) }
  // Diagonal lengths are rounded so the END lands on the grid (a multiple of the unit per axis).
  const unit = mode === "free" ? 0 : grid.cellSize / 2
  let along = dx * dir.x + dz * dir.z
  if (unit > 0) {
    const diagonal = Math.abs(dir.x) > 1e-9 && Math.abs(dir.z) > 1e-9
    const k = diagonal ? unit * Math.SQRT2 : unit
    along = Math.round(along / k) * k
  }
  const round = (v: number) => (Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v)
  return { x: round(from.x + dir.x * along), z: round(from.z + dir.z * along) }
}

// ---------------------------------------------------------------------------
// Openings
// ---------------------------------------------------------------------------

export interface OpeningPlacement {
  /** Centre offset along a→b (feet). */
  offset: number
  /** false when the opening cannot fit anywhere near (wall too short or fully occupied). */
  valid: boolean
}

/**
 * Nearest valid centre offset for an opening of `width` on `wall`, given a desired offset: inside
 * [width/2, length − width/2] and not overlapping other openings of the wall (touching is allowed).
 * With a snap mode, the snapped offset is preferred when valid (centre: cell centres along the wall,
 * vertex: whole cells, half: half cells, measured from a); a door (`kind: "door"`) in a wall that is not
 * grid-aligned instead goes to the nearest offset a medium token can walk through on the grid.
 */
export function placeOpening(
  scene: Pick<SceneLike, "objects" | "grid">,
  wall: WallObject,
  desired: number,
  width: number,
  opts: { mode: SnapMode; excludeId?: Id; kind?: "door" | "window" } = { mode: "free" }
): OpeningPlacement {
  const len = wallLength(wall)
  const lo = width / 2
  const hi = len - width / 2
  if (!(width > 0) || hi < lo - OPENING_FIT_EPS) return { offset: Math.min(Math.max(desired, 0), len), valid: false }

  // Allowed centre intervals: [lo, hi] minus (o.lo − w/2, o.hi + w/2) for every other opening.
  let allowed: [number, number][] = [[lo, Math.max(lo, hi)]]
  for (const o of wallOpenings(scene, wall.id)) {
    if (o.id === opts.excludeId) continue
    const b0 = o.offset - o.width / 2 - width / 2
    const b1 = o.offset + o.width / 2 + width / 2
    const next: [number, number][] = []
    for (const [a0, a1] of allowed) {
      if (b1 <= a0 + OPENING_FIT_EPS || b0 >= a1 - OPENING_FIT_EPS) {
        next.push([a0, a1])
        continue
      }
      if (b0 > a0) next.push([a0, b0])
      if (b1 < a1) next.push([b1, a1])
    }
    allowed = next
  }
  if (allowed.length === 0) return { offset: Math.min(Math.max(desired, lo), Math.max(lo, hi)), valid: false }

  const nearest = (t: number): number => {
    let bestT = allowed[0][0]
    let bestD = Infinity
    for (const [a0, a1] of allowed) {
      const c = Math.min(Math.max(t, a0), a1)
      const d = Math.abs(c - t)
      if (d < bestD) {
        bestD = d
        bestT = c
      }
    }
    return bestT
  }
  const isAllowed = (t: number) => allowed.some(([a0, a1]) => t >= a0 - 1e-9 && t <= a1 + 1e-9)

  if (opts.mode !== "free") {
    const s = scene.grid.cellSize
    // Doors in rotated walls (battlemap buildings) go where grid movement can walk straight through
    // them (core/movement's doorway rule): usually where the pointer is, else a foot or two along.
    if (opts.kind === "door") {
      const walkable = walkableDoorOffset(scene.grid, wall, desired, width, "medium", isAllowed)
      if (walkable !== null) return { offset: walkable, valid: true }
    }
    const step = opts.mode === "half" ? s / 2 : s
    const shift = opts.mode === "center" ? s / 2 : 0
    const snapped = Math.round((desired - shift) / step) * step + shift
    // Try the snapped offset, then its neighbours, before falling back to the raw nearest point.
    const candidates = [snapped, snapped - step, snapped + step].filter(isAllowed)
    if (candidates.length > 0) {
      candidates.sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired))
      return { offset: candidates[0], valid: true }
    }
  }
  return { offset: nearest(desired), valid: true }
}

/** Offset along a wall of the projection of p. */
export function offsetOnWall(wall: Pick<WallObject, "a" | "b">, p: Vec2): number {
  const dir = wallDirection(wall)
  return (p.x - wall.a.x) * dir.x + (p.z - wall.a.z) * dir.z
}

/** Nearest wall on a level whose centreline is within `radius` of p. */
export function nearestWall(scene: Pick<SceneLike, "objects">, levelId: Id, p: Vec2, radius: number): WallObject | null {
  let best: WallObject | null = null
  let bestD = Infinity
  for (const w of objectsOfType(scene, "wall", levelId)) {
    const d = closestOnSegment(w.a, w.b, p).distance
    if (d <= Math.max(radius, w.thickness / 2) && d < bestD) {
      bestD = d
      best = w
    }
  }
  return best
}
