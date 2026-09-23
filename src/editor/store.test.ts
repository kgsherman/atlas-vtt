import { applyPatches, type Patch } from "immer"
import { describe, expect, it } from "vitest"

import { createFloor, createLevel, createLight, createPillar, createProp, createToken, createWall } from "@/core/scene/factory"
import { createHeightmap } from "@/core/scene/heightmap"
import { wallOpenings } from "@/core/scene/queries"
import type { ConnectorObject, DoorObject, FloorObject, LightObject, PropObject, Scene, WallObject } from "@/core/scene/types"
import type { DmCommand } from "@/core/session/types"

import { serializeClipboard } from "./clipboard"
import { editorViewState, repairConnectors } from "./store"
import { fixtureScene, makeStore } from "./test-utils"

const obj = <T>(scene: Scene, id: string) => scene.objects[id] as T

describe("editor store: apply / undo / redo", () => {
  it("records each apply as an undo step and marks the document dirty", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    const s = store.getState()
    expect(s.dirty).toBe(false)
    const pillar = createPillar(f.groundId, { x: 5, z: 5 })
    s.addObject(pillar)
    let st = store.getState()
    expect(st.scene.objects[pillar.id]).toBeDefined()
    expect(st.history).toMatchObject({ canUndo: true, undoLabel: "Add pillar" })
    expect(st.dirty).toBe(true)
    expect(st.lastChange).toEqual({ objects: [pillar.id] })

    expect(st.undo()).toBe(true)
    st = store.getState()
    expect(st.scene.objects[pillar.id]).toBeUndefined()
    expect(st.scene).toEqual(f.scene)
    expect(st.dirty).toBe(false)

    expect(st.redo()).toBe(true)
    expect(store.getState().scene.objects[pillar.id]).toBeDefined()
  })

  it("ignores recipes that change nothing", () => {
    const store = makeStore()
    const rev = store.getState().revision
    expect(store.getState().apply(() => {}, "noop")).toEqual([])
    expect(store.getState().revision).toBe(rev)
    expect(store.getState().history.canUndo).toBe(false)
  })

  it("markSaved clears dirty; undoing back to the saved state is clean again", () => {
    const store = makeStore()
    const s = store.getState()
    s.updateSceneInfo({ name: "A" })
    s.markSaved()
    expect(store.getState().dirty).toBe(false)
    store.getState().updateSceneInfo({ meta: { author: "me" } })
    expect(store.getState().dirty).toBe(true)
    store.getState().undo()
    expect(store.getState().dirty).toBe(false)
  })

  it("is read-only for scenes opened read-only", () => {
    const store = makeStore()
    store.getState().loadScene(fixtureScene().scene, { readOnly: true })
    const before = store.getState().scene
    store.getState().addObject(createPillar(store.getState().activeLevelId, { x: 1, z: 1 }))
    expect(store.getState().scene).toBe(before)
  })

  it("loadScene resets history, selection and picks the ground level", () => {
    const f = fixtureScene()
    const store = makeStore()
    store.getState().addLevel()
    store.getState().loadScene(f.scene)
    const s = store.getState()
    expect(s.history.canUndo).toBe(false)
    expect(s.selection).toEqual([])
    expect(s.activeLevelId).toBe(f.groundId)
    expect(s.lastChange).toBeNull()
  })
})

describe("editor store: transactions", () => {
  it("commits a transaction of many applies as one net undo step", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    const s = store.getState()
    s.beginTransaction("Drag wall")
    for (let k = 1; k <= 20; k++) {
      store.getState().apply((d) => {
        const w = d.objects[f.wallId] as WallObject
        w.a = { x: 10 + k, z: 10 }
        w.b = { x: 30 + k, z: 10 }
      }, "Move")
    }
    expect(store.getState().history.canUndo).toBe(false)
    expect(store.getState().dirty).toBe(true)
    store.getState().commitTransaction()
    const h = store.getState().history
    expect(h).toMatchObject({ canUndo: true, undoDepth: 1, undoLabel: "Drag wall" })
    expect(obj<WallObject>(store.getState().scene, f.wallId).a).toEqual({ x: 30, z: 10 })
    store.getState().undo()
    expect(store.getState().scene).toEqual(f.scene)
    store.getState().redo()
    expect(obj<WallObject>(store.getState().scene, f.wallId).b).toEqual({ x: 50, z: 10 })
  })

  it("cancelTransaction reverts and records nothing; undo during a transaction cancels it", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().beginTransaction("t")
    store.getState().apply((d) => {
      d.name = "changed"
    }, "x")
    store.getState().cancelTransaction()
    expect(store.getState().scene.name).toBe(f.scene.name)
    expect(store.getState().history.canUndo).toBe(false)
    expect(store.getState().dirty).toBe(false)

    store.getState().beginTransaction("t2")
    store.getState().apply((d) => {
      d.name = "again"
    }, "x")
    expect(store.getState().undo()).toBe(true)
    expect(store.getState().scene.name).toBe(f.scene.name)
    expect(store.getState().history.transaction).toBeNull()
  })

  it("undo/redo across several transactions and plain edits", () => {
    const store = makeStore()
    const level = store.getState().activeLevelId
    const p = createPillar(level, { x: 5, z: 5 })
    store.getState().addObject(p)
    store.getState().beginTransaction("Move pillar")
    for (const x of [6, 7, 8]) {
      store.getState().apply((d) => {
        const pillar = d.objects[p.id] as typeof p
        pillar.position = { x, z: 5 }
      }, "m")
    }
    store.getState().commitTransaction()
    store.getState().updateObject(p.id, { size: 3 })
    store.getState().beginTransaction("Move pillar again")
    store.getState().apply((d) => {
      const pillar = d.objects[p.id] as typeof p
      pillar.position = { x: 20, z: 20 }
    }, "m")
    store.getState().commitTransaction()

    const pos = () => (store.getState().scene.objects[p.id] as typeof p | undefined)?.position
    expect(pos()).toEqual({ x: 20, z: 20 })
    store.getState().undo()
    expect(pos()).toEqual({ x: 8, z: 5 })
    store.getState().undo()
    expect((store.getState().scene.objects[p.id] as typeof p).size).toBe(2)
    store.getState().undo()
    expect(pos()).toEqual({ x: 5, z: 5 })
    store.getState().undo()
    expect(pos()).toBeUndefined()
    store.getState().redo()
    store.getState().redo()
    store.getState().redo()
    store.getState().redo()
    expect(pos()).toEqual({ x: 20, z: 20 })
    expect((store.getState().scene.objects[p.id] as typeof p).size).toBe(3)
  })
})

describe("editor store: selection", () => {
  it("select modes", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    const s = store.getState()
    s.select([f.wallId, "missing"])
    expect(store.getState().selection).toEqual([f.wallId])
    store.getState().select([f.doorId], "add")
    expect(store.getState().selection).toEqual([f.wallId, f.doorId])
    store.getState().toggleSelected(f.wallId)
    expect(store.getState().selection).toEqual([f.doorId])
    store.getState().select([f.doorId], "remove")
    expect(store.getState().selection).toEqual([])
  })

  it("selectAll selects the active level only and skips editor-locked objects", () => {
    const f = fixtureScene()
    const locked = createPillar(f.groundId, { x: 1, z: 1 }, { editorLocked: true })
    f.scene.objects[locked.id] = locked
    const hero = createToken(f.groundId, { x: 2.5, z: 2.5 })
    f.scene.tokens[hero.id] = hero
    const store = makeStore(f.scene)
    store.getState().selectAll()
    const sel = store.getState().selection
    expect(sel).toContain(f.wallId)
    expect(sel).toContain(f.doorId)
    expect(sel).toContain(hero.id)
    expect(sel).not.toContain(locked.id)
    expect(sel.every((id) => (f.scene.objects[id]?.levelId ?? f.scene.tokens[id]?.levelId) === f.groundId)).toBe(true)
  })

  it("deleteSelection deletes dependents; undo restores them; selection is pruned", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().select([f.wallId])
    expect(store.getState().deleteSelection()).toBe(1)
    const s = store.getState().scene
    expect(s.objects[f.wallId]).toBeUndefined()
    expect(s.objects[f.doorId]).toBeUndefined()
    expect(s.objects[f.windowId]).toBeUndefined()
    expect(store.getState().selection).toEqual([])
    store.getState().undo()
    expect(store.getState().scene).toEqual(f.scene)
  })
})

describe("editor store: clipboard", () => {
  it("copy/paste across levels re-parents openings onto the pasted wall", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().select([f.wallId])
    const clip = store.getState().copySelection()
    expect(clip?.objects.map((o) => o.type).sort()).toEqual(["door", "wall", "window"])
    store.getState().setActiveLevel(f.upperId)
    const ids = store.getState().paste()
    expect(ids).toHaveLength(3)
    const s = store.getState().scene
    const wall = ids.map((id) => s.objects[id]).find((o) => o.type === "wall") as WallObject
    expect(wall.levelId).toBe(f.upperId)
    // Another level: pasted in place.
    expect(wall.a).toEqual({ x: 10, z: 10 })
    const openings = wallOpenings(s, wall.id)
    expect(openings.map((o) => o.type).sort()).toEqual(["door", "window"])
    expect(openings.every((o) => o.levelId === f.upperId && ids.includes(o.id))).toBe(true)
    // The originals are untouched and still hosted by the original wall.
    expect(wallOpenings(s, f.wallId).map((o) => o.id).sort()).toEqual([f.doorId, f.windowId].sort())
    expect(store.getState().selection).toEqual(ids)
  })

  it("pasting on the same level offsets by one cell; `at` places the origin", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().select([f.wallId])
    store.getState().copySelection()
    const ids = store.getState().paste()
    const wall = ids.map((id) => store.getState().scene.objects[id]).find((o) => o.type === "wall") as WallObject
    expect(wall.a).toEqual({ x: 15, z: 15 })
    const ids2 = store.getState().paste({ at: { x: 70, z: 70 } })
    const wall2 = ids2.map((id) => store.getState().scene.objects[id]).find((o) => o.type === "wall") as WallObject
    expect(wall2.a).toEqual({ x: 60, z: 70 })
  })

  it("an opening copied alone is re-hosted on the wall under the pointer", () => {
    const f = fixtureScene()
    const other = createWall(f.groundId, { x: 10, z: 50 }, { x: 40, z: 50 })
    f.scene.objects[other.id] = other
    const store = makeStore(f.scene)
    store.getState().select([f.doorId])
    store.getState().copySelection()
    const ids = store.getState().paste({ at: { x: 20, z: 50 }, hostWallId: other.id })
    expect(ids).toHaveLength(1)
    const door = store.getState().scene.objects[ids[0]] as DoorObject
    expect(door.wallId).toBe(other.id)
    expect(door.offset).toBeCloseTo(10)
    // Without a host wall it is dropped.
    expect(store.getState().paste({ at: { x: 20, z: 80 } })).toEqual([])
  })

  it("cut removes and paste restores with fresh ids", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().select([f.stairsId])
    store.getState().cutSelection()
    expect(store.getState().scene.objects[f.stairsId]).toBeUndefined()
    const ids = store.getState().paste({ at: { x: 45, z: 50 } })
    const c = store.getState().scene.objects[ids[0]] as ConnectorObject
    expect(c.id).not.toBe(f.stairsId)
    expect(c.rect).toEqual({ x: 40, z: 40, w: 10, d: 20 })
    expect(c.toLevelId).toBe(f.upperId)
  })

  it("duplicate copies on the source level, one cell away, without touching the clipboard", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().select([f.wallId])
    const ids = store.getState().duplicateSelection()
    expect(ids).toHaveLength(3)
    expect(store.getState().clipboard).toBeNull()
    const wall = ids.map((id) => store.getState().scene.objects[id]).find((o) => o.type === "wall") as WallObject
    expect(wall.a).toEqual({ x: 15, z: 15 })
    expect(store.getState().history.undoLabel).toBe("Duplicate 1 item")
  })

  it("pasteText accepts a valid clipboard and rejects forged content", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().select([f.wallId])
    const clip = store.getState().copySelection()!
    const ok = store.getState().pasteText(serializeClipboard(clip), { at: { x: 50, z: 80 } })
    expect(ok.ok).toBe(true)

    const forged = JSON.parse(serializeClipboard(clip))
    forged.objects[0].height = "tall"
    forged.objects.push({ id: "__proto__", type: "pillar" })
    const rev = store.getState().revision
    const bad = store.getState().pasteText(JSON.stringify(forged))
    expect(bad.ok).toBe(false)
    expect(store.getState().revision).toBe(rev)
    expect(store.getState().pasteText("hello").ok).toBe(false)
  })

  it("mirrors copies to the system clipboard and pastes from it", async () => {
    let stored = ""
    const f = fixtureScene()
    const store = makeStore(f.scene, {
      systemClipboard: {
        writeText: async (t) => {
          stored = t
        },
        readText: async () => stored,
      },
    })
    store.getState().select([f.stairsId])
    store.getState().copySelection()
    await Promise.resolve()
    expect(JSON.parse(stored).kind).toBe("atlas-clipboard")
    const result = await store.getState().pasteFromSystem({ at: { x: 75, z: 50 } })
    expect(result.ok).toBe(true)
  })
})

describe("editor store: transforms", () => {
  it("nudges coalesce into one undo step and keep connectors cell-aligned", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().select([f.wallId])
    store.getState().nudgeSelection(5, 0)
    store.getState().nudgeSelection(5, 0)
    store.getState().nudgeSelection(0, 5)
    expect(obj<WallObject>(store.getState().scene, f.wallId).a).toEqual({ x: 20, z: 15 })
    expect(store.getState().history.undoDepth).toBe(1)
    store.getState().undo()
    expect(obj<WallObject>(store.getState().scene, f.wallId).a).toEqual({ x: 10, z: 10 })

    store.getState().select([f.stairsId])
    store.getState().nudgeSelection(1, 0)
    expect(obj<ConnectorObject>(store.getState().scene, f.stairsId).rect.x).toBe(40)
  })

  it("rotates a floor + connector selection about a grid vertex", () => {
    const f = fixtureScene()
    const floor = createFloor(f.groundId, { x: 40, z: 40, w: 10, d: 20 })
    f.scene.objects[floor.id] = floor
    const store = makeStore(f.scene)
    store.getState().select([floor.id, f.stairsId])
    store.getState().rotateSelection(1)
    const s = store.getState().scene
    const r = obj<FloorObject>(s, floor.id).rect
    expect(r.w).toBe(20)
    expect(r.d).toBe(10)
    expect(r.x % 5).toBe(0)
    expect(r.z % 5).toBe(0)
    expect(obj<ConnectorObject>(s, f.stairsId).direction).toBe(1)
    expect(obj<ConnectorObject>(s, f.stairsId).rect).toEqual(r)
  })

  it("rotates a single prop in place", () => {
    const store = makeStore()
    const prop = createProp(store.getState().activeLevelId, "table", { x: 12.5, y: 0, z: 12.5 })
    store.getState().addObject(prop)
    store.getState().select([prop.id])
    store.getState().rotateSelection(1)
    const p = obj<PropObject>(store.getState().scene, prop.id)
    expect(p.position).toEqual({ x: 12.5, y: 0, z: 12.5 })
    expect(p.rotationY).toBeCloseTo(Math.PI / 2)
  })
})

describe("editor store: object edits", () => {
  it("updateObject on a wall reprojects its openings (and deletes those that no longer fit)", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    // Move b: offsets are kept from a.
    expect(store.getState().updateObject(f.wallId, { b: { x: 40, z: 10 } })).toBe(true)
    let s = store.getState().scene
    expect(obj<DoorObject>(s, f.doorId).offset).toBe(5)
    // Move a to x = 20 (length 30 → 20): distances from b are kept, so the door (25 ft from b) no
    // longer fits and is deleted; the window (16 ft from b) ends up at offset 4.
    store.getState().updateObject(f.wallId, { a: { x: 20, z: 10 } })
    s = store.getState().scene
    expect(s.objects[f.doorId]).toBeUndefined()
    expect(obj<DoorObject>(s, f.windowId).offset).toBe(4)
  })

  it("rejects edits that would break invariants", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    expect(store.getState().updateObject(f.stairsId, { toLevelId: f.groundId })).toBe(false)
    expect(store.getState().updateObject(f.wallId, { thickness: 0 })).toBe(false)
    expect(store.getState().updateObject(f.doorId, { width: 100 })).toBe(false)
    expect(store.getState().scene).toEqual(f.scene)
    // Offsets are clamped into the wall.
    expect(store.getState().updateObject(f.doorId, { offset: 0 })).toBe(true)
    expect(obj<DoorObject>(store.getState().scene, f.doorId).offset).toBe(2)
  })

  it("keeps a light's dim radius ≥ bright radius and coalesces repeated slider edits", () => {
    const store = makeStore()
    const light = createLight(store.getState().activeLevelId, "torch", { x: 10, z: 10 })
    store.getState().addObject(light)
    store.getState().updateObject(light.id, { brightRadius: 30 })
    store.getState().updateObject(light.id, { brightRadius: 50 })
    const l = obj<LightObject>(store.getState().scene, light.id)
    expect(l.dimRadius).toBe(50)
    expect(store.getState().history.undoDepth).toBe(2)
  })

  it("updateToken moves attached lights to the token's new level", () => {
    const f = fixtureScene()
    const hero = createToken(f.groundId, { x: 2.5, z: 2.5 })
    f.scene.tokens[hero.id] = hero
    const lamp = createLight(f.groundId, "lantern", { x: 0, z: 0 }, { attachedTokenId: hero.id })
    f.scene.objects[lamp.id] = lamp
    const store = makeStore(f.scene)
    expect(store.getState().updateToken(hero.id, { levelId: f.upperId })).toBe(true)
    expect(obj<LightObject>(store.getState().scene, lamp.id).levelId).toBe(f.upperId)
    expect(store.getState().updateToken(hero.id, { levelId: "nope" })).toBe(false)
  })

  it("detaching a light keeps its world position; attaching makes it an offset", () => {
    const f = fixtureScene()
    const hero = createToken(f.upperId, { x: 22.5, z: 12.5 })
    f.scene.tokens[hero.id] = hero
    const lamp = createLight(f.groundId, "lantern", { x: 0, z: 0 }, { attachedTokenId: hero.id, position: { x: 1, y: 4, z: 0 } })
    f.scene.objects[lamp.id] = lamp
    const store = makeStore(f.scene)
    expect(store.getState().updateObject(lamp.id, { attachedTokenId: null })).toBe(true)
    let l = obj<LightObject>(store.getState().scene, lamp.id)
    expect(l).toMatchObject({ attachedTokenId: null, levelId: f.upperId, position: { x: 23.5, y: 4, z: 12.5 } })
    expect(store.getState().updateObject(lamp.id, { attachedTokenId: hero.id })).toBe(true)
    l = obj<LightObject>(store.getState().scene, lamp.id)
    expect(l).toMatchObject({ attachedTokenId: hero.id, levelId: f.upperId, position: { x: 0, y: 4, z: 0 } })
    expect(store.getState().updateObject(lamp.id, { attachedTokenId: "ghost" })).toBe(false)
  })

  it("deleteIds only deletes objects and tokens (levels go through removeLevel)", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    const before = store.getState().scene
    store.getState().deleteIds([f.upperId, f.groundId])
    expect(store.getState().scene).toBe(before)
    expect(Object.keys(store.getState().scene.levels)).toHaveLength(2)
    expect(store.getState().history.canUndo).toBe(false)
  })

  it("door state and light toggles are undoable edits without a play sink", () => {
    const f = fixtureScene()
    const lamp = createLight(f.groundId, "torch", { x: 5, z: 5 })
    f.scene.objects[lamp.id] = lamp
    const store = makeStore(f.scene)
    store.getState().setDoorState(f.doorId, "locked")
    expect(obj<DoorObject>(store.getState().scene, f.doorId).state).toBe("locked")
    expect(store.getState().history.undoLabel).toBe("Lock door")
    store.getState().toggleLight(lamp.id)
    expect(obj<LightObject>(store.getState().scene, lamp.id).on).toBe(false)
    store.getState().undo()
    expect(obj<LightObject>(store.getState().scene, lamp.id).on).toBe(true)
  })

  it("environment and grid edits", () => {
    const store = makeStore()
    store.getState().updateEnvironment({ skyLevel: "bright", directional: { enabled: true, elevation: 0 } })
    const env = store.getState().scene.environment
    expect(env.skyLevel).toBe("bright")
    expect(env.directional.enabled).toBe(true)
    expect(env.directional.elevation).toBe(0.1)
    expect(env.directional.kind).toBe("moon")
    expect(store.getState().lastChange).toEqual({ structure: true })

    const level = store.getState().activeLevelId
    store.getState().apply((d) => {
      d.levels[level].heightmap = { ...createHeightmap(1), chunks: { "0,0": "AAAA", "2,0": "AAAA", "0,2": "AAAA" } }
    }, "fake terrain")
    store.getState().updateGrid({ width: 10, depth: 300 })
    const s = store.getState().scene
    expect(s.grid.width).toBe(10)
    expect(s.grid.depth).toBe(200)
    // width 10 at resolution 1 → 11 samples → chunk columns 0..1 only.
    expect(Object.keys(s.levels[level].heightmap!.chunks).sort()).toEqual(["0,0", "0,2"])
  })
})

describe("editor store: levels", () => {
  it("adds a level on top and activates it", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    const id = store.getState().addLevel()!
    const s = store.getState()
    expect(s.activeLevelId).toBe(id)
    expect(s.scene.levels[id].elevation).toBe(20)
  })

  it("removes a level with its content, never the last one; the active level falls back", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().setActiveLevel(f.upperId)
    expect(store.getState().removeLevel(f.upperId)).toBe(true)
    const s = store.getState()
    expect(s.scene.levels[f.upperId]).toBeUndefined()
    expect(s.scene.objects[f.stairsId]).toBeUndefined()
    expect(s.activeLevelId).toBe(f.groundId)
    expect(s.removeLevel(f.groundId)).toBe(false)
    s.undo()
    expect(store.getState().scene).toEqual(f.scene)
  })

  it("elevation edits retarget or drop connectors that would lead downwards", () => {
    const f = fixtureScene()
    const attic = createLevel({ id: "attic", elevation: 20 })
    f.scene.levels[attic.id] = attic
    const store = makeStore(f.scene)
    // Upper drops below ground: the stairs from ground now lead to the attic (the level above ground).
    store.getState().updateLevel(f.upperId, { elevation: -10 })
    expect(obj<ConnectorObject>(store.getState().scene, f.stairsId).toLevelId).toBe("attic")
  })

  it("repairConnectors deletes connectors with no level above", () => {
    const f = fixtureScene()
    f.scene.levels[f.upperId].elevation = -5
    repairConnectors(f.scene)
    expect(f.scene.objects[f.stairsId]).toBeUndefined()
  })

  it("steps the active level with PageUp/PageDown semantics", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().stepActiveLevel(1)
    expect(store.getState().activeLevelId).toBe(f.upperId)
    store.getState().stepActiveLevel(1)
    expect(store.getState().activeLevelId).toBe(f.upperId)
    store.getState().stepActiveLevel(-1)
    expect(store.getState().activeLevelId).toBe(f.groundId)
  })
})

describe("editor store: live session sinks", () => {
  it("forwards every document patch to the patch sink so the host copy stays identical", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    let host: Scene = f.scene
    const sources: string[] = []
    store.getState().setPatchSink((patches: Patch[], meta) => {
      host = applyPatches(host, patches)
      sources.push(meta.source)
    })
    expect(store.getState().live).toBe(true)
    store.getState().addObject(createPillar(f.groundId, { x: 3, z: 3 }))
    store.getState().select([f.wallId])
    store.getState().nudgeSelection(5, 0)
    store.getState().undo()
    store.getState().redo()
    store.getState().beginTransaction("drag")
    store.getState().apply((d) => {
      d.name = "temp"
    }, "x")
    store.getState().cancelTransaction()
    expect(host).toEqual(store.getState().scene)
    expect(sources).toEqual(["apply", "apply", "undo", "redo", "apply", "cancel"])
  })

  it("routes play actions to the play sink instead of the document", () => {
    const f = fixtureScene()
    const lamp = createLight(f.groundId, "torch", { x: 5, z: 5 })
    f.scene.objects[lamp.id] = lamp
    const hero = createToken(f.groundId, { x: 2.5, z: 2.5 })
    f.scene.tokens[hero.id] = hero
    const store = makeStore(f.scene)
    const commands: DmCommand[] = []
    store.getState().setPlaySink((c) => commands.push(c))
    store.getState().setDoorState(f.doorId, "open")
    store.getState().toggleLight(lamp.id)
    store.getState().select([hero.id, f.wallId])
    store.getState().nudgeSelection(5, 0)
    expect(commands).toEqual([
      { t: "set-door", doorId: f.doorId, state: "open" },
      { t: "set-light", lightId: lamp.id, on: false },
      { t: "move-token", tokenId: hero.id, levelId: f.groundId, x: 7.5, z: 2.5 },
    ])
    const s = store.getState().scene
    expect(obj<DoorObject>(s, f.doorId).state).toBe("closed")
    expect(s.tokens[hero.id].position).toEqual({ x: 2.5, z: 2.5 })
    // The wall still moved as a document edit.
    expect(obj<WallObject>(s, f.wallId).a).toEqual({ x: 15, z: 10 })
  })

  it("syncScene adopts an external scene without touching history", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().select([f.wallId])
    const next = { ...f.scene, objects: { ...f.scene.objects } }
    delete next.objects[f.wallId]
    store.getState().syncScene(next)
    expect(store.getState().scene).toBe(next)
    expect(store.getState().selection).toEqual([])
    expect(store.getState().history.canUndo).toBe(false)
  })

  it("an undo step that no longer applies is discarded instead of throwing", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().updateObject(f.wallId, { height: 12 })
    const next = { ...store.getState().scene, objects: { ...store.getState().scene.objects } }
    delete next.objects[f.wallId]
    store.getState().syncScene(next)
    expect(store.getState().undo()).toBe(false)
    expect(store.getState().history.canRedo).toBe(false)
  })
})

describe("editor store: view", () => {
  it("toggles view options and exposes an engine ViewState patch", () => {
    const f = fixtureScene()
    const store = makeStore(f.scene)
    store.getState().toggleGrid()
    store.getState().toggleHelpers()
    store.getState().toggleLevelVisibility(f.upperId)
    const s = store.getState()
    expect(s.view.showGrid).toBe(false)
    expect(s.view.showHelpers).toBe(false)
    expect(s.view.levelVisibility[f.upperId]).toBe(false)
    expect(editorViewState(s)).toMatchObject({ mode: "editor", activeLevelId: f.groundId, showGrid: false, vision: "off", levelVisibility: { [f.upperId]: false } })
    store.getState().toggleLevelVisibility(f.upperId)
    expect(store.getState().view.levelVisibility[f.upperId]).toBe(true)
  })

  it("scales the brush radius within bounds", () => {
    const store = makeStore()
    store.getState().scaleBrushRadius(100)
    expect(store.getState().toolSettings.brush.radius).toBe(100)
    store.getState().scaleBrushRadius(0.0001)
    expect(store.getState().toolSettings.brush.radius).toBe(1)
  })
})
