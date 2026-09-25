/**
 * Exact geometry of occluder primitives: bounds, containment, segment ENTRY tests (see
 * docs/ARCHITECTURE.md §2 "Occlusion query semantics"), footprint overlap and push-out helpers.
 *
 * All solids are CLOSED. A segment start within EPS of a solid counts as contained (the solid is
 * ignored for that segment); a solid blocks only when the segment enters it at t ∈ (0, 1) and
 * penetrates by more than EPS.
 */
import {
  capsuleOverlapsAABB2,
  circleOverlapsAABB2,
  orientedRectBounds,
  orientedRectCorners,
  orientedRectOverlapsAABB2,
  orientedRectOverlapsCapsule,
  orientedRectOverlapsCircle,
  type AABB2,
  type AABB3,
} from "../geometry/box"
import { convexPolygonsOverlap, pointInConvexPolygon } from "../geometry/polygon"
import {
  classifyEntry,
  createInterval,
  ENTRY_CONTAINS_START,
  ENTRY_MISS,
  lineAABB3,
  lineConvex,
  lineOrientedBox,
  lineVerticalCylinder,
} from "../geometry/ray"
import { clipSegmentToBox2Into, distancePointSegment2 } from "../geometry/segment"
import { EPS, yawCos, yawSin } from "../geometry/vec"
import type { Rect, Vec2, Vec3 } from "../scene/types"
import type { Heightfield, OccluderPrimitive, OrientedBox, VerticalCylinder, WallStrip } from "./types"

export { ENTRY_CONTAINS_START, ENTRY_MISS } from "../geometry/ray"

const scratch = createInterval()
const clipRange = createInterval()

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Lattice-cell count of a heightfield along X / Z. */
export const heightfieldCellsX = (hf: Heightfield): number => hf.samplesX - 1
export const heightfieldCellsZ = (hf: Heightfield): number => hf.samplesZ - 1

/** World-space AABB of a primitive (heightfields: over their solid cells). */
export function primitiveBounds(p: OccluderPrimitive): AABB3 {
  switch (p.shape) {
    case "box": {
      const b = orientedRectBounds({ x: p.center.x, z: p.center.z }, p.halfExtents.x, p.halfExtents.z, p.yaw)
      return {
        minX: b.minX,
        minY: p.center.y - p.halfExtents.y,
        minZ: b.minZ,
        maxX: b.maxX,
        maxY: p.center.y + p.halfExtents.y,
        maxZ: b.maxZ,
      }
    }
    case "cylinder":
      return {
        minX: p.base.x - p.radius,
        minY: p.base.y,
        minZ: p.base.z - p.radius,
        maxX: p.base.x + p.radius,
        maxY: p.base.y + p.height,
        maxZ: p.base.z + p.radius,
      }
    case "heightfield":
      return heightfieldBounds(p)
    case "strip": {
      const b = orientedRectBounds(p.center, p.halfExtents.x, p.halfExtents.z, p.yaw)
      return { minX: b.minX, minY: p.bottom, minZ: b.minZ, maxX: b.maxX, maxY: stripMaxY(p), maxZ: b.maxZ }
    }
  }
}

function heightfieldBounds(hf: Heightfield): AABB3 {
  const cx = heightfieldCellsX(hf)
  const cz = heightfieldCellsZ(hf)
  let minI = Infinity
  let minJ = Infinity
  let maxI = -Infinity
  let maxJ = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  const sx = hf.samplesX
  const heights = hf.heights
  for (let j = 0; j < cz; j++) {
    for (let i = 0; i < cx; i++) {
      if (!hf.solid[j * cx + i]) continue
      if (i < minI) minI = i
      if (i > maxI) maxI = i
      if (j < minJ) minJ = j
      if (j > maxJ) maxJ = j
      const k = j * sx + i
      const lo = Math.min(heights[k], heights[k + 1], heights[k + sx], heights[k + sx + 1])
      const hi = Math.max(heights[k], heights[k + 1], heights[k + sx], heights[k + sx + 1])
      if (lo < minY) minY = lo
      if (hi > maxY) maxY = hi
    }
  }
  if (minI === Infinity) {
    // No solid cell: an empty box at the origin (never intersected).
    return { minX: hf.originX, minY: 0, minZ: hf.originZ, maxX: hf.originX, maxY: -1, maxZ: hf.originZ }
  }
  const s = hf.spacing
  return {
    minX: hf.originX + minI * s,
    minY: minY - hf.thickness,
    minZ: hf.originZ + minJ * s,
    maxX: hf.originX + (maxI + 1) * s,
    maxY,
    maxZ: hf.originZ + (maxJ + 1) * s,
  }
}

// ---------------------------------------------------------------------------
// Heightfield surface
// ---------------------------------------------------------------------------

/** World Y of the heightfield's top surface over lattice cell (i, j) at local fractions (tx, tz). */
function cellSurface(hf: Heightfield, i: number, j: number, tx: number, tz: number): number {
  const sx = hf.samplesX
  const h00 = hf.heights[j * sx + i]
  const h11 = hf.heights[(j + 1) * sx + i + 1]
  if (tx >= tz) {
    const h10 = hf.heights[j * sx + i + 1]
    return h00 + tx * (h10 - h00) + tz * (h11 - h10)
  }
  const h01 = hf.heights[(j + 1) * sx + i]
  return h00 + tz * (h01 - h00) + tx * (h11 - h01)
}

/** Top-surface Y of the heightfield at (x, z), or null when (x, z) is not over a solid cell. */
export function heightfieldSurfaceAt(hf: Heightfield, x: number, z: number): number | null {
  const fx = (x - hf.originX) / hf.spacing
  const fz = (z - hf.originZ) / hf.spacing
  const i = Math.floor(fx)
  const j = Math.floor(fz)
  const cx = heightfieldCellsX(hf)
  if (i < 0 || j < 0 || i >= cx || j >= heightfieldCellsZ(hf) || !hf.solid[j * cx + i]) return null
  return cellSurface(hf, i, j, fx - i, fz - j)
}

function heightfieldContains(hf: Heightfield, x: number, y: number, z: number, eps: number): boolean {
  const s = hf.spacing
  const fx = (x - hf.originX) / s
  const fz = (z - hf.originZ) / s
  const i = Math.floor(fx)
  const j = Math.floor(fz)
  const cx = heightfieldCellsX(hf)
  const cz = heightfieldCellsZ(hf)
  const e = eps / s
  // Points within eps of a lattice line are tested against the cells on both sides.
  const i0 = fx - i < e ? i - 1 : i
  const i1 = i + 1 - fx < e ? i + 1 : i
  const j0 = fz - j < e ? j - 1 : j
  const j1 = j + 1 - fz < e ? j + 1 : j
  for (let jj = j0; jj <= j1; jj++) {
    if (jj < 0 || jj >= cz) continue
    for (let ii = i0; ii <= i1; ii++) {
      if (ii < 0 || ii >= cx || !hf.solid[jj * cx + ii]) continue
      const tx = Math.min(1, Math.max(0, fx - ii))
      const tz = Math.min(1, Math.max(0, fz - jj))
      const top = cellSurface(hf, ii, jj, tx, tz)
      if (y <= top + eps && y >= top - hf.thickness - eps) return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Wall strip profile
// ---------------------------------------------------------------------------

/** Index i of the knot interval [knots[i], knots[i+1]] containing local x (the end intervals outside the knots). */
export function stripInterval(knots: ArrayLike<number>, x: number): number {
  let lo = 0
  let hi = knots.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (knots[mid] <= x) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Top Y of a strip at local x (clamped to the strip). */
export function stripTopAt(st: WallStrip, lx: number): number {
  const k = st.knots
  const t = st.top
  const n = k.length
  if (!(lx > k[0])) return t[0]
  if (lx >= k[n - 1]) return t[n - 1]
  const i = stripInterval(k, lx)
  return t[i] + ((lx - k[i]) / (k[i + 1] - k[i])) * (t[i + 1] - t[i])
}

/** Highest top of a strip over local x ∈ [x0, x1] (clamped to the strip). */
export function stripMaxTop(st: WallStrip, x0: number, x1: number): number {
  if (x1 < x0) [x0, x1] = [x1, x0]
  let v = Math.max(stripTopAt(st, x0), stripTopAt(st, x1))
  const k = st.knots
  for (let i = stripInterval(k, x0) + 1; i < k.length && k[i] < x1; i++) {
    if (k[i] > x0 && st.top[i] > v) v = st.top[i]
  }
  return v
}

// Highest top per strip (primitives are immutable once built).
const maxYCache = new WeakMap<WallStrip, number>()

/** Highest top of a strip (memoised). */
function stripMaxY(st: WallStrip): number {
  let v = maxYCache.get(st)
  if (v === undefined) {
    v = -Infinity
    for (const t of st.top) if (t > v) v = t
    maxYCache.set(st, v)
  }
  return v
}

/** Local (along, across) coordinates of a world XZ point in a strip's frame. */
function stripLocal(st: WallStrip, x: number, z: number): { lx: number; lz: number } {
  const c = yawCos(st.yaw)
  const s = yawSin(st.yaw)
  const dx = x - st.center.x
  const dz = z - st.center.z
  return { lx: c * dx - s * dz, lz: s * dx + c * dz }
}

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

/** Closed containment of a point, widened by eps (default EPS, matching the segment tests). */
export function primitiveContains(p: OccluderPrimitive, q: Vec3, eps = EPS): boolean {
  switch (p.shape) {
    case "box": {
      const c = yawCos(p.yaw)
      const s = yawSin(p.yaw)
      const dx = q.x - p.center.x
      const dz = q.z - p.center.z
      return (
        Math.abs(c * dx - s * dz) <= p.halfExtents.x + eps &&
        Math.abs(q.y - p.center.y) <= p.halfExtents.y + eps &&
        Math.abs(s * dx + c * dz) <= p.halfExtents.z + eps
      )
    }
    case "cylinder": {
      const r = p.radius + eps
      return (
        (q.x - p.base.x) ** 2 + (q.z - p.base.z) ** 2 <= r * r &&
        q.y >= p.base.y - eps &&
        q.y <= p.base.y + p.height + eps
      )
    }
    case "heightfield":
      return heightfieldContains(p, q.x, q.y, q.z, eps)
    case "strip": {
      const { lx, lz } = stripLocal(p, q.x, q.z)
      if (Math.abs(lx) > p.halfExtents.x + eps || Math.abs(lz) > p.halfExtents.z + eps || q.y < p.bottom - eps) return false
      return q.y <= stripTopAt(p, lx) + eps
    }
  }
}

// ---------------------------------------------------------------------------
// Segment entry tests
// ---------------------------------------------------------------------------

/**
 * Entry classification of the segment o → o + d (length `len`) against a box given its yaw cos/sin.
 * Returns ENTRY_CONTAINS_START, ENTRY_MISS or the entry t ∈ (0, 1).
 */
export function boxEntry(
  b: OrientedBox,
  cos: number,
  sin: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  len: number
): number {
  const h = b.halfExtents
  if (!lineOrientedBox(ox, oy, oz, dx, dy, dz, b.center.x, b.center.y, b.center.z, h.x, h.y, h.z, cos, sin, scratch)) {
    return ENTRY_MISS
  }
  return classifyEntry(scratch.t0, scratch.t1, len)
}

export function cylinderEntry(
  c: VerticalCylinder,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  len: number
): number {
  if (!lineVerticalCylinder(ox, oy, oz, dx, dy, dz, c.base.x, c.base.y, c.base.z, c.radius, c.height, scratch)) {
    return ENTRY_MISS
  }
  return classifyEntry(scratch.t0, scratch.t1, len)
}

// Half-spaces of one triangular prism, [nx, ny, nz, w] × 5, in lattice-cell-local coordinates.
const prismPlanes = new Float64Array(20)

function setPlane(k: number, nx: number, ny: number, nz: number, w: number): void {
  prismPlanes[4 * k] = nx
  prismPlanes[4 * k + 1] = ny
  prismPlanes[4 * k + 2] = nz
  prismPlanes[4 * k + 3] = w
}

/**
 * Entry classification of a segment against a heightfield: the union of the triangular prisms
 * [surface − thickness, surface] over its solid lattice cells. The lattice cells along the segment's
 * XZ path are visited in order (2D DDA), each culled by its Y range before the exact prism tests.
 */
export function heightfieldEntry(
  hf: Heightfield,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  len: number
): number {
  if (!(len > 0)) return ENTRY_MISS
  if (heightfieldContains(hf, ox, oy, oz, EPS)) return ENTRY_CONTAINS_START
  const s = hf.spacing
  const cellsX = heightfieldCellsX(hf)
  const cellsZ = heightfieldCellsZ(hf)
  if (cellsX <= 0 || cellsZ <= 0) return ENTRY_MISS
  const x0 = hf.originX
  const z0 = hf.originZ
  if (!clipSegmentToBox2Into(ox, oz, ox + dx, oz + dz, x0, z0, x0 + cellsX * s, z0 + cellsZ * s, clipRange)) return ENTRY_MISS
  const ta = clipRange.t0
  const tb = clipRange.t1
  const th = hf.thickness
  const heights = hf.heights
  const sx = hf.samplesX
  const epsY = EPS

  // DDA over lattice cells.
  const startX = (ox + dx * ta - x0) / s
  const startZ = (oz + dz * ta - z0) / s
  let i = Math.min(cellsX - 1, Math.max(0, Math.floor(startX)))
  let j = Math.min(cellsZ - 1, Math.max(0, Math.floor(startZ)))
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0
  const tDeltaX = dx !== 0 ? s / Math.abs(dx) : Infinity
  const tDeltaZ = dz !== 0 ? s / Math.abs(dz) : Infinity
  let tMaxX = dx > 0 ? (x0 + (i + 1) * s - ox) / dx : dx < 0 ? (x0 + i * s - ox) / dx : Infinity
  let tMaxZ = dz > 0 ? (z0 + (j + 1) * s - oz) / dz : dz < 0 ? (z0 + j * s - oz) / dz : Infinity
  let tc0 = ta
  let best = ENTRY_MISS
  for (;;) {
    const tc1 = Math.min(tMaxX, tMaxZ, tb)
    if (hf.solid[j * cellsX + i]) {
      const k = j * sx + i
      const h00 = heights[k]
      const h10 = heights[k + 1]
      const h01 = heights[k + sx]
      const h11 = heights[k + sx + 1]
      const lo = Math.min(h00, h10, h01, h11) - th
      const hi = Math.max(h00, h10, h01, h11)
      const ya = oy + dy * tc0
      const yb = oy + dy * tc1
      if (Math.max(ya, yb) >= lo - epsY && Math.min(ya, yb) <= hi + epsY) {
        // Cell-local origin (the cell's min corner at X0, Z0).
        const lx = ox - (x0 + i * s)
        const lz = oz - (z0 + j * s)
        // Triangle A (tx ≥ tz): corners 00, 10, 11. Surface slope a along x, b along z.
        let a = (h10 - h00) / s
        let b = (h11 - h10) / s
        setPlane(0, 1, 0, 0, s)
        setPlane(1, 0, 0, -1, 0)
        setPlane(2, -1, 0, 1, 0)
        setPlane(3, -a, 1, -b, h00)
        setPlane(4, a, -1, b, th - h00)
        if (lineConvex(lx, oy, lz, dx, dy, dz, prismPlanes, 5, scratch)) {
          const r = classifyEntry(scratch.t0, scratch.t1, len)
          if (r === ENTRY_CONTAINS_START) return r
          if (r < best) best = r
        }
        // Triangle B (tz > tx): corners 00, 01, 11.
        a = (h11 - h01) / s
        b = (h01 - h00) / s
        setPlane(0, -1, 0, 0, 0)
        setPlane(1, 0, 0, 1, s)
        setPlane(2, 1, 0, -1, 0)
        setPlane(3, -a, 1, -b, h00)
        setPlane(4, a, -1, b, th - h00)
        if (lineConvex(lx, oy, lz, dx, dy, dz, prismPlanes, 5, scratch)) {
          const r = classifyEntry(scratch.t0, scratch.t1, len)
          if (r === ENTRY_CONTAINS_START) return r
          if (r < best) best = r
        }
        // Later cells cannot be entered before this cell's exit parameter.
        if (best <= tc1) return best
      }
    }
    if (tc1 >= tb) break
    if (tMaxX < tMaxZ) {
      i += stepX
      if (i < 0 || i >= cellsX) break
      tc0 = tMaxX
      tMaxX += tDeltaX
    } else {
      j += stepZ
      if (j < 0 || j >= cellsZ) break
      tc0 = tMaxZ
      tMaxZ += tDeltaZ
    }
  }
  return best
}

// Half-spaces of one strip interval, [nx, ny, nz, w] × 6, in the strip's local frame.
const stripPlanes = new Float64Array(24)

function setStripPlane(k: number, nx: number, ny: number, nz: number, w: number): void {
  stripPlanes[4 * k] = nx
  stripPlanes[4 * k + 1] = ny
  stripPlanes[4 * k + 2] = nz
  stripPlanes[4 * k + 3] = w
}

/**
 * Entry classification of a segment against a wall strip given its yaw cos/sin and highest top `maxY`:
 * the union of one convex solid per knot interval (x between the knots, |z| ≤ halfExtents.z, bottom ≤ y
 * ≤ the interval's top plane). The segment is clipped to the strip's local box, the knot intervals over
 * the clipped local-x range are found by binary search and visited in ray order, each culled by its Y
 * range before the exact test; the walk stops once the best entry precedes the interval's exit.
 * On a constant profile the result is the box's.
 */
export function stripEntry(
  st: WallStrip,
  cos: number,
  sin: number,
  maxY: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  len: number
): number {
  if (!(len > 0)) return ENTRY_MISS
  const px = ox - st.center.x
  const pz = oz - st.center.z
  const lox = cos * px - sin * pz
  const loz = sin * px + cos * pz
  const ldx = cos * dx - sin * dz
  const ldz = sin * dx + cos * dz
  const hx = st.halfExtents.x
  const hz = st.halfExtents.z
  const bottom = st.bottom
  if (!lineAABB3(lox, oy, loz, ldx, dy, ldz, -hx, bottom, -hz, hx, maxY, hz, scratch)) return ENTRY_MISS
  // Only solids met at t ∈ [−epsT, 1] can contain the start or be entered (see classifyEntry).
  const epsT = EPS / len
  const tA = Math.max(scratch.t0, -epsT)
  const tB = Math.min(scratch.t1, 1)
  if (tA > tB) return ENTRY_MISS
  const knots = st.knots
  const top = st.top
  // Local x range covered, widened so a point on a knot tests the intervals on both sides.
  const xa = lox + ldx * tA
  const xb = lox + ldx * tB
  const i0 = stripInterval(knots, Math.min(xa, xb) - EPS)
  const i1 = stripInterval(knots, Math.max(xa, xb) + EPS)
  const forward = ldx >= 0
  let best = ENTRY_MISS
  for (let m = 0; m <= i1 - i0; m++) {
    const i = forward ? i0 + m : i1 - m
    const k0 = knots[i]
    const k1 = knots[i + 1]
    // Parameter range of the segment over this interval, and its exit (in ray order).
    let tc0 = tA
    let tc1 = tB
    let exit = Infinity
    if (ldx !== 0) {
      const ta = (k0 - lox) / ldx
      const tb = (k1 - lox) / ldx
      const lo = ta < tb ? ta : tb
      exit = ta < tb ? tb : ta
      if (lo > tc0) tc0 = lo
      if (exit < tc1) tc1 = exit
    }
    const t0 = top[i]
    const t1 = top[i + 1]
    const ya = oy + dy * tc0
    const yb = oy + dy * tc1
    if (tc0 <= tc1 + epsT && Math.max(ya, yb) >= bottom - EPS && Math.min(ya, yb) <= Math.max(t0, t1) + EPS) {
      const slope = (t1 - t0) / (k1 - k0)
      setStripPlane(0, -1, 0, 0, -k0)
      setStripPlane(1, 1, 0, 0, k1)
      setStripPlane(2, 0, 0, -1, hz)
      setStripPlane(3, 0, 0, 1, hz)
      setStripPlane(4, 0, -1, 0, -bottom)
      setStripPlane(5, -slope, 1, 0, t0 - slope * k0)
      if (lineConvex(lox, oy, loz, ldx, dy, ldz, stripPlanes, 6, scratch)) {
        const r = classifyEntry(scratch.t0, scratch.t1, len)
        if (r === ENTRY_CONTAINS_START) return r
        if (r < best) best = r
      }
    }
    // Later intervals cannot be entered before this interval's exit.
    if (best !== ENTRY_MISS && best <= exit) return best
  }
  return best
}

/**
 * Entry parameter t ∈ (0, 1) where the segment from→to enters the primitive, or null (no entry, or
 * the primitive contains `from`). Same semantics as OcclusionWorld.raycast for a single primitive.
 */
export function segmentEntry(p: OccluderPrimitive, from: Vec3, to: Vec3): number | null {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const len = Math.hypot(dx, dy, dz)
  let r: number
  switch (p.shape) {
    case "box":
      r = boxEntry(p, yawCos(p.yaw), yawSin(p.yaw), from.x, from.y, from.z, dx, dy, dz, len)
      break
    case "cylinder":
      r = cylinderEntry(p, from.x, from.y, from.z, dx, dy, dz, len)
      break
    case "heightfield":
      r = heightfieldEntry(p, from.x, from.y, from.z, dx, dy, dz, len)
      break
    case "strip":
      r = stripEntry(p, yawCos(p.yaw), yawSin(p.yaw), stripMaxY(p), from.x, from.y, from.z, dx, dy, dz, len)
      break
  }
  return r > 0 && r < 1 ? r : null
}

// ---------------------------------------------------------------------------
// Footprints (XZ)
// ---------------------------------------------------------------------------

/** Iterate the solid lattice cells of a heightfield overlapping an XZ box; stop when fn returns true. */
function someSolidCell(hf: Heightfield, box: AABB2, fn: (cell: AABB2) => boolean): boolean {
  const s = hf.spacing
  const cx = heightfieldCellsX(hf)
  const cz = heightfieldCellsZ(hf)
  const i0 = Math.max(0, Math.floor((box.minX - hf.originX) / s))
  const j0 = Math.max(0, Math.floor((box.minZ - hf.originZ) / s))
  const i1 = Math.min(cx - 1, Math.floor((box.maxX - hf.originX) / s))
  const j1 = Math.min(cz - 1, Math.floor((box.maxZ - hf.originZ) / s))
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (!hf.solid[j * cx + i]) continue
      const x = hf.originX + i * s
      const z = hf.originZ + j * s
      if (fn({ minX: x, minZ: z, maxX: x + s, maxZ: z + s })) return true
    }
  }
  return false
}

/** Strict (positive-area) overlap of a primitive's XZ footprint with a rect. */
export function footprintOverlapsRect(p: OccluderPrimitive, r: Rect): boolean {
  const box: AABB2 = { minX: r.x, minZ: r.z, maxX: r.x + r.w, maxZ: r.z + r.d }
  switch (p.shape) {
    case "box":
      return orientedRectOverlapsAABB2({ x: p.center.x, z: p.center.z }, p.halfExtents.x, p.halfExtents.z, p.yaw, box)
    case "cylinder":
      return circleOverlapsAABB2({ x: p.base.x, z: p.base.z }, p.radius, box)
    case "heightfield":
      return someSolidCell(p, box, (c) => c.minX < box.maxX && box.minX < c.maxX && c.minZ < box.maxZ && box.minZ < c.maxZ)
    case "strip":
      return orientedRectOverlapsAABB2(p.center, p.halfExtents.x, p.halfExtents.z, p.yaw, box)
  }
}

/** Strict overlap of a primitive's XZ footprint with a circle. */
export function footprintOverlapsCircle(p: OccluderPrimitive, center: Vec2, radius: number): boolean {
  switch (p.shape) {
    case "box":
      return orientedRectOverlapsCircle({ x: p.center.x, z: p.center.z }, p.halfExtents.x, p.halfExtents.z, p.yaw, center, radius)
    case "cylinder": {
      const r = p.radius + radius
      return (p.base.x - center.x) ** 2 + (p.base.z - center.z) ** 2 < r * r
    }
    case "heightfield":
      return someSolidCell(
        p,
        { minX: center.x - radius, minZ: center.z - radius, maxX: center.x + radius, maxZ: center.z + radius },
        (c) => circleOverlapsAABB2(center, radius, c)
      )
    case "strip":
      return orientedRectOverlapsCircle(p.center, p.halfExtents.x, p.halfExtents.z, p.yaw, center, radius)
  }
}

/** Strict overlap of a primitive's XZ footprint with a capsule: a disc of `radius` swept from a to b. */
export function footprintOverlapsCapsule(p: OccluderPrimitive, a: Vec2, b: Vec2, radius: number): boolean {
  switch (p.shape) {
    case "box":
      return orientedRectOverlapsCapsule({ x: p.center.x, z: p.center.z }, p.halfExtents.x, p.halfExtents.z, p.yaw, a, b, radius)
    case "cylinder": {
      const c = { x: p.base.x, z: p.base.z }
      return distancePointSegment2(c, a, b) < p.radius + radius
    }
    case "heightfield":
      return someSolidCell(
        p,
        {
          minX: Math.min(a.x, b.x) - radius,
          minZ: Math.min(a.z, b.z) - radius,
          maxX: Math.max(a.x, b.x) + radius,
          maxZ: Math.max(a.z, b.z) + radius,
        },
        (c) => capsuleOverlapsAABB2(a, b, radius, c)
      )
    case "strip":
      return orientedRectOverlapsCapsule(p.center, p.halfExtents.x, p.halfExtents.z, p.yaw, a, b, radius)
  }
}

/** Strict overlap of a primitive's XZ footprint with a convex polygon (e.g. a swept token footprint). */
export function footprintOverlapsPolygon(p: OccluderPrimitive, poly: readonly Vec2[]): boolean {
  switch (p.shape) {
    case "box":
      return convexPolygonsOverlap(
        orientedRectCorners({ x: p.center.x, z: p.center.z }, p.halfExtents.x, p.halfExtents.z, p.yaw),
        poly
      )
    case "cylinder": {
      const c = { x: p.base.x, z: p.base.z }
      if (pointInConvexPolygon(c, poly)) return true
      for (let k = 0; k < poly.length; k++) {
        if (distancePointSegment2(c, poly[k], poly[(k + 1) % poly.length]) < p.radius) return true
      }
      return false
    }
    case "heightfield": {
      let minX = Infinity
      let minZ = Infinity
      let maxX = -Infinity
      let maxZ = -Infinity
      for (const q of poly) {
        minX = Math.min(minX, q.x)
        minZ = Math.min(minZ, q.z)
        maxX = Math.max(maxX, q.x)
        maxZ = Math.max(maxZ, q.z)
      }
      return someSolidCell(p, { minX, minZ, maxX, maxZ }, (c) =>
        convexPolygonsOverlap(
          [
            { x: c.minX, z: c.minZ },
            { x: c.maxX, z: c.minZ },
            { x: c.maxX, z: c.maxZ },
            { x: c.minX, z: c.maxZ },
          ],
          poly
        )
      )
    }
    case "strip":
      return convexPolygonsOverlap(orientedRectCorners(p.center, p.halfExtents.x, p.halfExtents.z, p.yaw), poly)
  }
}

/** Convex XZ outline of a box, strip or cylinder footprint (cylinders: circumscribed 16-gon); null for heightfields. */
export function footprintPolygon(p: OccluderPrimitive): Vec2[] | null {
  switch (p.shape) {
    case "box":
      return orientedRectCorners({ x: p.center.x, z: p.center.z }, p.halfExtents.x, p.halfExtents.z, p.yaw)
    case "cylinder": {
      const n = 16
      const r = p.radius / Math.cos(Math.PI / n)
      const out: Vec2[] = []
      for (let k = 0; k < n; k++) {
        const a = ((k + 0.5) * 2 * Math.PI) / n
        out.push({ x: p.base.x + r * Math.cos(a), z: p.base.z + r * Math.sin(a) })
      }
      return out
    }
    case "heightfield":
      return null
    case "strip":
      return orientedRectCorners(p.center, p.halfExtents.x, p.halfExtents.z, p.yaw)
  }
}

// ---------------------------------------------------------------------------
// Tops and push-out
// ---------------------------------------------------------------------------

/** Top Y of the primitive above (x, z), or null when (x, z) is outside its footprint. */
export function primitiveTopAt(p: OccluderPrimitive, x: number, z: number): number | null {
  switch (p.shape) {
    case "box": {
      const c = yawCos(p.yaw)
      const s = yawSin(p.yaw)
      const dx = x - p.center.x
      const dz = z - p.center.z
      if (Math.abs(c * dx - s * dz) > p.halfExtents.x + EPS || Math.abs(s * dx + c * dz) > p.halfExtents.z + EPS) return null
      return p.center.y + p.halfExtents.y
    }
    case "cylinder":
      return (x - p.base.x) ** 2 + (z - p.base.z) ** 2 <= (p.radius + EPS) ** 2 ? p.base.y + p.height : null
    case "heightfield":
      return heightfieldSurfaceAt(p, x, z)
    case "strip": {
      const { lx, lz } = stripLocal(p, x, z)
      if (Math.abs(lx) > p.halfExtents.x + EPS || Math.abs(lz) > p.halfExtents.z + EPS) return null
      return stripTopAt(p, lx)
    }
  }
}

/**
 * Move a point contained in the primitive to `margin` feet past its nearest face (the rule used for
 * eyes and light origins, docs/ARCHITECTURE.md §2). Heightfields push vertically only; strips push through
 * their nearest side, up to their top line above the point or down below their bottom.
 * "Contained" uses the default EPS, like OcclusionWorld.containing and the segment ENTRY rule: a
 * point on (or within EPS outside) a face would make segments from it ignore the primitive, so it
 * is pushed too. Points outside the primitive are returned unchanged (copied).
 */
export function pushOutOfPrimitive(p: OccluderPrimitive, q: Vec3, margin: number): Vec3 {
  if (!primitiveContains(p, q)) return { x: q.x, y: q.y, z: q.z }
  switch (p.shape) {
    case "box": {
      const c = yawCos(p.yaw)
      const s = yawSin(p.yaw)
      const dx = q.x - p.center.x
      const dz = q.z - p.center.z
      let lx = c * dx - s * dz
      let ly = q.y - p.center.y
      let lz = s * dx + c * dz
      const h = p.halfExtents
      const exits = [h.x - lx, h.x + lx, h.y - ly, h.y + ly, h.z - lz, h.z + lz]
      let k = 0
      for (let m = 1; m < 6; m++) if (exits[m] < exits[k]) k = m
      if (k === 0) lx = h.x + margin
      else if (k === 1) lx = -h.x - margin
      else if (k === 2) ly = h.y + margin
      else if (k === 3) ly = -h.y - margin
      else if (k === 4) lz = h.z + margin
      else lz = -h.z - margin
      return { x: p.center.x + c * lx + s * lz, y: p.center.y + ly, z: p.center.z - s * lx + c * lz }
    }
    case "cylinder": {
      const ex = q.x - p.base.x
      const ez = q.z - p.base.z
      const rho = Math.hypot(ex, ez)
      const side = p.radius - rho
      const up = p.base.y + p.height - q.y
      const down = q.y - p.base.y
      if (side <= up && side <= down) {
        const ux = rho > 0 ? ex / rho : 1
        const uz = rho > 0 ? ez / rho : 0
        return { x: p.base.x + ux * (p.radius + margin), y: q.y, z: p.base.z + uz * (p.radius + margin) }
      }
      if (up <= down) return { x: q.x, y: p.base.y + p.height + margin, z: q.z }
      return { x: q.x, y: p.base.y - margin, z: q.z }
    }
    case "heightfield": {
      const top = heightfieldSurfaceAt(p, q.x, q.z)
      if (top === null) return { x: q.x, y: q.y, z: q.z }
      const bottom = top - p.thickness
      return top - q.y <= q.y - bottom ? { x: q.x, y: top + margin, z: q.z } : { x: q.x, y: bottom - margin, z: q.z }
    }
    case "strip": {
      const c = yawCos(p.yaw)
      const s = yawSin(p.yaw)
      const dx = q.x - p.center.x
      const dz = q.z - p.center.z
      let lx = c * dx - s * dz
      let lz = s * dx + c * dz
      let y = q.y
      const h = p.halfExtents
      const top = stripTopAt(p, lx)
      const exits = [h.x - lx, h.x + lx, top - y, y - p.bottom, h.z - lz, h.z + lz]
      let k = 0
      for (let m = 1; m < 6; m++) if (exits[m] < exits[k]) k = m
      if (k === 0) lx = h.x + margin
      else if (k === 1) lx = -h.x - margin
      else if (k === 2) y = top + margin
      else if (k === 3) y = p.bottom - margin
      else if (k === 4) lz = h.z + margin
      else lz = -h.z - margin
      return { x: p.center.x + c * lx + s * lz, y, z: p.center.z - s * lx + c * lz }
    }
  }
}
