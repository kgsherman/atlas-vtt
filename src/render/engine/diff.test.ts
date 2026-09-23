import { describe, expect, it } from "vitest"

import { createConnector, createDoor, createFloor, createLevel, createLight, createScene, createToken, createWall, createWindow } from "@/core/scene/factory"
import { createHeightmap, denseHeights, writeHeights } from "@/core/scene/heightmap"
import type { Scene } from "@/core/scene/types"

import { classifyStructure, deepEqual, diffScenes, heightmapDiffRect, invalidateTerrain, invalidation, occlusionClosure } from "./diff"

function base() {
  const scene = createScene({ width: 16, depth: 16 })
  const ground = Object.keys(scene.levels)[0]
  const upper = createLevel({ name: "Upper", elevation: 10 })
  scene.levels[upper.id] = upper
  const upperFloor = createFloor(upper.id, { x: 0, z: 0, w: 80, d: 80 })
  const w1 = createWall(ground, { x: 0, z: 0 }, { x: 20, z: 0 })
  const w2 = createWall(ground, { x: 20, z: 0 }, { x: 20, z: 20 })
  const w3 = createWall(ground, { x: 50, z: 50 }, { x: 60, z: 50 })
  const door = createDoor(w1, 10)
  const win = createWindow(w2, 10)
  const token = createToken(ground, { x: 2.5, z: 2.5 })
  const carried = createLight(ground, "torch", { x: 0, z: 0 }, { attachedTokenId: token.id })
  for (const o of [upperFloor, w1, w2, w3, door, win, carried]) scene.objects[o.id] = o
  scene.tokens[token.id] = token
  return { scene, ground, upper: upper.id, upperFloor, w1, w2, w3, door, win, token, carried }
}

const clone = (s: Scene): Scene => structuredClone(s)

describe("scene diff", () => {
  it("compares structurally", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true)
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(deepEqual(new Float32Array([1, 2]), new Float32Array([1, 2]))).toBe(true)
    expect(deepEqual([1], { 0: 1 })).toBe(false)
  })

  it("finds changed objects and tokens even when every object is a fresh copy", () => {
    const { scene, door, token } = base()
    const next = clone(scene)
    ;(next.objects[door.id] as typeof door).state = "open"
    next.tokens[token.id].position = { x: 7.5, z: 2.5 }
    expect(diffScenes(scene, next)).toEqual({ objects: [door.id], tokens: [token.id] })
    expect(diffScenes(scene, clone(scene))).toEqual({})
  })

  it("separates terrain edits from structural changes", () => {
    const { scene, ground } = base()
    const next = clone(scene)
    const hm = createHeightmap(1)
    const dense = denseHeights(hm, next.grid).heights
    dense[5] = 2
    next.levels[ground].heightmap = writeHeights(hm, next.grid, dense)
    expect(diffScenes(scene, next)).toEqual({ terrain: [ground] })
    const env = clone(scene)
    env.environment.backgroundColor = "#000000"
    expect(diffScenes(scene, env)).toEqual({ structure: true })
    expect(classifyStructure(scene, env)).toEqual({ geometry: false, environment: true })
    const moved = clone(scene)
    moved.levels[ground].elevation = -2
    expect(classifyStructure(scene, moved).geometry).toBe(true)
  })

  it("does not rebuild geometry for door state or label changes", () => {
    const { scene, door, w1 } = base()
    const next = clone(scene)
    ;(next.objects[door.id] as typeof door).state = "open"
    next.objects[w1.id].name = "North wall"
    const inv = invalidation(scene, next, { objects: [door.id, w1.id] })
    expect(inv.buckets.size).toBe(0)
  })

  it("rebuilds the right buckets", () => {
    const { scene, ground, upper, w1, win, token, carried } = base()
    const next = clone(scene)
    ;(next.objects[w1.id] as typeof w1).height = 12
    ;(next.objects[win.id] as typeof win).width = 2
    const stairs = createConnector(ground, upper, { x: 30, z: 30, w: 5, d: 10 }, 0)
    next.objects[stairs.id] = stairs
    next.tokens[token.id].position = { x: 12.5, z: 12.5 }
    const inv = invalidation(scene, next, { objects: [w1.id, win.id, stairs.id], tokens: [token.id] })
    expect([...inv.buckets.get(ground)!].sort()).toEqual(["connectors", "doors", "fixtures", "walls"])
    // The stairs cut a hole in the upper floor.
    expect([...inv.buckets.get(upper)!]).toEqual(["floors"])
    expect(inv.tokens).toBe(true)
    expect(carried.attachedTokenId).toBe(token.id)
  })

  it("rebuilds a level and the connectors reaching it on terrain edits", () => {
    const { scene, ground, upper } = base()
    const stairs = createConnector(ground, upper, { x: 30, z: 30, w: 5, d: 10 }, 0)
    scene.objects[stairs.id] = stairs
    const inv = invalidation(scene, scene, { terrain: [upper] })
    expect(inv.buckets.get(upper)!.size).toBe(7)
    expect([...inv.buckets.get(ground)!]).toEqual(["connectors"])
    // An in-place terrain commit (the engine moved the mesh itself) marks only what it asks for, plus the
    // connectors reaching the level and the tokens.
    const partial = invalidation(scene, scene, {})
    invalidateTerrain(partial, scene, upper, ["props"])
    expect([...partial.buckets.get(upper)!]).toEqual(["props"])
    expect([...partial.buckets.get(ground)!]).toEqual(["connectors"])
    expect(partial.tokens).toBe(true)
  })

  it("closes occlusion updates over openings, host walls and joints", () => {
    const { scene, w1, w2, w3, door, win } = base()
    const ids = occlusionClosure(scene, scene, [w1.id])
    expect(ids).toContain(door.id)
    expect(ids).toContain(w2.id)
    expect(ids).not.toContain(w3.id)
    expect(occlusionClosure(scene, scene, [win.id])).toContain(w2.id)
  })

  it("reports the rect of changed heightmap chunks", () => {
    const { scene, ground } = base()
    const grid = scene.grid
    const hm = createHeightmap(1)
    const dense = denseHeights(hm, grid).heights
    dense[10 * 17 + 10] = 3 // sample (10, 10) → chunk (1, 1) at 8 samples per chunk
    const next = writeHeights(hm, grid, dense)
    const r = heightmapDiffRect(hm, next, grid)!
    expect(r.x).toBeLessThanOrEqual(40)
    expect(r.x + r.w).toBeGreaterThanOrEqual(80)
    expect(r.z).toBeLessThanOrEqual(40)
    expect(heightmapDiffRect(next, next, grid)).toBeNull()
    expect(heightmapDiffRect(null, next, grid)).toEqual({ x: 0, z: 0, w: 80, d: 80 })
    expect(scene.levels[ground].heightmap).toBeNull()
  })
})
