import { describe, expect, it } from "vitest"

import { LIGHT_PRESETS } from "@/core/scene/defaults"
import { createScene, createToken, createWall } from "@/core/scene/factory"
import { sampleCounts, sampleSpacing } from "@/core/scene/heightmap"
import { levelGround, lightWorldPosition, objectsOfType } from "@/core/scene/queries"
import type { ConnectorObject, DoorObject, FloorObject, LightObject, PillarObject, PropObject, Token, WallObject, WindowObject } from "@/core/scene/types"

import { at, fixtureScene, key, makeStore, pointer } from "../test-utils"
import { createConnectorTool, dragDirection } from "./connector"
import { createFloorTool } from "./floor"
import { createLightTool, WALL_MOUNT_OFFSET, wallMountHeight } from "./light"
import { createOpeningTool } from "./opening"
import { createPillarTool } from "./pillar"
import { createPropTool } from "./prop"
import { createTokenTool, nextTokenName } from "./token"
import { createWallTool } from "./wall"

const newObjects = <T>(before: object, after: Record<string, unknown>): T[] =>
  Object.keys(after)
    .filter((id) => !Object.hasOwn(before, id))
    .map((id) => after[id] as T)

describe("floor tool", () => {
  it("drags a vertex-snapped rect and adds a floor with the configured material", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().setToolSettings("floor", { material: "marble" })
    const tool = createFloorTool({ store })
    tool.onPointerDown!(at(11, 9))
    tool.onPointerMove!(at(23, 21))
    expect(tool.preview()).toMatchObject({ kind: "rect", levelId: f.groundId, rect: { x: 10, z: 10, w: 15, d: 10 } })
    expect(tool.preview()).toBe(tool.preview())
    tool.onPointerUp!(at(23, 21))
    const [floor] = newObjects<FloorObject>(f.scene.objects, store.getState().scene.objects)
    expect(floor).toMatchObject({ type: "floor", levelId: f.groundId, rect: { x: 10, z: 10, w: 15, d: 10 }, material: "marble" })
    expect(store.getState().history.undoLabel).toBe("Add floor")
  })

  it("a click adds the cell under the pointer; rects are clipped to the scene; Alt is free", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    const tool = createFloorTool({ store })
    tool.onPointerDown!(at(12, 17))
    tool.onPointerUp!(at(12, 17))
    const [cell] = newObjects<FloorObject>(f.scene.objects, store.getState().scene.objects)
    expect(cell.rect).toEqual({ x: 10, z: 15, w: 5, d: 5 })

    const before = store.getState().scene.objects
    tool.onPointerDown!(at(90, 90))
    tool.onPointerUp!(at(130, 95))
    const [clipped] = newObjects<FloorObject>(before, store.getState().scene.objects)
    expect(clipped.rect).toEqual({ x: 90, z: 90, w: 10, d: 5 })

    const before2 = store.getState().scene.objects
    tool.onPointerDown!(at(1.3, 1.7, { alt: true }))
    tool.onPointerUp!(at(3.3, 4.2, { alt: true }))
    const [free] = newObjects<FloorObject>(before2, store.getState().scene.objects)
    expect(free.rect.x).toBeCloseTo(1.3)
    expect(free.rect.w).toBeCloseTo(2)
  })

  it("Escape cancels the drag", () => {
    const store = makeStore()
    const tool = createFloorTool({ store })
    tool.onPointerDown!(at(10, 10))
    expect(tool.onKeyDown!(key("Escape"))).toBe(true)
    tool.onPointerUp!(at(30, 30))
    expect(store.getState().history.canUndo).toBe(false)
  })
})

describe("wall tool", () => {
  it("click-click draws a polyline, one undo step per segment, with the tool settings", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().setToolSettings("wall", { height: 8, thickness: 1, material: "brick" })
    const tool = createWallTool({ store, now: () => 0 })
    tool.onPointerDown!(at(51, 49, { clientX: 0 }))
    tool.onPointerMove!(at(69, 51))
    expect(tool.preview()).toMatchObject({ kind: "segment", a: { x: 50, z: 50 }, b: { x: 70, z: 50 }, height: 8, thickness: 1, valid: true })
    tool.onPointerDown!(at(69, 51, { clientX: 100 }))
    tool.onPointerDown!(at(71, 69, { clientX: 200 }))
    const walls = newObjects<WallObject>(f.scene.objects, store.getState().scene.objects)
    expect(walls).toHaveLength(2)
    expect(walls.map((w) => [w.a, w.b])).toEqual(
      expect.arrayContaining([
        [
          { x: 50, z: 50 },
          { x: 70, z: 50 },
        ],
        [
          { x: 70, z: 50 },
          { x: 70, z: 70 },
        ],
      ])
    )
    expect(walls[0]).toMatchObject({ height: 8, thickness: 1, material: "brick", levelId: f.groundId })
    expect(store.getState().history.undoDepth).toBe(2)
    expect(tool.chain()).toHaveLength(3)
    expect(tool.onKeyDown!(key("Escape"))).toBe(true)
    expect(tool.chain()).toHaveLength(0)
  })

  it("snaps to existing wall endpoints before the grid", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    const tool = createWallTool({ store, now: () => 0 })
    // Start near the fixture wall's end (30, 10).
    tool.onPointerDown!(at(30.9, 10.6, { clientX: 0 }))
    expect(tool.chain()).toEqual([{ x: 30, z: 10 }])
    tool.onPointerDown!(at(30, 30, { clientX: 100 }))
    tool.onPointerDown!(at(10, 30, { clientX: 200 }))
    // Near the fixture wall's start (10, 10): the new wall ends exactly on it.
    tool.onPointerDown!(at(10.5, 10.9, { clientX: 300 }))
    const walls = newObjects<WallObject>(f.scene.objects, store.getState().scene.objects)
    expect(walls).toHaveLength(3)
    expect(walls.some((w) => w.a.x === 10 && w.a.z === 30 && w.b.x === 10 && w.b.z === 10)).toBe(true)
    // Closing onto (30, 10) would duplicate the fixture wall: refused, the chain stays open.
    tool.onPointerDown!(at(29.2, 10.4, { clientX: 400 }))
    expect(newObjects<WallObject>(f.scene.objects, store.getState().scene.objects)).toHaveLength(3)
    expect(tool.chain()).toHaveLength(4)
    // Clicking the last point again ends the chain.
    tool.onPointerDown!(at(10, 10, { clientX: 900 }))
    expect(tool.chain()).toEqual([])
  })

  it("closing onto the chain start finishes; invalid segments are refused", () => {
    const store = makeStore(createScene({ width: 20, depth: 20 }))
    const level = store.getState().activeLevelId
    const tool = createWallTool({ store, now: () => 0 })
    tool.onPointerDown!(at(0, 0, { clientX: 0 }))
    tool.onPointerDown!(at(20, 0, { clientX: 100 }))
    tool.onPointerDown!(at(20, 20, { clientX: 200 }))
    tool.onPointerDown!(at(0.4, 0.3, { clientX: 300 }))
    expect(objectsOfType(store.getState().scene, "wall", level)).toHaveLength(3)
    expect(tool.chain()).toEqual([])

    // Duplicate of an existing wall: refused.
    tool.onPointerDown!(at(0, 0, { clientX: 0 }))
    tool.onPointerMove!(at(20, 0))
    expect(tool.preview()).toMatchObject({ kind: "segment", valid: false })
    tool.onPointerDown!(at(20, 0, { clientX: 100 }))
    expect(objectsOfType(store.getState().scene, "wall", level)).toHaveLength(3)
    // Outside the scene: refused.
    tool.onPointerMove!(at(-20, 0))
    expect(tool.preview()).toMatchObject({ valid: false })
    tool.onPointerDown!(at(-20, 0, { clientX: 500 }))
    expect(objectsOfType(store.getState().scene, "wall", level)).toHaveLength(3)
    // Right-click ends the chain.
    tool.onPointerDown!(at(0, 0, { button: 2 }))
    expect(tool.chain()).toEqual([])
  })

  it("new walls and the segment preview follow the terrain per the tool setting", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    const tool = createWallTool({ store, now: () => 0 })
    tool.onPointerDown!(at(50, 50, { clientX: 0 }))
    tool.onPointerMove!(at(60, 50))
    expect(tool.preview()).toMatchObject({ kind: "segment", followTerrain: true })
    tool.onPointerDown!(at(60, 50, { clientX: 100 }))
    store.getState().setToolSettings("wall", { followTerrain: false })
    tool.onPointerMove!(at(60, 60))
    expect(tool.preview()).toMatchObject({ kind: "segment", followTerrain: false })
    tool.onPointerDown!(at(60, 60, { clientX: 200 }))
    const walls = newObjects<WallObject>(f.scene.objects, store.getState().scene.objects)
    expect(walls.map((w) => [w.b, w.followTerrain])).toEqual(
      expect.arrayContaining([
        [{ x: 60, z: 50 }, true],
        [{ x: 60, z: 60 }, false],
      ])
    )
  })

  it("the hover marker sits on the picked ground (y relative to the level ground)", () => {
    const store = makeStore()
    const tool = createWallTool({ store, now: () => 0 })
    tool.onPointerMove!(pointer({ ground: { x: 21, z: 19 } }))
    expect(tool.preview()).toMatchObject({ kind: "point", position: { x: 20, y: 0, z: 20 } })
  })

  it("Shift constrains to 45° from the previous point", () => {
    const store = makeStore()
    const tool = createWallTool({ store, now: () => 0 })
    tool.onPointerDown!(at(10, 10, { clientX: 0 }))
    tool.onPointerMove!(at(21, 12, { shift: true }))
    expect(tool.preview()).toMatchObject({ kind: "segment", b: { x: 20, z: 10 } })
  })
})

describe("door and window tools", () => {
  it("previews the opening at the nearest valid offset on the hovered wall and places it on click", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    const tool = createOpeningTool({ store }, "door")
    // Hover the wall at x = 18 (offset 8). The fixture door [3,7] and window [12.5,15.5] leave room
    // for a 4 ft door only at centres [9, 10.5] ∪ [17.5, 18]; the cell-centre snaps (2.5, 7.5, 12.5)
    // are all blocked, so the nearest free offset (9) is used.
    const e = at(18, 10, { objectId: f.wallId, hitPoint: { x: 18, y: 3, z: 10.25 } })
    tool.onPointerMove!(e)
    expect(tool.preview()).toMatchObject({ kind: "opening", levelId: f.groundId, valid: true, sill: 0, height: 7, a: { x: 17, z: 10 }, b: { x: 21, z: 10 } })
    tool.onPointerDown!(e)
    const [door] = newObjects<DoorObject>(f.scene.objects, store.getState().scene.objects)
    expect(door).toMatchObject({ type: "door", wallId: f.wallId, offset: 9, width: 4, style: "wood", state: "closed" })
    // The only gap left is [17.5, 18]: the preview jumps there.
    expect(tool.preview()).toMatchObject({ kind: "opening", valid: true, a: { x: 25.5, z: 10 } })
  })

  it("windows use the window settings and a hovered opening resolves to its host wall", () => {
    const f = fixtureScene()
    const other = createWall(f.groundId, { x: 50, z: 50 }, { x: 80, z: 50 }, { height: 5 })
    f.scene.objects[other.id] = other
    const store = makeStore(f.scene)
    store.getState().setToolSettings("window", { width: 2, height: 4, sillHeight: 3 })
    const tool = createOpeningTool({ store }, "window")
    tool.onPointerDown!(at(62, 50, { objectId: other.id, hitPoint: { x: 62, y: 3, z: 50.25 } }))
    const [win] = newObjects<WindowObject>(f.scene.objects, store.getState().scene.objects)
    expect(win).toMatchObject({ type: "window", wallId: other.id, width: 2, sillHeight: 3, height: 2 })
    expect(win.offset).toBe(12.5)
    // Hovering the fixture door resolves to the fixture wall.
    tool.onPointerMove!(at(15, 10, { objectId: f.doorId }))
    expect(tool.preview()).toMatchObject({ kind: "opening", levelId: f.groundId })
  })

  it("the opening preview measures from the host wall's base (its followTerrain)", () => {
    const f = fixtureScene()
    const flat = createWall(f.groundId, { x: 50, z: 50 }, { x: 80, z: 50 }, { followTerrain: false })
    f.scene.objects[flat.id] = flat
    const store = makeStore(f.scene)
    const tool = createOpeningTool({ store }, "window")
    tool.onPointerMove!(at(62, 50, { objectId: flat.id, hitPoint: { x: 62, y: 3, z: 50.25 } }))
    expect(tool.preview()).toMatchObject({ kind: "opening", followTerrain: false })
    tool.onPointerMove!(at(18, 10, { objectId: f.wallId, hitPoint: { x: 18, y: 3, z: 10.25 } }))
    expect(tool.preview()).toMatchObject({ kind: "opening", followTerrain: true })
  })

  it("finds the nearest wall without a pick, and shows nothing away from walls", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    const tool = createOpeningTool({ store }, "door")
    tool.onPointerMove!(at(28, 10.8))
    expect(tool.preview()).toMatchObject({ kind: "opening" })
    tool.onPointerMove!(at(60, 60))
    expect(tool.preview()).toBeNull()
    tool.onPointerDown!(at(60, 60))
    expect(store.getState().history.canUndo).toBe(false)
  })
})

describe("connector tool", () => {
  it("drags cell-aligned stairs to the level above with the drag direction", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    const tool = createConnectorTool({ store })
    tool.onPointerDown!(at(61, 61))
    tool.onPointerMove!(at(63, 72))
    expect(tool.preview()).toMatchObject({ kind: "rect", rect: { x: 60, z: 60, w: 5, d: 15 } })
    tool.onPointerUp!(at(63, 72))
    const [c] = newObjects<ConnectorObject>(f.scene.objects, store.getState().scene.objects)
    expect(c).toMatchObject({ type: "connector", style: "stairs", levelId: f.groundId, toLevelId: f.upperId, rect: { x: 60, z: 60, w: 5, d: 15 }, direction: 0 })
  })

  it("uses the configured direction and style; ladders are one cell", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().setToolSettings("connector", { style: "ladder", direction: 3 })
    const tool = createConnectorTool({ store })
    tool.onPointerDown!(at(71, 71))
    tool.onPointerUp!(at(89, 89))
    const [c] = newObjects<ConnectorObject>(f.scene.objects, store.getState().scene.objects)
    expect(c).toMatchObject({ style: "ladder", rect: { x: 70, z: 70, w: 5, d: 5 }, direction: 3 })
  })

  it("is invalid on the top level", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().setActiveLevel(f.upperId)
    const tool = createConnectorTool({ store })
    tool.onPointerDown!(at(61, 61))
    tool.onPointerMove!(at(66, 61))
    expect(tool.preview()).toMatchObject({ color: "#f87171" })
    tool.onPointerUp!(at(66, 61))
    expect(store.getState().history.canUndo).toBe(false)
  })

  it("dragDirection picks the dominant axis", () => {
    expect(dragDirection({ i: 0, j: 0 }, { i: 3, j: 1 })).toBe(1)
    expect(dragDirection({ i: 0, j: 0 }, { i: -3, j: 1 })).toBe(3)
    expect(dragDirection({ i: 0, j: 0 }, { i: 1, j: -3 })).toBe(2)
    expect(dragDirection({ i: 0, j: 0 }, { i: 0, j: 0 })).toBe(0)
  })
})

describe("pillar, prop and token tools", () => {
  it("places a pillar at the snapped point with the pillar settings", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().setSnapMode("vertex")
    store.getState().setToolSettings("pillar", { shape: "square", size: 3 })
    const tool = createPillarTool({ store })
    tool.onPointerMove!(at(21, 19))
    expect(tool.preview()).toMatchObject({ kind: "point", position: { x: 20, y: 0, z: 20 }, radius: 1.5 })
    tool.onPointerDown!(at(21, 19))
    const [p] = newObjects<PillarObject>(f.scene.objects, store.getState().scene.objects)
    expect(p).toMatchObject({ type: "pillar", position: { x: 20, z: 20 }, shape: "square", size: 3 })
  })

  it("places props of the configured kind; R rotates the ghost preview", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().setToolSettings("prop", { kind: "barrel" })
    const tool = createPropTool({ store })
    tool.onPointerMove!(at(21, 19))
    const p1 = tool.preview()
    expect(p1).toMatchObject({ kind: "ghost-objects", offset: { x: 22.5, z: 17.5 } })
    tool.onPointerMove!(at(31, 19))
    const p2 = tool.preview()
    // Moving only changes the offset: the ghost scene is reused.
    expect(p2 && p2.kind === "ghost-objects" && p1 && p1.kind === "ghost-objects" && p2.scene === p1.scene).toBe(true)
    expect(tool.onKeyDown!(key("r"))).toBe(true)
    const p3 = tool.preview()
    expect(p3 && p3.kind === "ghost-objects" && p1 && p1.kind === "ghost-objects" && p3.scene !== p1.scene).toBe(true)
    tool.onPointerDown!(at(31, 19))
    const [prop] = newObjects<PropObject>(f.scene.objects, store.getState().scene.objects)
    expect(prop).toMatchObject({ type: "prop", kind: "barrel", position: { x: 32.5, y: 0, z: 17.5 } })
    expect(prop.rotationY).toBeCloseTo(Math.PI / 2)
  })

  it("places tokens anchored by footprint with a generated name", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().setToolSettings("token", { size: "large", kind: "monster" })
    const tool = createTokenTool({ store })
    tool.onPointerDown!(at(21, 19))
    tool.onPointerDown!(at(41, 19))
    const tokens = Object.values(store.getState().scene.tokens) as Token[]
    expect(tokens.map((t) => t.position)).toEqual(expect.arrayContaining([{ x: 20, z: 20 }, { x: 40, z: 20 }]))
    expect(tokens.map((t) => t.name).sort()).toEqual(["Monster 1", "Monster 2"])
    expect(tokens[0]).toMatchObject({ size: "large", kind: "monster", levelId: f.groundId, height: 10 })
    expect(nextTokenName(store.getState().scene, "pc")).toBe("Hero 1")
    // Off the level plane: nothing.
    tool.onPointerDown!(pointer({ ground: null }))
    expect(Object.keys(store.getState().scene.tokens)).toHaveLength(2)
  })
})

describe("light tool", () => {
  it("places a preset light on the ground at the preset height", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().setToolSettings("light", { preset: "brazier" })
    const tool = createLightTool({ store })
    tool.onPointerMove!(at(61, 61))
    expect(tool.preview()).toMatchObject({ kind: "point", position: { x: 62.5, y: LIGHT_PRESETS.brazier.height, z: 62.5 }, radius: LIGHT_PRESETS.brazier.dimRadius })
    tool.onPointerDown!(at(61, 61))
    const [l] = newObjects<LightObject>(f.scene.objects, store.getState().scene.objects)
    expect(l).toMatchObject({ type: "light", preset: "brazier", position: { x: 62.5, y: 3, z: 62.5 }, attachedTokenId: null, levelId: f.groundId })
  })

  it("wall-mounts 0.3 ft off the face that was hit", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    const tool = createLightTool({ store })
    const wall = f.scene.objects[f.wallId] as WallObject
    // Wall along +X at z = 10, thickness 0.5: its +normal (left of a→b) is +Z. Hit the −Z face.
    tool.onPointerDown!(at(20, 5, { objectId: f.wallId, hitPoint: { x: 20.2, y: 4, z: 9.75 } }))
    const [l] = newObjects<LightObject>(f.scene.objects, store.getState().scene.objects)
    expect(l.position.x).toBeCloseTo(20.2)
    expect(l.position.z).toBeCloseTo(10 - wall.thickness / 2 - WALL_MOUNT_OFFSET)
    expect(l.position.y).toBe(LIGHT_PRESETS.torch.height)
    // The +Z face.
    const before = store.getState().scene.objects
    tool.onPointerDown!(at(20, 15, { objectId: f.wallId, hitPoint: { x: 25, y: 4, z: 10.25 } }))
    const [l2] = newObjects<LightObject>(before, store.getState().scene.objects)
    expect(l2.position.z).toBeCloseTo(10 + wall.thickness / 2 + WALL_MOUNT_OFFSET)
    // A cap hit uses the side of the ground point.
    const before2 = store.getState().scene.objects
    tool.onPointerDown!(at(22, 4, { objectId: f.wallId, hitPoint: { x: 22, y: 10, z: 10.05 } }))
    const [l3] = newObjects<LightObject>(before2, store.getState().scene.objects)
    expect(l3.position.z).toBeCloseTo(10 - wall.thickness / 2 - WALL_MOUNT_OFFSET)
  })

  it("wall mounts on terrain measure from the wall's base line at the mount point", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    // Ground rises along +Z: h = 0.4·z.
    const grid = store.getState().scene.grid
    const { samplesX, samplesZ } = sampleCounts(grid, 2)
    const spacing = sampleSpacing(grid.cellSize, 2)
    const heights = new Float32Array(samplesX * samplesZ)
    for (let sz = 0; sz < samplesZ; sz++) heights.fill(0.4 * sz * spacing, sz * samplesX, (sz + 1) * samplesX)
    const extent = { x: 0, z: 0, w: grid.width * grid.cellSize, d: grid.depth * grid.cellSize }
    expect(store.getState().applyTerrainEdit(f.groundId, { base: { lattice: { samplesX, samplesZ, heights, spacing }, rects: [extent] } }, "Paint")).toBe(true)
    const tool = createLightTool({ store })
    const mount = (wallId: string, hit: { x: number; y: number; z: number }) => {
      const before = store.getState().scene.objects
      tool.onPointerDown!(at(hit.x, hit.z - 5, { objectId: wallId, hitPoint: hit }))
      const [l] = newObjects<LightObject>(before, store.getState().scene.objects)
      return lightWorldPosition(store.getState().scene, l)
    }
    const torch = LIGHT_PRESETS.torch.height
    // The fixture wall (z = 10) follows the terrain: its base is the ground on its centreline (4 ft).
    const wall = store.getState().scene.objects[f.wallId] as WallObject
    expect(wall.followTerrain).toBe(true)
    const onFollow = mount(f.wallId, { x: 20.2, y: 8, z: 9.75 })
    expect(onFollow.z).toBeCloseTo(9.45)
    expect(onFollow.y).toBeCloseTo(levelGround(store.getState().scene, f.groundId, 20.2, 10) + torch)
    expect(onFollow.y).toBeCloseTo(4 + torch)

    // A wall on the level elevation, buried 7.78 ft deep at the mount point: the light stays 0.5 ft above the ground.
    const buried = createWall(f.groundId, { x: 50, z: 20 }, { x: 70, z: 20 }, { followTerrain: false })
    store.getState().addObject(buried)
    const onBuried = mount(buried.id, { x: 60, y: 9, z: 19.75 })
    expect(0.4 * 19.45 + 0.5).toBeGreaterThan(torch)
    expect(onBuried.y).toBeCloseTo(0.4 * 19.45 + 0.5)
    // Low wall: kept 0.5 ft under its top.
    const low = createWall(f.groundId, { x: 50, z: 80 }, { x: 70, z: 80 }, { height: 3 })
    store.getState().addObject(low)
    expect(mount(low.id, { x: 60, y: 33, z: 79.75 }).y).toBeCloseTo(0.4 * 80 + 2.5)
  })

  it("wallMountHeight on flat ground clamps the preset height into the wall", () => {
    const f = fixtureScene()
    const wall = f.scene.objects[f.wallId] as WallObject
    expect(wallMountHeight(f.scene, wall, { x: 20, z: 9.45 }, 5)).toBe(5)
    expect(wallMountHeight(f.scene, { ...wall, height: 4 }, { x: 20, z: 9.45 }, 5)).toBe(3.5)
    expect(wallMountHeight(f.scene, { ...wall, height: 0.6 }, { x: 20, z: 9.45 }, 5)).toBe(0.5)
  })

  it("a click on a door mounts the light on the door's wall", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    const tool = createLightTool({ store })
    tool.onPointerDown!(at(15, 30, { objectId: f.doorId, hitPoint: { x: 15, y: 4, z: 10.25 } }))
    const [l] = newObjects<LightObject>(f.scene.objects, store.getState().scene.objects)
    expect(l.position.x).toBeCloseTo(15)
    expect(l.position.z).toBeCloseTo(10 + 0.25 + WALL_MOUNT_OFFSET)
  })

  it("clicking a token attaches the light to it", () => {
    const f = fixtureScene()
    const hero = createToken(f.upperId, { x: 12.5, z: 12.5 })
    f.scene.tokens[hero.id] = hero
    const store = makeStore(f.scene)
    const tool = createLightTool({ store })
    tool.onPointerDown!(at(12.5, 12.5, { tokenId: hero.id }))
    const [l] = newObjects<LightObject>(f.scene.objects, store.getState().scene.objects)
    expect(l).toMatchObject({ attachedTokenId: hero.id, levelId: f.upperId, position: { x: 0, y: LIGHT_PRESETS.torch.height, z: 0 } })
    expect(store.getState().history.undoLabel).toBe("Attach light")
  })
})
