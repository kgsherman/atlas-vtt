import { describe, expect, it } from "vitest"

import { buildOcclusionWorld } from "../occlusion"
import { createConnector, createProp, createWall } from "../scene/factory"
import { checkEnd, checkJump, smoothPath } from "./index"
import { add, addLevel, at, flatScene, path, tokenAt, walk } from "./test-utils"

describe("checkEnd (gridless end points)", () => {
  it("accepts a point in the last anchor's cell reachable by a clear sweep", () => {
    const { scene, levelId } = flatScene()
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    const world = buildOcclusionWorld(scene)
    expect(checkEnd(scene, world, t, at(3, 1, levelId), { x: 17.5, z: 7.5 }, { x: 16, z: 8.9 })).toBeNull()
  })

  it("refuses points outside the last anchor's cell, off the floor or behind a wall", () => {
    const { scene, levelId } = flatScene()
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    add(scene, createWall(levelId, { x: 20, z: 0 }, { x: 20, z: 50 }))
    const world = buildOcclusionWorld(scene)
    const from = { x: 17.5, z: 7.5 }
    expect(checkEnd(scene, world, t, at(3, 1, levelId), from, { x: 22.6, z: 7.5 })).toBe("not-adjacent")
    expect(checkEnd(scene, world, t, at(3, 1, levelId), from, { x: 19.9, z: 7.5 })).toBe("blocked")
    expect(checkEnd(scene, world, t, at(3, 1, levelId), from, { x: Number.NaN, z: 7.5 })).toBe("out-of-bounds")
    const bare = addLevel(scene, { elevation: 10 }, false)
    expect(checkEnd(scene, world, t, at(3, 1, bare.id), from, { x: 17, z: 7 })).toBe("no-ground")
  })
})

describe("checkJump", () => {
  it("allows any grounded free spot, even behind walls", () => {
    const { scene, levelId } = flatScene()
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    add(scene, createWall(levelId, { x: 20, z: 0 }, { x: 20, z: 50 }))
    const world = buildOcclusionWorld(scene)
    expect(checkJump(scene, world, t, levelId, { x: 33.3, z: 21.1 })).toBeNull()
  })

  it("refuses spots in a blocker, off the grid, off the floor or on an unknown level", () => {
    const { scene, levelId } = flatScene()
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    add(scene, createWall(levelId, { x: 20, z: 0 }, { x: 20, z: 50 }))
    add(scene, createProp(levelId, "crate", { x: 35, y: 0, z: 35 }))
    const world = buildOcclusionWorld(scene)
    expect(checkJump(scene, world, t, levelId, { x: 20.5, z: 12 })).toBe("blocked")
    expect(checkJump(scene, world, t, levelId, { x: 35, z: 35 })).toBe("blocked")
    expect(checkJump(scene, world, t, levelId, { x: -3, z: 12 })).toBe("out-of-bounds")
    expect(checkJump(scene, world, t, "nope", { x: 12, z: 12 })).toBe("no-ground")
    const bare = addLevel(scene, { elevation: 10 }, false)
    expect(checkJump(scene, buildOcclusionWorld(scene), t, bare.id, { x: 12, z: 12 })).toBe("no-ground")
  })
})

describe("smoothPath", () => {
  it("pulls a staircase of grid steps into a straight line in the open", () => {
    const { scene, levelId } = flatScene()
    const t = tokenAt(scene, levelId, { i: 0, j: 0 })
    const steps = walk(levelId, [
      [0, 0],
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 2],
    ])
    const pts = smoothPath(scene, buildOcclusionWorld(scene), t, steps, { x: 23, z: 13 })
    expect(pts.map((p) => p.position)).toEqual([
      { x: 2.5, z: 2.5 },
      { x: 23, z: 13 },
    ])
  })

  it("keeps the corner where a wall is in the way", () => {
    const { scene, levelId } = flatScene()
    // A wall from (10, 0) to (10, 30): the path goes down, around its end, and back up.
    add(scene, createWall(levelId, { x: 10, z: 0 }, { x: 10, z: 30 }))
    const t = tokenAt(scene, levelId, { i: 0, j: 0 })
    const steps = path(scene, t, at(3, 0, levelId))!
    expect(steps).not.toBeNull()
    const pts = smoothPath(scene, buildOcclusionWorld(scene), t, steps)
    expect(pts.length).toBeGreaterThan(2)
    expect(pts.length).toBeLessThan(steps.length)
    expect(pts[pts.length - 1].position).toEqual({ x: 17.5, z: 2.5 })
  })

  it("does not cut across stairs", () => {
    const { scene, levelId } = flatScene()
    const upper = addLevel(scene, { elevation: 10 })
    add(scene, createConnector(levelId, upper.id, { x: 10, z: 10, w: 10, d: 15 }, 0))
    const t = tokenAt(scene, levelId, { i: 0, j: 3 })
    const steps = walk(levelId, [
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
      [4, 3],
      [5, 3],
    ])
    const pts = smoothPath(scene, buildOcclusionWorld(scene), t, steps)
    // The points on the run's cells are kept.
    expect(pts.map((p) => p.position.x)).toEqual(expect.arrayContaining([12.5, 17.5]))
  })

  it("starts at the token's own position and keeps level switches", () => {
    const { scene, levelId } = flatScene()
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    t.position = { x: 8, z: 9 }
    const pts = smoothPath(scene, buildOcclusionWorld(scene), t, [at(1, 1, levelId), at(2, 1, levelId)])
    expect(pts[0].position).toEqual({ x: 8, z: 9 })
    expect(smoothPath(scene, buildOcclusionWorld(scene), t, [])).toEqual([])
  })
})
