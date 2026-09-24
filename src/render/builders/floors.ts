/**
 * Floor slabs from effectiveFloorRects (connector cutouts removed). Flat levels: boxes whose top is
 * subdivided per grid cell (subtle per-cell tint so the grid reads even without the overlay).
 * Levels with a heightmap: one lattice mesh per floor over the lattice cells whose centre lies in
 * the floor's effective rects (same cells as the core/occlusion heightfield): the top displaced by the
 * terrain with the heightmap's triangle split and smooth-shaded (lattice normals), and skirts down to
 * top − thickness on the boundary.
 *
 * Terrain meshes are indexed (the tops share vertices inside each grid cell) and have no bottom; they
 * carry a per-vertex Y offset from the ground and a per-lattice-row vertex table so the terrain preview
 * (heightmap brush, terrain shapes) can move the vertices of a dirty rect in place
 * (updateTerrainGeometry) without rebuilding or scanning the whole mesh.
 */
import * as THREE from "three"

import { floorThickness as sceneFloorThickness } from "@/core/scene/queries"
import type { FloorObject, Id, MaterialId } from "@/core/scene/types"

import { SURF } from "../internal"
import { surfaceOf } from "../materials/surface"
import type { BuildContext } from "./context"
import { hashInts, materialColor, tintByHash, type RGB } from "./color"
import type { GroundSampler } from "./ground"
import { writeQuadOutward } from "./shapes"
import type { BucketBuild, MeshBuild, TerrainRows } from "./types"
import { F32, MeshWriter, type V3 } from "./writer"

const MATERIAL_INDEX: Record<MaterialId, number> = {
  stone: 1,
  brick: 2,
  wood: 3,
  plaster: 4,
  dirt: 5,
  grass: 6,
  sand: 7,
  water: 8,
  metal: 9,
  marble: 10,
  tile: 11,
  cobble: 12,
}

/**
 * Per-cell variation strength by material (water stays uniform). Kept small: in the top-down views a
 * stronger tint reads as a checkerboard rather than as texture.
 */
function cellVariation(m: MaterialId): number {
  // Natural ground gets its variation from the shader's procedural detail (medium and up); a strong
  // per-cell tint would read as a checkerboard on top of it.
  return m === "water" ? 0.01 : m === "grass" || m === "dirt" || m === "sand" ? 0.025 : 0.03
}

/**
 * Slab thickness: core/scene floorThickness, the one rule shared with core/occlusion (no visual
 * minimum: a slab is drawn exactly as thick as it blocks). Floors whose thickness is not positive are
 * not drawn (they do not block either).
 */
export function floorThickness(ctx: BuildContext, floor: FloorObject): number {
  return sceneFloorThickness(ctx.scene, floor)
}

function cellColor(base: RGB, material: MaterialId, i: number, j: number): RGB {
  return tintByHash(base, hashInts(i, j, MATERIAL_INDEX[material] ?? 0), cellVariation(material))
}

// ---------------------------------------------------------------------------
// Flat slabs
// ---------------------------------------------------------------------------

function writeFlatSlab(w: MeshWriter, ctx: BuildContext, floor: FloorObject, rect: { x: number; z: number; w: number; d: number }, top: number, th: number): void {
  if (!(rect.w > 1e-6 && rect.d > 1e-6)) return
  const cs = ctx.scene.grid.cellSize
  const base = materialColor(floor.material)
  const x0 = rect.x
  const z0 = rect.z
  const x1 = rect.x + rect.w
  const z1 = rect.z + rect.d
  const bottom = top - th
  w.material = surfaceOf(floor.material)
  // Top: one quad per grid cell ∩ rect.
  const i0 = Math.floor(x0 / cs)
  const i1 = Math.ceil(x1 / cs) - 1
  const j0 = Math.floor(z0 / cs)
  const j1 = Math.ceil(z1 / cs) - 1
  const up: V3 = [0, 1, 0]
  for (let j = j0; j <= j1; j++) {
    const za = Math.max(z0, j * cs)
    const zb = Math.min(z1, (j + 1) * cs)
    if (zb - za < 1e-6) continue
    for (let i = i0; i <= i1; i++) {
      const xa = Math.max(x0, i * cs)
      const xb = Math.min(x1, (i + 1) * cs)
      if (xb - xa < 1e-6) continue
      writeQuadOutward(w, [xa, top, za], [xb, top, za], [xb, top, zb], [xa, top, zb], up, cellColor(base, floor.material, i, j), SURF.WALKABLE)
    }
  }
  const side = tintByHash(base, hashInts(7, MATERIAL_INDEX[floor.material] ?? 0), 0.02)
  const dark: RGB = [side[0] * 0.8, side[1] * 0.8, side[2] * 0.8]
  writeQuadOutward(w, [x0, bottom, z0], [x1, bottom, z0], [x1, bottom, z1], [x0, bottom, z1], [0, -1, 0], dark, SURF.FACE)
  writeQuadOutward(w, [x0, bottom, z0], [x1, bottom, z0], [x1, top, z0], [x0, top, z0], [0, 0, -1], side, SURF.FACE)
  writeQuadOutward(w, [x0, bottom, z1], [x1, bottom, z1], [x1, top, z1], [x0, top, z1], [0, 0, 1], side, SURF.FACE)
  writeQuadOutward(w, [x0, bottom, z0], [x0, bottom, z1], [x0, top, z1], [x0, top, z0], [-1, 0, 0], side, SURF.FACE)
  writeQuadOutward(w, [x1, bottom, z0], [x1, bottom, z1], [x1, top, z1], [x1, top, z0], [1, 0, 0], side, SURF.FACE)
}

// ---------------------------------------------------------------------------
// Terrain slabs
// ---------------------------------------------------------------------------

/** Lattice cells (i, j ranges) spanned by a rect, matching core/occlusion's heightfield. */
export function latticeSpan(rect: { x: number; z: number; w: number; d: number }, spacing: number): { i0: number; j0: number; i1: number; j1: number } {
  return {
    i0: Math.floor(rect.x / spacing + 1e-9),
    j0: Math.floor(rect.z / spacing + 1e-9),
    i1: Math.ceil((rect.x + rect.w) / spacing - 1e-9),
    j1: Math.ceil((rect.z + rect.d) / spacing - 1e-9),
  }
}

class TerrainWriter {
  readonly w = new MeshWriter({ indexed: true })
  /** Per vertex: Y offset from the ground (0 on the top, −thickness at the foot of a skirt). */
  readonly offsets = new F32(4096)
  /** Per vertex: lattice sample (sx, sz) it stands on. */
  readonly samples: number[] = []

  vertex(p: V3, n: V3, color: RGB, surf: number, offset: number, sx: number, sz: number): number {
    this.offsets.push1(offset)
    this.samples.push(sx, sz)
    return this.w.addVertex(p, n, color, surf)
  }

  /** Vertices sorted by lattice row then x (MergedBuild.terrainRows), by two stable counting passes. */
  rows(): TerrainRows | null {
    const n = this.samples.length / 2
    if (n === 0) return null
    let sx0 = Infinity
    let sx1 = -Infinity
    let sz0 = Infinity
    let sz1 = -Infinity
    for (let v = 0; v < n; v++) {
      sx0 = Math.min(sx0, this.samples[v * 2])
      sx1 = Math.max(sx1, this.samples[v * 2])
      sz0 = Math.min(sz0, this.samples[v * 2 + 1])
      sz1 = Math.max(sz1, this.samples[v * 2 + 1])
    }
    const byX = countingSort(n, sx1 - sx0 + 1, (v) => this.samples[v * 2] - sx0, null)
    const rowStart = new Int32Array(sz1 - sz0 + 2)
    const order = countingSort(n, sz1 - sz0 + 1, (v) => this.samples[v * 2 + 1] - sz0, byX, rowStart)
    return { sz0, rowStart, order }
  }
}

/** Stable counting sort of vertices 0..n−1 (in the order of `input`, or 0..n−1) by key ∈ [0, keys). */
function countingSort(n: number, keys: number, key: (v: number) => number, input: Uint32Array | null, starts?: Int32Array): Uint32Array {
  const count = new Int32Array(keys + 1)
  for (let v = 0; v < n; v++) count[key(v) + 1]++
  for (let k = 0; k < keys; k++) count[k + 1] += count[k]
  if (starts) starts.set(count.subarray(0, starts.length))
  const out = new Uint32Array(n)
  for (let k = 0; k < n; k++) {
    const v = input ? input[k] : k
    out[count[key(v)]++] = v
  }
  return out
}

/**
 * The terrain slab of one floor: the top over its solid lattice cells (smooth lattice normals, vertices
 * shared inside each grid cell, whose tint is its own) and skirts where a neighbour cell is not solid. No
 * bottom: the cameras never look up at it (orbit polar limit), and the occluder proxies (render/occluders)
 * close the solid for shadows and line of sight.
 */
function writeTerrainSlab(tw: TerrainWriter, ctx: BuildContext, floor: FloorObject, ground: GroundSampler, th: number): void {
  const s = ground.spacing
  const span = latticeSpan(floor.rect, s)
  const cellsX = span.i1 - span.i0
  const cellsZ = span.j1 - span.j0
  if (cellsX <= 0 || cellsZ <= 0) return
  const rects = ctx.effectiveFloors(floor.levelId).filter((e) => e.floorId === floor.id)
  const solid = new Uint8Array(cellsX * cellsZ)
  for (let j = 0; j < cellsZ; j++) {
    for (let i = 0; i < cellsX; i++) {
      const cx = (span.i0 + i + 0.5) * s
      const cz = (span.j0 + j + 0.5) * s
      for (const e of rects) {
        const r = e.rect
        if (cx >= r.x && cx < r.x + r.w && cz >= r.z && cz < r.z + r.d) {
          solid[j * cellsX + i] = 1
          break
        }
      }
    }
  }
  const isSolid = (i: number, j: number) => i >= 0 && j >= 0 && i < cellsX && j < cellsZ && solid[j * cellsX + i] === 1
  const w = tw.w
  w.material = surfaceOf(floor.material)
  const base = materialColor(floor.material)
  const side: RGB = [base[0] * 0.75, base[1] * 0.75, base[2] * 0.75]
  const cs = ctx.scene.grid.cellSize
  // Grid cell (tint block) of lattice cell / sample index k along an axis.
  const block = (k: number) => Math.floor((k * s) / cs + 1e-9)
  const p = (sx: number, sz: number, off: number): V3 => [sx * s, ground.elevation + ground.sample(sx, sz) + off, sz * s]
  // Top vertices by (sample, side): a sample on a grid-cell line has one vertex per tint block it borders;
  // side bit 1 = the block below the sample's own (block(sx)) along that axis.
  const W2 = (cellsX + 1) * 2
  const top = new Int32Array(W2 * (cellsZ + 1) * 2).fill(-1)
  const nrm: [number, number, number] = [0, 1, 0]
  const topVertex = (i: number, j: number, ci: number, cj: number, color: RGB): number => {
    const sx = span.i0 + i
    const sz = span.j0 + j
    const k = (j * 2 + (block(span.j0 + cj) === block(sz) ? 0 : 1)) * W2 + i * 2 + (block(span.i0 + ci) === block(sx) ? 0 : 1)
    if (top[k] < 0) top[k] = tw.vertex(p(sx, sz, 0), ground.normalAt(sx, sz, nrm), color, SURF.WALKABLE, 0, sx, sz)
    return top[k]
  }
  // Skirt quad along a lattice edge (a → b seen from outside, counter-clockwise with the feet).
  const skirt = (ai: number, aj: number, bi: number, bj: number, out: V3) => {
    const ax = span.i0 + ai
    const az = span.j0 + aj
    const bx = span.i0 + bi
    const bz = span.j0 + bj
    const ta = tw.vertex(p(ax, az, 0), out, side, SURF.FACE, 0, ax, az)
    const tb = tw.vertex(p(bx, bz, 0), out, side, SURF.FACE, 0, bx, bz)
    const fa = tw.vertex(p(ax, az, -th), out, side, SURF.FACE, -th, ax, az)
    const fb = tw.vertex(p(bx, bz, -th), out, side, SURF.FACE, -th, bx, bz)
    w.indexedTriangle(ta, fa, fb)
    w.indexedTriangle(ta, fb, tb)
  }
  for (let j = 0; j < cellsZ; j++) {
    for (let i = 0; i < cellsX; i++) {
      if (!isSolid(i, j)) continue
      const color = cellColor(base, floor.material, block(span.i0 + i), block(span.j0 + j))
      const v00 = topVertex(i, j, i, j, color)
      const v10 = topVertex(i + 1, j, i, j, color)
      const v01 = topVertex(i, j + 1, i, j, color)
      const v11 = topVertex(i + 1, j + 1, i, j, color)
      // Heightmap split: triangles (00, 10, 11) and (00, 01, 11), wound to face up (+Y).
      w.indexedTriangle(v00, v11, v10)
      w.indexedTriangle(v00, v01, v11)
      // Skirts where the neighbour cell is not part of this floor, wound to face outward.
      if (!isSolid(i, j - 1)) skirt(i + 1, j, i, j, [0, 0, -1])
      if (!isSolid(i, j + 1)) skirt(i, j + 1, i + 1, j + 1, [0, 0, 1])
      if (!isSolid(i - 1, j)) skirt(i, j, i, j + 1, [-1, 0, 0])
      if (!isSolid(i + 1, j)) skirt(i + 1, j + 1, i + 1, j, [1, 0, 0])
    }
  }
}

/**
 * Floors bucket of a level. Terrain levels (a heightmap, or an active brush preview) produce a mesh
 * with `terrainOffsets`; flat levels produce plain slabs.
 */
export function buildFloorsBucket(ctx: BuildContext, levelId: Id): BucketBuild {
  const level = ctx.level(levelId)
  if (!level) return { meshes: [] }
  const ground = ctx.sampler(levelId)
  const w = new MeshWriter()
  const meshes: MeshBuild[] = []
  if (ground.flat) {
    const top = ground.elevation
    for (const e of ctx.effectiveFloors(levelId)) {
      const floor = ctx.object(e.floorId)
      if (!floor || floor.type !== "floor") continue
      const th = floorThickness(ctx, floor)
      if (!(th > 0)) continue
      w.begin(floor.id)
      writeFlatSlab(w, ctx, floor, e.rect, top, th)
      w.end()
    }
    const g = w.build()
    if (g) meshes.push({ kind: "merged", name: "floors", slot: "world", geometry: g })
    return { meshes }
  }
  const tw = new TerrainWriter()
  for (const floor of ctx.ofType(levelId, "floor")) {
    const th = floorThickness(ctx, floor)
    if (!(th > 0)) continue
    tw.w.begin(floor.id)
    writeTerrainSlab(tw, ctx, floor, ground, th)
    tw.w.end()
  }
  const g = tw.w.build()
  const rows = tw.rows()
  if (g && rows) {
    g.userData.terrainLevelId = levelId
    g.userData.terrainSpacing = ground.spacing
    meshes.push({ kind: "merged", name: "terrain", slot: "world", geometry: g, terrainOffsets: tw.offsets.toArray(), terrainRows: rows })
  }
  return { meshes }
}

const _box = new THREE.Box3()
const _sphere = new THREE.Sphere()
const _n: [number, number, number] = [0, 1, 0]

/**
 * Move terrain vertices in place to follow `ground` (terrain preview): only the vertices inside `dirty`
 * (grown by 1.5 lattice spacings, since a top vertex's smooth normal reads its neighbours; null =
 * everywhere) are touched: every vertex stands on a lattice sample, so its height is read from the
 * lattice directly (plus its offset), and the tops' normals are recomputed (GroundSampler.normalAt; the
 * skirts' stay horizontal). With `rows` (MergedBuild.terrainRows) only the vertices of the lattice rows
 * around `dirty` are visited, and in each row only those around it, so the cost follows the dirty rect,
 * not the mesh. Each attribute gets ONE upload range: the span from the first to the last touched vertex,
 * merged with any range not uploaded yet (several updates can run before a render, and dropping theirs
 * would leave stale vertices on the GPU). Per-row ranges would each be a bufferSubData into a buffer of
 * tens of MB the GPU may still be reading, which some drivers pay for with a copy of the whole buffer per
 * call (≈ 1 s frames on a 100×100-cell level at resolution 4). The bounds grow by union (they never shrink
 * during a preview). Returns the number of vertices updated, or −1 when the mesh was not built on
 * `ground`'s lattice spacing (rebuild it instead).
 */
export function updateTerrainGeometry(
  geometry: THREE.BufferGeometry,
  offsets: Float32Array,
  ground: GroundSampler,
  dirty: { x: number; z: number; w: number; d: number } | null,
  rows?: TerrainRows | null
): number {
  const s = ground.spacing
  const built = geometry.userData.terrainSpacing as number | undefined
  const H = ground.heights
  if (!H || (built !== undefined && Math.abs(built - s) > 1e-9)) return -1
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute
  const nrm = geometry.getAttribute("normal") as THREE.BufferAttribute
  const surf = geometry.getAttribute("aSurf").array as Float32Array
  const P = pos.array as Float32Array
  const N = nrm.array as Float32Array
  // Tops' normals read the neighbour samples: 1.5 spacings reach every vertex one sample away (with slack).
  const m = 1.5 * s
  const x0 = dirty ? dirty.x - m : -Infinity
  const z0 = dirty ? dirty.z - m : -Infinity
  const x1 = dirty ? dirty.x + dirty.w + m : Infinity
  const z1 = dirty ? dirty.z + dirty.d + m : Infinity
  const inv = 1 / s
  const SX = ground.samplesX
  const SZ = ground.samplesZ
  const E = ground.elevation
  let count = 0
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  // Span of the touched vertices, uploaded as one range per attribute below.
  let vFirst = Infinity
  let vLast = -1
  const visit = (v: number) => {
    const q = v * 3
    const x = P[q]
    const z = P[q + 2]
    if (x < x0 || x > x1 || z < z0 || z > z1) return
    const sx = Math.round(x * inv)
    const sz = Math.round(z * inv)
    const h = sx >= 0 && sz >= 0 && sx < SX && sz < SZ ? H[sz * SX + sx] : 0
    const y = (P[q + 1] = E + h + offsets[v])
    if (surf[v] === SURF.WALKABLE) {
      ground.normalAt(sx, sz, _n)
      N[q] = _n[0]
      N[q + 1] = _n[1]
      N[q + 2] = _n[2]
    }
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
    if (v < vFirst) vFirst = v
    if (v > vLast) vLast = v
    count++
  }
  if (rows && dirty) {
    const { sz0, rowStart, order } = rows
    const r0 = Math.max(0, Math.floor(z0 * inv) - 1 - sz0)
    const r1 = Math.min(rowStart.length - 2, Math.ceil(z1 * inv) + 1 - sz0)
    for (let r = r0; r <= r1; r++) {
      // First vertex of the row at x ≥ x0, then on while x ≤ x1.
      let lo = rowStart[r]
      let hi = rowStart[r + 1]
      const end = hi
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (P[order[mid] * 3] < x0) lo = mid + 1
        else hi = mid
      }
      for (let k = lo; k < end && P[order[k] * 3] <= x1; k++) visit(order[k])
    }
  } else {
    for (let v = 0, n = P.length / 3; v < n; v++) visit(v)
  }
  if (count > 0) {
    for (const a of [pos, nrm]) {
      let lo = vFirst * 3
      let hi = (vLast + 1) * 3
      for (const r of a.updateRanges) {
        if (r.start < lo) lo = r.start
        if (r.start + r.count > hi) hi = r.start + r.count
      }
      a.clearUpdateRanges()
      a.addUpdateRange(lo, hi - lo)
      a.needsUpdate = true
    }
    _box.min.set(minX, minY, minZ)
    _box.max.set(maxX, maxY, maxZ)
    if (geometry.boundingBox) geometry.boundingBox.union(_box)
    else geometry.computeBoundingBox()
    if (geometry.boundingSphere) geometry.boundingSphere.union(_box.getBoundingSphere(_sphere))
    else geometry.computeBoundingSphere()
  }
  return count
}
