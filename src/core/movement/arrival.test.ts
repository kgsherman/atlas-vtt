import { describe, expect, it } from "vitest"

import { buildOcclusionWorld } from "../occlusion"
import { createFloor, createProp, createScene, createWall } from "../scene/factory"
import type { Cell, Scene } from "../scene/types"
import { arrivalAnchors, arrivalOrder } from "./arrival"
import { add, flatScene, tokenAt } from "./test-utils"

const arriving = (id: string, size: "small" | "medium" | "large" | "tiny" = "medium", hidden = false) => ({
  id,
  size,
  height: size === "large" ? 8 : 5.5,
  hidden,
})

function place(scene: Scene, tokens: ReturnType<typeof arriving>[], at: { levelId: string; x: number; z: number }, standing: Scene["tokens"][string][] = []) {
  return arrivalAnchors(scene, buildOcclusionWorld(scene), tokens, at, { standing })
}

/** Every square a placed k × k footprint covers. */
function squares(anchors: Map<string, Cell>, k: Record<string, number>): string[] {
  const out: string[] = []
  for (const [id, a] of anchors) for (let j = 0; j < (k[id] ?? 1); j++) for (let i = 0; i < (k[id] ?? 1); i++) out.push(`${a.i + i},${a.j + j}`)
  return out
}

describe("arrivalAnchors", () => {
  it("puts the first arrival on the arrival square and packs the others around it without overlap", () => {
    const { scene, levelId } = flatScene(10, 10)
    const tokens = [arriving("a"), arriving("b"), arriving("c"), arriving("d")]
    const out = place(scene, tokens, { levelId, x: 22.5, z: 22.5 })
    expect(out.size).toBe(4)
    expect(out.get("a")).toEqual({ i: 4, j: 4 })
    const sq = squares(out, {})
    expect(new Set(sq).size).toBe(sq.length)
    for (const a of out.values()) expect(Math.max(Math.abs(a.i - 4), Math.abs(a.j - 4))).toBeLessThanOrEqual(1)
  })

  it("places large creatures first, never overlapping anything, and hidden ones last", () => {
    const { scene, levelId } = flatScene(10, 10)
    const tokens = [arriving("a"), arriving("ogre", "large"), arriving("imp", "tiny", true), arriving("b", "small")]
    expect(arrivalOrder(tokens).map((t) => t.id)).toEqual(["ogre", "a", "b", "imp"])
    const out = place(scene, tokens, { levelId, x: 25, z: 25 })
    expect(out.size).toBe(4)
    const sq = squares(out, { ogre: 2 })
    expect(new Set(sq).size).toBe(sq.length)
  })

  it("stays on the arrival's side of a wall and never lands in a crate", () => {
    const { scene, levelId } = flatScene(10, 10)
    add(scene, createWall(levelId, { x: 15, z: 0 }, { x: 15, z: 50 }, { height: 10 }))
    add(scene, createProp(levelId, "crate", { x: 7.5, y: 0, z: 22.5 }))
    const tokens = ["a", "b", "c", "d", "e", "f"].map((id) => arriving(id))
    const out = place(scene, tokens, { levelId, x: 7.5, z: 22.5 })
    expect(out.size).toBe(6)
    for (const a of out.values()) {
      expect(a.i).toBeLessThan(3)
      expect(a).not.toEqual({ i: 1, j: 4 })
    }
  })

  it("avoids the squares of visible tokens standing there, not of hidden ones", () => {
    const { scene, levelId } = flatScene(10, 10)
    const guard = tokenAt(scene, levelId, { i: 4, j: 4 })
    const spy = tokenAt(scene, levelId, { i: 5, j: 4 }, { hidden: true })
    const out = place(scene, [arriving("a"), arriving("b")], { levelId, x: 22.5, z: 22.5 }, [guard, spy])
    expect(out.get("a")).not.toEqual({ i: 4, j: 4 })
    expect([...out.values()].some((a) => a.i === 5 && a.j === 4)).toBe(true)
  })

  it("is deterministic", () => {
    const { scene, levelId } = flatScene(12, 12)
    add(scene, createWall(levelId, { x: 0, z: 30 }, { x: 40, z: 30 }))
    const tokens = ["e", "a", "d", "b", "c"].map((id) => arriving(id))
    const a = place(scene, tokens, { levelId, x: 21, z: 27 })
    const b = place(scene, [...tokens].reverse(), { levelId, x: 21, z: 27 })
    expect([...b.entries()].sort()).toEqual([...a.entries()].sort())
  })

  it("leaves out tokens with no room anywhere, and uses the rest of the level when the arrival's room is full", () => {
    const scene = createScene({ width: 10, depth: 10, groundFloor: false })
    const levelId = Object.keys(scene.levels)[0]
    // A 1 × 1 closet with a 2 × 2 room elsewhere, not connected.
    add(scene, createFloor(levelId, { x: 0, z: 0, w: 5, d: 5 }))
    add(scene, createFloor(levelId, { x: 25, z: 25, w: 10, d: 10 }))
    const out = place(
      scene,
      ["a", "b", "c", "d", "e", "f"].map((id) => arriving(id)),
      { levelId, x: 2.5, z: 2.5 }
    )
    expect(out.get("a")).toEqual({ i: 0, j: 0 })
    expect(out.size).toBe(5)
    for (const [id, a] of out) if (id !== "a") expect(a.i >= 5 && a.j >= 5).toBe(true)
  })

  it("places nobody on an unknown level", () => {
    const { scene } = flatScene(5, 5)
    expect(place(scene, [arriving("a")], { levelId: "nope", x: 2.5, z: 2.5 }).size).toBe(0)
  })
})
