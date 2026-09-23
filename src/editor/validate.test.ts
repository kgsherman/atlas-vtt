/**
 * The editor never commits a revision that core/scene parseScene would refuse (it could be saved but
 * not reopened).
 */
import { describe, expect, it } from "vitest"

import { createWall } from "@/core/scene/factory"
import { parseScene } from "@/core/scene/schema"
import { SCENE_LIMITS } from "@/core/scene/schema"
import type { Scene } from "@/core/scene/types"

import { fixtureScene, makeStore } from "./test-utils"
import { validateEdit } from "./validate"

const loads = (scene: Scene) => parseScene(JSON.parse(JSON.stringify(scene))).ok

describe("validateEdit", () => {
  it("accepts valid edits and checks only what the patches touched", () => {
    const { scene, wallId } = fixtureScene()
    expect(validateEdit(scene, [{ op: "replace", path: ["objects", wallId, "height"], value: 9 }])).toEqual([])
    // An untouched invalid object is not re-validated (cost stays proportional to the edit)…
    const far = createWall(Object.keys(scene.levels)[0], { x: 900, z: 0 }, { x: 910, z: 0 })
    scene.objects[far.id] = far
    expect(validateEdit(scene, [{ op: "replace", path: ["objects", wallId, "height"], value: 9 }])).toEqual([])
    // …but a touched one is, and a grid change re-checks every position.
    expect(validateEdit(scene, [{ op: "add", path: ["objects", far.id], value: far }]).join()).toMatch(/outside the scene extent/)
    expect(validateEdit(scene, [{ op: "replace", path: ["grid", "width"], value: 20 }]).join()).toMatch(/outside the scene extent/)
  })

  it("checks the openings of a touched wall and the host wall of a touched opening", () => {
    const { scene, wallId, doorId } = fixtureScene()
    const wall = scene.objects[wallId]
    if (wall.type !== "wall") throw new Error("fixture")
    // Shorten the wall under its door without reprojecting it: the door no longer fits.
    wall.b = { x: 14, z: 10 }
    expect(validateEdit(scene, [{ op: "replace", path: ["objects", wallId, "b"], value: wall.b }]).join()).toMatch(/does not fit|beyond/)
    expect(validateEdit(scene, [{ op: "replace", path: ["objects", doorId, "offset"], value: 5 }]).join()).toMatch(/does not fit|beyond/)
  })

  it("enforces the collection limits on the whole document", () => {
    const { scene } = fixtureScene()
    scene.levels = {}
    expect(validateEdit(scene, [{ op: "remove", path: ["levels", "x"] }])).toEqual([`levels: expected 1..${SCENE_LIMITS.maxLevels} entries, got 0`])
  })
})

describe("editor store refuses edits that would make the document unloadable", () => {
  it("refuses to shrink the grid under existing content, keeps the document and reports why", () => {
    const store = makeStore()
    const before = store.getState().scene
    store.getState().updateGrid({ width: 5, depth: 5 })
    expect(store.getState().scene).toBe(before)
    expect(store.getState().lastRejected?.label).toBe("Edit grid")
    expect(store.getState().lastRejected?.issues.join()).toMatch(/outside the scene extent/)
    expect(store.getState().history.canUndo).toBe(false)
    // A valid grid edit goes through and clears the report.
    store.getState().updateGrid({ width: 30 })
    expect(store.getState().scene.grid.width).toBe(30)
    expect(store.getState().lastRejected).toBeNull()
    expect(loads(store.getState().scene)).toBe(true)
  })

  it("stops nudges, pastes, moves and object edits at the scene extent margin", () => {
    const store = makeStore()
    const s = store.getState()
    s.selectAll()
    for (let k = 0; k < 40; k++) store.getState().nudgeSelection(5, 0)
    expect(loads(store.getState().scene)).toBe(true)
    expect(store.getState().lastRejected?.label).toBe("Nudge")

    store.getState().copySelection()
    expect(store.getState().paste({ at: { x: 5000, z: 5000 } })).toEqual([])
    expect(store.getState().lastRejected?.label).toBe("Paste")

    const token = Object.values(store.getState().scene.tokens)[0]
    if (token) {
      store.getState().moveTokens([{ id: token.id, position: { x: -5000, z: 0 } }])
      expect(store.getState().scene.tokens[token.id].position.x).not.toBe(-5000)
    }
    const wall = Object.values(store.getState().scene.objects).find((o) => o.type === "wall")!
    expect(store.getState().updateObject(wall.id, { a: { x: -900, z: 0 } })).toBe(false)
    expect(store.getState().updateSceneInfo({ name: "x".repeat(SCENE_LIMITS.maxString + 1) })).toBeUndefined()
    expect(store.getState().scene.name.length).toBeLessThanOrEqual(SCENE_LIMITS.maxString)
    const level = Object.keys(store.getState().scene.levels)[0]
    expect(store.getState().updateLevel(level, { elevation: 1e6 })).toBe(false)
    expect(loads(store.getState().scene)).toBe(true)
  })
})
