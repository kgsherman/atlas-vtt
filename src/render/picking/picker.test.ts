import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { createProp, createScene, createWall } from "@/core/scene/factory"
import { createHeightmap, denseHeights } from "@/core/scene/heightmap"
import { effectiveFloorRects } from "@/core/scene/queries"
import type { SceneLike } from "@/core/scene/types"

import { BuildContext, buildLevel, BUCKETS } from "../builders"
import { GroundSampler } from "../builders/ground"
import { LevelView } from "../engine/levels"
import { testMaterials } from "../engine/testUtils"
import { marchTerrain, Picker, planeHit, resolveHitIds } from "./picker"

describe("hit id resolution", () => {
  it("reads ids from every mesh kind", () => {
    const o = new THREE.Object3D()
    o.userData.ranges = [
      { id: "a", start: 0, count: 2 },
      { id: "b", start: 2, count: 3 },
    ]
    expect(resolveHitIds(o, 3, undefined)).toEqual({ objectId: "b", tokenId: null })
    const inst = new THREE.Object3D()
    inst.userData.instanceIds = ["p1", "p2"]
    expect(resolveHitIds(inst, 0, 1)).toEqual({ objectId: "p2", tokenId: null })
    const door = new THREE.Object3D()
    door.userData.objectId = "d"
    expect(resolveHitIds(door, 5, undefined).objectId).toBe("d")
    const tok = new THREE.Object3D()
    tok.userData.tokenIds = ["t1"]
    expect(resolveHitIds(tok, 0, 0)).toEqual({ objectId: null, tokenId: "t1" })
    expect(resolveHitIds(new THREE.Object3D(), 0, 0)).toEqual({ objectId: null, tokenId: null })
  })
})

describe("ground picking", () => {
  it("hits horizontal planes in front of the ray only", () => {
    const down = new THREE.Ray(new THREE.Vector3(1, 10, 2), new THREE.Vector3(0, -1, 0))
    expect(planeHit(down, 3)?.point).toEqual({ x: 1, y: 3, z: 2 })
    expect(planeHit(down, 20)).toBeNull()
  })

  it("marches terrain and bisects the crossing", () => {
    const scene = createScene({ width: 4, depth: 4 })
    const level = Object.values(scene.levels)[0]
    const heights = denseHeights(createHeightmap(2), scene.grid).heights.slice()
    heights[4 * 9 + 4] = 5 // peak at (10, 10)
    const g = GroundSampler.fromDense(level, scene.grid, heights)!
    const ray = new THREE.Ray(new THREE.Vector3(-20, 30, 10), new THREE.Vector3(30, -30, 0).normalize())
    const hit = marchTerrain(ray, g, () => true)!
    expect(hit).not.toBeNull()
    expect(hit.point.y).toBeCloseTo(g.heightAt(hit.point.x, hit.point.z), 3)
    // The slope rises toward the peak, so the ray meets it before reaching the plane y = 0 at x = 10.
    expect(hit.point.x).toBeLessThan(10)
    expect(hit.point.x).toBeGreaterThan(5)
    expect(marchTerrain(ray, g, () => false)).toBeNull()
  })
})

describe("Picker", () => {
  function setup() {
    const scene: SceneLike = createScene({ width: 10, depth: 10 })
    const lv = Object.keys(scene.levels)[0]
    const crate = createProp(lv, "crate", { x: 25, y: 0, z: 25 })
    const wall = createWall(lv, { x: 10, z: 40 }, { x: 40, z: 40 })
    scene.objects[crate.id] = crate
    scene.objects[wall.id] = wall
    const m = testMaterials()
    const view = new LevelView(lv, m.level, m.shared)
    const built = buildLevel(new BuildContext(scene), lv)
    for (const k of BUCKETS) view.setBucket(k, built[k])
    view.group.updateMatrixWorld(true)
    const camera = new THREE.OrthographicCamera(-25, 25, 25, -25, 0.1, 500)
    camera.position.set(25, 100, 25)
    camera.up.set(0, 0, -1)
    camera.lookAt(25, 0, 25)
    camera.updateMatrixWorld()
    camera.updateProjectionMatrix()
    const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } as unknown as HTMLCanvasElement
    const picker = new Picker({
      canvas,
      camera: () => camera,
      scene: () => scene,
      solidLevels: () => [{ levelId: lv, meshes: view.pickMeshes() }],
      tokenMeshes: () => [],
      ground: (id) => GroundSampler.forLevel(scene.levels[id], scene.grid),
      effectiveFloors: (id) => effectiveFloorRects(scene, id),
    })
    return { scene, lv, crate, wall, picker }
  }

  it("picks objects, floors and the ground under the cursor", () => {
    const { lv, crate, wall, scene, picker } = setup()
    const centre = picker.pick(50, 50, { levelId: lv, objects: true, tokens: true })
    expect(centre.objectId).toBe(crate.id)
    // The crate's lid sits just inside its 3 ft library box.
    expect(centre.hitPoint!.y).toBeCloseTo(3, 1)
    expect(centre.ground!.x).toBeCloseTo(25)
    expect(centre.ground!.y).toBe(0)
    expect(centre.ground!.z).toBeCloseTo(25)
    // Surface normals come back in world space (the crate's lid faces up).
    expect(centre.hitNormal!.y).toBeCloseTo(1)
    // (25, 40) is on the wall: screen y = 50 + (40 − 25) · 2 = 80.
    expect(picker.pick(50, 80, { levelId: lv, objects: true }).objectId).toBe(wall.id)
    const floorId = Object.values(scene.objects).find((o) => o.type === "floor")!.id
    const empty = picker.pick(10, 10, { levelId: lv, objects: true })
    expect(empty.objectId).toBe(floorId)
    expect(empty.ground!.x).toBeCloseTo(5)
    expect(empty.ground!.z).toBeCloseTo(5)
    expect(picker.pick(50, 50, { levelId: lv }).objectId).toBeNull()
  })

  it("projects world points to canvas pixels", () => {
    const { picker } = setup()
    const c = picker.project({ x: 25, y: 0, z: 25 })
    expect(c.x).toBeCloseTo(50)
    expect(c.y).toBeCloseTo(50)
    expect(c.visible).toBe(true)
    const p = picker.project({ x: 35, y: 0, z: 30 })
    expect(p.x).toBeCloseTo(70)
    expect(p.y).toBeCloseTo(60)
    expect(picker.project({ x: 500, y: 0, z: 25 }).visible).toBe(false)
  })
})
