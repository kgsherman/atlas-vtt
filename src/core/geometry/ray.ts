/**
 * Line / segment intersection against closed convex solids.
 *
 * Every `line*` function intersects the infinite line p(t) = o + t·d with a CLOSED solid and writes
 * the parameter interval [t0, t1] where the line is inside it (t0 may be −∞ / t1 +∞ when the line is
 * parallel to a pair of faces and between them). They take scalar arguments and write into a
 * caller-provided interval so the occlusion hot loops allocate nothing.
 *
 * `classifyEntry` then applies the ENTRY semantics shared by the CPU and GPU occlusion
 * (docs/ARCHITECTURE.md §2): a solid containing the segment start is ignored, and a solid blocks
 * only where the segment enters it at t ∈ (0, 1).
 */
import { EPS } from "./vec"

export interface LineInterval {
  t0: number
  t1: number
}

export const createInterval = (): LineInterval => ({ t0: 0, t1: 0 })

/** classifyEntry result: the solid contains the segment start (within tolerance) → ignored. */
export const ENTRY_CONTAINS_START = -1
/** classifyEntry result: the segment does not enter the solid. */
export const ENTRY_MISS = Infinity

/**
 * Classify a solid's line interval [t0, t1] for the segment t ∈ [0, 1] of length `length`.
 * Returns ENTRY_CONTAINS_START, ENTRY_MISS, or the entry parameter t ∈ (0, 1).
 * Tolerances are EPS feet: a start within EPS of the solid counts as inside it, and the segment must
 * penetrate by more than EPS (grazing contacts and zero-length touches do not block).
 */
export function classifyEntry(t0: number, t1: number, length: number): number {
  if (!(length > 0)) return ENTRY_MISS
  const epsT = EPS / length
  if (t0 <= epsT && t1 >= -epsT) return ENTRY_CONTAINS_START
  if (t1 < -epsT || t0 >= 1) return ENTRY_MISS
  if (Math.min(t1, 1) - t0 <= epsT) return ENTRY_MISS
  return t0
}

/** Line vs closed axis-aligned box. */
export function lineAABB3(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
  out: LineInterval
): boolean {
  let t0 = -Infinity
  let t1 = Infinity
  if (dx !== 0) {
    let a = (minX - ox) / dx
    let b = (maxX - ox) / dx
    if (a > b) {
      const tmp = a
      a = b
      b = tmp
    }
    if (a > t0) t0 = a
    if (b < t1) t1 = b
  } else if (ox < minX || ox > maxX) return false
  if (dy !== 0) {
    let a = (minY - oy) / dy
    let b = (maxY - oy) / dy
    if (a > b) {
      const tmp = a
      a = b
      b = tmp
    }
    if (a > t0) t0 = a
    if (b < t1) t1 = b
  } else if (oy < minY || oy > maxY) return false
  if (dz !== 0) {
    let a = (minZ - oz) / dz
    let b = (maxZ - oz) / dz
    if (a > b) {
      const tmp = a
      a = b
      b = tmp
    }
    if (a > t0) t0 = a
    if (b < t1) t1 = b
  } else if (oz < minZ || oz > maxZ) return false
  if (t0 > t1) return false
  out.t0 = t0
  out.t1 = t1
  return true
}

/**
 * Line vs closed box rotated about +Y (see ./box for the yaw convention), given cos/sin of the yaw.
 * Slab test in the box's local frame.
 */
export function lineOrientedBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  hx: number,
  hy: number,
  hz: number,
  cos: number,
  sin: number,
  out: LineInterval
): boolean {
  const px = ox - cx
  const pz = oz - cz
  return lineAABB3(
    cos * px - sin * pz,
    oy - cy,
    sin * px + cos * pz,
    cos * dx - sin * dz,
    dy,
    sin * dx + cos * dz,
    -hx,
    -hy,
    -hz,
    hx,
    hy,
    hz,
    out
  )
}

/** Line vs closed upright cylinder (base centre bx, by, bz; side + caps). */
export function lineVerticalCylinder(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  bx: number,
  by: number,
  bz: number,
  radius: number,
  height: number,
  out: LineInterval
): boolean {
  let t0 = -Infinity
  let t1 = Infinity
  // Caps: the slab by ≤ y ≤ by + height.
  if (dy !== 0) {
    let a = (by - oy) / dy
    let b = (by + height - oy) / dy
    if (a > b) {
      const tmp = a
      a = b
      b = tmp
    }
    t0 = a
    t1 = b
  } else if (oy < by || oy > by + height) return false
  // Side: |(o + t·d − base).xz|² ≤ r².
  const ex = ox - bx
  const ez = oz - bz
  const a = dx * dx + dz * dz
  const c = ex * ex + ez * ez - radius * radius
  if (a < 1e-24) {
    if (c > 0) return false
  } else {
    const halfB = ex * dx + ez * dz
    const disc = halfB * halfB - a * c
    if (disc < 0) return false
    const sq = Math.sqrt(disc)
    const r0 = (-halfB - sq) / a
    const r1 = (-halfB + sq) / a
    if (r0 > t0) t0 = r0
    if (r1 < t1) t1 = r1
  }
  if (t0 > t1) return false
  out.t0 = t0
  out.t1 = t1
  return true
}

/**
 * Line vs closed convex polyhedron given as half-spaces n·p ≤ w, packed as
 * [nx, ny, nz, w] × count (Cyrus–Beck clipping).
 */
export function lineConvex(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  planes: ArrayLike<number>,
  count: number,
  out: LineInterval
): boolean {
  let t0 = -Infinity
  let t1 = Infinity
  for (let k = 0; k < count; k++) {
    const nx = planes[4 * k]
    const ny = planes[4 * k + 1]
    const nz = planes[4 * k + 2]
    const num = planes[4 * k + 3] - (nx * ox + ny * oy + nz * oz)
    const den = nx * dx + ny * dy + nz * dz
    if (den === 0) {
      if (num < 0) return false
      continue
    }
    const t = num / den
    if (den > 0) {
      if (t < t1) t1 = t
    } else if (t > t0) t0 = t
    if (t0 > t1) return false
  }
  out.t0 = t0
  out.t1 = t1
  return true
}
