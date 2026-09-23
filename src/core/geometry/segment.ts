/**
 * Segment math on the ground plane (XZ).
 */
import type { Vec2 } from "../scene/types"

/** Parameter t ∈ [0, 1] of the point on segment a→b closest to p. */
export function closestParamOnSegment2(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len2 = dx * dx + dz * dz
  if (len2 === 0) return 0
  const t = ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2
  return t < 0 ? 0 : t > 1 ? 1 : t
}

export function closestPointOnSegment2(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const t = closestParamOnSegment2(p, a, b)
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }
}

export function distancePointSegment2(p: Vec2, a: Vec2, b: Vec2): number {
  const q = closestPointOnSegment2(p, a, b)
  return Math.hypot(p.x - q.x, p.z - q.z)
}

/**
 * Proper or touching intersection of segments a→b and c→d. Returns the parameters along each
 * segment, or null when they do not meet (parallel/collinear segments return null).
 */
export function segmentIntersection2(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { t: number; u: number } | null {
  const rx = b.x - a.x
  const rz = b.z - a.z
  const sx = d.x - c.x
  const sz = d.z - c.z
  const denom = rx * sz - rz * sx
  if (Math.abs(denom) < 1e-15) return null
  const qx = c.x - a.x
  const qz = c.z - a.z
  const t = (qx * sz - qz * sx) / denom
  const u = (qx * rz - qz * rx) / denom
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return { t, u }
}

/** Parameter range written by clipSegmentToBox2Into. */
export interface ParamRange {
  t0: number
  t1: number
}

/**
 * Liang–Barsky clip of the segment from→to (parameters [0, 1]) against the closed box
 * [minX, maxX] × [minZ, maxZ], without allocating: writes the clipped range into `out` and returns
 * false when the segment misses the box.
 */
export function clipSegmentToBox2Into(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  out: ParamRange
): boolean {
  const dx = toX - fromX
  const dz = toZ - fromZ
  let t0 = 0
  let t1 = 1
  // Each boundary is p·t ≤ q.
  for (let k = 0; k < 4; k++) {
    const p = k === 0 ? -dx : k === 1 ? dx : k === 2 ? -dz : dz
    const q = k === 0 ? fromX - minX : k === 1 ? maxX - fromX : k === 2 ? fromZ - minZ : maxZ - fromZ
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const r = q / p
    if (p < 0) {
      if (r > t1) return false
      if (r > t0) t0 = r
    } else {
      if (r < t0) return false
      if (r < t1) t1 = r
    }
  }
  if (t0 > t1) return false
  out.t0 = t0
  out.t1 = t1
  return true
}

/** Allocating convenience wrapper of clipSegmentToBox2Into: the clipped [t0, t1] or null. */
export function clipSegmentToBox2(
  fromX: number,
  fromZ: number,
  toX: number,
  toZ: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number
): [number, number] | null {
  const out = { t0: 0, t1: 1 }
  return clipSegmentToBox2Into(fromX, fromZ, toX, toZ, minX, minZ, maxX, maxZ, out) ? [out.t0, out.t1] : null
}
