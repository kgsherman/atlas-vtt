import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { buildOcclusionWorld, heightmapDiffRect, primitiveBounds } from "@/core/occlusion"
import type { Heightfield, OccluderPrimitive, OrientedBox, VerticalCylinder, WallStrip } from "@/core/occlusion/types"
import { createScene } from "@/core/scene/factory"
import { createHeightmap } from "@/core/scene/heightmap"
import { blockShape, writeTerrain } from "@/core/scene/terrainShapes"
import type { Scene } from "@/core/scene/types"
import { GroundSampler } from "../builders/ground"
import { LAYER } from "../internal"
import { heightfieldChunks } from "./geometry"
import { OccluderProxies, primitiveAabb, PROXY_BUCKET_FEET, proxyLayerMask, samePrimitive } from "./proxies"

const blocks = (light: boolean, sight: boolean) => ({ movement: true, light, sight })

const box = (key: string, x: number, z: number, o: Partial<OrientedBox> = {}): OrientedBox => ({
  key,
  sourceId: key.split("#")[0],
  sourceType: "wall",
  levelId: "L1",
  blocks: blocks(true, true),
  shape: "box",
  center: { x, y: 5, z },
  halfExtents: { x: 5, y: 5, z: 0.25 },
  yaw: 0,
  ...o,
})

const cyl = (key: string, x: number, z: number, o: Partial<VerticalCylinder> = {}): VerticalCylinder => ({
  key,
  sourceId: key,
  sourceType: "pillar",
  levelId: "L1",
  blocks: blocks(true, true),
  shape: "cylinder",
  base: { x, y: 0, z },
  radius: 1,
  height: 10,
  ...o,
})

const strip = (key: string, x: number, z: number, o: Partial<WallStrip> = {}): WallStrip => ({
  key,
  sourceId: key.split("#")[0],
  sourceType: "wall",
  levelId: "L1",
  blocks: blocks(true, true),
  shape: "strip",
  center: { x, z },
  halfExtents: { x: 5, z: 0.25 },
  yaw: 0.3,
  knots: [-5, -1, 2.5, 5],
  top: [8, 9.5, 7, 10],
  bottom: -0.05,
  ...o,
})

function heightfield(key: string): Heightfield {
  const n = 20
  return {
    key,
    sourceId: key,
    sourceType: "floor",
    levelId: "L1",
    blocks: blocks(true, true),
    shape: "heightfield",
    originX: 0,
    originZ: 0,
    spacing: 2.5,
    samplesX: n + 1,
    samplesZ: n + 1,
    heights: new Float32Array((n + 1) * (n + 1)),
    solid: new Uint8Array(n * n).fill(1),
    thickness: 1,
  }
}

const instanced = (p: OccluderProxies) => p.scene.children.filter((o): o is THREE.InstancedMesh => (o as THREE.InstancedMesh).isInstancedMesh)

describe("OccluderProxies", () => {
  it("groups boxes / prisms per level, channel mask and bucket, with layers per channel", () => {
    const material = new THREE.MeshBasicMaterial()
    const p = new OccluderProxies(material)
    p.rebuild({
      primitives: [
        box("w1", 10, 10),
        box("w2", 20, 10),
        box("w3", 10 + PROXY_BUCKET_FEET, 10), // other bucket
        box("win#sill", 30, 10, { blocks: blocks(true, false) }), // light only
        cyl("p1", 40, 40),
        box("mv", 50, 50, { blocks: blocks(false, false) }), // movement-only: no proxy
      ],
    })
    const meshes = instanced(p)
    expect(meshes).toHaveLength(4)
    const counts = meshes.map((m) => m.count).sort()
    expect(counts).toEqual([1, 1, 1, 2])
    const lightOnly = meshes.find((m) => m.layers.mask === 1 << LAYER.LIGHT)
    expect(lightOnly?.count).toBe(1)
    const both = meshes.filter((m) => m.layers.mask === ((1 << LAYER.LIGHT) | (1 << LAYER.SIGHT)))
    expect(both).toHaveLength(3)
    for (const m of meshes) {
      expect(m.layers.test(new THREE.Layers())).toBe(false) // never on the VISUAL layer
      expect(m.matrixWorldAutoUpdate).toBe(false)
      expect(m.material).toBe(material)
    }
    expect(p.primitiveCount).toBe(5)
    expect(p.scene.matrixWorldAutoUpdate).toBe(false)
  })

  it("writes instance matrices and per-instance keys", () => {
    const p = new OccluderProxies(new THREE.MeshBasicMaterial())
    p.rebuild({ primitives: [box("w1", 10, 20)] })
    const [mesh] = instanced(p)
    const m = new THREE.Matrix4()
    mesh.getMatrixAt(0, m)
    const corner = new THREE.Vector3(0.5, 0.5, 0.5).applyMatrix4(m)
    expect(corner.toArray()).toEqual([15, 10, 20.25])
    const keys = mesh.geometry.getAttribute("aKey")
    expect(keys.getX(0)).toBe(p.keyId("w1"))
    expect(mesh.boundingSphere).not.toBeNull()
  })

  it("diffs updates: unchanged content is not dirty, moves/removals/additions report old+new bounds", () => {
    const p = new OccluderProxies(new THREE.MeshBasicMaterial())
    const a = box("a", 10, 10)
    const b = box("b", 30, 10)
    p.rebuild({ primitives: [a, b] })
    // Same content, new objects → nothing dirty.
    expect(p.update({ primitives: [{ ...a }, { ...b }] })).toEqual([])
    // Door closes: new primitive; wall b moves; nothing removed.
    const door = box("door#leaf", 20, 10, { sourceType: "door", halfExtents: { x: 2, y: 3.5, z: 0.1 } })
    const moved = box("b", 35, 10)
    const dirty = p.update({ primitives: [a, moved, door] })
    expect(dirty).toHaveLength(3) // b old, b new, door new
    expect(dirty.map((d) => d.min.x).sort((x, y) => x - y)).toEqual([18, 25, 30])
    expect(instanced(p)[0].count).toBe(3)
    // Door opens: removed → one dirty region, instance gone.
    const opened = p.update({ primitives: [a, moved] })
    expect(opened).toHaveLength(1)
    expect(opened[0].min.x).toBe(18)
    expect(instanced(p)[0].count).toBe(2)
    // Everything removed: the group mesh is dropped.
    p.update({ primitives: [] })
    expect(instanced(p)).toHaveLength(0)
  })

  it("grows instance capacity and keeps keys stable", () => {
    const p = new OccluderProxies(new THREE.MeshBasicMaterial())
    const prims: OccluderPrimitive[] = Array.from({ length: 5 }, (_, k) => box(`w${k}`, 5 + k, 5))
    p.rebuild({ primitives: prims })
    const id3 = p.keyId("w3")
    const more = [...prims, ...Array.from({ length: 20 }, (_, k) => box(`x${k}`, 5 + k, 7))]
    p.update({ primitives: more })
    const [mesh] = instanced(p)
    expect(mesh.count).toBe(25)
    expect(mesh.instanceMatrix.count).toBeGreaterThanOrEqual(25)
    expect(p.keyId("w3")).toBe(id3)
  })

  it("builds closed chunked heightfield meshes with per-vertex keys", () => {
    const p = new OccluderProxies(new THREE.MeshBasicMaterial())
    p.rebuild({ primitives: [heightfield("floor1")] })
    const meshes = p.scene.children.filter((o) => (o as THREE.Mesh).isMesh && !(o as THREE.InstancedMesh).isInstancedMesh) as THREE.Mesh[]
    // 20×20 lattice cells in 16-cell chunks → 4 chunks.
    expect(meshes).toHaveLength(4)
    const key = p.keyId("floor1")
    for (const m of meshes) {
      const k = m.geometry.getAttribute("aKey")
      expect(k.count).toBe(m.geometry.getAttribute("position").count)
      expect(k.getX(0)).toBe(key)
    }
    expect(p.levelMeshes("L1")).toHaveLength(4)
    // Changing heights moves the chunk holding them, in place; identical arrays do nothing.
    const hf = heightfield("floor1")
    expect(p.update({ primitives: [hf] })).toEqual([])
    const raised = heightfield("floor1")
    raised.heights[5] = 2
    expect(p.update({ primitives: [raised] })).toHaveLength(1)
  })

  it("computes bounds and content equality", () => {
    const b = primitiveAabb(box("r", 0, 0, { yaw: Math.PI / 2 }))
    expect(b.min.x).toBeCloseTo(-0.25, 10)
    expect(b.max.z).toBeCloseTo(5, 10)
    const c = primitiveAabb(cyl("c", 1, 2))
    expect(c.min.toArray()).toEqual([0, 0, 1])
    expect(c.max.toArray()).toEqual([2, 10, 3])
    expect(samePrimitive(box("a", 1, 2), box("a", 1, 2))).toBe(true)
    expect(samePrimitive(box("a", 1, 2), box("a", 1, 2, { yaw: 0.1 }))).toBe(false)
    expect(samePrimitive(box("a", 1, 2), box("a", 1, 2, { blocks: blocks(true, false) }))).toBe(false)
    expect(proxyLayerMask({ blocks: blocks(false, true) })).toBe(1 << LAYER.SIGHT)
    const p = new OccluderProxies(new THREE.MeshBasicMaterial())
    expect(p.bounds()).toBeNull()
    p.rebuild({ primitives: [box("a", 10, 10), cyl("c", 100, 50)] })
    const all = p.bounds()!
    expect(all.min.x).toBe(5)
    expect(all.max.x).toBe(101)
  })
})

describe("OccluderProxies: wall strips", () => {
  const plainMeshes = (p: OccluderProxies) =>
    p.scene.children.filter((o): o is THREE.Mesh => (o as THREE.Mesh).isMesh && !(o as THREE.InstancedMesh).isInstancedMesh)

  it("merges strips per level, channel mask and bucket into closed meshes with per-vertex keys", () => {
    const p = new OccluderProxies(new THREE.MeshBasicMaterial())
    p.rebuild({
      primitives: [
        strip("a", 10, 10),
        strip("b", 30, 20, { yaw: -1.2 }),
        strip("c", 10 + PROXY_BUCKET_FEET, 10), // other bucket
        strip("d#lintel:x", 40, 40, { blocks: blocks(true, false) }), // light only
        strip("e", 50, 50, { levelId: "L2" }),
        strip("mv", 60, 60, { blocks: blocks(false, false) }), // movement only: no proxy
        box("w", 20, 20),
      ],
    })
    const meshes = plainMeshes(p)
    expect(meshes).toHaveLength(4)
    expect(instanced(p)).toHaveLength(1)
    expect(p.meshCount).toBe(5)
    expect(p.primitiveCount).toBe(6)
    const both = meshes.find((m) => m.name === `occluders:L1|${(1 << LAYER.LIGHT) | (1 << LAYER.SIGHT)}|strip|0,0`)!
    expect(both).toBeTruthy()
    expect(both.layers.mask).toBe((1 << LAYER.LIGHT) | (1 << LAYER.SIGHT))
    expect(both.matrixWorldAutoUpdate).toBe(false)
    expect(both.geometry.boundingSphere).not.toBeNull()
    // Two members: each vertex carries its strip's key; the vertices of "a" lie in its footprint.
    const keys = both.geometry.getAttribute("aKey")
    const pos = both.geometry.getAttribute("position")
    expect(keys.count).toBe(pos.count)
    const seen = new Set<number>()
    const aBounds = primitiveBounds(strip("a", 10, 10))
    for (let k = 0; k < keys.count; k++) {
      seen.add(keys.getX(k))
      if (keys.getX(k) === p.keyId("a")) {
        expect(pos.getX(k)).toBeGreaterThanOrEqual(aBounds.minX - 1e-4)
        expect(pos.getX(k)).toBeLessThanOrEqual(aBounds.maxX + 1e-4)
        expect(pos.getY(k)).toBeLessThanOrEqual(aBounds.maxY + 1e-4)
      }
    }
    expect([...seen].sort()).toEqual([p.keyId("a"), p.keyId("b")].sort())
    expect(p.levelMeshes("L2")).toHaveLength(1)
    expect(meshes.find((m) => m.layers.mask === 1 << LAYER.LIGHT)).toBeTruthy()
  })

  it("rebuilds only the touched bucket on updates, reports old and new bounds, drops empty buckets", () => {
    const p = new OccluderProxies(new THREE.MeshBasicMaterial())
    const a = strip("a", 10, 10)
    const far = strip("far", 10 + PROXY_BUCKET_FEET, 10)
    p.rebuild({ primitives: [a, far] })
    const farMesh = plainMeshes(p).find((m) => m.name.endsWith("|1,0"))!
    const farGeometry = farMesh.geometry
    // Same content, new objects: nothing dirty, nothing rebuilt.
    expect(p.update({ primitives: [strip("a", 10, 10), strip("far", 10 + PROXY_BUCKET_FEET, 10)] })).toEqual([])
    // A new profile (terrain edit): dirty old + new, only its bucket's geometry is replaced.
    const raised = strip("a", 10, 10, { top: [8, 11, 7, 10] })
    const dirty = p.update({ primitives: [raised, far] })
    expect(dirty).toHaveLength(2)
    expect(Math.max(...dirty.map((d) => d.max.y))).toBe(11)
    expect(farMesh.geometry).toBe(farGeometry)
    // Removing the last member of a bucket drops its mesh.
    p.update({ primitives: [raised] })
    expect(plainMeshes(p)).toHaveLength(1)
    // A strip turned into a box (the terrain flattened) moves to the instanced group.
    p.update({ primitives: [box("a", 10, 10)] })
    expect(plainMeshes(p)).toHaveLength(0)
    expect(instanced(p)[0].count).toBe(1)
  })

  it("computes strip bounds and content equality", () => {
    const b = primitiveAabb(strip("s", 0, 0, { yaw: 0 }))
    expect(b.min.toArray()).toEqual([-5, -0.05, -0.25])
    expect(b.max.toArray()).toEqual([5, 10, 0.25])
    const core = primitiveBounds(strip("s", 3, 4))
    const mine = primitiveAabb(strip("s", 3, 4))
    expect(mine.min.x).toBeCloseTo(core.minX, 9)
    expect(mine.max.z).toBeCloseTo(core.maxZ, 9)
    expect(mine.max.y).toBe(core.maxY)
    expect(samePrimitive(strip("s", 1, 2), strip("s", 1, 2))).toBe(true)
    expect(samePrimitive(strip("s", 1, 2), strip("s", 1, 2, { top: [8, 9.5, 7, 10.5] }))).toBe(false)
    expect(samePrimitive(strip("s", 1, 2), strip("s", 1, 2, { knots: [-5, -1, 2, 5] }))).toBe(false)
    expect(samePrimitive(strip("s", 1, 2), strip("s", 1, 2, { bottom: 0 }))).toBe(false)
    expect(samePrimitive(strip("s", 1, 2), box("s", 1, 2))).toBe(false)
  })
})

describe("OccluderProxies: terrain previews", () => {
  const plainMeshes = (p: OccluderProxies) =>
    p.scene.children.filter((o): o is THREE.Mesh => (o as THREE.Mesh).isMesh && !(o as THREE.InstancedMesh).isInstancedMesh)
  /** Positions of the plain (heightfield) meshes in chunk order. */
  const drawn = (p: OccluderProxies) => plainMeshes(p).map((m) => Array.from(m.geometry.getAttribute("position").array))
  /** What heightfieldChunks builds for `hf` (with other heights). */
  const expected = (hf: Heightfield, heights = hf.heights) => heightfieldChunks({ ...hf, heights }).map((c) => Array.from(c.positions))
  const N = 41
  /** Samples per row of heightfield(). */
  const N21 = 21
  /** Preview terrain on the heightfields' lattice (2.5 ft from the origin): a `depth` ft pit over samples 4..6 (10..15 ft). */
  function pit(depth = 3): GroundSampler {
    const h = new Float32Array(N * N)
    for (let sz = 4; sz <= 6; sz++) for (let sx = 4; sx <= 6; sx++) h[sz * N + sx] = -depth
    return new GroundSampler(0, 2.5, N, N, h)
  }
  /** `ground`'s world heights on a heightfield's lattice. */
  function sampled(hf: Heightfield, ground: GroundSampler): Float32Array {
    const i0 = Math.round(hf.originX / hf.spacing)
    const j0 = Math.round(hf.originZ / hf.spacing)
    return hf.heights.map((_, k) => ground.elevation + ground.sample(i0 + (k % hf.samplesX), j0 + Math.floor(k / hf.samplesX)))
  }
  const DIRTY = { x: 10, z: 10, w: 5, d: 5 }

  it("rewrites the heightfield chunks under the preview in place and restores them", () => {
    const p = new OccluderProxies(new THREE.MeshBasicMaterial())
    const hf = heightfield("floor1")
    p.rebuild({ primitives: [hf] })
    const meshes = plainMeshes(p)
    const geometries = meshes.map((m) => m.geometry)
    const before = drawn(p)
    const ground = pit()
    const regions = p.previewTerrain("L1", ground, DIRTY)
    // The occluders are the preview's terrain (what the sun / sky maps and the captures render).
    expect(drawn(p)).toEqual(expected(hf, sampled(hf, ground)))
    // In place: same meshes and geometries; only the chunk holding the pit was touched.
    expect(plainMeshes(p)).toEqual(meshes)
    expect(meshes.map((m) => m.geometry)).toEqual(geometries)
    expect(drawn(p).slice(1)).toEqual(before.slice(1))
    expect(meshes[0].geometry.boundingBox!.min.y).toBe(-4)
    // The changed samples 4..6 and their triangles (one cell further), down to the slab's bottom.
    expect(regions).toEqual([{ levelId: "L1", min: { x: 7.5, y: -4, z: 7.5 }, max: { x: 17.5, y: 0, z: 17.5 } }])
    expect(p.bounds()!.min.y).toBe(-4)
    expect(p.previewedLevels).toEqual(["L1"])
    // Nothing changed since: nothing to do.
    expect(p.previewTerrain("L1", ground, DIRTY)).toEqual([])
    expect(p.previewTerrain("L1", ground, null)).toEqual([])
    // Deeper, then back to the document.
    const deeper = pit(5)
    expect(p.previewTerrain("L1", deeper, DIRTY)).toHaveLength(1)
    expect(drawn(p)).toEqual(expected(hf, sampled(hf, deeper)))
    const restored = p.endPreview("L1")
    expect(restored).toHaveLength(1)
    expect(restored[0].min.y).toBe(-6)
    expect(drawn(p)).toEqual(before)
    expect(meshes[0].geometry.boundingBox!.min.y).toBe(-1)
    expect(p.bounds()!.min.y).toBe(-1)
    expect(p.previewedLevels).toEqual([])
    expect(p.endPreview("L1")).toEqual([])
    // Other levels are left alone.
    expect(p.previewTerrain("L2", ground, null)).toEqual([])
    expect(drawn(p)).toEqual(before)
  })

  it("keeps the preview through updates and gives it to heightfields rebuilt meanwhile", () => {
    const p = new OccluderProxies(new THREE.MeshBasicMaterial())
    const hf = heightfield("floor1")
    p.rebuild({ primitives: [hf, box("w1", 50, 50)] })
    const ground = pit()
    p.previewTerrain("L1", ground, null)
    // An unrelated change: the heightfield keeps the preview.
    p.update({ primitives: [hf, box("w1", 60, 50)] })
    expect(drawn(p)).toEqual(expected(hf, sampled(hf, ground)))
    // The floor changes (thicker slab): rebuilt from the world, then the preview is applied again.
    const thicker = { ...heightfield("floor1"), thickness: 2 }
    const dirty = p.update({ primitives: [thicker, box("w1", 60, 50)] })
    expect(drawn(p)).toEqual(expected(thicker, sampled(thicker, ground)))
    expect(Math.min(...dirty.map((r) => r.min.y))).toBe(-5)
    // A full rebuild ends every preview.
    p.rebuild({ primitives: [thicker] })
    expect(p.previewedLevels).toEqual([])
    expect(drawn(p)).toEqual(expected(thicker))
  })

  it("stands in for a flat level's floor boxes with heightfields on the preview's lattice", () => {
    const p = new OccluderProxies(new THREE.MeshBasicMaterial())
    const floor = box("floorA#0", 25, 25, { sourceType: "floor", center: { x: 25, y: -0.5, z: 25 }, halfExtents: { x: 25, y: 0.5, z: 25 } })
    const wall = box("w1", 30, 30)
    p.rebuild({ primitives: [floor, wall] })
    const [group] = instanced(p)
    expect(group.count).toBe(2)
    expect(plainMeshes(p)).toHaveLength(0)
    const ground = pit()
    const regions = p.previewTerrain("L1", ground, DIRTY)
    // The box leaves its group (same bucket as the wall), a heightfield over its cells takes its place.
    expect(group.count).toBe(1)
    const standIn: Heightfield = { ...heightfield("floorA#0"), heights: new Float32Array(21 * 21) }
    expect(drawn(p)).toEqual(expected(standIn, sampled(standIn, ground)))
    for (const m of plainMeshes(p)) expect(m.geometry.getAttribute("aKey").getX(0)).toBe(p.keyId("floorA#0"))
    expect(p.levelMeshes("L1")).toHaveLength(5)
    expect(p.meshCount).toBe(5)
    expect(regions.some((r) => r.min.y === -1 && r.max.x === 50)).toBe(true)
    // Later previews move the stand-ins in place; unrelated updates keep them.
    const standIns = plainMeshes(p)
    p.previewTerrain("L1", pit(5), DIRTY)
    expect(plainMeshes(p)).toEqual(standIns)
    expect(standIns[0].geometry.boundingBox!.min.y).toBe(-6)
    p.update({ primitives: [floor, box("w1", 35, 30)] })
    expect(plainMeshes(p)).toEqual(standIns)
    expect(group.count).toBe(1)
    // The floor goes: so does its stand-in.
    p.update({ primitives: [box("w1", 35, 30)] })
    expect(plainMeshes(p)).toHaveLength(0)
    expect(group.count).toBe(1)
    // It comes back while the preview lasts: a stand-in again, from the whole preview.
    p.update({ primitives: [floor, box("w1", 35, 30)] })
    expect(group.count).toBe(1)
    expect(drawn(p)).toEqual(expected(standIn, sampled(standIn, pit(5))))
    // The preview ends: the box is back, the stand-in gone.
    expect(p.endPreview("L1").length).toBeGreaterThan(0)
    expect(plainMeshes(p)).toHaveLength(0)
    expect(group.count).toBe(2)
    expect(p.meshCount).toBe(1)
  })

  it("moves a heightfield whose heights changed on the same lattice in place: only the chunks holding a change, only they dirty", () => {
    const p = new OccluderProxies(new THREE.MeshBasicMaterial())
    const hf = heightfield("floor1")
    p.rebuild({ primitives: [hf] })
    const meshes = plainMeshes(p)
    const geometries = meshes.map((m) => m.geometry)
    const before = drawn(p)
    // Sample (18, 18): chunk (1, 1) only (chunks draw samples 0..16 and 16..20 along each axis).
    const raised = { ...hf, heights: hf.heights.slice() }
    raised.heights[18 * N21 + 18] = 3
    const dirty = p.update({ primitives: [raised] })
    expect(plainMeshes(p)).toEqual(meshes)
    expect(meshes.map((m) => m.geometry)).toEqual(geometries)
    expect(drawn(p)).toEqual(expected(raised))
    expect(drawn(p).slice(0, 3)).toEqual(before.slice(0, 3))
    // That chunk's old ∪ new bounds (40..50 ft), not the whole floor's (0..50 ft).
    expect(dirty).toEqual([{ levelId: "L1", min: { x: 40, y: -1, z: 40 }, max: { x: 50, y: 3, z: 50 } }])
    expect(p.bounds()!.max.y).toBe(3)
    // A sample on a chunk edge (16, 4) is drawn by both chunks of its row: one region over the run.
    const edge = { ...raised, heights: raised.heights.slice() }
    edge.heights[4 * N21 + 16] = -2
    expect(p.update({ primitives: [edge] })).toEqual([{ levelId: "L1", min: { x: 0, y: -3, z: 0 }, max: { x: 50, y: 0, z: 40 } }])
    expect(plainMeshes(p)).toEqual(meshes)
    expect(drawn(p)).toEqual(expected(edge))
    // Changes in two chunk rows: a region per row.
    const rows = { ...edge, heights: edge.heights.slice() }
    rows.heights[2 * N21 + 2] = 1
    rows.heights[18 * N21 + 2] = 1
    expect(p.update({ primitives: [rows] }).map((r) => [r.min.z, r.max.z])).toEqual([
      [0, 40],
      [40, 50],
    ])
    expect(drawn(p)).toEqual(expected(rows))
    // Another lattice (a thicker slab, another solid mask): rebuilt, the whole floor dirty.
    const thicker = { ...rows, thickness: 2 }
    const d = p.update({ primitives: [thicker] })
    expect(plainMeshes(p).some((m) => meshes.includes(m))).toBe(false)
    expect(drawn(p)).toEqual(expected(thicker))
    expect(d.some((r) => r.min.x === 0 && r.min.z === 0 && r.max.x === 50 && r.max.z === 50)).toBe(true)
    const rebuilt = plainMeshes(p)
    const holed = { ...thicker, solid: thicker.solid.slice() }
    holed.solid[0] = 0
    p.update({ primitives: [holed] })
    expect(plainMeshes(p).some((m) => rebuilt.includes(m))).toBe(false)
    expect(drawn(p)).toEqual(expected(holed))
  })

  it("ends a committed level's preview by moving its heightfields from the previewed heights to the committed ones", () => {
    const p = new OccluderProxies(new THREE.MeshBasicMaterial())
    const hf = heightfield("floor1")
    p.rebuild({ primitives: [hf] })
    const meshes = plainMeshes(p)
    // A drag released: the commit is what the preview shows. Nothing moves, nothing is dirty.
    const ground = pit()
    p.previewTerrain("L1", ground, DIRTY)
    const committed = { ...hf, heights: sampled(hf, ground) }
    expect(p.update({ primitives: [committed] }, ["L1"])).toEqual([])
    expect(p.previewedLevels).toEqual([])
    expect(plainMeshes(p)).toEqual(meshes)
    expect(drawn(p)).toEqual(expected(committed))
    expect(p.bounds()!.min.y).toBe(-4)
    // The commit differs from the preview in chunk (1, 1) only: only that chunk moves.
    p.previewTerrain("L1", pit(5), DIRTY)
    const other = { ...hf, heights: sampled(hf, pit(5)) }
    other.heights[18 * N21 + 18] = 2
    expect(p.update({ primitives: [other] }, ["L1"])).toEqual([{ levelId: "L1", min: { x: 40, y: -1, z: 40 }, max: { x: 50, y: 2, z: 50 } }])
    expect(plainMeshes(p)).toEqual(meshes)
    expect(drawn(p)).toEqual(expected(other))
    // The commit left the heightfield as it was (refused, or elsewhere on the level): back from the preview to it.
    p.previewTerrain("L1", pit(3), DIRTY)
    expect(drawn(p)).not.toEqual(expected(other))
    expect(p.update({ primitives: [other] }, ["L1"])).toHaveLength(1)
    expect(drawn(p)).toEqual(expected(other))
    expect(p.bounds()!.min.y).toBe(-6)
    // Without `ending` the preview lasts (an unrelated update).
    p.previewTerrain("L1", pit(3), DIRTY)
    p.update({ primitives: [other] })
    expect(p.previewedLevels).toEqual(["L1"])
    // A commit on another lattice (a thicker slab) rebuilds it: what the preview drew (a 4 ft mound) is dirty too.
    p.previewTerrain("L1", pit(-4), DIRTY)
    const thicker = { ...other, thickness: 2 }
    const dirty = p.update({ primitives: [thicker] }, ["L1"])
    expect(p.previewedLevels).toEqual([])
    expect(drawn(p)).toEqual(expected(thicker))
    expect(Math.max(...dirty.map((r) => r.max.y))).toBe(4)
  })

  it("commits a terrain shape nudge on a resolution-4 level in place, as a rebuild would draw it", () => {
    const scene: Scene = createScene({ width: 60, depth: 60 })
    const levelId = Object.keys(scene.levels)[0]
    const level = { ...scene.levels[levelId], heightmap: createHeightmap(4) }
    writeTerrain(level, scene.grid, { upsert: [blockShape("hill", { x: 100, z: 100, w: 40, d: 40 }, 0, 5, 0)] })
    scene.levels[levelId] = level
    const hm = level.heightmap!
    const te = level.terrainEdits!
    const nudged = { ...level, heightmap: { ...hm, chunks: { ...hm.chunks } }, terrainEdits: { shapes: { ...te.shapes }, baseChunks: { ...te.baseChunks } } }
    writeTerrain(nudged, scene.grid, { upsert: [blockShape("hill", { x: 105, z: 100, w: 40, d: 40 }, 0, 5, 0)] })
    const next: Scene = { ...scene, levels: { ...scene.levels, [levelId]: nudged } }
    const rect = heightmapDiffRect(hm, nudged.heightmap, scene.grid)!
    const byName = (p: OccluderProxies) => new Map(plainMeshes(p).map((m) => [m.name, m] as const))
    const want = new OccluderProxies(new THREE.MeshBasicMaterial())
    want.rebuild(buildOcclusionWorld(next))
    for (const drag of [false, true]) {
      const world = buildOcclusionWorld(scene)
      const p = new OccluderProxies(new THREE.MeshBasicMaterial())
      p.rebuild(world)
      const meshes = byName(p)
      expect(meshes.size).toBe(225)
      const geometries = new Set([...meshes.values()].map((m) => m.geometry))
      if (drag) p.previewTerrain(levelId, GroundSampler.forLevel(nudged, scene.grid), rect)
      world.updateTerrain(next, levelId, rect)
      const dirty = p.update(world, [levelId])
      // No new mesh or geometry (nothing to upload whole), the positions a fresh build draws.
      expect(new Set(plainMeshes(p).map((m) => m.geometry))).toEqual(geometries)
      const got = byName(p)
      for (const [name, m] of byName(want)) {
        expect(got.get(name), name).toBe(meshes.get(name))
        expect(Array.from(got.get(name)!.geometry.getAttribute("position").array), name).toEqual(Array.from(m.geometry.getAttribute("position").array))
      }
      expect(p.bounds()).toEqual(want.bounds())
      // Dirty: the chunks along the block's moved edges (20 ft chunks), not the 300 ft level. After the
      // preview of the same move there is nothing left to move.
      if (drag) expect(dirty).toEqual([])
      else {
        expect(dirty.length).toBeGreaterThan(0)
        for (const r of dirty) expect(r.max.x - r.min.x).toBeLessThanOrEqual(40)
      }
    }
  })
})
