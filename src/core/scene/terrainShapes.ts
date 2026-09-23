/**
 * Terrain shapes (ARCHITECTURE §3 "Terrain edits"): editable blocks, ramps and cylinders baked into a
 * level's heightmap. Pure: geometry of shapes and their elements, triangulation, baking, and the single
 * writer that keeps Level.heightmap (baked) and Level.terrainEdits (shapes + painted base) consistent.
 *
 * Invariant (maintained by `writeTerrain`, not checked by the schema): for every heightmap chunk K,
 *   base_K  = decode(terrainEdits.baseChunks[K]) if present ("" = zeros), else decode(heightmap.chunks[K]) (zeros if absent)
 *   baked_K = bake(base_K, shapes)
 *   heightmap.chunks[K] = encode(baked_K) (absent when all zero), and K ∈ baseChunks ⇔ encode(base_K) ≠ encode(baked_K),
 * both in canonical form (−0 → +0, padding samples beyond the grid lattice zeroed). terrainEdits is present
 * exactly when the level has at least one shape.
 *
 * The bake is deterministic (+ − × ÷, sqrt for edge lengths and Math.fround only), so a whole-level rebake
 * reproduces an incrementally written heightmap bit for bit.
 */
import { current, isDraft, type Draft } from "immer"

import {
  chunkKey,
  chunkSamples,
  createHeightmap,
  decodeChunk,
  DEFAULT_TERRAIN_RESOLUTION,
  denseHeights,
  encodeChunk,
  parseChunkKey,
  sampleCounts,
  sampleSpacing,
  writeHeights,
} from "./heightmap"
import { MAX_TERRAIN_HEIGHT, type HeightLattice } from "./heightmapBrush"
import { signedArea } from "./polygon"
import type { GridSettings, Heightmap, Id, Level, Rect, TerrainEdits, TerrainShape, Vec2, Vec3 } from "./types"

/** Element kinds of the advanced (edit) mode. */
export type TerrainElementMode = "vertex" | "edge" | "face"

/**
 * An element of a terrain shape. Vertex k = top vertex k; edge k = top edge (k → k+1 mod n);
 * face "top" = the top surface, face k = the side quad under top edge k. Every element maps to a set
 * of top-vertex indices (see `elementVertexIndices`).
 */
export type TerrainElementRef = { shapeId: Id; kind: "vertex" | "edge"; index: number } | { shapeId: Id; kind: "face"; index: number | "top" }

/** Most footprint vertices a shape may have (SCENE_LIMITS.maxTerrainShapePoints mirrors it). */
export const TERRAIN_SHAPE_MAX_POINTS = 64
/** Smallest canonical signed footprint area (ft²) of a valid shape. */
export const TERRAIN_SHAPE_MIN_AREA = 1e-6
/** Largest bake order (orders are integers in [0, this]). */
export const TERRAIN_SHAPE_MAX_ORDER = 1e6

/** Closed inclusion tolerance of the bake (ft from a triangle edge). */
const INSIDE_EPS = 1e-6
/** Triangles whose doubled area is at most this (ft²) are skipped by the bake and by triangulation. */
const MIN_TRIANGLE_D = 1e-9
/** Vertices closer than this (ft) count as repeated; a vertex this close to a non-adjacent edge touches it. */
const VERTEX_EPS = 1e-6
/** Rect → lattice sample tolerance (ft): samples on a rect's edge are inside it despite rounding. */
const RECT_EPS = 1e-6
/** Growth of shape bounds when mapping them to dirty chunks (≫ INSIDE_EPS, so every sample a bake may write is covered). */
const DIRTY_MARGIN = 1e-3

type XZ = { readonly x: number; readonly z: number }

/** A level's terrain fields (what the terrain functions read and write). */
export type TerrainLevel = Pick<Level, "heightmap" | "terrainEdits">

/** New terrain fields of a level (level-wide operations return them; `terrainEdits` absent = no shapes). */
export interface TerrainResult {
  heightmap: Heightmap | null
  terrainEdits?: TerrainEdits
}

/** A delta for `writeTerrain`. */
export interface TerrainEdit {
  /** Shapes to add or replace (by id). Every one must be valid (`isValidTerrainShape`). */
  upsert?: readonly TerrainShape[]
  /** Shape ids to delete (applied before `upsert`; unknown ids are ignored). */
  remove?: readonly Id[]
  /** New painted terrain: `lattice` is authoritative only for the samples inside `rects` (closed). */
  base?: { lattice: HeightLattice; rects: readonly Rect[] }
  /** Extra regions to recompute ("all": the whole lattice). */
  rebake?: readonly Rect[] | "all"
}

// ---------------------------------------------------------------------------
// Polygons
// ---------------------------------------------------------------------------

/** Σ(x_k·z_{k+1} − x_{k+1}·z_k)/2 over the closed footprint (canonical shapes: > 0). Shared with the scene schema. */
export { signedArea }

/** Squared distance from p to segment a–b. */
function distSeg2(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const ex = bx - ax
  const ez = bz - az
  const len2 = ex * ex + ez * ez
  let t = len2 > 0 ? ((px - ax) * ex + (pz - az) * ez) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const dx = ax + t * ex - px
  const dz = az + t * ez - pz
  return dx * dx + dz * dz
}

const orient = (a: XZ, b: XZ, c: XZ) => (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)

/**
 * A simple polygon of either orientation: ≥ 3 finite vertices, no two within VERTEX_EPS, no edge crossing
 * or touching a non-adjacent edge, no fold-back between adjacent edges, |area| > TERRAIN_SHAPE_MIN_AREA.
 * Straight (180°) vertices are allowed.
 */
export function isSimplePolygon(points: readonly XZ[]): boolean {
  const n = points.length
  if (n < 3) return false
  for (const p of points) if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return false
  if (!(Math.abs(signedArea(points)) > TERRAIN_SHAPE_MIN_AREA)) return false
  const eps2 = VERTEX_EPS * VERTEX_EPS
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = points[i].x - points[j].x
      const dz = points[i].z - points[j].z
      if (dx * dx + dz * dz <= eps2) return false
    }
  }
  for (let i = 0; i < n; i++) {
    const a = points[i]
    const b = points[(i + 1) % n]
    for (let j = i + 1; j < n; j++) {
      const c = points[j]
      const d = points[(j + 1) % n]
      if (j === i + 1) {
        // Edges a→b and b(=c)→d: folding back means d lies on a–b or a lies on b–d.
        if (distSeg2(d.x, d.z, a.x, a.z, b.x, b.z) <= eps2 || distSeg2(a.x, a.z, c.x, c.z, d.x, d.z) <= eps2) return false
        continue
      }
      if (i === 0 && j === n - 1) {
        // Edges c→a (d = a) and a→b share a.
        if (distSeg2(c.x, c.z, a.x, a.z, b.x, b.z) <= eps2 || distSeg2(b.x, b.z, c.x, c.z, a.x, a.z) <= eps2) return false
        continue
      }
      const o1 = orient(a, b, c)
      const o2 = orient(a, b, d)
      const o3 = orient(c, d, a)
      const o4 = orient(c, d, b)
      if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return false
      if (
        distSeg2(c.x, c.z, a.x, a.z, b.x, b.z) <= eps2 ||
        distSeg2(d.x, d.z, a.x, a.z, b.x, b.z) <= eps2 ||
        distSeg2(a.x, a.z, c.x, c.z, d.x, d.z) <= eps2 ||
        distSeg2(b.x, b.z, c.x, c.z, d.x, d.z) <= eps2
      ) {
        return false
      }
    }
  }
  return true
}

/** Copy of the points in canonical orientation (reversed when the signed area is negative). For factories. */
export function canonicalize(points: readonly Vec3[]): Vec3[] {
  const out = points.map((p) => ({ x: p.x, y: p.y, z: p.z }))
  return signedArea(out) < 0 ? out.reverse() : out
}

/**
 * Ear-clipping triangulation of a footprint: index triples (a, b, c) with cross(b − a, c − a) > 1e-9 in
 * (x, z), whatever the input orientation. Robust for degenerate input: zero-area ears (collinear or
 * repeated vertices) are dropped without a triangle, an ear is clipped only when no remaining edge
 * reaches into it (preferring ears with no other vertex within VERTEX_EPS of their diagonal, so a
 * simple footprint is always covered whole), and when clipping stalls (non-simple input) the triangles
 * found so far are returned (never a fan covering area outside the polygon). Non-finite or zero-area
 * input gives [].
 */
export function triangulateFootprint(points: readonly XZ[]): number[] {
  const out: number[] = []
  const n = points.length
  if (n < 3) return out
  for (const p of points) if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) return out
  const area = signedArea(points)
  if (!(Math.abs(area) > 0)) return out
  const sign = area > 0 ? 1 : -1
  const idx: number[] = []
  for (let k = 0; k < n; k++) idx.push(k)
  const d = (a: number, b: number, c: number) => sign * orient(points[a], points[b], points[c])
  // Does segment p–q meet the open interior of the ear A, B, C (sign-adjusted positive)? Separating axes:
  // the ear's edge lines (touching counts as separated) and the segment's own line.
  const enters = (A: XZ, B: XZ, C: XZ, p: XZ, q: XZ) => {
    if (sign * orient(A, B, p) <= 0 && sign * orient(A, B, q) <= 0) return false
    if (sign * orient(B, C, p) <= 0 && sign * orient(B, C, q) <= 0) return false
    if (sign * orient(C, A, p) <= 0 && sign * orient(C, A, q) <= 0) return false
    const oA = orient(p, q, A)
    const oB = orient(p, q, B)
    const oC = orient(p, q, C)
    return !((oA >= 0 && oB >= 0 && oC >= 0) || (oA <= 0 && oB <= 0 && oC <= 0))
  }
  // Does segment p–q run along the ear edge A–B (collinear, overlapping by a positive length)? The
  // polygon then has zero width there (a slit or spike), and the ear side is not reliably inside.
  const overlaps = (A: XZ, B: XZ, p: XZ, q: XZ) => {
    if (orient(A, B, p) !== 0 || orient(A, B, q) !== 0) return false
    const ex = B.x - A.x
    const ez = B.z - A.z
    const l2 = ex * ex + ez * ez
    if (!(l2 > 0)) return false
    const tp = ((p.x - A.x) * ex + (p.z - A.z) * ez) / l2
    const tq = ((q.x - A.x) * ex + (q.z - A.z) * ez) / l2
    return Math.min(Math.max(tp, tq), 1) - Math.max(Math.min(tp, tq), 0) > 1e-9
  }
  const eps2 = VERTEX_EPS * VERTEX_EPS
  const near = (p: XZ, q: XZ) => (p.x - q.x) * (p.x - q.x) + (p.z - q.z) * (p.z - q.z) <= eps2
  // Does p lie on the new diagonal C–A (within VERTEX_EPS) away from its ends? Then C–A is not a proper
  // diagonal: clipping the ear would leave a remainder that touches itself at p, where clipping can stall.
  const onDiagonal = (A: XZ, C: XZ, p: XZ) => !near(p, A) && !near(p, C) && distSeg2(p.x, p.z, C.x, C.z, A.x, A.z) <= eps2
  // An ear is clipped only when no other remaining edge reaches into it or runs along its sides and, when
  // `strict`, no other remaining vertex lies on its diagonal. Testing edges rather than vertices keeps
  // repeated positions (a chain touching the ear's corner) and diagonal-touching vertices correct.
  const blocked = (at: number, strict: boolean) => {
    const m = idx.length
    const A = points[idx[(at + m - 1) % m]]
    const B = points[idx[at]]
    const C = points[idx[(at + 1) % m]]
    for (let k = 0; k < m; k++) {
      if (k === (at + m - 1) % m || k === at) continue
      const p = points[idx[k]]
      const q = points[idx[(k + 1) % m]]
      if (enters(A, B, C, p, q) || overlaps(A, B, p, q) || overlaps(B, C, p, q)) return true
      if (strict && k !== (at + 1) % m && onDiagonal(A, C, p)) return true
    }
    return false
  }
  // Doubled signed area (sign-adjusted) of the polygon still to triangulate: a valid ear never exceeds
  // it, and nothing is left once it vanishes (degenerate remainders of non-simple input).
  const remaining = () => {
    let s = 0
    for (let k = 0, m = idx.length; k < m; k++) {
      const p = points[idx[k]]
      const q = points[idx[(k + 1) % m]]
      s += p.x * q.z - q.x * p.z
    }
    return sign * s
  }
  let start = 0
  while (idx.length >= 3) {
    const left = remaining()
    if (!(left > MIN_TRIANGLE_D)) return out
    if (idx.length === 3) {
      if (d(idx[0], idx[1], idx[2]) > MIN_TRIANGLE_D) {
        if (sign > 0) out.push(idx[0], idx[1], idx[2])
        else out.push(idx[0], idx[2], idx[1])
      }
      return out
    }
    const m = idx.length
    let clipped = false
    // Proper diagonals first; an ear whose diagonal touches another vertex only when no other ear is left.
    for (let pass = 0; pass < 2 && !clipped; pass++) {
      for (let step = 0; step < m; step++) {
        const at = (start + step) % m
        const a = idx[(at + m - 1) % m]
        const b = idx[at]
        const c = idx[(at + 1) % m]
        const e = d(a, b, c)
        if (e <= MIN_TRIANGLE_D && e >= -MIN_TRIANGLE_D) {
          // Zero-area ear: removing b changes the covered region by nothing (straight, spike or repeat).
          idx.splice(at, 1)
        } else if (e < 0 || e > left * (1 + 1e-9) + MIN_TRIANGLE_D || blocked(at, pass === 0)) {
          continue
        } else {
          if (sign > 0) out.push(a, b, c)
          else out.push(a, c, b)
          idx.splice(at, 1)
        }
        start = (at + idx.length - 1) % idx.length
        clipped = true
        break
      }
    }
    if (!clipped) return out
  }
  return out
}

// ---------------------------------------------------------------------------
// Per-shape geometry cache
// ---------------------------------------------------------------------------

/** Floats per prepared triangle: a(x, z, y) b(x, z, y) c(x, z, y), edge tolerances tA tB tC, bbox (minX maxX minZ maxZ). */
const TRI_STRIDE = 16

interface ShapeGeometry {
  tris: number[]
  /** Bounding box of the (finite) footprint; null without finite points. */
  bounds: Rect | null
  /** Triangles with doubled area > MIN_TRIANGLE_D, packed (TRI_STRIDE floats each). */
  prepared: Float64Array
}

// Keyed by shape object identity: shapes are treated as immutable (document shapes are frozen).
const geometryCache = new WeakMap<TerrainShape, ShapeGeometry>()

function shapeGeometry(shape: TerrainShape): ShapeGeometry {
  const hit = geometryCache.get(shape)
  if (hit) return hit
  const pts = shape.points
  const tris = triangulateFootprint(pts)
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.z)) continue
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.z < minZ) minZ = p.z
    if (p.z > maxZ) maxZ = p.z
  }
  const bounds = minX <= maxX ? { x: minX, z: minZ, w: maxX - minX, d: maxZ - minZ } : null
  const packed: number[] = []
  for (let t = 0; t < tris.length; t += 3) {
    const a = pts[tris[t]]
    const b = pts[tris[t + 1]]
    const c = pts[tris[t + 2]]
    const d = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
    if (!(d > MIN_TRIANGLE_D)) continue
    const lenA = Math.sqrt((c.x - b.x) * (c.x - b.x) + (c.z - b.z) * (c.z - b.z))
    const lenB = Math.sqrt((a.x - c.x) * (a.x - c.x) + (a.z - c.z) * (a.z - c.z))
    const lenC = Math.sqrt((b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z))
    packed.push(
      a.x,
      a.z,
      a.y,
      b.x,
      b.z,
      b.y,
      c.x,
      c.z,
      c.y,
      -INSIDE_EPS * lenA,
      -INSIDE_EPS * lenB,
      -INSIDE_EPS * lenC,
      Math.min(a.x, b.x, c.x) - INSIDE_EPS,
      Math.max(a.x, b.x, c.x) + INSIDE_EPS,
      Math.min(a.z, b.z, c.z) - INSIDE_EPS,
      Math.max(a.z, b.z, c.z) + INSIDE_EPS
    )
  }
  const geom = { tris, bounds, prepared: Float64Array.from(packed) }
  geometryCache.set(shape, geom)
  return geom
}

/**
 * Height of prepared triangle `o` at (px, pz), or NaN when the point is outside it. Inside iff every edge
 * function eᵢ ≥ −INSIDE_EPS·|edgeᵢ| (closed, slightly grown); v = Σ λᵢ·yᵢ with λᵢ = max(0, eᵢ)/Σ max(0, eⱼ).
 * THE bake arithmetic: `shapeTopAt` and the rasteriser both call it.
 */
function triangleValue(p: Float64Array, o: number, px: number, pz: number): number {
  const ax = p[o]
  const az = p[o + 1]
  const bx = p[o + 3]
  const bz = p[o + 4]
  const cx = p[o + 6]
  const cz = p[o + 7]
  const eA = (cx - bx) * (pz - bz) - (cz - bz) * (px - bx)
  if (eA < p[o + 9]) return NaN
  const eB = (ax - cx) * (pz - cz) - (az - cz) * (px - cx)
  if (eB < p[o + 10]) return NaN
  const eC = (bx - ax) * (pz - az) - (bz - az) * (px - ax)
  if (eC < p[o + 11]) return NaN
  const wA = eA > 0 ? eA : 0
  const wB = eB > 0 ? eB : 0
  const wC = eC > 0 ? eC : 0
  const sum = wA + wB + wC
  return (wA / sum) * p[o + 2] + (wB / sum) * p[o + 5] + (wC / sum) * p[o + 8]
}

/** Canonical stored height: finite, clamped to ±MAX_TERRAIN_HEIGHT, float32, +0 for zero. */
function canonicalHeight(v: number): number {
  if (!(v === v) || v === 0) return 0
  const c = Math.fround(v > MAX_TERRAIN_HEIGHT ? MAX_TERRAIN_HEIGHT : v < -MAX_TERRAIN_HEIGHT ? -MAX_TERRAIN_HEIGHT : v)
  return c === 0 ? 0 : c
}

/** Bounding box of a shape's footprint (x, z world feet). */
export function shapeBounds(shape: TerrainShape): Rect {
  const b = shapeGeometry(shape).bounds
  return b ? { ...b } : { x: 0, z: 0, w: 0, d: 0 }
}

/**
 * The shape's top (feet, relative to the level elevation) at world (x, z) by the bake's rule: over the
 * top triangles containing the point, the max ("add") or min ("carve"); null outside the footprint.
 */
export function shapeTopAt(shape: TerrainShape, x: number, z: number): number | null {
  const p = shapeGeometry(shape).prepared
  const carve = shape.op === "carve"
  let best: number | null = null
  for (let o = 0; o < p.length; o += TRI_STRIDE) {
    const v = triangleValue(p, o, x, z)
    if (!Number.isFinite(v)) continue
    if (best === null || (carve ? v < best : v > best)) best = v
  }
  return best
}

/**
 * Lattice samples covered by the shape (by the bake's inclusion rule) on the unbounded lattice of the
 * given spacing, counting up to `limit`. The inspector warns about shapes with fewer than ~4 (they bake
 * to a spike or to nothing).
 */
export function countShapeSamples(shape: TerrainShape, spacing: number, limit = Infinity): number {
  if (!(spacing > 0)) return 0
  const p = shapeGeometry(shape).prepared
  const seen = new Set<string>()
  for (let o = 0; o < p.length; o += TRI_STRIDE) {
    const sx0 = Math.ceil(p[o + 12] / spacing)
    const sx1 = Math.floor(p[o + 13] / spacing)
    const sz0 = Math.ceil(p[o + 14] / spacing)
    const sz1 = Math.floor(p[o + 15] / spacing)
    for (let sz = sz0; sz <= sz1; sz++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        if (!Number.isFinite(triangleValue(p, o, sx * spacing, sz * spacing))) continue
        seen.add(`${sx},${sz}`)
        if (seen.size >= limit) return seen.size
      }
    }
  }
  return seen.size
}

// ---------------------------------------------------------------------------
// Baking
// ---------------------------------------------------------------------------

/** Inclusive lattice sample window. */
export interface LatticeWindow {
  sx0: number
  sx1: number
  sz0: number
  sz1: number
}

/** Samples within `rect` grown by `grow` feet (closed), clipped to the lattice; null when empty. */
function rectWindow(rect: Rect, grow: number, spacing: number, samplesX: number, samplesZ: number): LatticeWindow | null {
  const x0 = Math.min(rect.x, rect.x + rect.w) - grow
  const x1 = Math.max(rect.x, rect.x + rect.w) + grow
  const z0 = Math.min(rect.z, rect.z + rect.d) - grow
  const z1 = Math.max(rect.z, rect.z + rect.d) + grow
  if (!Number.isFinite(x0) || !Number.isFinite(x1) || !Number.isFinite(z0) || !Number.isFinite(z1)) return null
  const w = {
    sx0: Math.max(0, Math.ceil(x0 / spacing)),
    sx1: Math.min(samplesX - 1, Math.floor(x1 / spacing)),
    sz0: Math.max(0, Math.ceil(z0 / spacing)),
    sz1: Math.min(samplesZ - 1, Math.floor(z1 / spacing)),
  }
  return w.sx0 <= w.sx1 && w.sz0 <= w.sz1 ? w : null
}

/** Lattice samples inside `rect` (closed, tolerant to rounding) as an inclusive index window; null when none. */
export function latticeWindow(lattice: Pick<HeightLattice, "samplesX" | "samplesZ" | "spacing">, rect: Rect): LatticeWindow | null {
  return rectWindow(rect, RECT_EPS, lattice.spacing, lattice.samplesX, lattice.samplesZ)
}

/** Bake order: ascending (order, id). */
export function compareShapeOrder(a: TerrainShape, b: TerrainShape): number {
  if (a.order !== b.order) return a.order - b.order
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Apply `shapes` (already in bake order) to the samples of window `win` of a target array where lattice
 * sample (sx, sz) lives at target[(sz − oz)·stride + (sx − ox)]. Per triangle: visit the samples of its
 * grown bounding box ∩ win; add → max, carve → min; non-finite values skipped; results canonical.
 */
function bakeInto(target: Float32Array, stride: number, ox: number, oz: number, win: LatticeWindow, spacing: number, shapes: readonly TerrainShape[]): void {
  for (const shape of shapes) {
    const p = shapeGeometry(shape).prepared
    const carve = shape.op === "carve"
    for (let o = 0; o < p.length; o += TRI_STRIDE) {
      const sx0 = Math.max(win.sx0, Math.ceil(p[o + 12] / spacing))
      const sx1 = Math.min(win.sx1, Math.floor(p[o + 13] / spacing))
      if (sx0 > sx1) continue
      const sz0 = Math.max(win.sz0, Math.ceil(p[o + 14] / spacing))
      const sz1 = Math.min(win.sz1, Math.floor(p[o + 15] / spacing))
      for (let sz = sz0; sz <= sz1; sz++) {
        const pz = sz * spacing
        const row = (sz - oz) * stride - ox
        for (let sx = sx0; sx <= sx1; sx++) {
          const v = triangleValue(p, o, sx * spacing, pz)
          if (!Number.isFinite(v)) continue
          const k = row + sx
          const cur = target[k]
          const next = carve ? (v < cur ? v : cur) : v > cur ? v : cur
          if (next !== cur) target[k] = canonicalHeight(next)
        }
      }
    }
  }
}

/**
 * Bake `shapes` (any order; applied in ascending (order, id)) into `lattice` in place, over the samples
 * inside `rect` (closed; null = the whole lattice). The lattice must hold the painted base there.
 */
export function bakeRegion(lattice: HeightLattice, shapes: readonly TerrainShape[], rect: Rect | null): void {
  const { samplesX, samplesZ, spacing } = lattice
  if (samplesX < 1 || samplesZ < 1 || !(spacing > 0) || shapes.length === 0) return
  const win = rect ? latticeWindow(lattice, rect) : { sx0: 0, sx1: samplesX - 1, sz0: 0, sz1: samplesZ - 1 }
  if (!win) return
  bakeInto(lattice.heights, samplesX, 0, 0, win, spacing, [...shapes].sort(compareShapeOrder))
}

/** The dense painted terrain ("base") of a level: fresh arrays at the heightmap's resolution (default when none). */
export function baseLattice(level: TerrainLevel, grid: Pick<GridSettings, "width" | "depth" | "cellSize">): HeightLattice {
  const res = level.heightmap?.resolution ?? DEFAULT_TERRAIN_RESOLUTION
  const spacing = sampleSpacing(grid.cellSize, res)
  if (!level.heightmap) {
    const { samplesX, samplesZ } = sampleCounts(grid, res)
    return { samplesX, samplesZ, heights: new Float32Array(samplesX * samplesZ), spacing }
  }
  const { samplesX, samplesZ, heights } = denseHeights(level.heightmap, grid)
  const baseChunks = level.terrainEdits?.baseChunks
  if (baseChunks) {
    const n = chunkSamples(res)
    for (const key of Object.keys(baseChunks)) {
      const { ci, cj } = parseChunkKey(key)
      if (!Number.isInteger(ci) || !Number.isInteger(cj) || ci < 0 || cj < 0) continue
      const b64 = baseChunks[key]
      const src = b64 === "" ? null : decodeChunk(b64, res)
      for (let lz = 0; lz < n; lz++) {
        const sz = cj * n + lz
        if (sz >= samplesZ) break
        for (let lx = 0; lx < n; lx++) {
          const sx = ci * n + lx
          if (sx >= samplesX) break
          heights[sz * samplesX + sx] = src ? src[lz * n + lx] : 0
        }
      }
    }
  }
  return { samplesX, samplesZ, heights, spacing }
}

/**
 * The painted base (not the shapes baked on it) is non-zero somewhere. Decodes nothing: by the invariant
 * (header) a chunk's base is zero exactly when it is stored as "" in baseChunks, or is in neither record.
 */
export function hasPaintedBase(level: TerrainLevel): boolean {
  const hm = level.heightmap
  if (!hm) return false
  const baseChunks = level.terrainEdits?.baseChunks
  if (!baseChunks) return Object.keys(hm.chunks).length > 0
  for (const key of Object.keys(baseChunks)) if (baseChunks[key] !== "") return true
  for (const key of Object.keys(hm.chunks)) if (!Object.hasOwn(baseChunks, key)) return true
  return false
}

// ---------------------------------------------------------------------------
// Shape validity
// ---------------------------------------------------------------------------

// Mirror the scene schema's idSchema and SCENE_LIMITS.maxString (not imported, so the schema stays free to
// import helpers from this module without an evaluation-order cycle).
const SHAPE_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_NAME_LENGTH = 2000
const SHAPE_KINDS: ReadonlySet<string> = new Set(["block", "ramp", "cylinder"])
const SHAPE_OPS: ReadonlySet<string> = new Set(["add", "carve"])

const inHeightRange = (v: number) => Number.isFinite(v) && Math.abs(v) <= MAX_TERRAIN_HEIGHT

/**
 * What `writeTerrain` accepts: what the scene schema requires of a shape (id syntax, name ≤ 2000 chars,
 * 3..TERRAIN_SHAPE_MAX_POINTS finite points, heights and base within ±MAX_TERRAIN_HEIGHT, integer order in
 * [0, TERRAIN_SHAPE_MAX_ORDER], canonical signed area > TERRAIN_SHAPE_MIN_AREA) plus a simple footprint.
 * The grid extent is not checked (the editor's document guard refuses shapes beyond it).
 */
export function isValidTerrainShape(shape: TerrainShape): boolean {
  if (typeof shape.id !== "string" || !SHAPE_ID.test(shape.id) || shape.id === "__proto__") return false
  if (shape.name !== undefined && (typeof shape.name !== "string" || shape.name.length > MAX_NAME_LENGTH)) return false
  if (!SHAPE_KINDS.has(shape.kind) || !SHAPE_OPS.has(shape.op)) return false
  if (!Number.isInteger(shape.order) || shape.order < 0 || shape.order > TERRAIN_SHAPE_MAX_ORDER) return false
  if (!inHeightRange(shape.base)) return false
  const pts = shape.points
  if (!Array.isArray(pts) || pts.length < 3 || pts.length > TERRAIN_SHAPE_MAX_POINTS) return false
  for (const p of pts) if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || !inHeightRange(p.y)) return false
  return signedArea(pts) > TERRAIN_SHAPE_MIN_AREA && isSimplePolygon(pts)
}

function shapesEqual(a: TerrainShape | undefined, b: TerrainShape | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.id !== b.id || a.name !== b.name || a.kind !== b.kind || a.op !== b.op || a.order !== b.order || a.base !== b.base) return false
  if (a.points.length !== b.points.length) return false
  for (let k = 0; k < a.points.length; k++) {
    const p = a.points[k]
    const q = b.points[k]
    if (p.x !== q.x || p.y !== q.y || p.z !== q.z) return false
  }
  return true
}

/** A plain copy with exactly the document fields (no extra keys, no undefined name). */
function normalizeShape(s: TerrainShape): TerrainShape {
  const out: TerrainShape = {
    id: s.id,
    kind: s.kind,
    op: s.op,
    order: s.order,
    points: s.points.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    base: s.base,
  }
  if (s.name !== undefined) out.name = s.name
  return out
}

/** A plain view of a possibly-draft value (unmodified parts keep their identity, so the geometry cache hits). */
const snapshot = <T>(v: T): T => (isDraft(v) ? (current(v as Draft<T>) as T) : v)

// ---------------------------------------------------------------------------
// The single writer
// ---------------------------------------------------------------------------

/** Bitwise equality of two float arrays of equal length. */
function bitsEqual(a: Float32Array, b: Float32Array): boolean {
  const ua = new Uint32Array(a.buffer, a.byteOffset, a.length)
  const ub = new Uint32Array(b.buffer, b.byteOffset, b.length)
  for (let k = 0; k < ua.length; k++) if (ua[k] !== ub[k]) return false
  return true
}

function allZero(a: Float32Array): boolean {
  for (let k = 0; k < a.length; k++) if (a[k] !== 0) return false
  return true
}

/**
 * THE single writer of terrain (Level.heightmap + Level.terrainEdits), in delta form. Reads the current
 * shapes and base from `level` (an immer draft or a plain object it may mutate), applies `edit`, and
 * recomputes the chunks overlapping (old ∪ new bounds of the changed shapes) ∪ base.rects ∪ rebake; writes
 * heightmap.chunks[K] and terrainEdits.baseChunks[K] per the invariant, assigning only strings that
 * change (immer patches stay per chunk) and only shape entries that change; removes terrainEdits when no
 * shapes remain; creates the heightmap at DEFAULT_TERRAIN_RESOLUTION when there is none and something is
 * written. Returns false and writes nothing when `base.lattice` does not match the level's lattice
 * (resolution or grid changed) or an upserted shape is invalid (`isValidTerrainShape`); true otherwise.
 */
export function writeTerrain(level: TerrainLevel, grid: Pick<GridSettings, "width" | "depth" | "cellSize">, edit: TerrainEdit): boolean {
  const res = level.heightmap?.resolution ?? DEFAULT_TERRAIN_RESOLUTION
  const { samplesX, samplesZ } = sampleCounts(grid, res)
  const spacing = sampleSpacing(grid.cellSize, res)
  const lattice = edit.base?.lattice
  if (lattice) {
    if (lattice.samplesX !== samplesX || lattice.samplesZ !== samplesZ || lattice.heights.length !== samplesX * samplesZ) return false
    if (!(Math.abs(lattice.spacing - spacing) <= 1e-9 * spacing)) return false
  }
  for (const s of edit.upsert ?? []) if (!isValidTerrainShape(s)) return false

  // --- Read phase: nothing below writes until the chunk results are known.
  const te = level.terrainEdits
  const oldShapes: Record<Id, TerrainShape> = te ? snapshot(te.shapes) : {}
  const next = new Map<Id, TerrainShape>()
  for (const id of Object.keys(oldShapes)) next.set(id, oldShapes[id])
  const touched = new Set<Id>()
  for (const id of edit.remove ?? []) {
    if (next.delete(id)) touched.add(id)
  }
  for (const s of edit.upsert ?? []) {
    next.set(s.id, s)
    touched.add(s.id)
  }
  const changed: Id[] = []
  for (const id of [...touched].sort()) {
    const before = Object.hasOwn(oldShapes, id) ? oldShapes[id] : undefined
    if (!shapesEqual(before, next.get(id))) changed.push(id)
  }
  for (const id of changed) {
    const s = next.get(id)
    if (s) next.set(id, normalizeShape(s))
  }

  const n = chunkSamples(res)
  const chunksX = Math.floor((samplesX - 1) / n) + 1
  const chunksZ = Math.floor((samplesZ - 1) / n) + 1
  const dirty = new Set<number>()
  const markWindow = (w: LatticeWindow | null) => {
    if (!w) return
    for (let cj = Math.floor(w.sz0 / n); cj <= Math.floor(w.sz1 / n); cj++) {
      for (let ci = Math.floor(w.sx0 / n); ci <= Math.floor(w.sx1 / n); ci++) dirty.add(cj * chunksX + ci)
    }
  }
  const markShape = (s: TerrainShape | undefined) => {
    const b = s ? shapeGeometry(s).bounds : null
    if (b) markWindow(rectWindow(b, DIRTY_MARGIN, spacing, samplesX, samplesZ))
  }
  for (const id of changed) {
    markShape(Object.hasOwn(oldShapes, id) ? oldShapes[id] : undefined)
    markShape(next.get(id))
  }
  const baseWindows: LatticeWindow[] = []
  if (lattice) {
    for (const r of edit.base!.rects) {
      const w = rectWindow(r, RECT_EPS, spacing, samplesX, samplesZ)
      if (w) {
        baseWindows.push(w)
        markWindow(w)
      }
    }
  }
  if (edit.rebake === "all") markWindow({ sx0: 0, sx1: samplesX - 1, sz0: 0, sz1: samplesZ - 1 })
  else for (const r of edit.rebake ?? []) markWindow(rectWindow(r, RECT_EPS, spacing, samplesX, samplesZ))
  const baseChunks = te?.baseChunks
  if (next.size === 0 && baseChunks) {
    // Dropping terrainEdits: every chunk whose base is stored separately must return to the heightmap.
    for (const key of Object.keys(baseChunks)) {
      const { ci, cj } = parseChunkKey(key)
      if (Number.isInteger(ci) && Number.isInteger(cj) && ci >= 0 && cj >= 0 && ci < chunksX && cj < chunksZ) dirty.add(cj * chunksX + ci)
    }
  }

  const hmChunks = level.heightmap?.chunks
  if (!level.heightmap && next.size === 0 && !lattice) {
    // Nothing to write on a level without terrain (terrainEdits there would break the invariant anyway).
    if (level.terrainEdits) delete level.terrainEdits
    return true
  }

  const sorted = [...next.values()].sort(compareShapeOrder)
  const shapeWindows = sorted.map((s) => {
    const b = shapeGeometry(s).bounds
    return b ? rectWindow(b, DIRTY_MARGIN, spacing, samplesX, samplesZ) : null
  })
  const overlaps = (a: LatticeWindow, b: LatticeWindow) => a.sx0 <= b.sx1 && b.sx0 <= a.sx1 && a.sz0 <= b.sz1 && b.sz0 <= a.sz1

  const writes: { key: string; hm: string | undefined; base: string | undefined }[] = []
  for (const id of [...dirty].sort((a, b) => a - b)) {
    const ci = id % chunksX
    const cj = (id - ci) / chunksX
    const key = chunkKey(ci, cj)
    const ox = ci * n
    const oz = cj * n
    const win: LatticeWindow = { sx0: ox, sx1: Math.min(ox + n, samplesX) - 1, sz0: oz, sz1: Math.min(oz + n, samplesZ) - 1 }
    const inBaseChunks = baseChunks !== undefined && Object.hasOwn(baseChunks, key)
    const baseSrc = inBaseChunks ? baseChunks[key] : hmChunks && Object.hasOwn(hmChunks, key) ? hmChunks[key] : ""
    const chunkShapes = sorted.filter((_, k) => shapeWindows[k] !== null && overlaps(shapeWindows[k]!, win))
    const chunkBaseWindows = baseWindows.filter((w) => overlaps(w, win))
    const curHm = hmChunks && Object.hasOwn(hmChunks, key) ? hmChunks[key] : undefined
    if (baseSrc === "" && chunkShapes.length === 0 && chunkBaseWindows.length === 0 && curHm === undefined && !inBaseChunks) continue

    // base_K (a private copy: decodeChunk's arrays are shared), overridden by the lattice inside base.rects.
    const base = baseSrc === "" ? new Float32Array(n * n) : decodeChunk(baseSrc, res).slice()
    for (const w of chunkBaseWindows) {
      for (let sz = Math.max(w.sz0, win.sz0); sz <= Math.min(w.sz1, win.sz1); sz++) {
        for (let sx = Math.max(w.sx0, win.sx0); sx <= Math.min(w.sx1, win.sx1); sx++) base[(sz - oz) * n + (sx - ox)] = lattice!.heights[sz * samplesX + sx]
      }
    }
    // Canonical form: padding beyond the lattice zeroed; −0, NaN and out-of-range values normalised.
    for (let lz = 0; lz < n; lz++) {
      for (let lx = 0; lx < n; lx++) {
        const k = lz * n + lx
        base[k] = ox + lx > win.sx1 || oz + lz > win.sz1 ? 0 : canonicalHeight(base[k])
      }
    }
    const baked = base.slice()
    if (chunkShapes.length > 0) bakeInto(baked, n, ox, oz, win, spacing, chunkShapes)

    const bakedZero = allZero(baked)
    let hmOut: string | undefined
    if (!bakedZero) hmOut = curHm !== undefined && bitsEqual(decodeChunk(curHm, res), baked) ? curHm : encodeChunk(baked)
    let baseOut: string | undefined
    if (!bitsEqual(base, baked)) {
      // Reuse the source string when the base is unchanged (no re-encode, no patch).
      if (allZero(base)) baseOut = ""
      else if (baseSrc !== "" && bitsEqual(decodeChunk(baseSrc, res), base)) baseOut = baseSrc
      else baseOut = encodeChunk(base)
    }
    writes.push({ key, hm: hmOut, base: baseOut })
  }

  // --- Write phase.
  if (!level.heightmap) level.heightmap = createHeightmap(res)
  const hm = level.heightmap
  for (const w of writes) {
    if (w.hm === undefined) {
      if (Object.hasOwn(hm.chunks, w.key)) delete hm.chunks[w.key]
    } else if (hm.chunks[w.key] !== w.hm) hm.chunks[w.key] = w.hm
  }
  if (next.size === 0) {
    if (level.terrainEdits) delete level.terrainEdits
    return true
  }
  if (!level.terrainEdits) level.terrainEdits = { shapes: {}, baseChunks: {} }
  const out = level.terrainEdits
  for (const id of changed) {
    const s = next.get(id)
    if (s) out.shapes[id] = s
    else delete out.shapes[id]
  }
  for (const w of writes) {
    if (w.base === undefined) {
      if (Object.hasOwn(out.baseChunks, w.key)) delete out.baseChunks[w.key]
    } else if (!Object.hasOwn(out.baseChunks, w.key) || out.baseChunks[w.key] !== w.base) out.baseChunks[w.key] = w.base
  }
  return true
}

/** Bake order for the level's next new shape: max order + 1 (0 when it has none). */
export function nextShapeOrder(level: TerrainLevel): number {
  let max = -1
  const shapes = level.terrainEdits?.shapes
  if (shapes) for (const id of Object.keys(shapes)) max = Math.max(max, shapes[id].order)
  return max + 1
}

// ---------------------------------------------------------------------------
// Level-wide operations (return the new terrain fields; the input is not modified)
// ---------------------------------------------------------------------------

function unchanged(level: TerrainLevel): TerrainResult {
  return level.terrainEdits ? { heightmap: level.heightmap, terrainEdits: level.terrainEdits } : { heightmap: level.heightmap }
}

/** Mutable copies of the level's terrain records (shape objects shared, never mutated). */
function workingCopy(level: TerrainLevel): TerrainResult {
  const hm = snapshot(level.heightmap)
  const te = snapshot(level.terrainEdits)
  const out: TerrainResult = { heightmap: hm ? { resolution: hm.resolution, chunks: { ...hm.chunks } } : null }
  if (te) out.terrainEdits = { shapes: { ...te.shapes }, baseChunks: { ...te.baseChunks } }
  return out
}

/** A level whose base is `dense` (the grid's lattice at `res`) with `shapes`, fully baked. */
function rebuild(
  grid: Pick<GridSettings, "width" | "depth" | "cellSize">,
  res: Heightmap["resolution"],
  dense: Float32Array,
  shapes: Record<Id, TerrainShape> | undefined
): TerrainResult {
  const work: TerrainResult = { heightmap: writeHeights(createHeightmap(res), grid, dense) }
  if (shapes && Object.keys(shapes).length > 0) work.terrainEdits = { shapes: { ...shapes }, baseChunks: {} }
  writeTerrain(work, grid, { rebake: "all" })
  return work
}

/** Height of a dense lattice at world (x, z) on the heightmap triangle split; samples beyond the lattice read 0. */
function sampleDense(l: HeightLattice, x: number, z: number): number {
  const fx = x / l.spacing
  const fz = z / l.spacing
  if (fx < 0 || fz < 0) return 0
  const sx = Math.floor(fx)
  const sz = Math.floor(fz)
  const tx = fx - sx
  const tz = fz - sz
  const at = (i: number, j: number) => (i >= l.samplesX || j >= l.samplesZ ? 0 : l.heights[j * l.samplesX + i])
  const h00 = at(sx, sz)
  const h11 = at(sx + 1, sz + 1)
  if (tx >= tz) {
    const h10 = at(sx + 1, sz)
    return h00 + tx * (h10 - h00) + tz * (h11 - h10)
  }
  const h01 = at(sx, sz + 1)
  return h00 + tz * (h01 - h00) + tx * (h11 - h01)
}

/**
 * The level's terrain at another resolution: the BASE is resampled (bilinear on its triangles, like the
 * old levelOps.resampleHeightmap) and the shapes are rebaked at the new resolution (they stay sharp).
 * No heightmap → an empty one at `resolution`. Same resolution → the level's own objects.
 */
export function resampleTerrain(
  level: TerrainLevel,
  grid: Pick<GridSettings, "width" | "depth" | "cellSize">,
  resolution: Heightmap["resolution"]
): TerrainResult {
  const hm = level.heightmap
  if (!hm) return { heightmap: createHeightmap(resolution) }
  if (hm.resolution === resolution) return unchanged(level)
  const src = baseLattice(level, grid)
  const { samplesX, samplesZ } = sampleCounts(grid, resolution)
  const step = sampleSpacing(grid.cellSize, resolution)
  const dense = new Float32Array(samplesX * samplesZ)
  for (let sz = 0; sz < samplesZ; sz++) {
    for (let sx = 0; sx < samplesX; sx++) dense[sz * samplesX + sx] = sampleDense(src, sx * step, sz * step)
  }
  return rebuild(grid, resolution, dense, snapshot(level.terrainEdits)?.shapes)
}

/**
 * The level's terrain on a resized grid: the base (read on `prevGrid`'s lattice) is cropped to / padded
 * with zeros for the new lattice, then everything is rebaked (shapes re-appear where a grown grid
 * exposes them). Unchanged grid (width, depth, cell size) → the level's own objects.
 */
export function cropTerrainToGrid(
  level: TerrainLevel,
  grid: Pick<GridSettings, "width" | "depth" | "cellSize">,
  prevGrid: Pick<GridSettings, "width" | "depth" | "cellSize">
): TerrainResult {
  const hm = level.heightmap
  if (!hm) return { heightmap: null }
  if (grid.width === prevGrid.width && grid.depth === prevGrid.depth && grid.cellSize === prevGrid.cellSize) return unchanged(level)
  const src = baseLattice(level, prevGrid)
  const { samplesX, samplesZ } = sampleCounts(grid, hm.resolution)
  const dense = new Float32Array(samplesX * samplesZ)
  const w = Math.min(samplesX, src.samplesX)
  for (let sz = 0; sz < Math.min(samplesZ, src.samplesZ); sz++) dense.set(src.heights.subarray(sz * src.samplesX, sz * src.samplesX + w), sz * samplesX)
  return rebuild(grid, hm.resolution, dense, snapshot(level.terrainEdits)?.shapes)
}

/** Base := 0 everywhere, shapes kept (and rebaked on the flat ground). No heightmap → unchanged. */
export function flattenTerrain(level: TerrainLevel, grid: Pick<GridSettings, "width" | "depth" | "cellSize">): TerrainResult {
  const hm = level.heightmap
  if (!hm) return unchanged(level)
  const { samplesX, samplesZ } = sampleCounts(grid, hm.resolution)
  return rebuild(grid, hm.resolution, new Float32Array(samplesX * samplesZ), snapshot(level.terrainEdits)?.shapes)
}

/** Delete every shape: the base becomes the heightmap and terrainEdits goes away. */
export function clearTerrainShapes(level: TerrainLevel, grid: Pick<GridSettings, "width" | "depth" | "cellSize">): TerrainResult {
  const te = level.terrainEdits
  if (!level.heightmap || !te) return unchanged(level)
  const work = workingCopy(level)
  writeTerrain(work, grid, { remove: Object.keys(te.shapes) })
  return work
}

/**
 * The shapes "Apply to terrain" bakes for the given ids, in bake order: the named shapes of the level
 * plus, transitively, every shape earlier in bake order whose bounds overlap one of them (the downward
 * closure). Every remaining shape that overlaps an applied one then comes after it, so baking the applied
 * shapes into the base and rebaking the rest on top reproduces the heightmap exactly. [] when no id names
 * a shape of the level.
 */
export function applyShapesClosure(level: TerrainLevel, ids: readonly Id[]): TerrainShape[] {
  const te = snapshot(level.terrainEdits)
  if (!te) return []
  const named = new Set(ids)
  const sorted = Object.values(te.shapes).sort(compareShapeOrder)
  // From the last shape down: every shape after the current one is already decided.
  const out: TerrainShape[] = []
  const bounds: Rect[] = []
  const g = DIRTY_MARGIN // ≫ 2·INSIDE_EPS: shapes whose grown bounds are apart share no baked sample.
  for (let k = sorted.length - 1; k >= 0; k--) {
    const s = sorted[k]
    const b = shapeGeometry(s).bounds
    const under = b !== null && bounds.some((o) => b.x <= o.x + o.w + g && o.x <= b.x + b.w + g && b.z <= o.z + o.d + g && o.z <= b.z + b.d + g)
    if (!named.has(s.id) && !under) continue
    out.push(s)
    if (b) bounds.push(b)
  }
  return out.reverse()
}

/**
 * The delta that bakes the given shapes into the base ("Apply to terrain") and deletes them. Exact (the
 * heightmap does not change): the older shapes under them are applied too (`applyShapesClosure`), so
 * base := bake(base, closure in bake order) inside the closure's bounds and the closure is deleted. For
 * `writeTerrain` on a draft (per-chunk patches); null when no id names a shape of the level.
 */
export function applyShapesEdit(level: TerrainLevel, grid: Pick<GridSettings, "width" | "depth" | "cellSize">, ids: readonly Id[]): TerrainEdit | null {
  if (!level.heightmap) return null
  const sel = applyShapesClosure(level, ids)
  if (sel.length === 0) return null
  const lattice = baseLattice(level, grid)
  bakeRegion(lattice, sel, null)
  const rects = sel.map((s) => {
    const b = shapeBounds(s)
    return { x: b.x - DIRTY_MARGIN, z: b.z - DIRTY_MARGIN, w: b.w + 2 * DIRTY_MARGIN, d: b.d + 2 * DIRTY_MARGIN }
  })
  return { remove: sel.map((s) => s.id), base: { lattice, rects } }
}

/** `applyShapesEdit` as new terrain fields. */
export function applyShapesToBase(level: TerrainLevel, grid: Pick<GridSettings, "width" | "depth" | "cellSize">, ids: readonly Id[]): TerrainResult {
  const edit = applyShapesEdit(level, grid, ids)
  if (!edit) return unchanged(level)
  const work = workingCopy(level)
  writeTerrain(work, grid, edit)
  return work
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function rectCorners(rect: Rect): { x0: number; x1: number; z0: number; z1: number } {
  return {
    x0: Math.min(rect.x, rect.x + rect.w),
    x1: Math.max(rect.x, rect.x + rect.w),
    z0: Math.min(rect.z, rect.z + rect.d),
    z1: Math.max(rect.z, rect.z + rect.d),
  }
}

const opFor = (height: number): TerrainShape["op"] => (height >= 0 ? "add" : "carve")

/** A box over `rect`: top y0 + height, base y0 ("carve" when height < 0). */
export function blockShape(id: Id, rect: Rect, y0: number, height: number, order: number): TerrainShape {
  const { x0, x1, z0, z1 } = rectCorners(rect)
  const top = y0 + height
  return {
    id,
    kind: "block",
    op: opFor(height),
    order,
    points: [
      { x: x0, y: top, z: z0 },
      { x: x1, y: top, z: z0 },
      { x: x1, y: top, z: z1 },
      { x: x0, y: top, z: z1 },
    ],
    base: y0,
  }
}

/**
 * A ramp over `rect` rising in direction `dir` (0 = +Z, 1 = +X, 2 = −Z, 3 = −X, like connectors): the
 * edge opposite `dir` is at y0, the edge at `dir` at y0 + height; base y0.
 */
export function rampShape(id: Id, rect: Rect, dir: 0 | 1 | 2 | 3, y0: number, height: number, order: number): TerrainShape {
  const { x0, x1, z0, z1 } = rectCorners(rect)
  const hi = y0 + height
  // Heights of the corners (x0,z0), (x1,z0), (x1,z1), (x0,z1).
  const ys = dir === 0 ? [y0, y0, hi, hi] : dir === 1 ? [y0, hi, hi, y0] : dir === 2 ? [hi, hi, y0, y0] : [hi, y0, y0, hi]
  return {
    id,
    kind: "ramp",
    op: opFor(height),
    order,
    points: [
      { x: x0, y: ys[0], z: z0 },
      { x: x1, y: ys[1], z: z0 },
      { x: x1, y: ys[2], z: z1 },
      { x: x0, y: ys[3], z: z1 },
    ],
    base: y0,
  }
}

/** A `sides`-gon (clamped to 3..TERRAIN_SHAPE_MAX_POINTS) inscribed in the circle; top y0 + height, base y0. */
export function cylinderShape(id: Id, center: Vec2, radius: number, sides: number, y0: number, height: number, order: number): TerrainShape {
  const n = Math.max(3, Math.min(TERRAIN_SHAPE_MAX_POINTS, Math.round(sides) || 3))
  const top = y0 + height
  const points: Vec3[] = []
  for (let k = 0; k < n; k++) {
    const a = (2 * Math.PI * k) / n
    points.push({ x: center.x + radius * Math.cos(a), y: top, z: center.z + radius * Math.sin(a) })
  }
  return { id, kind: "cylinder", op: opFor(height), order, points, base: y0 }
}

// ---------------------------------------------------------------------------
// Elements and edits (each returns a valid shape or null)
// ---------------------------------------------------------------------------

/** Top-vertex indices of an element: vertex k → [k]; edge / side face k → [k, k+1 mod n]; top face → all. [] when out of range. */
export function elementVertexIndices(shape: TerrainShape, ref: TerrainElementRef): number[] {
  const n = shape.points.length
  if (ref.kind === "face" && ref.index === "top") return shape.points.map((_, k) => k)
  const k = ref.index
  if (typeof k !== "number" || !Number.isInteger(k) || k < 0 || k >= n) return []
  return ref.kind === "vertex" ? [k] : [k, (k + 1) % n]
}

function withPoints(shape: TerrainShape, points: Vec3[], base = shape.base): TerrainShape | null {
  const out: TerrainShape = { ...shape, points, base }
  return isValidTerrainShape(out) ? out : null
}

/**
 * Move the given top vertices by `delta` (y moves those tops only; the base stays). Null when the result
 * is invalid: not simple, flipped orientation, heights out of range.
 */
export function translateVertices(shape: TerrainShape, indices: readonly number[], delta: Vec3): TerrainShape | null {
  const set = new Set(indices)
  const points = shape.points.map((p, k) => (set.has(k) ? { x: p.x + delta.x, y: p.y + delta.y, z: p.z + delta.z } : { ...p }))
  return withPoints(shape, points)
}

/** Move the whole shape (tops and base). Null when the result is invalid (e.g. heights out of range). */
export function translateShape(shape: TerrainShape, delta: Vec3): TerrainShape | null {
  return withPoints(
    shape,
    shape.points.map((p) => ({ x: p.x + delta.x, y: p.y + delta.y, z: p.z + delta.z })),
    shape.base + delta.y
  )
}

/** Rotate the footprint about `pivot` by quarter turns of +90° about +Y ((x, z) → (z, −x) relative to the pivot, like editor rotateQuarter). */
export function rotateShapeQuarter(shape: TerrainShape, pivot: Vec2, quarterTurns: number): TerrainShape | null {
  const q = ((Math.round(quarterTurns) % 4) + 4) % 4
  if (q === 0) return shape
  const points = shape.points.map((p) => {
    let x = p.x - pivot.x
    let z = p.z - pivot.z
    for (let k = 0; k < q; k++) {
      const nx = z
      z = -x
      x = nx
    }
    return { x: pivot.x + x, y: p.y, z: pivot.z + z }
  })
  return withPoints(shape, points)
}

/** Remove the given vertices. Null when fewer than 3 would remain or the result is invalid. */
export function dissolveVertices(shape: TerrainShape, indices: readonly number[]): TerrainShape | null {
  const set = new Set(indices)
  const points = shape.points.filter((_, k) => !set.has(k)).map((p) => ({ ...p }))
  if (points.length < 3) return null
  return withPoints(shape, points)
}

/** Merge edge k's two vertices into their midpoint (at vertex k's position in the order). Null when fewer than 3 would remain or the result is invalid. */
export function collapseEdge(shape: TerrainShape, edgeIndex: number): TerrainShape | null {
  const n = shape.points.length
  if (n <= 3 || !Number.isInteger(edgeIndex) || edgeIndex < 0 || edgeIndex >= n) return null
  const j = (edgeIndex + 1) % n
  const a = shape.points[edgeIndex]
  const b = shape.points[j]
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 }
  const points: Vec3[] = []
  for (let k = 0; k < n; k++) {
    if (k === j) continue
    points.push(k === edgeIndex ? mid : { ...shape.points[k] })
  }
  return withPoints(shape, points)
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

/**
 * Nearest hit (t ≥ 0, in units of `ray.direction`) of the ray with the shape's prism at level `elevation`:
 * the top triangles (face "top"; a carve's top is its pit floor) and the vertical side quads (face k under
 * top edge k, spanning y between the base and the top along the edge). The base cap is not an element and
 * is never hit. Null on a miss or non-finite input.
 */
export function rayHitShape(shape: TerrainShape, elevation: number, ray: { origin: Vec3; direction: Vec3 }): { t: number; face: number | "top" } | null {
  const o = ray.origin
  const d = ray.direction
  if (![o.x, o.y, o.z, d.x, d.y, d.z, elevation].every(Number.isFinite)) return null
  const pts = shape.points
  const n = pts.length
  let bestT = Infinity
  let bestFace: number | "top" = "top"
  const { tris } = shapeGeometry(shape)
  const eps = 1e-9
  for (let t = 0; t < tris.length; t += 3) {
    // Möller–Trumbore, two-sided.
    const a = pts[tris[t]]
    const b = pts[tris[t + 1]]
    const c = pts[tris[t + 2]]
    const ay = elevation + a.y
    const e1x = b.x - a.x
    const e1y = elevation + b.y - ay
    const e1z = b.z - a.z
    const e2x = c.x - a.x
    const e2y = elevation + c.y - ay
    const e2z = c.z - a.z
    const px = d.y * e2z - d.z * e2y
    const py = d.z * e2x - d.x * e2z
    const pz = d.x * e2y - d.y * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (Math.abs(det) < 1e-12) continue
    const inv = 1 / det
    const sx = o.x - a.x
    const sy = o.y - ay
    const sz = o.z - a.z
    const u = (sx * px + sy * py + sz * pz) * inv
    if (u < -eps || u > 1 + eps) continue
    const qx = sy * e1z - sz * e1y
    const qy = sz * e1x - sx * e1z
    const qz = sx * e1y - sy * e1x
    const v = (d.x * qx + d.y * qy + d.z * qz) * inv
    if (v < -eps || u + v > 1 + eps) continue
    const hit = (e2x * qx + e2y * qy + e2z * qz) * inv
    if (hit >= 0 && hit < bestT) {
      bestT = hit
      bestFace = "top"
    }
  }
  const baseY = elevation + shape.base
  for (let k = 0; k < n; k++) {
    const a = pts[k]
    const b = pts[(k + 1) % n]
    const ex = b.x - a.x
    const ez = b.z - a.z
    const den = ex * d.z - ez * d.x
    if (Math.abs(den) < 1e-12) continue
    const hit = -(ex * (o.z - a.z) - ez * (o.x - a.x)) / den
    if (!(hit >= 0) || hit >= bestT) continue
    const hx = o.x + hit * d.x
    const hz = o.z + hit * d.z
    const len2 = ex * ex + ez * ez
    const s = ((hx - a.x) * ex + (hz - a.z) * ez) / len2
    if (s < -eps || s > 1 + eps) continue
    const topY = elevation + a.y + s * (b.y - a.y)
    const hy = o.y + hit * d.y
    if (hy < Math.min(topY, baseY) - 1e-6 || hy > Math.max(topY, baseY) + 1e-6) continue
    bestT = hit
    bestFace = k
  }
  return Number.isFinite(bestT) ? { t: bestT, face: bestFace } : null
}
