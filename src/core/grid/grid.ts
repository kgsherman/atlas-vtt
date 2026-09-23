import type { Cell, DiagonalRule, GridSettings, Rect, Vec2 } from "../scene/types"

export function cellOf(grid: GridSettings, p: Vec2): Cell {
  return { i: Math.floor(p.x / grid.cellSize), j: Math.floor(p.z / grid.cellSize) }
}

export function cellCenter(grid: GridSettings, c: Cell): Vec2 {
  return { x: (c.i + 0.5) * grid.cellSize, z: (c.j + 0.5) * grid.cellSize }
}

export function cellRect(grid: GridSettings, c: Cell): Rect {
  return { x: c.i * grid.cellSize, z: c.j * grid.cellSize, w: grid.cellSize, d: grid.cellSize }
}

export function inBounds(grid: GridSettings, c: Cell): boolean {
  return c.i >= 0 && c.j >= 0 && c.i < grid.width && c.j < grid.depth
}

export function cellIndex(grid: GridSettings, c: Cell): number {
  return c.j * grid.width + c.i
}

export function cellFromIndex(grid: GridSettings, index: number): Cell {
  return { i: index % grid.width, j: Math.floor(index / grid.width) }
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.i === b.i && a.j === b.j
}

export type SnapMode = "center" | "vertex" | "half" | "free"

/** Snap a ground point. "center" = cell centres, "vertex" = cell corners, "half" = every half cell. */
export function snapPoint(grid: GridSettings, p: Vec2, mode: SnapMode): Vec2 {
  const s = grid.cellSize
  switch (mode) {
    case "center":
      return { x: (Math.floor(p.x / s) + 0.5) * s, z: (Math.floor(p.z / s) + 0.5) * s }
    case "vertex":
      return { x: Math.round(p.x / s) * s, z: Math.round(p.z / s) * s }
    case "half":
      return { x: Math.round((p.x * 2) / s) * (s / 2), z: Math.round((p.z * 2) / s) * (s / 2) }
    case "free":
      return { x: p.x, z: p.z }
  }
}

/**
 * Distance in feet of a single step between cells, given how many diagonal steps were
 * taken before it (for the alternating 5-10-5 rule).
 */
export function stepCost(
  grid: GridSettings,
  from: Cell,
  to: Cell,
  diagonalsSoFar: number,
  rule: DiagonalRule = grid.diagonalRule
): number {
  const di = Math.abs(to.i - from.i)
  const dj = Math.abs(to.j - from.j)
  const diagonal = di > 0 && dj > 0
  if (!diagonal) return (di + dj) * grid.cellSize
  switch (rule) {
    case "5-5-5":
      return grid.cellSize
    case "5-10-5":
      return diagonalsSoFar % 2 === 0 ? grid.cellSize : grid.cellSize * 2
    case "euclidean":
      return Math.SQRT2 * grid.cellSize
  }
}

/** Total distance of a cell path (feet). Consecutive duplicates (level changes) cost nothing. */
export function pathDistance(grid: GridSettings, cells: Cell[], rule: DiagonalRule = grid.diagonalRule): number {
  let total = 0
  let diagonals = 0
  for (let k = 1; k < cells.length; k++) {
    const a = cells[k - 1]
    const b = cells[k]
    if (sameCell(a, b)) continue
    total += stepCost(grid, a, b, diagonals, rule)
    if (a.i !== b.i && a.j !== b.j) diagonals++
  }
  return total
}

/** Cells overlapped by a rect (inclusive of partially covered cells). */
export function cellsInRect(grid: GridSettings, r: Rect): Cell[] {
  const s = grid.cellSize
  const i0 = Math.max(0, Math.floor(r.x / s))
  const j0 = Math.max(0, Math.floor(r.z / s))
  const i1 = Math.min(grid.width - 1, Math.ceil((r.x + r.w) / s) - 1)
  const j1 = Math.min(grid.depth - 1, Math.ceil((r.z + r.d) / s) - 1)
  const out: Cell[] = []
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out.push({ i, j })
  return out
}

// ---------------------------------------------------------------------------
// Rasterisation (supercover). All of these use CLOSED cell squares
// [i·s, (i+1)·s] × [j·s, (j+1)·s]: a shape that merely touches a cell edge or corner counts as
// touching that cell. Callers that need "positive length/area inside the cell" filter the
// intervals returned by segmentCellIntervals (t1 > t0). A small tolerance `eps` (feet) widens every
// cell so that shapes passing within eps of a corner or edge are reported conservatively; this is
// what makes the results robust at exact corners despite floating-point error.
// ---------------------------------------------------------------------------

/** Default tolerance (feet) for the rasterisation helpers below. */
export const RASTER_EPS = 1e-6

export interface RasterOptions {
  /** Tolerance in feet (default RASTER_EPS). */
  eps?: number
  /** Drop cells outside the grid extent (default true). */
  clip?: boolean
}

/** A cell touched by a segment and the parametric range [t0, t1] ⊆ [0, 1] of the segment inside it. */
export interface CellInterval {
  cell: Cell
  t0: number
  t1: number
}

/**
 * X extent of (convex polygon ∩ horizontal slab z0 ≤ z ≤ z1), or null if they do not meet.
 * `pts` may also be a 2-point segment or a single point. The intersection of a convex set with a
 * slab is convex, so its x-range is spanned by the polygon vertices inside the slab plus the
 * points where edges cross the slab boundaries.
 */
function slabXRange(pts: readonly Vec2[], z0: number, z1: number): { x0: number; x1: number } | null {
  let x0 = Infinity
  let x1 = -Infinity
  const n = pts.length
  for (let k = 0; k < n; k++) {
    const p = pts[k]
    if (p.z >= z0 && p.z <= z1) {
      if (p.x < x0) x0 = p.x
      if (p.x > x1) x1 = p.x
    }
    if (n < 2) continue
    const q = pts[(k + 1) % n]
    if (p.z === q.z) continue
    for (const zb of [z0, z1]) {
      const t = (zb - p.z) / (q.z - p.z)
      if (t > 0 && t < 1) {
        const x = p.x + (q.x - p.x) * t
        if (x < x0) x0 = x
        if (x > x1) x1 = x
      }
    }
  }
  return x0 <= x1 ? { x0, x1 } : null
}

/**
 * Cells whose closed square (widened by eps) intersects a convex polygon, a segment (2 points) or
 * a point (1 point). Exact per row: the polygon ∩ row slab is convex, so a cell of that row touches
 * the polygon iff its x-interval overlaps the slab's x-range. Row-major order (j, then i).
 */
function rasterConvex(grid: GridSettings, pts: readonly Vec2[], opts: RasterOptions = {}): Cell[] {
  if (pts.length === 0) return []
  const s = grid.cellSize
  const eps = opts.eps ?? RASTER_EPS
  const clip = opts.clip ?? true
  let zMin = Infinity
  let zMax = -Infinity
  for (const p of pts) {
    if (p.z < zMin) zMin = p.z
    if (p.z > zMax) zMax = p.z
  }
  // Rows whose closed, eps-widened slab [j·s − eps, (j+1)·s + eps] meets [zMin, zMax].
  let j0 = Math.ceil((zMin - eps) / s) - 1
  let j1 = Math.floor((zMax + eps) / s)
  if (clip) {
    j0 = Math.max(j0, 0)
    j1 = Math.min(j1, grid.depth - 1)
  }
  const out: Cell[] = []
  for (let j = j0; j <= j1; j++) {
    const range = slabXRange(pts, j * s - eps, (j + 1) * s + eps)
    if (!range) continue
    let i0 = Math.ceil((range.x0 - eps) / s) - 1
    let i1 = Math.floor((range.x1 + eps) / s)
    if (clip) {
      i0 = Math.max(i0, 0)
      i1 = Math.min(i1, grid.width - 1)
    }
    for (let i = i0; i <= i1; i++) out.push({ i, j })
  }
  return out
}

/**
 * Every cell a segment touches (supercover), including all cells around a lattice corner the
 * segment passes through and both rows/columns beside a segment lying on a grid line. Row-major
 * order; use segmentCellIntervals for cells ordered along the segment.
 */
export function supercoverCells(grid: GridSettings, a: Vec2, b: Vec2, opts: RasterOptions = {}): Cell[] {
  return rasterConvex(grid, [a, b], opts)
}

/** Cells whose closed square touches a convex polygon (vertices in either winding order). */
export function cellsInConvexPolygon(grid: GridSettings, pts: readonly Vec2[], opts: RasterOptions = {}): Cell[] {
  return rasterConvex(grid, pts, opts)
}

/**
 * Parametric range of the segment a→b inside an axis-aligned box (Liang–Barsky), or null.
 * Closed box; a zero-length segment is "inside" when the point is in the box.
 */
function clipSegmentToBox(a: Vec2, b: Vec2, x0: number, z0: number, x1: number, z1: number): [number, number] | null {
  let t0 = 0
  let t1 = 1
  const dx = b.x - a.x
  const dz = b.z - a.z
  const tests: [number, number][] = [
    [-dx, a.x - x0],
    [dx, x1 - a.x],
    [-dz, a.z - z0],
    [dz, z1 - a.z],
  ]
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return null
      continue
    }
    const r = q / p
    if (p < 0) {
      if (r > t1) return null
      if (r > t0) t0 = r
    } else {
      if (r < t0) return null
      if (r < t1) t1 = r
    }
  }
  return [t0, t1]
}

/**
 * Parametric t-range of a THICK segment (a→b swept by a cross-section of ±halfWidth along its
 * normal, no end caps: the footprint of a wall of thickness 2·halfWidth) inside a box: the
 * projection onto a→b of (box ∩ strip), clipped to [0, 1].
 */
function clipStripToBox(a: Vec2, b: Vec2, halfWidth: number, x0: number, z0: number, x1: number, z1: number): [number, number] | null {
  const len = Math.hypot(b.x - a.x, b.z - a.z)
  const dir = { x: (b.x - a.x) / len, z: (b.z - a.z) / len }
  const nrm = { x: -dir.z, z: dir.x }
  // Box polygon clipped by the two half-planes |dot(q − a, n)| ≤ halfWidth (Sutherland–Hodgman).
  let poly: Vec2[] = [
    { x: x0, z: z0 },
    { x: x1, z: z0 },
    { x: x1, z: z1 },
    { x: x0, z: z1 },
  ]
  for (const sign of [1, -1]) {
    const dist = (q: Vec2) => halfWidth - sign * ((q.x - a.x) * nrm.x + (q.z - a.z) * nrm.z)
    const next: Vec2[] = []
    for (let k = 0; k < poly.length; k++) {
      const p = poly[k]
      const q = poly[(k + 1) % poly.length]
      const dp = dist(p)
      const dq = dist(q)
      if (dp >= 0) next.push(p)
      if ((dp >= 0) !== (dq >= 0)) {
        const t = dp / (dp - dq)
        next.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t })
      }
    }
    poly = next
    if (poly.length === 0) return null
  }
  let t0 = Infinity
  let t1 = -Infinity
  for (const q of poly) {
    const t = ((q.x - a.x) * dir.x + (q.z - a.z) * dir.z) / len
    if (t < t0) t0 = t
    if (t > t1) t1 = t
  }
  t0 = Math.max(0, t0)
  t1 = Math.min(1, t1)
  return t0 <= t1 ? [t0, t1] : null
}

export interface SegmentCellOptions extends RasterOptions {
  /**
   * Treat the segment as a strip of this half-width (e.g. wall thickness / 2) with no end caps.
   * Each interval is then the range of t whose cross-section touches the cell. Default 0.
   */
  halfWidth?: number
}

/**
 * Cells touched by a segment (or, with halfWidth, by a wall-like strip) with the parametric range
 * of the segment inside each, sorted along the segment (by t0, then t1, then row-major).
 * Intervals of touching-only cells are degenerate (t0 === t1) at corners / end points.
 * Used for clipping walls to explored cells and for movement sweeps.
 */
export function segmentCellIntervals(grid: GridSettings, a: Vec2, b: Vec2, opts: SegmentCellOptions = {}): CellInterval[] {
  const s = grid.cellSize
  const eps = opts.eps ?? RASTER_EPS
  const hw = opts.halfWidth ?? 0
  const len = Math.hypot(b.x - a.x, b.z - a.z)
  const thick = hw > 0 && len > 0
  let candidates: Cell[]
  if (thick) {
    const nx = (-(b.z - a.z) / len) * hw
    const nz = ((b.x - a.x) / len) * hw
    candidates = rasterConvex(
      grid,
      [
        { x: a.x + nx, z: a.z + nz },
        { x: b.x + nx, z: b.z + nz },
        { x: b.x - nx, z: b.z - nz },
        { x: a.x - nx, z: a.z - nz },
      ],
      opts
    )
  } else {
    candidates = rasterConvex(grid, [a, b], opts)
  }
  const out: CellInterval[] = []
  for (const cell of candidates) {
    const x0 = cell.i * s - eps
    const z0 = cell.j * s - eps
    const x1 = (cell.i + 1) * s + eps
    const z1 = (cell.j + 1) * s + eps
    const range = thick ? clipStripToBox(a, b, hw + eps, x0, z0, x1, z1) : clipSegmentToBox(a, b, x0, z0, x1, z1)
    if (range) out.push({ cell, t0: range[0], t1: range[1] })
  }
  return out.sort((p, q) => p.t0 - q.t0 || p.t1 - q.t1 || p.cell.j - q.cell.j || p.cell.i - q.cell.i)
}

/** Distance from a point to the closest point of a cell's closed square (0 inside). */
export function distanceToCell(grid: GridSettings, p: Vec2, c: Cell): number {
  const s = grid.cellSize
  const dx = Math.max(c.i * s - p.x, 0, p.x - (c.i + 1) * s)
  const dz = Math.max(c.j * s - p.z, 0, p.z - (c.j + 1) * s)
  return Math.hypot(dx, dz)
}

/**
 * Cells whose closed square touches the closed disk of radius r around c (conservative: use it
 * for "may be affected by" queries such as light spheres or sense ranges). Row-major order.
 */
export function cellsInCircle(grid: GridSettings, c: Vec2, r: number, opts: RasterOptions = {}): Cell[] {
  if (!(r >= 0)) return []
  const s = grid.cellSize
  const eps = opts.eps ?? RASTER_EPS
  const clip = opts.clip ?? true
  const rr = r + eps
  let j0 = Math.ceil((c.z - rr) / s) - 1
  let j1 = Math.floor((c.z + rr) / s)
  if (clip) {
    j0 = Math.max(j0, 0)
    j1 = Math.min(j1, grid.depth - 1)
  }
  const out: Cell[] = []
  for (let j = j0; j <= j1; j++) {
    // Nearest z of the row to the centre → half-width of the disk's chord there.
    const dz = Math.max(j * s - c.z, 0, c.z - (j + 1) * s)
    if (dz > rr) continue
    const hw = Math.sqrt(rr * rr - dz * dz)
    let i0 = Math.ceil((c.x - hw) / s) - 1
    let i1 = Math.floor((c.x + hw) / s)
    if (clip) {
      i0 = Math.max(i0, 0)
      i1 = Math.min(i1, grid.width - 1)
    }
    for (let i = i0; i <= i1; i++) {
      if (distanceToCell(grid, c, { i, j }) <= rr) out.push({ i, j })
    }
  }
  return out
}
