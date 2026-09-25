import { describe, expect, it } from "vitest"

import { createFloor, createLevel, createLight, createScene, createToken, createWall } from "@/core/scene/factory"
import { parseScene, serializeScene } from "@/core/scene/schema"
import { blockShape, rampShape } from "@/core/scene/terrainShapes"
import type { Scene } from "@/core/scene/types"
import { createEditorController } from "@/editor/controller"
import { createEditorStore } from "@/editor/store"

import { describeIssues, formatBytes, formatElevation, formatFeet, itemLabel, relativeTime, selectionSummary, trimNumber } from "./format"
import { duplicateLevel, guessStoreyFromName, levelNameFromFile, levelsTopDown, nextLevelElevation, suggestLevelForImage } from "./levelOps"
import { presetForFileNames, withPreset } from "./environmentPresets"
import { defaultCalibration, floorPlanForLevel, importRect, pxPerCell, requiredGrid, sceneNameFromFiles } from "./importPlan"
import { cursorReadout, editorCursor, editorMayHandleKey, isTextEntryTarget, stripBackgroundFloor, toToolPointerEvent } from "./pointer"
import {
  alsoAppliedShapes,
  applyInspectorTerrainEdit,
  offsetShapeTop,
  reorderShapes,
  shapeSampleCount,
  shapeTopStats,
  wallTerrainWarning,
} from "./terrainInspect"
import {
  activeLevelShapes,
  activeTerrainSelection,
  editedTerrainElements,
  runEditorCommand,
  selectedShapes,
  selectionCount,
  selectionFocusBounds,
} from "./terrainMode"
import { applyExtras, defaultToolExtras, extrasApply, lightOverridesFromPreset, newItemIds } from "./toolExtras"

const store = (scene: Scene) => createEditorStore({ scene, systemClipboard: null })
const groundOf = (scene: Scene) => Object.keys(scene.levels)[0]

describe("format", () => {
  it("formats numbers, feet and elevations", () => {
    expect(trimNumber(2.345)).toBe("2.35")
    expect(trimNumber(-0.0001)).toBe("0")
    expect(formatFeet(10)).toBe("10 ft")
    expect(formatFeet(2.55, 1)).toBe("2.6 ft")
    expect(formatElevation(10)).toBe("+10 ft")
    expect(formatElevation(-10)).toBe("−10 ft")
    expect(formatElevation(0.01)).toBe("0 ft")
    expect(formatBytes(512)).toBe("512 B")
    expect(formatBytes(3 * 1024 * 1024)).toBe("3 MB")
    expect(formatBytes(820 * 1024)).toBe("820 KB")
    expect(formatBytes(12.4 * 1024 * 1024)).toBe("12.4 MB")
    expect(formatBytes(-1)).toBe("—")
  })

  it("describes relative times", () => {
    const now = Date.parse("2026-01-01T12:00:00Z")
    expect(relativeTime("2026-01-01T11:59:50Z", now)).toBe("just now")
    expect(relativeTime("2026-01-01T11:55:00Z", now)).toBe("5 min ago")
    expect(relativeTime("2026-01-01T09:00:00Z", now)).toBe("3 h ago")
    expect(relativeTime("nope", now)).toBe("")
  })

  it("labels items and summarises selections", () => {
    const scene = createScene()
    const g = groundOf(scene)
    const wall = createWall(g, { x: 0, z: 0 }, { x: 10, z: 0 })
    const light = createLight(g, "torch", { x: 5, z: 5 }, { name: "Hall torch" })
    const token = createToken(g, { x: 2.5, z: 2.5 }, { name: "Mira" })
    scene.objects[wall.id] = wall
    scene.objects[light.id] = light
    scene.tokens[token.id] = token
    expect(itemLabel(scene, wall.id)).toBe("Wall")
    expect(itemLabel(scene, light.id)).toBe("Hall torch")
    expect(itemLabel(scene, token.id)).toBe("Mira")
    expect(selectionSummary(scene, [wall.id, light.id, token.id])).toBe("1 token, 1 wall, 1 light")
    expect(describeIssues(["a", "b", "c"])).toBe("A (+2 more)")
    expect(describeIssues(["objects.nIa_wceYq232.rect: rect lies outside the scene extent"])).toBe("Rect lies outside the scene extent")
  })
})

describe("levelOps", () => {
  it("orders levels top-down and computes the next elevation", () => {
    const scene = createScene()
    const upper = createLevel({ name: "Upper", elevation: 10 })
    const cellar = createLevel({ name: "Cellar", elevation: -10 })
    scene.levels[upper.id] = upper
    scene.levels[cellar.id] = cellar
    expect(levelsTopDown(scene).map((l) => l.name)).toEqual(["Upper", "Ground Floor", "Cellar"])
    expect(nextLevelElevation(scene)).toBe(20)
  })

  it("duplicates a level with its objects in one undo step", () => {
    const scene = createScene({ width: 10, depth: 10 })
    const g = groundOf(scene)
    const wall = createWall(g, { x: 5, z: 5 }, { x: 25, z: 5 }, { name: "North" })
    scene.objects[wall.id] = wall
    const token = createToken(g, { x: 12.5, z: 12.5 })
    scene.tokens[token.id] = token
    const s = store(scene)
    const id = duplicateLevel(s, g)
    expect(id).not.toBeNull()
    const next = s.getState().scene
    expect(next.levels[id!].elevation).toBe(10)
    expect(next.levels[id!].name).toBe("Ground Floor copy")
    const copied = Object.values(next.objects).filter((o) => o.levelId === id)
    expect(copied.map((o) => o.type).sort()).toEqual(["floor", "wall"])
    expect(Object.values(next.tokens).filter((t) => t.levelId === id)).toHaveLength(0)
    expect(s.getState().activeLevelId).toBe(id)
    expect(parseScene(JSON.parse(serializeScene(next))).ok).toBe(true)
    s.getState().undo()
    expect(Object.keys(s.getState().scene.levels)).toHaveLength(1)
  })

  it("duplicates a level with its terrain shapes", () => {
    const scene = createScene({ width: 10, depth: 10 })
    const g = groundOf(scene)
    const s = store(scene)
    expect(s.getState().applyTerrainEdit(g, { upsert: [blockShape("hill", { x: 10, z: 10, w: 10, d: 10 }, 0, 4, 0)] }, "Add block")).toBe(true)
    const src = s.getState().scene.levels[g]
    const id = duplicateLevel(s, g)
    expect(id).not.toBeNull()
    const copy = s.getState().scene.levels[id!]
    expect(copy.heightmap).toEqual(src.heightmap)
    expect(copy.terrainEdits).toEqual(src.terrainEdits)
    expect(parseScene(JSON.parse(serializeScene(s.getState().scene))).ok).toBe(true)
  })

  it("guesses storeys and names from map file names", () => {
    expect(guessStoreyFromName("181-FA-Vineyard-Interior-27x47-NoGrid-Basement-Night.png")).toEqual({ storey: -1, name: "Basement" })
    expect(guessStoreyFromName("181-FA-Vineyard-Interiors-27x47-NoGrid-FirstFloor-Night.jpg")).toEqual({ storey: 0, name: "Ground Floor" })
    expect(guessStoreyFromName("181-FA-Vineyard-Interior-27x47-NoGrid-SecondFloor-Night.png")).toEqual({ storey: 1, name: "Second Floor" })
    expect(guessStoreyFromName("tavern_second_floor.webp")?.storey).toBe(1)
    expect(guessStoreyFromName("forest-clearing.png")).toBeNull()
    expect(levelNameFromFile("181-FA-Forest-Clearing-30x30-NoGrid.png")).toBe("Forest Clearing")
  })

  it("suggests existing levels or new ones for imported images", () => {
    const scene = createScene()
    const g = groundOf(scene)
    expect(suggestLevelForImage(scene, "x-FirstFloor.jpg")).toEqual({ levelId: g, name: "Ground Floor", elevation: 0 })
    expect(suggestLevelForImage(scene, "x-Basement.png")).toEqual({ levelId: null, name: "Basement", elevation: -10 })
    expect(suggestLevelForImage(scene, "x-FirstFloor.jpg", new Set([g])).levelId).toBeNull()
  })
})

describe("pointer", () => {
  it("builds snapped tool events and honours Alt", () => {
    const grid = { cellSize: 5, width: 10, depth: 10, diagonalRule: "5-5-5" as const }
    const pick = { ground: { x: 6.2, y: 0, z: 13.9 }, objectId: null, tokenId: null, hitPoint: null }
    const base = { clientX: 10, clientY: 20, button: 0, shiftKey: false, altKey: false, ctrlKey: false, metaKey: true, detail: 2 }
    const e = toToolPointerEvent(base, pick, { grid, snapMode: "center", altHeld: false })
    expect(e.snapped).toEqual({ x: 7.5, z: 12.5 })
    expect(e.ctrl).toBe(true)
    expect(e.detail).toBe(2)
    const free = toToolPointerEvent({ ...base, altKey: true }, pick, { grid, snapMode: "center", altHeld: false })
    expect(free.snapped).toEqual({ x: 6.2, z: 13.9 })
    expect(toToolPointerEvent(base, { ...pick, ground: null }, { grid, snapMode: "vertex", altHeld: false }, { button: 2 })).toMatchObject({
      snapped: null,
      button: 2,
    })
    expect(cursorReadout(grid, { x: 12, y: 13, z: 49 }, 10)).toEqual({ i: 2, j: 9, x: 12, y: 3, z: 49, inside: true })
    expect(cursorReadout(grid, { x: -1, y: 0, z: 3 })?.inside).toBe(false)
    expect(isTextEntryTarget(null)).toBe(false)
  })

  it("fills canvas-relative coordinates and the pressed buttons", () => {
    const grid = { cellSize: 5, width: 10, depth: 10, diagonalRule: "5-5-5" as const }
    const pick = { ground: null, objectId: null, tokenId: null, hitPoint: null }
    const base = { clientX: 110, clientY: 220, button: 0, buttons: 2, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }
    const e = toToolPointerEvent(base, pick, { grid, snapMode: "center", altHeld: false }, { origin: { left: 100, top: 200 } })
    expect(e).toMatchObject({ canvasX: 10, canvasY: 20, buttons: 2, clientX: 110, clientY: 220 })
    const bare = toToolPointerEvent(base, pick, { grid, snapMode: "center", altHeld: false })
    expect(bare.canvasX).toBeUndefined()
    expect(bare.canvasY).toBeUndefined()
  })

  it("uses the tool's cursor, else the tool's default", () => {
    const s = store(createScene())
    const controller = createEditorController(s)
    expect(editorCursor(controller, false)).toBe("default")
    s.getState().setTool("wall")
    expect(editorCursor(controller, false)).toBe("crosshair")
    s.getState().setTool("terrain")
    s.getState().setToolSettings("terrain", { sub: "select" })
    expect(editorCursor(controller, false)).toBe("default")
    s.getState().setToolSettings("terrain", { sub: "block" })
    expect(editorCursor(controller, false)).toBe(controller.toolCursor() ?? "crosshair")
    controller.dispose()
  })
})

describe("terrainMode", () => {
  const setup = () => {
    const scene = createScene({ width: 12, depth: 12 })
    const g = groundOf(scene)
    const wall = createWall(g, { x: 5, z: 5 }, { x: 25, z: 5 })
    scene.objects[wall.id] = wall
    const s = store(scene)
    s.getState().applyTerrainEdit(
      g,
      { upsert: [blockShape("a", { x: 10, z: 10, w: 10, d: 5 }, 0, 3, 0), blockShape("b", { x: 30, z: 30, w: 5, d: 5 }, 0, 2, 1)] },
      "Add blocks"
    )
    const controller = createEditorController(s)
    return { s, g, wall, controller }
  }

  it("counts, lists and bounds the shape selection in the terrain mode only", () => {
    const { s, g, wall, controller } = setup()
    s.getState().select([wall.id])
    s.getState().setTool("terrain")
    expect(selectionCount(s.getState())).toBe(0)
    expect(Object.keys(activeLevelShapes(s.getState()))).toEqual(["a", "b"])
    s.getState().setTerrainSelection({ levelId: g, shapeIds: ["b", "a"], elements: [] })
    expect(activeTerrainSelection(s.getState())?.shapeIds).toEqual(["b", "a"])
    expect(selectedShapes(s.getState()).map((sh) => sh.id)).toEqual(["b", "a"])
    expect(selectionCount(s.getState())).toBe(2)
    expect(selectionFocusBounds(s.getState())).toEqual({ x: 10, z: 10, w: 25, d: 25 })
    s.getState().setTool("select")
    expect(selectionCount(s.getState())).toBe(1)
    expect(selectionFocusBounds(s.getState())).not.toBeNull()
    expect(selectedShapes(s.getState())).toEqual([])
    controller.dispose()
  })

  it("routes menu commands to the terrain tool, never to the hidden object selection", () => {
    const { s, g, wall, controller } = setup()
    s.getState().select([wall.id])
    s.getState().setTool("terrain")
    s.getState().setToolSettings("terrain", { sub: "select" })
    // Nothing selected in the mode: consumed, the wall stays (and is not duplicated).
    const objects = s.getState().scene.objects
    expect(runEditorCommand(controller, { type: "delete" })).toBe(true)
    expect(runEditorCommand(controller, { type: "duplicate" })).toBe(true)
    expect(s.getState().scene.objects).toBe(objects)
    // Select all → the level's shapes; delete removes them, not the wall.
    runEditorCommand(controller, { type: "select-all" })
    expect(s.getState().terrainSelection?.shapeIds.slice().sort()).toEqual(["a", "b"])
    runEditorCommand(controller, { type: "delete" })
    expect(s.getState().scene.levels[g].terrainEdits).toBeUndefined()
    expect(Object.hasOwn(s.getState().scene.objects, wall.id)).toBe(true)
    // Outside the mode the same command acts on objects again.
    s.getState().setTool("select")
    s.getState().select([wall.id])
    runEditorCommand(controller, { type: "delete" })
    expect(Object.hasOwn(s.getState().scene.objects, wall.id)).toBe(false)
    controller.dispose()
  })

  it("counts the selected elements only where the tool edits them (Select sub-tool, advanced mode)", () => {
    const { s, g, controller } = setup()
    s.getState().setTool("terrain")
    s.getState().setToolSettings("terrain", { sub: "select", advanced: true, element: "vertex" })
    s.getState().setTerrainSelection({ levelId: g, shapeIds: ["a"], elements: [{ shapeId: "a", kind: "vertex", index: 0 }] })
    expect(editedTerrainElements(s.getState())).toBe(1)
    s.getState().setToolSettings("terrain", { advanced: false })
    expect(editedTerrainElements(s.getState())).toBe(0)
    s.getState().setToolSettings("terrain", { advanced: true, sub: "brush" })
    // The vertex stays selected (hidden) in Brush, but Delete there removes the whole shape.
    expect(s.getState().terrainSelection?.elements).toHaveLength(1)
    expect(editedTerrainElements(s.getState())).toBe(0)
    runEditorCommand(controller, { type: "delete" })
    expect(Object.keys(activeLevelShapes(s.getState()))).toEqual(["b"])
    controller.dispose()
  })
})

describe("toolExtras", () => {
  it("applies door, token and light extras to new items only", () => {
    const scene = createScene()
    const g = groundOf(scene)
    const before = { objects: { ...scene.objects }, tokens: { ...scene.tokens } }
    const light = createLight(g, "torch", { x: 5, z: 5 })
    const token = createToken(g, { x: 2.5, z: 2.5 })
    const floor = createFloor(g, { x: 0, z: 0, w: 5, d: 5 })
    const after = { objects: { ...scene.objects, [light.id]: light, [floor.id]: floor }, tokens: { [token.id]: token } }
    const created = newItemIds(before, after)
    expect(created.objects.sort()).toEqual([light.id, floor.id].sort())
    expect(created.tokens).toEqual([token.id])

    const extras = defaultToolExtras()
    expect(extrasApply("door", extras)).toBe(false)
    expect(extrasApply("light", extras)).toBe(false)
    extras.token.vision = { darkvision: 60, blindsight: 0, blind: false }
    extras.light = { ...lightOverridesFromPreset("torch"), color: "#00ff00", dimRadius: 10, brightRadius: 25 }
    expect(extrasApply("token", extras)).toBe(true)
    const draft = structuredClone(after) as Scene
    applyExtras(draft, created, extras)
    expect(draft.tokens[token.id].vision.darkvision).toBe(60)
    const l = draft.objects[light.id]
    expect(l.type === "light" && l.color).toBe("#00ff00")
    expect(l.type === "light" && l.dimRadius).toBe(25) // clamped to ≥ bright
  })
})

describe("importPlan", () => {
  it("defaults the calibration from the name, then 140 px cells, then the scene grid", () => {
    const grid = { width: 40, depth: 30 }
    expect(defaultCalibration({ cellsX: 27, cellsZ: 47 }, { width: 9000, height: 15000 }, grid)).toEqual({ cellsX: 27, cellsZ: 47 })
    expect(defaultCalibration(null, { width: 3780, height: 6580 }, grid)).toEqual({ cellsX: 27, cellsZ: 47 })
    expect(defaultCalibration(null, { width: 1000, height: 777 }, grid)).toEqual({ cellsX: 40, cellsZ: 30 })
    expect(defaultCalibration({ cellsX: 500, cellsZ: 0 }, null, grid)).toEqual({ cellsX: 200, cellsZ: 1 })
  })

  it("computes px per cell and the grid the images need", () => {
    expect(pxPerCell({ width: 9000, height: 15000 }, 27, 47)).toMatchObject({ square: true })
    expect(pxPerCell({ width: 9000, height: 15000 }, 27, 30).square).toBe(false)
    expect(requiredGrid([{ cellsX: 27, cellsZ: 47, offsetX: 0, offsetZ: 0 }], 5)).toEqual({ width: 27, depth: 47 })
    expect(requiredGrid([{ cellsX: 27, cellsZ: 47, offsetX: 10, offsetZ: 0 }], 5, { width: 40, depth: 30 })).toEqual({ width: 40, depth: 47 })
  })

  it("names scenes after the map", () => {
    expect(sceneNameFromFiles(["181-FA-Vineyard-Interiors-27x47-NoGrid-FirstFloor-Night.jpg"])).toBe("Vineyard Interiors")
    expect(sceneNameFromFiles(["181-FA-Vineyard-Interior-27x47-NoGrid-Basement-Night.png"])).toBe("Vineyard Interior")
    expect(sceneNameFromFiles(["12.png"])).toBe("Imported Map")
    // One tokenizer for scene and level names: noise words go even inside camelCase runs.
    expect(sceneNameFromFiles(["Keep-GroundFloorDusk.png"])).toBe("Keep")
    expect(levelNameFromFile("Keep-TowerDawn-NoGrid.png")).toBe("Keep Tower")
  })
})

describe("environmentPresets", () => {
  it("picks lighting from map names and applies presets to a full environment", () => {
    expect(presetForFileNames(["181-FA-Vineyard-Interiors-27x47-NoGrid-FirstFloor-Night.jpg"])).toBe("moonlit")
    expect(presetForFileNames(["Tavern-Day.png"])).toBe("day")
    expect(presetForFileNames(["tavern-dusk.png"])).toBe("dusk")
    expect(presetForFileNames(["sunken-crypt.png"])).toBe("dungeon")
    const scene = createScene()
    const env = withPreset(scene.environment, "day")
    expect(env.skyLevel).toBe("bright")
    expect(env.directional).toMatchObject({ enabled: true, kind: "sun" })
    expect(env.directional.azimuth).toBe(scene.environment.directional.azimuth)
    expect(parseScene(JSON.parse(serializeScene({ ...scene, environment: env }))).ok).toBe(true)
  })
})

describe("stripBackgroundFloor", () => {
  it("hides unselected floors from the select tool unless Shift/Ctrl is held", () => {
    const scene = createScene()
    const floorId = Object.keys(scene.objects)[0]
    const g = groundOf(scene)
    const wall = createWall(g, { x: 0, z: 0 }, { x: 10, z: 0 })
    scene.objects[wall.id] = wall
    const ev = (objectId: string | null, shift = false) => ({
      pick: { ground: { x: 1, y: 0, z: 1 }, objectId, tokenId: null, hitPoint: { x: 1, y: 0, z: 1 } },
      shift,
      ctrl: false,
    })
    expect(stripBackgroundFloor(scene, [], ev(floorId))).toMatchObject({ floorId, event: { pick: { objectId: null, hitPoint: null } } })
    expect(stripBackgroundFloor(scene, [floorId], ev(floorId)).floorId).toBeNull()
    expect(stripBackgroundFloor(scene, [], ev(floorId, true)).event.pick.objectId).toBe(floorId)
    expect(stripBackgroundFloor(scene, [], ev(wall.id)).event.pick.objectId).toBe(wall.id)
  })
})

describe("floorPlanForLevel", () => {
  it("measures floor coverage of an image rect and whether floors can be replaced", () => {
    const scene = createScene({ width: 40, depth: 30 })
    const g = groundOf(scene)
    const rect = importRect({ cellsX: 27, cellsZ: 47, offsetX: 0, offsetZ: 0 }, 5)
    expect(rect).toEqual({ x: 0, z: 0, w: 135, d: 235 })
    const plan = floorPlanForLevel(scene, g, rect)
    expect(plan.hasFloors).toBe(true)
    expect(plan.coverage).toBeCloseTo((135 * 150) / (135 * 235), 5)
    expect(plan.replace).toBe(false) // the 200 ft wide grass floor extends beyond the image
    const inner = createFloor(g, { x: 10, z: 10, w: 20, d: 20 })
    const onlyInner = { ...scene, objects: { [inner.id]: inner } }
    expect(floorPlanForLevel(onlyInner, g, rect)).toMatchObject({ hasFloors: true, replace: true })
    expect(floorPlanForLevel(onlyInner, "nope", rect).hasFloors).toBe(false)
  })
})

describe("terrainInspect", () => {
  it("reads and offsets a shape's top", () => {
    const ramp = rampShape("r", { x: 0, z: 0, w: 10, d: 10 }, 1, 2, 6, 0)
    expect(shapeTopStats(ramp)).toEqual({ mean: 5, min: 2, max: 8 })
    const up = offsetShapeTop(ramp, 1.5)
    expect(shapeTopStats(up)).toEqual({ mean: 6.5, min: 3.5, max: 9.5 })
    expect(up.base).toBe(ramp.base)
    expect(ramp.points[0].y).not.toBe(up.points[0].y)
  })

  it("moves shapes one step in the bake order", () => {
    const at = (id: string, order: number) => blockShape(id, { x: 0, z: 0, w: 5, d: 5 }, 0, 1, order)
    const orders = (up: ReturnType<typeof reorderShapes>) => Object.fromEntries((up ?? []).map((s) => [s.id, s.order]))
    const three = [at("a", 0), at("b", 3), at("c", 7)]
    expect(orders(reorderShapes(three, "a", 1))).toEqual({ a: 3, b: 0 })
    expect(orders(reorderShapes(three, "c", -1))).toEqual({ c: 3, b: 7 })
    expect(reorderShapes(three, "c", 1)).toBeNull()
    expect(reorderShapes(three, "a", -1)).toBeNull()
    expect(reorderShapes(three, "zz", 1)).toBeNull()
    // Shared orders: renumbered so the moved shape really passes its neighbour.
    const tied = [at("a", 2), at("b", 2), at("c", 2)]
    const up = reorderShapes(tied, "a", 1)!
    const next = tied.map((s) => up.find((u) => u.id === s.id) ?? s).sort((p, q) => p.order - q.order || (p.id < q.id ? -1 : 1))
    expect(next.map((s) => s.id)).toEqual(["b", "a", "c"])
  })

  it("flags shapes too small for the terrain resolution", () => {
    const tiny = blockShape("t", { x: 1, z: 1, w: 1, d: 1 }, 0, 2, 0)
    const room = blockShape("r", { x: 0, z: 0, w: 10, d: 10 }, 0, 2, 0)
    expect(shapeSampleCount(tiny, { heightmap: { resolution: 2, chunks: {} } }, { cellSize: 5 })).toBeLessThan(4)
    expect(shapeSampleCount(room, { heightmap: { resolution: 2, chunks: {} } }, { cellSize: 5 })).toBe(4)
    expect(shapeSampleCount(room, { heightmap: null }, { cellSize: 5 })).toBeNull()
  })

  it("warns about buried walls and walls poking through the level above", () => {
    const scene = createScene({ width: 12, depth: 12 })
    const g = groundOf(scene)
    const off = createWall(g, { x: 5, z: 20 }, { x: 45, z: 20 }, { followTerrain: false, height: 8 })
    const on = createWall(g, { x: 5, z: 20 }, { x: 45, z: 20 }, { followTerrain: true, height: 8 })
    // Flat level: nothing to warn about.
    expect(wallTerrainWarning(scene, off)).toBeNull()
    const s = store(scene)
    s.getState().applyTerrainEdit(g, { upsert: [blockShape("hill", { x: 20, z: 10, w: 10, d: 20 }, 0, 4, 0)] }, "Add block")
    const terrain = s.getState().scene
    const buried = wallTerrainWarning(terrain, off)
    expect(buried?.kind).toBe("buried")
    expect(buried && buried.kind === "buried" ? buried.depth : 0).toBeCloseTo(4, 5)
    expect(buried && buried.kind === "buried" ? buried.whole : true).toBe(false)
    // Following the terrain it rides up to 12 ft: no level above → fine; a floor at 10 ft (1 ft thick) → its
    // top pokes 2 ft above that floor.
    expect(wallTerrainWarning(terrain, on)).toBeNull()
    const upper = createLevel({ name: "Upper", elevation: 10, floorThickness: 1 })
    const stacked = { ...terrain, levels: { ...terrain.levels, [upper.id]: upper } }
    const pokes = wallTerrainWarning(stacked, on)
    expect(pokes).toMatchObject({ kind: "pokes", above: "Upper" })
    expect(pokes && pokes.kind === "pokes" ? pokes.by : 0).toBeCloseTo(2, 5)
    expect(wallTerrainWarning(stacked, { ...on, height: 4 })).toBeNull()
  })

  it("reports an Inspector terrain edit as refused only when a shape is invalid, not when it changes nothing", () => {
    const s = store(createScene({ width: 12, depth: 12 }))
    const g = s.getState().activeLevelId
    const hill = { ...blockShape("b", { x: 10, z: 10, w: 10, d: 10 }, 0, 3, 0), name: "Hill" }
    expect(applyInspectorTerrainEdit(s, g, { upsert: [hill] }, "Add shape")).toEqual({ ok: true, refused: false })
    const shape = s.getState().scene.levels[g].terrainEdits!.shapes.b
    // "Hill " trims back to "Hill": nothing changes, which is no error.
    const same = { ...shape, name: "Hill ".trim() || undefined }
    expect(applyInspectorTerrainEdit(s, g, { upsert: [same] }, "Rename shape")).toEqual({ ok: false, refused: false })
    expect(applyInspectorTerrainEdit(s, g, { upsert: [{ ...shape, name: "Mound" }] }, "Rename shape")).toEqual({ ok: true, refused: false })
    // A top beyond ±500 ft: the terrain writer refuses the shape.
    expect(applyInspectorTerrainEdit(s, g, { upsert: [offsetShapeTop(shape, 600)] }, "Move shape top")).toEqual({ ok: false, refused: true })
    expect(s.getState().scene.levels[g].terrainEdits!.shapes.b.name).toBe("Mound")
    // Read-only documents: nothing happens, nothing to report.
    s.getState().loadScene(s.getState().scene, { readOnly: true })
    expect(applyInspectorTerrainEdit(s, g, { upsert: [offsetShapeTop(shape, 600)] }, "Move shape top")).toEqual({ ok: false, refused: false })
  })

  it("lists the older shapes Apply to terrain applies with the selection", () => {
    const s = store(createScene({ width: 20, depth: 20 }))
    const g = s.getState().activeLevelId
    s.getState().applyTerrainEdit(
      g,
      {
        upsert: [
          blockShape("pit", { x: 10, z: 10, w: 30, d: 30 }, 0, -6, 0),
          blockShape("pillar", { x: 20, z: 20, w: 10, d: 10 }, -6, 10, 1),
          blockShape("apart", { x: 60, z: 60, w: 10, d: 10 }, 0, 2, 0),
        ],
      },
      "Add shapes"
    )
    const level = s.getState().scene.levels[g]
    expect(alsoAppliedShapes(level, ["pillar"]).map((sh) => sh.id)).toEqual(["pit"])
    expect(alsoAppliedShapes(level, ["pit", "pillar"])).toEqual([])
    expect(alsoAppliedShapes(level, ["pit"])).toEqual([])
    expect(alsoAppliedShapes(level, ["apart"])).toEqual([])
    expect(alsoAppliedShapes(undefined, ["pillar"])).toEqual([])
  })

  it("does not warn about a default wall reaching the level above on flat terrain, only about the terrain lifting it", () => {
    const s = store(createScene({ width: 12, depth: 12 }))
    const g = s.getState().activeLevelId
    expect(s.getState().enableTerrain(g)).toBe(true)
    s.getState().addLevel() // defaults: elevation 10, 1 ft floor → the ceiling is at 9 ft
    const scene = s.getState().scene
    const upper = Object.values(scene.levels).find((l) => l.id !== g)!
    expect(upper.elevation - upper.floorThickness).toBe(9)
    // A wall with the tool's defaults (storey height, follow terrain) on flat terrain: its top is where it
    // would be without terrain, so nothing to warn about.
    const { height, followTerrain } = s.getState().toolSettings.wall
    const w = createWall(g, { x: 5, z: 20 }, { x: 45, z: 20 }, { height, followTerrain })
    expect(w).toMatchObject({ height: 10, followTerrain: true })
    expect(wallTerrainWarning(scene, w)).toBeNull()
    // A 2 ft block under it lifts its top 2 ft past that.
    s.getState().applyTerrainEdit(g, { upsert: [blockShape("b", { x: 20, z: 15, w: 10, d: 10 }, 0, 2, 0)] }, "Add block")
    const lifted = wallTerrainWarning(s.getState().scene, w)
    expect(lifted).toMatchObject({ kind: "pokes", above: upper.name })
    expect(lifted && lifted.kind === "pokes" ? lifted.by : 0).toBeCloseTo(2, 5)
  })

  it("measures a wall poking through from the top of the floor above, whatever the wall's height", () => {
    const s = store(createScene({ width: 12, depth: 12 }))
    const g = s.getState().activeLevelId
    s.getState().enableTerrain(g)
    s.getState().addLevel() // elevation 10, 1 ft floor: its underside at 9 ft, its top at 10 ft
    s.getState().applyTerrainEdit(g, { upsert: [blockShape("b", { x: 20, z: 15, w: 10, d: 10 }, 0, 2, 0)] }, "Add block")
    const scene = s.getState().scene
    const wall = (height: number) => createWall(g, { x: 5, z: 20 }, { x: 45, z: 20 }, { height, followTerrain: true })
    const by = (height: number) => {
      const warning = wallTerrainWarning(scene, wall(height))
      return warning?.kind === "pokes" ? warning.by : null
    }
    // On the 2 ft block the top is at height + 2.
    expect(by(10)).toBeCloseTo(2, 5)
    expect(by(9)).toBeCloseTo(1, 5)
    expect(by(8.5)).toBeCloseTo(0.5, 5)
    // Lowered by the 2 ft it reported, the 10 ft wall's top is flush with the floor above, like a default
    // wall's on flat ground: no warning (tops inside the slab do not show on the level above either).
    expect(by(10 - 2)).toBeNull()
    expect(by(7.5)).toBeNull()
    // A wall taller than the storey already passes through on flat ground: only the terrain's lift counts.
    expect(by(12)).toBeCloseTo(2, 5)
  })
})

describe("editorMayHandleKey", () => {
  it("leaves navigation keys to focused widgets", () => {
    const el = (tagName: string, extra: Record<string, unknown> = {}) =>
      ({ tagName, closest: () => null, isContentEditable: false, ...extra }) as unknown as EventTarget
    expect(editorMayHandleKey("ArrowUp", el("CANVAS"))).toBe(true)
    expect(editorMayHandleKey("ArrowUp", el("BODY"))).toBe(true)
    expect(editorMayHandleKey("ArrowUp", el("BUTTON"))).toBe(false)
    expect(editorMayHandleKey("w", el("BUTTON"))).toBe(true)
    expect(editorMayHandleKey("w", el("INPUT", { type: "text" }))).toBe(false)
    expect(editorMayHandleKey("Delete", el("TEXTAREA"))).toBe(false)
    expect(editorMayHandleKey("ArrowLeft", el("INPUT", { type: "range" }))).toBe(false)
    // Tab moves focus between widgets; it reaches the canvas (terrain advanced mode) only from there.
    expect(editorMayHandleKey("Tab", el("BUTTON"))).toBe(false)
    expect(editorMayHandleKey("Tab", el("CANVAS"))).toBe(true)
  })
})
