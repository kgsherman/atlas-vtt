import { enablePatches, produceWithPatches } from "immer"
import { describe, expect, it } from "vitest"

import { createScene } from "@/core/scene/factory"

import { sceneChangeFromPatches } from "./sceneChange"

enablePatches()

describe("sceneChangeFromPatches: terrain edits", () => {
  it("ignores levels/<id>/terrainEdits (DM-only; the baked heightmap patches carry the change)", () => {
    expect(sceneChangeFromPatches([{ op: "replace", path: ["levels", "L", "terrainEdits", "shapes", "s1", "points", 0, "x"], value: 3 }])).toEqual({})
    expect(sceneChangeFromPatches([{ op: "add", path: ["levels", "L", "terrainEdits"], value: { shapes: {}, baseChunks: {} } }])).toEqual({})
    expect(sceneChangeFromPatches([{ op: "remove", path: ["levels", "L", "terrainEdits"] }])).toEqual({})
    expect(
      sceneChangeFromPatches([
        { op: "replace", path: ["levels", "L", "terrainEdits", "baseChunks", "0,0"], value: "" },
        { op: "replace", path: ["levels", "L", "heightmap", "chunks", "0,0"], value: "AAAA" },
      ])
    ).toEqual({ terrain: ["L"] })
    // The level itself or its other fields are still structural.
    expect(sceneChangeFromPatches([{ op: "replace", path: ["levels", "L"], value: {} }])).toEqual({ structure: true })
    expect(sceneChangeFromPatches([{ op: "replace", path: ["levels"], value: {} }])).toEqual({ structure: true })
  })

  it("classifies real immer patches of a shape commit", () => {
    const scene = createScene()
    const id = Object.keys(scene.levels)[0]
    scene.levels[id].heightmap = { resolution: 1, chunks: {} }
    const [, patches] = produceWithPatches(scene, (d) => {
      d.levels[id].terrainEdits = { shapes: {}, baseChunks: { "0,0": "" } }
      d.levels[id].heightmap!.chunks["0,0"] = "AAAA"
    })
    expect(sceneChangeFromPatches(patches)).toEqual({ terrain: [id] })
  })
})
