/**
 * reduceRequest: move authorisation, legal prefixes and masked reasons; door rules and reasons.
 */
import { describe, expect, it } from "vitest"

import { anchorPosition } from "../movement"
import type { PathStep } from "../movement/types"
import { buildOcclusionWorld } from "../occlusion"
import { createDoor, createFloor, createWall } from "../scene/factory"
import type { Id } from "../scene/types"
import { reduceDm } from "./reduceDm"
import { reduceRequest, segmentRectDistance, type RequestContext } from "./reduceRequest"
import { createGameState } from "./state"
import { add, addToken, flatScene, TestHost } from "./test-utils"
import type { GameState } from "./types"

const walk = (levelId: Id, cells: [number, number][]): PathStep[] => cells.map(([i, j]) => ({ cell: { i, j }, levelId }))

describe("move requests", () => {
  /** Bright 10×6 field; row 2 has a hole in the floor at cell (5, 2). The PC stands in cell (2, 2). */
  function field() {
    const { scene, ground } = flatScene(10, 6)
    // Replace the full floor by floors around cell (5, 2).
    for (const id of Object.keys(scene.objects)) delete scene.objects[id]
    add(scene, createFloor(ground, { x: 0, z: 0, w: 50, d: 10 }))
    add(scene, createFloor(ground, { x: 0, z: 15, w: 50, d: 15 }))
    add(scene, createFloor(ground, { x: 0, z: 10, w: 25, d: 5 }))
    add(scene, createFloor(ground, { x: 30, z: 10, w: 20, d: 5 }))
    const pc = addToken(scene, ground, 12.5, 12.5)
    const other = addToken(scene, ground, 12.5, 22.5)
    let state = createGameState({ sessionId: "s", roomCode: "R", scene })
    for (const uid of ["p1", "p2"]) state = reduceDm(state, { t: "add-player", userId: uid, displayName: uid }).state
    state = reduceDm(state, { t: "assign-token", tokenId: pc.id, userId: "p1", assigned: true }).state
    state = reduceDm(state, { t: "assign-token", tokenId: other.id, userId: "p2", assigned: true }).state
    const ctx = (perceived: boolean): RequestContext => ({ world: buildOcclusionWorld(scene), currentView: null, perceivedByPlayer: () => perceived })
    return { state, ground, pc, other, ctx }
  }

  it("applies the legal prefix and reports the visited steps", () => {
    const { state, ground, pc, ctx } = field()
    const path = walk(ground, [[2, 2], [3, 2], [4, 2], [5, 2], [6, 2]])
    const out = reduceRequest(state, "p1", { t: "move", reqId: "r1", tokenId: pc.id, path }, ctx(true))
    expect(out.result).toEqual({ reqId: "r1", ok: false, applied: 2, reason: "no-ground" })
    expect(out.visited).toEqual(walk(ground, [[3, 2], [4, 2]]))
    expect(out.state.scene.tokens[pc.id].position).toEqual(anchorPosition(state.scene, "medium", { i: 4, j: 2 }))
    expect(out.delta.tokens).toEqual([pc.id])
    expect(out.dirtyPlayers).toBe("all")
    expect(out.tokenId).toBe(pc.id)
    expect(out.state.seq).toBe(state.seq + 1)
    // The input state is untouched.
    expect(state.scene.tokens[pc.id].position).toEqual({ x: 12.5, z: 12.5 })
  })

  it("masks world-dependent reasons as 'blocked' when the failing step is not perceived", () => {
    const { state, ground, pc, ctx } = field()
    const path = walk(ground, [[2, 2], [3, 2], [4, 2], [5, 2]])
    const out = reduceRequest(state, "p1", { t: "move", reqId: "r", tokenId: pc.id, path }, ctx(false))
    expect(out.result).toEqual({ reqId: "r", ok: false, applied: 2, reason: "blocked" })
    // One unperceived cell of the sweep is enough to mask.
    const partly: RequestContext = { ...ctx(true), perceivedByPlayer: (_l, i) => i !== 5 }
    expect(reduceRequest(state, "p1", { t: "move", reqId: "r", tokenId: pc.id, path }, partly).result.reason).toBe("blocked")
  })

  it("masks with the real perception: a hole in the floor is never perceived", () => {
    const { state, pc } = field()
    const host = new TestHost(state.scene, ["p1"])
    host.assign(pc.id)
    host.refresh()
    const ground = pc.levelId
    const out = host.request("p1", { t: "move", reqId: "r", tokenId: pc.id, path: walk(ground, [[2, 2], [3, 2], [4, 2], [5, 2]]) })
    expect(out.result).toEqual({ reqId: "r", ok: false, applied: 2, reason: "blocked" })
  })

  it("does not mask reasons that reveal nothing about the world", () => {
    const { state, ground, pc, ctx } = field()
    const jump = reduceRequest(state, "p1", { t: "move", reqId: "r", tokenId: pc.id, path: walk(ground, [[2, 2], [4, 2]]) }, ctx(false))
    expect(jump.result).toEqual({ reqId: "r", ok: false, applied: 0, reason: "not-adjacent" })
    expect(jump.state).toBe(state)
    const wrongStart = reduceRequest(state, "p1", { t: "move", reqId: "r", tokenId: pc.id, path: walk(ground, [[1, 1], [2, 1]]) }, ctx(false))
    expect(wrongStart.result.reason).toBe("path-start-mismatch")
  })

  it("enforces speed only when the DM does", () => {
    const { state, ground, pc, ctx } = field()
    const path = walk(ground, [[2, 2], [2, 3], [3, 3], [4, 3], [5, 3], [6, 3], [7, 3], [8, 3], [9, 3]])
    expect(reduceRequest(state, "p1", { t: "move", reqId: "r", tokenId: pc.id, path }, ctx(true)).result.ok).toBe(true)
    const enforced = reduceDm(state, { t: "set-enforce-speed", enabled: true }).state
    const out = reduceRequest(enforced, "p1", { t: "move", reqId: "r", tokenId: pc.id, path }, ctx(false))
    expect(out.result).toEqual({ reqId: "r", ok: false, applied: 6, reason: "too-far" })
  })

  it("authorises by ownership before any lookup", () => {
    const { state, ground, pc, other, ctx } = field()
    const path = walk(ground, [[2, 4], [3, 4]])
    expect(reduceRequest(state, "p1", { t: "move", reqId: "r", tokenId: other.id, path }, ctx(true)).result.reason).toBe("not-owner")
    // A token that does not exist looks exactly like one the player does not own.
    expect(reduceRequest(state, "p1", { t: "move", reqId: "r", tokenId: "nope", path }, ctx(true)).result).toEqual({ reqId: "r", ok: false, reason: "not-owner" })
    expect(reduceRequest(state, "p1", { t: "move", reqId: "r", tokenId: "__proto__", path }, ctx(true)).result.reason).toBe("not-owner")
    expect(reduceRequest(state, "p2", { t: "move", reqId: "r", tokenId: pc.id, path }, ctx(true)).result.reason).toBe("not-owner")
  })

  it("rejects moves of hidden tokens and while movement is locked", () => {
    const { state, ground, pc, ctx } = field()
    const path = walk(ground, [[2, 2], [2, 3]])
    const hidden = reduceDm(state, { t: "apply-scene-patches", patches: [{ op: "replace", path: ["tokens", pc.id, "hidden"], value: true }] }).state
    expect(reduceRequest(hidden, "p1", { t: "move", reqId: "r", tokenId: pc.id, path }, ctx(true)).result.reason).toBe("unknown-token")
    const global = reduceDm(state, { t: "set-movement-locked", locked: true }).state
    expect(reduceRequest(global, "p1", { t: "move", reqId: "r", tokenId: pc.id, path }, ctx(true)).result.reason).toBe("movement-locked")
    const personal = reduceDm(state, { t: "set-movement-locked", locked: true, userId: "p1" }).state
    expect(reduceRequest(personal, "p1", { t: "move", reqId: "r", tokenId: pc.id, path }, ctx(true)).result.reason).toBe("movement-locked")
    const ok = reduceRequest(state, "p1", { t: "move", reqId: "r", tokenId: pc.id, path }, ctx(true))
    expect(ok.result).toEqual({ reqId: "r", ok: true, applied: 1 })
  })

  it("rejects over-long paths", () => {
    const { state, ground, pc, ctx } = field()
    const path = Array.from({ length: 258 }, () => ({ cell: { i: 2, j: 2 }, levelId: ground }))
    expect(reduceRequest(state, "p1", { t: "move", reqId: "r", tokenId: pc.id, path }, ctx(true)).result.reason).toBe("path-too-long")
  })
})

describe("gridless moves and jumps", () => {
  /** Open 10×6 field, a wall along x = 30; the PC stands in cell (2, 2). */
  function field(freeMovement: boolean) {
    const { scene, ground } = flatScene(10, 6)
    add(scene, createWall(ground, { x: 30, z: 0 }, { x: 30, z: 30 }))
    const pc = addToken(scene, ground, 12.5, 12.5)
    let state = createGameState({ sessionId: "s", roomCode: "R", scene })
    state = reduceDm(state, { t: "add-player", userId: "p1", displayName: "p1" }).state
    state = reduceDm(state, { t: "assign-token", tokenId: pc.id, userId: "p1", assigned: true }).state
    state = reduceDm(state, { t: "set-free-movement", enabled: freeMovement }).state
    const ctx: RequestContext = { world: buildOcclusionWorld(scene), currentView: null, perceivedByPlayer: () => true }
    return { state, ground, pc, ctx }
  }

  it("ends a gridless move at its exact point", () => {
    const { state, ground, pc, ctx } = field(true)
    const out = reduceRequest(state, "p1", { t: "move", reqId: "r", tokenId: pc.id, path: walk(ground, [[2, 2], [3, 2]]), end: { x: 16.2, z: 11.4 } }, ctx)
    expect(out.result).toEqual({ reqId: "r", ok: true, applied: 1 })
    expect(out.state.scene.tokens[pc.id].position).toEqual({ x: 16.2, z: 11.4 })
    // Within the token's own cell.
    const nudge = reduceRequest(state, "p1", { t: "move", reqId: "n", tokenId: pc.id, path: walk(ground, [[2, 2]]), end: { x: 11, z: 14 } }, ctx)
    expect(nudge.result.ok).toBe(true)
    expect(nudge.state.scene.tokens[pc.id].position).toEqual({ x: 11, z: 14 })
    expect(nudge.visited).toEqual(walk(ground, [[2, 2]]))
  })

  it("stops on the last centre when the end is not reachable, and refuses ends while players snap to the grid", () => {
    const { state, ground, pc, ctx } = field(true)
    const path = walk(ground, [[2, 2], [3, 2], [4, 2], [5, 2]])
    const out = reduceRequest(state, "p1", { t: "move", reqId: "r", tokenId: pc.id, path, end: { x: 29.9, z: 12.5 } }, ctx)
    expect(out.result).toEqual({ reqId: "r", ok: false, applied: 3, reason: "blocked" })
    expect(out.state.scene.tokens[pc.id].position).toEqual({ x: 27.5, z: 12.5 })
    const snapped = field(false)
    const gridPath = walk(snapped.ground, [[2, 2], [3, 2]])
    const refused = reduceRequest(snapped.state, "p1", { t: "move", reqId: "r", tokenId: snapped.pc.id, path: gridPath, end: { x: 16, z: 12.5 } }, snapped.ctx)
    expect(refused.result).toEqual({ reqId: "r", ok: false, reason: "invalid" })
    expect(refused.state).toBe(snapped.state)
  })

  it("jumps over walls, snapping to the grid unless free movement is on", () => {
    const free = field(true)
    const out = reduceRequest(free.state, "p1", { t: "jump", reqId: "j", tokenId: free.pc.id, levelId: free.ground, x: 41.3, z: 8.2 }, free.ctx)
    expect(out.result).toEqual({ reqId: "j", ok: true, applied: 1 })
    expect(out.state.scene.tokens[free.pc.id].position).toEqual({ x: 41.3, z: 8.2 })
    expect(out.delta.tokens).toEqual([free.pc.id])
    const grid = field(false)
    const snapped = reduceRequest(grid.state, "p1", { t: "jump", reqId: "j", tokenId: grid.pc.id, levelId: grid.ground, x: 41.3, z: 8.2 }, grid.ctx)
    expect(snapped.state.scene.tokens[grid.pc.id].position).toEqual({ x: 42.5, z: 7.5 })
  })

  it("refuses jumps into blockers (masked when unseen), too far, locked or for tokens not owned", () => {
    const { state, ground, pc, ctx } = field(true)
    const jump = (s: GameState, uid: string, x: number, c: RequestContext = ctx) =>
      reduceRequest(s, uid, { t: "jump", reqId: "j", tokenId: pc.id, levelId: ground, x, z: 12.5 }, c)
    expect(jump(state, "p1", 30.5).result).toEqual({ reqId: "j", ok: false, reason: "blocked" })
    expect(jump(state, "p2", 40).result.reason).toBe("not-owner")
    expect(jump(state, "p1", 70).result.reason).toBe("out-of-bounds")
    const speedy = reduceDm(state, { t: "set-enforce-speed", enabled: true }).state
    expect(jump(speedy, "p1", 47.5).result.reason).toBe("too-far")
    const locked = reduceDm(state, { t: "set-movement-locked", locked: true }).state
    expect(jump(locked, "p1", 40).result.reason).toBe("movement-locked")
    // Setting the rule to its current value is a no-op.
    expect(reduceDm(state, { t: "set-free-movement", enabled: true }).state).toBe(state)
  })
})

describe("door requests", () => {
  /** Bright field; wall along z = 25 with a door centred at x = 27.5 (x 25.5–29.5). */
  function doorField(state: "open" | "closed" | "locked" = "closed") {
    const { scene, ground } = flatScene(12, 12)
    const wall = add(scene, createWall(ground, { x: 0, z: 25 }, { x: 60, z: 25 }))
    const door = add(scene, createDoor(wall, 27.5, { state }))
    const near = addToken(scene, ground, 27.5, 22.5) // cell (5, 4), touching the wall
    const far = addToken(scene, ground, 27.5, 7.5) // cell (5, 1)
    const host = new TestHost(scene, ["p1", "p2"])
    host.assign(near.id, "p1")
    host.assign(far.id, "p2")
    host.refresh("p1")
    host.refresh("p2")
    return { host, door, near, far, ground }
  }

  it("opens and closes a door in view with a controlled token beside it", () => {
    const { host, door } = doorField()
    const out = host.request("p1", { t: "door", reqId: "d1", doorId: door.id, action: "open" })
    expect(out.result).toEqual({ reqId: "d1", ok: true })
    expect(out.delta.objects).toEqual([door.id])
    expect(host.state.scene.objects[door.id]).toMatchObject({ state: "open" })
    expect(host.request("p1", { t: "door", reqId: "d2", doorId: door.id, action: "close" }).result.ok).toBe(true)
    expect(host.state.scene.objects[door.id]).toMatchObject({ state: "closed" })
    // Asking for the current state is a successful no-op.
    const again = host.request("p1", { t: "door", reqId: "d3", doorId: door.id, action: "close" })
    expect(again.result.ok).toBe(true)
    expect(again.dirtyPlayers).toEqual([])
  })

  it("replies 'cannot' when no controlled token is within one cell", () => {
    const { host, door } = doorField()
    // p2's token is 3 cells away; p2 sees the door too.
    expect(host.sent.get("p2")!.objects[door.id]).toBeDefined()
    expect(host.request("p2", { t: "door", reqId: "d", doorId: door.id, action: "open" }).result).toEqual({ reqId: "d", ok: false, reason: "cannot" })
  })

  it("replies 'cannot' for doors not in the player's current view", () => {
    const { host, door } = doorField()
    const out = reduceRequest(host.state, "p1", { t: "door", reqId: "d", doorId: door.id, action: "open" }, {
      world: host.engine.world,
      currentView: null,
      perceivedByPlayer: () => true,
    })
    expect(out.result.reason).toBe("cannot")
    expect(host.request("p1", { t: "door", reqId: "d", doorId: "no-such-door", action: "open" }).result.reason).toBe("cannot")
  })

  it("replies 'locked' only after the adjacency check passes; players never unlock", () => {
    const { host, door } = doorField("locked")
    expect(host.sent.get("p1")!.objects[door.id]).toMatchObject({ state: "closed" })
    expect(host.request("p1", { t: "door", reqId: "d", doorId: door.id, action: "open" }).result).toEqual({ reqId: "d", ok: false, reason: "locked" })
    expect(host.request("p2", { t: "door", reqId: "d", doorId: door.id, action: "open" }).result.reason).toBe("cannot")
    expect(host.request("p1", { t: "door", reqId: "d", doorId: door.id, action: "close" }).result.ok).toBe(true)
    expect(host.state.scene.objects[door.id]).toMatchObject({ state: "locked" })
  })

  it("replies 'cannot' while movement is locked (even for locked doors)", () => {
    const { host, door } = doorField("locked")
    host.dm({ t: "set-movement-locked", locked: true, userId: "p1" })
    expect(host.request("p1", { t: "door", reqId: "d", doorId: door.id, action: "open" }).result.reason).toBe("cannot")
  })

  it("replies 'cannot' for hidden doors and unrevealed secret doors", () => {
    const { host, door } = doorField()
    const view = host.sent.get("p1")!
    const hidden = reduceDm(host.state, { t: "apply-scene-patches", patches: [{ op: "replace", path: ["objects", door.id, "hidden"], value: true }] }).state
    const ctx: RequestContext = { world: host.engine.world, currentView: view, perceivedByPlayer: () => true }
    expect(reduceRequest(hidden, "p1", { t: "door", reqId: "d", doorId: door.id, action: "open" }, ctx).result.reason).toBe("cannot")
    const secret: GameState = reduceDm(host.state, { t: "apply-scene-patches", patches: [{ op: "replace", path: ["objects", door.id, "style"], value: "secret" }] }).state
    expect(reduceRequest(secret, "p1", { t: "door", reqId: "d", doorId: door.id, action: "open" }, ctx).result.reason).toBe("cannot")
    const revealed = reduceDm(secret, { t: "reveal-object", objectId: door.id, userId: "p1" }).state
    expect(reduceRequest(revealed, "p1", { t: "door", reqId: "d", doorId: door.id, action: "open" }, ctx).result.ok).toBe(true)
  })

  it("requires the controlled token to be on the door's level", () => {
    const { host, door, near } = doorField()
    const view = host.sent.get("p1")!
    const lvl = { id: "upper", name: "Upper", elevation: 10, height: 10, floorThickness: 1, heightmap: null }
    let s = reduceDm(host.state, { t: "apply-scene-patches", patches: [{ op: "add", path: ["levels", "upper"], value: lvl }] }).state
    s = reduceDm(s, { t: "move-token", tokenId: near.id, levelId: "upper", x: 27.5, z: 22.5 }).state
    const out = reduceRequest(s, "p1", { t: "door", reqId: "d", doorId: door.id, action: "open" }, { world: host.engine.world, currentView: view, perceivedByPlayer: () => true })
    expect(out.result.reason).toBe("cannot")
  })
})

describe("segmentRectDistance", () => {
  const r = { x: 0, z: 0, w: 5, d: 5 }
  it("is 0 for touching or crossing segments and the gap otherwise", () => {
    expect(segmentRectDistance({ x: -1, z: 5 }, { x: 6, z: 5 }, r)).toBe(0)
    expect(segmentRectDistance({ x: -1, z: 2 }, { x: 6, z: 3 }, r)).toBe(0)
    expect(segmentRectDistance({ x: 2, z: 2 }, { x: 3, z: 3 }, r)).toBe(0)
    expect(segmentRectDistance({ x: 0, z: 8 }, { x: 5, z: 8 }, r)).toBe(3)
    expect(segmentRectDistance({ x: 8, z: 9 }, { x: 20, z: 9 }, r)).toBe(5)
  })
})
