// @vitest-environment jsdom
import { describe, expect, it } from "vitest"

import { createPillar, createProp, createToken, createWall } from "@/core/scene/factory"
import type { DoorObject, PillarObject, PropObject, WallObject } from "@/core/scene/types"

import { createEditorController } from "./controller"
import { at, fixtureScene, makeStore, pressKey } from "./test-utils"

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
    expect(pressKey(controller, "w")).toBe(true)
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
    expect(pressKey(controller, "r")).toBe(true)
    // The prop tool rotated its preview; the selected table did not turn.
    expect(store.getState().toolSettings.prop.rotationY).toBeCloseTo(Math.PI / 2)
    expect((store.getState().scene.objects[table.id] as PropObject).rotationY).toBe(0)
    // With the select tool, R rotates the selection.
    store.getState().setTool("select")
    expect(pressKey(controller, "r")).toBe(true)
    expect((store.getState().scene.objects[table.id] as PropObject).rotationY).toBeCloseTo(Math.PI / 2)
  })

  it("undo during a drag cancels the gesture instead of undoing earlier work", () => {
    const { store, controller, pillar } = setup()
    store.getState().updateObject(pillar.id, { size: 3 })
    controller.pointerDown(at(62.5, 12.5, { objectId: pillar.id }))
    controller.pointerMove(at(80, 12.5))
    expect((store.getState().scene.objects[pillar.id] as PillarObject).position.x).toBe(82.5)
    pressKey(controller, "z", { ctrl: true })
    const p = store.getState().scene.objects[pillar.id] as PillarObject
    expect(p.position).toEqual({ x: 62.5, z: 12.5 })
    expect(p.size).toBe(3)
    expect(store.getState().history.undoLabel).toBe("Edit pillar")
    pressKey(controller, "z", { ctrl: true })
    expect((store.getState().scene.objects[pillar.id] as PillarObject).size).toBe(2)
    pressKey(controller, "y", { ctrl: true })
    expect((store.getState().scene.objects[pillar.id] as PillarObject).size).toBe(3)
  })

  it("Ctrl+C / Ctrl+V pastes at the pointer and re-hosts openings on the wall under it", () => {
    const { f, store, controller } = setup()
    const other = createWall(f.groundId, { x: 10, z: 80 }, { x: 40, z: 80 })
    store.getState().addObject(other)
    store.getState().select([f.doorId])
    expect(pressKey(controller, "c", { ctrl: true })).toBe(true)
    controller.pointerMove(at(22, 80, { objectId: other.id }))
    expect(pressKey(controller, "v", { ctrl: true })).toBe(true)
    const pasted = store.getState().selection.map((id) => store.getState().scene.objects[id]) as DoorObject[]
    expect(pasted).toHaveLength(1)
    expect(pasted[0].wallId).toBe(other.id)
    expect(pasted[0].offset).toBeCloseTo(12)
    expect(controller.cursor()?.ground).toEqual({ x: 22, z: 80 })
  })

  describe("paste at the pointer snaps like a drag", () => {
    const pasted = (store: ReturnType<typeof setup>["store"]) => {
      const s = store.getState()
      return s.selection.map((id) => (Object.hasOwn(s.scene.tokens, id) ? s.scene.tokens[id] : s.scene.objects[id]))
    }

    it("puts a pasted token on a cell centre", () => {
      const { f, store, controller } = setup()
      store.getState().setSnapMode("center")
      const t = createToken(f.groundId, { x: 12.5, z: 12.5 }, { size: "medium" })
      store.getState().addToken(t)
      store.getState().select([t.id])
      pressKey(controller, "c", { ctrl: true })
      controller.pointerMove(at(33.3, 81.1))
      expect(pressKey(controller, "v", { ctrl: true })).toBe(true)
      const [p] = pasted(store)
      expect(p && "position" in p ? p.position : null).toEqual({ x: 32.5, z: 82.5 })
    })

    it("puts a pasted prop on a cell centre", () => {
      const { f, store, controller } = setup()
      store.getState().setSnapMode("center")
      const crate = createProp(f.groundId, "crate", { x: 12.5, y: 0, z: 42.5 })
      store.getState().addObject(crate)
      store.getState().select([crate.id])
      pressKey(controller, "c", { ctrl: true })
      controller.pointerMove(at(41.3, 78.7))
      pressKey(controller, "v", { ctrl: true })
      const [p] = pasted(store) as PropObject[]
      expect(p.position.x).toBeCloseTo(42.5)
      expect(p.position.z).toBeCloseTo(77.5)
    })

    it("keeps a wall on grid vertices and a token on a cell centre together", () => {
      const { f, store, controller } = setup()
      store.getState().setSnapMode("center")
      const wall = createWall(f.groundId, { x: 60, z: 20 }, { x: 80, z: 20 })
      const t = createToken(f.groundId, { x: 72.5, z: 27.5 })
      store.getState().addObject(wall)
      store.getState().addToken(t)
      store.getState().select([wall.id, t.id])
      pressKey(controller, "c", { ctrl: true })
      controller.pointerMove(at(31.7, 63.4))
      pressKey(controller, "v", { ctrl: true })
      const items = pasted(store)
      const w = items.find((o) => o && "type" in o && o.type === "wall") as WallObject
      const tok = items.find((o) => o && !("type" in o)) as { position: { x: number; z: number } }
      for (const v of [w.a.x, w.a.z, w.b.x, w.b.z]) expect(v % 5).toBeCloseTo(0)
      expect(tok.position.x % 5).toBeCloseTo(2.5)
      expect(tok.position.z % 5).toBeCloseTo(2.5)
      // Relative layout kept.
      expect(tok.position.x - w.a.x).toBeCloseTo(12.5)
      expect(tok.position.z - w.a.z).toBeCloseTo(7.5)
    })

    it("keeps the raw pointer point with free snapping (Alt / Ctrl+Alt+V)", () => {
      const { f, store, controller } = setup()
      store.getState().setSnapMode("center")
      const t = createToken(f.groundId, { x: 12.5, z: 12.5 })
      store.getState().addToken(t)
      store.getState().select([t.id])
      pressKey(controller, "c", { ctrl: true })
      controller.pointerMove(at(33.3, 81.1))
      pressKey(controller, "v", { ctrl: true, alt: true })
      const [p] = pasted(store)
      const pos = p && "position" in p ? p.position : { x: NaN, z: NaN }
      expect(pos.x).toBeCloseTo(33.3)
      expect(pos.z).toBeCloseTo(81.1)
      store.getState().setSnapMode("free")
      expect(controller.pasteTarget()).toMatchObject({ at: { x: 33.3, z: 81.1 }, snap: "free" })
    })
  })

  it("arrows nudge, Delete deletes, Ctrl+D duplicates, PageUp changes level, G/H toggle view", () => {
    const { f, store, controller, pillar } = setup()
    store.getState().select([pillar.id])
    pressKey(controller, "ArrowRight")
    pressKey(controller, "ArrowDown", { shift: true })
    expect((store.getState().scene.objects[pillar.id] as PillarObject).position).toEqual({ x: 67.5, z: 13.5 })
    expect(pressKey(controller, "d", { ctrl: true })).toBe(true)
    expect(store.getState().selection).not.toContain(pillar.id)
    expect(pressKey(controller, "Delete")).toBe(true)
    expect(store.getState().selection).toEqual([])
    expect(pressKey(controller, "Delete")).toBe(false)
    pressKey(controller, "PageUp")
    expect(store.getState().activeLevelId).toBe(f.upperId)
    pressKey(controller, "g")
    pressKey(controller, "h")
    expect(store.getState().view).toMatchObject({ showGrid: false, showHelpers: false })
    pressKey(controller, "]")
    expect(store.getState().toolSettings.brush.radius).toBe(12.5)
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
    expect(pressKey(controller, "Escape")).toBe(true)
    expect(store.getState().selection).toEqual([pillar.id])
    expect(pressKey(controller, "Escape")).toBe(true)
    expect(store.getState().selection).toEqual([])
    // The cancelled drag creates nothing on release.
    controller.pointerUp(at(30, 30))
    expect(Object.values(store.getState().scene.objects).filter((o) => o.type === "floor")).toHaveLength(2)
  })
})
