/**
 * The editor never commits a revision that core/scene parseScene would refuse (it could be saved but
 * not reopened).
 */
import { enablePatches, produceWithPatches, type Draft } from "immer"
import { describe, expect, it } from "vitest"

import { createWall } from "@/core/scene/factory"
import { chunkSamples, encodeChunk } from "@/core/scene/heightmap"
import { copySelection } from "@/core/scene/integrity"
import { parseScene } from "@/core/scene/schema"
import { SCENE_LIMITS } from "@/core/scene/schema"
import type { Scene, TerrainShape } from "@/core/scene/types"

import { validatePastedItems } from "./clipboard"
import { fixtureScene, makeStore } from "./test-utils"
import { validateEdit } from "./validate"

enablePatches()

const loads = (scene: Scene) => parseScene(JSON.parse(JSON.stringify(scene))).ok

/** A canonical block footprint over [x0, x1] × [z0, z1] with top y. */
function block(id: string, x0: number, z0: number, x1: number, z1: number, y: number): TerrainShape {
  const points = [
    { x: x0, y, z: z0 },
    { x: x1, y, z: z0 },
    { x: x1, y, z: z1 },
    { x: x0, y, z: z1 },
  ]
  return { id, kind: "block", op: "add", order: 0, points, base: 0 }
}

/** fixtureScene with terrain on the ground level (res 2: 3×3 chunks) and two terrain shapes. */
function terrainFixture() {
  const f = fixtureScene()
  const ground = f.scene.levels[f.groundId]
  ground.heightmap = { resolution: 2, chunks: { "0,0": encodeChunk(new Float32Array(chunkSamples(2) ** 2).fill(1)) } }
  ground.terrainEdits = { shapes: { a: block("a", 10, 10, 20, 20, 3), b: block("b", 40, 40, 50, 50, 5) }, baseChunks: { "0,0": "" } }
  /** validateEdit of a recipe's result, given its patches. */
  const edit = (recipe: (d: Draft<Scene>) => void) => {
    const [next, patches] = produceWithPatches(f.scene, recipe)
    return validateEdit(next, patches).join("\n")
  }
  return { ...f, edit }
}

const nanChunk = () => {
  const arr = new Float32Array(chunkSamples(2) ** 2)
  arr[7] = NaN
  return encodeChunk(arr)
}

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

describe("validateEdit: terrain", () => {
  it("accepts terrain edits that keep the document loadable", () => {
    const f = terrainFixture()
    expect(loads(f.scene)).toBe(true)
    expect(f.edit((d) => void (d.levels[f.groundId].terrainEdits!.shapes.a.points[0].y = 4))).toBe("")
    expect(f.edit((d) => void (d.levels[f.groundId].terrainEdits!.shapes.c = block("c", 60, 60, 70, 70, 2)))).toBe("")
    expect(f.edit((d) => void delete d.levels[f.groundId].terrainEdits!.shapes.a)).toBe("")
    expect(f.edit((d) => void delete d.levels[f.groundId].terrainEdits)).toBe("")
    expect(f.edit((d) => void (d.levels[f.groundId].heightmap!.chunks["1,1"] = encodeChunk(new Float32Array(chunkSamples(2) ** 2))))).toBe("")
    // Untouched levels (and edits elsewhere) are unaffected by the terrain edits.
    expect(f.edit((d) => void (d.levels.upper.name = "Attic"))).toBe("")
    expect(f.edit((d) => void (d.objects[f.wallId] as { height: number }).height++)).toBe("")
  })

  it("refuses a non-finite heightmap or base chunk (NaN guard)", () => {
    const f = terrainFixture()
    expect(f.edit((d) => void (d.levels[f.groundId].heightmap!.chunks["0,1"] = nanChunk()))).toMatch(
      /heightmap\.chunks\.0,1: chunk sample 7 is not a finite height/
    )
    expect(f.edit((d) => void (d.levels[f.groundId].terrainEdits!.baseChunks["0,1"] = nanChunk()))).toMatch(/baseChunks\.0,1: chunk sample 7/)
    // A wholesale heightmap replacement checks every chunk.
    expect(f.edit((d) => void (d.levels[f.groundId].heightmap = { resolution: 2, chunks: { "2,2": nanChunk() } }))).toMatch(/heightmap\.chunks\.2,2/)
    // Chunks beyond the grid.
    expect(f.edit((d) => void (d.levels[f.groundId].terrainEdits!.baseChunks["3,0"] = ""))).toMatch(/outside the grid/)
    // Base chunks are encoded at the heightmap's resolution: changing it re-checks all of them.
    const g = terrainFixture()
    g.scene.levels[g.groundId].terrainEdits!.baseChunks["1,1"] = encodeChunk(new Float32Array(chunkSamples(2) ** 2))
    expect(g.edit((d) => void (d.levels[g.groundId].heightmap = { resolution: 1, chunks: {} }))).toMatch(/baseChunks\.1,1: chunk must decode to exactly 256 bytes/)
  })

  it("validates only the touched shapes", () => {
    const f = terrainFixture()
    // An untouched invalid shape is not re-validated (cost stays proportional to the edit)…
    f.scene.levels[f.groundId].terrainEdits!.shapes.b.points.reverse()
    expect(f.edit((d) => void (d.levels[f.groundId].terrainEdits!.shapes.a.name = "Mound"))).toBe("")
    // …but a touched one is.
    expect(f.edit((d) => void (d.levels[f.groundId].terrainEdits!.shapes.b.name = "Pit"))).toMatch(/shapes\.b\.points: footprint must have a positive/)
    expect(f.edit((d) => void (d.levels[f.groundId].terrainEdits!.shapes.a.points[1].x = 1000))).toMatch(
      /shapes\.a\.points\.1: point lies outside the scene extent/
    )
    expect(f.edit((d) => void (d.levels[f.groundId].terrainEdits!.shapes.a.op = "xor" as never))).toMatch(/shapes\.a\.op/)
    expect(f.edit((d) => void (d.levels[f.groundId].terrainEdits!.shapes.c = block("d", 0, 0, 5, 5, 1)))).toMatch(
      /terrain shape \["c"\]: id "d" does not match its key/
    )
    // A whole-level replacement or a grid change checks every shape.
    expect(f.edit((d) => void (d.levels[f.groundId] = { ...d.levels[f.groundId] }))).toMatch(/shapes\.b\.points/)
    expect(f.edit((d) => void (d.grid.diagonalRule = "euclidean"))).toMatch(/shapes\.b\.points/)
    expect(f.edit((d) => void (d.levels[f.groundId].terrainEdits = { ...d.levels[f.groundId].terrainEdits! }))).toMatch(/shapes\.b\.points/)
  })

  it("refuses terrain edits without a heightmap or without shapes, and oversized levels", () => {
    const f = terrainFixture()
    expect(f.edit((d) => void (d.levels[f.groundId].heightmap = null))).toMatch(/terrainEdits: terrain edits require a heightmap/)
    expect(
      f.edit((d) => {
        d.levels.upper.terrainEdits = { shapes: { a: block("a", 10, 10, 20, 20, 3) }, baseChunks: {} }
      })
    ).toMatch(/levels\.upper\.terrainEdits: terrain edits require a heightmap/)
    expect(
      f.edit((d) => {
        delete d.levels[f.groundId].terrainEdits!.shapes.a
        delete d.levels[f.groundId].terrainEdits!.shapes.b
      })
    ).toMatch(/at least one shape/)
    expect(
      f.edit((d) => {
        for (let k = 0; k < SCENE_LIMITS.maxTerrainShapesPerLevel; k++) d.levels[f.groundId].terrainEdits!.shapes[`s${k}`] = block(`s${k}`, 0, 0, 5, 5, 1)
      })
    ).toMatch(/levels\..*\.terrainEdits\.shapes: expected at most 1000 terrain shapes, got 1002/)
  })

  it("pastes into scenes with terrain edits (the paste probe strips terrain)", () => {
    const f = terrainFixture()
    const store = makeStore(f.scene)
    store.getState().select([f.wallId])
    store.getState().copySelection()
    expect(store.getState().paste({ at: { x: 50, z: 70 } }).length).toBeGreaterThan(0)
    expect(loads(store.getState().scene)).toBe(true)
    expect(validatePastedItems(f.scene, [f.wallId, f.doorId])).toEqual([])
    expect(copySelection(f.scene, [f.wallId])).not.toBeNull()
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
