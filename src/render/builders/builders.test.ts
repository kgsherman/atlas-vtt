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
import { connectorGround, levelCeilingY, levelGround, wallNormal } from "@/core/scene/queries"
import type { DoorObject, Scene, SceneObject, WallObject, WindowObject } from "@/core/scene/types"

import { SURF, WORLD_ATTRIBUTES } from "../internal"
import { BuildContext, buildLevel, BUCKETS } from "./index"
import { DOOR_MARKER_ACCENT, DOOR_MARKER_LIFT, DOOR_MARKER_OVERHANG, doorLeafPose, doorLeaves, type DoorLeaf } from "./doors"
import { updateTerrainGeometry } from "./floors"
import { GroundSampler } from "./ground"
import { pillarExtent, propPlacement } from "./props"
import { writeBox, writeFrameStrip, writePrism } from "./shapes"
import { openingHole, splitWall, wallFrame, wallPieceArea, wallPieces, wallPieceTopAt, type WallPiece } from "./walls"
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

/** Signed volume of a closed triangle soup by the divergence theorem (positive for outward winding). */
function signedVolume(pos: ArrayLike<number>): number {
  let v = 0
  for (let k = 0; k < pos.length; k += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = Array.from({ length: 9 }, (_, i) => pos[k + i])
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  return v / 6
}

/** Every directed edge is matched by the reverse edge equally often (closed, consistently wound). */
function expectClosed(pos: ArrayLike<number>): void {
  const key = (k: number) => `${pos[k].toFixed(4)},${pos[k + 1].toFixed(4)},${pos[k + 2].toFixed(4)}`
  const edges = new Map<string, number>()
  for (let k = 0; k < pos.length; k += 9) {
    const v = [key(k), key(k + 3), key(k + 6)]
    for (let e = 0; e < 3; e++) {
      const id = `${v[e]}>${v[(e + 1) % 3]}`
      edges.set(id, (edges.get(id) ?? 0) + 1)
    }
  }
  for (const [id, n] of edges) {
    const [a, b] = id.split(">")
    expect(edges.get(`${b}>${a}`), `edge ${id}`).toBe(n)
  }
}

/** Triangle normals of a non-indexed geometry agree with their winding. */
function expectWindingMatchesNormals(g: THREE.BufferGeometry): void {
  const p = g.getAttribute("position")
  const nrm = g.getAttribute("normal")
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const idx = g.index
  const vtx = (k: number) => (idx ? idx.getX(k) : k)
  const triangles = (idx ? idx.count : p.count) / 3
  for (let t = 0; t < triangles; t++) {
    const [i, j, k] = [vtx(t * 3), vtx(t * 3 + 1), vtx(t * 3 + 2)]
    a.fromBufferAttribute(p, i)
    b.fromBufferAttribute(p, j)
    c.fromBufferAttribute(p, k)
    const face = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a))
    if (face.lengthSq() < 1e-12) continue
    const avg = new THREE.Vector3(nrm.getX(i) + nrm.getX(j) + nrm.getX(k), nrm.getY(i) + nrm.getY(j) + nrm.getY(k), nrm.getZ(i) + nrm.getZ(j) + nrm.getZ(k))
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
    expect(f.profile.baseAt(10)).toBe(0)
    expect(f.profile.topAt(10)).toBe(w1.height)
    expect(f.profile.bottomY).toBeCloseTo(-0.05)
    const pieces = wallPieces(ctx, f)
    expect(pieces[0].u0).toBe(0)
    expect(pieces[pieces.length - 1].u1).toBe(20.5)
    // No terrain: boxes only.
    expect(pieces.every((p) => p.knots === undefined)).toBe(true)
    expect(openingHole(f, door)).toEqual({ u0: 8, u1: 12, y0: -Infinity, y1: 7 })

    // Terrain: a ridge under the middle (sample (2, 0) at x = 10, 5 ft lattice). The top follows the ground
    // along the wall; the door measures from the ground at its middle; the bottom follows the lowest ground.
    const level = scene.levels[lv]
    const hm = createHeightmap(1)
    const dense = denseHeights(hm, scene.grid).heights
    dense[0 * 11 + 2] = 3
    level.heightmap = writeHeights(hm, scene.grid, dense)
    const ctx2 = new BuildContext(scene)
    const f2 = wallFrame(ctx2, w1)!
    expect(f2.profile.follow).toBe(true)
    for (const [u, g] of [
      [0, 0],
      [5, 0],
      [7.5, 1.5],
      [10, 3],
      [13, 1.2],
      [20, 0],
    ]) {
      expect(f2.profile.topAt(u), `u = ${u}`).toBeCloseTo(g + w1.height, 9)
    }
    expect(f2.profile.bottomY).toBeCloseTo(-0.05)
    // Head = base (3) + 7, under the lowest top over the span (1.8 + 10).
    expect(openingHole(f2, door)).toEqual({ u0: 8, u1: 12, y0: -Infinity, y1: 10 })
    const sloped = wallPieces(ctx2, f2)
    // Full-height pieces and the lintel follow the ridge: strips.
    expect(sloped.filter((p) => p.knots).length).toBe(3)
    const lintel = sloped.find((p) => p.u0 === 8 && p.u1 === 12)!
    expect(lintel.y0).toBe(10)
    expect(lintel.knots).toEqual([8, 10, 12])
    expect(lintel.tops![1]).toBeCloseTo(13)

    // Follow off: the wall stands on the level elevation whatever the terrain.
    const off = { ...w1, followTerrain: false }
    scene.objects[w1.id] = off
    const f3 = wallFrame(new BuildContext(scene), off)!
    expect(f3.profile.follow).toBe(false)
    expect(f3.profile.topAt(10)).toBe(w1.height)
    expect(f3.profile.bottomY).toBeCloseTo(-0.05)
    expect(wallPieces(new BuildContext(scene), f3).every((p) => p.knots === undefined)).toBe(true)
  })
})

/** Scene with a sloped / bumpy res-2 heightmap level and the level id. */
function terrainScene(height: (x: number, z: number) => number, cells = 24): { scene: Scene; lv: string } {
  const scene = createScene({ width: cells, depth: cells })
  const lv = groundLevelId(scene)
  const hm = createHeightmap(2)
  const { samplesX, samplesZ, heights } = denseHeights(hm, scene.grid)
  const s = scene.grid.cellSize / 2
  for (let j = 0; j < samplesZ; j++) for (let i = 0; i < samplesX; i++) heights[j * samplesX + i] = height(i * s, j * s)
  scene.levels[lv].heightmap = writeHeights(hm, scene.grid, heights)
  return { scene, lv }
}

/** Highest solid point of a wall's pieces at u (the wall's top there). */
const topOfPieces = (pieces: readonly WallPiece[], u: number) => Math.max(...pieces.filter((p) => p.u0 <= u && u <= p.u1).map((p) => wallPieceTopAt(p, u)))

describe("walls on terrain", () => {
  const rng = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646

  it("draws closed, outward strips whose volume matches their profile", () => {
    const w = new MeshWriter()
    const knots = [-0.5, 2, 3.25, 7, 9.5]
    const tops = [5, 6.5, 4.2, 4.2, 8]
    writeFrameStrip(w, 3, 4, Math.cos(0.4), Math.sin(0.4), knots, tops, 1, -0.25, 0.25, [1, 1, 1])
    const g = w.build()!
    expectWorldGeometry(g)
    expectWindingMatchesNormals(g)
    const pos = g.getAttribute("position").array
    expectClosed(pos)
    const piece: WallPiece = { u0: -0.5, u1: 9.5, y0: 1, y1: 8, knots, tops }
    expect(signedVolume(pos)).toBeCloseTo(wallPieceArea(piece) * 0.5, 4)
    // Tops touching the bottom (a lintel clamped to the lowest top): still closed.
    const w2 = new MeshWriter()
    writeFrameStrip(w2, 0, 0, 1, 0, [0, 2, 4], [3, 1, 3], 1, -0.5, 0.5, [1, 1, 1])
    const g2 = w2.build()!
    expectWorldGeometry(g2)
    expectClosed(g2.getAttribute("position").array)
    expect(signedVolume(g2.getAttribute("position").array)).toBeCloseTo(4, 6)
  })

  it("puts follow-terrain tops on the level ground + height at random u (and off: elevation + height)", () => {
    const { scene, lv } = terrainScene((x, z) => 6 * Math.sin(x / 13) * Math.cos(z / 17) + 0.02 * x)
    scene.levels[lv].elevation = 2
    const r = rng(7)
    const walls: WallObject[] = []
    // Inside the lattice (x, z in [0, 120]): outside it the ground steps to the elevation (a known limit).
    const inside = (v: number) => Math.min(115, Math.max(5, v))
    for (let k = 0; k < 12; k++) {
      const a = { x: 10 + r() * 90, z: 10 + r() * 90 }
      const ang = k % 3 === 0 ? (Math.floor(r() * 4) * Math.PI) / 2 : r() * Math.PI * 2
      const len = 8 + r() * 30
      const b = { x: inside(a.x + Math.cos(ang) * len), z: inside(a.z + Math.sin(ang) * len) }
      const wall = createWall(lv, a, b, { height: 8, followTerrain: k !== 5 })
      walls.push(wall)
      add(scene, wall)
    }
    const ctx = new BuildContext(scene)
    let strips = 0
    for (const wall of walls) {
      const f = wallFrame(ctx, wall)!
      const pieces = wallPieces(ctx, f)
      strips += pieces.filter((p) => p.knots).length
      for (let q = 0; q < 40; q++) {
        const u = r() * f.len
        const x = wall.a.x + f.dir.x * u
        const z = wall.a.z + f.dir.z * u
        const expected = wall.followTerrain ? levelGround(scene, lv, x, z) + 8 : 2 + 8
        expect(topOfPieces(pieces, u), `${wall.id} at ${u}`).toBeCloseTo(expected, 5)
      }
      // The flat bottom reaches below the ground everywhere under the wall.
      for (let q = 0; q <= 20; q++) {
        const u = (f.len * q) / 20
        expect(f.profile.bottomY).toBeLessThan(levelGround(scene, lv, wall.a.x + f.dir.x * u, wall.a.z + f.dir.z * u))
      }
    }
    expect(strips).toBeGreaterThan(5)
    // The merged mesh is valid and its highest point is the highest top.
    const g = buildLevel(ctx, lv).walls.meshes[0].geometry
    expectWorldGeometry(g)
    expectWindingMatchesNormals(g)
  })

  it("seats doors and windows on the ground at their middle, under the lowest top of their span", () => {
    // Slope of 0.25 ft per ft along x (the wall's direction); flat across it.
    const { scene, lv } = terrainScene((x) => 0.25 * x)
    const wall = createWall(lv, { x: 10, z: 40 }, { x: 70, z: 40 }, { height: 10, thickness: 0.5 })
    const door = createDoor(wall, 15, { width: 4, height: 7, style: "portcullis" })
    const win = createWindow(wall, 40, { width: 4, sillHeight: 3, height: 4 })
    add(scene, wall, door, win)
    const ctx = new BuildContext(scene)
    const f = wallFrame(ctx, wall)!
    const ground = (u: number) => levelGround(scene, lv, 10 + u, 40)
    // Door [13, 17]: base = ground(15), head = base + 7 (below the lowest top, ground(13) + 10).
    const doorBase = ground(15)
    expect(openingHole(f, door as DoorObject)).toEqual({ u0: 13, u1: 17, y0: -Infinity, y1: expect.closeTo(doorBase + 7, 9) })
    const [leaf] = doorLeaves(f, door as DoorObject)
    expect(leaf.pivot.y).toBeCloseTo(doorBase, 9)
    expect(leaf.top).toBeCloseTo(7, 9)
    expect(leaf.lift).toBeCloseTo(7 * 0.9, 9)
    // The leaf reaches the lowest ground under the opening, not the wall's bottom far downhill.
    expect(leaf.bottom).toBeCloseTo(ground(13) - 0.05 - doorBase, 9)
    expect(f.profile.bottomY).toBeLessThan(doorBase + leaf.bottom - 3)
    // The top-down marker sits on the highest top over the leaf.
    expect(leaf.wallTop).toBeCloseTo(ground(17) + 10 - doorBase, 9)
    const marker = buildLevel(ctx, lv).doors.meshes.find((m) => m.kind === "door")
    if (marker?.kind !== "door") throw new Error("no door leaf")
    marker.marker!.computeBoundingBox()
    expect(marker.marker!.boundingBox!.min.y).toBeCloseTo(leaf.wallTop + DOOR_MARKER_LIFT, 5)
    // Window [38, 42]: sill and head from the ground at its middle.
    const winBase = ground(40)
    expect(openingHole(f, win as WindowObject)).toEqual({ u0: 38, u1: 42, y0: expect.closeTo(winBase + 3, 9), y1: expect.closeTo(winBase + 7, 9) })
    // A door taller than the lowest top over its span is clamped to it.
    const tall = createDoor(wall, 50, { width: 8, height: 10 })
    expect(openingHole(f, tall as DoorObject)!.y1).toBeCloseTo(ground(46) + 10, 9)
    // Follow off: everything measures from the elevation (0).
    const off = { ...wall, followTerrain: false }
    scene.objects[wall.id] = off
    const f2 = wallFrame(new BuildContext(scene), off)!
    expect(openingHole(f2, door as DoorObject)!.y1).toBeCloseTo(7, 9)
    expect(doorLeaves(f2, door as DoorObject)[0].pivot.y).toBe(0)
  })

  it("drops door leaves buried under the ground", () => {
    // A follow-off wall in a cutting: the ground stands 12 ft above the elevation at the door.
    const { scene, lv } = terrainScene(() => 12)
    const wall = createWall(lv, { x: 10, z: 40 }, { x: 40, z: 40 }, { followTerrain: false })
    const door = createDoor(wall, 15, { height: 7 })
    add(scene, wall, door)
    const ctx = new BuildContext(scene)
    expect(doorLeaves(wallFrame(ctx, wall)!, door as DoorObject)).toEqual([])
    expect(buildLevel(ctx, lv).doors.meshes).toEqual([])
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

  it("gives every door leaf a top-down marker on the wall top, wider than the wall", () => {
    const scene = smallScene()
    const ground = groundLevelId(scene)
    const ctx = new BuildContext(scene)
    const leaves = buildLevel(ctx, ground).doors.meshes.filter((m) => m.kind === "door")
    expect(leaves.length).toBeGreaterThan(0)
    for (const m of leaves) {
      if (m.kind !== "door") continue
      const door = scene.objects[m.leaf.doorId]
      if (door.type !== "door") throw new Error("not a door")
      const wall = scene.objects[door.wallId]
      if (wall.type !== "wall") throw new Error("not a wall")
      const marker = m.marker!
      expect(marker).not.toBeNull()
      marker.computeBoundingBox()
      const box = marker.boundingBox!
      // Pivot frame: y from the wall base, z across the wall.
      expect(box.min.y).toBeCloseTo(wall.height + DOOR_MARKER_LIFT, 5)
      expect(box.max.y - box.min.y).toBeLessThan(0.1)
      expect(box.max.z - box.min.z).toBeGreaterThan(wall.thickness)
      expect(box.min.z).toBeCloseTo(-(wall.thickness / 2 + DOOR_MARKER_OVERHANG), 5)
      // Within the leaf's width (double doors: each leaf its half).
      expect(box.min.x).toBeGreaterThanOrEqual(0)
      expect(box.max.x).toBeLessThanOrEqual(m.leaf.width + 1e-6)
      // Accent plate after the slab; owned by the door (hover / selection outlines).
      const accent = marker.userData[DOOR_MARKER_ACCENT] as number
      expect(accent).toBeGreaterThan(0)
      expect(accent).toBeLessThan(marker.getAttribute("position").count)
      expect((marker.userData.ranges as { id: string }[]).every((r) => r.id === door.id)).toBe(true)
    }
    // Double doors: one marker per leaf.
    const wall = createWall(ground, { x: 0, z: 90 }, { x: 20, z: 90 })
    const double = createDoor(wall, 10, { width: 4, leaves: "double" })
    add(scene, wall, double)
    const doubles = buildLevel(new BuildContext(scene), ground).doors.meshes.filter((m) => m.kind === "door" && m.leaf.doorId === double.id)
    expect(doubles).toHaveLength(2)
    for (const m of doubles) if (m.kind === "door") expect(m.marker).not.toBeNull()
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

  it("builds terrain as an indexed top (vertices shared within each grid cell) and boundary skirts, no bottom", () => {
    // 4×4 cells at resolution 2: 8×8 lattice cells, one floor over the whole grid.
    const { scene, lv } = terrainScene((x, z) => Math.sin(x / 4) + z / 10, 4)
    const b = buildLevel(new BuildContext(scene), lv).floors.meshes[0]
    if (b.kind !== "merged" || !b.terrainOffsets || !b.terrainRows) throw new Error("no terrain mesh")
    const g = b.geometry
    expectWorldGeometry(g)
    expectWindingMatchesNormals(g)
    expect(g.index).toBeTruthy()
    const surf = g.getAttribute("aSurf")
    const nrm = g.getAttribute("normal")
    let tops = 0
    for (let k = 0; k < surf.count; k++) {
      if (surf.getX(k) === SURF.WALKABLE) tops++
      // Nothing faces down: the slab has no bottom.
      expect(nrm.getY(k)).toBeGreaterThan(-0.5)
    }
    // Tops: (2 + 1)² vertices per grid cell (its own tint), 2 triangles per lattice cell.
    expect(tops).toBe(16 * 9)
    // Skirts: one quad (4 vertices, 2 triangles) per boundary lattice edge.
    expect(surf.count - tops).toBe(32 * 4)
    expect(g.index!.count / 3).toBe(64 * 2 + 32 * 2)
    // The row table lists every vertex once, rows in ascending z, each in ascending x.
    const { sz0, rowStart, order } = b.terrainRows
    expect(order.length).toBe(surf.count)
    expect(new Set(order).size).toBe(surf.count)
    const pos = g.getAttribute("position")
    for (let r = 0; r + 1 < rowStart.length; r++) {
      for (let k = rowStart[r]; k < rowStart[r + 1]; k++) {
        expect(Math.round(pos.getZ(order[k]) / 2.5)).toBe(sz0 + r)
        if (k > rowStart[r]) expect(pos.getX(order[k])).toBeGreaterThanOrEqual(pos.getX(order[k - 1]))
      }
    }
  })

  it("smooth-shades terrain tops with the lattice normals, before and after a preview update", () => {
    const { scene, lv } = terrainScene((x, z) => 3 * Math.sin(x / 7) * Math.cos(z / 5), 12)
    const built = () => {
      const b = buildLevel(new BuildContext(scene), lv).floors.meshes[0]
      if (b.kind !== "merged" || !b.terrainOffsets || !b.terrainRows) throw new Error("no terrain mesh")
      return b as typeof b & { terrainOffsets: Float32Array; terrainRows: Int32Array }
    }
    /** Top vertices by lattice sample: every vertex of a sample carries the same normal, normalAt's. */
    const expectSmoothTops = (b: ReturnType<typeof built>, g: GroundSampler) => {
      const pos = b.geometry.getAttribute("position")
      const nrm = b.geometry.getAttribute("normal")
      const surf = b.geometry.getAttribute("aSurf")
      let tops = 0
      for (let k = 0; k < pos.count; k++) {
        if (surf.getX(k) !== SURF.WALKABLE) continue
        const n = g.normalAt(Math.round(pos.getX(k) / g.spacing), Math.round(pos.getZ(k) / g.spacing))
        expect(nrm.getX(k)).toBeCloseTo(n[0], 5)
        expect(nrm.getY(k)).toBeCloseTo(n[1], 5)
        expect(nrm.getZ(k)).toBeCloseTo(n[2], 5)
        tops++
      }
      expect(tops).toBeGreaterThan(0)
      expectWindingMatchesNormals(b.geometry)
    }
    const b = built()
    expectSmoothTops(b, new BuildContext(scene).sampler(lv))
    // A preview that raises a block of samples: normals just outside the block change too.
    const heights = denseHeights(scene.levels[lv].heightmap!, scene.grid).heights.slice()
    const g0 = new BuildContext(scene).sampler(lv)
    const dirty = { x: 20, z: 20, w: 10, d: 10 }
    for (let j = 0; j < g0.samplesZ; j++) {
      for (let i = 0; i < g0.samplesX; i++) {
        const x = i * g0.spacing
        const z = j * g0.spacing
        if (x >= dirty.x && x <= dirty.x + dirty.w && z >= dirty.z && z <= dirty.z + dirty.d) heights[j * g0.samplesX + i] += 4
      }
    }
    const g = GroundSampler.fromDense(scene.levels[lv], scene.grid, heights)!
    expect(updateTerrainGeometry(b.geometry, b.terrainOffsets, g, dirty, b.terrainRows)).toBeGreaterThan(0)
    expectSmoothTops(b, g)
  })

  it("updates terrain previews through the row table exactly like a full scan, at a cost that follows the dirty rect", () => {
    const scene = createScene({ width: 60, depth: 60, groundFloor: false })
    const lv = groundLevelId(scene)
    scene.levels[lv].heightmap = createHeightmap(4)
    // Two floors with a gap and a notch (skirts inside rows), and a third overlapping row range.
    add(scene, createFloor(lv, { x: 0, z: 0, w: 140, d: 300 }, "grass"), createFloor(lv, { x: 160, z: 20, w: 140, d: 250 }, "dirt"))
    add(scene, createFloor(lv, { x: 142.5, z: 100, w: 15, d: 30 }, "stone"))
    const build = () => {
      const b = buildLevel(new BuildContext(scene), lv).floors.meshes[0]
      if (b.kind !== "merged" || !b.terrainOffsets || !b.terrainRows) throw new Error("no terrain mesh")
      return b as typeof b & { terrainOffsets: Float32Array; terrainRows: Int32Array }
    }
    const fast = build()
    const slow = build()
    const heights = denseHeights(scene.levels[lv].heightmap!, scene.grid).heights.slice()
    const n = 241
    const r = (() => {
      let seed = 11
      return () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646
    })()
    const times: number[] = []
    for (let step = 0; step < 12; step++) {
      const dirty = step === 0 ? { x: -3, z: 250, w: 60, d: 60 } : { x: r() * 250 - 10, z: r() * 250 - 10, w: 20 + r() * 80, d: 20 + r() * 80 }
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const x = i * 1.25
          const z = j * 1.25
          if (x >= dirty.x && x <= dirty.x + dirty.w && z >= dirty.z && z <= dirty.z + dirty.d) heights[j * n + i] = 4 * Math.sin(x / 9 + step) + (z % 7)
        }
      }
      const g = GroundSampler.fromDense(scene.levels[lv], scene.grid, heights)!
      const t0 = performance.now()
      const a = updateTerrainGeometry(fast.geometry, fast.terrainOffsets, g, dirty, fast.terrainRows)
      times.push(performance.now() - t0)
      const b = updateTerrainGeometry(slow.geometry, slow.terrainOffsets, g, dirty)
      expect(a).toBe(b)
      expect(a).toBeGreaterThan(0)
    }
    for (const name of ["position", "normal"]) {
      const other = slow.geometry.getAttribute(name).array
      expect(
        Array.from(fast.geometry.getAttribute(name).array).every((v, k) => v === other[k]),
        name
      ).toBe(true)
    }
    // Every moved vertex sits on the previewed ground (plus its slab offset).
    const g = GroundSampler.fromDense(scene.levels[lv], scene.grid, heights)!
    const pos = fast.geometry.getAttribute("position")
    for (let k = 0; k < pos.count; k += 97) expect(pos.getY(k)).toBeCloseTo(g.heightAt(pos.getX(k), pos.getZ(k)) + fast.terrainOffsets[k], 4)
    // Bounds grow to cover the moved vertices (never recomputed over the whole mesh).
    const box = fast.geometry.boundingBox!
    fast.geometry.computeBoundingBox()
    expect(box.max.y).toBeGreaterThanOrEqual(fast.geometry.boundingBox!.max.y - 1e-6)
    expect(fast.geometry.boundingSphere!.radius).toBeGreaterThan(0)
    // Budget (DESIGN: ≤ 4 ms for a 100×100 ft rect on a 200×200-cell res-4 level, measured ≈ 1 ms there):
    // generous here, the point is that it does not scan the whole mesh.
    times.sort((x, y) => x - y)
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(8)
    // A lattice of another spacing cannot be updated in place.
    const coarse = GroundSampler.fromDense(scene.levels[lv], scene.grid, new Float32Array(121 * 121))!
    expect(updateTerrainGeometry(fast.geometry, fast.terrainOffsets, coarse, null, fast.terrainRows)).toBe(-1)
  })

  it("uploads one range per attribute for a terrain update, merged with the ranges not uploaded yet", () => {
    const scene = createScene({ width: 20, depth: 20 })
    const lv = groundLevelId(scene)
    scene.levels[lv].heightmap = createHeightmap(2)
    const b = buildLevel(new BuildContext(scene), lv).floors.meshes[0]
    if (b.kind !== "merged" || !b.terrainOffsets || !b.terrainRows) throw new Error("no terrain mesh")
    const pos = b.geometry.getAttribute("position") as THREE.BufferAttribute
    const nrm = b.geometry.getAttribute("normal") as THREE.BufferAttribute
    const heights = denseHeights(scene.levels[lv].heightmap!, scene.grid).heights.slice()
    const n = 41
    const raise = (x0: number, z0: number, w: number, h: number) => {
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (i * 2.5 >= x0 && i * 2.5 <= x0 + w && j * 2.5 >= z0 && j * 2.5 <= z0 + w) heights[j * n + i] = h
      return GroundSampler.fromDense(scene.levels[lv], scene.grid, heights)!
    }
    /** Every float of `a` that differs from `before` lies inside one of the attribute's pending ranges. */
    const covered = (a: THREE.BufferAttribute, before: Float32Array) => {
      const now = a.array as Float32Array
      for (let k = 0; k < now.length; k++) {
        if (now[k] !== before[k] && !a.updateRanges.some((r) => k >= r.start && k < r.start + r.count)) return false
      }
      return true
    }
    pos.clearUpdateRanges()
    nrm.clearUpdateRanges()
    const p0 = (pos.array as Float32Array).slice()
    const n0 = (nrm.array as Float32Array).slice()
    // A 20 ft rect spans ~10 lattice rows, each touched only around the rect: one range, not one per row.
    const dirtyA = { x: 30, z: 30, w: 20, d: 20 }
    expect(updateTerrainGeometry(b.geometry, b.terrainOffsets, raise(30, 30, 20, 3), dirtyA, b.terrainRows)).toBeGreaterThan(0)
    expect(pos.updateRanges).toHaveLength(1)
    expect(nrm.updateRanges).toHaveLength(1)
    expect(covered(pos, p0) && covered(nrm, n0)).toBe(true)
    // A second update before any upload: still one range, covering both (the first one is not dropped).
    const dirtyB = { x: 70, z: 5, w: 10, d: 10 }
    expect(updateTerrainGeometry(b.geometry, b.terrainOffsets, raise(70, 5, 10, -2), dirtyB, b.terrainRows)).toBeGreaterThan(0)
    expect(pos.updateRanges).toHaveLength(1)
    expect(nrm.updateRanges).toHaveLength(1)
    expect(covered(pos, p0) && covered(nrm, n0)).toBe(true)
    // Unrelated pending ranges are kept inside the merged one.
    pos.clearUpdateRanges()
    pos.addUpdateRange(0, 9)
    updateTerrainGeometry(b.geometry, b.terrainOffsets, raise(30, 30, 20, 1), dirtyA, b.terrainRows)
    expect(pos.updateRanges).toHaveLength(1)
    expect(pos.updateRanges[0].start).toBe(0)
  })

  it("is deterministic", () => {
    const scene = smallScene()
    const ground = groundLevelId(scene)
    const a = buildLevel(new BuildContext(scene), ground).walls.meshes[0].geometry.getAttribute("color").array
    const b = buildLevel(new BuildContext(scene), ground).walls.meshes[0].geometry.getAttribute("color").array
    expect(Array.from(a)).toEqual(Array.from(b))
  })
})
