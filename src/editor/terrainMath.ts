/**
 * Pure helpers of the terrain editing tool (ARCHITECTURE §7 "Terrain tools"): ray / plane math for drags,
 * the ramp's rise direction, height snapping and labels, hit testing of shapes and their elements (shapes
 * and faces by the pointer ray, vertices and edges in screen space through a projector), marquee
 * selection, click cycling through overlapping candidates, multi-edge collapse and selection pivots.
 * The screen-space math shared with the renderer (gizmo handles, the height-follow mapping) lives in
 * core/geometry/gizmo.
 */
import { snapPoint, type SnapMode } from "@/core/grid/grid"
import { pointToSegmentDistancePx, type Projector, type ScreenPoint } from "@/core/geometry/gizmo"
import { SCENE_LIMITS } from "@/core/scene/schema"
import {
  collapseEdge,
  elementVertexIndices,
  isValidTerrainShape,
  rayHitShape,
  shapeBounds,
  shapeEdgeCount,
  shapeEdgeEnds,
  topVertexCount,
  topVertices,
  withVertexMap,
  type TerrainElementMode,
  type TerrainElementRef,
} from "@/core/scene/terrainShapes"
import type { GridSettings, Id, Rect, TerrainShape, Vec2, Vec3 } from "@/core/scene/types"

export interface Ray {
  origin: Vec3
  direction: Vec3
}

/** Ascending direction of a ramp: 0 = +Z, 1 = +X, 2 = −Z, 3 = −X (like connectors and rampShape). */
export type RampDir = 0 | 1 | 2 | 3

/** Screen-space pick radius for vertices and edges (CSS px). */
export const ELEMENT_PICK_PX = 8
/** Heights snap to this step when snapping is off (Alt, free snap mode, heightStep 0). */
export const FREE_HEIGHT_STEP = 0.01

// ---------------------------------------------------------------------------
// Rays and planes
// ---------------------------------------------------------------------------

/**
 * The ray's intersection with the horizontal plane at world height `y`. Null when the ray is (nearly)
 * parallel to the plane or the plane lies behind the ray's origin.
 */
export function rayPlaneY(ray: Ray, y: number): Vec3 | null {
  const { origin: o, direction: d } = ray
  const len = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z)
  if (!(len > 0) || !(Math.abs(d.y) > 1e-6 * len)) return null
  const t = (y - o.y) / d.y
  if (!(t >= 0) || !Number.isFinite(t)) return null
  return { x: o.x + d.x * t, y, z: o.z + d.z * t }
}

/** Ray parameter (in units of `ray.direction`) of the point on the ray closest to `p`. */
export function rayParam(ray: Ray, p: Vec3): number {
  const d = ray.direction
  const len2 = d.x * d.x + d.y * d.y + d.z * d.z
  if (!(len2 > 0)) return 0
  return ((p.x - ray.origin.x) * d.x + (p.y - ray.origin.y) * d.y + (p.z - ray.origin.z) * d.z) / len2
}

export const rayAt = (ray: Ray, t: number): Vec3 => ({
  x: ray.origin.x + ray.direction.x * t,
  y: ray.origin.y + ray.direction.y * t,
  z: ray.origin.z + ray.direction.z * t,
})

// ---------------------------------------------------------------------------
// Ramp direction
// ---------------------------------------------------------------------------

const DIR_VECTORS: Record<RampDir, Vec2> = { 0: { x: 0, z: 1 }, 1: { x: 1, z: 0 }, 2: { x: 0, z: -1 }, 3: { x: -1, z: 0 } }

export const rampDirVector = (dir: RampDir): Vec2 => ({ ...DIR_VECTORS[dir] })

/** The ramp direction turned by quarter turns (+1 = the next direction in 0 → 1 → 2 → 3). */
export const turnRampDir = (dir: RampDir, turns: number): RampDir => ((((dir + Math.round(turns)) % 4) + 4) % 4) as RampDir

/**
 * The camera's horizontal "forward" from the pointer ray (normalised XZ), or null when the ray is
 * (nearly) vertical.
 */
export function horizontalForward(rayDir: Vec3): Vec2 | null {
  const h = Math.sqrt(rayDir.x * rayDir.x + rayDir.z * rayDir.z)
  const len = Math.sqrt(h * h + rayDir.y * rayDir.y)
  if (!(h > 1e-3 * len)) return null
  return { x: rayDir.x / h, z: rayDir.z / h }
}

/**
 * The world horizontal direction that points up on screen at `at` (for straight-down views, where the ray
 * has no horizontal component): the gradient of screen "up" over world X and Z. Null when not projectable.
 */
export function screenUpForward(project: Projector, at: Vec3): Vec2 | null {
  const p0 = project(at)
  const px = project({ x: at.x + 1, y: at.y, z: at.z })
  const pz = project({ x: at.x, y: at.y, z: at.z + 1 })
  if (!p0?.visible || !px?.visible || !pz?.visible) return null
  // Screen y grows downward: "up" is −y.
  const x = -(px.y - p0.y)
  const z = -(pz.y - p0.y)
  const len = Math.hypot(x, z)
  return len > 1e-9 ? { x: x / len, z: z / len } : null
}

/** Among `dirs`, the one most aligned with `forward` (null forward: −Z when offered, else the first). */
function bestAligned(dirs: readonly RampDir[], forward: Vec2 | null): RampDir {
  if (!forward) return dirs.includes(2) ? 2 : dirs[0]
  let best = dirs[0]
  let bestDot = -Infinity
  for (const d of dirs) {
    const v = DIR_VECTORS[d]
    const dot = v.x * forward.x + v.z * forward.z
    if (dot > bestDot + 1e-9) {
      best = d
      bestDot = dot
    }
  }
  return best
}

/**
 * A ramp's rise direction while its base is dragged by (dx, dz) from the first corner: the dominant drag
 * axis in the drag's sign. Switching axes needs the other axis to exceed the current one by `hysteresis`;
 * a tie (no previous direction, or no drag at all) rises away from the camera (`forward`, the camera's
 * horizontal view direction) among the drag's candidate directions.
 */
export function rampDirection(dx: number, dz: number, prev: RampDir | null, forward: Vec2 | null, hysteresis = 1.25): RampDir {
  const eps = 1e-9
  const ax = Math.abs(dx)
  const az = Math.abs(dz)
  if (ax <= eps && az <= eps) return prev ?? bestAligned([0, 1, 2, 3], forward)
  const xDir: RampDir = dx > 0 ? 1 : 3
  const zDir: RampDir = dz > 0 ? 0 : 2
  const prevAxis = prev === null ? null : prev % 2 === 1 ? "x" : "z"
  let axis: "x" | "z" | null
  if (prevAxis === "x") axis = az > ax * hysteresis ? "z" : "x"
  else if (prevAxis === "z") axis = ax > az * hysteresis ? "x" : "z"
  else axis = ax > az * hysteresis ? "x" : az > ax * hysteresis ? "z" : null
  if (axis === "x" && ax > eps) return xDir
  if (axis === "z" && az > eps) return zDir
  const cands: RampDir[] = []
  if (ax > eps) cands.push(xDir)
  if (az > eps) cands.push(zDir)
  return bestAligned(cands, forward)
}

// ---------------------------------------------------------------------------
// Heights and labels
// ---------------------------------------------------------------------------

/** h rounded to a multiple of `step` (step ≤ 0: FREE_HEIGHT_STEP), without float noise. */
export function snapHeight(h: number, step: number): number {
  const s = step > 0 ? step : FREE_HEIGHT_STEP
  const v = Math.round(h / s) * s
  const r = Math.round(v * 1e6) / 1e6
  return r === 0 ? 0 : r
}

/** Feet with at most two decimals and a true minus sign: "7.5", "−3", "0". */
export function formatFeet(v: number): string {
  const r = Math.round(v * 100) / 100
  if (r === 0) return "0"
  return r < 0 ? `−${String(-r)}` : String(r)
}

/** "+7.5 ft · Add", "−3 ft · Carve", "0 ft". */
export function heightLabel(h: number): string {
  const r = Math.round(h * 100) / 100
  if (r === 0) return "0 ft"
  return r > 0 ? `+${formatFeet(r)} ft · Add` : `${formatFeet(r)} ft · Carve`
}

/** "+5, 0, −2.5 ft": a move's offset (x, y, z). */
export function offsetLabel(d: Vec3): string {
  const f = (v: number) => (Math.round(v * 100) / 100 > 0 ? `+${formatFeet(v)}` : formatFeet(v))
  return `${f(d.x)}, ${f(d.y)}, ${f(d.z)} ft`
}

// ---------------------------------------------------------------------------
// Extent
// ---------------------------------------------------------------------------

/** Whether every point of the shape lies where the scene schema accepts it (grid extent ± coordMargin). */
export function shapeInExtent(shape: Pick<TerrainShape, "points">, grid: Pick<GridSettings, "width" | "depth" | "cellSize">): boolean {
  const m = SCENE_LIMITS.coordMargin
  const w = grid.width * grid.cellSize
  const d = grid.depth * grid.cellSize
  return shape.points.every((p) => p.x >= -m && p.z >= -m && p.x <= w + m && p.z <= d + m)
}

/** A shape `writeTerrain` and the document guard both accept. */
export function shapeAcceptable(shape: TerrainShape, grid: Pick<GridSettings, "width" | "depth" | "cellSize">): boolean {
  return shapeInExtent(shape, grid) && isValidTerrainShape(shape)
}

/** Largest radius of a circle centred at `c` that stays inside the grid extent ± coordMargin. */
export function maxRadiusInExtent(c: Vec2, grid: Pick<GridSettings, "width" | "depth" | "cellSize">): number {
  const m = SCENE_LIMITS.coordMargin
  const w = grid.width * grid.cellSize
  const d = grid.depth * grid.cellSize
  return Math.max(0, Math.min(c.x + m, w + m - c.x, c.z + m, d + m - c.z))
}

// ---------------------------------------------------------------------------
// Hit testing
// ---------------------------------------------------------------------------

/** World position of top vertex k (footprint point, or interior point k − n) of a shape on a level at `elevation`. */
export const vertexWorld = (shape: TerrainShape, k: number, elevation: number): Vec3 => {
  const n = shape.points.length
  const p = k < n ? shape.points[k] : shape.innerPoints![k - n]
  return { x: p.x, y: elevation + p.y, z: p.z }
}

function projectPoint(project: Projector, p: Vec3): ScreenPoint | null {
  const q = project(p)
  if (!q || !q.visible || !Number.isFinite(q.x) || !Number.isFinite(q.y)) return null
  return { x: q.x, y: q.y }
}

/**
 * Cheap rejection before rayHitShape: the part of the ray inside the prism's height range must cross the
 * footprint's bounding box (XZ).
 */
function rayMayHit(shape: TerrainShape, elevation: number, ray: Ray): boolean {
  const { origin: o, direction: d } = ray
  let lo = shape.base
  let hi = shape.base
  for (const p of topVertices(shape)) {
    if (p.y < lo) lo = p.y
    if (p.y > hi) hi = p.y
  }
  lo += elevation - 1e-6
  hi += elevation + 1e-6
  let t0 = 0
  let t1 = Infinity
  if (Math.abs(d.y) > 1e-12) {
    const a = (lo - o.y) / d.y
    const b = (hi - o.y) / d.y
    t0 = Math.max(0, Math.min(a, b))
    t1 = Math.max(a, b)
    if (!(t1 >= t0)) return false
  } else if (o.y < lo || o.y > hi) {
    return false
  }
  if (!Number.isFinite(t1)) return true
  const b = shapeBounds(shape)
  const x0 = o.x + d.x * t0
  const x1 = o.x + d.x * t1
  const z0 = o.z + d.z * t0
  const z1 = o.z + d.z * t1
  const eps = 1e-6
  return Math.max(x0, x1) >= b.x - eps && Math.min(x0, x1) <= b.x + b.w + eps && Math.max(z0, z1) >= b.z - eps && Math.min(z0, z1) <= b.z + b.d + eps
}

export interface ShapeHit {
  shapeId: Id
  /** Ray parameter of the hit (units of ray.direction). */
  t: number
  face: number | "top"
  point: Vec3
  /** The baked terrain is in front of the hit (the shape is buried / seen through the ground). */
  hidden: boolean
  /**
   * A carve hit on the picked terrain (within 0.5 ft): its pit is what the cursor shows there, though the top
   * of a shape it carves is hit first.
   */
  onGround: boolean
}

/**
 * Shapes under the pointer ray (rayHitShape per shape), nearest first; hits behind the baked terrain
 * (`groundT`: the ray parameter of the terrain pick, when known) by more than `tolerance` feet come last.
 * A carve hit within 0.5 ft of the terrain pick is `onGround` (a fixed tolerance, so shallow pits count).
 */
export function shapeHits(
  shapes: readonly TerrainShape[],
  elevation: number,
  ray: Ray,
  opts: { groundT?: number | null; tolerance?: number } = {}
): ShapeHit[] {
  const d = ray.direction
  const len = Math.sqrt(d.x * d.x + d.y * d.y + d.z * d.z) || 1
  const tol = (opts.tolerance ?? 0.5) / len
  const floorTol = 0.5 / len
  const groundT = opts.groundT ?? null
  const hits: ShapeHit[] = []
  for (const s of shapes) {
    if (!rayMayHit(s, elevation, ray)) continue
    const h = rayHitShape(s, elevation, ray)
    if (!h) continue
    const hidden = groundT !== null && groundT < h.t - tol
    const onGround = s.op === "carve" && groundT !== null && Math.abs(groundT - h.t) <= floorTol
    hits.push({ shapeId: s.id, t: h.t, face: h.face, point: rayAt(ray, h.t), hidden, onGround })
  }
  return hits.sort((a, b) => Number(a.hidden) - Number(b.hidden) || a.t - b.t || (a.shapeId < b.shapeId ? -1 : a.shapeId > b.shapeId ? 1 : 0))
}

export interface ElementHit {
  ref: TerrainElementRef
  /** Screen distance (px) for vertices and edges; ray parameter for faces. */
  distance: number
  /** World point the element is grabbed at (vertex, closest point of the edge, face hit). */
  point: Vec3
}

/** Top vertices of `shapes` within `radiusPx` of the cursor on screen, nearest first. */
export function vertexHits(
  shapes: readonly TerrainShape[],
  elevation: number,
  project: Projector,
  cursor: ScreenPoint,
  radiusPx = ELEMENT_PICK_PX
): ElementHit[] {
  const out: ElementHit[] = []
  for (const s of shapes) {
    for (let k = 0, count = topVertexCount(s); k < count; k++) {
      const w = vertexWorld(s, k, elevation)
      const q = projectPoint(project, w)
      if (!q) continue
      const dist = Math.hypot(q.x - cursor.x, q.y - cursor.y)
      if (dist <= radiusPx) out.push({ ref: { shapeId: s.id, kind: "vertex", index: k }, distance: dist, point: w })
    }
  }
  return out.sort((a, b) => a.distance - b.distance)
}

/** Top edges of `shapes` (outline and inner edges; `outlineOnly`: outline only) within `radiusPx` of the cursor on screen, nearest first. */
export function edgeHits(
  shapes: readonly TerrainShape[],
  elevation: number,
  project: Projector,
  cursor: ScreenPoint,
  radiusPx = ELEMENT_PICK_PX,
  outlineOnly = false
): ElementHit[] {
  const out: ElementHit[] = []
  for (const s of shapes) {
    const count = outlineOnly ? s.points.length : shapeEdgeCount(s)
    for (let k = 0; k < count; k++) {
      const [i, j] = shapeEdgeEnds(s, k)!
      const a = vertexWorld(s, i, elevation)
      const b = vertexWorld(s, j, elevation)
      const pa = projectPoint(project, a)
      const pb = projectPoint(project, b)
      if (!pa || !pb) continue
      const dist = pointToSegmentDistancePx(cursor, pa, pb)
      if (dist > radiusPx) continue
      const ex = pb.x - pa.x
      const ey = pb.y - pa.y
      const len2 = ex * ex + ey * ey
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((cursor.x - pa.x) * ex + (cursor.y - pa.y) * ey) / len2)) : 0.5
      const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
      out.push({ ref: { shapeId: s.id, kind: "edge", index: k }, distance: dist, point })
    }
  }
  return out.sort((a, b) => a.distance - b.distance)
}

/** The face of each shape the ray hits first (top or side k), nearest first (buried hits last, see shapeHits). */
export function faceHits(
  shapes: readonly TerrainShape[],
  elevation: number,
  ray: Ray,
  opts: { groundT?: number | null; tolerance?: number } = {}
): ElementHit[] {
  return shapeHits(shapes, elevation, ray, opts).map((h) => ({ ref: { shapeId: h.shapeId, kind: "face", index: h.face }, distance: h.t, point: h.point }))
}

/** Normalised screen rect of two corners. */
export interface ScreenRect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export const screenRect = (a: ScreenPoint, b: ScreenPoint): ScreenRect => ({
  x0: Math.min(a.x, b.x),
  y0: Math.min(a.y, b.y),
  x1: Math.max(a.x, b.x),
  y1: Math.max(a.y, b.y),
})

function projectedInside(project: Projector, p: Vec3, r: ScreenRect): boolean {
  const q = projectPoint(project, p)
  return q !== null && q.x >= r.x0 && q.x <= r.x1 && q.y >= r.y0 && q.y <= r.y1
}

/**
 * Elements of `mode` whose projection lies inside the screen rect: vertices by position, edges (outline and inner) with both
 * ends inside, side faces with their four corners inside, the top face with every top vertex inside.
 */
export function elementsInScreenRect(
  shapes: readonly TerrainShape[],
  elevation: number,
  project: Projector,
  r: ScreenRect,
  mode: TerrainElementMode
): TerrainElementRef[] {
  const out: TerrainElementRef[] = []
  for (const s of shapes) {
    const n = s.points.length
    const top = topVertices(s).map((_, k) => projectedInside(project, vertexWorld(s, k, elevation), r))
    if (mode === "vertex") {
      for (let k = 0; k < top.length; k++) if (top[k]) out.push({ shapeId: s.id, kind: "vertex", index: k })
    } else if (mode === "edge") {
      for (let k = 0, m = shapeEdgeCount(s); k < m; k++) {
        const [i, j] = shapeEdgeEnds(s, k)!
        if (top[i] && top[j]) out.push({ shapeId: s.id, kind: "edge", index: k })
      }
    } else {
      const base = s.points.map((p) => projectedInside(project, { x: p.x, y: elevation + s.base, z: p.z }, r))
      if (top.every(Boolean)) out.push({ shapeId: s.id, kind: "face", index: "top" })
      for (let k = 0; k < n; k++) {
        const j = (k + 1) % n
        if (top[k] && top[j] && base[k] && base[j]) out.push({ shapeId: s.id, kind: "face", index: k })
      }
    }
  }
  return out
}

/** Shapes whose top vertices all project inside the screen rect. */
export function shapesInScreenRect(shapes: readonly TerrainShape[], elevation: number, project: Projector, r: ScreenRect): Id[] {
  return shapes.filter((s) => s.points.every((_, k) => projectedInside(project, vertexWorld(s, k, elevation), r))).map((s) => s.id)
}

// ---------------------------------------------------------------------------
// Click cycling
// ---------------------------------------------------------------------------

/** The last click's candidates, for cycling through overlapping ones on repeated clicks at the same spot. */
export interface ClickCycle {
  at: ScreenPoint
  keys: string
  index: number
}

/** The click at `at` offers the same candidates (`keys`) within `slopPx` of the previous one. */
const sameCycle = (prev: ClickCycle | null, keys: string, at: ScreenPoint, slopPx: number): prev is ClickCycle =>
  prev !== null && prev.keys === keys && Math.hypot(at.x - prev.at.x, at.y - prev.at.y) <= slopPx

/**
 * Pick among `candidates` (best first): the first one, or — when the click is within `slopPx` of the previous
 * one and offers the same candidates — the one after the previous pick (wrapping).
 */
export function cyclePick<T>(
  candidates: readonly T[],
  keyOf: (c: T) => string,
  at: ScreenPoint,
  prev: ClickCycle | null,
  slopPx = 4
): { choice: T | null; cycle: ClickCycle | null } {
  if (candidates.length === 0) return { choice: null, cycle: null }
  const keys = candidates.map(keyOf).join("|")
  const index = sameCycle(prev, keys, at, slopPx) ? (prev.index + 1) % candidates.length : 0
  return { choice: candidates[index], cycle: { at: { ...at }, keys, index } }
}

/**
 * The candidate the click cycle currently sits on: `prev`'s last pick when `at` is within `slopPx` of that
 * click and the candidates are the same (cyclePick's test); null otherwise (a fresh spot).
 */
export function cycleCurrent<T>(candidates: readonly T[], keyOf: (c: T) => string, at: ScreenPoint, prev: ClickCycle | null, slopPx = 4): T | null {
  if (candidates.length === 0 || !sameCycle(prev, candidates.map(keyOf).join("|"), at, slopPx)) return null
  return candidates[prev.index] ?? null
}

// ---------------------------------------------------------------------------
// Elements and selections
// ---------------------------------------------------------------------------

export const elementKey = (e: TerrainElementRef) => `${e.shapeId}:${e.kind}:${e.index}`

export const sameElement = (a: TerrainElementRef | null, b: TerrainElementRef | null) =>
  a === b || (a !== null && b !== null && a.shapeId === b.shapeId && a.kind === b.kind && a.index === b.index)

/** Top-vertex indices per shape covered by the elements (shapes missing from `shapes` are skipped). */
export function elementVerticesByShape(shapes: Readonly<Record<Id, TerrainShape>>, elements: readonly TerrainElementRef[]): Map<Id, number[]> {
  const sets = new Map<Id, Set<number>>()
  for (const e of elements) {
    if (!Object.hasOwn(shapes, e.shapeId)) continue
    let set = sets.get(e.shapeId)
    if (!set) sets.set(e.shapeId, (set = new Set()))
    for (const k of elementVertexIndices(shapes[e.shapeId], e)) set.add(k)
  }
  const out = new Map<Id, number[]>()
  for (const [id, set] of sets)
    if (set.size > 0)
      out.set(
        id,
        [...set].sort((a, b) => a - b)
      )
  return out
}

/** Every element of `mode` of the shapes (select all in the advanced mode). */
export function allElements(shapes: readonly TerrainShape[], mode: TerrainElementMode): TerrainElementRef[] {
  const out: TerrainElementRef[] = []
  for (const s of shapes) {
    if (mode === "face") out.push({ shapeId: s.id, kind: "face", index: "top" })
    const count = mode === "edge" ? shapeEdgeCount(s) : mode === "vertex" ? topVertexCount(s) : s.points.length
    for (let k = 0; k < count; k++) out.push(mode === "face" ? { shapeId: s.id, kind: "face", index: k } : { shapeId: s.id, kind: mode, index: k })
  }
  return out
}

/** Union of the shapes' footprint bounds (null for none). */
export function shapesBounds(shapes: readonly TerrainShape[]): Rect | null {
  let x0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let z1 = -Infinity
  for (const s of shapes) {
    const b = shapeBounds(s)
    x0 = Math.min(x0, b.x)
    z0 = Math.min(z0, b.z)
    x1 = Math.max(x1, b.x + b.w)
    z1 = Math.max(z1, b.z + b.d)
  }
  return x0 <= x1 ? { x: x0, z: z0, w: x1 - x0, d: z1 - z0 } : null
}

/**
 * Pivot for rotating shapes, like editor/transform rotationPivot: the centre of their bounds snapped to the
 * nearest cell vertex (so grid-aligned shapes stay aligned) unless snapping is off.
 */
export function shapesPivot(shapes: readonly TerrainShape[], grid: GridSettings, mode: SnapMode): Vec2 | null {
  const b = shapesBounds(shapes)
  if (!b) return null
  const c = { x: b.x + b.w / 2, z: b.z + b.d / 2 }
  return mode === "free" ? c : snapPoint(grid, c, "vertex")
}

/** Mean world position of the given top vertices of `shapes` (null for none). */
export function verticesCentroid(shapes: ReadonlyMap<Id, TerrainShape>, indices: ReadonlyMap<Id, readonly number[]>, elevation: number): Vec3 | null {
  let x = 0
  let y = 0
  let z = 0
  let n = 0
  for (const [id, ks] of indices) {
    const s = shapes.get(id)
    if (!s) continue
    for (const k of ks) {
      const p = topVertices(s)[k]
      if (!p) continue
      x += p.x
      y += p.y
      z += p.z
      n++
    }
  }
  return n > 0 ? { x: x / n, y: elevation + y / n, z: z / n } : null
}

/**
 * Collapse the given top outline edges: every chain of consecutive selected edges merges into one vertex at
 * the mean of its vertices (a single edge: core collapseEdge, the midpoint in the edge's slot); inner edges
 * are re-indexed (core withVertexMap: those losing an end or merging dropped, dangling interior vertices go). Indices ≥ n (inner edges) are ignored. Null when
 * fewer than 3 vertices would remain or the result is invalid.
 */
export function collapseEdges(shape: TerrainShape, edges: readonly number[]): TerrainShape | null {
  const n = shape.points.length
  const sel = new Set(edges.filter((k) => Number.isInteger(k) && k >= 0 && k < n))
  if (sel.size === 0) return shape
  if (sel.size === 1) return collapseEdge(shape, [...sel][0])
  if (n - sel.size < 3) return null
  // Start the walk at a vertex whose incoming edge is not selected (one exists: not every edge is).
  let start = 0
  while (sel.has((start + n - 1) % n)) start++
  const points: Vec3[] = []
  const map: number[] = []
  let k = start
  for (let visited = 0; visited < n;) {
    let x = 0
    let y = 0
    let z = 0
    let count = 0
    for (;;) {
      const p = shape.points[k]
      map[k] = points.length
      x += p.x
      y += p.y
      z += p.z
      count++
      visited++
      const more = sel.has(k)
      k = (k + 1) % n
      if (!more) break
    }
    points.push({ x: x / count, y: y / count, z: z / count })
  }
  const inner = (shape.innerPoints ?? []).map((p) => ({ ...p }))
  inner.forEach((_, m) => (map[n + m] = points.length + m))
  return withVertexMap(shape, points, inner, map)
}
