import { describe, expect, it } from "vitest"

import { createDoor, createLight, createScene, createToken, createWall } from "@/core/scene/factory"
import { SAMPLE_SCENES } from "@/core/scene/samples"

import { isSceneDigest, primaryLevel, sceneDigest } from "./sceneDigest"

describe("sceneDigest", () => {
  it("summarises every sample and survives a JSON round trip", () => {
    for (const sample of SAMPLE_SCENES) {
      const scene = sample.build()
      const digest = sceneDigest(scene)
      expect(digest.levels.length).toBe(Object.keys(scene.levels).length)
      expect(digest.counts.objects).toBe(Object.keys(scene.objects).length)
      expect(digest.counts.tokens).toBe(Object.keys(scene.tokens).length)
      expect(digest.primary.floors.length).toBeGreaterThan(0)
      const back = JSON.parse(JSON.stringify(digest))
      expect(isSceneDigest(back)).toBe(true)
      expect(back).toEqual(digest)
      // Palette indices are in range.
      for (const f of digest.primary.floors) expect(f[4]).toBeLessThan(digest.palette.length)
      for (const l of digest.primary.lights) expect(l[4]).toBeLessThan(digest.palette.length)
    }
  })

  it("shows the ground storey of a multi-level scene", () => {
    const lantern = SAMPLE_SCENES.find((s) => s.id === "crooked-lantern")!.build()
    expect(primaryLevel(lantern).elevation).toBe(0)
    const digest = sceneDigest(lantern)
    expect(digest.primary.elevation).toBe(0)
    expect(digest.levels.map((l) => l.elevation)).toEqual([-10, 0, 10, 20])
    expect(digest.primary.walls.length).toBeGreaterThan(4)
    expect(digest.primary.lights.length).toBeGreaterThan(0)
  })

  it("encodes doors on their wall, lights, tokens and content bounds", () => {
    const scene = createScene({ width: 20, depth: 20, groundFloor: false })
    const level = Object.values(scene.levels)[0]
    const wall = createWall(level.id, { x: 10, z: 10 }, { x: 30, z: 10 })
    const door = createDoor(wall, 10, { width: 4 })
    const light = createLight(level.id, "torch", { x: 20, z: 15 })
    const token = createToken(level.id, { x: 12.5, z: 12.5 })
    scene.objects[wall.id] = wall
    scene.objects[door.id] = door
    scene.objects[light.id] = light
    scene.tokens[token.id] = token
    const d = sceneDigest(scene)
    expect(d.primary.doors).toEqual([[18, 10, 22, 10, wall.thickness]])
    expect(d.primary.lights[0].slice(0, 2)).toEqual([20, 15])
    expect(d.primary.tokens[0].slice(0, 2)).toEqual([12.5, 12.5])
    const [bx, bz, bw, bd] = d.primary.bounds
    expect(bx).toBeLessThan(10)
    expect(bz).toBeLessThan(10)
    expect(bx + bw).toBeGreaterThan(30)
    expect(bz + bd).toBeGreaterThanOrEqual(10)
  })

  it("rejects malformed cache entries", () => {
    expect(isSceneDigest(null)).toBe(false)
    expect(isSceneDigest({ v: 999 })).toBe(false)
    expect(isSceneDigest({ v: 1, levels: [], palette: [], counts: {}, primary: { floors: [], walls: [] } })).toBe(false)
  })
})
