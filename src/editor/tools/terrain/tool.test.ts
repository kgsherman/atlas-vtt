import { describe, expect, it } from "vitest"

import { createLevel, createProp } from "@/core/scene/factory"
import { blockShape } from "@/core/scene/terrainShapes"

import type { ShortcutAction } from "../../shortcuts"
import { key } from "../../test-utils"
import { READ_ONLY_HINT } from "../terrain"
import { terrainHarness, type TerrainHarness } from "./harness"

const act = (t: TerrainHarness, action: ShortcutAction, k = "") => t.tool.onKeyDown!(key(k, { action }))

/** Start a block and leave it in the height phase at +4 ft. */
function blockInHeightPhase(t: TerrainHarness) {
  t.store.getState().setToolSettings("terrain", { sub: "block" })
  t.tool.onPointerDown!(t.at(20, 0, 20))
  const release = t.at(30, 0, 30)
  t.tool.onPointerMove!(release)
  t.tool.onPointerUp!(release)
  t.tool.onPointerMove!(t.heightAt({ x: 30, y: 0, z: 30 }, release, 4))
  expect(t.overlay().label?.text).toBe("+4 ft · Add")
}

describe("terrain tool", () => {
  it("cancels a gesture when its basis changes (level, sub-tool, the level's terrain), not on other scene changes", () => {
    const t = terrainHarness()
    const { store, tool, levelId } = t
    const upper = createLevel({ id: "upper", name: "Upper", elevation: 10 })
    store.getState().apply((d) => {
      d.levels[upper.id] = upper
    }, "Add level")

    blockInHeightPhase(t)
    // An unrelated edit (the live host re-syncs on every player step) keeps the gesture.
    store.getState().addObject(createProp(levelId, "crate", { x: 80, y: 0, z: 80 }))
    expect(t.overlay().draft).not.toBeNull()
    // Switching the active level cancels it, and its preview.
    store.getState().setActiveLevel("upper")
    expect(t.previews.at(-1)!.heights).toBeNull()
    store.getState().setActiveLevel(levelId)
    expect(t.overlay().draft).toBeNull()
    expect(tool.onKeyDown!(key("Enter", { action: { type: "confirm" } }))).toBe(false)
    expect(t.shapes()).toEqual([])

    blockInHeightPhase(t)
    store.getState().setToolSettings("terrain", { sub: "ramp" })
    expect(t.overlay().draft).toBeNull()

    blockInHeightPhase(t)
    store.getState().applyTerrainEdit(levelId, { upsert: [blockShape("other", { x: 60, z: 60, w: 5, d: 5 }, 0, 1, 0)] }, "Elsewhere")
    expect(t.overlay().draft).toBeNull()

    // A brush stroke: the grid changing underneath cancels it.
    store.getState().setToolSettings("terrain", { sub: "brush" })
    tool.onPointerDown!(t.at(40, 0, 40))
    expect(tool.painting()).toBe(true)
    store.getState().updateGrid({ width: 22 })
    expect(tool.painting()).toBe(false)
  })

  it("undo / redo during an uncommitted gesture only cancel it", () => {
    const t = terrainHarness()
    const { store } = t
    t.add(blockShape("first", { x: 60, z: 60, w: 10, d: 10 }, 0, 3, 0))
    blockInHeightPhase(t)
    expect(act(t, { type: "undo" }, "z")).toBe(true)
    expect(t.overlay().draft).toBeNull()
    expect(store.getState().history.undoDepth).toBe(1)
    expect(t.shapes().map((s) => s.id)).toEqual(["first"])
    blockInHeightPhase(t)
    expect(act(t, { type: "redo" }, "y")).toBe(true)
    expect(t.overlay().draft).toBeNull()
    // Without a gesture the keymap handles them.
    expect(act(t, { type: "undo" }, "z")).toBe(false)
  })

  it("read-only: no creation, painting or edits; selection still works", () => {
    const t = terrainHarness()
    const { store, tool, levelId } = t
    const a = t.add(blockShape("a", { x: 10, z: 10, w: 10, d: 10 }, 0, 5, 0))
    store.getState().loadScene(store.getState().scene, { readOnly: true })
    store.getState().setToolSettings("terrain", { sub: "brush" })
    tool.onPointerDown!(t.at(40, 0, 40))
    expect(tool.painting()).toBe(false)
    expect(t.previews).toHaveLength(0)
    expect(tool.hint()).toBe(READ_ONLY_HINT)

    store.getState().setToolSettings("terrain", { sub: "select" })
    tool.onPointerDown!(t.at(15, 5, 15))
    tool.onPointerMove!(t.at(25, 5, 15))
    tool.onPointerUp!(t.at(25, 5, 15))
    expect(store.getState().terrainSelection?.shapeIds).toEqual([a])
    expect(t.shape(a).points[0]).toEqual({ x: 10, y: 5, z: 10 })
    expect(t.overlay().gizmo).toBeNull()
    for (const action of [
      { type: "delete" },
      { type: "duplicate" },
      { type: "nudge", x: 1, z: 0, fine: false },
      { type: "rotate", turns: 1 },
    ] as ShortcutAction[]) {
      expect(act(t, action)).toBe(true)
    }
    expect(t.shapes()).toHaveLength(1)
    expect(t.shape(a).points[0]).toEqual({ x: 10, y: 5, z: 10 })
    expect(store.getState().scene.levels[levelId].terrainEdits?.shapes).toHaveProperty(a)
  })

  it("consumes the object-selection actions so a hidden object selection is never edited", () => {
    const t = terrainHarness()
    const { store, levelId } = t
    const crate = createProp(levelId, "crate", { x: 80, y: 0, z: 80 })
    store.getState().addObject(crate)
    store.getState().select([crate.id])
    const scene = store.getState().scene
    const actions: ShortcutAction[] = [
      { type: "delete" },
      { type: "duplicate" },
      { type: "select-all" },
      { type: "nudge", x: 1, z: 0, fine: false },
      { type: "rotate", turns: 1 },
      { type: "copy" },
      { type: "cut" },
      { type: "paste" },
    ]
    for (const action of actions) expect(act(t, action), action.type).toBe(true)
    expect(store.getState().scene).toBe(scene)
    expect(store.getState().selection).toEqual([crate.id])
    expect(store.getState().clipboard).toBeNull()
    // Keys the tool does not use are left to the keymap.
    expect(act(t, { type: "toggle-grid" }, "g")).toBe(false)
    expect(act(t, { type: "terrain-sub", sub: "brush" }, "b")).toBe(false)
  })

  it("always previews a TerrainOverlay, memoised; shapes keep their identity", () => {
    const t = terrainHarness({ sub: "brush" })
    const { tool, store, levelId } = t
    const empty = t.overlay()
    expect(empty).toMatchObject({ kind: "terrain", levelId, shapes: [], selectedShapeIds: [], draft: null, gizmo: null, brush: null, elements: null })
    expect(tool.preview()).toBe(empty)
    const a = t.add(blockShape("a", { x: 10, z: 10, w: 10, d: 10 }, 0, 5, 0))
    const o1 = t.overlay()
    expect(o1.shapes.map((s) => s.id)).toEqual([a])
    tool.onPointerMove!(t.at(40, 0, 40))
    const o2 = t.overlay()
    expect(o2).not.toBe(o1)
    expect(o2.brush).toMatchObject({ center: { x: 40, z: 40 }, radius: 10 })
    expect(o2.shapes).toBe(o1.shapes)
    // Scene changes that do not touch the level's shapes keep the overlay.
    store.getState().addObject(createProp(levelId, "crate", { x: 80, y: 0, z: 80 }))
    expect(tool.preview()).toBe(o2)
    // A brush hint while the level has shapes.
    expect(tool.hint()).toMatch(/Apply to terrain/)
  })
})
