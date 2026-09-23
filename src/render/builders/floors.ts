/**
 * Floor slabs from effectiveFloorRects (connector cutouts removed). Flat levels: boxes whose top is
 * subdivided per grid cell (subtle per-cell tint so the grid reads even without the overlay).
 * Levels with a heightmap: one lattice mesh per floor over the lattice cells whose centre lies in
 * the floor's effective rects (same cells as the core/occlusion heightfield), top displaced by the
 * terrain with the heightmap's triangle split, bottom = top − thickness, skirts on the boundary.
 *
 * Terrain meshes carry a per-vertex Y offset from the ground so the heightmap brush preview can
 * move vertices in place (updateTerrainGeometry) without rebuilding.
 */
import * as THREE from "three"

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

export function floorThickness(ctx: BuildContext, floor: FloorObject): number {
  const level = ctx.level(floor.levelId)
  const th = floor.thickness ?? level?.floorThickness ?? 1
  // Visual slabs keep a minimal thickness even for degenerate documents.
  return th > 0.05 ? th : 0.05
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
    for (let i = 0; i < cellsX; i++) {
      if (!isSolid(i, j)) continue
      const sx = span.i0 + i
      const sz = span.j0 + j
      const color = cellColor(base, floor.material, Math.floor((sx * s) / cs + 1e-9), Math.floor((sz * s) / cs + 1e-9))
      const t00 = p(sx, sz, 0)
      const t10 = p(sx + 1, sz, 0)
      const t01 = p(sx, sz + 1, 0)
      const t11 = p(sx + 1, sz + 1, 0)
      // Heightmap split: triangles (00, 10, 11) and (00, 01, 11).
      tw.tri(t00, 0, t10, 0, t11, 0, [0, 1, 0], color, SURF.WALKABLE)
      tw.tri(t00, 0, t01, 0, t11, 0, [0, 1, 0], color, SURF.WALKABLE)
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
      w.begin(floor.id)
      writeFlatSlab(w, ctx, floor, e.rect, top, floorThickness(ctx, floor))
      w.end()
    }
    const g = w.build()
    if (g) meshes.push({ kind: "merged", name: "floors", slot: "world", geometry: g })
    return { meshes }
  }
  const tw = new TerrainWriter(w)
  for (const floor of ctx.ofType(levelId, "floor")) {
    w.begin(floor.id)
    writeTerrainSlab(tw, ctx, floor, ground, floorThickness(ctx, floor))
    w.end()
  }
  const g = w.build()
  if (g) {
    g.userData.terrainLevelId = levelId
    meshes.push({ kind: "merged", name: "terrain", slot: "world", geometry: g, terrainOffsets: tw.offsets.toArray() })
  }
  return { meshes }
}

/**
 * Move terrain vertices in place to follow `ground` (brush preview). Only triangles with a vertex
 * inside `dirty` (expanded by one lattice spacing) are touched; their flat normals are recomputed.
 * Returns the number of triangles updated.
 */
export function updateTerrainGeometry(geometry: THREE.BufferGeometry, offsets: Float32Array, ground: GroundSampler, dirty: { x: number; z: number; w: number; d: number } | null): number {
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute
  const nrm = geometry.getAttribute("normal") as THREE.BufferAttribute
  const P = pos.array as Float32Array
  const N = nrm.array as Float32Array
  const m = ground.spacing
  const x0 = dirty ? dirty.x - m : -Infinity
  const z0 = dirty ? dirty.z - m : -Infinity
  const x1 = dirty ? dirty.x + dirty.w + m : Infinity
  const z1 = dirty ? dirty.z + dirty.d + m : Infinity
  const tris = P.length / 9
  let first = -1
  let last = -1
  let count = 0
  const inside = (k: number) => P[k] >= x0 && P[k] <= x1 && P[k + 2] >= z0 && P[k + 2] <= z1
  for (let t = 0; t < tris; t++) {
    const k = t * 9
    if (!inside(k) && !inside(k + 3) && !inside(k + 6)) continue
    for (let v = 0; v < 3; v++) {
      const q = k + v * 3
      P[q + 1] = ground.heightAt(P[q], P[q + 2]) + offsets[t * 3 + v]
    }
    const n = faceNormal([P[k], P[k + 1], P[k + 2]], [P[k + 3], P[k + 4], P[k + 5]], [P[k + 6], P[k + 7], P[k + 8]])
    for (let v = 0; v < 3; v++) {
      N[k + v * 3] = n[0]
      N[k + v * 3 + 1] = n[1]
      N[k + v * 3 + 2] = n[2]
    }
    if (first < 0) first = k
    last = k + 9
    count++
  }
  if (count > 0) {
    pos.clearUpdateRanges()
    nrm.clearUpdateRanges()
    pos.addUpdateRange(first, last - first)
    nrm.addUpdateRange(first, last - first)
    pos.needsUpdate = true
    nrm.needsUpdate = true
    geometry.computeBoundingSphere()
    geometry.computeBoundingBox()
  }
  return count
}
