/**
 * World characters at the table (ARCHITECTURE §6.9): owners of character tokens come from the world's roster
 * (GameState.characters), for players of the game only; the table cannot hand them out; linking a token,
 * a new player, a map change and a guest merge keep them derived; the roster is saved with the game and
 * never reaches a player.
 */
import { produceWithPatches } from "immer"
import { describe, expect, it } from "vitest"

import { newId } from "../scene/factory"
import type { Scene } from "../scene/types"
import { carryParty, changeMapCommand } from "./changeMap"
import { characterOwners, isCharacterToken, syncCharacterOwners } from "./characters"
import { parseGameState, serializeGameState } from "./persist"
import { reduceDm } from "./reduceDm"
import { addToken, flatScene, TestHost } from "./test-utils"
import type { TableCharacter } from "./types"

const ARIA = "3f2b8c1e-0d4a-4a9b-9c1e-5b6d7e8f9a0b"
const BORIN = "7a1e2d3c-4b5a-4f6e-8d7c-9b0a1f2e3d4c"

function table() {
  const { scene, ground } = flatScene(12, 12)
  const aria = addToken(scene, ground, 12.5, 12.5, { name: "Aria", kind: "pc", characterId: ARIA })
  const borin = addToken(scene, ground, 22.5, 12.5, { name: "Borin", kind: "pc", characterId: BORIN })
  const wolf = addToken(scene, ground, 32.5, 12.5, { name: "Wolf", kind: "npc" })
  const host = new TestHost(scene, ["p1", "p2"])
  return { scene, ground, host, aria, borin, wolf }
}

const roster = (entries: Record<string, string[]>): Record<string, TableCharacter> =>
  Object.fromEntries(Object.entries(entries).map(([id, players]) => [id, { name: id === ARIA ? "Aria" : "Borin", players }]))

describe("owners of character tokens", () => {
  it("come from the roster: its players who are players of the game, and nobody else", () => {
    const { host, aria, borin, wolf } = table()
    host.assign(wolf.id, "p2")
    const r = host.dm({ t: "set-characters", characters: roster({ [ARIA]: ["p1", "stranger"], [BORIN]: ["p2", "p1"] }) })
    expect(r.error).toBeUndefined()
    expect(host.state.owners).toEqual({ [aria.id]: ["p1"], [borin.id]: ["p1", "p2"], [wolf.id]: ["p2"] })
    expect(host.state.characters![BORIN].players).toEqual(["p1", "p2"])
    expect(r.dirtyPlayers).toEqual(["p1", "p2"])
    // The same roster again changes nothing.
    expect(host.dm({ t: "set-characters", characters: roster({ [ARIA]: ["stranger", "p1"], [BORIN]: ["p1", "p2"] }) }).state).toBe(host.state)
  })

  it("only the players whose control changed are dirty (everyone with shared vision)", () => {
    const { host } = table()
    host.dm({ t: "set-characters", characters: roster({ [ARIA]: ["p1"], [BORIN]: [] }) })
    expect(host.dm({ t: "set-characters", characters: roster({ [ARIA]: ["p1"], [BORIN]: ["p2"] }) }).dirtyPlayers).toEqual(["p2"])
    // A renamed character is DM-only data.
    expect(host.dm({ t: "set-characters", characters: { ...host.state.characters!, [ARIA]: { name: "Aria Vey", players: ["p1"] } } }).dirtyPlayers).toEqual([])
    host.dm({ t: "set-shared-vision", enabled: true })
    expect(host.dm({ t: "set-characters", characters: roster({ [ARIA]: [], [BORIN]: ["p2"] }) }).dirtyPlayers).toBe("all")
  })

  it("a character gone from the roster leaves its tokens with nobody; without a roster nothing is derived", () => {
    const { host, aria, borin } = table()
    host.assign(aria.id, "p1")
    expect(isCharacterToken(host.state, aria.id)).toBe(false)
    expect(host.state.owners[aria.id]).toEqual(["p1"])
    host.dm({ t: "set-characters", characters: roster({ [BORIN]: ["p2"] }) })
    expect(host.state.owners).toEqual({ [borin.id]: ["p2"] })
    expect(characterOwners(host.state, { characterId: ARIA })).toEqual([])
    expect(characterOwners(host.state, {})).toBeNull()
  })

  it("the table cannot hand out a character token, but still any other", () => {
    const { host, aria, wolf } = table()
    host.dm({ t: "set-characters", characters: roster({ [ARIA]: ["p1"] }) })
    const r = host.dm({ t: "assign-token", tokenId: aria.id, userId: "p2", assigned: true })
    expect(r.error).toMatch(/world/)
    expect(host.state.owners[aria.id]).toEqual(["p1"])
    host.assign(wolf.id, "p2")
    expect(host.state.owners[wolf.id]).toEqual(["p2"])
  })

  it("a player who joins takes up the characters the world gave them", () => {
    const { host, aria } = table()
    host.dm({ t: "set-characters", characters: roster({ [ARIA]: ["p3"] }) })
    expect(host.state.owners[aria.id]).toBeUndefined()
    const r = host.dm({ t: "add-player", userId: "p3", displayName: "Pat" })
    expect(host.state.owners[aria.id]).toEqual(["p3"])
    expect(r.dirtyPlayers).toEqual(["p3"])
    // A kicked player loses them (and gets them back on returning).
    host.dm({ t: "remove-player", userId: "p3" })
    expect(host.state.owners[aria.id]).toBeUndefined()
    host.dm({ t: "add-player", userId: "p3", displayName: "Pat" })
    expect(host.state.owners[aria.id]).toEqual(["p3"])
  })

  it("linking a token to a character in the editor hands it to the character's players; unlinking takes it back", () => {
    const { host, wolf } = table()
    host.dm({ t: "set-characters", characters: roster({ [ARIA]: ["p2"] }) })
    const [, patches] = produceWithPatches(host.state.scene, (d: Scene) => {
      d.tokens[wolf.id].characterId = ARIA
    })
    const r = host.dm({ t: "apply-scene-patches", patches })
    expect(r.error).toBeUndefined()
    expect(host.state.owners[wolf.id]).toEqual(["p2"])
    // Unlinking (an undone link, say) takes it back from the character's players: a token of the table's now.
    const [, undo] = produceWithPatches(host.state.scene, (d: Scene) => {
      delete d.tokens[wolf.id].characterId
    })
    const r2 = host.dm({ t: "apply-scene-patches", patches: undo })
    expect(host.state.owners[wolf.id]).toBeUndefined()
    expect(isCharacterToken(host.state, wolf.id)).toBe(false)
    expect(r2.dirtyPlayers).toBe("all")
    // …and the table can hand it out again.
    host.assign(wolf.id, "p1")
    expect(host.state.owners[wolf.id]).toEqual(["p1"])
  })

  it("a guest merge moves the roster's user ids too", () => {
    const { host, aria } = table()
    host.dm({ t: "set-characters", characters: roster({ [ARIA]: ["p1"] }) })
    host.dm({ t: "rebind-player", fromUserId: "p1", toUserId: "acct" })
    expect(host.state.characters![ARIA].players).toEqual(["acct"])
    expect(host.state.owners[aria.id]).toEqual(["acct"])
  })

  it("syncCharacterOwners returns the same state when everything already follows the roster", () => {
    const { host } = table()
    host.dm({ t: "set-characters", characters: roster({ [ARIA]: ["p1"] }) })
    const r = syncCharacterOwners(host.state)
    expect(r.state).toBe(host.state)
    expect(r.changed).toEqual([])
  })
})

describe("characters and changing the scene", () => {
  it("an arriving character replaces that character's token on the target (and the light it carried)", () => {
    const t = table()
    const { scene: target, ground } = flatScene(12, 12)
    target.id = newId()
    const waiting = addToken(target, ground, 42.5, 42.5, { name: "Aria (placed)", kind: "pc", characterId: ARIA })
    const other = addToken(target, ground, 47.5, 42.5, { name: "Borin (placed)", kind: "pc", characterId: BORIN })
    const r = carryParty(t.scene, target, { tokenIds: [t.aria.id], arrival: { levelId: ground, x: 12.5, z: 12.5 } })
    if (!r.ok) throw new Error(r.error)
    expect(r.scene.tokens[waiting.id]).toBeUndefined()
    expect(
      Object.values(r.scene.tokens)
        .filter((x) => x.characterId === ARIA)
        .map((x) => x.id)
    ).toEqual([t.aria.id])
    // Borin did not travel: his placed token stays.
    expect(r.scene.tokens[other.id]).toEqual(other)
  })

  it("character tokens on the new scene belong to their players, carried or placed there beforehand", () => {
    const t = table()
    t.host.dm({ t: "set-characters", characters: roster({ [ARIA]: ["p1"], [BORIN]: ["p2"] }) })
    const { scene: target, ground } = flatScene(12, 12)
    target.id = newId()
    const placed = addToken(target, ground, 42.5, 42.5, { name: "Borin (placed)", kind: "pc", characterId: BORIN })
    const r = changeMapCommand(t.host.state, target, { tokenIds: [t.aria.id], arrival: { levelId: ground, x: 12.5, z: 12.5 } }, { now: 1, newId: () => "n1" })
    if (!r.ok) throw new Error(r.error)
    t.host.dm(r.cmd)
    expect(t.host.state.owners).toEqual({ [t.aria.id]: ["p1"], [placed.id]: ["p2"] })
  })
})

describe("the roster in storage and on the wire", () => {
  it("is saved with the game, normalised on load", () => {
    const { host } = table()
    host.dm({ t: "set-characters", characters: roster({ [ARIA]: ["p2", "p1"] }) })
    const loaded = parseGameState(JSON.parse(serializeGameState(host.state)))
    expect(loaded?.characters).toEqual({ [ARIA]: { name: "Aria", players: ["p1", "p2"] } })
    const raw = JSON.parse(serializeGameState(host.state))
    raw.characters[ARIA].players = ["p2", "p1", "p2"]
    expect(parseGameState(raw)?.characters?.[ARIA].players).toEqual(["p1", "p2"])
    raw.characters["bad id"] = { name: "x", players: [] }
    expect(parseGameState(raw)).toBeNull()
  })

  it("never reaches a player: no roster, no character ids in the view", () => {
    const { host, aria } = table()
    host.dm({ t: "set-characters", characters: roster({ [ARIA]: ["p1"] }) })
    const { view } = host.refresh("p1")
    expect(view.controlledTokenIds).toEqual([aria.id])
    const text = JSON.stringify(view)
    expect(text).not.toContain(ARIA)
    expect(text).not.toContain("characterId")
    expect(reduceDm(host.state, { t: "set-characters", characters: {} }).state.owners).toEqual({})
  })
})
