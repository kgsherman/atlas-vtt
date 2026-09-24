/**
 * GameState persistence: lossless round trip, strict rejection of malformed data, and dropping of
 * dangling references (so a state saved around a scene edit still loads).
 */
import { describe, expect, it } from "vitest"

import { sampleById } from "../scene/samples"
import { emptyEncodedMask } from "../vision/mask"
import { parseGameState, parseGameStateDetailed, parseGameStateJson, serializeGameState } from "./persist"
import { TestHost } from "./test-utils"
import type { GameState } from "./types"

/** A played Crooked Lantern: two players, explored masks, memory, a revealed secret door. */
function playedState(): GameState {
  const scene = sampleById("crooked-lantern")!.build()
  const byName = (name: string) => Object.values(scene.objects).find((o) => o.name === name)!
  const tokenByName = (name: string) => Object.values(scene.tokens).find((t) => t.name === name)!
  const host = new TestHost(scene, ["p1", "p2"])
  host.assign(tokenByName("Brunhild Ironvein").id, "p1")
  host.assign(tokenByName("Pip Thistledown").id, "p2")
  host.dm({ t: "set-movement-locked", locked: true, userId: "p2" })
  host.dm({ t: "reveal-object", objectId: byName("Secret door (loose stones)").id, userId: "p1" })
  host.refresh("p1")
  host.refresh("p2")
  return host.state
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

describe("serializeGameState / parseGameState", () => {
  it("round-trips a played session losslessly", () => {
    const state = playedState()
    expect(Object.keys(state.explored.p1).length).toBeGreaterThan(0)
    expect(Object.keys(state.memory.p1).length).toBeGreaterThan(0)
    const parsed = parseGameStateJson(serializeGameState(state))
    expect(parsed).not.toBeNull()
    expect(parsed).toEqual(clone(state))
    // Idempotent.
    expect(JSON.parse(serializeGameState(parsed!))).toEqual(JSON.parse(serializeGameState(state)))
  })

  it("keeps remembered masked floors (battlemap caves, upper storeys) and rejects a malformed mask", () => {
    const state = playedState()
    const levelId = Object.values(state.scene.levels)[0].id
    const floor = {
      id: "cave",
      type: "floor",
      levelId,
      rect: { x: 0, z: 0, w: 10, d: 5 },
      material: "stone",
      // 8 × 4 mask cells of 1.25 ft: 32 bits.
      mask: { spacing: 1.25, cols: 8, rows: 4, b64: "/w8A8A==" },
    }
    state.memory.p1 = { ...state.memory.p1, cave: floor as unknown as GameState["memory"][string][string] }
    const parsed = parseGameStateJson(serializeGameState(state))
    expect(parsed?.memory.p1.cave).toEqual(floor)
    const bad = clone(state) as unknown as { memory: Record<string, Record<string, { mask: { b64: string } }>> }
    bad.memory.p1.cave.mask.b64 = "AAAA"
    expect(parseGameState(bad)).toBeNull()
  })

  it("loads remembered walls saved before followTerrain existed (they follow the terrain); never a remembered terrainProfile", () => {
    const state = playedState()
    const wallIds = Object.keys(state.memory.p1).filter((id) => state.memory.p1[id].type === "wall")
    expect(wallIds.length).toBeGreaterThan(0)
    const old = clone(state) as unknown as { memory: Record<string, Record<string, Record<string, unknown>>> }
    for (const id of wallIds) delete old.memory.p1[id].followTerrain
    const parsed = parseGameState(old)
    expect(parsed).not.toBeNull()
    // Normalised to what sanitising the (migrated) scene walls gives, so re-observing them changes nothing.
    expect(parsed!.memory).toEqual(clone(state.memory))
    for (const id of wallIds) expect(parsed!.memory.p1[id]).toMatchObject({ type: "wall", followTerrain: true })
    const withProfile = clone(state) as unknown as { memory: Record<string, Record<string, Record<string, unknown>>> }
    withProfile.memory.p1[wallIds[0]].terrainProfile = [0, 0]
    expect(parseGameState(withProfile)).toBeNull()
  })

  it("rejects malformed shapes", () => {
    const base = clone(playedState()) as unknown as Record<string, unknown>
    const variants: Array<[string, (s: Record<string, unknown>) => unknown]> = [
      ["unknown top-level key", (s) => ({ ...s, extra: 1 })],
      ["wrong version", (s) => ({ ...s, stateVersion: 2 })],
      ["missing field", (s) => ({ ...s, seq: undefined })],
      ["negative seq", (s) => ({ ...s, seq: -1 })],
      ["non-object", () => 42],
      ["array", () => []],
      [
        "player key mismatch",
        (s) => {
          const players = s.players as Record<string, { userId: string }>
          return { ...s, players: { ...players, p1: { ...players.p1, userId: "zz" } } }
        },
      ],
      [
        "player with an extra field",
        (s) => {
          const players = s.players as Record<string, object>
          return { ...s, players: { ...players, p1: { ...players.p1, isDm: true } } }
        },
      ],
      [
        "explored mask with the wrong byte length",
        (s) => {
          const ex = s.explored as Record<string, Record<string, { b64: string }>>
          const [levelId, m] = Object.entries(ex.p1)[0]
          return { ...s, explored: { ...ex, p1: { ...ex.p1, [levelId]: { ...m, b64: m.b64 + "AAAA" } } } }
        },
      ],
      [
        "explored mask with an unknown field",
        (s) => {
          const ex = s.explored as Record<string, Record<string, object>>
          const [levelId, m] = Object.entries(ex.p1)[0]
          return { ...s, explored: { ...ex, p1: { ...ex.p1, [levelId]: { ...m, owner: "dm" } } } }
        },
      ],
      [
        "memory entry carrying DM-only fields",
        (s) => {
          const mem = s.memory as Record<string, Record<string, object>>
          const [id, o] = Object.entries(mem.p1)[0]
          return { ...s, memory: { ...mem, p1: { ...mem.p1, [id]: { ...o, dmNotes: "secret" } } } }
        },
      ],
      [
        "memory key mismatch",
        (s) => {
          const mem = s.memory as Record<string, Record<string, object>>
          const [, o] = Object.entries(mem.p1)[0]
          return { ...s, memory: { ...mem, p1: { ...mem.p1, other_id: o } } }
        },
      ],
      ["invalid scene", (s) => ({ ...s, scene: { ...(s.scene as object), grid: "big" } })],
      ["revealed not an array", (s) => ({ ...s, revealed: { p1: "door" } })],
      ["owners with a bad user id", (s) => ({ ...s, owners: { tok: ["has space"] } })],
    ]
    expect(parseGameState(base)).not.toBeNull()
    for (const [name, mutate] of variants) {
      const res = parseGameStateDetailed(mutate(base))
      expect(res.ok, name).toBe(false)
    }
  })

  it("rejects __proto__ keys anywhere a record key is read", () => {
    const base = serializeGameState(playedState())
    const withProto = base.replace('"players":{', '"players":{"__proto__":{"userId":"__proto__","displayName":"x","color":"#000000","movementLocked":false},')
    expect(withProto).not.toBe(base)
    expect(parseGameStateJson(withProto)).toBeNull()
    expect(parseGameStateJson("{not json")).toBeNull()
  })

  it("drops dangling references instead of rejecting the state", () => {
    const state = clone(playedState())
    const levelId = Object.keys(state.scene.levels)[0]
    const tokenId = Object.keys(state.scene.tokens)[0]
    const g = state.scene.grid
    const mutated = {
      ...state,
      owners: { ...state.owners, missing_token: ["p1"], [tokenId]: ["p1", "p1", "ghost"] },
      explored: {
        ...state.explored,
        ghost: { [levelId]: emptyEncodedMask(g.width, g.depth) },
        p2: { ...state.explored.p2, missing_level: emptyEncodedMask(g.width, g.depth), [levelId]: emptyEncodedMask(g.width + 1, g.depth) },
      },
      memory: {
        ...state.memory,
        ghost: {},
        p2: {
          ...state.memory.p2,
          floaty: { id: "floaty", type: "pillar", levelId: "missing_level", position: { x: 1, z: 1 }, shape: "round", size: 1, height: null, material: "stone" },
        },
      },
      revealed: { ...state.revealed, ghost: ["x"], p2: ["b", "a", "b"] },
    }
    const parsed = parseGameState(mutated)!
    expect(parsed).not.toBeNull()
    expect(parsed.owners.missing_token).toBeUndefined()
    expect(parsed.owners[tokenId]).toEqual(["p1"])
    expect(parsed.explored.ghost).toBeUndefined()
    expect(parsed.explored.p2.missing_level).toBeUndefined()
    // A mask for another grid size is dropped.
    expect(parsed.explored.p2[levelId]).toBeUndefined()
    expect(parsed.memory.ghost).toBeUndefined()
    expect(parsed.memory.p2.floaty).toBeUndefined()
    expect(parsed.revealed.ghost).toBeUndefined()
    expect(parsed.revealed.p2).toEqual(["a", "b"])
    // Everything else is untouched.
    expect(parsed.memory.p1).toEqual(state.memory.p1)
    expect(parsed.explored.p1).toEqual(state.explored.p1)
  })
})

describe("origin (the library scene the live map comes from)", () => {
  it("round-trips with and without an origin; states saved before the field still load", () => {
    const state = playedState()
    expect(state.origin).toBeUndefined()
    const plain = parseGameStateJson(serializeGameState(state))
    expect(plain).toEqual(clone(state))
    expect(plain && "origin" in plain).toBe(false)
    for (const origin of [{ sceneId: "lib-1", version: 7, dirty: true }, { sceneId: "lib-2", version: null, dirty: false }, null]) {
      const withOrigin: GameState = { ...state, origin }
      const parsed = parseGameStateJson(serializeGameState(withOrigin))
      expect(parsed?.origin).toEqual(origin)
      expect(parsed).toEqual(clone(withOrigin))
    }
  })

  it("rejects a malformed origin", () => {
    const state = playedState()
    for (const origin of [{ sceneId: "", version: 1, dirty: false }, { sceneId: "a", version: -1, dirty: false }, { sceneId: "a", version: 1.5, dirty: false }, { sceneId: "a", version: 1, dirty: "yes" }, { sceneId: "a", version: 1, dirty: false, extra: 1 }]) {
      expect(parseGameState({ ...clone(state), origin }), JSON.stringify(origin)).toBeNull()
    }
  })
})

describe("freeMovement (players may move off the grid)", () => {
  it("round-trips; states saved before the field still load", () => {
    const state = playedState()
    expect("freeMovement" in state).toBe(false)
    for (const freeMovement of [true, false]) expect(parseGameStateJson(serializeGameState({ ...state, freeMovement }))?.freeMovement).toBe(freeMovement)
    expect(parseGameState({ ...clone(state), freeMovement: "yes" })).toBeNull()
  })
})

describe("freeAssets (the free asset categories a game loads)", () => {
  it("round-trips; states saved before the field still load; unknown categories are dropped", () => {
    const state = playedState()
    expect("freeAssets" in state).toBe(false)
    for (const freeAssets of [[], ["token-models"]] as GameState["freeAssets"][]) {
      const parsed = parseGameStateJson(serializeGameState({ ...state, freeAssets }))
      expect(parsed?.freeAssets).toEqual(freeAssets)
    }
    // A newer app's category is ignored rather than making the game unloadable.
    expect(parseGameState({ ...clone(state), freeAssets: ["maps", "token-models", "token-models"] })?.freeAssets).toEqual(["token-models"])
  })

  it("rejects a malformed list", () => {
    const state = playedState()
    for (const freeAssets of ["token-models", [1], new Array(17).fill("token-models")]) {
      expect(parseGameState({ ...clone(state), freeAssets }), JSON.stringify(freeAssets)).toBeNull()
    }
  })
})
