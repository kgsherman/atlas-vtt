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
 *    a light's cube pass culls the terrain it cannot see.
 */
import * as THREE from "three"

import type { Heightfield, OrientedBox, VerticalCylinder } from "@/core/occlusion/types"

export const PRISM_SIDES = 16
/** Vertex radius / circle radius giving the 16-gon the circle's area. */
export const PRISM_RADIUS_SCALE = Math.sqrt((2 * Math.PI) / (PRISM_SIDES * Math.sin((2 * Math.PI) / PRISM_SIDES)))
/** Lattice cells per heightfield chunk edge. */
export const HEIGHTFIELD_CHUNK_CELLS = 16
/** Minimum slab thickness used for proxies (keeps the volume closed and non-degenerate). */
const MIN_THICKNESS = 0.05

type P3 = readonly [number, number, number]

class TriangleSink {
  private data: number[] = []
  tri(a: P3, b: P3, c: P3): void {
    this.data.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2])
  }
  /** Quad a→b→c→d, counter-clockwise seen from its front. */
  quad(a: P3, b: P3, c: P3, d: P3): void {
    this.tri(a, b, c)
    this.tri(a, c, d)
  }
  get length(): number {
    return this.data.length
  }
  toArray(): Float32Array {
    return new Float32Array(this.data)
  }
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

/**
 * Closed triangle soup of a heightfield's solid, split into chunks by lattice cell. The union of all
 * chunks is a closed, outward-wound surface (skirts are emitted only on the region's boundary).
 */
export function heightfieldChunks(hf: Pick<Heightfield, "originX" | "originZ" | "spacing" | "samplesX" | "samplesZ" | "heights" | "solid" | "thickness">, chunkCells = HEIGHTFIELD_CHUNK_CELLS): HeightfieldChunk[] {
  const cx = hf.samplesX - 1
  const cz = hf.samplesZ - 1
  const th = Math.max(hf.thickness, MIN_THICKNESS)
  const solid = (i: number, j: number): boolean => i >= 0 && j >= 0 && i < cx && j < cz && hf.solid[j * cx + i] !== 0
  const sinks = new Map<string, { ci: number; cj: number; sink: TriangleSink }>()
  const top = (i: number, j: number): P3 => [hf.originX + i * hf.spacing, hf.heights[j * hf.samplesX + i], hf.originZ + j * hf.spacing]
  const bot = (i: number, j: number): P3 => [hf.originX + i * hf.spacing, hf.heights[j * hf.samplesX + i] - th, hf.originZ + j * hf.spacing]

  for (let j = 0; j < cz; j++) {
    for (let i = 0; i < cx; i++) {
      if (!solid(i, j)) continue
      const ci = Math.floor(i / chunkCells)
      const cj = Math.floor(j / chunkCells)
      const key = `${ci},${cj}`
      let entry = sinks.get(key)
      if (!entry) {
        entry = { ci, cj, sink: new TriangleSink() }
        sinks.set(key, entry)
      }
      const s = entry.sink
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
  return [...sinks.values()]
    .sort((a, b) => a.cj - b.cj || a.ci - b.ci)
    .map((e) => ({ ci: e.ci, cj: e.cj, positions: e.sink.toArray() }))
}

/** BufferGeometry with only a position attribute (the occluder shaders need nothing else). */
export function positionsGeometry(positions: Float32Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3))
  g.computeBoundingSphere()
  g.computeBoundingBox()
  return g
}
