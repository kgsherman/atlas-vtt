import { describe, expect, it } from "vitest"

import { createPillar, createProp, createWall } from "@/core/scene/factory"
import type { DoorObject, PillarObject, PropObject } from "@/core/scene/types"

import { createEditorController } from "./controller"
import { resolveShortcut, SHORTCUTS } from "./shortcuts"
import { at, fixtureScene, key, makeStore } from "./test-utils"

describe("resolveShortcut", () => {
  it("maps tool letters", () => {
    const tools = { v: "select", f: "floor", w: "wall", d: "door", n: "window", s: "connector", p: "pillar", o: "prop", l: "light", t: "terrain", k: "token", m: "measure" }
    for (const [k, tool] of Object.entries(tools)) {
      expect(resolveShortcut(key(k))).toEqual({ type: "tool", tool })
      expect(resolveShortcut(key(k.toUpperCase()))).toEqual({ type: "tool", tool })
    }
    expect(resolveShortcut(key("w", { alt: true }))).toBeNull()
    expect(resolveShortcut(key("W", { shift: true }))).toBeNull()
  })

  it("maps editing, view and navigation keys", () => {
    expect(resolveShortcut(key("z", { ctrl: true }))).toEqual({ type: "undo" })
    expect(resolveShortcut(key("Z", { ctrl: true, shift: true }))).toEqual({ type: "redo" })
    expect(resolveShortcut(key("y", { ctrl: true }))).toEqual({ type: "redo" })
    expect(resolveShortcut(key("c", { ctrl: true }))).toEqual({ type: "copy" })
    expect(resolveShortcut(key("x", { ctrl: true }))).toEqual({ type: "cut" })
    expect(resolveShortcut(key("v", { ctrl: true }))).toEqual({ type: "paste" })
    expect(resolveShortcut(key("d", { ctrl: true }))).toEqual({ type: "duplicate" })
    expect(resolveShortcut(key("a", { ctrl: true }))).toEqual({ type: "select-all" })
    expect(resolveShortcut(key("Delete"))).toEqual({ type: "delete" })
    expect(resolveShortcut(key("Backspace"))).toEqual({ type: "delete" })
    expect(resolveShortcut(key("ArrowUp"))).toEqual({ type: "nudge", x: 0, z: -1, fine: false })
    expect(resolveShortcut(key("ArrowRight", { shift: true }))).toEqual({ type: "nudge", x: 1, z: 0, fine: true })
    expect(resolveShortcut(key("r"))).toEqual({ type: "rotate", turns: 1 })
    expect(resolveShortcut(key("R", { shift: true }))).toEqual({ type: "rotate", turns: -1 })
    expect(resolveShortcut(key("g"))).toEqual({ type: "toggle-grid" })
    expect(resolveShortcut(key("h"))).toEqual({ type: "toggle-helpers" })
    expect(resolveShortcut(key("["))).toMatchObject({ type: "brush-size" })
    expect(resolveShortcut(key("]"))).toMatchObject({ type: "brush-size" })
    expect(resolveShortcut(key("PageUp"))).toEqual({ type: "level", delta: 1 })
    expect(resolveShortcut(key("PageDown"))).toEqual({ type: "level", delta: -1 })
    expect(resolveShortcut(key("Escape"))).toEqual({ type: "escape" })
    expect(resolveShortcut(key("q"))).toBeNull()
    expect(resolveShortcut(key("q", { ctrl: true }))).toBeNull()
  })

  it("documents every binding", () => {
    expect(SHORTCUTS.length).toBeGreaterThanOrEqual(27)
    expect(SHORTCUTS.every((s) => s.keys.length > 0 && s.description.length > 0)).toBe(true)
  })
})

function setup() {
  const f = fixtureScene()
  const pillar = createPillar(f.groundId, { x: 62.5, z: 12.5 })
  f.scene.objects[pillar.id] = pillar
  const store = makeStore(f.scene)
  let emitted = 0
  const controller = createEditorController(store, { now: () => 0 })
  controller.subscribe(() => emitted++)
  return { f, store, controller, pillar, emitted: () => emitted }
}

describe("editor controller", () => {
  it("routes pointer events to the active tool and switches tools by key", () => {
    const { store, controller } = setup()
    expect(controller.activeTool().id).toBe("select")
    expect(controller.keyDown(key("w"))).toBe(true)
    expect(store.getState().tool).toBe("wall")
    expect(controller.activeTool().id).toBe("wall")
    controller.pointerDown(at(50, 50, { clientX: 0 }))
    controller.pointerMove(at(70, 50))
    expect(controller.overlays().preview).toMatchObject({ kind: "segment" })
    controller.pointerDown(at(70, 50, { clientX: 100 }))
    expect(Object.values(store.getState().scene.objects).filter((o) => o.type === "wall")).toHaveLength(2)
    // Switching tools (even from the store directly) cancels the chain.
    store.getState().setTool("select")
    expect(controller.tools.wall.chain()).toEqual([])
    expect(controller.overlays().preview).toBeNull()
  })

  it("lets the active tool consume keys before the keymap (R in the prop tool)", () => {
    const { f, store, controller } = setup()
    const table = createProp(f.groundId, "table", { x: 12.5, y: 0, z: 42.5 })
    store.getState().addObject(table)
    store.getState().select([table.id])
    store.getState().setTool("prop")
    expect(controller.keyDown(key("r"))).toBe(true)
    // The prop tool rotated its preview; the selected table did not turn.
    expect(store.getState().toolSettings.prop.rotationY).toBeCloseTo(Math.PI / 2)
    expect((store.getState().scene.objects[table.id] as PropObject).rotationY).toBe(0)
    // With the select tool, R rotates the selection.
    store.getState().setTool("select")
    expect(controller.keyDown(key("r"))).toBe(true)
    expect((store.getState().scene.objects[table.id] as PropObject).rotationY).toBeCloseTo(Math.PI / 2)
  })

  it("undo during a drag cancels the gesture instead of undoing earlier work", () => {
    const { store, controller, pillar } = setup()
    store.getState().updateObject(pillar.id, { size: 3 })
    controller.pointerDown(at(62.5, 12.5, { objectId: pillar.id }))
    controller.pointerMove(at(80, 12.5))
    expect((store.getState().scene.objects[pillar.id] as PillarObject).position.x).toBe(82.5)
    controller.keyDown(key("z", { ctrl: true }))
    const p = store.getState().scene.objects[pillar.id] as PillarObject
    expect(p.position).toEqual({ x: 62.5, z: 12.5 })
    expect(p.size).toBe(3)
    expect(store.getState().history.undoLabel).toBe("Edit pillar")
    controller.keyDown(key("z", { ctrl: true }))
    expect((store.getState().scene.objects[pillar.id] as PillarObject).size).toBe(2)
    controller.keyDown(key("y", { ctrl: true }))
    expect((store.getState().scene.objects[pillar.id] as PillarObject).size).toBe(3)
  })

  it("Ctrl+C / Ctrl+V pastes at the pointer and re-hosts openings on the wall under it", () => {
    const { f, store, controller } = setup()
    const other = createWall(f.groundId, { x: 10, z: 80 }, { x: 40, z: 80 })
    store.getState().addObject(other)
    store.getState().select([f.doorId])
    expect(controller.keyDown(key("c", { ctrl: true }))).toBe(true)
    controller.pointerMove(at(22, 80, { objectId: other.id }))
    expect(controller.keyDown(key("v", { ctrl: true }))).toBe(true)
    const pasted = store.getState().selection.map((id) => store.getState().scene.objects[id]) as DoorObject[]
    expect(pasted).toHaveLength(1)
    expect(pasted[0].wallId).toBe(other.id)
    expect(pasted[0].offset).toBeCloseTo(12)
    expect(controller.cursor()?.ground).toEqual({ x: 22, z: 80 })
  })

  it("arrows nudge, Delete deletes, Ctrl+D duplicates, PageUp changes level, G/H toggle view", () => {
    const { f, store, controller, pillar } = setup()
    store.getState().select([pillar.id])
    controller.keyDown(key("ArrowRight"))
    controller.keyDown(key("ArrowDown", { shift: true }))
    expect((store.getState().scene.objects[pillar.id] as PillarObject).position).toEqual({ x: 67.5, z: 13.5 })
    expect(controller.keyDown(key("d", { ctrl: true }))).toBe(true)
    expect(store.getState().selection).not.toContain(pillar.id)
    expect(controller.keyDown(key("Delete"))).toBe(true)
    expect(store.getState().selection).toEqual([])
    expect(controller.keyDown(key("Delete"))).toBe(false)
    controller.keyDown(key("PageUp"))
    expect(store.getState().activeLevelId).toBe(f.upperId)
    controller.keyDown(key("g"))
    controller.keyDown(key("h"))
    expect(store.getState().view).toMatchObject({ showGrid: false, showHelpers: false })
    controller.keyDown(key("]"))
    expect(store.getState().toolSettings.brush.radius).toBe(12.5)
  })

  it("tracks Alt for free placement", () => {
    const { store, controller } = setup()
    controller.keyDown(key("Alt", { alt: true }))
    expect(store.getState().altHeld).toBe(true)
    controller.keyUp(key("Alt"))
    expect(store.getState().altHeld).toBe(false)
  })

  it("overlays are memoised and include selection, hover, previews and the ruler", () => {
    const { store, controller, pillar, emitted } = setup()
    const o1 = controller.overlays()
    expect(controller.overlays()).toBe(o1)
    const n = emitted()
    controller.pointerMove(at(62.5, 12.5, { objectId: pillar.id }))
    expect(emitted()).toBeGreaterThan(n)
    const o2 = controller.overlays()
    expect(o2).not.toBe(o1)
    expect(o2.hoveredId).toBe(pillar.id)
    store.getState().select([pillar.id])
    expect(controller.overlays().selectedIds).toEqual([pillar.id])
    store.getState().setTool("measure")
    controller.pointerDown(at(1, 1, { clientX: 0 }))
    controller.pointerMove(at(21, 1))
    expect(controller.overlays().ruler).toMatchObject({ label: "20 ft" })
    expect(controller.overlays().hoveredId).toBeNull()
  })

  it("forwards terrain previews to the engine hook once set", () => {
    const { store, controller } = setup()
    const calls: (Float32Array | null)[] = []
    controller.setTerrainPreview((_l, heights) => calls.push(heights))
    store.getState().setTool("terrain")
    controller.pointerDown(at(20, 20))
    controller.pointerUp(at(20, 20))
    expect(calls.length).toBe(2)
    expect(calls[1]).toBeNull()
    controller.dispose()
    store.getState().setTool("wall")
    expect(controller.activeTool().id).toBe("terrain")
  })

  it("Escape cancels the gesture and clears the selection", () => {
    const { store, controller, pillar } = setup()
    store.getState().select([pillar.id])
    store.getState().setTool("floor")
    controller.pointerDown(at(10, 10))
    expect(controller.keyDown(key("Escape"))).toBe(true)
    expect(store.getState().selection).toEqual([pillar.id])
    expect(controller.keyDown(key("Escape"))).toBe(true)
    expect(store.getState().selection).toEqual([])
    // The cancelled drag creates nothing on release.
    controller.pointerUp(at(30, 30))
    expect(Object.values(store.getState().scene.objects).filter((o) => o.type === "floor")).toHaveLength(2)
  })
})
