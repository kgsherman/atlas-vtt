import * as THREE from "three"
import { describe, expect, it } from "vitest"

import {
  createConnector,
  createDoor,
  createFloor,
  createLevel,
  createLight,
  createPillar,
  createProp,
  createScene,
  createToken,
  createWall,
  createWindow,
} from "@/core/scene/factory"
import { createHeightmap, denseHeights, sampleHeight, writeHeights } from "@/core/scene/heightmap"
import { connectorGround, levelCeilingY, wallNormal } from "@/core/scene/queries"
import type { Scene, SceneObject } from "@/core/scene/types"

import { SURF, WORLD_ATTRIBUTES } from "../internal"
import { BuildContext, buildLevel, BUCKETS } from "./index"
import { doorLeafPose, doorLeaves, type DoorLeaf } from "./doors"
import { updateTerrainGeometry } from "./floors"
import { GroundSampler } from "./ground"
import { pillarExtent, propPlacement } from "./props"
import { writeBox, writePrism } from "./shapes"
import { openingHole, splitWall, wallFrame, wallPieces } from "./walls"
import { MeshWriter, rangeIdAt } from "./writer"

function add(scene: Scene, ...objs: SceneObject[]): void {
  for (const o of objs) scene.objects[o.id] = o
}

function groundLevelId(scene: Scene): string {
  return Object.keys(scene.levels)[0]
}

/** Every vertex attribute of a world geometry, validated. */
function expectWorldGeometry(g: THREE.BufferGeometry): void {
  for (const name of WORLD_ATTRIBUTES) expect(g.getAttribute(name), name).toBeTruthy()
  const pos = g.getAttribute("position")
  const n = pos.count
  expect(g.getAttribute("normal").count).toBe(n)
  expect(g.getAttribute("color").count).toBe(n)
  expect(g.getAttribute("aSurf").count).toBe(n)
  expect(g.getAttribute("aSurf").itemSize).toBe(1)
  const nrm = g.getAttribute("normal")
  const col = g.getAttribute("color")
  const surf = g.getAttribute("aSurf")
  for (let k = 0; k < n; k++) {
    expect(Number.isFinite(pos.getX(k) + pos.getY(k) + pos.getZ(k))).toBe(true)
    expect(Math.hypot(nrm.getX(k), nrm.getY(k), nrm.getZ(k))).toBeCloseTo(1, 4)
    expect(col.getX(k)).toBeGreaterThanOrEqual(0)
    expect([SURF.WALKABLE, SURF.FACE, SURF.CAP]).toContain(surf.getX(k))
  }
}

/** Triangle normals of a non-indexed geometry agree with their winding. */
function expectWindingMatchesNormals(g: THREE.BufferGeometry): void {
  const p = g.getAttribute("position")
  const nrm = g.getAttribute("normal")
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  for (let t = 0; t < p.count / 3; t++) {
    a.fromBufferAttribute(p, t * 3)
    b.fromBufferAttribute(p, t * 3 + 1)
    c.fromBufferAttribute(p, t * 3 + 2)
    const face = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a))
    if (face.lengthSq() < 1e-12) continue
    const avg = new THREE.Vector3(nrm.getX(t * 3) + nrm.getX(t * 3 + 1) + nrm.getX(t * 3 + 2), nrm.getY(t * 3) + nrm.getY(t * 3 + 1) + nrm.getY(t * 3 + 2), nrm.getZ(t * 3) + nrm.getZ(t * 3 + 1) + nrm.getZ(t * 3 + 2))
    expect(face.dot(avg)).toBeGreaterThan(0)
  }
}

describe("shapes", () => {
  it("writes boxes with outward normals and caps on top", () => {
    const w = new MeshWriter()
    writeBox(w, 0, 0, 0, 2, 3, 4, [1, 1, 1])
    const g = w.build()!
    expectWorldGeometry(g)
    expectWindingMatchesNormals(g)
    const p = g.getAttribute("position")
    const n = g.getAttribute("normal")
    const s = g.getAttribute("aSurf")
    for (let k = 0; k < p.count; k++) {
      const out = new THREE.Vector3(p.getX(k) - 1, p.getY(k) - 1.5, p.getZ(k) - 2)
      expect(out.dot(new THREE.Vector3(n.getX(k), n.getY(k), n.getZ(k)))).toBeGreaterThan(0)
      if (n.getY(k) > 0.7) expect(s.getX(k)).toBe(SURF.CAP)
      else expect(s.getX(k)).toBe(SURF.FACE)
    }
    expect(g.getAttribute("position").count).toBe(36)
  })

  it("writes prisms facing outward (flat and smooth)", () => {
    for (const smooth of [false, true]) {
      const w = new MeshWriter()
      writePrism(w, 5, 5, 1, 0, 2, 12, [1, 1, 1], { smooth })
      const g = w.build()!
      expectWorldGeometry(g)
      const p = g.getAttribute("position")
      const n = g.getAttribute("normal")
      for (let k = 0; k < p.count; k++) {
        const out = new THREE.Vector3(p.getX(k) - 5, p.getY(k) - 1, p.getZ(k) - 5)
        expect(out.dot(new THREE.Vector3(n.getX(k), n.getY(k), n.getZ(k)))).toBeGreaterThan(0)
      }
    }
  })
})

describe("wall splitting", () => {
  it("cuts a door into two full pieces and a lintel", () => {
    const pieces = splitWall(0, 10, 0, 10, [{ u0: 3, u1: 7, y0: -Infinity, y1: 7 }])
    expect(pieces).toEqual([
      { u0: 0, u1: 3, y0: 0, y1: 10 },
      { u0: 3, u1: 7, y0: 7, y1: 10 },
      { u0: 7, u1: 10, y0: 0, y1: 10 },
    ])
  })

  it("cuts a window into sill and lintel", () => {
    const pieces = splitWall(0, 10, -0.05, 10, [{ u0: 2, u1: 5, y0: 3, y1: 6 }])
    expect(pieces).toEqual([
      { u0: 0, u1: 2, y0: -0.05, y1: 10 },
      { u0: 2, u1: 5, y0: -0.05, y1: 3 },
      { u0: 2, u1: 5, y0: 6, y1: 10 },
      { u0: 5, u1: 10, y0: -0.05, y1: 10 },
    ])
  })

  it("merges overlapping holes and drops a lintel for a full-height door", () => {
    const pieces = splitWall(0, 10, 0, 8, [
      { u0: 2, u1: 5, y0: -Infinity, y1: 7 },
      { u0: 4, u1: 6, y0: -Infinity, y1: 8 },
    ])
    expect(pieces).toEqual([
      { u0: 0, u1: 2, y0: 0, y1: 8 },
      { u0: 2, u1: 4, y0: 7, y1: 8 },
      { u0: 6, u1: 10, y0: 0, y1: 8 },
    ])
  })

  it("extends walls at joints and follows the Terrain rule", () => {
    const scene = createScene({ width: 10, depth: 10 })
    const lv = groundLevelId(scene)
    const w1 = createWall(lv, { x: 0, z: 0 }, { x: 20, z: 0 }, { thickness: 1 })
    const w2 = createWall(lv, { x: 20, z: 0 }, { x: 20, z: 20 }, { thickness: 1 })
    const door = createDoor(w1, 10, { width: 4, height: 7 })
    add(scene, w1, w2, door)
    const ctx = new BuildContext(scene)
    const f = wallFrame(ctx, w1)!
    expect(f.extA).toBe(0)
    expect(f.extB).toBe(0.5)
    expect(f.baseY).toBe(0)
    expect(f.bottomY).toBeCloseTo(-0.05)
    const pieces = wallPieces(ctx, f)
    expect(pieces[0].u0).toBe(0)
    expect(pieces[pieces.length - 1].u1).toBe(20.5)
    expect(openingHole(f, door)).toEqual({ u0: 8, u1: 12, y0: -Infinity, y1: 7 })

    // Terrain: raise the midpoint; base follows it, bottom follows the lowest ground.
    const level = scene.levels[lv]
    const hm = createHeightmap(1)
    const dense = denseHeights(hm, scene.grid).heights
    dense[0 * 11 + 2] = 3 // sample (2, 0) at x = 10
    level.heightmap = writeHeights(hm, scene.grid, dense)
    const f2 = wallFrame(new BuildContext(scene), w1)!
    expect(f2.baseY).toBeCloseTo(3)
    expect(f2.topY).toBeCloseTo(3 + w1.height)
    expect(f2.bottomY).toBeCloseTo(-0.05)
  })
})

describe("door leaves", () => {
  const scene = createScene({ width: 10, depth: 10 })
  const lv = groundLevelId(scene)
  const wall = createWall(lv, { x: 0, z: 10 }, { x: 20, z: 10 })
  add(scene, wall)
  const ctx = new BuildContext(scene)
  const f = wallFrame(ctx, wall)!
  const n = wallNormal(wall)

  /** World position of the leaf's free edge (local x = width) at open fraction t. */
  const freeEdge = (leaf: DoorLeaf, t: number) => {
    const pose = doorLeafPose(leaf, t)
    const m = new THREE.Matrix4().makeRotationY(pose.yaw).setPosition(pose.x, pose.y, pose.z)
    return new THREE.Vector3(leaf.width, 0, 0).applyMatrix4(m)
  }

  for (const hinge of ["start", "end"] as const) {
    for (const swing of [1, -1] as const) {
      it(`swings a ${hinge}-hinged leaf to side ${swing}`, () => {
        const door = createDoor(wall, 10, { width: 4, hinge, swing })
        const [leaf] = doorLeaves(f, door)
        expect(leaf.motion).toBe("swing")
        const hingeU = hinge === "start" ? 8 : 12
        expect(leaf.pivot.x).toBeCloseTo(hingeU)
        expect(leaf.pivot.z).toBeCloseTo(10)
        const closed = freeEdge(leaf, 0)
        expect(closed.x).toBeCloseTo(hinge === "start" ? 12 : 8)
        expect(closed.z).toBeCloseTo(10)
        const open = freeEdge(leaf, 1)
        expect(open.x).toBeCloseTo(hingeU)
        expect(open.z - 10).toBeCloseTo(n.z * swing * 4)
      })
    }
  }

  it("splits double doors into two leaves hinged at both ends", () => {
    const door = createDoor(wall, 10, { width: 4, leaves: "double", swing: -1 })
    const leaves = doorLeaves(f, door)
    expect(leaves.map((l) => l.pivot.x)).toEqual([8, 12])
    for (const leaf of leaves) {
      expect(leaf.width).toBe(2)
      expect(freeEdge(leaf, 0).x).toBeCloseTo(10)
      expect(freeEdge(leaf, 1).z - 10).toBeCloseTo(-n.z * 2)
    }
  })

  it("lifts portcullises", () => {
    const door = createDoor(wall, 10, { style: "portcullis", height: 8 })
    const [leaf] = doorLeaves(f, door)
    expect(leaf.motion).toBe("lift")
    expect(doorLeafPose(leaf, 0).y).toBeCloseTo(0)
    expect(doorLeafPose(leaf, 1).y).toBeCloseTo(8 * 0.9)
    expect(doorLeafPose(leaf, 1).yaw).toBeCloseTo(leaf.yaw)
  })
})

function smallScene(): Scene {
  const scene = createScene({ width: 12, depth: 10 })
  const ground = groundLevelId(scene)
  const upper = createLevel({ name: "Upper", elevation: 10 })
  scene.levels[upper.id] = upper
  add(scene, createFloor(upper.id, { x: 0, z: 0, w: 30, d: 30 }, "wood"))
  const w1 = createWall(ground, { x: 0, z: 0 }, { x: 30, z: 0 })
  const w2 = createWall(ground, { x: 30, z: 0 }, { x: 30, z: 30 }, { material: "brick" })
  add(scene, w1, w2)
  add(scene, createDoor(w1, 10), createDoor(w2, 20, { style: "secret", state: "open" }), createDoor(w1, 22, { style: "portcullis", width: 5 }))
  add(scene, createWindow(w2, 8), createDoor(w1, 4, { style: "bars", leaves: "double", width: 3 }))
  add(scene, createConnector(ground, upper.id, { x: 10, z: 10, w: 5, d: 10 }, 0, "stairs"))
  add(scene, createConnector(ground, upper.id, { x: 20, z: 10, w: 5, d: 10 }, 1, "ramp"))
  add(scene, createConnector(ground, upper.id, { x: 40, z: 40, w: 5, d: 5 }, 2, "ladder"))
  add(scene, createPillar(ground, { x: 5, z: 25 }), createPillar(ground, { x: 7, z: 25 }, { shape: "square", height: 4 }))
  const kinds = ["table", "chair", "crate", "barrel", "chest", "bookshelf", "bed", "altar", "statue", "tree", "bush", "rock", "well", "cart"] as const
  kinds.forEach((k, i) => add(scene, createProp(ground, k, { x: 5 + i * 3, y: 0, z: 40 }, { rotationY: i * 0.3 })))
  const token = createToken(ground, { x: 2.5, z: 2.5 })
  scene.tokens[token.id] = token
  for (const preset of ["torch", "lantern", "brazier", "candle", "magical", "custom"] as const) add(scene, createLight(ground, preset, { x: 10, z: 30 }))
  add(scene, createLight(ground, "torch", { x: 0, z: 0 }, { attachedTokenId: token.id, position: { x: 0, y: 4, z: 0 } }))
  return scene
}

describe("level builders", () => {
  it("produce complete world geometry for every bucket", () => {
    const scene = smallScene()
    const ctx = new BuildContext(scene)
    let meshes = 0
    for (const levelId of Object.keys(scene.levels)) {
      const level = buildLevel(ctx, levelId)
      for (const kind of BUCKETS) {
        for (const m of level[kind].meshes) {
          meshes++
          expectWorldGeometry(m.geometry)
          expectWindingMatchesNormals(m.geometry)
          if (m.kind === "instanced") {
            expect(m.matrices.length).toBe(m.ids.length * 16)
            expect(m.colors.length).toBe(m.ids.length * 3)
            expect(m.geometry.userData.shared).toBe(true)
          }
          if (m.kind === "merged") {
            const ranges = m.geometry.userData.ranges
            const tris = m.geometry.getAttribute("position").count / 3
            expect(ranges.length).toBeGreaterThan(0)
            // Every triangle belongs to a scene object.
            for (let t = 0; t < tris; t += Math.max(1, Math.floor(tris / 50))) expect(rangeIdAt(ranges, t)).not.toBeNull()
          }
        }
      }
    }
    expect(meshes).toBeGreaterThan(10)
  })

  it("builds every door leaf and the window glass", () => {
    const scene = smallScene()
    const ground = groundLevelId(scene)
    const b = buildLevel(new BuildContext(scene), ground)
    expect(b.doors.meshes.filter((m) => m.kind === "door")).toHaveLength(5)
    expect(b.walls.meshes.map((m) => m.slot)).toEqual(["world", "glass"])
    expect(b.fixtures.meshes.find((m) => m.kind === "instanced")?.ids).toHaveLength(7)
  })

  it("marks floor tops walkable at the level elevation", () => {
    const scene = smallScene()
    const upper = Object.values(scene.levels).find((l) => l.elevation === 10)!
    const b = buildLevel(new BuildContext(scene), upper.id)
    const g = b.floors.meshes[0].geometry
    const p = g.getAttribute("position")
    const n = g.getAttribute("normal")
    const s = g.getAttribute("aSurf")
    let tops = 0
    for (let k = 0; k < p.count; k++) {
      if (n.getY(k) > 0.99) {
        tops++
        expect(p.getY(k)).toBeCloseTo(10)
        expect(s.getX(k)).toBe(SURF.WALKABLE)
      }
      // The stairs and ramp footprints are cut out of the upper floor.
      if (n.getY(k) > 0.99) expect(p.getX(k) > 10 && p.getX(k) < 15 && p.getZ(k) > 10 && p.getZ(k) < 20).toBe(false)
    }
    expect(tops).toBeGreaterThan(0)
  })

  it("rises stairs from the lower to the upper ground", () => {
    const scene = smallScene()
    const ground = groundLevelId(scene)
    const stairs = Object.values(scene.objects).find((o) => o.type === "connector" && o.style === "stairs")!
    const g = buildLevel(new BuildContext(scene), ground).connectors.meshes[0].geometry
    const p = g.getAttribute("position")
    const ranges = g.userData.ranges as { id: string; start: number; count: number }[]
    const r = ranges.find((x) => x.id === stairs.id)!
    let maxY = -Infinity
    for (let k = r.start * 3; k < (r.start + r.count) * 3; k++) maxY = Math.max(maxY, p.getY(k))
    expect(maxY).toBeCloseTo(connectorGround(scene, stairs as never, { x: 12.5, z: 19.999 }), 2)
  })

  it("applies the Terrain rule to props and pillars", () => {
    const scene = createScene({ width: 10, depth: 10 })
    const lv = groundLevelId(scene)
    const hm = createHeightmap(1)
    const dense = denseHeights(hm, scene.grid).heights
    dense[2 * 11 + 3] = -2 // sample (3, 2) at x = 15, z = 10
    scene.levels[lv].heightmap = writeHeights(hm, scene.grid, dense)
    const crate = createProp(lv, "crate", { x: 14, y: 0, z: 11 })
    const lifted = createProp(lv, "crate", { x: 14, y: 2, z: 11 })
    const pillar = createPillar(lv, { x: 14, z: 11 }, { height: null })
    add(scene, crate, lifted, pillar)
    const ctx = new BuildContext(scene)
    const g = sampleHeight(scene.levels[lv].heightmap, 5, 14, 11)
    const pl = propPlacement(ctx, crate)
    expect(pl.baseY).toBeCloseTo(g)
    expect(pl.top).toBeCloseTo(g + 3)
    expect(pl.bottom).toBeLessThan(g)
    expect(pl.bottom).toBeCloseTo(-2, 5)
    const pl2 = propPlacement(ctx, lifted)
    expect(pl2.bottom).toBeCloseTo(g + 2)
    expect(pl2.stretch).toBe(1)
    const ext = pillarExtent(ctx, pillar)
    expect(ext.top).toBeCloseTo(levelCeilingY(scene, lv))
  })

  it("moves terrain vertices in place for brush previews", () => {
    const scene = createScene({ width: 4, depth: 4 })
    const lv = groundLevelId(scene)
    scene.levels[lv].heightmap = createHeightmap(2)
    const ctx = new BuildContext(scene)
    const b = buildLevel(ctx, lv).floors.meshes[0]
    expect(b.kind === "merged" && b.terrainOffsets).toBeTruthy()
    if (b.kind !== "merged" || !b.terrainOffsets) return
    const heights = denseHeights(scene.levels[lv].heightmap!, scene.grid).heights.slice()
    heights[4 * 9 + 4] = 5 // sample (4, 4) at x = z = 10
    const sampler = GroundSampler.fromDense(scene.levels[lv], scene.grid, heights)!
    const touched = updateTerrainGeometry(b.geometry, b.terrainOffsets, sampler, { x: 9, z: 9, w: 2, d: 2 })
    expect(touched).toBeGreaterThan(0)
    const p = b.geometry.getAttribute("position")
    let found = false
    for (let k = 0; k < p.count; k++) {
      if (Math.abs(p.getX(k) - 10) < 1e-6 && Math.abs(p.getZ(k) - 10) < 1e-6) {
        found = true
        // Top vertices at the peak, bottom vertices one thickness below.
        expect([5, 4]).toContainEqual(Math.round(p.getY(k) * 1000) / 1000)
      }
    }
    expect(found).toBe(true)
    expectWindingMatchesNormals(b.geometry)
  })

  it("is deterministic", () => {
    const scene = smallScene()
    const ground = groundLevelId(scene)
    const a = buildLevel(new BuildContext(scene), ground).walls.meshes[0].geometry.getAttribute("color").array
    const b = buildLevel(new BuildContext(scene), ground).walls.meshes[0].geometry.getAttribute("color").array
    expect(Array.from(a)).toEqual(Array.from(b))
  })
})
