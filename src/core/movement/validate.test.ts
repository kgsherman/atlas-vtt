import { describe, expect, it } from "vitest"

import { buildOcclusionWorld } from "../occlusion"
import { createConnector, createDoor, createFloor, createPillar, createProp, createWall, createWindow } from "../scene/factory"
import type { Scene, Token } from "../scene/types"
import { anchorPosition, footprintCells, measurePath, tokenAnchor, validateMove } from "./index"
import { add, addLevel, at, check, flatScene, paintHeightmap, path, place, stepResult, tokenAt, walk } from "./test-utils"

describe("footprints and anchors", () => {
  it("footprint side in cells is max(1, SIZE_FOOTPRINT)", () => {
    expect(footprintCells("tiny")).toBe(1)
    expect(footprintCells("small")).toBe(1)
    expect(footprintCells("medium")).toBe(1)
    expect(footprintCells("large")).toBe(2)
    expect(footprintCells("huge")).toBe(3)
    expect(footprintCells("gargantuan")).toBe(4)
  })

  it("medium tokens anchor on the cell they centre in, large tokens on cell corners", () => {
    const { scene } = flatScene()
    expect(tokenAnchor(scene, { position: { x: 7.5, z: 12.5 }, size: "medium" })).toEqual({ i: 1, j: 2 })
    expect(tokenAnchor(scene, { position: { x: 10, z: 10 }, size: "large" })).toEqual({ i: 1, j: 1 })
    expect(tokenAnchor(scene, { position: { x: 7.5, z: 7.5 }, size: "huge" })).toEqual({ i: 0, j: 0 })
    expect(tokenAnchor(scene, { position: { x: 7.5, z: 7.5 }, size: "tiny" })).toEqual({ i: 1, j: 1 })
    // Freely placed tokens snap to the nearest anchor; no −0.
    expect(tokenAnchor(scene, { position: { x: 8.9, z: 6.1 }, size: "medium" })).toEqual({ i: 1, j: 1 })
    const a = tokenAnchor(scene, { position: { x: 2.5, z: 2.5 }, size: "medium" })
    expect(Object.is(a.i, 0) && Object.is(a.j, 0)).toBe(true)
  })

  it("anchorPosition is the footprint centre and round-trips through tokenAnchor", () => {
    const { scene } = flatScene()
    expect(anchorPosition(scene, "medium", { i: 1, j: 2 })).toEqual({ x: 7.5, z: 12.5 })
    expect(anchorPosition(scene, "large", { i: 1, j: 1 })).toEqual({ x: 10, z: 10 })
    expect(anchorPosition(scene, "gargantuan", { i: 0, j: 0 })).toEqual({ x: 10, z: 10 })
    for (const size of ["tiny", "small", "medium", "large", "huge", "gargantuan"] as const) {
      const anchor = { i: 3, j: 4 }
      expect(tokenAnchor(scene, { position: anchorPosition(scene, size, anchor), size })).toEqual(anchor)
    }
  })
})

describe("path shape", () => {
  it("rejects empty, too long and mis-started paths; accepts a start-only path", () => {
    const { scene, levelId } = flatScene()
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    expect(check(scene, t, [])).toMatchObject({ ok: false, reason: "empty-path", legalSteps: 0 })
    const long = walk(levelId, [
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
    ])
    expect(check(scene, t, long, { maxSteps: 2 })).toMatchObject({ ok: false, reason: "path-too-long", legalSteps: 0 })
    expect(check(scene, t, long, { maxSteps: 3 }).ok).toBe(true)
    const tooLong = Array.from({ length: 258 }, (_, k) => at(1 + (k % 2), 1, levelId))
    expect(check(scene, t, tooLong).reason).toBe("path-too-long")
    expect(check(scene, t, [at(2, 1, levelId), at(3, 1, levelId)]).reason).toBe("path-start-mismatch")
    expect(check(scene, t, [at(1, 1, "other"), at(2, 1, "other")]).reason).toBe("path-start-mismatch")
    expect(check(scene, t, [at(1, 1, levelId)])).toEqual({ ok: true, legalSteps: 0, distance: 0 })
  })

  it("steps must be 8-neighbours on the same level", () => {
    const { scene, levelId } = flatScene()
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    expect(stepResult(scene, t, at(1, 1, levelId), at(3, 1, levelId))).toBe("not-adjacent")
    expect(stepResult(scene, t, at(1, 1, levelId), at(1, 1, levelId))).toBe("not-adjacent")
    expect(stepResult(scene, t, at(1, 1, levelId), at(2, 2, levelId))).toBe("ok")
    expect(stepResult(scene, t, at(1, 1, levelId), at(1.5, 1, levelId))).toBe("out-of-bounds")
  })

  it("the whole footprint must stay inside the grid", () => {
    const { scene, levelId } = flatScene(10, 10)
    const m = tokenAt(scene, levelId, { i: 0, j: 0 })
    expect(stepResult(scene, m, at(0, 0, levelId), at(-1, 0, levelId))).toBe("out-of-bounds")
    const l = tokenAt(scene, levelId, { i: 7, j: 7 }, { size: "large" })
    expect(stepResult(scene, l, at(7, 7, levelId), at(8, 7, levelId))).toBe("ok")
    expect(stepResult(scene, l, at(8, 7, levelId), at(9, 7, levelId))).toBe("out-of-bounds")
  })

  it("returns the legal prefix and the index of the first illegal step", () => {
    const { scene, levelId } = flatScene()
    add(scene, createWall(levelId, { x: 20, z: 0 }, { x: 20, z: 50 }))
    const t = tokenAt(scene, levelId, { i: 0, j: 3 })
    const r = check(
      scene,
      t,
      walk(levelId, [
        [0, 3],
        [1, 3],
        [2, 3],
        [3, 3],
        [4, 3],
        [5, 3],
      ])
    )
    expect(r).toEqual({ ok: false, legalSteps: 3, distance: 15, reason: "blocked", failedAt: 4 })
  })
})

describe("walls, doors and windows", () => {
  // Wall on the grid line x = 10 between columns 1 and 2; openings centred on row 3 (z = 17.5).
  function wallScene() {
    const { scene, levelId } = flatScene()
    const wall = add(scene, createWall(levelId, { x: 10, z: 0 }, { x: 10, z: 50 }))
    return { scene, levelId, wall }
  }

  it("a wall blocks crossing but not walking alongside it", () => {
    const { scene, levelId } = wallScene()
    const t = tokenAt(scene, levelId, { i: 1, j: 3 })
    expect(stepResult(scene, t, at(1, 3, levelId), at(2, 3, levelId))).toBe("blocked")
    expect(stepResult(scene, t, at(1, 3, levelId), at(1, 4, levelId))).toBe("ok")
    expect(stepResult(scene, t, at(2, 3, levelId), at(2, 4, levelId))).toBe("ok")
  })

  it("an open 4 ft door lets a medium token through; closed and locked doors block", () => {
    const { scene, levelId, wall } = wallScene()
    const door = add(scene, createDoor(wall, 17.5, { width: 4, height: 7, state: "open" }))
    const t = tokenAt(scene, levelId, { i: 1, j: 3 })
    expect(stepResult(scene, t, at(1, 3, levelId), at(2, 3, levelId))).toBe("ok")
    expect(stepResult(scene, t, at(2, 3, levelId), at(1, 3, levelId))).toBe("ok")
    // Not through the jamb next to the door.
    expect(stepResult(scene, t, at(1, 4, levelId), at(2, 4, levelId))).toBe("blocked")
    for (const state of ["closed", "locked"] as const) {
      door.state = state
      expect(stepResult(scene, t, at(1, 3, levelId), at(2, 3, levelId))).toBe("blocked")
    }
    // A closed portcullis does not block sight but does block movement.
    door.state = "closed"
    door.style = "portcullis"
    expect(stepResult(scene, t, at(1, 3, levelId), at(2, 3, levelId))).toBe("blocked")
  })

  it("windows block movement through the whole opening", () => {
    const { scene, levelId, wall } = wallScene()
    add(scene, createWindow(wall, 17.5, { width: 3 }))
    add(scene, createWindow(wall, 27.5, { width: 5, sillHeight: 0.2 }))
    const t = tokenAt(scene, levelId, { i: 1, j: 3 })
    expect(stepResult(scene, t, at(1, 3, levelId), at(2, 3, levelId))).toBe("blocked")
    expect(stepResult(scene, t, at(1, 5, levelId), at(2, 5, levelId))).toBe("blocked")
  })

  it("lintels let medium tokens pass but not a 10 ft tall one", () => {
    const { scene, levelId, wall } = wallScene()
    add(scene, createDoor(wall, 17.5, { width: 4, height: 7, state: "open" }))
    const tall = tokenAt(scene, levelId, { i: 1, j: 3 }, { height: 10 })
    expect(stepResult(scene, tall, at(1, 3, levelId), at(2, 3, levelId))).toBe("blocked")
    // Exactly door height: touching the lintel is not overlapping it.
    const seven = tokenAt(scene, levelId, { i: 1, j: 3 }, { height: 7 })
    expect(stepResult(scene, seven, at(1, 3, levelId), at(2, 3, levelId))).toBe("ok")
  })

  it("a large token cannot fit a 4 ft door but passes a 10 ft wide, full-height opening", () => {
    const { scene, levelId } = flatScene()
    const wall = add(scene, createWall(levelId, { x: 20, z: 0 }, { x: 20, z: 50 }))
    // Large token on cells i 2–3, j 1–2 (centre (15, 10)); the door is centred on z = 10.
    const big = tokenAt(scene, levelId, { i: 2, j: 1 }, { size: "large" })
    expect(big.position).toEqual({ x: 15, z: 10 })
    const narrow = add(scene, createDoor(wall, 10, { width: 4, height: 10, state: "open" }))
    expect(stepResult(scene, big, at(2, 1, levelId), at(3, 1, levelId))).toBe("blocked")
    narrow.width = 10
    expect(stepResult(scene, big, at(2, 1, levelId), at(3, 1, levelId))).toBe("ok")
    // Same opening with a 7 ft lintel: the large token is 10 ft tall.
    narrow.height = 7
    expect(stepResult(scene, big, at(2, 1, levelId), at(3, 1, levelId))).toBe("blocked")
    // A medium token fits the 4 ft door.
    narrow.width = 4
    const m = tokenAt(scene, levelId, { i: 3, j: 1 })
    expect(stepResult(scene, m, at(3, 1, levelId), at(4, 1, levelId))).toBe("blocked") // jamb (door spans z 8–12)
    add(scene, createDoor(wall, 17.5, { width: 4, height: 7, state: "open" }))
    expect(stepResult(scene, m, at(3, 3, levelId), at(4, 3, levelId))).toBe("ok")
  })

  it("open doors in rotated walls (battlemap buildings) let a token through the doorway, not beside it", () => {
    const { scene, levelId } = flatScene(20, 20)
    // A 38° wall through the centre of cell (10, 10) with a 4 ft door centred there.
    const u = { x: Math.cos((38 * Math.PI) / 180), z: Math.sin((38 * Math.PI) / 180) }
    const c = { x: 52.5, z: 52.5 }
    const wall = add(scene, createWall(levelId, { x: c.x - 40 * u.x, z: c.z - 40 * u.z }, { x: c.x + 40 * u.x, z: c.z + 40 * u.z }, { thickness: 0.75 }))
    const door = add(scene, createDoor(wall, 40, { width: 4, height: 7, state: "open" }))
    const t = tokenAt(scene, levelId, { i: 12, j: 8 })
    // Straight across (the diagonal nearest the wall's normal), and back.
    const across: [number, number][] = [
      [12, 8],
      [11, 9],
      [10, 10],
      [9, 11],
      [8, 12],
    ]
    expect(check(scene, t, walk(levelId, across))).toMatchObject({ ok: true, legalSteps: 4 })
    place(scene, t, at(8, 12, levelId))
    expect(check(scene, t, walk(levelId, [...across].reverse())).ok).toBe(true)
    place(scene, t, at(12, 8, levelId))
    expect(path(scene, t, at(8, 12, levelId), { maxSteps: 6 })).not.toBeNull()
    // One cell further along the wall (7 ft from the door's centre) the wall blocks.
    const beside = walk(levelId, [
      [13, 9],
      [12, 10],
      [11, 11],
      [10, 12],
    ])
    place(scene, t, at(13, 9, levelId))
    expect(check(scene, t, beside)).toMatchObject({ ok: false, legalSteps: 1 })
    // Closed, narrower than the token, too low, or a large token: blocked.
    place(scene, t, at(12, 8, levelId))
    door.state = "closed"
    expect(check(scene, t, walk(levelId, across)).ok).toBe(false)
    door.state = "open"
    door.width = 3
    expect(check(scene, t, walk(levelId, across)).ok).toBe(false)
    door.width = 4
    const tall = tokenAt(scene, levelId, { i: 12, j: 8 }, { height: 10 })
    expect(check(scene, tall, walk(levelId, across)).ok).toBe(false)
    // A large (10 ft tall) token needs a wide, full-height opening.
    const big = tokenAt(scene, levelId, { i: 12, j: 8 }, { size: "large" })
    door.height = 10
    expect(path(scene, big, at(7, 12, levelId), { maxSteps: 6 })).toBeNull()
    door.width = 10
    expect(path(scene, big, at(7, 12, levelId), { maxSteps: 6 })).not.toBeNull()
  })

  it("a tiny token fits a 2 ft gap that a medium token does not", () => {
    const { scene, levelId, wall } = wallScene()
    add(scene, createDoor(wall, 17.5, { width: 2, height: 7, state: "open" }))
    const tiny = tokenAt(scene, levelId, { i: 1, j: 3 }, { size: "tiny" })
    const medium = tokenAt(scene, levelId, { i: 1, j: 3 })
    expect(stepResult(scene, tiny, at(1, 3, levelId), at(2, 3, levelId))).toBe("ok")
    expect(stepResult(scene, medium, at(1, 3, levelId), at(2, 3, levelId))).toBe("blocked")
  })

  it("hidden walls still block; other tokens never do", () => {
    const { scene, levelId } = flatScene()
    add(scene, createWall(levelId, { x: 10, z: 0 }, { x: 10, z: 50 }, { hidden: true }))
    const t = tokenAt(scene, levelId, { i: 1, j: 3 })
    tokenAt(scene, levelId, { i: 1, j: 4 }, { size: "large" })
    expect(stepResult(scene, t, at(1, 3, levelId), at(2, 3, levelId))).toBe("blocked")
    expect(stepResult(scene, t, at(1, 3, levelId), at(1, 4, levelId))).toBe("ok")
  })

  it("walls of other levels do not block", () => {
    const { scene, levelId } = flatScene()
    const upper = addLevel(scene, { elevation: 10 })
    add(scene, createWall(upper.id, { x: 10, z: 0 }, { x: 10, z: 50 }))
    const t = tokenAt(scene, levelId, { i: 1, j: 3 })
    expect(stepResult(scene, t, at(1, 3, levelId), at(2, 3, levelId))).toBe("ok")
  })
})

describe("props and pillars", () => {
  function propScene(kind: Parameters<typeof createProp>[1], partial: Parameters<typeof createProp>[3] = {}) {
    const { scene, levelId } = flatScene()
    // Centre of cell (3, 3).
    const prop = add(scene, createProp(levelId, kind, { x: 17.5, y: 0, z: 17.5 }, partial))
    const t = tokenAt(scene, levelId, { i: 2, j: 3 })
    return { scene, levelId, prop, t }
  }

  it("a table blocks, a chair and a bush do not", () => {
    for (const [kind, expected] of [
      ["table", "blocked"],
      ["crate", "blocked"],
      ["chair", "ok"],
      ["bush", "ok"],
    ] as const) {
      const { scene, levelId, t } = propScene(kind)
      expect([kind, stepResult(scene, t, at(2, 3, levelId), at(3, 3, levelId))]).toEqual([kind, expected])
    }
  })

  it("a tree trunk blocks; its raised canopy does not block the cells around it", () => {
    const { scene, levelId, t } = propScene("tree")
    expect(stepResult(scene, t, at(2, 3, levelId), at(3, 3, levelId))).toBe("blocked")
    // Under the canopy (8 ft wide, from 7 ft up) next to the trunk.
    expect(stepResult(scene, t, at(2, 2, levelId), at(2, 3, levelId))).toBe("ok")
  })

  it("hidden props still block; a prop flagged not blocking movement does not", () => {
    const hidden = propScene("table", { hidden: true })
    expect(stepResult(hidden.scene, hidden.t, at(2, 3, hidden.levelId), at(3, 3, hidden.levelId))).toBe("blocked")
    const soft = propScene("crate", { blocksMovement: false })
    expect(stepResult(soft.scene, soft.t, at(2, 3, soft.levelId), at(3, 3, soft.levelId))).toBe("ok")
  })

  it("obstacles lower than the 0.5 ft step-up are walked over", () => {
    const low = propScene("crate", { scale: { x: 1, y: 0.1, z: 1 } }) // 0.3 ft tall
    expect(stepResult(low.scene, low.t, at(2, 3, low.levelId), at(3, 3, low.levelId))).toBe("ok")
    const high = propScene("crate", { scale: { x: 1, y: 0.25, z: 1 } }) // 0.75 ft tall
    expect(stepResult(high.scene, high.t, at(2, 3, high.levelId), at(3, 3, high.levelId))).toBe("blocked")
    // A raised prop (a shelf 7 ft up) passes over a medium token.
    const raised = propScene("crate", { position: { x: 17.5, y: 7, z: 17.5 } })
    expect(stepResult(raised.scene, raised.t, at(2, 3, raised.levelId), at(3, 3, raised.levelId))).toBe("ok")
  })

  it("a token placed overlapping a prop can walk off it but not through another", () => {
    const { scene, levelId } = flatScene()
    add(scene, createProp(levelId, "table", { x: 17.5, y: 0, z: 17.5 }))
    add(scene, createProp(levelId, "crate", { x: 22.5, y: 0, z: 17.5 }))
    const t = tokenAt(scene, levelId, { i: 3, j: 3 })
    expect(stepResult(scene, t, at(3, 3, levelId), at(2, 3, levelId))).toBe("ok")
    expect(stepResult(scene, t, at(3, 3, levelId), at(4, 3, levelId))).toBe("blocked")
  })

  it("pillars (round and square) block", () => {
    const { scene, levelId } = flatScene()
    add(scene, createPillar(levelId, { x: 17.5, z: 17.5 }, { shape: "round", size: 1.5 }))
    add(scene, createPillar(levelId, { x: 17.5, z: 27.5 }, { shape: "square", size: 1.5 }))
    const t = tokenAt(scene, levelId, { i: 2, j: 3 })
    expect(stepResult(scene, t, at(2, 3, levelId), at(3, 3, levelId))).toBe("blocked")
    expect(stepResult(scene, t, at(2, 5, levelId), at(3, 5, levelId))).toBe("blocked")
  })
})

describe("corner cutting", () => {
  it("diagonals need both orthogonal intermediate positions free", () => {
    const { scene, levelId } = flatScene()
    // Short stub on x = 10 from the corner (10, 5) to (10, 5.8): it misses the diagonal sweep from
    // (1, 1) to (2, 2) (whose edge passes z ≈ 5.95 there) but blocks the orthogonal step (1, 1) → (2, 1)
    // (which covers z ≥ 5.6).
    add(scene, createWall(levelId, { x: 10, z: 5 }, { x: 10, z: 5.8 }))
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    expect(stepResult(scene, t, at(1, 1, levelId), at(2, 2, levelId))).toBe("corner-cutting")
    expect(stepResult(scene, t, at(2, 2, levelId), at(1, 1, levelId))).toBe("corner-cutting")
    expect(stepResult(scene, t, at(1, 1, levelId), at(2, 1, levelId))).toBe("blocked")
    expect(check(scene, place(scene, t, at(1, 1, levelId)), walk(levelId, [[1, 1], [1, 2], [2, 2]])).ok).toBe(true)
    expect(stepResult(scene, t, at(1, 1, levelId), at(0, 2, levelId))).toBe("ok")
  })

  it("a 5 ft corridor at 45° (a rotated building) can be walked down its middle", () => {
    const { scene, levelId } = flatScene()
    // Walls 2.5 ft either side of the line x = z (faces 2.25 ft away): the token's disc (1.9 ft) fits,
    // and the orthogonal legs of each diagonal step clip the rotated walls, which have no grid corner.
    const k = 2.5 * Math.SQRT1_2
    add(scene, createWall(levelId, { x: 5 + k, z: 5 - k }, { x: 45 + k, z: 45 - k }))
    add(scene, createWall(levelId, { x: 5 - k, z: 5 + k }, { x: 45 - k, z: 45 + k }))
    const t = tokenAt(scene, levelId, { i: 2, j: 2 })
    const corridor: [number, number][] = [
      [2, 2],
      [3, 3],
      [4, 4],
      [5, 5],
      [6, 6],
    ]
    expect(check(scene, t, walk(levelId, corridor))).toMatchObject({ ok: true, legalSteps: 4 })
    expect(path(scene, t, at(7, 7, levelId), { maxSteps: 5 })).not.toBeNull()
    // Not through the walls.
    expect(stepResult(scene, t, at(3, 3, levelId), at(4, 3, levelId))).toBe("blocked")
    expect(stepResult(scene, t, at(3, 3, levelId), at(3, 4, levelId))).toBe("blocked")
  })

  it("diagonals around a room corner are rejected", () => {
    const { scene, levelId } = flatScene()
    add(scene, createWall(levelId, { x: 10, z: 0 }, { x: 10, z: 10 }))
    add(scene, createWall(levelId, { x: 10, z: 10 }, { x: 0, z: 10 }))
    const t = tokenAt(scene, levelId, { i: 1, j: 1 })
    expect(stepResult(scene, t, at(1, 1, levelId), at(2, 2, levelId))).toBe("corner-cutting")
    expect(stepResult(scene, t, at(1, 1, levelId), at(0, 0, levelId))).toBe("ok")
  })
})

describe("ground", () => {
  it("an upper level has ground only where it has a floor", () => {
    const { scene } = flatScene()
    const upper = addLevel(scene, { elevation: 10 }, false)
    add(scene, createFloor(upper.id, { x: 0, z: 0, w: 25, d: 50 }))
    const t = tokenAt(scene, upper.id, { i: 3, j: 2 })
    expect(stepResult(scene, t, at(3, 2, upper.id), at(4, 2, upper.id))).toBe("ok")
    expect(stepResult(scene, t, at(4, 2, upper.id), at(5, 2, upper.id))).toBe("no-ground")
    // Multi-cell footprints need ground under every cell.
    const big = tokenAt(scene, upper.id, { i: 2, j: 2 }, { size: "large" })
    expect(stepResult(scene, big, at(2, 2, upper.id), at(3, 2, upper.id))).toBe("ok")
    expect(stepResult(scene, big, at(3, 2, upper.id), at(4, 2, upper.id))).toBe("no-ground")
  })
})

describe("stairs and ramps", () => {
  /** Ground (elev 0) and upper (elev 10) levels, both fully floored; stairs in column 2, rows 1–4, climbing +Z. */
  function stairsScene(width = 1, style: "stairs" | "ramp" = "stairs") {
    const { scene, levelId } = flatScene()
    const upper = addLevel(scene, { elevation: 10 })
    const stairs = add(scene, createConnector(levelId, upper.id, { x: 10, z: 5, w: 5 * width, d: 20 }, 0, style))
    return { scene, lower: levelId, upper: upper.id, stairs }
  }

  it("climbing through the top edge changes level", () => {
    const { scene, lower, upper } = stairsScene()
    const t = tokenAt(scene, lower, { i: 2, j: 0 })
    const route = [at(2, 0, lower), at(2, 1, lower), at(2, 2, lower), at(2, 3, lower), at(2, 4, lower), at(2, 5, upper), at(2, 6, upper)]
    const r = check(scene, t, route)
    expect(r).toEqual({ ok: true, legalSteps: 6, distance: 30 })
    expect(measurePath(scene, route)).toBe(30)
    // And back down.
    place(scene, t, at(2, 6, upper))
    expect(check(scene, t, [...route].reverse()).ok).toBe(true)
  })

  it("works for ramps and for every direction", () => {
    for (const direction of [0, 1, 2, 3] as const) {
      const { scene, levelId } = flatScene()
      const upper = addLevel(scene, { elevation: 8 })
      // A 1 × 3 run in the middle of the map; the top row and the cell beyond depend on the direction.
      const rect = direction % 2 === 0 ? { x: 25, z: 20, w: 5, d: 15 } : { x: 20, z: 25, w: 15, d: 5 }
      add(scene, createConnector(levelId, upper.id, rect, direction, "ramp"))
      const f = [
        { i: 0, j: 1 },
        { i: 1, j: 0 },
        { i: 0, j: -1 },
        { i: -1, j: 0 },
      ][direction]
      // Top row cell: centre cell (5, 5) + f; beyond: + 2f.
      const top = { i: 5 + f.i, j: 5 + f.j }
      const t = tokenAt(scene, levelId, top)
      expect([direction, stepResult(scene, t, at(top.i, top.j, levelId), at(top.i + f.i, top.j + f.j, upper.id))]).toEqual([direction, "ok"])
      expect([direction, stepResult(scene, t, at(top.i, top.j, levelId), at(top.i + f.i, top.j + f.j, levelId))]).toEqual([
        direction,
        "connector-edge",
      ])
      // The bottom row is not the top edge.
      const bottom = { i: 5 - f.i, j: 5 - f.j }
      expect([direction, stepResult(scene, t, at(bottom.i, bottom.j, levelId), at(bottom.i - f.i, bottom.j - f.j, upper.id))]).toEqual([
        direction,
        "connector-edge",
      ])
    }
  })

  it("stepping off the side stays on the lower level; walking past the top edge on it is rejected", () => {
    const { scene, lower } = stairsScene()
    const t = tokenAt(scene, lower, { i: 2, j: 2 })
    expect(stepResult(scene, t, at(2, 2, lower), at(3, 2, lower))).toBe("ok")
    expect(stepResult(scene, t, at(3, 2, lower), at(2, 2, lower))).toBe("ok")
    expect(stepResult(scene, t, at(2, 4, lower), at(3, 4, lower))).toBe("ok")
    expect(stepResult(scene, t, at(2, 4, lower), at(2, 5, lower))).toBe("connector-edge")
    expect(stepResult(scene, t, at(2, 5, lower), at(2, 4, lower))).toBe("connector-edge")
    expect(stepResult(scene, t, at(3, 5, lower), at(2, 4, lower))).toBe("connector-edge")
  })

  it("jumping between the run and the upper floor anywhere but the top edge is rejected", () => {
    const { scene, lower, upper } = stairsScene()
    const t = tokenAt(scene, lower, { i: 2, j: 2 })
    expect(stepResult(scene, t, at(2, 2, lower), at(3, 2, upper))).toBe("connector-edge")
    expect(stepResult(scene, t, at(2, 2, lower), at(2, 3, upper))).toBe("connector-edge")
    expect(stepResult(scene, t, at(2, 4, lower), at(3, 5, upper))).toBe("connector-edge")
    expect(stepResult(scene, t, at(3, 2, upper), at(2, 2, lower))).toBe("connector-edge")
    // Level changes away from any connector.
    expect(stepResult(scene, t, at(6, 6, lower), at(6, 7, upper))).toBe("no-connector")
    expect(stepResult(scene, t, at(6, 6, lower), at(6, 6, upper))).toBe("no-connector")
    expect(stepResult(scene, t, at(6, 6, lower), at(6, 6, "missing-level"))).toBe("no-connector")
    expect(stepResult(scene, t, at(2, 3, lower), at(2, 5, upper))).toBe("not-adjacent")
  })

  it("on the upper level the stairwell is not walkable and may only be entered across the top edge", () => {
    const { scene, upper } = stairsScene()
    const t = tokenAt(scene, upper, { i: 2, j: 5 })
    expect(stepResult(scene, t, at(2, 5, upper), at(2, 4, upper))).toBe("no-ground")
    expect(stepResult(scene, t, at(3, 3, upper), at(2, 3, upper))).toBe("connector-edge")
    expect(stepResult(scene, t, at(2, 0, upper), at(2, 1, upper))).toBe("connector-edge")
  })

  it("an upper-level wall across the top edge blocks the climb; a lower wall under the edge does not", () => {
    const { scene, lower, upper } = stairsScene()
    const t = tokenAt(scene, lower, { i: 2, j: 4 })
    const low = add(scene, createWall(lower, { x: 5, z: 25 }, { x: 20, z: 25 }, { height: 10 }))
    expect(stepResult(scene, t, at(2, 4, lower), at(2, 5, upper))).toBe("ok")
    delete scene.objects[low.id]
    add(scene, createWall(upper, { x: 5, z: 25 }, { x: 20, z: 25 }))
    expect(stepResult(scene, t, at(2, 4, lower), at(2, 5, upper))).toBe("blocked")
  })

  it("an upper-level wall over the run blocks near the top but not near the bottom", () => {
    const { scene, lower } = stairsScene()
    const upperId = Object.values(scene.levels).find((l) => l.elevation === 10)!.id
    // Across the run at z = 20 (between rows 3 and 4): at the top the token's head reaches it.
    add(scene, createWall(upperId, { x: 10, z: 20 }, { x: 15, z: 20 }))
    const t = tokenAt(scene, lower, { i: 2, j: 3 })
    expect(stepResult(scene, t, at(2, 3, lower), at(2, 4, lower))).toBe("blocked")
    const { scene: s2, lower: l2 } = stairsScene()
    const up2 = Object.values(s2.levels).find((l) => l.elevation === 10)!.id
    add(s2, createWall(up2, { x: 10, z: 10 }, { x: 15, z: 10 }))
    const t2 = tokenAt(s2, l2, { i: 2, j: 1 })
    expect(stepResult(s2, t2, at(2, 1, l2), at(2, 2, l2))).toBe("ok")
  })

  it("large tokens climb wide stairs and stand across the top edge", () => {
    const { scene, lower, upper } = stairsScene(2)
    const big = tokenAt(scene, lower, { i: 2, j: 2 }, { size: "large" })
    const route = [at(2, 2, lower), at(2, 3, lower), at(2, 4, upper), at(2, 5, upper)]
    expect(check(scene, big, route)).toMatchObject({ ok: true, legalSteps: 3 })
    // Straddling the top edge on the upper level is supported; fully over the stairwell is not.
    expect(stepResult(scene, big, at(2, 4, upper), at(2, 3, upper))).toBe("no-ground")
    // Down again.
    place(scene, big, at(2, 5, upper))
    expect(check(scene, big, [at(2, 5, upper), at(2, 4, upper), at(2, 3, lower), at(2, 2, lower)]).ok).toBe(true)
    // Too wide for single-width stairs.
    const narrow = stairsScene(1)
    const b2 = tokenAt(narrow.scene, narrow.lower, { i: 2, j: 3 }, { size: "large" })
    expect(stepResult(narrow.scene, b2, at(2, 3, narrow.lower), at(2, 4, narrow.upper))).toBe("connector-edge")
  })
})

describe("ladders", () => {
  function ladderScene() {
    const { scene, levelId } = flatScene()
    const upper = addLevel(scene, { elevation: 10 })
    const ladder = add(scene, createConnector(levelId, upper.id, { x: 25, z: 25, w: 5, d: 5 }, 0, "ladder"))
    return { scene, lower: levelId, upper: upper.id, ladder }
  }

  it("switches level in place on the ladder cell, for free", () => {
    const { scene, lower, upper } = ladderScene()
    const t = tokenAt(scene, lower, { i: 4, j: 5 })
    const route = [at(4, 5, lower), at(5, 5, lower), at(5, 5, upper), at(6, 5, upper)]
    expect(check(scene, t, route)).toEqual({ ok: true, legalSteps: 3, distance: 10 })
    expect(measurePath(scene, route)).toBe(10)
    place(scene, t, at(5, 5, upper))
    expect(check(scene, t, [at(5, 5, upper), at(5, 5, lower)]).ok).toBe(true)
  })

  it("rejects switches away from the ladder and blocked destinations", () => {
    const { scene, lower, upper } = ladderScene()
    const t = tokenAt(scene, lower, { i: 4, j: 4 })
    expect(stepResult(scene, t, at(4, 4, lower), at(4, 4, upper))).toBe("no-connector")
    // The ladder cell is cut out of the upper floor but is ground on both levels.
    expect(stepResult(scene, t, at(5, 4, upper), at(5, 5, upper))).toBe("ok")
    add(scene, createProp(upper, "crate", { x: 27.5, y: 0, z: 27.5 }))
    expect(stepResult(scene, t, at(5, 5, lower), at(5, 5, upper))).toBe("blocked")
  })
})

describe("speed and distance", () => {
  const diagonal = (levelId: string, n: number) => Array.from({ length: n + 1 }, (_, k) => at(k, k, levelId))

  it("5-5-5: every step costs 5 ft", () => {
    const { scene, levelId } = flatScene()
    const t = tokenAt(scene, levelId, { i: 0, j: 0 }, { speed: 30 })
    expect(check(scene, t, diagonal(levelId, 7))).toEqual({ ok: true, legalSteps: 7, distance: 35 })
    expect(check(scene, t, diagonal(levelId, 7), { enforceSpeed: true })).toEqual({
      ok: false,
      legalSteps: 6,
      distance: 30,
      reason: "too-far",
      failedAt: 7,
    })
  })

  it("5-10-5: alternating diagonals", () => {
    const { scene, levelId } = flatScene()
    scene.grid.diagonalRule = "5-10-5"
    const t = tokenAt(scene, levelId, { i: 0, j: 0 }, { speed: 30 })
    expect(check(scene, t, diagonal(levelId, 4), { enforceSpeed: true })).toEqual({ ok: true, legalSteps: 4, distance: 30 })
    expect(check(scene, t, diagonal(levelId, 5), { enforceSpeed: true })).toEqual({
      ok: false,
      legalSteps: 4,
      distance: 30,
      reason: "too-far",
      failedAt: 5,
    })
    // An orthogonal step between diagonals does not reset the parity.
    const mixed = walk(levelId, [
      [0, 0],
      [1, 1],
      [2, 1],
      [3, 2],
    ])
    expect(measurePath(scene, mixed)).toBe(20)
    expect(check(scene, t, mixed).distance).toBe(20)
  })

  it("euclidean diagonals", () => {
    const { scene, levelId } = flatScene()
    scene.grid.diagonalRule = "euclidean"
    expect(measurePath(scene, diagonal(levelId, 2))).toBeCloseTo(10 * Math.SQRT2)
  })

  it("measurePath counts level switches as free", () => {
    const { scene, levelId } = flatScene()
    expect(measurePath(scene, [at(0, 0, levelId), at(0, 0, "up"), at(1, 0, "up")])).toBe(5)
    expect(measurePath(scene, [])).toBe(0)
  })
})

describe("terrain", () => {
  it("walls and props on slopes still block; steps on a slope are fine", () => {
    const { scene, levelId } = flatScene()
    paintHeightmap(scene, levelId, (x) => x * 0.2)
    add(scene, createWall(levelId, { x: 20, z: 0 }, { x: 20, z: 50 }))
    add(scene, createProp(levelId, "table", { x: 12.5, y: 0, z: 27.5 }))
    const t = tokenAt(scene, levelId, { i: 0, j: 3 })
    expect(check(scene, t, walk(levelId, [[0, 3], [1, 3], [2, 3]])).ok).toBe(true)
    expect(stepResult(scene, t, at(3, 3, levelId), at(4, 3, levelId))).toBe("blocked")
    expect(stepResult(scene, t, at(1, 5, levelId), at(2, 5, levelId))).toBe("blocked")
  })
})

describe("world consistency", () => {
  it("uses the given world (door toggles take effect after world.update)", () => {
    const { scene, levelId } = flatScene()
    const wall = add(scene, createWall(levelId, { x: 10, z: 0 }, { x: 10, z: 50 }))
    const door = add(scene, createDoor(wall, 17.5, { state: "closed" }))
    const world = buildOcclusionWorld(scene)
    const t: Token = tokenAt(scene, levelId, { i: 1, j: 3 })
    const route = [at(1, 3, levelId), at(2, 3, levelId)]
    const run = (s: Scene) => validateMove(s, world, t, route, { enforceSpeed: false })
    expect(run(scene).reason).toBe("blocked")
    door.state = "open"
    world.update(scene, [door.id])
    expect(run(scene).ok).toBe(true)
  })
})
