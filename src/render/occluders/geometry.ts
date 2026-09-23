/**
 * Occluder proxy geometry (ARCHITECTURE §4.3): closed, outward-wound (CCW seen from outside) solids,
 * because the shadow / line-of-sight passes render them BackSide ("second depth"): what a capture
 * stores is the FAR side of each occluder, so a lit face never shadows itself.
 *
 *  - unit box [−½, ½]³ → instance matrix T(center)·Ry(yaw)·S(2·halfExtents)
 *  - unit 16-sided prism (height 1, y ∈ [−½, ½]) → T(base + h/2)·S(2r, h, 2r); its vertex radius is
 *    scaled so the polygon has the circle's area (radial error ≤ 1.3% either way)
 *  - heightfields → closed meshes (top surface on the terrain triangle split, bottom = top − thickness,
 *    skirts along the boundary of the solid lattice cells), cut into chunks so the per-face frustum of
 *    a light's cube pass culls the terrain it cannot see. A chunk's triangle order depends only on the
 *    lattice size and the solid mask, so a terrain preview rewrites a chunk's positions in place
 *    (heightfieldChunkTriangles into an ArrayTriangleSink).
 *  - wall strips → closed world-space meshes: per knot interval a top quad on the profile, a bottom
 *    quad and the two side trapezoids (shared edges, no internal faces), plus the two end caps.
 */
import * as THREE from "three"

import type { Heightfield, OrientedBox, VerticalCylinder, WallStrip } from "@/core/occlusion/types"

export const PRISM_SIDES = 16
/** Vertex radius / circle radius giving the 16-gon the circle's area. */
export const PRISM_RADIUS_SCALE = Math.sqrt((2 * Math.PI) / (PRISM_SIDES * Math.sin((2 * Math.PI) / PRISM_SIDES)))
/** Lattice cells per heightfield chunk edge. */
export const HEIGHTFIELD_CHUNK_CELLS = 16
/** Minimum slab thickness used for proxies (keeps the volume closed and non-degenerate). */
export const HEIGHTFIELD_MIN_THICKNESS = 0.05

type P3 = readonly [number, number, number]

/** Where triangle emitters write (TriangleSink grows, ArrayTriangleSink overwrites a fixed array). */
export interface TriangleWriter {
  tri(a: P3, b: P3, c: P3): void
  /** Quad a→b→c→d, counter-clockwise seen from its front: triangles (a, b, c), (a, c, d). */
  quad(a: P3, b: P3, c: P3, d: P3): void
}

/**
 * Writes triangles over a preallocated array from index 0 (a mesh of the same topology rewritten in
 * place). `offset` is where the next triangle goes; triangles past the end are counted but dropped, so
 * `offset === array.length` after emission means the topology matched.
 */
export class ArrayTriangleSink implements TriangleWriter {
  offset = 0
  readonly array: Float32Array
  constructor(array: Float32Array) {
    this.array = array
  }
  tri(a: P3, b: P3, c: P3): void {
    const o = this.offset
    this.offset = o + 9
    if (o + 9 > this.array.length) return
    const d = this.array
    d[o] = a[0]
    d[o + 1] = a[1]
    d[o + 2] = a[2]
    d[o + 3] = b[0]
    d[o + 4] = b[1]
    d[o + 5] = b[2]
    d[o + 6] = c[0]
    d[o + 7] = c[1]
    d[o + 8] = c[2]
  }
  quad(a: P3, b: P3, c: P3, d: P3): void {
    this.tri(a, b, c)
    this.tri(a, c, d)
  }
}

export class TriangleSink implements TriangleWriter {
  private data: number[] = []
  tri(a: P3, b: P3, c: P3): void {
    this.data.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
  }
  /** Quad a→b→c→d, counter-clockwise seen from its front. */
  quad(a: P3, b: P3, c: P3, d: P3): void {
    this.tri(a, b, c)
    this.tri(a, c, d)
  }
  /** Triangle wound counter-clockwise seen from the side `out` points to. */
  triOutward(a: P3, b: P3, c: P3, out: P3): void {
    if (crossDot(a, b, c, out) < 0) this.tri(a, c, b)
    else this.tri(a, b, c)
  }
  /** Planar quad a→b→c→d (cyclic order) wound counter-clockwise seen from the side `out` points to. */
  quadOutward(a: P3, b: P3, c: P3, d: P3, out: P3): void {
    if (crossDot(a, b, c, out) + crossDot(a, c, d, out) < 0) this.quad(a, d, c, b)
    else this.quad(a, b, c, d)
  }
  get length(): number {
    return this.data.length
  }
  toArray(): Float32Array {
    return new Float32Array(this.data)
  }
}

/** (b − a) × (c − a) · out. */
function crossDot(a: P3, b: P3, c: P3, out: P3): number {
  const ux = b[0] - a[0]
  const uy = b[1] - a[1]
  const uz = b[2] - a[2]
  const vx = c[0] - a[0]
  const vy = c[1] - a[1]
  const vz = c[2] - a[2]
  return (uy * vz - uz * vy) * out[0] + (uz * vx - ux * vz) * out[1] + (ux * vy - uy * vx) * out[2]
}

/** Closed unit cube [−½, ½]³, non-indexed triangles. */
export function unitBoxTriangles(): Float32Array {
  const h = 0.5
  const s = new TriangleSink()
  s.quad([h, -h, -h], [h, h, -h], [h, h, h], [h, -h, h]) // +X
  s.quad([-h, -h, h], [-h, h, h], [-h, h, -h], [-h, -h, -h]) // −X
  s.quad([-h, h, -h], [-h, h, h], [h, h, h], [h, h, -h]) // +Y
  s.quad([-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]) // −Y
  s.quad([-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]) // +Z
  s.quad([-h, -h, -h], [-h, h, -h], [h, h, -h], [h, -h, -h]) // −Z
  return s.toArray()
}

/** Closed 16-sided prism of height 1 centred on the origin, non-indexed triangles. */
export function unitPrismTriangles(): Float32Array {
  const r = 0.5 * PRISM_RADIUS_SCALE
  const s = new TriangleSink()
  const ring = (y: number): P3[] =>
    Array.from({ length: PRISM_SIDES }, (_, k) => {
      const a = (2 * Math.PI * k) / PRISM_SIDES
      return [r * Math.cos(a), y, r * Math.sin(a)] as P3
    })
  const top = ring(0.5)
  const bottom = ring(-0.5)
  for (let k = 0; k < PRISM_SIDES; k++) {
    const k1 = (k + 1) % PRISM_SIDES
    s.quad(bottom[k], top[k], top[k1], bottom[k1])
    s.tri([0, 0.5, 0], top[k1], top[k])
    s.tri([0, -0.5, 0], bottom[k], bottom[k1])
  }
  return s.toArray()
}

const _q = new THREE.Quaternion()
const _p = new THREE.Vector3()
const _s = new THREE.Vector3()
const _yAxis = new THREE.Vector3(0, 1, 0)

/** Unit box → oriented box (yaw convention shared with three's makeRotationY, see core/geometry/box). */
export function boxInstanceMatrix(b: Pick<OrientedBox, "center" | "halfExtents" | "yaw">, out: THREE.Matrix4): THREE.Matrix4 {
  _p.set(b.center.x, b.center.y, b.center.z)
  _q.setFromAxisAngle(_yAxis, b.yaw)
  _s.set(2 * b.halfExtents.x, 2 * b.halfExtents.y, 2 * b.halfExtents.z)
  return out.compose(_p, _q, _s)
}

/** Unit prism → upright cylinder standing on `base`. */
export function cylinderInstanceMatrix(c: Pick<VerticalCylinder, "base" | "radius" | "height">, out: THREE.Matrix4): THREE.Matrix4 {
  _p.set(c.base.x, c.base.y + c.height / 2, c.base.z)
  _q.identity()
  _s.set(2 * c.radius, c.height, 2 * c.radius)
  return out.compose(_p, _q, _s)
}

export interface HeightfieldChunk {
  /** Chunk coordinates (lattice cells / HEIGHTFIELD_CHUNK_CELLS). */
  ci: number
  cj: number
  /** Non-indexed triangles. */
  positions: Float32Array
}

export type HeightfieldSurface = Pick<Heightfield, "originX" | "originZ" | "spacing" | "samplesX" | "samplesZ" | "heights" | "solid" | "thickness">

/**
 * Closed triangle soup of a heightfield's solid, split into chunks by lattice cell. The union of all
 * chunks is a closed, outward-wound surface (skirts are emitted only on the region's boundary).
 */
export function heightfieldChunks(hf: HeightfieldSurface, chunkCells = HEIGHTFIELD_CHUNK_CELLS): HeightfieldChunk[] {
  const out: HeightfieldChunk[] = []
  for (let cj = 0; cj * chunkCells < hf.samplesZ - 1; cj++) {
    for (let ci = 0; ci * chunkCells < hf.samplesX - 1; ci++) {
      const sink = new TriangleSink()
      heightfieldChunkTriangles(hf, ci, cj, sink, chunkCells)
      if (sink.length > 0) out.push({ ci, cj, positions: sink.toArray() })
    }
  }
  return out
}

/**
 * The triangles of chunk (ci, cj) of a heightfield's solid (lattice cells [ci·C, (ci + 1)·C) ×
 * [cj·C, (cj + 1)·C), C = chunkCells), in heightfieldChunks' order: solid cells by row then column, each
 * its two top triangles, two bottom triangles and the skirts on the solid region's boundary. The order
 * depends only on the lattice size and the solid mask, not on the heights.
 */
export function heightfieldChunkTriangles(hf: HeightfieldSurface, ci: number, cj: number, s: TriangleWriter, chunkCells = HEIGHTFIELD_CHUNK_CELLS): void {
  const cx = hf.samplesX - 1
  const cz = hf.samplesZ - 1
  const th = Math.max(hf.thickness, HEIGHTFIELD_MIN_THICKNESS)
  const solid = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < cx && j < cz && hf.solid[j * cx + i] !== 0
  const top = (i: number, j: number): P3 => [hf.originX + i * hf.spacing, hf.heights[j * hf.samplesX + i], hf.originZ + j * hf.spacing]
  const bot = (i: number, j: number): P3 => [hf.originX + i * hf.spacing, hf.heights[j * hf.samplesX + i] - th, hf.originZ + j * hf.spacing]
  const i1 = Math.min((ci + 1) * chunkCells, cx)
  const j1 = Math.min((cj + 1) * chunkCells, cz)
  for (let j = cj * chunkCells; j < j1; j++) {
    for (let i = ci * chunkCells; i < i1; i++) {
      if (!solid(i, j)) continue
      const p00 = top(i, j)
      const p10 = top(i + 1, j)
      const p01 = top(i, j + 1)
      const p11 = top(i + 1, j + 1)
      const b00 = bot(i, j)
      const b10 = bot(i + 1, j)
      const b01 = bot(i, j + 1)
      const b11 = bot(i + 1, j + 1)
      // Top: split along (i, j)–(i+1, j+1), as core/scene/heightmap and core/occlusion.
      s.tri(p00, p11, p10)
      s.tri(p00, p01, p11)
      // Bottom: same split, facing down.
      s.tri(b00, b10, b11)
      s.tri(b00, b11, b01)
      // Skirts where the neighbour is not solid; quad [t0, t1, b1, b0] faces cross(t1 − t0, down).
      if (!solid(i, j - 1)) s.quad(p00, p10, b10, b00) // −Z
      if (!solid(i, j + 1)) s.quad(p11, p01, b01, b11) // +Z
      if (!solid(i - 1, j)) s.quad(p01, p00, b00, b01) // −X
      if (!solid(i + 1, j)) s.quad(p10, p11, b11, b10) // +X
    }
  }
}

/**
 * Closed, outward-wound triangles of a wall strip in world space, appended to `sink`. Local x runs
 * along the strip (the knots), local z across it (±halfExtents.z), rotated by yaw as OrientedBox:
 * world = centre + (cos·lx + sin·lz, −sin·lx + cos·lz). Side triangles and caps of zero height (the
 * top touching the bottom at a knot) are skipped; the surface stays closed.
 */
export function stripTriangles(st: Pick<WallStrip, "center" | "halfExtents" | "yaw" | "knots" | "top" | "bottom">, sink: TriangleSink): void {
  const n = st.knots.length
  if (n < 2 || st.top.length !== n) return
  const c = Math.cos(st.yaw)
  const s = Math.sin(st.yaw)
  const hz = st.halfExtents.z
  const b = st.bottom
  const P = (lx: number, y: number, lz: number): P3 => [st.center.x + c * lx + s * lz, y, st.center.z - s * lx + c * lz]
  // World directions of local +x and +z.
  const ex: P3 = [c, 0, -s]
  const ez: P3 = [s, 0, c]
  const up: P3 = [0, 1, 0]
  const down: P3 = [0, -1, 0]
  const EPS = 1e-9
  for (let i = 0; i + 1 < n; i++) {
    const ka = st.knots[i]
    const kb = st.knots[i + 1]
    const ta = st.top[i]
    const tb = st.top[i + 1]
    sink.quadOutward(P(ka, ta, -hz), P(kb, tb, -hz), P(kb, tb, hz), P(ka, ta, hz), up)
    sink.quadOutward(P(ka, b, -hz), P(kb, b, -hz), P(kb, b, hz), P(ka, b, hz), down)
    const ha = ta - b > EPS
    const hb = tb - b > EPS
    for (const [lz, out] of [
      [-hz, [-ez[0], 0, -ez[2]]],
      [hz, ez],
    ] as const) {
      if (ha && hb) sink.quadOutward(P(ka, b, lz), P(kb, b, lz), P(kb, tb, lz), P(ka, ta, lz), out)
      else if (ha) sink.triOutward(P(ka, b, lz), P(kb, b, lz), P(ka, ta, lz), out)
      else if (hb) sink.triOutward(P(ka, b, lz), P(kb, b, lz), P(kb, tb, lz), out)
    }
  }
  const cap = (k: number, t: number, out: P3) => {
    if (t - b > EPS) sink.quadOutward(P(k, b, -hz), P(k, b, hz), P(k, t, hz), P(k, t, -hz), out)
  }
  cap(st.knots[0], st.top[0], [-ex[0], 0, -ex[2]])
  cap(st.knots[n - 1], st.top[n - 1], ex)
}

/** BufferGeometry with only a position attribute (the occluder shaders need nothing else). */
export function positionsGeometry(positions: Float32Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3))
  g.computeBoundingSphere()
  g.computeBoundingBox()
  return g
}
