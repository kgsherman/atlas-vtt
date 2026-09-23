import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { createDoor, createLight, createPillar, createProp, createScene, createWall } from "@/core/scene/factory"

import { BuildContext, buildLevel, BUCKETS } from "../builders"
import { LevelView } from "./levels"
import { testMaterials } from "./testUtils"

function setup() {
  const scene = createScene({ width: 10, depth: 10 })
  const lv = Object.keys(scene.levels)[0]
  const wall = createWall(lv, { x: 0, z: 20 }, { x: 40, z: 20 })
  const door = createDoor(wall, 10)
  const crate = createProp(lv, "crate", { x: 25, y: 0, z: 25 })
  const pillar = createPillar(lv, { x: 5, z: 5 })
  const light = createLight(lv, "torch", { x: 30, z: 30 })
  for (const o of [wall, door, crate, pillar, light]) scene.objects[o.id] = o
  const m = testMaterials()
  const view = new LevelView(lv, m.level, m.shared)
  const built = buildLevel(new BuildContext(scene), lv)
  for (const k of BUCKETS) view.setBucket(k, built[k])
  return { scene, lv, view, m, wall, door, crate, pillar, light }
}

const worldMeshes = (view: LevelView) => {
  const out: THREE.Mesh[] = []
  view.group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && o.userData.slot === "world") out.push(o as THREE.Mesh)
  })
  return out
}

describe("LevelView", () => {
  it("creates meshes with the level materials and instance colours", () => {
    const { view, m } = setup()
    const meshes = worldMeshes(view)
    expect(meshes.length).toBeGreaterThan(4)
    for (const mesh of meshes) {
      const inst = (mesh as THREE.InstancedMesh).isInstancedMesh
      expect(mesh.material).toBe(inst ? m.level.opaqueInstanced : m.level.opaque)
      if (inst) expect((mesh as THREE.InstancedMesh).instanceColor).not.toBeNull()
    }
    // Nested containers are plain Object3D; only the level root is a Group.
    view.group.traverse((o) => {
      if (o !== view.group) expect((o as THREE.Group).isGroup).not.toBe(true)
    })
  })

  it("indexes objects for outlines", () => {
    const { view, wall, door, crate, light } = setup()
    expect(view.objectRefs(wall.id).map((r) => r.kind)).toEqual(["ranges"])
    expect(view.objectRefs(door.id).map((r) => r.kind)).toContain("whole")
    expect(view.objectRefs(crate.id).every((r) => r.kind === "instance")).toBe(true)
    expect(view.objectRefs(light.id).length).toBeGreaterThan(0)
  })

  it("switches to ghost materials with a depth pre-pass and back", () => {
    const { view, m } = setup()
    view.setMode("ghost")
    for (const mesh of worldMeshes(view)) {
      const inst = (mesh as THREE.InstancedMesh).isInstancedMesh
      expect(mesh.material).toBe(inst ? m.level.ghostInstanced : m.level.ghost)
      const clone = mesh.children.find((c) => (c as THREE.Mesh).isMesh) as THREE.Mesh
      expect(clone.material).toBe(inst ? m.level.ghostDepthInstanced : m.level.ghostDepth)
      expect(clone.renderOrder).toBeLessThan(mesh.renderOrder)
      if (inst) expect((clone as THREE.InstancedMesh).instanceMatrix).toBe((mesh as THREE.InstancedMesh).instanceMatrix)
    }
    view.setMode("solid")
    for (const mesh of worldMeshes(view)) {
      expect(mesh.children.some((c) => (c as THREE.Mesh).isMesh)).toBe(false)
      expect([m.level.opaque, m.level.opaqueInstanced]).toContain(mesh.material)
    }
    view.setMode("hidden")
    expect(view.group.visible).toBe(false)
  })

  it("poses door leaves", () => {
    const { view } = setup()
    const [leaf] = view.doorLeaves()
    LevelView.applyDoor(leaf, 0)
    const closedYaw = leaf.pivot.rotation.y
    LevelView.applyDoor(leaf, 1)
    expect(Math.abs(leaf.pivot.rotation.y - closedYaw)).toBeCloseTo(Math.PI / 2)
  })

  it("keeps picking away from floors and glass", () => {
    const { view } = setup()
    for (const mesh of view.pickMeshes()) expect(["glass"]).not.toContain(mesh.userData.slot)
    expect(view.pickMeshes().some((m) => m.name === "floors")).toBe(false)
  })

  it("animates flames without touching the base transforms", () => {
    const { view } = setup()
    const [f] = view.flames()
    const before = Array.from(f.base)
    view.animateFlames(1.234, () => 1.5)
    expect(Array.from(f.base)).toEqual(before)
    const arr = f.mesh.instanceMatrix.array as Float32Array
    expect(arr[0]).toBeCloseTo(before[0] * 1.5)
    expect(arr[12]).toBeCloseTo(before[12])
  })
})
