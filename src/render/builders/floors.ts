/**
 * Floor slabs from effectiveFloorRects (connector cutouts removed). Flat levels: boxes whose top is
 * subdivided per grid cell (subtle per-cell tint so the grid reads even without the overlay).
 * Levels with a heightmap: one lattice mesh per floor over the lattice cells whose centre lies in
 * the floor's effective rects (same cells as the core/occlusion heightfield), top displaced by the
 * terrain with the heightmap's triangle split and smooth-shaded (lattice normals), bottom = top − thickness,
 * skirts on the boundary.
 *
 * Terrain meshes carry a per-vertex Y offset from the ground and a per-lattice-row triangle table so
 * the terrain preview (heightmap brush, terrain shapes) can move the vertices of a dirty rect in place
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
import type { BucketBuild, MeshBuild } from "./types"
import { F32, faceNormal, MeshWriter, type V3 } from "./writer"

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
  readonly w: MeshWriter
  readonly offsets = new F32(4096)
  /** (sz, first triangle, end triangle) per floor and lattice cell row, see MergedBuild.terrainRows. */
  readonly rows: number[] = []
  constructor(w: MeshWriter) {
    this.w = w
  }
  /** Triangle with explicit per-vertex ground offsets; flipped if its normal opposes `outward`. */
  tri(a: V3, oa: number, b: V3, ob: number, c: V3, oc: number, outward: V3, color: RGB, surf: number): void {
    const n = faceNormal(a, b, c)
    if (n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2] < 0) {
      this.w.triangle(a, c, b, color, surf, [-n[0], -n[1], -n[2]])
      this.offsets.push3(oa, oc, ob)
    } else {
      this.w.triangle(a, b, c, color, surf, n)
      this.offsets.push3(oa, ob, oc)
    }
  }
  /** Top triangle (offsets 0) with the lattice's smooth normals; wound to face up. */
  top(a: V3, na: V3, b: V3, nb: V3, c: V3, nc: V3, color: RGB): void {
    if (faceNormal(a, b, c)[1] < 0) this.w.triangleSmooth(a, na, c, nc, b, nb, color, SURF.WALKABLE)
    else this.w.triangleSmooth(a, na, b, nb, c, nc, color, SURF.WALKABLE)
    this.offsets.push3(0, 0, 0)
  }
}

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
  tw.w.material = surfaceOf(floor.material)
  const base = materialColor(floor.material)
  const side: RGB = [base[0] * 0.75, base[1] * 0.75, base[2] * 0.75]
  const cs = ctx.scene.grid.cellSize
  const p = (sx: number, sz: number, off: number): V3 => [sx * s, ground.elevation + ground.sample(sx, sz) + off, sz * s]
  for (let j = 0; j < cellsZ; j++) {
    const rowStart = tw.w.triangleCount
    for (let i = 0; i < cellsX; i++) {
      if (!isSolid(i, j)) continue
      const sx = span.i0 + i
      const sz = span.j0 + j
      const color = cellColor(base, floor.material, Math.floor((sx * s) / cs + 1e-9), Math.floor((sz * s) / cs + 1e-9))
      const t00 = p(sx, sz, 0)
      const t10 = p(sx + 1, sz, 0)
      const t01 = p(sx, sz + 1, 0)
      const t11 = p(sx + 1, sz + 1, 0)
      // Heightmap split: triangles (00, 10, 11) and (00, 01, 11), smooth-shaded.
      const n00 = ground.normalAt(sx, sz)
      const n11 = ground.normalAt(sx + 1, sz + 1)
      tw.top(t00, n00, t10, ground.normalAt(sx + 1, sz), t11, n11, color)
      tw.top(t00, n00, t01, ground.normalAt(sx, sz + 1), t11, n11, color)
      const b00 = p(sx, sz, -th)
      const b10 = p(sx + 1, sz, -th)
      const b01 = p(sx, sz + 1, -th)
      const b11 = p(sx + 1, sz + 1, -th)
      tw.tri(b00, -th, b10, -th, b11, -th, [0, -1, 0], side, SURF.FACE)
      tw.tri(b00, -th, b01, -th, b11, -th, [0, -1, 0], side, SURF.FACE)
      // Skirts where the neighbour cell is not part of this floor.
      const skirt = (ta: V3, tb: V3, ba: V3, bb: V3, out: V3) => {
        tw.tri(ta, 0, tb, 0, bb, -th, out, side, SURF.FACE)
        tw.tri(ta, 0, bb, -th, ba, -th, out, side, SURF.FACE)
      }
      if (!isSolid(i, j - 1)) skirt(t00, t10, b00, b10, [0, 0, -1])
      if (!isSolid(i, j + 1)) skirt(t01, t11, b01, b11, [0, 0, 1])
      if (!isSolid(i - 1, j)) skirt(t00, t01, b00, b01, [-1, 0, 0])
      if (!isSolid(i + 1, j)) skirt(t10, t11, b10, b11, [1, 0, 0])
    }
    if (tw.w.triangleCount > rowStart) tw.rows.push(span.j0 + j, rowStart, tw.w.triangleCount)
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
  const tw = new TerrainWriter(w)
  for (const floor of ctx.ofType(levelId, "floor")) {
    const th = floorThickness(ctx, floor)
    if (!(th > 0)) continue
    w.begin(floor.id)
    writeTerrainSlab(tw, ctx, floor, ground, th)
    w.end()
  }
  const g = w.build()
  if (g) {
    g.userData.terrainLevelId = levelId
    g.userData.terrainSpacing = ground.spacing
    meshes.push({ kind: "merged", name: "terrain", slot: "world", geometry: g, terrainOffsets: tw.offsets.toArray(), terrainRows: Int32Array.from(tw.rows) })
  }
  return { meshes }
}

const _box = new THREE.Box3()
const _sphere = new THREE.Sphere()
const _n: [number, number, number] = [0, 1, 0]

/**
 * Move terrain vertices in place to follow `ground` (terrain preview): only triangles with a vertex
 * inside `dirty` (grown by 1.5 lattice spacings, since a top vertex's smooth normal reads its neighbours;
 * null = everywhere) are touched and their normals recomputed (tops: GroundSampler.normalAt; bottoms and
 * skirts: flat). Every vertex of a terrain mesh sits on a lattice sample, so heights are read from the
 * lattice directly. With `rows` (MergedBuild.terrainRows) only the lattice rows around `dirty` are
 * visited, and in each row only the cells around it (triangles of a row are in ascending x of their
 * first vertex), so the cost follows the dirty rect, not the mesh. Each attribute gets ONE upload range:
 * the span from the first to the last touched triangle, merged with any range not uploaded yet (several
 * updates can run before a render, and dropping theirs would leave stale vertices on the GPU). Per-row
 * ranges would each be a bufferSubData into a buffer of tens of MB the GPU may still be reading, which
 * some drivers pay for with a copy of the whole buffer per call (≈ 1 s frames on a 100×100-cell level at
 * resolution 4). The bounds grow by union (they never shrink during a preview). Returns the number of
 * triangles updated, or −1 when the mesh was not built on `ground`'s lattice spacing (rebuild it instead).
 */
export function updateTerrainGeometry(
  geometry: THREE.BufferGeometry,
  offsets: Float32Array,
  ground: GroundSampler,
  dirty: { x: number; z: number; w: number; d: number } | null,
  rows?: Int32Array | null
): number {
  const s = ground.spacing
  const built = geometry.userData.terrainSpacing as number | undefined
  const H = ground.heights
  if (!H || (built !== undefined && Math.abs(built - s) > 1e-9)) return -1
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute
  const nrm = geometry.getAttribute("normal") as THREE.BufferAttribute
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
  const inside = (k: number) => P[k] >= x0 && P[k] <= x1 && P[k + 2] >= z0 && P[k + 2] <= z1
  // Span of the touched triangles (floats), uploaded as one range per attribute below.
  let upFirst = Infinity
  let upLast = -1
  // Triangles [t0, t1): update those with a vertex inside.
  const visit = (t0: number, t1: number) => {
    for (let t = t0; t < t1; t++) {
      const k = t * 9
      if (!inside(k) && !inside(k + 3) && !inside(k + 6)) continue
      for (let v = 0; v < 3; v++) {
        const q = k + v * 3
        const sx = Math.round(P[q] * inv)
        const sz = Math.round(P[q + 2] * inv)
        const h = sx >= 0 && sz >= 0 && sx < SX && sz < SZ ? H[sz * SX + sx] : 0
        const y = (P[q + 1] = E + h + offsets[t * 3 + v])
        if (P[q] < minX) minX = P[q]
        if (P[q] > maxX) maxX = P[q]
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        if (P[q + 2] < minZ) minZ = P[q + 2]
        if (P[q + 2] > maxZ) maxZ = P[q + 2]
      }
      if (offsets[t * 3] === 0 && offsets[t * 3 + 1] === 0 && offsets[t * 3 + 2] === 0) {
        // Top triangle: the lattice's smooth normals (ground.normalAt).
        for (let v = 0; v < 9; v += 3) {
          ground.normalAt(Math.round(P[k + v] * inv), Math.round(P[k + v + 2] * inv), _n)
          N[k + v] = _n[0]
          N[k + v + 1] = _n[1]
          N[k + v + 2] = _n[2]
        }
        if (k < upFirst) upFirst = k
        if (k + 9 > upLast) upLast = k + 9
        count++
        continue
      }
      const ux = P[k + 3] - P[k]
      const uy = P[k + 4] - P[k + 1]
      const uz = P[k + 5] - P[k + 2]
      const vx = P[k + 6] - P[k]
      const vy = P[k + 7] - P[k + 1]
      const vz = P[k + 8] - P[k + 2]
      const nx = uy * vz - uz * vy
      const ny = uz * vx - ux * vz
      const nz = ux * vy - uy * vx
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1
      for (let v = 0; v < 9; v += 3) {
        N[k + v] = nx / len
        N[k + v + 1] = ny / len
        N[k + v + 2] = nz / len
      }
      if (k < upFirst) upFirst = k
      if (k + 9 > upLast) upLast = k + 9
      count++
    }
  }
  if (rows && dirty) {
    const r0 = Math.floor(z0 * inv) - 1
    const r1 = Math.ceil(z1 * inv)
    const xMin = x0 - s
    for (let e = 0; e + 2 < rows.length; e += 3) {
      const sz = rows[e]
      if (sz < r0 || sz > r1) continue
      // First triangle of a cell that can reach x0 (its first vertex at x ≥ x0 − spacing) ...
      let lo = rows[e + 1]
      let hi = rows[e + 2]
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (P[mid * 9] < xMin) lo = mid + 1
        else hi = mid
      }
      // ... up to the last one starting at or before x1.
      let end = lo
      while (end < rows[e + 2] && P[end * 9] <= x1) end++
      visit(lo, end)
    }
  } else visit(0, P.length / 9)
  if (count > 0) {
    for (const a of [pos, nrm]) {
      let lo = upFirst
      let hi = upLast
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
