/**
 * Vision benchmarks (docs/PERFORMANCE.md §8): a generated 100×100-cell, 3-level dungeon with
 * 20 lights and 15 tokens. Targets: full line-of-sight compute for one viewer ≤ 50 ms, light-field
 * update for one light ≤ 5 ms. Thresholds below are generous (shared CI machines); the measured
 * numbers are printed.
 */
import { describe, expect, it } from "vitest"

import { rng } from "../occlusion/test-utils"
import { createConnector, createDoor, createFloor, createLevel, createLight, createPillar, createProp, createScene, createToken, createWall } from "../scene/factory"
import type { Id, LightObject, PropKind, Scene, SceneObject, Token } from "../scene/types"
import { VisionEngineImpl } from "./engine"
import { perceivedCount } from "./test-scenes"
import type { Viewer } from "./types"

const PROPS: PropKind[] = ["crate", "barrel", "table", "statue", "bookshelf", "chest", "rock", "bush"]
const SIZE = 100
const ROOM = 50

interface Dungeon {
  scene: Scene
  levels: Id[]
  tokens: Token[]
  bearer: Token
  staticLights: LightObject[]
}

function dungeon(seed: number): Dungeon {
  const r = rng(seed)
  const scene = createScene({ width: SIZE, depth: SIZE, groundFloor: false })
  scene.environment.skyLevel = "dark"
  scene.environment.ambientLevel = "dark"
  const add = <T extends SceneObject>(o: T): T => {
    scene.objects[o.id] = o
    return o
  }
  const levels: Id[] = [Object.keys(scene.levels)[0]]
  for (const elevation of [10, 20]) {
    const l = createLevel({ name: `L${elevation}`, elevation })
    scene.levels[l.id] = l
    levels.push(l.id)
  }
  const extent = SIZE * 5
  const rooms = extent / ROOM
  const roomCentre = () => ({ x: (Math.floor(r() * rooms) + 0.5) * ROOM + 2.5, z: (Math.floor(r() * rooms) + 0.5) * ROOM + 2.5 })
  levels.forEach((levelId) => {
    add(createFloor(levelId, { x: 0, z: 0, w: extent, d: extent }))
    // Room grid: wall segments of one room side, each with a door in the middle.
    for (let k = 0; k <= rooms; k++) {
      for (let m = 0; m < rooms; m++) {
        const v = add(createWall(levelId, { x: k * ROOM, z: m * ROOM }, { x: k * ROOM, z: (m + 1) * ROOM }))
        const h = add(createWall(levelId, { x: m * ROOM, z: k * ROOM }, { x: (m + 1) * ROOM, z: k * ROOM }))
        if (k > 0 && k < rooms) {
          add(createDoor(v, ROOM / 2, { state: r() < 0.5 ? "open" : "closed" }))
          add(createDoor(h, ROOM / 2, { state: r() < 0.5 ? "open" : "closed" }))
        }
      }
    }
    for (let k = 0; k < 30; k++) add(createPillar(levelId, { x: 5 + r() * (extent - 10), z: 5 + r() * (extent - 10) }, { size: 2 }))
    for (let k = 0; k < 40; k++) {
      add(createProp(levelId, PROPS[k % PROPS.length], { x: 5 + r() * (extent - 10), y: 0, z: 5 + r() * (extent - 10) }, { rotationY: r() * 6 }))
    }
  })
  // Stairs between consecutive levels.
  add(createConnector(levels[0], levels[1], { x: 60, z: 60, w: 5, d: 10 }, 0))
  add(createConnector(levels[1], levels[2], { x: 160, z: 160, w: 5, d: 10 }, 0))

  const staticLights: LightObject[] = []
  const lightLevels = [...Array(10).fill(0), ...Array(5).fill(1), ...Array(4).fill(2)] as number[]
  for (const li of lightLevels) staticLights.push(add(createLight(levels[li], "torch", roomCentre())))

  const tokens: Token[] = []
  const tokenLevels = [...Array(10).fill(0), ...Array(3).fill(1), ...Array(2).fill(2)] as number[]
  tokenLevels.forEach((li, k) => {
    const p = roomCentre()
    const t = createToken(levels[li], { x: p.x + 5, z: p.z + 5 }, k % 5 === 0 ? { vision: { darkvision: 60, blindsight: 0, blind: false } } : {})
    scene.tokens[t.id] = t
    tokens.push(t)
  })
  const bearer = tokens[1]
  add(createLight(levels[0], "torch", { x: 0, z: 0 }, { attachedTokenId: bearer.id, position: { x: 0, y: 4, z: 0 } }))
  return { scene, levels, tokens, bearer, staticLights }
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

function time<T>(fn: () => T): { ms: number; value: T } {
  const t = performance.now()
  const value = fn()
  return { ms: performance.now() - t, value }
}

describe("vision performance", () => {
  it("100×100×3 dungeon, 20 lights, 15 tokens", () => {
    // JIT warm-up on a separate engine.
    {
      const d = dungeon(3)
      const e = new VisionEngineImpl(d.scene)
      e.compute(d.tokens.slice(0, 3).map((t) => e.viewerFor(t)))
    }

    const d = dungeon(1)
    const created = time(() => new VisionEngineImpl(d.scene))
    const engine = created.value
    expect(engine.stats().lights).toBe(20)
    const viewers: Viewer[] = d.tokens.map((t) => engine.viewerFor(t))

    // Full compute for one viewer (fresh line-of-sight cache), several viewers.
    const full: number[] = []
    let perceived = 0
    for (let k = 0; k < 7; k++) {
      const { ms, value } = time(() => engine.compute([viewers[k]]))
      full.push(ms)
      perceived += perceivedCount(value, viewers[k].levelId)
    }
    expect(perceived).toBeGreaterThan(0)
    const fullMs = median(full)

    // Warm compute of all 15 viewers (caches primed), then again with nothing changed.
    for (const v of viewers) engine.compute([v])
    const idle = time(() => {
      for (const v of viewers) engine.compute([v])
    })

    // Single light move (update only), median of 9.
    let scene = d.scene
    const lamp = d.staticLights[0]
    const moves: number[] = []
    const after: number[] = []
    for (let k = 0; k < 9; k++) {
      const pos = { ...lamp.position, x: lamp.position.x + (k % 2 === 0 ? 5 : 0) }
      scene = { ...scene, objects: { ...scene.objects, [lamp.id]: { ...lamp, position: pos } } }
      moves.push(time(() => engine.update(scene, { objects: [lamp.id] })).ms)
      after.push(time(() => engine.compute([viewers[0]])).ms)
    }
    const lightMs = median(moves)
    const afterMs = median(after)

    // Torch bearer steps one cell: update + a compute per viewer (15 players) and one union compute.
    const steps: number[] = []
    const unions: number[] = []
    let bearer = d.bearer
    for (let k = 0; k < 5; k++) {
      bearer = { ...bearer, position: { x: bearer.position.x + 5, z: bearer.position.z } }
      scene = { ...scene, tokens: { ...scene.tokens, [bearer.id]: bearer } }
      const s = scene
      steps.push(
        time(() => {
          engine.update(s, { tokens: [bearer.id] })
          const vs = d.tokens.map((t) => engine.viewerFor(s.tokens[t.id]))
          for (const v of vs) engine.compute([v])
        }).ms
      )
      unions.push(time(() => engine.compute(d.tokens.map((t) => engine.viewerFor(s.tokens[t.id])))).ms)
    }
    const stepMs = median(steps)
    const unionMs = median(unions)

    // Worst case: daylight everywhere (every sample lit → line of sight to the whole map).
    const day: Scene = { ...scene, environment: { ...scene.environment, ambientLevel: "bright", skyLevel: "bright" } }
    const dayEngine = new VisionEngineImpl(day)
    const dayViewer = dayEngine.viewerFor(day.tokens[d.tokens[0].id])
    const dayMs = time(() => dayEngine.compute([dayViewer])).ms

    console.log(
      `[vision perf] ${engine.stats().samples} samples; engine build ${created.ms.toFixed(0)} ms; ` +
        `full compute 1 viewer: median ${fullMs.toFixed(1)} ms (${full.map((x) => x.toFixed(1)).join(", ")}); ` +
        `15 warm viewers, no change: ${idle.ms.toFixed(1)} ms; light move update ${lightMs.toFixed(2)} ms, then 1-viewer compute ${afterMs.toFixed(2)} ms; ` +
        `torch-bearer step (update + 15 per-viewer computes) ${stepMs.toFixed(1)} ms, union of 15 ${unionMs.toFixed(1)} ms; ` +
        `daylight full compute ${dayMs.toFixed(0)} ms`
    )
    expect(fullMs).toBeLessThan(200)
    expect(lightMs).toBeLessThan(20)
    expect(stepMs).toBeLessThan(1000)
  })

  it("200×200 single level, ~10k objects, 20 lights", () => {
    const r = rng(5)
    const scene = createScene({ width: 200, depth: 200 })
    scene.environment.skyLevel = "dark"
    scene.environment.ambientLevel = "dark"
    const levelId = Object.keys(scene.levels)[0]
    const add = <T extends SceneObject>(o: T): T => {
      scene.objects[o.id] = o
      return o
    }
    // 30 ft rooms with a door in every wall segment.
    const room = 30
    const n = Math.floor(1000 / room)
    for (let k = 0; k <= n; k++) {
      for (let m = 0; m < n; m++) {
        const v = add(createWall(levelId, { x: k * room, z: m * room }, { x: k * room, z: (m + 1) * room }))
        const h = add(createWall(levelId, { x: m * room, z: k * room }, { x: (m + 1) * room, z: k * room }))
        if (k > 0 && k < n) {
          add(createDoor(v, room / 2, { state: r() < 0.5 ? "open" : "closed" }))
          add(createDoor(h, room / 2, { state: r() < 0.5 ? "open" : "closed" }))
        }
      }
    }
    for (let k = 0; k < 3000; k++) add(createProp(levelId, PROPS[k % PROPS.length], { x: 5 + r() * 990, y: 0, z: 5 + r() * 990 }, { rotationY: r() * 6 }))
    const lights: LightObject[] = []
    for (let k = 0; k < 20; k++) lights.push(add(createLight(levelId, "torch", { x: (Math.floor(r() * n) + 0.5) * room, z: (Math.floor(r() * n) + 0.5) * room })))
    const tokens: Token[] = []
    for (let k = 0; k < 15; k++) {
      const t = createToken(levelId, { x: (Math.floor(r() * n) + 0.5) * room + 2.5, z: (Math.floor(r() * n) + 0.5) * room + 2.5 })
      scene.tokens[t.id] = t
      tokens.push(t)
    }
    const objects = Object.keys(scene.objects).length
    const created = time(() => new VisionEngineImpl(scene))
    const engine = created.value
    const viewers = tokens.map((t) => engine.viewerFor(t))
    const full: number[] = []
    for (let k = 0; k < 5; k++) full.push(time(() => engine.compute([viewers[k]])).ms)
    const idle = time(() => engine.compute([viewers[0]])).ms
    const lamp = lights[0]
    const moved = { ...scene, objects: { ...scene.objects, [lamp.id]: { ...lamp, position: { ...lamp.position, x: lamp.position.x + 5 } } } }
    const lightMs = time(() => engine.update(moved, { objects: [lamp.id] })).ms
    console.log(
      `[vision perf] 200×200: ${objects} objects, ${engine.stats().samples} samples; engine build ${created.ms.toFixed(0)} ms; ` +
        `full compute 1 viewer: median ${median(full).toFixed(1)} ms; unchanged recompute ${idle.toFixed(1)} ms; light move ${lightMs.toFixed(2)} ms`
    )
    expect(median(full)).toBeLessThan(400)
    expect(lightMs).toBeLessThan(40)
  })
})
