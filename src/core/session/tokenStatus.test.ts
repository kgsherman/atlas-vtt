/**
 * Token hit points and conditions in play: what each player is sent (exact for their own and party
 * tokens, a band for others unless the DM hides wounds, conditions for whoever sees the token), the DM's
 * set-token-status, a player's own token-status request, the wire and storage schemas.
 */
import { describe, expect, it } from "vitest"

import type { Id } from "../scene/types"
import type { VisibilityResult } from "../vision/types"
import { filterForPlayer } from "./filter"
import { parseGameState, serializeGameState } from "./persist"
import { parsePlayerView } from "./playerViewSchema"
import { parseClientMessage } from "./protocol"
import { reduceDm } from "./reduceDm"
import { reduceRequest } from "./reduceRequest"
import { createGameState } from "./state"
import { addToken, flatScene } from "./test-utils"
import type { DmCommand, GameState, StateRequest } from "./index"

const ALICE = "user-alice"
const BOB = "user-bob"

function game() {
  const { scene, ground } = flatScene(20, 20)
  const pip = addToken(scene, ground, 12.5, 12.5, { name: "Pip", label: "Pip", kind: "pc" }).id
  const bram = addToken(scene, ground, 22.5, 12.5, { name: "Bram", label: "Bram", kind: "pc" }).id
  const orc = addToken(scene, ground, 52.5, 52.5, { name: "Orc chief", label: "Orc", kind: "monster" }).id
  const ghost = addToken(scene, ground, 62.5, 22.5, { name: "Ghost", label: "Ghost", hidden: true }).id
  let state = createGameState({ sessionId: "s", roomCode: "R", scene, origin: { sceneId: "lib1", version: 3, dirty: false } })
  const dm = (cmd: DmCommand) => {
    const r = reduceDm(state, cmd)
    expect(r.error).toBeUndefined()
    state = r.state
  }
  dm({ t: "add-player", userId: ALICE, displayName: "Alice" })
  dm({ t: "add-player", userId: BOB, displayName: "Bob" })
  dm({ t: "assign-token", tokenId: pip, userId: ALICE, assigned: true })
  dm({ t: "assign-token", tokenId: bram, userId: BOB, assigned: true })
  dm({ t: "set-token-status", tokenId: pip, hp: { current: 9, max: 12, temp: 2 }, conditions: ["prone"] })
  dm({ t: "set-token-status", tokenId: bram, hp: { current: 20, max: 20, temp: 0 } })
  dm({ t: "set-token-status", tokenId: orc, hp: { current: 14, max: 30, temp: 0 }, conditions: ["poisoned", "frightened"] })
  dm({ t: "set-token-status", tokenId: ghost, hp: { current: 5, max: 5, temp: 0 }, conditions: ["invisible"] })
  return { state, pip, bram, orc, ghost }
}

const sees = (...ids: Id[]): VisibilityResult => ({
  perception: {},
  sunlit: {},
  visibleTokenIds: new Set(ids),
  observedObjectIds: new Set(),
  illuminatingLightIds: new Set(),
})

describe("token status: what players are sent", () => {
  it("exact hit points for one's own tokens, a band for others, conditions for whoever sees", () => {
    const { state, pip, bram, orc, ghost } = game()
    const view = filterForPlayer(state, ALICE, sees(bram, orc, ghost))
    expect(view.tokens[pip]).toMatchObject({ hp: { current: 9, max: 12, temp: 2 }, conditions: ["prone"] })
    expect(view.tokens[pip].health).toBeUndefined()
    expect(view.tokens[bram]).toMatchObject({ health: "unhurt" })
    expect(view.tokens[bram].hp).toBeUndefined()
    // Conditions are stored in catalog order.
    expect(view.tokens[orc]).toMatchObject({ health: "bloodied", conditions: ["frightened", "poisoned"] })
    expect(view.tokens[orc].hp).toBeUndefined()
    expect(view.tokens[ghost]).toBeUndefined()
    const json = JSON.stringify(view)
    expect(json).not.toContain('"max":30')
    expect(json).not.toContain("invisible")
    expect(parsePlayerView(JSON.parse(json))).toEqual(view)
  })

  it("shared vision gives party members each other's exact hit points", () => {
    const g = game()
    const state = reduceDm(g.state, { t: "set-shared-vision", enabled: true }).state
    expect(filterForPlayer(state, ALICE, sees()).tokens[g.bram]).toMatchObject({ hp: { current: 20, max: 20, temp: 0 } })
  })

  it("the DM can hide wounds: no bands for others (own tokens keep their numbers)", () => {
    const g = game()
    const state = reduceDm(g.state, { t: "set-hide-wounds", hidden: true }).state
    const view = filterForPlayer(state, ALICE, sees(g.orc))
    expect(view.tokens[g.orc].health).toBeUndefined()
    expect(view.tokens[g.orc].conditions).toEqual(["frightened", "poisoned"])
    expect(view.tokens[g.pip].hp).toEqual({ current: 9, max: 12, temp: 2 })
    expect(parseGameState(JSON.parse(serializeGameState(state)))?.hideWounds).toBe(true)
  })

  it("rejects views carrying anything but the allowed shapes", () => {
    const { state, orc } = game()
    const view = JSON.parse(JSON.stringify(filterForPlayer(state, ALICE, sees(orc))))
    view.tokens[orc].health = "mostly dead"
    expect(parsePlayerView(view)).toBeNull()
  })
})

describe("token status: changes", () => {
  it("the DM's set-token-status clamps, normalizes, and is a play action", () => {
    const { state, orc } = game()
    const r = reduceDm(state, {
      t: "set-token-status",
      tokenId: orc,
      hp: { current: 50, max: 30.4, temp: -1 },
      conditions: ["prone", "prone", "sleepy" as never],
    })
    expect(r.state.scene.tokens[orc]).toMatchObject({ hp: { current: 30, max: 30, temp: 0 }, conditions: ["prone"] })
    expect(r.dirtyPlayers).toBe("all")
    expect(r.delta).toEqual({ objects: [], tokens: [], terrain: [], structure: false })
    // Not a map edit: "Save map to library" is not nagged about it.
    expect(r.state.origin?.dirty).toBe(false)
    expect(reduceDm(r.state, { t: "set-token-status", tokenId: orc, conditions: ["prone"] }).state).toBe(r.state)
    const cleared = reduceDm(r.state, { t: "set-token-status", tokenId: orc, hp: null, conditions: [] }).state
    expect(cleared.scene.tokens[orc].hp).toBeUndefined()
    expect(cleared.scene.tokens[orc].conditions).toBeUndefined()
    expect(reduceDm(state, { t: "set-token-status", tokenId: "nope", conditions: [] }).error).toBe("unknown token")
  })

  it("a player changes only their own token, within the DM's max", () => {
    const g = game()
    const req = (uid: string, msg: Omit<Extract<StateRequest, { t: "token-status" }>, "t" | "reqId">, state: GameState = g.state) =>
      reduceRequest(state, uid, { t: "token-status", reqId: "r", ...msg }, { world: null as never, currentView: null, perceivedByPlayer: () => false })
    expect(req(ALICE, { tokenId: g.orc, conditions: { remove: ["poisoned"] } }).result.reason).toBe("not-owner")
    expect(req(ALICE, { tokenId: g.bram, conditions: { add: ["prone"] } }).result.reason).toBe("not-owner")
    // Pip: 9 / 12, 2 temporary, prone.
    const healed = req(ALICE, { tokenId: g.pip, hp: { kind: "heal", amount: 99 }, conditions: { add: ["concentrating"], remove: ["prone"] } })
    expect(healed.result).toEqual({ reqId: "r", ok: true })
    expect(healed.state.scene.tokens[g.pip]).toMatchObject({ hp: { current: 12, max: 12, temp: 2 }, conditions: ["concentrating"] })
    expect(req(ALICE, { tokenId: g.pip, hp: { kind: "damage", amount: 5 } }).state.scene.tokens[g.pip].hp).toEqual({ current: 6, max: 12, temp: 0 })
    expect(req(ALICE, { tokenId: g.pip, hp: { kind: "temp", amount: 1 } }).state).toBe(g.state)
    // Hit points the DM does not track cannot be changed by the player.
    const untracked = reduceDm(g.state, { t: "set-token-status", tokenId: g.pip, hp: null }).state
    expect(req(ALICE, { tokenId: g.pip, hp: { kind: "heal", amount: 5 } }, untracked).result.reason).toBe("cannot")
    // Conditions still work on a token whose hit points are not tracked.
    expect(req(ALICE, { tokenId: g.pip, conditions: { add: ["blinded"] } }, untracked).state.scene.tokens[g.pip].conditions).toEqual(["blinded", "prone"])
    // A hidden token is gone as far as its player knows.
    const tokens = g.state.scene.tokens
    const hidden: GameState = { ...g.state, scene: { ...g.state.scene, tokens: { ...tokens, [g.pip]: { ...tokens[g.pip], hidden: true } } } }
    expect(req(ALICE, { tokenId: g.pip, conditions: { add: ["prone"] } }, hidden).result.reason).toBe("unknown-token")
  })

  it("changes made from the same stale view both count, and never undo the DM's", () => {
    const g = game()
    const ctx = { world: null as never, currentView: null, perceivedByPlayer: () => false }
    const req = (state: GameState, msg: Omit<Extract<StateRequest, { t: "token-status" }>, "t" | "reqId">) =>
      reduceRequest(state, ALICE, { t: "token-status", reqId: "r", ...msg }, ctx).state
    // Two quick ticks in the conditions menu, both sent before the first result came back.
    let s = req(g.state, { tokenId: g.pip, conditions: { add: ["poisoned"] } })
    s = req(s, { tokenId: g.pip, conditions: { add: ["blinded"] } })
    expect(s.scene.tokens[g.pip].conditions).toEqual(["blinded", "poisoned", "prone"])
    // The DM deals 8 damage (Pip: 9 + 2 temporary) while the player adds temporary hit points: both stand.
    s = reduceDm(s, { t: "change-token-status", tokenId: g.pip, hp: { kind: "damage", amount: 8 } }).state
    expect(s.scene.tokens[g.pip].hp).toEqual({ current: 3, max: 12, temp: 0 })
    s = req(s, { tokenId: g.pip, hp: { kind: "temp", amount: 5 } })
    expect(s.scene.tokens[g.pip].hp).toEqual({ current: 3, max: 12, temp: 5 })
    // Two quick damage entries both land (5 temporary, then 3 current, then down).
    s = req(req(s, { tokenId: g.pip, hp: { kind: "damage", amount: 3 } }), { tokenId: g.pip, hp: { kind: "damage", amount: 3 } })
    expect(s.scene.tokens[g.pip].hp).toEqual({ current: 2, max: 12, temp: 0 })
    s = req(s, { tokenId: g.pip, hp: { kind: "damage", amount: 3 } })
    expect(s.scene.tokens[g.pip].hp).toEqual({ current: 0, max: 12, temp: 0 })
  })

  it("the DM's change-token-status applies to the token as the host holds it", () => {
    const g = game()
    const dm = (state: GameState, cmd: DmCommand) => reduceDm(state, cmd)
    // A player ticked Concentrating a moment before the DM's menu (which still showed only Prone) adds Blinded.
    const s0 = reduceRequest(
      g.state,
      ALICE,
      { t: "token-status", reqId: "r", tokenId: g.pip, conditions: { add: ["concentrating"] } },
      { world: null as never, currentView: null, perceivedByPlayer: () => false }
    ).state
    const r = dm(s0, { t: "change-token-status", tokenId: g.pip, conditions: { add: ["blinded"] }, hp: { kind: "max", max: 20 } })
    expect(r.state.scene.tokens[g.pip]).toMatchObject({ hp: { current: 17, max: 20, temp: 2 }, conditions: ["blinded", "prone", "concentrating"] })
    expect(r.dirtyPlayers).toBe("all")
    expect(r.state.origin?.dirty).toBe(false)
    // Typed values change only their own field.
    expect(dm(r.state, { t: "change-token-status", tokenId: g.pip, hp: { kind: "set", temp: 0 } }).state.scene.tokens[g.pip].hp).toEqual({
      current: 17,
      max: 20,
      temp: 0,
    })
    // Hit points that are not tracked are left alone; nothing to change keeps the state.
    expect(dm(g.state, { t: "change-token-status", tokenId: g.ghost, hp: { kind: "heal", amount: 1 } }).state).toBe(g.state)
    const untracked = dm(g.state, { t: "set-token-status", tokenId: g.pip, hp: null }).state
    expect(dm(untracked, { t: "change-token-status", tokenId: g.pip, hp: { kind: "damage", amount: 3 } }).state).toBe(untracked)
    expect(dm(g.state, { t: "change-token-status", tokenId: "nope", conditions: { add: ["prone"] } }).error).toBe("unknown token")
  })

  it("accepts only well-formed requests on the wire", () => {
    expect(parseClientMessage({ t: "token-status", reqId: "r", tokenId: "t1", hp: { kind: "damage", amount: 3 } })).not.toBeNull()
    expect(parseClientMessage({ t: "token-status", reqId: "r", tokenId: "t1", conditions: { add: ["prone"] } })).not.toBeNull()
    expect(parseClientMessage({ t: "token-status", reqId: "r", tokenId: "t1", conditions: { remove: ["prone"], add: ["dead"] } })).not.toBeNull()
    for (const bad of [
      { t: "token-status", reqId: "r", tokenId: "t1" },
      { t: "token-status", reqId: "r", tokenId: "t1", hp: { current: 3, temp: 0 } },
      { t: "token-status", reqId: "r", tokenId: "t1", hp: { kind: "max", amount: 99 } },
      { t: "token-status", reqId: "r", tokenId: "t1", hp: { kind: "damage", amount: 0 } },
      { t: "token-status", reqId: "r", tokenId: "t1", hp: { kind: "heal", amount: 2.5 } },
      { t: "token-status", reqId: "r", tokenId: "t1", hp: { kind: "damage", amount: 3, max: 99 } },
      { t: "token-status", reqId: "r", tokenId: "t1", conditions: ["prone"] },
      { t: "token-status", reqId: "r", tokenId: "t1", conditions: {} },
      { t: "token-status", reqId: "r", tokenId: "t1", conditions: { add: ["zombified"] } },
    ]) {
      expect(parseClientMessage(bad), JSON.stringify(bad)).toBeNull()
    }
  })
})
