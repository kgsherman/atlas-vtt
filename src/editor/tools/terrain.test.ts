import type { Patch } from "immer"
import { describe, expect, it } from "vitest"

import { createScene } from "@/core/scene/factory"
import { chunkSamples, parseChunkKey, sampleHeight, sampleSpacing } from "@/core/scene/heightmap"
import type { Id, Rect } from "@/core/scene/types"

import { at, key, makeStore } from "../test-utils"
import { createTerrainTool } from "./terrain"

function setup() {
  const scene = createScene({ width: 20, depth: 20 })
  const store = makeStore(scene)
  const levelId = store.getState().activeLevelId
  store.getState().setToolSettings("brush", { mode: "raise", radius: 6, strength: 1, falloff: "smooth" })
  const previews: { levelId: Id; heights: Float32Array | null; dirty: Rect | null }[] = []
  const tool = createTerrainTool({ store, previewTerrain: (l, heights, dirty) => previews.push({ levelId: l, heights, dirty }) })
  return { store, levelId, tool, previews }
}

/** Chunk keys whose samples overlap a world rect (res 2, 5 ft cells → 2.5 ft spacing, 16 samples per chunk). */
function chunksOverlapping(rect: Rect, resolution: number, cellSize: number): Set<string> {
  const s = sampleSpacing(cellSize, resolution)
  const n = chunkSamples(resolution)
  const out = new Set<string>()
  for (let ci = Math.floor(Math.floor(rect.x / s) / n); ci <= Math.floor(Math.ceil((rect.x + rect.w) / s) / n); ci++) {
    for (let cj = Math.floor(Math.floor(rect.z / s) / n); cj <= Math.floor(Math.ceil((rect.z + rect.d) / s) / n); cj++) out.add(`${ci},${cj}`)
  }
  return out
}

describe("terrain brush tool", () => {
  it("previews while painting and commits ONE undo step on pointerup", () => {
    const { store, levelId, tool, previews } = setup()
    const before = store.getState().scene
    tool.onPointerDown!(at(20, 20))
    expect(tool.painting()).toBe(true)
    for (const x of [22, 24, 26, 28, 30]) tool.onPointerMove!(at(x, 20))
    // The document is untouched while painting; the engine gets the scratch lattice.
    expect(store.getState().scene).toBe(before)
    expect(previews.length).toBeGreaterThan(1)
    expect(previews[0].heights).toBeInstanceOf(Float32Array)
    expect(previews[0].dirty).not.toBeNull()
    expect(tool.preview()).toMatchObject({ kind: "brush", levelId, center: { x: 30, z: 20 }, radius: 6, mode: "raise" })

    tool.onPointerUp!(at(30, 20))
    expect(tool.painting()).toBe(false)
    expect(previews[previews.length - 1]).toEqual({ levelId, heights: null, dirty: null })
    const s = store.getState()
    expect(s.history).toMatchObject({ undoDepth: 1, undoLabel: "Paint terrain" })
    expect(s.lastChange).toEqual({ terrain: [levelId] })
    const hm = s.scene.levels[levelId].heightmap!
    expect(hm.resolution).toBe(2)
    expect(sampleHeight(hm, 5, 25, 20)).toBeGreaterThan(1)
    expect(sampleHeight(hm, 5, 80, 80)).toBe(0)

    s.undo()
    expect(store.getState().scene.levels[levelId].heightmap).toBeNull()
  })

  it("a stroke on existing terrain patches only the chunks it dirtied", () => {
    const { store, levelId, tool } = setup()
    tool.onPointerDown!(at(20, 20))
    tool.onPointerUp!(at(20, 20))
    const firstChunks = { ...store.getState().scene.levels[levelId].heightmap!.chunks }
    expect(Object.keys(firstChunks)).toEqual(["0,0"])

    const patches: Patch[] = []
    store.getState().setPatchSink((p) => patches.push(...p))
    // A stroke across the chunk boundary at x = z = 80 (sample 32).
    tool.onPointerDown!(at(78, 78))
    tool.onPointerMove!(at(82, 82))
    tool.onPointerUp!(at(82, 82))
    expect(store.getState().history.undoDepth).toBe(2)

    const dirty = { x: 78 - 6 - 2.5, z: 78 - 6 - 2.5, w: 4 + 12 + 5, d: 4 + 12 + 5 }
    const allowed = chunksOverlapping(dirty, 2, 5)
    expect(patches.length).toBeGreaterThan(0)
    for (const p of patches) {
      expect(p.path.slice(0, 4)).toEqual(["levels", levelId, "heightmap", "chunks"])
      expect(p.path).toHaveLength(5)
      expect(allowed.has(String(p.path[4]))).toBe(true)
    }
    const touched = new Set(patches.map((p) => String(p.path[4])))
    expect(touched.has("0,0")).toBe(false)
    expect([...touched].every((k) => parseChunkKey(k).ci >= 1)).toBe(true)
    // The first stroke's chunk is the very same string.
    expect(store.getState().scene.levels[levelId].heightmap!.chunks["0,0"]).toBe(firstChunks["0,0"])

    store.getState().undo()
    expect(store.getState().scene.levels[levelId].heightmap!.chunks).toEqual(firstChunks)
  })

  it("lowering back to zero drops the chunk", () => {
    const { store, levelId, tool } = setup()
    tool.onPointerDown!(at(20, 20))
    tool.onPointerUp!(at(20, 20))
    store.getState().setToolSettings("brush", { mode: "flatten", strength: 1, radius: 30, falloff: "constant" })
    tool.onPointerDown!(at(60, 60))
    tool.onPointerMove!(at(20, 20))
    tool.onPointerUp!(at(20, 20))
    expect(store.getState().scene.levels[levelId].heightmap!.chunks).toEqual({})
  })

  it("Escape (or cancel) discards the stroke", () => {
    const { store, levelId, tool, previews } = setup()
    tool.onPointerDown!(at(20, 20))
    tool.onPointerMove!(at(25, 20))
    expect(tool.onKeyDown!(key("Escape"))).toBe(true)
    tool.onPointerUp!(at(25, 20))
    expect(store.getState().history.canUndo).toBe(false)
    expect(previews[previews.length - 1].heights).toBeNull()
    tool.onPointerDown!(at(20, 20))
    tool.cancel!()
    expect(store.getState().history.canUndo).toBe(false)
    expect(store.getState().scene.levels[levelId].heightmap).toBeNull()
  })
})
