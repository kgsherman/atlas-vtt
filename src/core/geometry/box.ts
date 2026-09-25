import { yawCos, yawSin } from "./vec"
/**
 * Axis-aligned boxes (2D on the ground plane and 3D) and oriented rectangles on XZ.
 *
 * Yaw convention (shared with three.js `Object3D.rotation.y` / `Matrix4.makeRotationY`):
 * a local point (lx, lz) maps to world (c·lx + s·lz, −s·lx + c·lz) with c = cos(yaw), s = sin(yaw).
 * The local +X axis is therefore (c, −s) in world XZ and the local +Z axis is (s, c).
 */
import type { Rect, Vec2, Vec3 } from "../scene/types"

export interface AABB2 {
  minX: number
  minZ: number
  maxX: number
  maxZ: number
}

export interface AABB3 {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

export function aabb3Union(a: AABB3, b: AABB3): AABB3 {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
    maxZ: Math.max(a.maxZ, b.maxZ),
  }
}

export function aabb3ContainsPoint(b: AABB3, p: Vec3, eps = 0): boolean {
  return (
    p.x >= b.minX - eps &&
    p.x <= b.maxX + eps &&
    p.y >= b.minY - eps &&
    p.y <= b.maxY + eps &&
    p.z >= b.minZ - eps &&
    p.z <= b.maxZ + eps
  )
}

/** Expand a rect by `m` feet on every side. */
export function inflateRect(r: Rect, m: number): Rect {
  return { x: r.x - m, z: r.z - m, w: r.w + 2 * m, d: r.d + 2 * m }
}

// ---------------------------------------------------------------------------
// Yaw frames and oriented rectangles on XZ
// ---------------------------------------------------------------------------

/** Yaw that maps local +X onto the world direction (dx, dz). */
export function yawFromDirection(dx: number, dz: number): number {
  return Math.atan2(-dz, dx)
}

/** Local (lx, lz) → world offset, for a frame rotated by yaw. */
export function rotateLocalXZ(lx: number, lz: number, yaw: number): Vec2 {
  const c = yawCos(yaw)
  const s = yawSin(yaw)
  return { x: c * lx + s * lz, z: -s * lx + c * lz }
}

/** World offset → local (lx, lz), inverse of rotateLocalXZ. */
export function unrotateXZ(wx: number, wz: number, yaw: number): Vec2 {
  const c = yawCos(yaw)
  const s = yawSin(yaw)
  return { x: c * wx - s * wz, z: s * wx + c * wz }
}

/** Corners (counter-clockwise in local space) of an oriented rectangle. */
export function orientedRectCorners(center: Vec2, halfX: number, halfZ: number, yaw: number): Vec2[] {
  const c = yawCos(yaw)
  const s = yawSin(yaw)
  const out: Vec2[] = []
  for (const [lx, lz] of [
    [-halfX, -halfZ],
    [halfX, -halfZ],
    [halfX, halfZ],
    [-halfX, halfZ],
  ]) {
    out.push({ x: center.x + c * lx + s * lz, z: center.z - s * lx + c * lz })
  }
  return out
}

/** World-space AABB of an oriented rectangle. */
export function orientedRectBounds(center: Vec2, halfX: number, halfZ: number, yaw: number): AABB2 {
  const c = Math.abs(yawCos(yaw))
  const s = Math.abs(yawSin(yaw))
  const ex = c * halfX + s * halfZ
  const ez = s * halfX + c * halfZ
  return { minX: center.x - ex, minZ: center.z - ez, maxX: center.x + ex, maxZ: center.z + ez }
}

/**
 * Oriented rectangle vs axis-aligned box on XZ by separating axes. `eps` > 0 requires the shapes to
 * overlap by more than eps along every axis (strict overlap); eps < 0 also accepts near-touching shapes.
 */
export function orientedRectOverlapsAABB2(
  center: Vec2,
  halfX: number,
  halfZ: number,
  yaw: number,
  box: AABB2,
  eps = 0
): boolean {
  const c = yawCos(yaw)
  const s = yawSin(yaw)
  const ac = Math.abs(c)
  const as = Math.abs(s)
  const bx = (box.maxX - box.minX) / 2
  const bz = (box.maxZ - box.minZ) / 2
  const dx = (box.minX + box.maxX) / 2 - center.x
  const dz = (box.minZ + box.maxZ) / 2 - center.z
  // World axes.
  if (Math.abs(dx) >= ac * halfX + as * halfZ + bx - eps) return false
  if (Math.abs(dz) >= as * halfX + ac * halfZ + bz - eps) return false
  // Local axes of the oriented rect: ux = (c, −s), uz = (s, c).
  if (Math.abs(dx * c - dz * s) >= halfX + ac * bx + as * bz - eps) return false
  if (Math.abs(dx * s + dz * c) >= halfZ + as * bx + ac * bz - eps) return false
  return true
}

/** Oriented rectangle vs circle on XZ (strict overlap: distance < r). */
export function orientedRectOverlapsCircle(center: Vec2, halfX: number, halfZ: number, yaw: number, p: Vec2, r: number): boolean {
  const l = unrotateXZ(p.x - center.x, p.z - center.z, yaw)
  const qx = Math.max(-halfX, Math.min(halfX, l.x))
  const qz = Math.max(-halfZ, Math.min(halfZ, l.z))
  return (l.x - qx) ** 2 + (l.z - qz) ** 2 < r * r
}

/** Circle vs axis-aligned box on XZ (strict overlap). */
export function circleOverlapsAABB2(p: Vec2, r: number, box: AABB2): boolean {
  const qx = Math.max(box.minX, Math.min(box.maxX, p.x))
  const qz = Math.max(box.minZ, Math.min(box.maxZ, p.z))
  return (p.x - qx) ** 2 + (p.z - qz) ** 2 < r * r
}

/** Squared distance from point p to an axis-aligned box on XZ (0 inside). */
function pointAABB2Distance2(p: Vec2, box: AABB2): number {
  const dx = p.x < box.minX ? box.minX - p.x : p.x > box.maxX ? p.x - box.maxX : 0
  const dz = p.z < box.minZ ? box.minZ - p.z : p.z > box.maxZ ? p.z - box.maxZ : 0
  return dx * dx + dz * dz
}

/** Squared distance between segment a→b and an axis-aligned box on XZ (0 when they meet). */
export function segmentAABB2Distance2(a: Vec2, b: Vec2, box: AABB2): number {
  // Clip the segment against the box (Liang–Barsky): any surviving part means they meet.
  const dx = b.x - a.x
  const dz = b.z - a.z
  let t0 = 0
  let t1 = 1
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q >= 0
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
    return true
  }
  if (clip(-dx, a.x - box.minX) && clip(dx, box.maxX - a.x) && clip(-dz, a.z - box.minZ) && clip(dz, box.maxZ - a.z) && t0 <= t1) return 0
  // Disjoint convex shapes: the closest pair involves an endpoint of the segment or a corner of the box.
  let best = Math.min(pointAABB2Distance2(a, box), pointAABB2Distance2(b, box))
  const len2 = dx * dx + dz * dz
  for (const cx of [box.minX, box.maxX]) {
    for (const cz of [box.minZ, box.maxZ]) {
      let t = len2 > 0 ? ((cx - a.x) * dx + (cz - a.z) * dz) / len2 : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const ex = a.x + dx * t - cx
      const ez = a.z + dz * t - cz
      best = Math.min(best, ex * ex + ez * ez)
    }
  }
  return best
}

/** Oriented rectangle vs capsule (a disc of radius r swept from a to b) on XZ (strict overlap: distance < r). */
export function orientedRectOverlapsCapsule(center: Vec2, halfX: number, halfZ: number, yaw: number, a: Vec2, b: Vec2, r: number): boolean {
  const la = unrotateXZ(a.x - center.x, a.z - center.z, yaw)
  const lb = unrotateXZ(b.x - center.x, b.z - center.z, yaw)
  return segmentAABB2Distance2(la, lb, { minX: -halfX, minZ: -halfZ, maxX: halfX, maxZ: halfZ }) < r * r
}

/** Axis-aligned box vs capsule on XZ (strict overlap). */
export function capsuleOverlapsAABB2(a: Vec2, b: Vec2, r: number, box: AABB2): boolean {
  return segmentAABB2Distance2(a, b, box) < r * r
}
