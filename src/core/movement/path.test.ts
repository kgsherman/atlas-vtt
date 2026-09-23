import { describe, expect, it } from "vitest"

import { buildOcclusionWorld } from "../occlusion"
import { createConnector, createDoor, createProp, createWall } from "../scene/factory"
import type { Scene, Token } from "../scene/types"
import { MoveContext } from "./context"
import { findPath, measurePath, validateMove } from "./index"
import { heuristic } from "./pathfind"
import { add, addLevel, at, flatScene, path, place, tokenAt } from "./test-utils"
import type { PathStep } from "./types"

/** A found path must start at the token, end at the target and pass validateMove. */
function expectValid(scene: Scene, token: Token, p: PathStep[] | null, target: PathStep): PathStep[] {
  expect(p).not.toBeNull()
  const route = p!
  expect(route[route.length - 1]).toEqual(target)
  const r = validateMove(scene, buildOcclusionWorld(scene), token, route, { enforceSpeed: false })
  expect(r).toMatchObject({ ok: true, legalSteps: route.length - 1 })
  return route
}

describe("findPath", () => {
  it("walks straight on open ground and returns the start alone for a no-op", () => {
    const { scene, levelId } = flatScene()
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    const route = expectValid(scene, t, path(scene, t, at(6, 1, levelId)), at(6, 1, levelId))
    expect(route).toHaveLength(6)
    expect(measurePath(scene, route)).toBe(25)
    expect(path(scene, t, at(1, 1, levelId))).toEqual([at(1, 1, levelId)])
  })

  it("goes around a wall through its gap without cutting the corner", () => {
    const { scene, levelId } = flatScene()
    // Wall on x = 25 from z = 0 to 40: the only way east is rows 8–9.
    add(scene, createWall(levelId, { x: 25, z: 0 }, { x: 25, z: 40 }))
    const t = tokenAt(scene, levelId, { i: 2, j: 2 })
    const target = at(8, 2, levelId)
    const route = expectValid(scene, t, path(scene, t, target), target)
    const crossing = route.findIndex((s, k) => k > 0 && route[k - 1].cell.i === 4 && s.cell.i === 5)
    expect(crossing).toBeGreaterThan(0)
    expect(route[crossing].cell.j).toBeGreaterThanOrEqual(8)
    // (2,2) → (4,8): 6 steps, cross: 1, (5,8) → (8,2): 6 steps.
    expect(measurePath(scene, route)).toBe(65)
  })

  it("uses an open door and is stopped by a closed one", () => {
    const { scene, levelId } = flatScene()
    const wall = add(scene, createWall(levelId, { x: 25, z: 0 }, { x: 25, z: 50 }))
    const door = add(scene, createDoor(wall, 22.5, { state: "open" }))
    const t = tokenAt(scene, levelId, { i: 2, j: 4 })
    const target = at(7, 4, levelId)
    const route = expectValid(scene, t, path(scene, t, target), target)
    expect(measurePath(scene, route)).toBe(25)
    door.state = "closed"
    expect(path(scene, t, target)).toBeNull()
  })

  it("climbs stairs through the top edge to reach the upper level", () => {
    const { scene, levelId } = flatScene()
    const upper = addLevel(scene, { elevation: 10 })
    add(scene, createConnector(levelId, upper.id, { x: 10, z: 5, w: 5, d: 20 }, 0))
    const t = tokenAt(scene, levelId, { i: 6, j: 0 })
    const target = at(2, 8, upper.id)
    const route = expectValid(scene, t, path(scene, t, target), target)
    const change = route.findIndex((s, k) => k > 0 && s.levelId !== route[k - 1].levelId)
    expect(route[change - 1]).toEqual(at(2, 4, levelId))
    expect(route[change]).toEqual(at(2, 5, upper.id))
    // And back down to the ground next to the stairs.
    place(scene, t, target)
    const down = at(3, 1, levelId)
    expectValid(scene, t, path(scene, t, down), down)
  })

  it("climbs a ladder in place", () => {
    const { scene, levelId } = flatScene()
    const upper = addLevel(scene, { elevation: 10 })
    add(scene, createConnector(levelId, upper.id, { x: 25, z: 25, w: 5, d: 5 }, 0, "ladder"))
    const t = tokenAt(scene, levelId, { i: 1, j: 5 })
    const target = at(8, 5, upper.id)
    const route = expectValid(scene, t, path(scene, t, target), target)
    expect(route).toContainEqual(at(5, 5, levelId))
    expect(route).toContainEqual(at(5, 5, upper.id))
    expect(measurePath(scene, route)).toBe(35)
  })

  it("returns null for unreachable, groundless or out-of-bounds targets and when maxSteps is too small", () => {
    const { scene, levelId } = flatScene()
    // Closed 3 × 3 room in the corner.
    add(scene, createWall(levelId, { x: 15, z: 0 }, { x: 15, z: 15 }))
    add(scene, createWall(levelId, { x: 15, z: 15 }, { x: 0, z: 15 }))
    const inside = tokenAt(scene, levelId, { i: 1, j: 1 })
    expect(path(scene, inside, at(6, 6, levelId))).toBeNull()
    const outside = tokenAt(scene, levelId, { i: 5, j: 5 })
    expect(path(scene, outside, at(1, 1, levelId))).toBeNull()
    expect(path(scene, outside, at(12, 1, levelId))).toBeNull()
    expect(path(scene, outside, at(5, 5, "nowhere"))).toBeNull()
    expect(path(scene, outside, at(9, 5, levelId), { maxSteps: 3 })).toBeNull()
    expect(path(scene, outside, at(9, 5, levelId), { maxSteps: 4 })).toHaveLength(5)
    // Node limit.
    expect(path(scene, outside, at(9, 9, levelId), { nodeLimit: 2 })).toBeNull()
  })

  it("large tokens need room: a 4 ft door stops them", () => {
    const { scene, levelId } = flatScene()
    const wall = add(scene, createWall(levelId, { x: 25, z: 0 }, { x: 25, z: 50 }))
    add(scene, createDoor(wall, 22.5, { state: "open" }))
    const big = tokenAt(scene, levelId, { i: 1, j: 4 }, { size: "large" })
    expect(path(scene, big, at(7, 4, levelId))).toBeNull()
    const medium = tokenAt(scene, levelId, { i: 1, j: 4 })
    expect(path(scene, medium, at(7, 4, levelId))).not.toBeNull()
  })

  it("is optimal under 5-10-5 (parity is part of the state)", () => {
    const { scene, levelId } = flatScene()
    scene.grid.diagonalRule = "5-10-5"
    const t = tokenAt(scene, levelId, { i: 0, j: 0 })
    const route = expectValid(scene, t, path(scene, t, at(4, 4, levelId)), at(4, 4, levelId))
    expect(measurePath(scene, route)).toBe(30)
    const r2 = expectValid(scene, t, path(scene, t, at(6, 3, levelId)), at(6, 3, levelId))
    // 3 diagonals (5 + 10 + 5) + 3 orthogonal steps.
    expect(measurePath(scene, r2)).toBe(35)
  })

  it("steps around props that block and through those that do not", () => {
    const { scene, levelId } = flatScene()
    add(scene, createProp(levelId, "crate", { x: 17.5, y: 0, z: 17.5 }))
    add(scene, createProp(levelId, "bush", { x: 17.5, y: 0, z: 22.5 }))
    const t = tokenAt(scene, levelId, { i: 1, j: 3 })
    const route = expectValid(scene, t, path(scene, t, at(5, 3, levelId)), at(5, 3, levelId))
    expect(route.some((s) => s.cell.i === 3 && s.cell.j === 3)).toBe(false)
    expect(measurePath(scene, route)).toBe(20)
  })
})

describe("heuristic", () => {
  it("never overestimates on open ground", () => {
    const { scene, levelId } = flatScene(12, 12)
    const t = tokenAt(scene, levelId, { i: 0, j: 0 })
    for (const rule of ["5-5-5", "5-10-5", "euclidean"] as const) {
      scene.grid.diagonalRule = rule
      for (const [i, j] of [
        [5, 0],
        [3, 7],
        [11, 11],
        [8, 2],
      ]) {
        const route = path(scene, t, at(i, j, levelId))!
        expect(heuristic(scene.grid, { i: 0, j: 0 }, { i, j }, 0)).toBeLessThanOrEqual(measurePath(scene, route) + 1e-9)
      }
    }
  })
})

describe("MoveContext", () => {
  it("the corner-cutting stub leaves the diagonal sweep itself free", () => {
    const { scene, levelId } = flatScene()
    add(scene, createWall(levelId, { x: 10, z: 5 }, { x: 10, z: 5.8 }))
    const ctx = new MoveContext(scene, buildOcclusionWorld(scene), { size: "medium", height: 6 })
    expect(ctx.moveBlocked(levelId, { i: 1, j: 1 }, 1, 1)).toBe(false)
    expect(ctx.moveBlocked(levelId, { i: 1, j: 1 }, 1, 0)).toBe(true)
    // Cached results are stable.
    expect(ctx.moveBlocked(levelId, { i: 1, j: 1 }, 1, 0)).toBe(true)
  })

  it("ground mask matches hasGroundAt at cell centres (floors minus cutouts, connectors)", () => {
    const { scene, levelId } = flatScene()
    const upper = addLevel(scene, { elevation: 10 })
    add(scene, createConnector(levelId, upper.id, { x: 10, z: 5, w: 5, d: 20 }, 0))
    add(scene, createConnector(levelId, upper.id, { x: 40, z: 40, w: 5, d: 5 }, 0, "ladder"))
    const ctx = new MoveContext(scene, buildOcclusionWorld(scene), { size: "medium", height: 6 })
    const mask = ctx.groundMask(upper.id)
    expect(mask[3 * 10 + 2]).toBe(0) // stairwell
    expect(mask[8 * 10 + 8]).toBe(1) // ladder cell (cut out of the floor, but a ladder)
    expect(mask[5 * 10 + 5]).toBe(1)
    // Interpolated on the run (z ∈ [5, 25), 0 → 10), level ground past its (half-open) top edge.
    expect(ctx.groundAt(levelId, { x: 12.5, z: 20 })).toBeCloseTo(7.5)
    expect(ctx.groundAt(levelId, { x: 12.5, z: 15 })).toBeCloseTo(5)
    expect(ctx.groundAt(levelId, { x: 12.5, z: 25 })).toBeCloseTo(0)
  })
})

describe("performance", () => {
  it("paths across a 100 × 100 map with scattered walls stay fast; unreachable targets are capped", () => {
    const { scene, levelId } = flatScene(100, 100)
    // Five walls across the map with 10 ft gaps alternating between x = 175 and x = 325.
    for (let r = 1; r <= 5; r++) {
      const z = r * 50
      const gap = r % 2 ? 175 : 325
      add(scene, createWall(levelId, { x: 0, z }, { x: gap - 5, z }))
      add(scene, createWall(levelId, { x: gap + 5, z }, { x: 500, z }))
    }
    for (let k = 0; k < 200; k++) {
      add(scene, createProp(levelId, "crate", { x: ((k * 97) % 100) * 5 + 2.5, y: 0, z: ((k * 53) % 100) * 5 + 2.5 }))
    }
    const world = buildOcclusionWorld(scene)
    const t = tokenAt(scene, levelId, { i: 50, j: 2 })
    let t0 = performance.now()
    const route = findPath(scene, world, t, at(50, 57, levelId))
    const reachMs = performance.now() - t0
    expect(route).not.toBeNull()
    expect(validateMove(scene, world, t, route!, { enforceSpeed: false }).ok).toBe(true)
    // Unreachable: a closed cell far away.
    add(scene, createWall(levelId, { x: 400, z: 400 }, { x: 405, z: 400 }))
    add(scene, createWall(levelId, { x: 405, z: 400 }, { x: 405, z: 405 }))
    add(scene, createWall(levelId, { x: 405, z: 405 }, { x: 400, z: 405 }))
    add(scene, createWall(levelId, { x: 400, z: 405 }, { x: 400, z: 400 }))
    const world2 = buildOcclusionWorld(scene)
    t0 = performance.now()
    expect(findPath(scene, world2, t, at(80, 80, levelId))).toBeNull()
    const capMs = performance.now() - t0
    console.log(`findPath 100×100: reachable ${reachMs.toFixed(1)} ms (${route!.length} steps), capped search ${capMs.toFixed(1)} ms`)
    expect(reachMs).toBeLessThan(1000)
    expect(capMs).toBeLessThan(3000)
  })

  it("an unreachable target on a 200 × 200 map stops at the node limit", () => {
    const { scene, levelId } = flatScene(200, 200)
    for (let k = 0; k < 400; k++) {
      add(scene, createProp(levelId, "barrel", { x: ((k * 131) % 200) * 5 + 2.5, y: 0, z: ((k * 71) % 200) * 5 + 2.5 }))
    }
    // Enclosed cell (150, 150).
    add(scene, createWall(levelId, { x: 750, z: 750 }, { x: 755, z: 750 }))
    add(scene, createWall(levelId, { x: 755, z: 750 }, { x: 755, z: 755 }))
    add(scene, createWall(levelId, { x: 755, z: 755 }, { x: 750, z: 755 }))
    add(scene, createWall(levelId, { x: 750, z: 755 }, { x: 750, z: 750 }))
    const world = buildOcclusionWorld(scene)
    const t = tokenAt(scene, levelId, { i: 100, j: 100 })
    const t0 = performance.now()
    expect(findPath(scene, world, t, at(150, 150, levelId))).toBeNull()
    const ms = performance.now() - t0
    console.log(`findPath 200×200 unreachable (20k node cap): ${ms.toFixed(1)} ms`)
    expect(ms).toBeLessThan(3000)
  })
})
