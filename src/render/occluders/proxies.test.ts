import * as THREE from "three"
import { describe, expect, it } from "vitest"

import type { Heightfield, OccluderPrimitive, OrientedBox, VerticalCylinder } from "@/core/occlusion/types"
import { LAYER } from "../internal"
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
    // Changing heights rebuilds; identical arrays do not.
    const hf = heightfield("floor1")
    expect(p.update({ primitives: [hf] })).toEqual([])
    const raised = heightfield("floor1")
    raised.heights[5] = 2
    expect(p.update({ primitives: [raised] })).toHaveLength(2)
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
