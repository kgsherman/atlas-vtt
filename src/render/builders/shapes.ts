/**
 * Solid primitives written into a MeshWriter: hexahedra (boxes, oriented boxes), wall strips,
 * prisms/cylinders and frusta. Every face is oriented outward automatically (the winding is checked
 * against the solid's centre), so callers can list corners in any consistent cyclic order.
 */
import { SURF } from "../internal"
import type { RGB } from "./color"
import { faceNormal, surfForNormal, type MeshWriter, type V3 } from "./writer"

/** Colour of face `face` (hexahedron: 0 −u, 1 +u, 2 bottom, 3 top, 4 −v, 5 +v; prism: side index or -1 top / -2 bottom). */
export type FaceColor = RGB | ((face: number) => RGB)

export interface SurfOptions {
  /** Upward faces are walkable (floors, terrain, connector tops) instead of caps. */
  walkableTop?: boolean
}

const colorOf = (c: FaceColor, face: number): RGB => (typeof c === "function" ? c(face) : c)

// Corner index bits: 1 = +u, 2 = +y, 4 = +v.
const HEX_FACES: readonly (readonly [number, number, number, number])[] = [
  [0, 4, 6, 2],
  [1, 3, 7, 5],
  [0, 1, 5, 4],
  [2, 6, 7, 3],
  [0, 2, 3, 1],
  [4, 5, 7, 6],
]

/**
 * Write a quad a→b→c→d, flipped if needed so its normal points along `outward` (the vector from the
 * solid's interior toward the face). Returns the normal used.
 */
export function writeQuadOutward(w: MeshWriter, a: V3, b: V3, c: V3, d: V3, outward: V3, color: RGB, surf: number | null, walkableTop = false): V3 {
  let n = faceNormal(a, b, c)
  if (n[0] === 0 && n[1] === 0 && n[2] === 0) n = faceNormal(a, c, d)
  if (n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0) {
    const flipped: V3 = [-n[0], -n[1], -n[2]]
    w.quad(a, d, c, b, color, surf ?? surfForNormal(flipped[1], walkableTop), flipped)
    return flipped
  }
  w.quad(a, b, c, d, color, surf ?? surfForNormal(n[1], walkableTop), n)
  return n
}

/** Triangle flipped if needed so its normal points along `outward`. */
export function writeTriOutward(w: MeshWriter, a: V3, b: V3, c: V3, outward: V3, color: RGB, surf: number | null, walkableTop = false): void {
  const n = faceNormal(a, b, c)
  if (n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0) {
    const flipped: V3 = [-n[0], -n[1], -n[2]]
    w.triangle(a, c, b, color, surf ?? surfForNormal(flipped[1], walkableTop), flipped)
  } else {
    w.triangle(a, b, c, color, surf ?? surfForNormal(n[1], walkableTop), n)
  }
}

/** Closed hexahedron from 8 corners indexed by bits (1 = +u, 2 = +y, 4 = +v). */
export function writeHexahedron(w: MeshWriter, c: readonly V3[], color: FaceColor, opts: SurfOptions = {}): void {
  let cx = 0
  let cy = 0
  let cz = 0
  for (const p of c) {
    cx += p[0] / 8
    cy += p[1] / 8
    cz += p[2] / 8
  }
  for (let f = 0; f < 6; f++) {
    const [i0, i1, i2, i3] = HEX_FACES[f]
    const a = c[i0]
    const b = c[i1]
    const cc = c[i2]
    const d = c[i3]
    const out: V3 = [(a[0] + b[0] + cc[0] + d[0]) / 4 - cx, (a[1] + b[1] + cc[1] + d[1]) / 4 - cy, (a[2] + b[2] + cc[2] + d[2]) / 4 - cz]
    writeQuadOutward(w, a, b, cc, d, out, colorOf(color, f), null, opts.walkableTop ?? false)
  }
}

/**
 * Box in a frame on the ground plane: origin (ox, oz), unit direction (dx, dz) for u, its left normal
 * (−dz, dx) for v. Spans u ∈ [u0, u1], y ∈ [y0, y1], v ∈ [v0, v1]. Degenerate boxes are skipped.
 */
export function writeFrameBox(
  w: MeshWriter,
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  u0: number,
  u1: number,
  y0: number,
  y1: number,
  v0: number,
  v1: number,
  color: FaceColor,
  opts: SurfOptions = {}
): void {
  if (!(u1 - u0 > 1e-6 && y1 - y0 > 1e-6 && v1 - v0 > 1e-6)) return
  const nx = -dz
  const nz = dx
  const c: V3[] = []
  for (let k = 0; k < 8; k++) {
    const u = k & 1 ? u1 : u0
    const y = k & 2 ? y1 : y0
    const v = k & 4 ? v1 : v0
    c.push([ox + dx * u + nx * v, y, oz + dz * u + nz * v])
  }
  writeHexahedron(w, c, color, opts)
}

/**
 * Wall strip in the same ground frame as writeFrameBox: u ∈ [knots[0], knots[last]] (knots strictly
 * increasing), v ∈ [v0, v1], a flat bottom at y0 and a top linear between (knots[i], tops[i]) with every
 * top ≥ y0. One closed solid with a single outer surface (no internal faces between knot intervals): a
 * top quad per interval following the profile, the two long sides as one trapezoid per interval, the
 * bottom per interval (no T-junctions) and the two end caps. Colour indices as writeFrameBox's
 * hexahedron (0 −u cap, 1 +u cap, 2 bottom, 3 top, 4 −v side, 5 +v side). Side triangles and caps of
 * zero height (the top touching the bottom at a knot) are skipped.
 */
export function writeFrameStrip(
  w: MeshWriter,
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  knots: readonly number[],
  tops: readonly number[],
  y0: number,
  v0: number,
  v1: number,
  color: FaceColor
): void {
  const n = knots.length
  if (n < 2 || tops.length !== n || !(v1 - v0 > 1e-6) || !(knots[n - 1] - knots[0] > 1e-6)) return
  const nx = -dz
  const nz = dx
  const P = (u: number, y: number, v: number): V3 => [ox + dx * u + nx * v, y, oz + dz * u + nz * v]
  const up: V3 = [0, 1, 0]
  const down: V3 = [0, -1, 0]
  const sides: [number, V3, number][] = [
    [v0, [-nx, 0, -nz], 4],
    [v1, [nx, 0, nz], 5],
  ]
  const EPS = 1e-9
  for (let i = 0; i + 1 < n; i++) {
    const ua = knots[i]
    const ub = knots[i + 1]
    const ta = tops[i]
    const tb = tops[i + 1]
    writeQuadOutward(w, P(ua, ta, v0), P(ub, tb, v0), P(ub, tb, v1), P(ua, ta, v1), up, colorOf(color, 3), null)
    writeQuadOutward(w, P(ua, y0, v0), P(ub, y0, v0), P(ub, y0, v1), P(ua, y0, v1), down, colorOf(color, 2), null)
    const ha = ta - y0 > EPS
    const hb = tb - y0 > EPS
    for (const [v, out, face] of sides) {
      const c = colorOf(color, face)
      if (ha && hb) writeQuadOutward(w, P(ua, y0, v), P(ub, y0, v), P(ub, tb, v), P(ua, ta, v), out, c, null)
      else if (ha) writeTriOutward(w, P(ua, y0, v), P(ub, y0, v), P(ua, ta, v), out, c, null)
      else if (hb) writeTriOutward(w, P(ua, y0, v), P(ub, y0, v), P(ub, tb, v), out, c, null)
    }
  }
  const cap = (u: number, t: number, out: V3, face: number) => {
    if (t - y0 > EPS) writeQuadOutward(w, P(u, y0, v0), P(u, y0, v1), P(u, t, v1), P(u, t, v0), out, colorOf(color, face), null)
  }
  cap(knots[0], tops[0], [-dx, 0, -dz], 0)
  cap(knots[n - 1], tops[n - 1], [dx, 0, dz], 1)
}

/** Axis-aligned box. */
export function writeBox(w: MeshWriter, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: FaceColor, opts: SurfOptions = {}): void {
  writeFrameBox(w, 0, 0, 1, 0, x0, x1, y0, y1, z0, z1, color, opts)
}

/** Axis-aligned box given its base centre and full size. */
export function writeBoxAt(w: MeshWriter, cx: number, y0: number, cz: number, sx: number, sy: number, sz: number, color: FaceColor, opts: SurfOptions = {}): void {
  writeBox(w, cx - sx / 2, y0, cz - sz / 2, cx + sx / 2, y0 + sy, cz + sz / 2, color, opts)
}

export interface PrismOptions extends SurfOptions {
  /** Radius at the top (frustum); defaults to the bottom radius. */
  radiusTop?: number
  /** Angle of the first vertex (radians). */
  phase?: number
  /** Radial (smooth) side normals instead of flat facets. */
  smooth?: boolean
  capTop?: boolean
  capBottom?: boolean
}

/** Upright prism / frustum with `sides` facets around (cx, cz), from y0 to y1. */
export function writePrism(
  w: MeshWriter,
  cx: number,
  cz: number,
  radius: number,
  y0: number,
  y1: number,
  sides: number,
  color: FaceColor,
  opts: PrismOptions = {}
): void {
  const rt = opts.radiusTop ?? radius
  if (!(y1 - y0 > 1e-6) || !(radius > 0 || rt > 0) || sides < 3) return
  const phase = opts.phase ?? 0
  const h = y1 - y0
  const ang = (k: number) => phase + (2 * Math.PI * k) / sides
  for (let k = 0; k < sides; k++) {
    const a0 = ang(k)
    const a1 = ang(k + 1)
    const c0 = Math.cos(a0)
    const s0 = Math.sin(a0)
    const c1 = Math.cos(a1)
    const s1 = Math.sin(a1)
    const b0: V3 = [cx + radius * c0, y0, cz + radius * s0]
    const b1: V3 = [cx + radius * c1, y0, cz + radius * s1]
    const t0: V3 = [cx + rt * c0, y1, cz + rt * s0]
    const t1: V3 = [cx + rt * c1, y1, cz + rt * s1]
    const col = colorOf(color, k)
    if (opts.smooth) {
      // Radial normals tilted by the frustum slope; winding b0 → t0 → t1 faces outward for this
      // angle order (checked against the facet normal below).
      const slope = radius - rt
      const n0 = normalize([c0 * h, slope, s0 * h])
      const n1 = normalize([c1 * h, slope, s1 * h])
      const fn = faceNormal(b0, t0, t1)
      const mid = (a0 + a1) / 2
      const outward = fn[0] * Math.cos(mid) + fn[2] * Math.sin(mid) >= 0
      if (outward) {
        w.triangleSmooth(b0, n0, t0, n0, t1, n1, col, SURF.FACE)
        w.triangleSmooth(b0, n0, t1, n1, b1, n1, col, SURF.FACE)
      } else {
        w.triangleSmooth(b0, n0, t1, n1, t0, n0, col, SURF.FACE)
        w.triangleSmooth(b0, n0, b1, n1, t1, n1, col, SURF.FACE)
      }
    } else {
      const mid = (a0 + a1) / 2
      writeQuadOutward(w, b0, b1, t1, t0, [Math.cos(mid), 0, Math.sin(mid)], col, SURF.FACE)
    }
    if (opts.capTop !== false && rt > 0) {
      writeTriOutward(w, [cx, y1, cz], t0, t1, [0, 1, 0], colorOf(color, -1), null, opts.walkableTop ?? false)
    }
    if (opts.capBottom !== false && radius > 0) {
      writeTriOutward(w, [cx, y0, cz], b1, b0, [0, -1, 0], colorOf(color, -2), SURF.FACE)
    }
  }
}

export function normalize(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/**
 * Horizontal cylinder along the X axis (e.g. cart wheels), centre (cx, cy, cz), from x0 to x1.
 */
export function writeCylinderX(w: MeshWriter, x0: number, x1: number, cy: number, cz: number, radius: number, sides: number, color: FaceColor): void {
  for (let k = 0; k < sides; k++) {
    const a0 = (2 * Math.PI * k) / sides
    const a1 = (2 * Math.PI * (k + 1)) / sides
    const p = (x: number, a: number): V3 => [x, cy + radius * Math.sin(a), cz + radius * Math.cos(a)]
    const mid = (a0 + a1) / 2
    const col = colorOf(color, k)
    writeQuadOutward(w, p(x0, a0), p(x1, a0), p(x1, a1), p(x0, a1), [0, Math.sin(mid), Math.cos(mid)], col, null)
    writeTriOutward(w, [x0, cy, cz], p(x0, a0), p(x0, a1), [-1, 0, 0], col, SURF.FACE)
    writeTriOutward(w, [x1, cy, cz], p(x1, a1), p(x1, a0), [1, 0, 0], col, SURF.FACE)
  }
}
