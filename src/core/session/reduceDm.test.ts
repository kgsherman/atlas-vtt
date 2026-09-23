/**
 * reduceDm: every DmCommand, scene patches → SceneDelta, knowledge reconciliation on grid / level
 * changes, player management.
 */
import { produceWithPatches, type Patch } from "immer"
import { describe, expect, it } from "vitest"

import { createDoor, createLight, createProp, createWall } from "../scene/factory"
import { chunkKey } from "../scene/heightmap"
import type { Scene } from "../scene/types"
import { createCellMask, createGradeMask, decodeMask, encodeMask, setCell } from "../vision/mask"
import type { VisibilityResult } from "../vision/types"
import { updateKnowledge } from "./memory"
import { deltaFromPatches, reduceDm } from "./reduceDm"
import { controlledTokenIds, createGameState, viewerTokenIds } from "./state"
import { add, addLevel, addToken, flatScene } from "./test-utils"
import type { DmCommand, GameState } from "./types"

function setup() {
  const { scene, ground } = flatScene(10, 10)
  const wall = add(scene, createWall(ground, { x: 0, z: 20 }, { x: 50, z: 20 }))
  const door = add(scene, createDoor(wall, 10))
  const light = add(scene, createLight(ground, "torch", { x: 7.5, z: 7.5 }))
  const crate = add(scene, createProp(ground, "crate", { x: 12.5, y: 0, z: 12.5 }))
  const pc = addToken(scene, ground, 7.5, 7.5, { kind: "pc" })
  const pc2 = addToken(scene, ground, 17.5, 7.5, { kind: "pc" })
  const npc = addToken(scene, ground, 27.5, 7.5, { kind: "npc" })
  const carried = add(scene, createLight(ground, "lantern", { x: 0, z: 0 }, { attachedTokenId: pc.id }))
  let state = createGameState({ sessionId: "s", roomCode: "R", scene })
  const run = (cmd: DmCommand) => (state = reduceDm(state, cmd).state)
  run({ t: "add-player", userId: "p1", displayName: "Ann" })
  run({ t: "add-player", userId: "p2", displayName: "Bob" })
  return { scene, ground, wall, door, light, crate, pc, pc2, npc, carried, state }
}

/** A knowledge pass over a synthetic perception of the listed cells. */
function perceive(state: GameState, uid: string, levelId: string, cells: [number, number][], observed: string[]): GameState {
  const m = createGradeMask(state.scene.grid.width, state.scene.grid.depth)
  for (const [i, j] of cells) m.grades[j * m.width + i] = 3
  const vis: VisibilityResult = { perception: { [levelId]: m }, sunlit: {}, visibleTokenIds: new Set(), observedObjectIds: new Set(observed), illuminatingLightIds: new Set() }
  return updateKnowledge(state, uid, vis)
}

function patchesFor(scene: Scene, recipe: (d: Scene) => void): Patch[] {
  return produceWithPatches(scene, recipe)[1]
}

describe("play commands", () => {
  it("move-token moves a token (and reports its carried lights)", () => {
    const { state, ground, pc, carried } = setup()
    const r = reduceDm(state, { t: "move-token", tokenId: pc.id, levelId: ground, x: 22.5, z: 32.5 })
    expect(r.state.scene.tokens[pc.id]).toMatchObject({ levelId: ground, position: { x: 22.5, z: 32.5 } })
    expect(r.delta).toEqual({ objects: [carried.id], tokens: [pc.id], terrain: [], structure: false })
    expect(r.dirtyPlayers).toBe("all")
    expect(r.state.seq).toBe(state.seq + 1)
    expect(state.scene.tokens[pc.id].position).toEqual({ x: 7.5, z: 7.5 })
  })

  it("move-token rejects unknown tokens / levels, non-finite positions and positions outside the scene", () => {
    const { state, ground, pc } = setup()
    for (const cmd of [
      { t: "move-token", tokenId: "nope", levelId: ground, x: 1, z: 1 },
      { t: "move-token", tokenId: pc.id, levelId: "nope", x: 1, z: 1 },
      { t: "move-token", tokenId: "__proto__", levelId: ground, x: 1, z: 1 },
      { t: "move-token", tokenId: pc.id, levelId: ground, x: Number.NaN, z: 1 },
      // The live scene is persisted and must stay loadable (extent ± SCENE_LIMITS.coordMargin).
      { t: "move-token", tokenId: pc.id, levelId: ground, x: -500, z: 1 },
      { t: "move-token", tokenId: pc.id, levelId: ground, x: 1, z: state.scene.grid.depth * state.scene.grid.cellSize + 51 },
    ] as DmCommand[]) {
      const r = reduceDm(state, cmd)
      expect(r.state).toBe(state)
      expect(r.error).toBeDefined()
    }
  })

  it("set-door and set-light change play state; no-ops are free", () => {
    const { state, door, light } = setup()
    const r1 = reduceDm(state, { t: "set-door", doorId: door.id, state: "locked" })
    expect(r1.state.scene.objects[door.id]).toMatchObject({ state: "locked" })
    expect(r1.delta.objects).toEqual([door.id])
    const r2 = reduceDm(state, { t: "set-light", lightId: light.id, on: false })
    expect(r2.state.scene.objects[light.id]).toMatchObject({ on: false })
    expect(r2.delta.objects).toEqual([light.id])
    const same = reduceDm(state, { t: "set-door", doorId: door.id, state: "closed" })
    expect(same.state).toBe(state)
    expect(same.dirtyPlayers).toEqual([])
    expect(reduceDm(state, { t: "set-door", doorId: light.id, state: "open" }).error).toBeDefined()
    expect(reduceDm(state, { t: "set-light", lightId: door.id, on: true }).error).toBeDefined()
  })

  it("movement locks are global or per player", () => {
    const { state } = setup()
    const g = reduceDm(state, { t: "set-movement-locked", locked: true })
    expect(g.state.movementLocked).toBe(true)
    expect(g.dirtyPlayers).toBe("all")
    const p = reduceDm(state, { t: "set-movement-locked", locked: true, userId: "p2" })
    expect(p.state.players.p2.movementLocked).toBe(true)
    expect(p.state.players.p1.movementLocked).toBe(false)
    expect(p.dirtyPlayers).toEqual(["p2"])
    expect(reduceDm(state, { t: "set-movement-locked", locked: true, userId: "ghost" }).error).toBeDefined()
  })

  it("assign-token drives control and shared vision (players owning ≥ 1 PC see through party PCs)", () => {
    const { pc, pc2, npc, state: s0 } = setup()
    let state = s0
    const run = (cmd: DmCommand) => (state = reduceDm(state, cmd).state)
    run({ t: "assign-token", tokenId: pc.id, userId: "p1", assigned: true })
    run({ t: "assign-token", tokenId: pc2.id, userId: "p2", assigned: true })
    run({ t: "assign-token", tokenId: npc.id, userId: "p2", assigned: true })
    expect(controlledTokenIds(state, "p1")).toEqual([pc.id])
    expect(viewerTokenIds(state, "p1")).toEqual([pc.id])
    run({ t: "set-shared-vision", enabled: true })
    expect(viewerTokenIds(state, "p1")).toEqual([pc.id, pc2.id].sort())
    // p2's NPC is theirs to see through, but not shared with the party.
    expect(viewerTokenIds(state, "p2")).toEqual([pc.id, pc2.id, npc.id].sort())
    // A player who owns no PC gets no party vision.
    run({ t: "add-player", userId: "p3", displayName: "Cat" })
    expect(viewerTokenIds(state, "p3")).toEqual([])
    run({ t: "assign-token", tokenId: npc.id, userId: "p3", assigned: true })
    expect(viewerTokenIds(state, "p3")).toEqual([npc.id])
    // Unassigning; unknown players cannot be assigned.
    run({ t: "assign-token", tokenId: pc.id, userId: "p1", assigned: false })
    expect(state.owners[pc.id]).toBeUndefined()
    expect(reduceDm(state, { t: "assign-token", tokenId: pc.id, userId: "ghost", assigned: true }).error).toBeDefined()
  })

  it("hidden tokens are neither controlled nor viewers", () => {
    const { pc, state: s0 } = setup()
    let state = reduceDm(s0, { t: "assign-token", tokenId: pc.id, userId: "p1", assigned: true }).state
    state = reduceDm(state, { t: "apply-scene-patches", patches: [{ op: "replace", path: ["tokens", pc.id, "hidden"], value: true }] }).state
    expect(controlledTokenIds(state, "p1")).toEqual([])
    expect(viewerTokenIds(state, "p1")).toEqual([])
  })

  it("reveal-object reveals a secret door to one or all players and remembers it", () => {
    const { state: s0, door } = setup()
    const secret = reduceDm(s0, { t: "apply-scene-patches", patches: [{ op: "replace", path: ["objects", door.id, "style"], value: "secret" }] }).state
    const one = reduceDm(secret, { t: "reveal-object", objectId: door.id, userId: "p1" })
    expect(one.state.revealed).toEqual({ p1: [door.id] })
    expect(one.state.memory.p1[door.id]).toMatchObject({ style: "wood" })
    expect(one.dirtyPlayers).toEqual(["p1"])
    const all = reduceDm(secret, { t: "reveal-object", objectId: door.id })
    expect(all.state.revealed).toEqual({ p1: [door.id], p2: [door.id] })
    expect(reduceDm(s0, { t: "reveal-object", objectId: door.id }).error).toBeDefined()
  })
})

describe("apply-scene-patches", () => {
  it("applies immer patches and derives the delta from their paths", () => {
    const { state, crate, wall, pc } = setup()
    const patches = patchesFor(state.scene, (d) => {
      const c = d.objects[crate.id]
      if (c.type === "prop") c.position.x = 30
      delete d.objects[wall.id]
      d.tokens[pc.id].name = "Renamed"
      d.name = "New name"
    })
    const r = reduceDm(state, { t: "apply-scene-patches", patches })
    expect(r.state.scene.objects[crate.id]).toMatchObject({ position: { x: 30 } })
    expect(r.state.scene.objects[wall.id]).toBeUndefined()
    expect(r.state.scene.name).toBe("New name")
    expect(r.delta).toEqual({ objects: [crate.id, wall.id].sort(), tokens: [pc.id], terrain: [], structure: false })
    expect(r.dirtyPlayers).toBe("all")
  })

  it("classifies terrain, level, grid and environment changes", () => {
    const { state, ground } = setup()
    const withHm = reduceDm(state, { t: "apply-scene-patches", patches: [{ op: "replace", path: ["levels", ground, "heightmap"], value: { resolution: 2, chunks: {} } }] })
    expect(withHm.delta.structure).toBe(true)
    const chunk = "A".repeat(4 * Math.ceil((16 * 16 * 4) / 3))
    const chunkEdit = patchesFor(withHm.state.scene, (d) => {
      d.levels[ground].heightmap!.chunks[chunkKey(0, 0)] = chunk
    })
    expect(deltaFromPatches(withHm.state.scene, withHm.state.scene, chunkEdit)).toEqual({ objects: [], tokens: [], terrain: [ground], structure: false })
    for (const path of [["grid", "diagonalRule"], ["environment", "skyLevel"], ["levels", ground, "elevation"]]) {
      expect(deltaFromPatches(state.scene, state.scene, [{ op: "replace", path, value: 1 }]).structure).toBe(true)
    }
    const whole = deltaFromPatches(state.scene, state.scene, [{ op: "replace", path: [], value: state.scene }])
    expect(whole.structure).toBe(true)
    expect(whole.objects).toEqual(Object.keys(state.scene.objects).sort())
  })

  it("returns an error and leaves the state untouched when patches do not apply", () => {
    const { state } = setup()
    const r = reduceDm(state, { t: "apply-scene-patches", patches: [{ op: "replace", path: ["objects", "missing", "position", "x"], value: 1 }] })
    expect(r.state).toBe(state)
    expect(r.error).toMatch(/patches do not apply/)
  })

  it("remaps explored masks on grid resizes (origin fixed)", () => {
    const { ground, crate, state: s0 } = setup()
    const s1 = perceive(s0, "p1", ground, [[1, 1], [9, 9]], [crate.id])
    const r = reduceDm(s1, { t: "apply-scene-patches", patches: patchesFor(s1.scene, (d) => void ((d.grid.width = 6), (d.grid.depth = 12))) })
    const m = decodeMask(r.state.explored.p1[ground])
    expect([m.width, m.depth]).toEqual([6, 12])
    expect((m.bits[(1 * 6 + 1) >> 3] >> ((1 * 6 + 1) & 7)) & 1).toBe(1)
    let count = 0
    for (let c = 0; c < 72; c++) count += (m.bits[c >> 3] >> (c & 7)) & 1
    expect(count).toBe(1)
    expect(r.delta.structure).toBe(true)
  })

  it("remaps explored masks conservatively when the cell size changes", () => {
    const { ground, state: s0 } = setup()
    // Explore a 2×2 block (cells 0–1) and one lone cell (4, 0).
    const s1 = perceive(s0, "p1", ground, [[0, 0], [1, 0], [0, 1], [1, 1], [4, 0]], [])
    const r = reduceDm(s1, { t: "apply-scene-patches", patches: patchesFor(s1.scene, (d) => void ((d.grid.cellSize = 10), (d.grid.width = 5), (d.grid.depth = 5))) })
    const m = decodeMask(r.state.explored.p1[ground])
    const set: number[] = []
    for (let c = 0; c < 25; c++) if ((m.bits[c >> 3] >> (c & 7)) & 1) set.push(c)
    // New cell (0, 0) covers the explored block; new cell (2, 0) covers old cells 4–5 of which only 4 was explored.
    expect(set).toEqual([0])
  })

  it("drops a deleted level's masks and memory", () => {
    const { scene, ground, crate } = setup()
    const upper = addLevel(scene, { name: "Upper", elevation: 10 }, { x: 0, z: 0, w: 50, d: 50 })
    const upperCrate = add(scene, createProp(upper.id, "crate", { x: 7.5, y: 0, z: 7.5 }))
    let state = createGameState({ sessionId: "s", roomCode: "R", scene })
    state = reduceDm(state, { t: "add-player", userId: "p1", displayName: "Ann" }).state
    state = perceive(state, "p1", ground, [[2, 2]], [crate.id])
    state = perceive(state, "p1", upper.id, [[1, 1]], [upperCrate.id])
    expect(Object.keys(state.explored.p1).sort()).toEqual([ground, upper.id].sort())
    const patches = patchesFor(state.scene, (d) => {
      delete d.levels[upper.id]
      delete d.objects[upperCrate.id]
      for (const [id, o] of Object.entries(d.objects)) if (o.levelId === upper.id) delete d.objects[id]
    })
    const r = reduceDm(state, { t: "apply-scene-patches", patches })
    expect(Object.keys(r.state.explored.p1)).toEqual([ground])
    expect(r.state.memory.p1[upperCrate.id]).toBeUndefined()
    expect(r.state.memory.p1[crate.id]).toBeDefined()
  })

  it("drops ownership of deleted tokens", () => {
    const { pc, state: s0 } = setup()
    const s1 = reduceDm(s0, { t: "assign-token", tokenId: pc.id, userId: "p1", assigned: true }).state
    const r = reduceDm(s1, { t: "apply-scene-patches", patches: [{ op: "remove", path: ["tokens", pc.id] }] })
    expect(r.state.owners[pc.id]).toBeUndefined()
  })
})

describe("session commands", () => {
  it("load-scene swaps the map and resets knowledge", () => {
    const { ground, crate, pc, state: s0 } = setup()
    let state = reduceDm(s0, { t: "assign-token", tokenId: pc.id, userId: "p1", assigned: true }).state
    state = perceive(state, "p1", ground, [[2, 2]], [crate.id])
    const next = flatScene(8, 8).scene
    const r = reduceDm(state, { t: "load-scene", scene: next })
    expect(r.state.scene).toBe(next)
    expect(r.state.explored).toEqual({})
    expect(r.state.memory).toEqual({})
    expect(r.state.revealed).toEqual({})
    expect(r.state.owners).toEqual({})
    expect(r.state.players).toBe(state.players)
    expect(r.delta.structure).toBe(true)
    expect(r.delta.objects).toContain(crate.id)
  })

  it("add-player / remove-player", () => {
    const { pc, state: s0 } = setup()
    expect(s0.players.p1).toMatchObject({ userId: "p1", displayName: "Ann", movementLocked: false })
    expect(s0.players.p1.color).toMatch(/^#[0-9a-f]{6}$/)
    const renamed = reduceDm(s0, { t: "add-player", userId: "p1", displayName: "Anne" })
    expect(renamed.state.players.p1.displayName).toBe("Anne")
    expect(renamed.state.players.p1.color).toBe(s0.players.p1.color)
    let state = reduceDm(s0, { t: "assign-token", tokenId: pc.id, userId: "p1", assigned: true }).state
    state = perceive(state, "p1", Object.keys(state.scene.levels)[0], [[1, 1]], [])
    const r = reduceDm(state, { t: "remove-player", userId: "p1" })
    expect(r.state.players.p1).toBeUndefined()
    expect(r.state.explored.p1).toBeUndefined()
    expect(r.state.memory.p1).toBeUndefined()
    expect(r.state.owners[pc.id]).toBeUndefined()
  })

  it("rebind-player re-keys players, explored, memory, owners and revealed", () => {
    const { ground, crate, pc, door, state: s0 } = setup()
    let state = reduceDm(s0, { t: "assign-token", tokenId: pc.id, userId: "p1", assigned: true }).state
    state = perceive(state, "p1", ground, [[2, 2]], [crate.id])
    state = { ...state, revealed: { p1: [door.id] } }
    const r = reduceDm(state, { t: "rebind-player", fromUserId: "p1", toUserId: "p9" })
    expect(r.state.players.p1).toBeUndefined()
    expect(r.state.players.p9).toMatchObject({ userId: "p9", displayName: "Ann" })
    expect(r.state.explored.p9).toBe(state.explored.p1)
    expect(r.state.memory.p9).toBe(state.memory.p1)
    expect(r.state.revealed).toEqual({ p9: [door.id] })
    expect(r.state.owners[pc.id]).toEqual(["p9"])
    expect(r.dirtyPlayers).toEqual(["p1", "p9"])
  })

  it("reset-fog clears explored and memory for one or all players", () => {
    const { ground, crate, state: s0 } = setup()
    let state = perceive(s0, "p1", ground, [[2, 2]], [crate.id])
    state = perceive(state, "p2", ground, [[2, 2]], [crate.id])
    const one = reduceDm(state, { t: "reset-fog", userId: "p1" }).state
    expect(one.explored.p1).toEqual({})
    expect(one.memory.p1).toEqual({})
    expect(one.memory.p2[crate.id]).toBeDefined()
    const all = reduceDm(state, { t: "reset-fog" }).state
    expect(all.memory.p2).toEqual({})
  })
})

describe("encoded masks survive the state", () => {
  it("explored masks are plain JSON", () => {
    const { ground, state: s0 } = setup()
    const s = perceive(s0, "p1", ground, [[3, 3]], [])
    const round = JSON.parse(JSON.stringify(s.explored))
    expect(round).toEqual(s.explored)
    const m = createCellMask(10, 10)
    setCell(m, 33, true)
    expect(round.p1[ground]).toEqual(encodeMask(m))
  })
})

describe("origin", () => {
  it("scene patches mark the live map dirty; play commands do not", () => {
    const { scene, door, light, pc, state: s0 } = setup()
    const start: GameState = { ...s0, origin: { sceneId: "lib", version: 3, dirty: false } }
    let state = start
    const run = (cmd: DmCommand) => (state = reduceDm(state, cmd).state)
    run({ t: "move-token", tokenId: pc.id, levelId: pc.levelId, x: 12.5, z: 7.5 })
    run({ t: "set-door", doorId: door.id, state: "open" })
    run({ t: "set-light", lightId: light.id, on: false })
    run({ t: "set-shared-vision", enabled: true })
    expect(state.origin).toEqual({ sceneId: "lib", version: 3, dirty: false })
    // An empty patch list is a no-op.
    run({ t: "apply-scene-patches", patches: [] })
    expect(state.origin?.dirty).toBe(false)
    run({ t: "apply-scene-patches", patches: [{ op: "replace", path: ["objects", light.id, "brightRadius"], value: 12 }] })
    expect(state.origin).toEqual({ sceneId: "lib", version: 3, dirty: true })
    expect(start.origin?.dirty).toBe(false)
    // Saved back to the library: clean at the new version.
    run({ t: "set-origin", origin: { sceneId: "lib", version: 4, dirty: false } })
    expect(state.origin).toEqual({ sceneId: "lib", version: 4, dirty: false })
    // Another map: the old origin no longer applies unless one is given.
    run({ t: "load-scene", scene: structuredClone(scene) })
    expect(state.origin).toBeNull()
    run({ t: "load-scene", scene: structuredClone(scene), origin: { sceneId: "other", version: 1, dirty: false } })
    expect(state.origin).toEqual({ sceneId: "other", version: 1, dirty: false })
  })

  it("scene patches on a state without an origin leave it absent", () => {
    const { light, state: s0 } = setup()
    const s1 = reduceDm(s0, { t: "apply-scene-patches", patches: [{ op: "replace", path: ["objects", light.id, "brightRadius"], value: 12 }] }).state
    expect("origin" in s1).toBe(false)
    expect(createGameState({ sessionId: "s", roomCode: "R", scene: s0.scene, origin: { sceneId: "x", version: null, dirty: false } }).origin).toEqual({ sceneId: "x", version: null, dirty: false })
  })
})
