/**
 * Ground-plane polygons (arrays of XZ points). Used for footprints (walls, props, swept tokens)
 * and for clipping shapes to rects.
 */
import type { Rect, Vec2 } from "../scene/types"

/** Signed area (> 0 when the vertices run counter-clockwise in (x, z)). */
export function polygonSignedArea(poly: readonly Vec2[]): number {
  let s = 0
  for (let k = 0, n = poly.length; k < n; k++) {
    const a = poly[k]
    const b = poly[(k + 1) % n]
    s += a.x * b.z - b.x * a.z
  }
  return s / 2
}

export function polygonArea(poly: readonly Vec2[]): number {
  return Math.abs(polygonSignedArea(poly))
}

/** Closed point-in-polygon test for a convex polygon of either winding (eps widens it). */
export function pointInConvexPolygon(p: Vec2, poly: readonly Vec2[], eps = 0): boolean {
  const n = poly.length
  if (n < 3) return false
  const sign = polygonSignedArea(poly) >= 0 ? 1 : -1
  for (let k = 0; k < n; k++) {
    const a = poly[k]
    const b = poly[(k + 1) % n]
    const ex = b.x - a.x
    const ez = b.z - a.z
    const len = Math.hypot(ex, ez)
    if (len === 0) continue
    // Signed distance of p to the edge line, positive on the inside.
    const d = (sign * (ex * (p.z - a.z) - ez * (p.x - a.x))) / len
    if (d < -eps) return false
  }
  return true
}

/** Even-odd point-in-polygon test for any simple polygon. */
export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false
  for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) {
    const a = poly[k]
    const b = poly[j]
    if (a.z > p.z !== b.z > p.z && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) inside = !inside
  }
  return inside
}

function projectRange(poly: readonly Vec2[], ax: number, az: number): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (const p of poly) {
    const v = p.x * ax + p.z * az
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return [lo, hi]
}

/**
 * Separating-axis test for two convex polygons. Strict: shapes that only touch do not overlap;
 * `eps` > 0 additionally requires more than eps of penetration along every axis.
 */
export function convexPolygonsOverlap(a: readonly Vec2[], b: readonly Vec2[], eps = 0): boolean {
  for (const poly of [a, b]) {
    for (let k = 0, n = poly.length; k < n; k++) {
      const p = poly[k]
      const q = poly[(k + 1) % n]
      const ex = q.x - p.x
      const ez = q.z - p.z
      const len = Math.hypot(ex, ez)
      if (len === 0) continue
      const ax = -ez / len
      const az = ex / len
      const [a0, a1] = projectRange(a, ax, az)
      const [b0, b1] = projectRange(b, ax, az)
      if (a1 <= b0 + eps || b1 <= a0 + eps) return false
    }
  }
  return true
}

/**
 * Sutherland–Hodgman clip of a polygon against the half-plane n·p ≤ w (n = (nx, nz)).
 * Works for any simple polygon; the result is convex when the input is.
 */
export function clipPolygonHalfPlane(poly: readonly Vec2[], nx: number, nz: number, w: number): Vec2[] {
  const out: Vec2[] = []
  const n = poly.length
  for (let k = 0; k < n; k++) {
    const a = poly[k]
    const b = poly[(k + 1) % n]
    const da = nx * a.x + nz * a.z - w
    const db = nx * b.x + nz * b.z - w
    if (da <= 0) out.push(a)
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db)
      out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })
    }
  }
  return out
}

/** Clip a polygon to an axis-aligned rect. */
export function clipPolygonToRect(poly: readonly Vec2[], r: Rect): Vec2[] {
  let out = clipPolygonHalfPlane(poly, -1, 0, -r.x)
  out = clipPolygonHalfPlane(out, 1, 0, r.x + r.w)
  out = clipPolygonHalfPlane(out, 0, -1, -r.z)
  return clipPolygonHalfPlane(out, 0, 1, r.z + r.d)
}

export function rectPolygon(r: Rect): Vec2[] {
  return [
    { x: r.x, z: r.z },
    { x: r.x + r.w, z: r.z },
    { x: r.x + r.w, z: r.z + r.d },
    { x: r.x, z: r.z + r.d },
  ]
}

/** Convex hull (Andrew's monotone chain), counter-clockwise in (x, z), collinear points dropped. */
export function convexHull(points: readonly Vec2[]): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.z - b.z)
  if (pts.length < 3) return pts
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x)
  const lower: Vec2[] = []
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Vec2[] = []
  for (let k = pts.length - 1; k >= 0; k--) {
    const p = pts[k]
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop()
    upper.push(p)
  }
  lower.pop()
  upper.pop()
  return lower.concat(upper)
}
