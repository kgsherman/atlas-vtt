/**
 * Octahedral distance-map math (ARCHITECTURE §4.2), mirrored 1:1 by the GLSL in
 * render/materials/glsl/common.ts (world/token shaders) and glsl/reencode.ts (cube → tile pass).
 *
 * Mapping: a unit direction d is L1-normalised (n = d / (|dx|+|dy|+|dz|)). The lower hemisphere
 * (n.y ≤ 0) maps to uv = n.xz, so straight DOWN (−Y) is the centre of the tile; the upper hemisphere
 * is folded over the diamond's edges, so every seam lies in the upward hemisphere (hidden by cutaway).
 *
 * Tile layout (T = tile texels per side): a 1-texel guard ring surrounds an interior of S = T − 2
 * texels covering uv ∈ [−1, 1]². Interior texel i ∈ [0, S) has its centre at uv = (i + 0.5)/S·2 − 1;
 * guard texels (i = −1 and i = S) hold the octahedral wrap of the texel across the edge, so a
 * bilinear 2×2 footprint (and the 3×3 box footprint) never leaves the tile; the 4×4 line-of-sight
 * footprint (losContour) clamps its outer taps to the guard ring.
 */

export type Dir3 = [number, number, number]

/** √(4π): angular size of one texel ≈ √(4π)/S radians (4π sr spread over S² texels). */
export const SQRT_4PI = Math.sqrt(4 * Math.PI)

/** Tolerance added to stored distances in every comparison (feet). */
export const DISTANCE_EPSILON = 0.05

const signNotZero = (v: number): number => (v >= 0 ? 1 : -1)

/** Unit (or any non-zero) direction → octahedral uv in [−1, 1]². */
export function octEncode(x: number, y: number, z: number): [number, number] {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z)
  const nx = x / l1
  const ny = y / l1
  const nz = z / l1
  if (ny <= 0) return [nx, nz]
  return [(1 - Math.abs(nz)) * signNotZero(nx), (1 - Math.abs(nx)) * signNotZero(nz)]
}

/** Octahedral uv in [−1, 1]² → unit direction. */
export function octDecode(u: number, v: number): Dir3 {
  const t = 1 - Math.abs(u) - Math.abs(v)
  let x = u
  let z = v
  // t ≥ 0: lower hemisphere (y = −t ≤ 0). t < 0: unfold the upper hemisphere.
  if (t < 0) {
    x = (1 - Math.abs(v)) * signNotZero(u)
    z = (1 - Math.abs(u)) * signNotZero(v)
  }
  const y = -t
  const len = Math.hypot(x, y, z)
  return [x / len, y / len, z / len]
}

/**
 * Fold a uv that lies (at most one tile width) outside [−1, 1]² back into range. Crossing the edge
 * u = ±1 mirrors v (the points (±1, v) and (±1, −v) are the same direction), likewise for v.
 */
export function octWrap(u: number, v: number): [number, number] {
  if (Math.abs(u) > 1) {
    u = signNotZero(u) * (2 - Math.abs(u))
    v = -v
  }
  if (Math.abs(v) > 1) {
    v = signNotZero(v) * (2 - Math.abs(v))
    u = -u
  }
  return [u, v]
}

/** Interior texels per side of a tile. */
export const tileInterior = (tileTexels: number): number => tileTexels - 2

/**
 * Normal-offset scale k of §4.2: the receiver is pushed along its normal by 1.5 texel footprints at
 * its distance, q = p + n·k·d with k = 1.5·√(4π)/(tileTexels − 2).
 */
export function normalOffsetScale(tileTexels: number): number {
  return (1.5 * SQRT_4PI) / tileInterior(tileTexels)
}

/** Caps (SURF.CAP: tops of walls, doors, pillars, props) are tested this far (ft) inside their solid. */
export const CAP_INSET = 0.03
/** …and must be at least this much (ft) in front of the stored back face (strict comparison). */
export const CAP_EPSILON = 0.01

/**
 * Receiver lookup vector relative to the capture origin: q − src with q = p + n·k·|p − src|.
 * Returns the offset vector and its length (the distance compared against the stored map) and the
 * comparison epsilon to use with pcfSample.
 *
 * Caps deviate from §4.2's normal offset: q = p − n·CAP_INSET, compared strictly (−CAP_EPSILON). The
 * stored map holds back faces ("second depth"), and a cap touching the underside of a slab (a 9 ft wall
 * under the next storey's floor) lies exactly on the slab's back face: pushed outward it would read as
 * lit through the floor above. From just inside its own solid, a free cap still sees the light (its own
 * back faces are further along the ray) while a covered one does not.
 */
export function receiverOffset(p: Dir3, n: Dir3, src: Dir3, tileTexels: number, cap = false): { q: Dir3; dist: number; epsilon: number } {
  const rx = p[0] - src[0]
  const ry = p[1] - src[1]
  const rz = p[2] - src[2]
  const d = Math.hypot(rx, ry, rz)
  const k = cap ? -CAP_INSET : normalOffsetScale(tileTexels) * d
  const q: Dir3 = [rx + n[0] * k, ry + n[1] * k, rz + n[2] * k]
  return { q, dist: Math.hypot(q[0], q[1], q[2]), epsilon: cap ? -CAP_EPSILON : DISTANCE_EPSILON }
}

/** Sub-texel sample offsets used by the re-encode pass (MIN of 4 cube taps per texel). */
export const REENCODE_TAPS: ReadonlyArray<[number, number]> = [
  [0.25, 0.25],
  [0.75, 0.25],
  [0.25, 0.75],
  [0.75, 0.75],
]

/**
 * Directions sampled for tile texel (tx, ty), tx/ty ∈ [0, T) including the guard ring. Mirrors the
 * re-encode fragment shader: interior coordinate i = t − 1, uv continued linearly past the edge and
 * then wrapped.
 */
export function tileTexelDirections(tx: number, ty: number, tileTexels: number): Dir3[] {
  const s = tileInterior(tileTexels)
  return REENCODE_TAPS.map(([ox, oy]) => {
    const u = ((tx - 1 + ox) / s) * 2 - 1
    const v = ((ty - 1 + oy) / s) * 2 - 1
    const [wu, wv] = octWrap(u, v)
    return octDecode(wu, wv)
  })
}

/** Direction through the centre of interior texel (ix, iy) of a tile (−1 and `interior` are the guard ring). */
export function texelCenterDirection(ix: number, iy: number, interior: number): Dir3 {
  const [u, v] = octWrap(((ix + 0.5) / interior) * 2 - 1, ((iy + 0.5) / interior) * 2 - 1)
  return octDecode(u, v)
}

/** A receiver's tangent plane for pcfSample: point q relative to the capture origin, unit normal n. */
export interface ReceiverPlane {
  q: Dir3
  n: Dir3
}

/** Receiver-plane distances stay within this fraction of the receiver's own distance. */
export const PLANE_DISTANCE_CLAMP = 0.1

/**
 * Receiver-plane depth bias: the distance along a PCF tap's own direction `w` to the receiver's tangent
 * plane, instead of the receiver's distance along its direction. Every tap then compares like against
 * like, so a receiver lying on (or just behind) an occluder's back-face plane cannot pass through the
 * neighbouring taps at grazing angles (acne). Used only by capCovered: for general receivers the plane
 * runs under whatever stands on the surface, and taps aimed there would leak light at contacts. Falls
 * back to `dist` when the tap runs parallel to (or away from) the plane; clamped to ±10 %.
 */
export function planeDistance(plane: ReceiverPlane, w: Dir3, dist: number): number {
  const { q, n } = plane
  const dn = w[0] * n[0] + w[1] * n[1] + w[2] * n[2]
  if (dn > -1e-3) return dist
  const t = (q[0] * n[0] + q[1] * n[1] + q[2] * n[2]) / dn
  if (!(t > 0)) return dist
  return Math.min(Math.max(t, dist * (1 - PLANE_DISTANCE_CLAMP)), dist * (1 + PLANE_DISTANCE_CLAMP))
}

/**
 * Cap receivers (see receiverOffset): is the cap covered by an occluder resting on it? The texel under q,
 * compared on the cap's own plane — robust at grazing angles, where the back-face plane of a covering
 * slab moves by more than the inset from one texel to the next. A cap that is not covered then uses the
 * regular filter WITHOUT plane distances: the plane of a thin cap runs inside its solid, and taps past
 * its far edge would exit through the side face first (streaks). Mirrors atCapCovered in the shaders.
 */
export function capCovered(fetch: (ax: number, ay: number) => number, tile: TileRect, plane: ReceiverPlane): boolean {
  const { q } = plane
  const dist = Math.hypot(q[0], q[1], q[2])
  if (dist < 1e-4) return false
  const s = tileInterior(tile.size)
  const [u, v] = octEncode(q[0], q[1], q[2])
  const ix = Math.floor(Math.min(Math.max(((u * 0.5 + 0.5) * s) - 0.5, 0), s - 1) + 0.5)
  const iy = Math.floor(Math.min(Math.max(((v * 0.5 + 0.5) * s) - 0.5, 0), s - 1) + 0.5)
  const stored = fetch(tile.x + 1 + ix, tile.y + 1 + iy)
  return planeDistance(plane, texelCenterDirection(ix, iy, s), dist) > stored - CAP_EPSILON
}

/**
 * Where capCovered probes a cap: its inset receiver shifted toward the source (horizontally) by one
 * filter footprint, k·d / sin(elevation) capped at 0.5 ft. A slab resting on the cap extends past it,
 * so a covered cap stays covered there, while a free cap's own far edge — whose side-face exits fill the
 * texels at grazing angles — is out of reach. Returns the probe relative to the source.
 */
export function capCoverageProbe(p: Dir3, n: Dir3, src: Dir3, tileTexels: number): Dir3 {
  const rx = p[0] - src[0]
  const ry = p[1] - src[1]
  const rz = p[2] - src[2]
  const d = Math.hypot(rx, ry, rz)
  const sinA = Math.max(-(rx * n[0] + ry * n[1] + rz * n[2]) / Math.max(d, 1e-4), 0.15)
  const shift = Math.min(0.5, (normalOffsetScale(tileTexels) * d) / sinA)
  const h = Math.hypot(rx, rz)
  const hx = h > 1e-4 ? -rx / h : 0
  const hz = h > 1e-4 ? -rz / h : 0
  return [rx - n[0] * CAP_INSET + hx * shift, ry - n[1] * CAP_INSET, rz - n[2] * CAP_INSET + hz * shift]
}

/** CPU mirror of the re-encode pass for one texel: the minimum of the 4 cube taps (conservative). */
export function reencodeTexel(tx: number, ty: number, tileTexels: number, sampleCube: (d: Dir3) => number): number {
  let m = Infinity
  for (const d of tileTexelDirections(tx, ty, tileTexels)) m = Math.min(m, sampleCube(d))
  return m
}

export interface TileRect {
  /** Atlas texel of the tile's lower-left corner (guard ring included). */
  x: number
  y: number
  /** Tile texels per side (guard ring included). */
  size: number
}

/**
 * CPU mirror of the shader PCF (`atPcf` in glsl/common.ts). `fetch(ax, ay)` returns the stored distance
 * at atlas texel (ax, ay). Returns the lit/visible fraction in [0, 1]:
 *  - narrow: bilinear-weighted 2×2 taps around the continuous texel position;
 *  - wide: 3×3 taps with a 2-texel box filter (weights ½−o, 1, ½+o per axis, sum 4).
 * A tap passes when `dist ≤ stored + epsilon` (DISTANCE_EPSILON by default). `plane` switches to
 * receiver-plane distances per tap: analysis / tests only — the shaders filter with the receiver's own
 * distance, because plane distances leak light at contacts (see planeDistance).
 */
export function pcfSample(
  fetch: (ax: number, ay: number) => number,
  tile: TileRect,
  u: number,
  v: number,
  dist: number,
  wide: boolean,
  epsilon = DISTANCE_EPSILON,
  plane: ReceiverPlane | null = null
): number {
  const s = tileInterior(tile.size)
  const bx = tile.x + 1
  const by = tile.y + 1
  const fx = Math.min(Math.max(((u * 0.5 + 0.5) * s) - 0.5, -0.5), s - 0.5)
  const fy = Math.min(Math.max(((v * 0.5 + 0.5) * s) - 0.5, -0.5), s - 0.5)
  const tapDist = (ix: number, iy: number): number => (plane ? planeDistance(plane, texelCenterDirection(ix, iy, s), dist) : dist)
  const pass = (ix: number, iy: number): number => (tapDist(ix, iy) <= fetch(bx + ix, by + iy) + epsilon ? 1 : 0)
  if (!wide) {
    const ix = Math.floor(fx)
    const iy = Math.floor(fy)
    const wx = fx - ix
    const wy = fy - iy
    const a = pass(ix, iy) * (1 - wx) + pass(ix + 1, iy) * wx
    const b = pass(ix, iy + 1) * (1 - wx) + pass(ix + 1, iy + 1) * wx
    return a * (1 - wy) + b * wy
  }
  const cx = Math.min(Math.max(Math.floor(fx + 0.5), 0), s - 1)
  const cy = Math.min(Math.max(Math.floor(fy + 0.5), 0), s - 1)
  const ox = fx - cx
  const oy = fy - cy
  const wxs = [0.5 - ox, 1, 0.5 + ox]
  const wys = [0.5 - oy, 1, 0.5 + oy]
  let sum = 0
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) sum += pass(cx + i - 1, cy + j - 1) * wxs[i] * wys[j]
  }
  return sum / 4
}

/** Cubic B-spline weights of the 4 taps around a point at fraction f between the middle two (atBSpline). */
export function bSplineWeights(f: number): [number, number, number, number] {
  const g = 1 - f
  const f2 = f * f
  const f3 = f2 * f
  return [(g * g * g) / 6, (3 * f3 - 6 * f2 + 4) / 6, (-3 * f3 + 3 * f2 + 3 * f + 1) / 6, f3 / 6]
}

/** Derivatives of bSplineWeights with respect to f (atBSplineSlope). */
export function bSplineSlopes(f: number): [number, number, number, number] {
  const g = 1 - f
  return [(-g * g) / 2, (3 * f * f - 4 * f) / 2, (-3 * f * f + 2 * f + 1) / 2, (f * f) / 2]
}

/** Continuous interior texel coordinate of an octahedral uv component in a tile with `interior` texels. */
const texelCoord = (uv: number, interior: number): number => (uv * 0.5 + 0.5) * interior - 0.5

const cut = (field: number): number => {
  const t = Math.min(Math.max((field - 0.38) / 0.24, 0), 1)
  return t * t * (3 - 2 * t)
}

/**
 * CPU mirror of the viewer line-of-sight field (`atLosField` in glsl/common.ts) at (fx, fy), in interior texel
 * coordinates: the binary test `dist ≤ stored + epsilon` at the 4×4 texels around it weighted by a cubic
 * B-spline, with its gradient, to be cut at 0.5. An occluder's outline in the map is a staircase of texels;
 * the bilinear 2×2 filter followed it, and where the view grazes the ground past a sill or a ledge each texel
 * step stretches to a foot or more of ground (feathered teeth along the fog edge). The spline's contour is a
 * smooth curve through the steps. Unless `full`, when the 2×2 around (fx, fy) agree it returns their verdict
 * (0 or 1, no gradient): the spline is past its cut whatever the outer ring holds (the inner taps carry
 * ≥ 25/36 of the weight). Taps are clamped to the guard ring.
 */
export function losField(
  fetch: (ax: number, ay: number) => number,
  tile: TileRect,
  fx: number,
  fy: number,
  dist: number,
  epsilon = DISTANCE_EPSILON,
  full = false
): { field: number; gx: number; gy: number } {
  const s = tileInterior(tile.size)
  const x = Math.min(Math.max(fx, -0.5), s - 0.5)
  const y = Math.min(Math.max(fy, -0.5), s - 0.5)
  const ix = Math.floor(x)
  const iy = Math.floor(y)
  const clampI = (i: number) => Math.min(Math.max(i, -1), s)
  const pass = (i: number, j: number): number => (dist <= fetch(tile.x + 1 + clampI(i), tile.y + 1 + clampI(j)) + epsilon ? 1 : 0)
  if (!full) {
    const inner = pass(ix, iy) + pass(ix + 1, iy) + pass(ix, iy + 1) + pass(ix + 1, iy + 1)
    if (inner === 0 || inner === 4) return { field: inner / 4, gx: 0, gy: 0 }
  }
  const wx = bSplineWeights(x - ix)
  const wy = bSplineWeights(y - iy)
  const sx = bSplineSlopes(x - ix)
  const sy = bSplineSlopes(y - iy)
  let field = 0
  let gx = 0
  let gy = 0
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const b = pass(ix + i - 1, iy + j - 1)
      field += b * wx[i] * wy[j]
      gx += b * sx[i] * wy[j]
      gy += b * wx[i] * sy[j]
    }
  }
  return { field, gx, gy }
}

/** The line-of-sight field at octahedral (u, v), cut at 0.5 (smoothstep 0.38 … 0.62): one tap of atViewerLos. */
export function losContour(
  fetch: (ax: number, ay: number) => number,
  tile: TileRect,
  u: number,
  v: number,
  dist: number,
  epsilon = DISTANCE_EPSILON
): number {
  const s = tileInterior(tile.size)
  return cut(losField(fetch, tile, texelCoord(u, s), texelCoord(v, s), dist, epsilon).field)
}

/**
 * CPU mirror of one eye's test in `atViewerLos` (glsl/common.ts). rel = the receiver's test point relative to
 * the eye (surface offsets applied), n = its normal, footprint = the pixel's size on it (ft). The normal
 * offset of §4.2 (none for caps), then the field cut at 0.5. Where one texel spans more than the footprint
 * along the ray on the surface, the field is first averaged across the ray (9 taps 0.8 texel apart, stepped
 * in world space so they follow the map's folds), each tap weighted by its field's slope along the ray in the
 * map where its contour runs across the ray, and used as far as the receiver's own contour does: an edge
 * across the ray, whose position wobbles by about a texel there, gets its mean position (a straight line);
 * an edge along the ray (resolved to a texel's angle) stays sharp, and taps on one or in open space carry no
 * weight, so nothing leaks round a corner or past a line's end. Receivers whose 4×4 texels agree skip it.
 */
export function viewerLosSample(
  fetch: (ax: number, ay: number) => number,
  tile: TileRect,
  rel: Dir3,
  n: Dir3,
  footprint: number,
  cap = false
): number {
  const d = Math.hypot(rel[0], rel[1], rel[2])
  const s = tileInterior(tile.size)
  const texAng = SQRT_4PI / s
  const lift = cap ? 0 : 1.5 * texAng * d
  const q: Dir3 = [rel[0] + n[0] * lift, rel[1] + n[1] * lift, rel[2] + n[2] * lift]
  const at = (p: Dir3, full: boolean) => {
    const [u, v] = octEncode(p[0], p[1], p[2])
    return losField(fetch, tile, texelCoord(u, s), texelCoord(v, s), Math.hypot(p[0], p[1], p[2]), DISTANCE_EPSILON, full)
  }
  const qd = Math.hypot(q[0], q[1], q[2])
  if (qd < 1e-4) return 1
  const graze = Math.max(Math.abs(rel[0] * n[0] + rel[1] * n[1] + rel[2] * n[2]) / Math.max(d, 1e-4), 0.02)
  const wide = (texAng * d) / graze > footprint
  const centre = at(q, wide)
  const inv = 1 / Math.max(d, 1e-4)
  const lat: Dir3 = [(rel[1] * n[2] - rel[2] * n[1]) * inv, (rel[2] * n[0] - rel[0] * n[2]) * inv, (rel[0] * n[1] - rel[1] * n[0]) * inv]
  const latLen = Math.hypot(lat[0], lat[1], lat[2])
  if (!wide || centre.field <= 0 || centre.field >= 1 || latLen < 0.05) return cut(centre.field)
  // One texel's angle across the ray, in world units along lat and in texels in the map; and the map's
  // direction for a step along the ray on the surface (the map is sheared: not square to the first).
  const step = (texAng * qd) / latLen
  const [u0, v0] = octEncode(q[0], q[1], q[2])
  const [u1, v1] = octEncode(q[0] + lat[0] * step, q[1] + lat[1] * step, q[2] + lat[2] * step)
  const ll = Math.hypot(u1 - u0, v1 - v0) * 0.5 * s
  const dn = rel[0] * n[0] + rel[1] * n[1] + rel[2] * n[2]
  const along = (texAng * qd) / graze / Math.max(d, 1e-4)
  const [u2, v2] = octEncode(q[0] + (rel[0] - n[0] * dn) * along, q[1] + (rel[1] - n[1] * dn) * along, q[2] + (rel[2] - n[2] * dn) * along)
  const rx = u2 - u0
  const ry = v2 - v0
  const rl = Math.hypot(rx, ry)
  if (ll < 1e-3 || ll > 4 || rl < 1e-9 || rl * 0.5 * s > 4) return cut(centre.field)
  // How far a contour runs across the ray (1 within ~35° of it, 0 beyond ~60°: the staircase tilts a contour
  // by up to ~25°), and a tap's weight: that times its field's slope along the ray in the map.
  const across = (t: { gx: number; gy: number }) => {
    const g = Math.hypot(t.gx, t.gy)
    if (g < 1e-6) return { a: 0, w: 0 }
    const c = Math.abs(t.gx * rx + t.gy * ry) / (rl * g)
    const k = Math.min(Math.max((c - 0.5) / 0.3, 0), 1)
    const a = k * k * (3 - 2 * k)
    return { a, w: g * c * a }
  }
  const own = across(centre).a
  if (own <= 0) return cut(centre.field)
  let num = LOS_OWN_WEIGHT * centre.field
  let den = LOS_OWN_WEIGHT
  for (let k = -4; k <= 4; k++) {
    const o = (0.8 * k * step) / ll
    const tap = k === 0 ? centre : at([q[0] + lat[0] * o, q[1] + lat[1] * o, q[2] + lat[2] * o], true)
    const w = across(tap).w
    num += w * tap.field
    den += w
  }
  // Only as far as the receiver's own contour runs across the ray: past the end of a thin shadow line (an
  // edge along the ray) the taps would reach back into the line's sides.
  return cut(centre.field + (num / den - centre.field) * own)
}

/**
 * Weight of the receiver's own field in viewerLosSample's average (AT_LOS_OWN_WEIGHT; a tap on an edge
 * across the ray weighs up to 2/3): enough that a few taps on an edge along the ray, their contour tilted
 * by the staircase, cannot outweigh it.
 */
export const LOS_OWN_WEIGHT = 0.25
