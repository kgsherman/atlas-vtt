/**
 * Randomised cross-check of the accelerated world (grid DDA + Y culling + mailboxing) against a
 * brute-force loop over every primitive, and the query benchmark from the module brief:
 * a 60×60-cell scene with ~300 primitives and 100k random segment queries (target < 1 s).
 */
import { describe, expect, it } from "vitest"

import { createDoor, createPillar, createProp, createWall, createWindow } from "../scene/factory"
import type { PropKind, Scene, Vec3 } from "../scene/types"
import { buildOcclusionWorld } from "./index"
import { segmentEntry } from "./primitives"
import { add, flatScene, paintHeightmap, rng } from "./test-utils"
import type { BlockChannel, OcclusionWorld } from "./types"

const PROPS: PropKind[] = ["crate", "barrel", "tree", "bush", "table", "statue", "rock", "bookshelf"]

function randomScene(seed: number, cells: number, walls: number, pillars: number, props: number, terrain: boolean): Scene {
  const r = rng(seed)
  const { scene, levelId } = flatScene(cells, cells)
  const extent = cells * 5
  if (terrain) paintHeightmap(scene, levelId, (x, z) => 3 * Math.sin(x / 17) * Math.cos(z / 23) + 1.5, 2)
  for (let k = 0; k < walls; k++) {
    const a = { x: r() * extent, z: r() * extent }
    // Mostly grid-aligned walls, some diagonal.
    const len = 5 + r() * 25
    const ang = r() < 0.7 ? (Math.floor(r() * 4) * Math.PI) / 2 : r() * Math.PI * 2
    const b = { x: a.x + Math.cos(ang) * len, z: a.z + Math.sin(ang) * len }
    const wall = add(scene, createWall(levelId, a, b, { height: r() < 0.2 ? 3 : 10, followTerrain: true }))
    const roll = r()
    if (len > 10 && roll < 0.3) add(scene, createDoor(wall, len / 2, { state: r() < 0.5 ? "open" : "closed" }))
    else if (len > 10 && roll < 0.5) add(scene, createWindow(wall, len / 2))
  }
  for (let k = 0; k < pillars; k++) {
    add(scene, createPillar(levelId, { x: r() * extent, z: r() * extent }, { shape: r() < 0.5 ? "round" : "square", size: 1 + r() * 2 }))
  }
  for (let k = 0; k < props; k++) {
    add(
      scene,
      createProp(levelId, PROPS[Math.floor(r() * PROPS.length)], { x: r() * extent, y: 0, z: r() * extent }, { rotationY: r() * Math.PI * 2 })
    )
  }
  return scene
}

function bruteBlocked(world: OcclusionWorld, a: Vec3, b: Vec3, channel: BlockChannel): number | null {
  let best: number | null = null
  for (const p of world.primitives) {
    if (!p.blocks[channel]) continue
    const t = segmentEntry(p, a, b)
    if (t !== null && (best === null || t < best)) best = t
  }
  return best
}

function randomSegments(seed: number, n: number, extent: number, maxLen: number): Float64Array {
  const r = rng(seed)
  const out = new Float64Array(n * 6)
  for (let k = 0; k < n; k++) {
    const ax = r() * extent
    const az = r() * extent
    const ang = r() * Math.PI * 2
    const len = r() * maxLen
    out.set([ax, 0.25 + r() * 12, az, ax + Math.cos(ang) * len, 0.25 + r() * 8, az + Math.sin(ang) * len], k * 6)
  }
  return out
}

describe("accelerated queries match brute force", () => {
  for (const terrain of [false, true]) {
    it(`random scenes (${terrain ? "terrain" : "flat"})`, () => {
      const scene = randomScene(terrain ? 11 : 7, 24, 40, 20, 30, terrain)
      const world = buildOcclusionWorld(scene)
      const segs = randomSegments(3, 3000, 120, 80)
      const channels: BlockChannel[] = ["sight", "light", "movement"]
      let hits = 0
      for (let k = 0; k < 3000; k++) {
        const a = { x: segs[k * 6], y: segs[k * 6 + 1], z: segs[k * 6 + 2] }
        const b = { x: segs[k * 6 + 3], y: segs[k * 6 + 4], z: segs[k * 6 + 5] }
        const channel = channels[k % 3]
        const brute = bruteBlocked(world, a, b, channel)
        expect(world.segmentBlocked(a, b, { channel })).toBe(brute !== null)
        const hit = world.raycast(a, b, { channel })
        if (brute === null) expect(hit).toBeNull()
        else {
          hits++
          expect(hit).not.toBeNull()
          expect(hit!.t).toBeCloseTo(brute, 9)
        }
      }
      expect(hits).toBeGreaterThan(300)
    })
  }
})

/** 100k random sight queries of length ≤ maxLen over a 300 ft square. */
function runQueries(world: OcclusionWorld, maxLen: number): { ms: number; blocked: number } {
  const n = 100_000
  const segs = randomSegments(5, n, 300, maxLen)
  const a = { x: 0, y: 0, z: 0 }
  const b = { x: 0, y: 0, z: 0 }
  const opts = { channel: "sight" as const }
  let blockedCount = 0
  const start = performance.now()
  for (let k = 0; k < n; k++) {
    a.x = segs[k * 6]
    a.y = segs[k * 6 + 1]
    a.z = segs[k * 6 + 2]
    b.x = segs[k * 6 + 3]
    b.y = segs[k * 6 + 4]
    b.z = segs[k * 6 + 5]
    if (world.segmentBlocked(a, b, opts)) blockedCount++
  }
  return { ms: performance.now() - start, blocked: blockedCount }
}

/** Flat-scene budgets (ms) of the 100k-query benchmark; terrain with follow-terrain walls gets 1.5×. */
const FLAT_BUDGET = { vision: 1000, fullMap: 2000 }

describe("performance", () => {
  it("100k random segment queries on a 60×60 scene with ~300 primitives", () => {
    const scene = randomScene(42, 60, 85, 50, 70, false)
    const t0 = performance.now()
    const world = buildOcclusionWorld(scene)
    const buildMs = performance.now() - t0
    const count = world.primitives.length
    expect(count).toBeGreaterThan(250)
    expect(count).toBeLessThan(400)

    runQueries(world, 60) // warm-up (JIT)
    const vision = runQueries(world, 60)
    const fullMap = runQueries(world, 425)
    console.log(
      `[occlusion perf] ${count} primitives, build ${buildMs.toFixed(1)} ms; 100k segments ≤ 60 ft: ${vision.ms.toFixed(0)} ms ` +
        `(${vision.blocked} blocked); 100k segments ≤ 425 ft: ${fullMap.ms.toFixed(0)} ms (${fullMap.blocked} blocked)`
    )
    expect(vision.ms).toBeLessThan(FLAT_BUDGET.vision)
    expect(fullMap.ms).toBeLessThan(FLAT_BUDGET.fullMap)
  })

  it("the same scene on terrain with follow-terrain walls (strips) stays within 1.5× the flat budgets", () => {
    const flatWorld = buildOcclusionWorld(randomScene(42, 60, 85, 50, 70, false))
    const scene = randomScene(42, 60, 85, 50, 70, true)
    const t0 = performance.now()
    const world = buildOcclusionWorld(scene)
    const buildMs = performance.now() - t0
    const strips = world.primitives.filter((p) => p.shape === "strip").length
    expect(strips).toBeGreaterThan(60)

    runQueries(world, 60) // warm-up (JIT)
    runQueries(flatWorld, 60)
    const flat = runQueries(flatWorld, 60)
    const vision = runQueries(world, 60)
    const fullMap = runQueries(world, 425)
    console.log(
      `[occlusion perf] terrain + follow walls: ${world.primitives.length} primitives (${strips} strips), build ${buildMs.toFixed(1)} ms; ` +
        `100k segments ≤ 60 ft: ${vision.ms.toFixed(0)} ms (flat scene ${flat.ms.toFixed(0)} ms); ≤ 425 ft: ${fullMap.ms.toFixed(0)} ms`
    )
    expect(vision.ms).toBeLessThan(1.5 * FLAT_BUDGET.vision)
    expect(fullMap.ms).toBeLessThan(1.5 * FLAT_BUDGET.fullMap)
  })

  it("large scene: 200×200 cells, resolution-4 terrain, ~5k objects", () => {
    const r = rng(99)
    const { scene, levelId } = flatScene(200, 200)
    paintHeightmap(scene, levelId, (x, z) => 4 * Math.sin(x / 40) * Math.cos(z / 55), 4)
    for (let k = 0; k < 3000; k++) {
      const a = { x: r() * 1000, z: r() * 1000 }
      const ang = (Math.floor(r() * 4) * Math.PI) / 2
      const w = add(scene, createWall(levelId, a, { x: a.x + Math.cos(ang) * 10, z: a.z + Math.sin(ang) * 10 }))
      if (k % 5 === 0) add(scene, createDoor(w, 5))
    }
    for (let k = 0; k < 1500; k++) {
      add(scene, createProp(levelId, PROPS[k % PROPS.length], { x: r() * 1000, y: 0, z: r() * 1000 }, { rotationY: r() * 6 }))
    }
    let t = performance.now()
    const world = buildOcclusionWorld(scene)
    const buildMs = performance.now() - t

    // Door toggles (median of 9; scenes prepared outside the timed region).
    const door = Object.values(scene.objects).find((o) => o.type === "door")!
    if (door.type !== "door") throw new Error("expected a door")
    const openScene = { ...scene, objects: { ...scene.objects, [door.id]: { ...door, state: "open" as const } } }
    const toggles: number[] = []
    for (let k = 0; k < 9; k++) {
      t = performance.now()
      world.update(k % 2 === 0 ? openScene : scene, [door.id])
      toggles.push(performance.now() - t)
    }
    const toggleMs = toggles.sort((a, b) => a - b)[4]

    // Terrain brush commit over a 20×20 ft rect.
    const rect = { x: 490, z: 490, w: 20, d: 20 }
    const edited = { ...scene, levels: { ...scene.levels } }
    paintHeightmap(edited, levelId, (x, z) => 4 * Math.sin(x / 40) * Math.cos(z / 55) + (x >= 490 && x <= 510 && z >= 490 && z <= 510 ? 2 : 0), 4)
    t = performance.now()
    const dirty = world.updateTerrain(edited, levelId, rect)
    const terrainMs = performance.now() - t

    const n = 20_000
    const segs = randomSegments(8, n, 1000, 60)
    t = performance.now()
    for (let k = 0; k < n; k++) {
      world.segmentBlocked(
        { x: segs[k * 6], y: segs[k * 6 + 1] + 4, z: segs[k * 6 + 2] },
        { x: segs[k * 6 + 3], y: segs[k * 6 + 4] + 4, z: segs[k * 6 + 5] },
        { channel: "sight" }
      )
    }
    const queryMs = performance.now() - t
    console.log(
      `[occlusion perf] large scene (${world.primitives.length} primitives): build ${buildMs.toFixed(0)} ms, door toggle ` +
        `${toggleMs.toFixed(2)} ms, terrain edit ${terrainMs.toFixed(0)} ms (${dirty.length} dirty regions), 20k segments ${queryMs.toFixed(0)} ms`
    )
    expect(dirty.length).toBeGreaterThan(0)
    expect(buildMs).toBeLessThan(5000)
  })

  it("heightfield terrain queries stay fast", () => {
    const scene = randomScene(43, 60, 60, 20, 40, true)
    const world = buildOcclusionWorld(scene)
    const n = 100_000
    const segs = randomSegments(6, n, 300, 60)
    const opts = { channel: "sight" as const }
    const start = performance.now()
    let blockedCount = 0
    for (let k = 0; k < n; k++) {
      const a = { x: segs[k * 6], y: segs[k * 6 + 1] + 5, z: segs[k * 6 + 2] }
      const b = { x: segs[k * 6 + 3], y: segs[k * 6 + 4] + 5, z: segs[k * 6 + 5] }
      if (world.segmentBlocked(a, b, opts)) blockedCount++
    }
    const ms = performance.now() - start
    console.log(`[occlusion perf] terrain scene (${world.primitives.length} primitives): 100k segments ≤ 60 ft: ${ms.toFixed(0)} ms (${blockedCount} blocked)`)
    expect(ms).toBeLessThan(2000)
  })
})
