import { afterEach, describe, expect, it, vi } from "vitest"

import { createScene, createWall } from "@/core/scene/factory"
import { SCENE_SCHEMA_VERSION } from "@/core/scene/types"

import { draftScene } from "./useSceneDocument"

describe("draftScene (autosave draft recovery)", () => {
  afterEach(() => vi.restoreAllMocks())

  it("migrates drafts saved by an older app version and passes current ones through", () => {
    const scene = createScene()
    const levelId = Object.keys(scene.levels)[0]
    const wall = createWall(levelId, { x: 5, z: 5 }, { x: 20, z: 5 })
    scene.objects[wall.id] = wall
    const current = draftScene(JSON.parse(JSON.stringify(scene)))
    expect(current).toEqual(scene)
    // The same draft as a v1 document (walls had no followTerrain).
    const v1 = JSON.parse(JSON.stringify(scene))
    v1.schemaVersion = 1
    delete v1.objects[wall.id].followTerrain
    const migrated = draftScene(v1)
    expect(migrated?.schemaVersion).toBe(SCENE_SCHEMA_VERSION)
    expect(migrated?.objects[wall.id]).toMatchObject({ type: "wall", followTerrain: true })
    // Idempotent: recovering the recovered draft changes nothing.
    expect(draftScene(JSON.parse(JSON.stringify(migrated)))).toEqual(migrated)
  })

  it("ignores drafts that cannot be opened (invalid or from a newer version)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(draftScene({ schemaVersion: 1, objects: "nope" })).toBeNull()
    expect(draftScene({ ...createScene(), schemaVersion: SCENE_SCHEMA_VERSION + 1 })).toBeNull()
    expect(draftScene(null)).toBeNull()
    expect(warn).toHaveBeenCalledTimes(3)
  })
})
