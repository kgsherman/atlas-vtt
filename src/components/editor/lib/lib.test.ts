import { describe, expect, it } from "vitest"

import { createFloor, createLevel, createLight, createScene, createToken, createWall } from "@/core/scene/factory"
import { createHeightmap, sampleHeight, writeHeights, sampleCounts } from "@/core/scene/heightmap"
import { parseScene, serializeScene } from "@/core/scene/schema"
import type { Scene } from "@/core/scene/types"
import { decodeGrades, decodeMask, getCell } from "@/core/vision"
import { createEditorStore } from "@/editor/store"

import { describeIssues, formatBytes, formatElevation, formatFeet, itemLabel, relativeTime, selectionSummary, trimNumber } from "./format"
import {
  duplicateLevel,
  guessStoreyFromName,
  levelNameFromFile,
  levelsTopDown,
  nextLevelElevation,
  resampleHeightmap,
  setTerrainResolution,
  suggestLevelForImage,
} from "./levelOps"
import { presetForFileNames, withPreset } from "./environmentPresets"
import { defaultCalibration, floorPlanForLevel, importRect, pxPerCell, requiredGrid, sceneNameFromFiles } from "./importPlan"
import { cursorReadout, editorMayHandleKey, isTextEntryTarget, stripBackgroundFloor, toToolPointerEvent } from "./pointer"
import { createPreviewVision, defaultPreviewToken, playerPreviewScene, previewCandidates } from "./preview"
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

  it("resamples terrain between resolutions", () => {
    const grid = { width: 4, depth: 4, cellSize: 5, diagonalRule: "5-5-5" as const }
    const { samplesX, samplesZ } = sampleCounts(grid, 1)
    const dense = new Float32Array(samplesX * samplesZ)
    for (let k = 0; k < dense.length; k++) dense[k] = (k % samplesX) * 2 // linear ramp along x
    const hm = writeHeights(createHeightmap(1), grid, dense)
    const hi = resampleHeightmap(hm, grid, 4)
    expect(hi.resolution).toBe(4)
    for (const x of [0, 2.5, 7.5, 13.75]) expect(sampleHeight(hi, 5, x, 6)).toBeCloseTo(sampleHeight(hm, 5, x, 6), 4)

    const scene = createScene({ width: 4, depth: 4 })
    const g = groundOf(scene)
    scene.levels[g].heightmap = hm
    const s = store(scene)
    expect(setTerrainResolution(s, g, 2)).toBe(true)
    expect(s.getState().scene.levels[g].heightmap?.resolution).toBe(2)
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
    expect(toToolPointerEvent(base, { ...pick, ground: null }, { grid, snapMode: "vertex", altHeld: false }, { button: 2 })).toMatchObject({ snapped: null, button: 2 })
    expect(cursorReadout(grid, { x: 12, z: 49 })).toEqual({ i: 2, j: 9, x: 12, z: 49, inside: true })
    expect(cursorReadout(grid, { x: -1, z: 3 })?.inside).toBe(false)
    expect(isTextEntryTarget(null)).toBe(false)
  })
})

describe("preview", () => {
  const lit = () => {
    const scene = createScene({ width: 12, depth: 12 })
    const g = groundOf(scene)
    const pc = createToken(g, { x: 12.5, z: 12.5 }, { name: "Aria", kind: "pc" })
    const npc = createToken(g, { x: 22.5, z: 12.5 }, { name: "Bob", kind: "npc" })
    const spy = createToken(g, { x: 32.5, z: 12.5 }, { name: "Spy", kind: "monster", hidden: true })
    const torch = createLight(g, "torch", { x: 15, z: 15 })
    const secret = createWall(g, { x: 40, z: 0 }, { x: 40, z: 20 }, { hidden: true })
    for (const t of [pc, npc, spy]) scene.tokens[t.id] = t
    scene.objects[torch.id] = torch
    scene.objects[secret.id] = secret
    return { scene, g, pc, npc, spy, torch, secret }
  }

  it("chooses candidates and the default viewer", () => {
    const { scene, pc, npc } = lit()
    expect(previewCandidates(scene)[0]).toBe(pc.id)
    expect(defaultPreviewToken(scene, [npc.id])).toBe(npc.id)
    expect(defaultPreviewToken(scene, [])).toBe(pc.id)
  })

  it("computes perception masks with explored = perceived and a filtered scene", () => {
    const { scene, g, pc, npc, spy, secret } = lit()
    const vision = createPreviewVision()
    const r = vision.compute(scene, [pc.id])
    const grades = decodeGrades(r.masks[g].perception)
    const explored = decodeMask(r.masks[g].explored)
    const cell = 2 * scene.grid.width + 2 // the viewer's own cell
    expect(grades.grades[cell]).toBe(3)
    expect(getCell(explored, cell)).toBe(true)
    // Unlit far corner: not perceived, not explored.
    const far = 11 * scene.grid.width + 11
    expect(grades.grades[far]).toBe(0)
    expect(getCell(explored, far)).toBe(false)
    expect(r.visibleTokenIds).toContain(npc.id)
    expect(Object.keys(r.scene.tokens).sort()).toEqual([pc.id, npc.id].sort())
    expect(Object.hasOwn(r.scene.tokens, spy.id)).toBe(false)
    expect(Object.hasOwn(r.scene.objects, secret.id)).toBe(false)
    // Incremental update after an edit.
    const moved: Scene = { ...scene, tokens: { ...scene.tokens, [pc.id]: { ...pc, position: { x: 57.5, z: 57.5 } } } }
    const r2 = vision.compute(moved, [pc.id], { tokens: [pc.id] })
    expect(decodeGrades(r2.masks[g].perception).grades[cell]).toBe(3) // still inside the torch light
  })

  it("drops lights carried by tokens that are not kept", () => {
    const { scene, g, npc } = lit()
    const carried = createLight(g, "torch", { x: 0, z: 0 }, { attachedTokenId: npc.id, position: { x: 0, y: 4, z: 0 } })
    scene.objects[carried.id] = carried
    expect(Object.hasOwn(playerPreviewScene(scene, new Set()).objects, carried.id)).toBe(false)
    expect(Object.hasOwn(playerPreviewScene(scene, new Set([npc.id])).objects, carried.id)).toBe(true)
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
    const ev = (objectId: string | null, shift = false) => ({ pick: { ground: { x: 1, y: 0, z: 1 }, objectId, tokenId: null, hitPoint: { x: 1, y: 0, z: 1 } }, shift, ctrl: false })
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

describe("editorMayHandleKey", () => {
  it("leaves navigation keys to focused widgets", () => {
    const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, closest: () => null, isContentEditable: false, ...extra }) as unknown as EventTarget
    expect(editorMayHandleKey("ArrowUp", el("CANVAS"))).toBe(true)
    expect(editorMayHandleKey("ArrowUp", el("BODY"))).toBe(true)
    expect(editorMayHandleKey("ArrowUp", el("BUTTON"))).toBe(false)
    expect(editorMayHandleKey("w", el("BUTTON"))).toBe(true)
    expect(editorMayHandleKey("w", el("INPUT", { type: "text" }))).toBe(false)
    expect(editorMayHandleKey("Delete", el("TEXTAREA"))).toBe(false)
    expect(editorMayHandleKey("ArrowLeft", el("INPUT", { type: "range" }))).toBe(false)
  })
})
