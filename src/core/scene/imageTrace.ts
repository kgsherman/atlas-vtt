/**
 * Geometry from a battlemap image's alpha channel (docs/ARCHITECTURE.md §9 "From image"). Pure: works
 * on raw RGBA pixels, so it runs in a Worker and in vitest.
 *
 *  - floorMaskFromAlpha: a masked floor covering exactly the opaque part of the image (caves, rotated
 *    upper storeys), on a lattice of `spacing` feet anchored at the world origin.
 *  - wallsFromAlpha: wall segments along the alpha boundary: the alpha is box-filtered onto a coarse
 *    sample grid, contoured with marching squares (linear interpolation, saddles resolved by the
 *    centre average), the contours are followed into closed rings, simplified with Douglas–Peucker
 *    and cleaned of short edges and tiny loops.
 *
 * The image covers `calib.rect` in world feet: pixel (px, py) spans
 * x ∈ [rect.x + px·rect.w/width, …), z ∈ [rect.z + py·rect.d/height, …) (image rows run along +Z).
 */
import { createFloor, createWall } from "./factory"
import { bytesToBase64 } from "./heightmap"
import type { FloorMask, FloorObject, Id, MaterialId, Rect, Vec2, WallObject } from "./types"

/** RGBA pixels (4 bytes per pixel, row-major), e.g. an ImageData. */
export interface TraceImage {
  width: number
  height: number
  data: Uint8ClampedArray | Uint8Array
}

export interface TraceCalibration {
  /** World rect the image covers (feet). */
  rect: Rect
  /** Grid cell size (feet). */
  cellSize: number
}

export interface FloorMaskOptions {
  /** Mask cell size in feet (default cellSize / 4). */
  spacing?: number
  /** Alpha (0..255) at or above which a pixel counts as opaque (default 128). */
  threshold?: number
  /** Fraction of a mask cell that must be opaque for the cell to be covered (default 0.5). */
  minCoverage?: number
}

export interface TracedFloor {
  /** Lattice-aligned bounds of the covered cells. */
  rect: Rect
  mask: FloorMask
  /** Covered mask cells / all mask cells in `rect` (1 = the mask is a plain rect). */
  fill: number
}

export interface WallTraceOptions {
  /** Alpha iso-level (0..255) of the boundary (default 128). */
  threshold?: number
  /** Douglas–Peucker tolerance in feet (default 0.75). */
  tolerance?: number
  /** Shortest wall kept, feet (default 1). Shorter edges are merged into their neighbours. */
  minLength?: number
  /** Loops enclosing less than this area (ft²) are dropped (default (cellSize / 2)²). */
  minArea?: number
  /** Sample spacing of the downsampled alpha grid, feet (default min(tolerance / 2, cellSize / 8)). */
  resolution?: number
  /** Wall thickness / height for wallObjectsFromAlpha (ignored by wallsFromAlpha). */
  thickness?: number
  height?: number
}

export interface TracedSegment {
  a: Vec2
  b: Vec2
}

/** Cap on the downsampled alpha grid (samples) so huge maps stay fast. */
const MAX_TRACE_SAMPLES = 4_000_000
/** Cap on mask cells (matches the scene schema's MAX_FLOOR_MASK_CELLS). */
const MAX_MASK_CELLS = 800 * 800
const MAX_MASK_SIDE = 4096

function checkImage(img: TraceImage): void {
  if (!(img.width > 0 && img.height > 0) || img.data.length < img.width * img.height * 4) {
    throw new Error("imageTrace: image data does not match its size")
  }
}

function checkRect(r: Rect): void {
  if (![r.x, r.z, r.w, r.d].every(Number.isFinite) || !(r.w > 0 && r.d > 0)) throw new Error("imageTrace: invalid calibration rect")
}

// ---------------------------------------------------------------------------
// Floor mask
// ---------------------------------------------------------------------------

/**
 * The floor covering the opaque part of the image: mask cells of `spacing` feet on the world lattice
 * (multiples of `spacing`), covered when at least `minCoverage` of the cell is opaque, trimmed to the
 * covered bounds. null when nothing is opaque.
 */
export function floorMaskFromAlpha(img: TraceImage, calib: TraceCalibration, opts: FloorMaskOptions = {}): TracedFloor | null {
  checkImage(img)
  checkRect(calib.rect)
  const R = calib.rect
  let s = opts.spacing ?? calib.cellSize / 4
  if (!(s > 0)) throw new Error("imageTrace: spacing must be > 0")
  const threshold = opts.threshold ?? 128
  const minCoverage = opts.minCoverage ?? 0.5
  const eps = 1e-9
  // Lattice bounds covering the image rect; coarsened (doubling) if a mask could not hold them.
  const lattice = (sp: number) => {
    const u0 = Math.floor(R.x / sp + eps)
    const v0 = Math.floor(R.z / sp + eps)
    return { u0, v0, cols: Math.ceil((R.x + R.w) / sp - eps) - u0, rows: Math.ceil((R.z + R.d) / sp - eps) - v0 }
  }
  let L = lattice(s)
  while (L.cols * L.rows > MAX_MASK_CELLS || L.cols > MAX_MASK_SIDE || L.rows > MAX_MASK_SIDE) {
    s *= 2
    L = lattice(s)
  }
  const { u0, v0, cols, rows } = L
  const W = img.width
  const H = img.height
  const pw = R.w / W
  const ph = R.d / H
  const data = img.data
  const covered = new Uint8Array(cols * rows)

  if (pw > s / 2 || ph > s / 2) {
    // The image is coarser than the lattice: point-sample each cell centre.
    for (let v = 0; v < rows; v++) {
      const z = (v0 + v + 0.5) * s
      const py = Math.floor((z - R.z) / ph)
      if (py < 0 || py >= H) continue
      for (let u = 0; u < cols; u++) {
        const x = (u0 + u + 0.5) * s
        const px = Math.floor((x - R.x) / pw)
        if (px < 0 || px >= W) continue
        if (data[(py * W + px) * 4 + 3] >= threshold) covered[v * cols + u] = 1
      }
    }
  } else {
    // Count opaque pixels (by pixel centre) per lattice cell.
    const colCell = new Int32Array(W)
    for (let px = 0; px < W; px++) colCell[px] = Math.min(cols - 1, Math.max(0, Math.floor((R.x + (px + 0.5) * pw) / s) - u0))
    const counts = new Uint32Array(cols * rows)
    for (let py = 0; py < H; py++) {
      const v = Math.min(rows - 1, Math.max(0, Math.floor((R.z + (py + 0.5) * ph) / s) - v0))
      const base = v * cols
      let k = py * W * 4 + 3
      for (let px = 0; px < W; px++, k += 4) {
        if (data[k] >= threshold) counts[base + colCell[px]]++
      }
    }
    // Coverage relative to a FULL lattice cell, so cells the image only partly covers count partly.
    const need = Math.max(1, minCoverage * ((s * s) / (pw * ph)))
    for (let c = 0; c < counts.length; c++) if (counts[c] >= need - 1e-9) covered[c] = 1
  }

  let umin = cols
  let umax = -1
  let vmin = rows
  let vmax = -1
  let set = 0
  for (let v = 0; v < rows; v++) {
    for (let u = 0; u < cols; u++) {
      if (!covered[v * cols + u]) continue
      set++
      if (u < umin) umin = u
      if (u > umax) umax = u
      if (v < vmin) vmin = v
      if (v > vmax) vmax = v
    }
  }
  if (set === 0) return null
  const mc = umax - umin + 1
  const mr = vmax - vmin + 1
  const bits = new Uint8Array(Math.ceil((mc * mr) / 8))
  for (let v = 0; v < mr; v++) {
    for (let u = 0; u < mc; u++) {
      if (!covered[(v + vmin) * cols + (u + umin)]) continue
      const k = v * mc + u
      bits[k >> 3] |= 1 << (k & 7)
    }
  }
  return {
    rect: { x: (u0 + umin) * s, z: (v0 + vmin) * s, w: mc * s, d: mr * s },
    mask: { spacing: s, cols: mc, rows: mr, b64: bytesToBase64(bits) },
    fill: set / (mc * mr),
  }
}

// ---------------------------------------------------------------------------
// Contours
// ---------------------------------------------------------------------------

/** Box-filtered alpha on a padded sample grid (a ring of zeros around the image). */
interface AlphaField {
  /** Samples per row / column including the padding ring. */
  nx: number
  nz: number
  values: Float32Array
  /** World position of padded sample (0, 0) and the sample spacing. */
  x0: number
  z0: number
  rx: number
  rz: number
}

function alphaField(img: TraceImage, R: Rect, resolution: number): AlphaField {
  const W = img.width
  const H = img.height
  let r = Math.max(resolution, R.w / W, R.d / H)
  if ((R.w / r) * (R.d / r) > MAX_TRACE_SAMPLES) r = Math.sqrt((R.w * R.d) / MAX_TRACE_SAMPLES)
  // Bins tile the image exactly (never finer than a pixel, so none is empty).
  const bx = Math.max(1, Math.min(W, Math.round(R.w / r)))
  const bz = Math.max(1, Math.min(H, Math.round(R.d / r)))
  const colBin = new Int32Array(W)
  for (let px = 0; px < W; px++) colBin[px] = Math.min(bx - 1, Math.floor(((px + 0.5) * bx) / W))
  const sums = new Float64Array(bx * bz)
  const counts = new Uint32Array(bx * bz)
  const data = img.data
  for (let py = 0; py < H; py++) {
    const base = Math.min(bz - 1, Math.floor(((py + 0.5) * bz) / H)) * bx
    let k = py * W * 4 + 3
    for (let px = 0; px < W; px++, k += 4) {
      const c = base + colBin[px]
      sums[c] += data[k]
      counts[c]++
    }
  }
  const nx = bx + 2
  const nz = bz + 2
  const values = new Float32Array(nx * nz)
  for (let j = 0; j < bz; j++) {
    for (let i = 0; i < bx; i++) {
      const c = j * bx + i
      values[(j + 1) * nx + (i + 1)] = counts[c] > 0 ? sums[c] / counts[c] : 0
    }
  }
  const rx = R.w / bx
  const rz = R.d / bz
  return { nx, nz, values, x0: R.x - rx / 2, z0: R.z - rz / 2, rx, rz }
}

// Marching-squares segment table: corners c0 (k,l), c1 (k+1,l), c2 (k+1,l+1), c3 (k,l+1);
// edges e0 = c0–c1, e1 = c1–c2, e2 = c3–c2, e3 = c0–c3. Unordered edge pairs per case
// (saddles 5 and 10 are resolved at runtime by the centre average).
const CASES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [],
  [[3, 0]],
  [[0, 1]],
  [[3, 1]],
  [[1, 2]],
  [], // saddle
  [[0, 2]],
  [[2, 3]],
  [[2, 3]],
  [[0, 2]],
  [], // saddle
  [[1, 2]],
  [[1, 3]],
  [[0, 1]],
  [[3, 0]],
  [],
]
/** Corner shared by two adjacent edges (key a·4 + b), −1 for opposite edges. */
function sharedCorner(a: number, b: number): number {
  const lo = Math.min(a, b)
  const hi = Math.max(a, b)
  if (lo === 0 && hi === 1) return 1
  if (lo === 1 && hi === 2) return 2
  if (lo === 2 && hi === 3) return 3
  if (lo === 0 && hi === 3) return 0
  return -1
}

/**
 * Closed contours (rings) of the alpha iso-level, in world feet, inside on the LEFT when walking a ring
 * in the (x, z) plane (outer boundaries have positive signed area, holes negative). Unsimplified.
 */
export function alphaContours(img: TraceImage, calib: TraceCalibration, opts: Pick<WallTraceOptions, "threshold" | "resolution" | "tolerance"> = {}): Vec2[][] {
  checkImage(img)
  checkRect(calib.rect)
  const threshold = opts.threshold ?? 128
  const tolerance = opts.tolerance ?? 0.75
  const f = alphaField(img, calib.rect, opts.resolution ?? Math.min(tolerance / 2, calib.cellSize / 8))
  const { nx, nz, values } = f
  const inside = (k: number, l: number) => values[l * nx + k] >= threshold
  const val = (k: number, l: number) => values[l * nx + k]
  // Edge ids: horizontal edge (k,l)–(k+1,l) = 2·(l·nx+k); vertical edge (k,l)–(k,l+1) = 2·(l·nx+k)+1.
  const H = (k: number, l: number) => 2 * (l * nx + k)
  const V = (k: number, l: number) => 2 * (l * nx + k) + 1
  const next = new Map<number, number>()
  const point = new Map<number, Vec2>()

  // Endpoints [ka, la, kb, lb] of edge e of square (k, l), and the edge id.
  const EDGE_ENDS: ReadonlyArray<readonly [number, number, number, number]> = [
    [0, 0, 1, 0],
    [1, 0, 1, 1],
    [0, 1, 1, 1],
    [0, 0, 0, 1],
  ]
  const edgePoint = (k: number, l: number, e: number): { id: number; p: Vec2 } => {
    const [dka, dla, dkb, dlb] = EDGE_ENDS[e]
    const ka = k + dka
    const la = l + dla
    const kb = k + dkb
    const lb = l + dlb
    const id = e === 0 || e === 2 ? H(ka, la) : V(ka, la)
    const va = val(ka, la)
    const vb = val(kb, lb)
    let t = va === vb ? 0.5 : (threshold - va) / (vb - va)
    t = Math.min(0.999, Math.max(0.001, t))
    const p = { x: f.x0 + (ka + (kb - ka) * t) * f.rx, z: f.z0 + (la + (lb - la) * t) * f.rz }
    return { id, p }
  }
  const cornerPos = (k: number, l: number, c: number): Vec2 => {
    const ck = c === 1 || c === 2 ? k + 1 : k
    const cl = c === 2 || c === 3 ? l + 1 : l
    return { x: f.x0 + ck * f.rx, z: f.z0 + cl * f.rz }
  }
  const cornerInside = (k: number, l: number, c: number) => inside(c === 1 || c === 2 ? k + 1 : k, c === 2 || c === 3 ? l + 1 : l)

  for (let l = 0; l < nz - 1; l++) {
    for (let k = 0; k < nx - 1; k++) {
      const idx = (inside(k, l) ? 1 : 0) | (inside(k + 1, l) ? 2 : 0) | (inside(k + 1, l + 1) ? 4 : 0) | (inside(k, l + 1) ? 8 : 0)
      if (idx === 0 || idx === 15) continue
      let pairs = CASES[idx]
      if (idx === 5 || idx === 10) {
        const centre = (val(k, l) + val(k + 1, l) + val(k + 1, l + 1) + val(k, l + 1)) / 4 >= threshold
        // Centre inside: the inside region joins through the centre, cutting off the outside corners.
        if (idx === 5) pairs = centre ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]]
        else pairs = centre ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]]
      }
      for (const [ea, eb] of pairs) {
        let A = edgePoint(k, l, ea)
        let B = edgePoint(k, l, eb)
        const c = sharedCorner(ea, eb)
        const probe = c >= 0 ? c : 0
        const C = cornerPos(k, l, probe)
        const cross = (B.p.x - A.p.x) * (C.z - A.p.z) - (B.p.z - A.p.z) * (C.x - A.p.x)
        // Orient so the inside is on the left (cross > 0 for an inside probe corner).
        if ((cross > 0) !== cornerInside(k, l, probe)) [A, B] = [B, A]
        next.set(A.id, B.id)
        point.set(A.id, A.p)
        point.set(B.id, B.p)
      }
    }
  }

  const rings: Vec2[][] = []
  const visited = new Set<number>()
  for (const start of next.keys()) {
    if (visited.has(start)) continue
    const ring: Vec2[] = []
    let cur: number | undefined = start
    while (cur !== undefined && !visited.has(cur)) {
      visited.add(cur)
      ring.push(point.get(cur)!)
      cur = next.get(cur)
    }
    if (ring.length >= 3) rings.push(ring)
  }
  return rings
}

/** Signed area of a closed ring in the (x, z) plane (positive = counter-clockwise). */
export function ringArea(ring: readonly Vec2[]): number {
  let a = 0
  for (let k = 0, n = ring.length; k < n; k++) {
    const p = ring[k]
    const q = ring[(k + 1) % n]
    a += p.x * q.z - q.x * p.z
  }
  return a / 2
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len2 = dx * dx + dz * dz
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t))
}

/** Douglas–Peucker on points[i0..i1] (indices into `pts`); returns the kept indices in order. */
function douglasPeucker(pts: readonly Vec2[], idx: readonly number[], tolerance: number): number[] {
  if (idx.length <= 2) return idx.slice()
  const keep = new Uint8Array(idx.length)
  keep[0] = 1
  keep[idx.length - 1] = 1
  const stack: [number, number][] = [[0, idx.length - 1]]
  while (stack.length > 0) {
    const [i0, i1] = stack.pop()!
    let worst = -1
    let dmax = tolerance
    for (let k = i0 + 1; k < i1; k++) {
      const d = pointSegmentDistance(pts[idx[k]], pts[idx[i0]], pts[idx[i1]])
      if (d > dmax) {
        dmax = d
        worst = k
      }
    }
    if (worst >= 0) {
      keep[worst] = 1
      stack.push([i0, worst], [worst, i1])
    }
  }
  return idx.filter((_, k) => keep[k])
}

/** Douglas–Peucker on an open polyline (keeps both ends). */
export function simplifyPolyline(pts: readonly Vec2[], tolerance: number): Vec2[] {
  return douglasPeucker(
    pts,
    pts.map((_, k) => k),
    tolerance
  ).map((k) => pts[k])
}

/** Indices (in ring order) of the vertices Douglas–Peucker keeps on a closed ring. */
function simplifyRingIndices(ring: readonly Vec2[], tolerance: number): number[] {
  const n = ring.length
  if (n <= 3) return ring.map((_, k) => k)
  // Anchor 1: the lowest-x (then lowest-z) point; anchor 2: the point farthest from it.
  let a = 0
  for (let k = 1; k < n; k++) if (ring[k].x < ring[a].x || (ring[k].x === ring[a].x && ring[k].z < ring[a].z)) a = k
  let b = a
  let best = -1
  for (let k = 0; k < n; k++) {
    const d = Math.hypot(ring[k].x - ring[a].x, ring[k].z - ring[a].z)
    if (d > best) {
      best = d
      b = k
    }
  }
  const walk = (from: number, to: number) => {
    const out: number[] = []
    for (let k = from; ; k = (k + 1) % n) {
      out.push(k)
      if (k === to) break
    }
    return out
  }
  const first = douglasPeucker(ring, walk(a, b), tolerance)
  const second = douglasPeucker(ring, walk(b, a), tolerance)
  return [...first, ...second.slice(1, -1)]
}

/** Douglas–Peucker on a closed ring (split at the leftmost point and the point farthest from it). */
export function simplifyRing(ring: readonly Vec2[], tolerance: number): Vec2[] {
  return simplifyRingIndices(ring, tolerance).map((k) => ring[k])
}

/** Total-least-squares line through points (centroid + principal direction); null if degenerate. */
function fitLine(pts: readonly Vec2[]): { p: Vec2; d: Vec2 } | null {
  if (pts.length < 2) return null
  let cx = 0
  let cz = 0
  for (const p of pts) {
    cx += p.x
    cz += p.z
  }
  cx /= pts.length
  cz /= pts.length
  let sxx = 0
  let sxz = 0
  let szz = 0
  for (const p of pts) {
    const dx = p.x - cx
    const dz = p.z - cz
    sxx += dx * dx
    sxz += dx * dz
    szz += dz * dz
  }
  if (sxx + szz <= 1e-12) return null
  const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz)
  return { p: { x: cx, z: cz }, d: { x: Math.cos(angle), z: Math.sin(angle) } }
}

/**
 * Snap simplified vertices to corners: each simplified edge gets a line fitted to the raw contour
 * points it replaced (minus the ones next to its ends, which the contour rounds off), and each vertex
 * moves to the intersection of its two edges' lines when that is within `maxShift`.
 */
function refineCorners(raw: readonly Vec2[], idx: readonly number[], maxShift: number): Vec2[] {
  const n = raw.length
  const m = idx.length
  if (m < 3) return idx.map((k) => raw[k])
  const lines: ({ p: Vec2; d: Vec2 } | null)[] = []
  for (let e = 0; e < m; e++) {
    const from = idx[e]
    const to = idx[(e + 1) % m]
    const chain: Vec2[] = []
    for (let k = from; ; k = (k + 1) % n) {
      chain.push(raw[k])
      if (k === to) break
    }
    lines.push(fitLine(chain.length > 4 ? chain.slice(1, -1) : chain))
  }
  return idx.map((k, e) => {
    const v = raw[k]
    const l0 = lines[(e - 1 + m) % m]
    const l1 = lines[e]
    if (!l0 || !l1) return v
    const x = lineIntersection(l0.p, { x: l0.p.x + l0.d.x, z: l0.p.z + l0.d.z }, l1.p, { x: l1.p.x + l1.d.x, z: l1.p.z + l1.d.z })
    return x && Math.hypot(x.x - v.x, x.z - v.z) <= maxShift ? x : v
  })
}

/** Intersection of the infinite lines a1–a2 and b1–b2 (null when nearly parallel). */
function lineIntersection(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const dax = a2.x - a1.x
  const daz = a2.z - a1.z
  const dbx = b2.x - b1.x
  const dbz = b2.z - b1.z
  const den = dax * dbz - daz * dbx
  const la = Math.hypot(dax, daz)
  const lb = Math.hypot(dbx, dbz)
  if (!(la > 0 && lb > 0) || Math.abs(den) < 0.05 * la * lb) return null
  const t = ((b1.x - a1.x) * dbz - (b1.z - a1.z) * dbx) / den
  return { x: a1.x + dax * t, z: a1.z + daz * t }
}

/**
 * Remove edges shorter than `minLength` (keeps at least 3 vertices). A short edge between two longer
 * ones is usually a corner the contour cut: its neighbours are extended to meet (restoring the sharp
 * corner) when they intersect close by; otherwise the endpoint whose removal changes the outline least
 * is dropped.
 */
function dropShortEdges(ring: Vec2[], minLength: number, tolerance: number): Vec2[] {
  const out = ring.slice()
  let changed = true
  while (changed && out.length > 3) {
    changed = false
    for (let k = 0; k < out.length && out.length > 3; k++) {
      const n = out.length
      const p = out[k]
      const q = out[(k + 1) % n]
      const len = Math.hypot(q.x - p.x, q.z - p.z)
      if (len >= minLength) continue
      const prev = out[(k - 1 + n) % n]
      const nxt = out[(k + 2) % n]
      const x = n > 4 ? lineIntersection(prev, p, q, nxt) : null
      if (x && Math.hypot(x.x - (p.x + q.x) / 2, x.z - (p.z + q.z) / 2) <= Math.max(len, tolerance) * 1.5) {
        out[k] = x
        out.splice((k + 1) % n, 1)
      } else {
        const dp = pointSegmentDistance(p, prev, q)
        const dq = pointSegmentDistance(q, p, nxt)
        out.splice(dp <= dq ? k : (k + 1) % n, 1)
      }
      changed = true
    }
  }
  return out
}

const round3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000
  return r === 0 ? 0 : r
}

/**
 * Simplified closed rings of the alpha boundary (world feet), tiny loops dropped. Each consecutive
 * pair of vertices (and last → first) is one wall.
 */
export function traceAlphaOutlines(img: TraceImage, calib: TraceCalibration, opts: WallTraceOptions = {}): Vec2[][] {
  const tolerance = opts.tolerance ?? 0.75
  const minLength = opts.minLength ?? 1
  const minArea = opts.minArea ?? (calib.cellSize / 2) ** 2
  const out: Vec2[][] = []
  for (const raw of alphaContours(img, calib, opts)) {
    if (Math.abs(ringArea(raw)) < minArea) continue
    let ring = refineCorners(raw, simplifyRingIndices(raw, tolerance), tolerance)
    ring = dropShortEdges(ring, minLength, tolerance)
    ring = simplifyRing(ring, tolerance)
    // Rounding keeps shared endpoints bit-identical, so every corner forms a wall joint.
    ring = ring.map((p) => ({ x: round3(p.x), z: round3(p.z) }))
    const dedup: Vec2[] = []
    for (const p of ring) {
      const last = dedup[dedup.length - 1]
      if (!last || last.x !== p.x || last.z !== p.z) dedup.push(p)
    }
    while (dedup.length > 1 && dedup[0].x === dedup[dedup.length - 1].x && dedup[0].z === dedup[dedup.length - 1].z) dedup.pop()
    if (dedup.length < 3 || Math.abs(ringArea(dedup)) < minArea) continue
    out.push(dedup)
  }
  return out
}

/** Wall segments along the image's alpha boundary (see traceAlphaOutlines). */
export function wallsFromAlpha(img: TraceImage, calib: TraceCalibration, opts: WallTraceOptions = {}): TracedSegment[] {
  const segs: TracedSegment[] = []
  for (const ring of traceAlphaOutlines(img, calib, opts)) {
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k]
      const b = ring[(k + 1) % ring.length]
      // The scene schema's minimum wall length.
      if (Math.hypot(b.x - a.x, b.z - a.z) < 0.01) continue
      segs.push({ a: { x: a.x, z: a.z }, b: { x: b.x, z: b.z } })
    }
  }
  return segs
}

// ---------------------------------------------------------------------------
// Scene objects
// ---------------------------------------------------------------------------

/** A floor object for a traced mask (a full mask becomes a plain rect floor). */
export function floorObjectFromTrace(levelId: Id, traced: Pick<TracedFloor, "rect" | "mask" | "fill">, partial: { material?: MaterialId; thickness?: number } = {}): FloorObject {
  const floor = createFloor(levelId, { ...traced.rect }, partial.material ?? "stone")
  if (traced.fill < 1) floor.mask = { ...traced.mask }
  if (partial.thickness !== undefined) floor.thickness = partial.thickness
  return floor
}

/** Wall objects for traced segments. */
export function wallObjectsFromSegments(levelId: Id, segs: readonly TracedSegment[], partial: { height?: number; thickness?: number; material?: MaterialId } = {}): WallObject[] {
  const extra: Partial<WallObject> = { material: partial.material ?? "stone" }
  if (partial.height !== undefined) extra.height = partial.height
  if (partial.thickness !== undefined) extra.thickness = partial.thickness
  return segs.map((s) => createWall(levelId, { ...s.a }, { ...s.b }, extra))
}

/** floorMaskFromAlpha → FloorObject (null when nothing is opaque). */
export function floorObjectFromAlpha(levelId: Id, img: TraceImage, calib: TraceCalibration, opts: FloorMaskOptions & { material?: MaterialId } = {}): FloorObject | null {
  const traced = floorMaskFromAlpha(img, calib, opts)
  return traced ? floorObjectFromTrace(levelId, traced, { material: opts.material }) : null
}

/** wallsFromAlpha → WallObjects (thickness default 1 ft). */
export function wallObjectsFromAlpha(levelId: Id, img: TraceImage, calib: TraceCalibration, opts: WallTraceOptions & { material?: MaterialId } = {}): WallObject[] {
  return wallObjectsFromSegments(levelId, wallsFromAlpha(img, calib, opts), { height: opts.height, thickness: opts.thickness ?? 1, material: opts.material })
}
