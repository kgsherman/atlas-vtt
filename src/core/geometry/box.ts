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

export function emptyAABB3(): AABB3 {
  return { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity }
}

export function isEmptyAABB3(b: AABB3): boolean {
  return b.minX > b.maxX || b.minY > b.maxY || b.minZ > b.maxZ
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

/** Closed overlap test, inflated by eps (eps may be negative to require a positive-volume overlap). */
export function aabb3Overlaps(a: AABB3, b: AABB3, eps = 0): boolean {
  return (
    a.minX <= b.maxX + eps &&
    b.minX <= a.maxX + eps &&
    a.minY <= b.maxY + eps &&
    b.minY <= a.maxY + eps &&
    a.minZ <= b.maxZ + eps &&
    b.minZ <= a.maxZ + eps
  )
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

export function rectToAABB2(r: Rect): AABB2 {
  return { minX: r.x, minZ: r.z, maxX: r.x + r.w, maxZ: r.z + r.d }
}

export function aabb2ToRect(b: AABB2): Rect {
  return { x: b.minX, z: b.minZ, w: b.maxX - b.minX, d: b.maxZ - b.minZ }
}

/** Strict overlap (positive area) of two ground-plane boxes. */
export function aabb2Overlaps(a: AABB2, b: AABB2): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ
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
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return { x: c * lx + s * lz, z: -s * lx + c * lz }
}

/** World offset → local (lx, lz), inverse of rotateLocalXZ. */
export function unrotateXZ(wx: number, wz: number, yaw: number): Vec2 {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return { x: c * wx - s * wz, z: s * wx + c * wz }
}

/** Corners (counter-clockwise in local space) of an oriented rectangle. */
export function orientedRectCorners(center: Vec2, halfX: number, halfZ: number, yaw: number): Vec2[] {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
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
  const c = Math.abs(Math.cos(yaw))
  const s = Math.abs(Math.sin(yaw))
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
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
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
