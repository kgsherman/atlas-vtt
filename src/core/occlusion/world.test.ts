import { describe, expect, it } from "vitest"

import {
  createConnector,
  createDoor,
  createFloor,
  createPillar,
  createProp,
  createToken,
  createWall,
  createWindow,
} from "../scene/factory"
import { nominalTokenEye } from "../scene/queries"
import type { Scene, SceneObject, Vec3 } from "../scene/types"
import { buildOcclusionWorld } from "./index"
import { primitiveBounds, segmentEntry } from "./primitives"
import { add, addLevel, flatScene, paintHeightmap, rng } from "./test-utils"
import type { BlockChannel, DirtyRegion, OcclusionWorld, WallStrip } from "./types"
import { primitivesEqual } from "./world"

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z })
const blocked = (w: OcclusionWorld, a: Vec3, b: Vec3, channel: BlockChannel = "sight") => w.segmentBlocked(a, b, { channel })

/** Immutable object replacement, like an immer patch. */
function withObject(scene: Scene, o: SceneObject): Scene {
  return { ...scene, objects: { ...scene.objects, [o.id]: o } }
}

function withoutObject(scene: Scene, id: string): Scene {
  const objects = { ...scene.objects }
  delete objects[id]
  return { ...scene, objects }
}

const regionContains = (r: DirtyRegion, p: Vec3) =>
  p.x >= r.min.x && p.x <= r.max.x && p.y >= r.min.y && p.y <= r.max.y && p.z >= r.min.z && p.z <= r.max.z

describe("line of sight from eye height", () => {
  it("a low 3 ft wall blocks a small token's eye but not a huge token's", () => {
    const { scene, levelId } = flatScene()
    add(scene, createWall(levelId, { x: 20, z: 30 }, { x: 60, z: 30 }, { height: 3 }))
    const world = buildOcclusionWorld(scene)
    const small = createToken(levelId, { x: 42.5, z: 22.5 }, { size: "small" })
    const huge = createToken(levelId, { x: 42.5, z: 22.5 }, { size: "huge" })
    const target = v(42.5, 0.25, 40) // floor sample 10 ft behind the wall
    expect(nominalTokenEye(scene, small).y).toBe(3)
    expect(nominalTokenEye(scene, huge).y).toBe(14)
    expect(blocked(world, nominalTokenEye(scene, small), target)).toBe(true)
    expect(blocked(world, nominalTokenEye(scene, huge), target)).toBe(false)
    expect(blocked(world, nominalTokenEye(scene, huge), target, "light")).toBe(false)
  })
})

describe("openings", () => {
  function wallWith(add2: (scene: Scene, wall: ReturnType<typeof createWall>) => void) {
    const { scene, levelId } = flatScene()
    const wall = add(scene, createWall(levelId, { x: 20, z: 30 }, { x: 60, z: 30 }, { height: 10 }))
    add2(scene, wall)
    return { scene, levelId, wall }
  }

  it("a ray exactly along the seam between a wall piece and a closed leaf is blocked (quarter-turn walls)", () => {
    const { scene, levelId } = flatScene()
    // A wall along z (yaw −π/2) with a 4 ft door centred at z = 17.5: its leaf meets the wall at z = 15.5.
    const wall = add(scene, createWall(levelId, { x: 35, z: 0 }, { x: 35, z: 40 }))
    add(scene, createDoor(wall, 17.5, { width: 4 }))
    const world = buildOcclusionWorld(scene)
    for (const z of [15.5, 19.5]) expect(blocked(world, v(29.5, 5.5, z), v(50.5, 3, z), "sight"), `z = ${z}`).toBe(true)
  })

  it("windows block movement but not sight or light; sill and lintel block everything", () => {
    const { scene } = wallWith((s, w) => add(s, createWindow(w, 20, { width: 3, sillHeight: 3, height: 3 })))
    const world = buildOcclusionWorld(scene)
    const a = v(40, 4.5, 25)
    const b = v(40, 4.5, 35)
    expect(blocked(world, a, b, "sight")).toBe(false)
    expect(blocked(world, a, b, "light")).toBe(false)
    expect(blocked(world, a, b, "movement")).toBe(true)
    // Sill at 1 ft and lintel at 8 ft.
    expect(blocked(world, v(40, 1, 25), v(40, 1, 35))).toBe(true)
    expect(blocked(world, v(40, 8, 25), v(40, 8, 35), "light")).toBe(true)
    // Beside the window the wall is solid.
    expect(blocked(world, v(35, 4.5, 25), v(35, 4.5, 35))).toBe(true)
  })

  it("closed wood doors block sight, open doors don't, a closed portcullis blocks movement only", () => {
    const { scene, wall } = wallWith(() => {})
    const door = createDoor(wall, 20, { width: 4, height: 7 })
    const a = v(40, 5, 25)
    const b = v(40, 5, 35)
    const closed = buildOcclusionWorld(withObject(scene, door))
    expect(blocked(closed, a, b)).toBe(true)
    expect(blocked(closed, a, b, "movement")).toBe(true)
    const open = buildOcclusionWorld(withObject(scene, { ...door, state: "open" }))
    expect(blocked(open, a, b)).toBe(false)
    expect(blocked(open, a, b, "movement")).toBe(false)
    // The lintel above the open door still blocks.
    expect(blocked(open, v(40, 8.5, 25), v(40, 8.5, 35))).toBe(true)
    const portcullis = buildOcclusionWorld(withObject(scene, { ...door, style: "portcullis", state: "locked" }))
    expect(blocked(portcullis, a, b)).toBe(false)
    expect(blocked(portcullis, a, b, "light")).toBe(false)
    expect(blocked(portcullis, a, b, "movement")).toBe(true)
  })
})

describe("levels and terrain", () => {
  it("floor slabs block between levels; a stairwell cutout lets a vertical segment through", () => {
    const { scene, levelId } = flatScene(20, 20)
    const upper = addLevel(scene, { elevation: 10, floorThickness: 1 })
    add(scene, createFloor(upper.id, { x: 0, z: 0, w: 100, d: 100 }))
    add(scene, createConnector(levelId, upper.id, { x: 40, z: 40, w: 5, d: 15 }, 0))
    add(scene, createConnector(levelId, upper.id, { x: 70, z: 70, w: 5, d: 5 }, 0, "ladder"))
    const world = buildOcclusionWorld(scene)
    expect(blocked(world, v(20, 5, 20), v(20, 15, 20))).toBe(true)
    expect(blocked(world, v(20, 5, 20), v(20, 15, 20), "light")).toBe(true)
    expect(blocked(world, v(20, 5, 20), v(20, 15, 20), "movement")).toBe(false)
    // Above the stairs' top row and through the ladder hole.
    expect(blocked(world, v(42.5, 8, 52.5), v(42.5, 15, 52.5))).toBe(false)
    expect(blocked(world, v(72.5, 1, 72.5), v(72.5, 15, 72.5))).toBe(false)
    // Under the stairs: the stepped solid blocks.
    expect(blocked(world, v(42.5, 2, 30), v(42.5, 2, 53))).toBe(true)
    // Along the run above the walking surface: open.
    expect(blocked(world, v(42.5, 5.5, 38), v(42.5, 7.5, 54))).toBe(false)
  })

  it("a heightfield hill blocks a grazing ray", () => {
    const { scene, levelId } = flatScene(20, 20)
    paintHeightmap(scene, levelId, (x, z) => Math.max(0, 6 - Math.hypot(x - 50, z - 50) / 2))
    const world = buildOcclusionWorld(scene)
    expect(world.primitives.some((p) => p.shape === "heightfield")).toBe(true)
    expect(blocked(world, v(20, 1, 50), v(80, 1, 50))).toBe(true)
    expect(blocked(world, v(20, 7, 50), v(80, 7, 50))).toBe(false)
    // Grazing over flat ground (0.25 ft above it) away from the hill.
    expect(blocked(world, v(5, 0.25, 5), v(95, 0.25, 5))).toBe(false)
    const hit = world.raycast(v(20, 1, 50), v(80, 1, 50), { channel: "sight" })
    expect(hit?.primitive.shape).toBe("heightfield")
    expect(20 + 60 * hit!.t).toBeCloseTo(40, 0)
  })
})

describe("query semantics", () => {
  it("ENTRY semantics: starting inside a bush sees out; entering it from outside is blocked", () => {
    const { scene, levelId } = flatScene()
    const bush = add(scene, createProp(levelId, "bush", { x: 50, y: 0, z: 50 }))
    const world = buildOcclusionWorld(scene)
    expect(blocked(world, v(50, 1, 50), v(60, 1, 50))).toBe(false)
    expect(blocked(world, v(40, 1, 50), v(51, 1, 50))).toBe(true)
    expect(blocked(world, v(40, 1, 50), v(60, 1, 50))).toBe(true)
    // Bushes do not block movement.
    expect(blocked(world, v(40, 1, 50), v(60, 1, 50), "movement")).toBe(false)
    // ignoreSourceIds
    expect(world.segmentBlocked(v(40, 1, 50), v(60, 1, 50), { channel: "sight", ignoreSourceIds: new Set([bush.id]) })).toBe(false)
  })

  it("raycast returns the nearest entry", () => {
    const { scene, levelId } = flatScene()
    const near = add(scene, createPillar(levelId, { x: 30, z: 50 }, { size: 2 }))
    add(scene, createPillar(levelId, { x: 60, z: 50 }, { size: 2 }))
    const world = buildOcclusionWorld(scene)
    const hit = world.raycast(v(80, 3, 50), v(10, 3, 50), { channel: "sight" })
    expect(hit?.primitive.sourceId).not.toBe(near.id)
    expect(80 - 70 * hit!.t).toBeCloseTo(61)
    const back = world.raycast(v(10, 3, 50), v(80, 3, 50), { channel: "sight" })
    expect(back?.primitive.sourceId).toBe(near.id)
    expect(10 + 70 * back!.t).toBeCloseTo(29)
    expect(world.raycast(v(10, 3, 40), v(80, 3, 40), { channel: "sight" })).toBeNull()
  })

  it("wall corners have no gap: a ray aimed exactly at the outer corner of joined walls is blocked", () => {
    const { scene, levelId } = flatScene()
    add(scene, createWall(levelId, { x: 10, z: 10 }, { x: 20, z: 10 }, { thickness: 0.5 }))
    add(scene, createWall(levelId, { x: 10, z: 10 }, { x: 10, z: 20 }, { thickness: 0.5 }))
    add(scene, createWall(levelId, { x: 30, z: 10 }, { x: 40, z: 10 }, { thickness: 0.5 }))
    const world = buildOcclusionWorld(scene)
    // Outer corner at (9.75, 9.75); the segment ends inside the joint square.
    expect(blocked(world, v(5, 5, 5), v(9.9, 5, 9.9))).toBe(true)
    expect(blocked(world, v(5, 5, 5), v(15, 5, 15), "light")).toBe(true)
    // A free wall end is not extended.
    expect(blocked(world, v(25, 5, 10), v(29.9, 5, 10))).toBe(false)
  })

  it("tree canopy lets ground-level sight pass between trunk and canopy", () => {
    const { scene, levelId } = flatScene()
    add(scene, createProp(levelId, "tree", { x: 50, y: 0, z: 50 }))
    const world = buildOcclusionWorld(scene)
    expect(blocked(world, v(40, 4, 52), v(60, 4, 52))).toBe(false)
    expect(blocked(world, v(40, 4, 50), v(60, 4, 50))).toBe(true)
    expect(blocked(world, v(40, 10, 52), v(60, 10, 52))).toBe(true)
  })

  it("containing() filters by channel", () => {
    const { scene, levelId } = flatScene()
    const crate = add(scene, createProp(levelId, "crate", { x: 20, y: 0, z: 20 }))
    const bush = add(scene, createProp(levelId, "bush", { x: 40, y: 0, z: 40 }))
    const world = buildOcclusionWorld(scene)
    expect(world.containing(v(20, 1, 20)).map((p) => p.sourceId)).toEqual([crate.id])
    expect(world.containing(v(20, 3.5, 20))).toEqual([])
    expect(world.containing(v(40, 1, 40), "sight").map((p) => p.sourceId)).toEqual([bush.id])
    expect(world.containing(v(40, 1, 40), "movement")).toEqual([])
    // Floor slab under the ground.
    expect(world.containing(v(5, -0.5, 5)).map((p) => p.sourceType)).toEqual(["floor"])
  })

  it("queryRect / queryCircle filter by level and exact footprint", () => {
    const { scene, levelId } = flatScene()
    const upper = addLevel(scene, { elevation: 10 })
    const pillar = add(scene, createPillar(levelId, { x: 22.5, z: 22.5 }, { size: 2, shape: "square" }))
    const upPillar = add(scene, createPillar(upper.id, { x: 22.5, z: 22.5 }, { size: 2 }))
    const diag = add(scene, createWall(levelId, { x: 50, z: 50 }, { x: 70, z: 70 }))
    const world = buildOcclusionWorld(scene)
    const ids = (ps: { sourceId: string }[]) => ps.map((p) => p.sourceId).sort()
    const floorId = Object.keys(scene.objects).find((id) => scene.objects[id].type === "floor")!
    expect(ids(world.queryRect(levelId, { x: 20, z: 20, w: 5, d: 5 }))).toEqual([floorId, pillar.id].sort())
    expect(ids(world.queryRect(upper.id, { x: 20, z: 20, w: 5, d: 5 }))).toEqual([upPillar.id])
    expect(ids(world.queryRect(null, { x: 20, z: 20, w: 5, d: 5 }))).toEqual([floorId, pillar.id, upPillar.id].sort())
    // Touching the pillar's edge is not an overlap.
    expect(world.queryRect(levelId, { x: 23.5, z: 20, w: 2, d: 5 }).some((p) => p.sourceId === pillar.id)).toBe(false)
    // Inside the diagonal wall's AABB but off its footprint.
    expect(world.queryRect(levelId, { x: 51, z: 66, w: 2, d: 2 }).some((p) => p.sourceId === diag.id)).toBe(false)
    expect(world.queryCircle(levelId, { x: 60, z: 60 }, 0.5).some((p) => p.sourceId === diag.id)).toBe(true)
    // Pillar edge at x = 23.5.
    expect(world.queryCircle(levelId, { x: 25, z: 22.5 }, 1.6).some((p) => p.sourceId === pillar.id)).toBe(true)
    expect(world.queryCircle(levelId, { x: 25, z: 22.5 }, 1.5).some((p) => p.sourceId === pillar.id)).toBe(false)
  })
})

describe("incremental updates", () => {
  it("a door toggle returns a dirty region around the door and flips results", () => {
    const { scene, levelId } = flatScene()
    const wall = add(scene, createWall(levelId, { x: 20, z: 30 }, { x: 60, z: 30 }))
    const door = add(scene, createDoor(wall, 20, { width: 4, height: 7 }))
    const world = buildOcclusionWorld(scene)
    const a = v(40, 5, 25)
    const b = v(40, 5, 35)
    expect(blocked(world, a, b)).toBe(true)
    const v0 = world.version
    const before = world.primitives

    const opened = withObject(scene, { ...door, state: "open" })
    const dirty = world.update(opened, [door.id])
    expect(world.version).toBe(v0 + 1)
    expect(world.primitives).not.toBe(before)
    expect(dirty).toHaveLength(1)
    expect(dirty[0].levelId).toBe(levelId)
    expect(regionContains(dirty[0], v(40, 3, 30))).toBe(true)
    // Only the leaf changed: the region does not cover the rest of the wall.
    expect(dirty[0].max.x - dirty[0].min.x).toBeCloseTo(4)
    expect(blocked(world, a, b)).toBe(false)

    // No-op update: no dirty region, no version bump.
    expect(world.update(opened, [door.id])).toEqual([])
    expect(world.version).toBe(v0 + 1)

    const closed = withObject(opened, { ...door, state: "locked" })
    expect(world.update(closed, [door.id])).toHaveLength(1)
    expect(blocked(world, a, b)).toBe(true)
    expect(world.version).toBe(v0 + 2)
  })

  it("moving a wall rebuilds its openings and its neighbours' joints", () => {
    const { scene, levelId } = flatScene()
    const a = add(scene, createWall(levelId, { x: 10, z: 10 }, { x: 20, z: 10 }))
    const b = add(scene, createWall(levelId, { x: 10, z: 10 }, { x: 10, z: 20 }))
    const window = add(scene, createWindow(b, 5))
    const world = buildOcclusionWorld(scene)
    expect(blocked(world, v(5, 5, 5), v(9.9, 5, 9.9))).toBe(true)
    const keyOf = (id: string) => world.primitives.find((p) => p.key === id)!
    expect(primitiveBounds(keyOf(a.id)).minX).toBeCloseTo(9.75)

    // Move wall b away: a loses its joint extension, the window follows b.
    const moved = withObject(scene, { ...b, a: { x: 30, z: 10 }, b: { x: 30, z: 20 } })
    const dirty = world.update(moved, [b.id])
    expect(dirty.length).toBeGreaterThan(0)
    expect(primitiveBounds(keyOf(a.id)).minX).toBeCloseTo(10)
    const wb = primitiveBounds(keyOf(window.id))
    expect(wb.minX).toBeCloseTo(29.75)
    expect(blocked(world, v(5, 5, 5), v(9.9, 5, 9.9))).toBe(false)
    // Old and new locations are both dirty.
    expect(dirty.some((r) => regionContains(r, v(10, 5, 15)))).toBe(true)
    expect(dirty.some((r) => regionContains(r, v(30, 5, 15)))).toBe(true)

    // Deleting b removes its primitives and its window's.
    world.update(withoutObject(withoutObject(moved, b.id), window.id), [b.id, window.id])
    expect(world.primitives.some((p) => p.sourceId === b.id || p.sourceId === window.id)).toBe(false)
  })

  it("adding a connector cuts the floor above", () => {
    const { scene, levelId } = flatScene(20, 20)
    const upper = addLevel(scene, { elevation: 10 })
    add(scene, createFloor(upper.id, { x: 0, z: 0, w: 100, d: 100 }))
    const world = buildOcclusionWorld(scene)
    const up = [v(72.5, 1, 72.5), v(72.5, 15, 72.5)] as const
    expect(blocked(world, ...up)).toBe(true)
    const ladder = createConnector(levelId, upper.id, { x: 70, z: 70, w: 5, d: 5 }, 0, "ladder")
    const dirty = world.update(withObject(scene, ladder), [ladder.id])
    expect(dirty.length).toBeGreaterThan(0)
    expect(blocked(world, ...up)).toBe(false)
  })

  it("level changes trigger a full rebuild", () => {
    const { scene, levelId } = flatScene()
    const world = buildOcclusionWorld(scene)
    const raised = { ...scene, levels: { [levelId]: { ...scene.levels[levelId], elevation: 5 } } }
    const dirty = world.update(raised, [levelId])
    expect(dirty).toHaveLength(1)
    expect(world.containing(v(5, 4.5, 5)).length).toBe(1)
  })

  it("updateTerrain rebuilds heightfields and ground-anchored objects locally", () => {
    const { scene, levelId } = flatScene(20, 20)
    paintHeightmap(scene, levelId, () => 0)
    const crate = add(scene, createProp(levelId, "crate", { x: 50, y: 0, z: 50 }))
    const far = add(scene, createPillar(levelId, { x: 10, z: 10 }))
    const world = buildOcclusionWorld(scene)
    const ray = [v(30, 1, 50), v(45, 1, 50)] as const
    expect(blocked(world, ...ray)).toBe(false)
    const farBefore = world.primitives.find((p) => p.key === far.id)

    // Raise a 5×5 ft mound at (40, 50) and under the crate.
    const hilly = { ...scene, levels: { ...scene.levels } }
    paintHeightmap(hilly, levelId, (x, z) => (Math.abs(x - 40) <= 2.5 && Math.abs(z - 50) <= 2.5) || (Math.abs(x - 50) <= 5 && Math.abs(z - 50) <= 5) ? 3 : 0)
    const dirty = world.updateTerrain(hilly, levelId, { x: 35, z: 45, w: 25, d: 15 })
    expect(dirty.length).toBeGreaterThan(0)
    for (const r of dirty) {
      expect(r.min.x).toBeGreaterThanOrEqual(30)
      expect(r.max.x).toBeLessThanOrEqual(60)
    }
    expect(blocked(world, ...ray)).toBe(true)
    // The crate now rests on the raised ground; the far pillar is untouched.
    const crateBox = world.primitives.find((p) => p.key === crate.id)!
    expect(primitiveBounds(crateBox).maxY).toBeCloseTo(6)
    expect(world.primitives.find((p) => p.key === far.id)).toBe(farBefore)
  })

  it("primitives outside the scene extent grow the grid", () => {
    const { scene, levelId } = flatScene(4, 4)
    const world = buildOcclusionWorld(scene)
    const pillar = createPillar(levelId, { x: 200, z: -80 }, { size: 2 })
    world.update(withObject(scene, pillar), [pillar.id])
    expect(blocked(world, v(190, 3, -80), v(210, 3, -80))).toBe(true)
    expect(world.queryCircle(null, { x: 200, z: -80 }, 3)).toHaveLength(1)
  })
})

describe("nearest-hit ties", () => {
  it("raycast reports the same primitive on a fresh world and after an update round trip", () => {
    // Walls P (box x ∈ [24, 50]) and Q (box x ∈ [24, 26]) share the x = 24 face; the ray enters both there.
    const { scene, levelId } = flatScene(12, 8)
    const P = add(scene, { ...createWall(levelId, { x: 24, z: 20 }, { x: 50, z: 20 }, { height: 10, thickness: 2 }), id: "P" })
    add(scene, { ...createWall(levelId, { x: 25, z: 20.92 }, { x: 25, z: 23.92 }, { height: 3, thickness: 2 }), id: "Q" })
    scene.objects = Object.fromEntries(Object.values(scene.objects).map((o) => [o.id, o]))
    const eye = v(2.5, 9, 22.5)
    const p = v(28.125, 0.25, 20.625)
    const fresh = buildOcclusionWorld(scene).raycast(eye, p, { channel: "sight" })
    expect(fresh?.primitive.key).toBe("P")
    const w = buildOcclusionWorld(scene)
    w.update(withObject(scene, { ...P, height: 10.5 }), ["P"])
    w.update(scene, ["P"])
    const after = w.raycast(eye, p, { channel: "sight" })
    expect(after?.t).toBe(fresh?.t)
    expect(after?.primitive.key).toBe("P")
  })
})

describe("follow-terrain walls (strips)", () => {
  /** A 60 ft follow wall along z = 50 on ground rising 0.5 ft per ft along x (x ∈ [20, 80]). */
  function slopeScene() {
    const { scene, levelId } = flatScene(24, 20)
    paintHeightmap(scene, levelId, (x) => Math.max(0, Math.min(30, (x - 20) / 2)))
    const wall = add(scene, createWall(levelId, { x: 20, z: 50 }, { x: 80, z: 50 }, { height: 8, followTerrain: true }))
    return { scene, levelId, wall }
  }

  it("per-cell Y ranges: rays over the low end pass, the same height at the high end is blocked", () => {
    const { scene } = slopeScene()
    const world = buildOcclusionWorld(scene)
    expect(world.primitives.some((p) => p.shape === "strip")).toBe(true)
    expect(blocked(world, v(25, 12, 45), v(25, 12, 55))).toBe(false)
    expect(blocked(world, v(75, 12, 45), v(75, 12, 55))).toBe(true)
    // Along the wall, above its top line near the low end, then diving into it.
    expect(blocked(world, v(22, 10, 50), v(30, 13, 50))).toBe(false)
    const hit = world.raycast(v(22, 10, 50), v(60, 20, 50), { channel: "sight" })
    expect(hit?.primitive.shape).toBe("strip")
  })

  it("raycasts match a brute-force loop over the primitives", () => {
    const r = rng(8)
    const { scene, levelId } = flatScene(30, 30)
    paintHeightmap(scene, levelId, (x, z) => 4 * Math.sin(x / 11) * Math.cos(z / 17) + 0.05 * x, 4)
    for (let k = 0; k < 30; k++) {
      const a = { x: r() * 150, z: r() * 150 }
      const ang = k % 2 ? (Math.floor(r() * 4) * Math.PI) / 2 : r() * Math.PI * 2
      const L = 5 + r() * 30
      const w = add(scene, createWall(levelId, a, { x: a.x + Math.cos(ang) * L, z: a.z + Math.sin(ang) * L }, { height: 3 + r() * 8 }))
      if (k % 3 === 0) add(scene, createDoor(w, 3, { width: 2, state: "closed" }))
      if (k % 3 === 1) add(scene, createWindow(w, 3, { width: 2, sillHeight: 1 }))
    }
    const world = buildOcclusionWorld(scene)
    expect(world.primitives.filter((p) => p.shape === "strip").length).toBeGreaterThan(20)
    for (let q = 0; q < 3000; q++) {
      const a = v(r() * 150, r() * 14 - 2, r() * 150)
      const b = v(a.x + (r() - 0.5) * 80, r() * 14 - 2, a.z + (r() - 0.5) * 80)
      const channel = (["sight", "light", "movement"] as const)[q % 3]
      let best: number | null = null
      for (const p of world.primitives) {
        if (!p.blocks[channel]) continue
        const t = segmentEntry(p, a, b)
        if (t !== null && (best === null || t < best)) best = t
      }
      const hit = world.raycast(a, b, { channel })
      if (best === null) expect(hit).toBeNull()
      else expect(hit?.t).toBeCloseTo(best, 9)
      expect(world.segmentBlocked(a, b, { channel })).toBe(best !== null)
    }
  })

  it("updateTerrain rebuilds the strips over the edit only; followTerrain toggles rebuild the wall and its openings", () => {
    const { scene, levelId, wall } = slopeScene()
    const door = add(scene, createDoor(wall, 30, { width: 4, height: 7 }))
    const far = add(scene, createWall(levelId, { x: 20, z: 10 }, { x: 80, z: 10 }, { height: 8, followTerrain: true }))
    const world = buildOcclusionWorld(scene)
    const farBefore = world.primitives.find((p) => p.key === far.id)
    expect(farBefore?.shape).toBe("strip")
    const doorTop = primitiveBounds(world.primitives.find((p) => p.key === door.id)!).maxY

    // Raise a 10 ft mound under the wall's high end.
    const edited = { ...scene, levels: { ...scene.levels } }
    paintHeightmap(edited, levelId, (x, z) => Math.max(0, Math.min(30, (x - 20) / 2)) + (x >= 65 && z >= 45 && z <= 55 ? 10 : 0))
    const dirty = world.updateTerrain(edited, levelId, { x: 62.5, z: 42.5, w: 25, d: 15 })
    expect(dirty.length).toBeGreaterThan(0)
    const moved = world.primitives.find((p) => p.key === `${wall.id}#after:${door.id}`) as WallStrip
    expect(Math.max(...moved.top)).toBeCloseTo(30 + 10 + 8, 6)
    expect(dirty.some((d) => regionContains(d, v(75, 47, 50)))).toBe(true)
    expect(world.primitives.find((p) => p.key === far.id)).toBe(farBefore)
    const fresh = buildOcclusionWorld(edited)
    expect(world.primitives.length).toBe(fresh.primitives.length)
    world.primitives.forEach((p, k) => expect(primitivesEqual(p, fresh.primitives[k])).toBe(true))

    // Off: boxes on the elevation; the closed door is rebuilt with its host.
    const off = withObject(edited, { ...wall, followTerrain: false })
    world.update(off, [wall.id])
    expect(world.primitives.filter((p) => p.sourceId === wall.id).every((p) => p.shape === "box")).toBe(true)
    expect(primitiveBounds(world.primitives.find((p) => p.key === door.id)!).maxY).toBe(7)
    expect(doorTop).toBeGreaterThan(7)
  })

  it("primitivesEqual compares strip profiles by value", () => {
    const { scene, wall } = slopeScene()
    const a = buildOcclusionWorld(scene).primitives.find((p) => p.key === wall.id) as WallStrip
    const b: WallStrip = { ...a, knots: [...a.knots], top: [...a.top], center: { ...a.center }, halfExtents: { ...a.halfExtents } }
    expect(primitivesEqual(a, b)).toBe(true)
    expect(primitivesEqual(a, { ...b, top: b.top.map((t, k) => (k === 1 ? t + 1e-9 : t)) })).toBe(false)
    expect(primitivesEqual(a, { ...b, knots: b.knots.map((t, k) => (k === 1 ? t + 1e-9 : t)) })).toBe(false)
    expect(primitivesEqual(a, { ...b, knots: b.knots.slice(0, -1), top: b.top.slice(0, -1) })).toBe(false)
    expect(primitivesEqual(a, { ...b, bottom: b.bottom - 1 })).toBe(false)
    expect(primitivesEqual(a, { ...b, yaw: 0.1 })).toBe(false)
  })
})
