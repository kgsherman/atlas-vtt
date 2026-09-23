/**
 * Light origins are pushed out of the light blockers containing them (docs/ARCHITECTURE.md §2
 * "Occlusion query semantics"): rays from a point inside a blocker ignore it, so without the push a
 * candle standing on a slab lights the storey below and a torch inside a wall lights both sides.
 */
import { describe, expect, it } from "vitest"

import { buildOcclusionWorld } from "../occlusion"
import { paintHeightmap } from "../occlusion/test-utils"
import { createLight, createWall } from "../scene/factory"
import type { Scene, Token } from "../scene/types"
import { createVisionEngine, resolveLightOrigin, resolveLightWorldOrigin, VisionEngineImpl } from "."
import { add, addLevel, addToken, flat, withObject } from "./test-scenes"
import type { VisionEngine } from "./types"

/** Light level of sample k of cell (i, j). */
function lightAt(engine: VisionEngine, levelId: string, i: number, j: number, k = 0): number {
  const s = (engine as VisionEngineImpl).inspectSample(levelId, i, j, k)
  if (!s || !s.valid) throw new Error(`no sample at ${levelId} (${i}, ${j})`)
  return s.light
}

/** Cellar (L0, full floor) under a storey L1 at elevation 10 with a full 1.5 ft slab, all dark. */
function twoStoreys(terrain = false): { scene: Scene; cellar: string; upper: string } {
  const { scene, ground } = flat(6, 6, "dark")
  const upper = addLevel(scene, { name: "Upper", elevation: 10, floorThickness: 1.5 }, { x: 0, z: 0, w: 30, d: 30 })
  if (terrain) paintHeightmap(scene, upper.id, (x) => (x > 25 ? 0.5 : 0), 2)
  return { scene, cellar: ground, upper: upper.id }
}

describe("light origins inside blockers", () => {
  for (const terrain of [false, true]) {
    for (const y of [0, 1e-7, -0.5]) {
      it(`a candle on the upper storey at y = ${y} does not light the cellar${terrain ? " (terrain slab)" : ""}`, () => {
        const { scene, cellar, upper } = twoStoreys(terrain)
        const candle = add(scene, createLight(upper, "custom", { x: 15, z: 15 }, { brightRadius: 20, dimRadius: 30 }))
        candle.position.y = y
        const viewer = addToken(scene, cellar, 12.5, 12.5)
        const engine = createVisionEngine(scene)
        expect(lightAt(engine, cellar, 2, 2)).toBe(0)
        expect(lightAt(engine, cellar, 3, 3)).toBe(0)
        // Its own storey is lit.
        expect(lightAt(engine, upper, 2, 2)).toBe(2)
        // A normal-vision creature in the cellar perceives nothing but its own footprint.
        const res = engine.compute([engine.viewerFor(viewer)])
        expect([...res.perception[cellar].grades].filter((g) => g > 0)).toHaveLength(1)
        expect(res.illuminatingLightIds.size).toBe(0)
        // The resolved origin sits just above the slab.
        const o = resolveLightWorldOrigin(buildOcclusionWorld(scene), scene, candle)
        expect(o.y).toBeCloseTo(10.3, 5)
      })
    }
  }

  it("a lantern hanging into the next storey's slab lights its own level, not the one above", () => {
    const { scene, cellar, upper } = twoStoreys()
    const lantern = add(scene, createLight(cellar, "lantern", { x: 15, z: 15 }))
    for (const y of [9.5, 9.8]) {
      lantern.position.y = y
      const engine = createVisionEngine(scene)
      expect(lightAt(engine, upper, 2, 2), `y = ${y}`).toBe(0)
      expect(lightAt(engine, cellar, 2, 2), `y = ${y}`).toBe(2)
      // Pushed below the slab's underside (10 − 1.5).
      expect(resolveLightWorldOrigin(buildOcclusionWorld(scene), scene, lantern).y).toBeCloseTo(8.2, 5)
    }
  })

  it("a torch inside a wall lights exactly one side", () => {
    const { scene, ground } = flat(8, 4, "dark")
    const torch = add(scene, createLight(ground, "torch", { x: 20.1, z: 10 }))
    add(scene, createWall(ground, { x: 20, z: 0 }, { x: 20, z: 20 }, { height: 10, thickness: 1 }))
    const engine = createVisionEngine(scene)
    // Nearest face is east (x = 20.5): pushed to 20.8.
    expect(resolveLightWorldOrigin(buildOcclusionWorld(scene), scene, torch).x).toBeCloseTo(20.8, 9)
    expect(lightAt(engine, ground, 2, 2)).toBe(0)
    expect(lightAt(engine, ground, 5, 2)).toBe(2)
  })

  it("a wall thickened over a wall-mounted torch keeps the far side dark (incremental)", () => {
    const { scene: s0, ground } = flat(8, 4, "dark")
    add(s0, createLight(ground, "torch", { x: 19.45, z: 10 }))
    const wall = add(s0, createWall(ground, { x: 20, z: 0 }, { x: 20, z: 20 }, { height: 10, thickness: 0.5 }))
    const viewer = addToken(s0, ground, 7.5, 12.5)
    const engine = new VisionEngineImpl(s0)
    expect(lightAt(engine, ground, 2, 2)).toBe(2)
    expect(lightAt(engine, ground, 5, 2)).toBe(0)
    const s1 = withObject(s0, { ...wall, thickness: 1.5 })
    engine.update(s1, { objects: [wall.id] })
    expect(lightAt(engine, ground, 2, 2)).toBe(2)
    expect(lightAt(engine, ground, 5, 2)).toBe(0)
    expectSameAsFresh(engine, s1, [viewer])
  })

  it("a token-attached light whose carrier stands inside a wall lights one side", () => {
    const { scene, ground } = flat(8, 4, "dark")
    add(scene, createWall(ground, { x: 20, z: 0 }, { x: 20, z: 20 }, { height: 10, thickness: 1 }))
    const bearer = addToken(scene, ground, 20.1, 10)
    add(scene, createLight(ground, "torch", { x: 0, z: 0 }, { attachedTokenId: bearer.id, position: { x: 0, y: 4, z: 0 } }))
    const engine = createVisionEngine(scene)
    const west = lightAt(engine, ground, 2, 2)
    const east = lightAt(engine, ground, 5, 2)
    expect(Math.min(west, east)).toBe(0)
    expect(Math.max(west, east)).toBe(2)
  })

  it("resolves T-junctions (a push that lands in another wall is repeated)", () => {
    const { scene, ground } = flat(8, 8, "dark")
    // Stem from the south ending on the cross wall's centreline; torch in the overlap near the stem.
    add(scene, createWall(ground, { x: 0, z: 20 }, { x: 40, z: 20 }, { thickness: 1 }))
    add(scene, createWall(ground, { x: 20, z: 0 }, { x: 20, z: 20 }, { thickness: 1 }))
    const world = buildOcclusionWorld(scene)
    const q = resolveLightOrigin(world, { x: 20.2, y: 5, z: 19.9 }, 0)
    expect(world.containing(q, "light")).toEqual([])
  })

  it("leaves origins in the open untouched", () => {
    const { scene, ground } = flat(4, 4, "dark")
    const torch = add(scene, createLight(ground, "torch", { x: 10, z: 10 }))
    expect(resolveLightWorldOrigin(buildOcclusionWorld(scene), scene, torch)).toEqual({ x: 10, y: 5, z: 10 })
  })
})

function expectSameAsFresh(engine: VisionEngineImpl, scene: Scene, viewers: Token[]): void {
  const fresh = new VisionEngineImpl(scene)
  const L = Object.keys(scene.levels)
  for (const levelId of L) {
    for (let j = 0; j < scene.grid.depth; j++) {
      for (let i = 0; i < scene.grid.width; i++) {
        for (let k = 0; k < 5; k++) expect(engine.inspectSample(levelId, i, j, k)).toEqual(fresh.inspectSample(levelId, i, j, k))
      }
    }
  }
  const a = engine.compute(viewers.map((t) => engine.viewerFor(t)))
  const b = fresh.compute(viewers.map((t) => fresh.viewerFor(t)))
  expect([...a.illuminatingLightIds]).toEqual([...b.illuminatingLightIds])
  for (const levelId of L) expect(a.perception[levelId]?.grades).toEqual(b.perception[levelId]?.grades)
}
