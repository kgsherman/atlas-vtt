import { describe, expect, it } from "vitest"

import { createPillar, createProp, createToken } from "@/core/scene/factory"
import type { DmCommand } from "@/core/session/types"
import type { PillarObject, PropObject, WallObject } from "@/core/scene/types"

import { at, fixtureScene, key, makeStore } from "../test-utils"
import { createSelectTool, itemsInRect } from "./select"

function setup() {
  const f = fixtureScene()
  const pillar = createPillar(f.groundId, { x: 62.5, z: 12.5 })
  const crate = createProp(f.groundId, "crate", { x: 72.5, y: 0, z: 12.5 })
  const hero = createToken(f.groundId, { x: 82.5, z: 12.5 })
  const upperPillar = createPillar(f.upperId, { x: 67.5, z: 12.5 })
  f.scene.objects[pillar.id] = pillar
  f.scene.objects[crate.id] = crate
  f.scene.objects[upperPillar.id] = upperPillar
  f.scene.tokens[hero.id] = hero
  const store = makeStore(f.scene)
  let invalidations = 0
  const tool = createSelectTool({ store, invalidate: () => invalidations++ })
  return { f, store, tool, pillar, crate, hero, upperPillar, invalidations: () => invalidations }
}

describe("select tool", () => {
  it("click selects, shift-click toggles, click on empty ground clears", () => {
    const { store, tool, pillar, crate } = setup()
    tool.onPointerDown!(at(62.5, 12.5, { objectId: pillar.id }))
    tool.onPointerUp!(at(62.5, 12.5, { objectId: pillar.id }))
    expect(store.getState().selection).toEqual([pillar.id])
    tool.onPointerDown!(at(72.5, 12.5, { objectId: crate.id, shift: true }))
    tool.onPointerUp!(at(72.5, 12.5, { objectId: crate.id, shift: true }))
    expect(store.getState().selection).toEqual([pillar.id, crate.id])
    tool.onPointerDown!(at(62.5, 12.5, { objectId: pillar.id, shift: true }))
    tool.onPointerUp!(at(62.5, 12.5, { objectId: pillar.id, shift: true }))
    expect(store.getState().selection).toEqual([crate.id])
    tool.onPointerDown!(at(90, 90))
    tool.onPointerUp!(at(90, 90))
    expect(store.getState().selection).toEqual([])
  })

  it("tokens take priority over objects and editor-locked objects are not selectable", () => {
    const { store, tool, pillar, hero } = setup()
    tool.onPointerDown!(at(82.5, 12.5, { objectId: pillar.id, tokenId: hero.id }))
    tool.onPointerUp!(at(82.5, 12.5, { objectId: pillar.id, tokenId: hero.id }))
    expect(store.getState().selection).toEqual([hero.id])
    store.getState().updateObject(pillar.id, { editorLocked: true })
    tool.onPointerDown!(at(62.5, 12.5, { objectId: pillar.id }))
    tool.onPointerUp!(at(62.5, 12.5, { objectId: pillar.id }))
    expect(store.getState().selection).toEqual([])
  })

  it("dragging moves the selection with snapping in ONE undo step", () => {
    const { store, tool, pillar, crate } = setup()
    store.getState().select([pillar.id, crate.id])
    tool.onPointerDown!(at(62.5, 12.5, { objectId: pillar.id }))
    expect(tool.capturesPointer).toBe(true)
    for (const x of [63, 64.9, 66, 68.2, 71.9]) tool.onPointerMove!(at(x, 13.1))
    tool.onPointerUp!(at(71.9, 13.1))
    const s = store.getState().scene
    // Pillar snapped to the next cell centre 10 ft away; the crate moved by the same delta.
    expect((s.objects[pillar.id] as PillarObject).position).toEqual({ x: 72.5, z: 12.5 })
    expect((s.objects[crate.id] as PropObject).position).toEqual({ x: 82.5, y: 0, z: 12.5 })
    expect(store.getState().history.undoDepth).toBe(1)
  })

  it("a drag is a single history entry that undo reverts", () => {
    const { store, tool, pillar } = setup()
    const before = store.getState().scene
    tool.onPointerDown!(at(62.5, 12.5, { objectId: pillar.id }))
    tool.onPointerMove!(at(66, 12.5))
    tool.onPointerMove!(at(77, 18))
    tool.onPointerUp!(at(77, 18))
    expect(store.getState().history.undoDepth).toBe(1)
    expect((store.getState().scene.objects[pillar.id] as PillarObject).position).toEqual({ x: 77.5, z: 17.5 })
    store.getState().undo()
    expect(store.getState().scene).toEqual(before)
  })

  it("Escape during a drag cancels it and records nothing", () => {
    const { store, tool, pillar } = setup()
    const before = store.getState().scene
    tool.onPointerDown!(at(62.5, 12.5, { objectId: pillar.id }))
    tool.onPointerMove!(at(80, 12.5))
    expect(tool.onKeyDown!(key("Escape"))).toBe(true)
    expect(store.getState().scene).toEqual(before)
    expect(store.getState().history.canUndo).toBe(false)
    tool.onPointerUp!(at(80, 12.5))
    expect(store.getState().history.canUndo).toBe(false)
  })

  it("an undo during a drag aborts the gesture", () => {
    const { store, tool, pillar } = setup()
    tool.onPointerDown!(at(62.5, 12.5, { objectId: pillar.id }))
    tool.onPointerMove!(at(80, 12.5))
    store.getState().undo()
    tool.onPointerMove!(at(90, 12.5))
    tool.onPointerUp!(at(90, 12.5))
    expect((store.getState().scene.objects[pillar.id] as PillarObject).position).toEqual({ x: 62.5, z: 12.5 })
    expect(store.getState().history.canUndo).toBe(false)
  })

  it("small jitter does not start a drag, and a click on a selected item narrows the selection", () => {
    const { store, tool, pillar, crate } = setup()
    store.getState().select([pillar.id, crate.id])
    tool.onPointerDown!(at(62.5, 12.5, { objectId: pillar.id }))
    tool.onPointerMove!(at(62.6, 12.5))
    tool.onPointerUp!(at(62.6, 12.5))
    expect(store.getState().history.canUndo).toBe(false)
    expect(store.getState().selection).toEqual([pillar.id])
  })

  it("moving a wall carries its openings", () => {
    const { f, store, tool } = setup()
    tool.onPointerDown!(at(20, 10, { objectId: f.wallId }))
    tool.onPointerMove!(at(20, 21))
    tool.onPointerUp!(at(20, 21))
    const w = store.getState().scene.objects[f.wallId] as WallObject
    expect(w.a).toEqual({ x: 10, z: 20 })
    expect(store.getState().scene.objects[f.doorId]).toEqual(f.scene.objects[f.doorId])
  })

  it("marquee selects items fully inside the rect on the active level", () => {
    const { f, store, tool, pillar, crate, hero, upperPillar } = setup()
    tool.onPointerDown!(at(55, 5))
    tool.onPointerMove!(at(90, 20))
    const p = tool.preview()
    expect(p).toMatchObject({ kind: "rect", levelId: f.groundId, rect: { x: 55, z: 5, w: 35, d: 15 } })
    expect(tool.preview()).toBe(p)
    tool.onPointerUp!(at(90, 20))
    expect(store.getState().selection.sort()).toEqual([pillar.id, crate.id, hero.id].sort())
    expect(store.getState().selection).not.toContain(upperPillar.id)
    expect(tool.preview()).toBeNull()
    // Shift adds.
    tool.onPointerDown!(at(5, 5, { shift: true }))
    tool.onPointerUp!(at(35, 15, { shift: true }))
    expect(store.getState().selection).toContain(f.wallId)
    expect(store.getState().selection).toContain(pillar.id)
    expect(itemsInRect(store.getState().scene, f.upperId, { x: 60, z: 5, w: 20, d: 20 })).toEqual([upperPillar.id])
  })

  it("R rotates the selection; Escape clears it", () => {
    const { store, tool, crate } = setup()
    store.getState().select([crate.id])
    expect(tool.onKeyDown!(key("r"))).toBe(true)
    expect((store.getState().scene.objects[crate.id] as PropObject).rotationY).toBeCloseTo(Math.PI / 2)
    expect(tool.onKeyDown!(key("R", { shift: true }))).toBe(true)
    expect((store.getState().scene.objects[crate.id] as PropObject).rotationY).toBeCloseTo(0)
    expect(tool.onKeyDown!(key("Escape"))).toBe(true)
    expect(store.getState().selection).toEqual([])
    expect(tool.onKeyDown!(key("Escape"))).toBe(false)
  })

  it("tracks the hovered item", () => {
    const { tool, crate, invalidations } = setup()
    const n = invalidations()
    tool.onPointerMove!(at(72.5, 12.5, { objectId: crate.id }))
    expect(tool.hoveredId()).toBe(crate.id)
    expect(invalidations()).toBeGreaterThan(n)
    tool.onPointerMove!(at(90, 90))
    expect(tool.hoveredId()).toBeNull()
  })

  it("with a play sink, dragged tokens are ghosts and move by DmCommand on release", () => {
    const { f, store, tool, hero, pillar } = setup()
    const commands: DmCommand[] = []
    store.getState().setPlaySink((c) => commands.push(c))
    store.getState().select([hero.id, pillar.id])
    tool.onPointerDown!(at(82.5, 12.5, { tokenId: hero.id }))
    tool.onPointerMove!(at(92.5, 12.5))
    expect(tool.dragGhosts()).toEqual({ [hero.id]: { levelId: f.groundId, position: { x: 92.5, z: 12.5 } } })
    expect(store.getState().scene.tokens[hero.id].position).toEqual({ x: 82.5, z: 12.5 })
    tool.onPointerUp!(at(92.5, 12.5))
    expect(commands).toEqual([{ t: "move-token", tokenId: hero.id, levelId: f.groundId, x: 92.5, z: 12.5 }])
    expect((store.getState().scene.objects[pillar.id] as PillarObject).position).toEqual({ x: 72.5, z: 12.5 })
    expect(tool.dragGhosts()).toEqual({})
  })
})
