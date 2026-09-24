/**
 * The table (chat, dice, combat): audiences, host-side rolls, the initiative order and turns, what
 * filterForPlayer lets through (whispers, hidden or unseen combatants never), persistence and the wire.
 */
import { describe, expect, it } from "vitest"

import type { DiceRng } from "../dice/dice"
import type { Id, Scene } from "../scene/types"
import type { VisibilityResult } from "../vision/types"
import { applyPatchOps, diffViews } from "./diff"
import { filterForPlayer, pingForPlayer } from "./filter"
import { parseGameState, serializeGameState } from "./persist"
import { parsePlayerView } from "./playerViewSchema"
import { parseClientMessage } from "./protocol"
import { reduceDm } from "./reduceDm"
import { reduceRequest, type StateRequest } from "./reduceRequest"
import { createGameState } from "./state"
import { advanceTurn, DM_NAME, dmMessage, dmRollCommand, dmSayCommand, npcInitiativeCommand, sortCombat, TABLE_LIMITS, type TableContext } from "./table"
import { addToken, flatScene } from "./test-utils"
import type { Combat, CombatEntry, DmCommand, GameState, PlayerView, TableMessage } from "./types"

// Distinctive user ids, so a leak scan of a serialised view cannot match anything else.
const ALICE = "user-alice-7f3a"
const BOB = "user-bob-91c2"

function fixedDice(...values: number[]): DiceRng {
  let k = 0
  return (sides) => ((values[Math.min(k++, values.length - 1)] - 1) % sides) + 1
}

function ctx(now = 1000, dice: DiceRng = fixedDice(10)): TableContext {
  let n = 0
  return { now, newId: () => `msg${++n}x${now}`, rng: dice }
}

function world(): { scene: Scene; ground: Id; pip: Id; aldric: Id; goblin: Id; ogre: Id; spy: Id } {
  const { scene, ground } = flatScene(20, 20)
  const pip = addToken(scene, ground, 12.5, 12.5, { name: "Pip Thistledown", label: "Pip", kind: "pc" }).id
  const aldric = addToken(scene, ground, 22.5, 12.5, { name: "Ser Aldric", label: "Aldric", kind: "pc" }).id
  const goblin = addToken(scene, ground, 52.5, 52.5, { name: "Goblin Boss (DM name)", label: "Goblin", kind: "monster" }).id
  const ogre = addToken(scene, ground, 82.5, 82.5, { name: "Ogre", label: "Ogre", kind: "monster" }).id
  const spy = addToken(scene, ground, 62.5, 22.5, { name: "Spy", label: "Spy", kind: "npc", hidden: true }).id
  return { scene, ground, pip, aldric, goblin, ogre, spy }
}

function game(): { state: GameState } & ReturnType<typeof world> {
  const w = world()
  let state = createGameState({ sessionId: "s", roomCode: "R", scene: w.scene })
  const dm = (cmd: DmCommand) => {
    const r = reduceDm(state, cmd)
    expect(r.error).toBeUndefined()
    state = r.state
  }
  dm({ t: "add-player", userId: ALICE, displayName: "Alice" })
  dm({ t: "add-player", userId: BOB, displayName: "Bob" })
  dm({ t: "assign-token", tokenId: w.pip, userId: ALICE, assigned: true })
  dm({ t: "assign-token", tokenId: w.aldric, userId: BOB, assigned: true })
  return { state, ...w }
}

/** Visibility where the player sees the listed tokens (no cells: the table does not depend on them). */
function sees(...tokenIds: Id[]): VisibilityResult {
  return { perception: {}, sunlit: {}, visibleTokenIds: new Set(tokenIds), observedObjectIds: new Set(), illuminatingLightIds: new Set() }
}

function request(state: GameState, uid: string, msg: StateRequest, c: TableContext = ctx()) {
  return reduceRequest(state, uid, msg, {
    world: null as never,
    currentView: null,
    perceivedByPlayer: () => false,
    table: c,
  })
}

function dm(state: GameState, cmd: DmCommand): GameState {
  const r = reduceDm(state, cmd)
  expect(r.error).toBeUndefined()
  return r.state
}

function messages(view: PlayerView) {
  return Object.values(view.table?.log ?? {}).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
}

function entry(tokenId: Id | null, id: Id, partial: Partial<CombatEntry> = {}): CombatEntry {
  return { id, tokenId, name: "", initiative: null, modifier: 0, hidden: false, ...partial }
}

const stamp = (id: string, at = 5000) => ({ id, at })

describe("table messages", () => {
  it("public chat reaches every player; a whisper to the DM only its sender", () => {
    let { state } = game()
    const said = request(state, ALICE, { t: "say", reqId: "r1", text: "  Hello\u0000 there  ", to: "all" })
    expect(said.result).toEqual({ reqId: "r1", ok: true })
    expect(said.dirtyPlayers).toBe("all")
    state = said.state
    const whisper = request(state, BOB, { t: "say", reqId: "r2", text: "I pocket the gem", to: "dm" }, ctx(2000))
    expect(whisper.dirtyPlayers).toEqual([BOB])
    state = whisper.state

    const a = messages(filterForPlayer(state, ALICE, sees()))
    expect(a.map((m) => m.text)).toEqual(["Hello there"])
    expect(a[0]).toMatchObject({ kind: "chat", name: "Alice", mine: true, dm: false, whisper: false })

    const b = messages(filterForPlayer(state, BOB, sees()))
    expect(b.map((m) => m.text)).toEqual(["Hello there", "I pocket the gem"])
    expect(b[1]).toMatchObject({ mine: true, whisper: true, name: "Bob" })
    expect(b[0].mine).toBe(false)
  })

  it("the DM whispers to one player, or rolls in secret", () => {
    let { state } = game()
    state = dm(state, { t: "table-post", message: dmMessage({ stamp: stamp("w1"), kind: "chat", to: [BOB], text: "You hear a click" }) })
    const roll = {
      formula: "1d20",
      total: 17,
      terms: [{ kind: "dice" as const, sign: 1 as const, count: 1, sides: 20, explode: false, keep: null, rolls: [17], dropped: [] }],
    }
    state = dm(state, { t: "table-post", message: dmMessage({ stamp: stamp("s1", 6000), kind: "roll", to: [], text: "Stealth", roll }) })
    expect(state.table!.log).toHaveLength(2)
    expect(messages(filterForPlayer(state, ALICE, sees()))).toEqual([])
    const b = messages(filterForPlayer(state, BOB, sees()))
    expect(b).toHaveLength(1)
    expect(b[0]).toMatchObject({ name: DM_NAME, dm: true, whisper: true, text: "You hear a click", mine: false })
  })

  it("rolls are made by the host from the formula", () => {
    const { state } = game()
    const out = request(state, ALICE, { t: "roll", reqId: "r1", formula: "adv+5 to hit", to: "all" }, ctx(1000, fixedDice(4, 18)))
    expect(out.result.ok).toBe(true)
    const m = out.state.table!.log[0]
    expect(m).toMatchObject({ kind: "roll", text: "to hit", from: ALICE, to: "all" })
    expect(m.roll).toMatchObject({ formula: "2d20kh1 + 5", total: 23 })
    const bad = request(state, ALICE, { t: "roll", reqId: "r2", formula: "banana", to: "all" })
    expect(bad.result).toEqual({ reqId: "r2", ok: false, reason: "bad-formula" })
    expect(bad.state).toBe(state)
  })

  it("refuses empty chat and non-players", () => {
    const { state } = game()
    expect(request(state, ALICE, { t: "say", reqId: "r", text: " \u0007 ", to: "all" }).result.reason).toBe("invalid")
    expect(request(state, "user-stranger", { t: "say", reqId: "r", text: "hi", to: "all" }).result.reason).toBe("invalid")
  })

  it("keeps the log bounded, times increasing, and each view to its newest messages", () => {
    let { state } = game()
    for (let k = 0; k < TABLE_LIMITS.maxLog + 15; k++) {
      // The same clock reading for every message: times still strictly increase.
      state = request(
        state,
        k % 2 ? ALICE : BOB,
        { t: "say", reqId: `r${k}`, text: `m${k}`, to: "all" },
        { now: 1000, newId: () => `id${k}`, rng: fixedDice(1) }
      ).state
    }
    const log = state.table!.log
    expect(log).toHaveLength(TABLE_LIMITS.maxLog)
    expect(log[0].text).toBe("m15")
    for (let k = 1; k < log.length; k++) expect(log[k].at).toBeGreaterThan(log[k - 1].at)
    const view = messages(filterForPlayer(state, ALICE, sees()))
    expect(view).toHaveLength(TABLE_LIMITS.maxViewLog)
    expect(view[view.length - 1].text).toBe(`m${TABLE_LIMITS.maxLog + 14}`)
  })

  it("a view never carries a user id", () => {
    const g = game()
    let { state } = g
    const { pip, aldric, goblin } = g
    state = request(state, ALICE, { t: "say", reqId: "r1", text: "hi", to: "all" }).state
    state = request(state, BOB, { t: "roll", reqId: "r2", formula: "d20", to: "dm" }).state
    state = dm(state, { t: "table-post", message: dmMessage({ stamp: stamp("w1"), kind: "chat", to: [ALICE, BOB], text: "psst" }) })
    state = dm(state, { t: "combat-start", entries: [entry(pip, "c1"), entry(aldric, "c2"), entry(goblin, "c3")], stamp: stamp("cs") })
    for (const uid of [ALICE, BOB]) {
      const json = JSON.stringify(filterForPlayer(state, uid, sees(pip, aldric, goblin)))
      const other = uid === ALICE ? BOB : ALICE
      expect(json).not.toContain(other)
      expect(json.split(uid).length - 1).toBe(1) // PlayerView.userId only
    }
  })

  it("guest merge (rebind-player) takes the player's messages along", () => {
    let { state } = game()
    state = request(state, ALICE, { t: "say", reqId: "r1", text: "secret", to: "dm" }).state
    state = dm(state, { t: "table-post", message: dmMessage({ stamp: stamp("w1"), kind: "chat", to: [ALICE], text: "reply" }) })
    const NEW = "user-alice-permanent"
    state = dm(state, { t: "rebind-player", fromUserId: ALICE, toUserId: NEW })
    const view = messages(filterForPlayer(state, NEW, sees()))
    expect(view.map((m) => [m.text, m.mine])).toEqual([
      ["secret", true],
      ["reply", false],
    ])
  })

  it("the DM can clear the log", () => {
    let { state } = game()
    state = request(state, ALICE, { t: "say", reqId: "r1", text: "hi", to: "all" }).state
    state = dm(state, { t: "table-clear-log" })
    expect(filterForPlayer(state, ALICE, sees()).table).toBeUndefined()
  })
})

describe("combat", () => {
  it("sorts by initiative, then modifier, unrolled last", () => {
    const order = sortCombat([
      entry(null, "a", { initiative: 12 }),
      entry(null, "b", { initiative: null, modifier: 5 }),
      entry(null, "c", { initiative: 18 }),
      entry(null, "d", { initiative: 12, modifier: 3 }),
      entry(null, "e", { initiative: 12, modifier: 3 }),
    ])
    expect(order.map((e) => e.id)).toEqual(["c", "d", "e", "a", "b"])
  })

  it("advances turns and rounds, and back", () => {
    const c: Combat = { round: 1, activeId: null, entries: [entry(null, "a"), entry(null, "b")] }
    let r = advanceTurn(c, 1)
    expect([r.combat.activeId, r.combat.round, r.newRound]).toEqual(["a", 1, false])
    r = advanceTurn(r.combat, 1)
    expect([r.combat.activeId, r.combat.round]).toEqual(["b", 1])
    r = advanceTurn(r.combat, 1)
    expect([r.combat.activeId, r.combat.round, r.newRound]).toEqual(["a", 2, true])
    r = advanceTurn(r.combat, -1)
    expect([r.combat.activeId, r.combat.round]).toEqual(["b", 1])
    r = advanceTurn(advanceTurn(r.combat, -1).combat, -1)
    expect([r.combat.activeId, r.combat.round]).toEqual([null, 1])
    expect(advanceTurn({ ...c, entries: [] }, 1).combat.activeId).toBeNull()
  })

  it("players see only entries they may: not hidden, custom or a token in their view", () => {
    const g = game()
    let { state } = g
    const { pip, aldric, goblin, ogre, spy } = g
    state = dm(state, {
      t: "combat-start",
      entries: [
        entry(pip, "c1", { initiative: 15 }),
        entry(aldric, "c2", { initiative: 12 }),
        entry(goblin, "c3", { initiative: 20 }),
        entry(ogre, "c4", { initiative: 8, hidden: true }),
        entry(spy, "c5", { initiative: 30 }),
        entry(null, "c6", { name: "Lair action", initiative: 20 }),
      ],
      stamp: stamp("cs"),
    })
    expect(state.table!.combat!.entries.map((e) => e.id)).toEqual(["c5", "c3", "c6", "c1", "c2", "c4"])
    // Alice sees the goblin and the ogre, not Aldric (out of sight this turn).
    const a = filterForPlayer(state, ALICE, sees(goblin, ogre)).table!.combat!
    expect(a.entries.map((e) => [e.id, e.tokenId, e.name, e.initiative])).toEqual([
      ["c3", goblin, "Goblin", 20],
      ["c6", null, "Lair action", 20],
      ["c1", pip, "Pip Thistledown", 15],
    ])
    // Nobody acting yet; then the hidden spy acts: Alice sees no active entry.
    expect(a.activeId).toBeNull()
    state = dm(state, { t: "combat-turn", delta: 1, stamp: stamp("t1") })
    expect(state.table!.combat!.activeId).toBe("c5")
    expect(filterForPlayer(state, ALICE, sees(goblin)).table!.combat!.activeId).toBeNull()
    state = dm(state, { t: "combat-turn", delta: 1, stamp: stamp("t2") })
    expect(filterForPlayer(state, ALICE, sees(goblin)).table!.combat!.activeId).toBe("c3")
    // The goblin out of sight: its entry and its turn disappear for Alice.
    expect(filterForPlayer(state, ALICE, sees()).table!.combat).toEqual({
      round: 1,
      activeId: null,
      entries: [
        { id: "c6", tokenId: null, name: "Lair action", initiative: 20 },
        { id: "c1", tokenId: pip, name: "Pip Thistledown", initiative: 15 },
      ],
    })
    const json = JSON.stringify(filterForPlayer(state, ALICE, sees(goblin)))
    for (const secret of ["Spy", spy, "Ogre", ogre, "Goblin Boss", "c4", "c5"]) expect(json).not.toContain(secret)
  })

  it("posts notices for start, new rounds and end", () => {
    const g = game()
    let { state } = g
    const { pip } = g
    state = dm(state, { t: "combat-start", entries: [entry(pip, "c1")], stamp: stamp("n1", 100) })
    state = dm(state, { t: "combat-turn", delta: 1, stamp: stamp("n2", 200) })
    state = dm(state, { t: "combat-turn", delta: 1, stamp: stamp("n3", 300) })
    state = dm(state, { t: "combat-end", stamp: stamp("n4", 400) })
    expect(messages(filterForPlayer(state, BOB, sees())).map((m) => [m.kind, m.text])).toEqual([
      ["system", "Combat started"],
      ["system", "Round 2"],
      ["system", "Combat ended"],
    ])
    expect(filterForPlayer(state, BOB, sees()).table!.combat).toBeNull()
  })

  it("add skips tokens already in combat; remove hands the turn on; update re-sorts", () => {
    const g = game()
    let { state } = g
    const { pip, aldric, goblin } = g
    state = dm(state, { t: "combat-start", entries: [entry(pip, "c1", { initiative: 10 }), entry(aldric, "c2", { initiative: 5 })], stamp: stamp("n1") })
    state = dm(state, { t: "combat-add", entries: [entry(pip, "dup"), entry(goblin, "c3", { initiative: 7 }), entry("no-such-token", "c9")] })
    expect(state.table!.combat!.entries.map((e) => e.id)).toEqual(["c1", "c3", "c2"])
    state = dm(state, { t: "combat-set-active", entryId: "c3" })
    state = dm(state, { t: "combat-remove", entryId: "c3", stamp: stamp("r1") })
    expect(state.table!.combat!.activeId).toBe("c2")
    // The last one acting leaves: a new round starts, as Next turn would.
    state = dm(state, { t: "combat-remove", entryId: "c2", stamp: stamp("r2", 7000) })
    expect(state.table!.combat).toMatchObject({ round: 2, activeId: "c1" })
    expect(state.table!.log.at(-1)).toMatchObject({ kind: "system", text: "Round 2", id: "r2" })
    state = dm(state, { t: "combat-add", entries: [entry(aldric, "c2", { initiative: 5 })] })
    state = dm(state, { t: "combat-update", updates: [{ entryId: "c2", patch: { initiative: 99.123, modifier: 250 } }] })
    expect(state.table!.combat!.entries[0]).toMatchObject({ id: "c2", initiative: 99.12, modifier: TABLE_LIMITS.maxModifier })
    expect(reduceDm(state, { t: "combat-update", updates: [{ entryId: "c2", patch: { initiative: 99.12 } }] }).state).toBe(state)
  })

  it("a player rolls initiative for their own token only", () => {
    const g = game()
    let { state } = g
    const { pip, aldric, goblin } = g
    state = dm(state, {
      t: "combat-start",
      entries: [entry(pip, "c1"), entry(goblin, "c3", { initiative: 12 }), entry(aldric, "c2", { hidden: true })],
      stamp: stamp("n1"),
    })
    expect(request(state, ALICE, { t: "initiative", reqId: "r", tokenId: goblin, bonus: 0 }).result.reason).toBe("not-owner")
    expect(request(state, BOB, { t: "initiative", reqId: "r", tokenId: aldric, bonus: 0 }).result.reason).toBe("cannot")
    expect(request(state, ALICE, { t: "initiative", reqId: "r", tokenId: pip, bonus: 21 }).result.reason).toBe("invalid")
    expect(request(state, ALICE, { t: "initiative", reqId: "r", tokenId: pip, bonus: 1.5 }).result.reason).toBe("invalid")
    const out = request(state, ALICE, { t: "initiative", reqId: "r", tokenId: pip, bonus: 3 }, ctx(1000, fixedDice(14)))
    expect(out.result.ok).toBe(true)
    expect(out.state.table!.combat!.entries.map((e) => [e.id, e.initiative, e.modifier])).toEqual([
      ["c1", 17, 3],
      ["c3", 12, 0],
      ["c2", null, 0],
    ])
    // The host wrote the formula; everyone sees the bonus on the roll.
    expect(messages(filterForPlayer(out.state, BOB, sees()))[1]).toMatchObject({
      kind: "roll",
      text: "Initiative",
      name: "Alice",
      roll: { formula: "1d20 + 3", total: 17 },
    })
    // Once: a second roll (to fish for a better one) is refused until the DM clears the value.
    const again = request(out.state, ALICE, { t: "initiative", reqId: "r2", tokenId: pip, bonus: 3 }, ctx(2000, fixedDice(20)))
    expect(again.result.reason).toBe("cannot")
    const cleared = dm(out.state, { t: "combat-update", updates: [{ entryId: "c1", patch: { initiative: null } }] })
    expect(request(cleared, ALICE, { t: "initiative", reqId: "r3", tokenId: pip, bonus: -2 }, ctx(3000, fixedDice(5))).result.ok).toBe(true)
  })

  it("a player ends only their own turn", () => {
    const g = game()
    let { state } = g
    const { pip, goblin } = g
    state = dm(state, { t: "combat-start", entries: [entry(pip, "c1", { initiative: 15 }), entry(goblin, "c3", { initiative: 12 })], stamp: stamp("n1") })
    expect(request(state, ALICE, { t: "end-turn", reqId: "r", entryId: "c1" }).result.reason).toBe("cannot")
    state = dm(state, { t: "combat-turn", delta: 1, stamp: stamp("n2") })
    expect(request(state, BOB, { t: "end-turn", reqId: "r", entryId: "c1" }).result.reason).toBe("cannot")
    expect(request(state, ALICE, { t: "end-turn", reqId: "r", entryId: "c3" }).result.reason).toBe("cannot")
    const out = request(state, ALICE, { t: "end-turn", reqId: "r", entryId: "c1" })
    expect(out.result.ok).toBe(true)
    expect(out.state.table!.combat!.activeId).toBe("c3")
    // A repeated click names the turn that already ended: refused, the goblin keeps its turn.
    expect(request(out.state, ALICE, { t: "end-turn", reqId: "r", entryId: "c1" }).result.reason).toBe("cannot")
  })

  it("a deleted token leaves combat, handing the turn on", () => {
    const g = game()
    let { state } = g
    const { pip, goblin, ogre } = g
    state = dm(state, {
      t: "combat-start",
      entries: [entry(pip, "c1", { initiative: 15 }), entry(goblin, "c3", { initiative: 12 }), entry(ogre, "c4", { initiative: 3 })],
      stamp: stamp("n1"),
    })
    state = dm(state, { t: "combat-set-active", entryId: "c3" })
    state = dm(state, { t: "apply-scene-patches", patches: [{ op: "remove", path: ["tokens", goblin] }] })
    expect(state.table!.combat).toMatchObject({ round: 1, activeId: "c4" })
    expect(state.table!.combat!.entries.map((e) => e.id)).toEqual(["c1", "c4"])
    // The last one, acting: the order wraps into the next round (no notice: a map edit carries no ids).
    state = dm(state, { t: "apply-scene-patches", patches: [{ op: "remove", path: ["tokens", ogre] }] })
    expect(state.table!.combat).toMatchObject({ round: 2, activeId: "c1", entries: [{ id: "c1" }] })
  })

  it("a new map ends combat but keeps the log", () => {
    const g = game()
    let { state } = g
    const { pip } = g
    state = dm(state, { t: "combat-start", entries: [entry(pip, "c1")], stamp: stamp("n1") })
    state = dm(state, { t: "load-scene", scene: world().scene })
    expect(state.table!.combat).toBeNull()
    expect(state.table!.log).toHaveLength(1)
  })
})

describe("table on the wire and in storage", () => {
  function busy(): { state: GameState; pip: Id; goblin: Id } {
    const g = game()
    let { state } = g
    const { pip, goblin } = g
    state = request(state, ALICE, { t: "roll", reqId: "r1", formula: "4d6dl1 stats", to: "all" }, ctx(1000, fixedDice(3, 5, 1, 6))).state
    state = request(state, BOB, { t: "say", reqId: "r2", text: "Hi DM 👋", to: "dm" }, ctx(2000)).state
    state = dm(state, {
      t: "combat-start",
      entries: [entry(pip, "c1", { initiative: 11 }), entry(goblin, "c3", { initiative: 9, modifier: 2 }), entry(null, "c7", { name: "Lair" })],
      stamp: stamp("n1"),
    })
    state = dm(state, { t: "combat-turn", delta: 1, stamp: stamp("n2") })
    return { state, pip, goblin }
  }

  it("filter output passes the strict view schema unchanged", () => {
    const { state, goblin } = busy()
    for (const uid of [ALICE, BOB]) {
      const view = filterForPlayer(state, uid, sees(goblin))
      expect(view.table).toBeDefined()
      expect(parsePlayerView(JSON.parse(JSON.stringify(view)))).toEqual(view)
    }
    const bad = JSON.parse(JSON.stringify(filterForPlayer(state, ALICE, sees(goblin))))
    bad.table.log[Object.keys(bad.table.log)[0]].from = ALICE
    expect(parsePlayerView(bad)).toBeNull()
  })

  it("a new message is one op", () => {
    const { state } = busy()
    const before = filterForPlayer(state, ALICE, sees())
    const next = request(state, BOB, { t: "say", reqId: "r9", text: "again", to: "all" }, ctx(9000)).state
    const after = filterForPlayer(next, ALICE, sees())
    const ops = diffViews(before, after)
    expect(ops).toHaveLength(1)
    expect(ops[0].path.slice(0, 2)).toEqual(["table", "log"])
    expect(applyPatchOps(before, ops)).toEqual(after)
  })

  it("saved games keep the table; combat entries of deleted tokens are dropped", () => {
    const { state, goblin } = busy()
    const back = parseGameState(JSON.parse(serializeGameState(state)))
    expect(back?.table).toEqual(state.table)
    const json = JSON.parse(serializeGameState(state))
    delete json.scene.tokens[goblin]
    const trimmed = parseGameState(json)!
    expect(trimmed.table!.combat!.entries.map((e) => e.id)).toEqual(["c1", "c7"])
    // A malformed message rejects the state.
    const broken = JSON.parse(serializeGameState(state))
    broken.table.log[0].roll.total = "lots"
    expect(parseGameState(broken)).toBeNull()
    const extra = JSON.parse(serializeGameState(state))
    extra.table.log[0].secret = 1
    expect(parseGameState(extra)).toBeNull()
  })

  it("states saved before the table load without one", () => {
    const { state } = game()
    const back = parseGameState(JSON.parse(serializeGameState(state)))
    expect(back?.table).toBeUndefined()
  })
})

describe("protocol and pings", () => {
  it("accepts well-formed table requests only", () => {
    expect(parseClientMessage({ t: "say", reqId: "r1", text: "hi", to: "all" })).not.toBeNull()
    expect(parseClientMessage({ t: "roll", reqId: "r1", formula: "d20", to: "dm" })).not.toBeNull()
    expect(parseClientMessage({ t: "initiative", reqId: "r1", tokenId: "tok_1", bonus: -3 })).not.toBeNull()
    expect(parseClientMessage({ t: "end-turn", reqId: "r1", entryId: "c1" })).not.toBeNull()
    expect(parseClientMessage({ t: "ping", levelId: "lvl", x: 1, z: 2 })).not.toBeNull()
    for (const bad of [
      { t: "say", reqId: "r1", text: "", to: "all" },
      { t: "say", reqId: "r1", text: "x".repeat(TABLE_LIMITS.maxText * 2 + 1), to: "all" },
      { t: "say", reqId: "r1", text: "hi", to: "everyone" },
      { t: "say", reqId: "r1", text: "hi", to: "all", from: ALICE },
      { t: "roll", reqId: "r1", formula: "x".repeat(TABLE_LIMITS.maxFormulaInput + 1), to: "all" },
      { t: "roll", reqId: "r1", formula: "d20", to: "all", result: 20 },
      { t: "ping", levelId: "lvl", x: Infinity, z: 2 },
      { t: "ping", levelId: "lvl", x: 1e9, z: 2 },
      { t: "end-turn", reqId: "r1" },
      { t: "initiative", reqId: "r1", tokenId: "tok_1", formula: "999" },
      { t: "initiative", reqId: "r1", tokenId: "tok_1", bonus: 21 },
      { t: "initiative", reqId: "r1", tokenId: "tok_1", bonus: 2.5 },
    ]) {
      expect(parseClientMessage(bad), JSON.stringify(bad).slice(0, 60)).toBeNull()
    }
  })

  it("pings reach a player only on a level they know", () => {
    const { state, ground } = game()
    const view = filterForPlayer(state, ALICE, sees())
    const ping = { levelId: ground, x: 10, z: 20, name: "Bob", color: "#ff0000", focus: false }
    // Nothing explored: the level is at most a stub.
    expect(pingForPlayer(ping, view)).toBeNull()
    expect(pingForPlayer(ping, null)).toBeNull()
    const known: PlayerView = {
      ...view,
      scene: {
        ...view.scene,
        levels: { [ground]: { id: ground, known: true, name: "G", elevation: 0, height: 10, floorThickness: 1, terrainResolution: null } },
      },
    }
    expect(pingForPlayer(ping, known)).toEqual(ping)
    expect(pingForPlayer({ ...ping, levelId: "elsewhere" }, known)).toBeNull()
    expect(pingForPlayer({ ...ping, x: NaN }, known)).toBeNull()
  })
})

describe("DM messages", () => {
  it("are bounded and need content", () => {
    const { state } = game()
    const long: TableMessage = dmMessage({ stamp: stamp("d1"), kind: "chat", to: "all", text: "y".repeat(2000) })
    const out = reduceDm(state, { t: "table-post", message: long })
    expect([...out.state.table!.log[0].text].length).toBe(TABLE_LIMITS.maxText)
    expect(reduceDm(state, { t: "table-post", message: dmMessage({ stamp: stamp("d2"), kind: "chat", to: "all", text: "   " }) }).error).toBe("invalid message")
    expect(reduceDm(state, { t: "table-post", message: dmMessage({ stamp: stamp("d3"), kind: "roll", to: "all", text: "x" }) }).error).toBe("invalid message")
    expect(reduceDm(state, { t: "table-post", message: { ...long, id: "bad id!" } }).error).toBe("invalid message")
    // Whispers only reach players of the game.
    const w = reduceDm(state, { t: "table-post", message: dmMessage({ stamp: stamp("d4"), kind: "chat", to: [BOB, "not a player", BOB], text: "hi" }) })
    expect(w.state.table!.log[0].to).toEqual([BOB])
    expect(w.dirtyPlayers).toEqual([BOB])
  })
})

describe("DM command builders", () => {
  it("say, roll in secret, and roll initiative for the DM's creatures", () => {
    const g = game()
    let { state } = g
    const { pip, goblin, ogre } = g
    expect(dmSayCommand("   ", "all", ctx())).toBeNull()
    state = dm(state, dmSayCommand("Roll for initiative!", "all", ctx(100))!)
    const secret = dmRollCommand("1d20+2 Perception (goblin)", [], ctx(200, fixedDice(11)))
    expect(secret).toMatchObject({ ok: true, total: 13 })
    if (!secret.ok) return
    state = dm(state, secret.cmd)
    expect(dmRollCommand("oops", "all", ctx()).ok).toBe(false)
    expect(messages(filterForPlayer(state, ALICE, sees())).map((m) => m.text)).toEqual(["Roll for initiative!"])
    expect(state.table!.log[1]).toMatchObject({ from: null, to: [], text: "Perception (goblin)", roll: { total: 13 } })

    expect(npcInitiativeCommand(state, null, ctx())).toBeNull()
    state = dm(state, {
      t: "combat-start",
      entries: [entry(pip, "c1"), entry(goblin, "c3", { modifier: 2 }), entry(ogre, "c4", { initiative: 5 }), entry(null, "c9", { name: "Lair" })],
      stamp: stamp("n1"),
    })
    const cmd = npcInitiativeCommand(state, null, { rng: fixedDice(7) })
    expect(cmd).toEqual({
      t: "combat-update",
      updates: [
        { entryId: "c3", patch: { initiative: 9 } },
        { entryId: "c9", patch: { initiative: 7 } },
      ],
    })
    expect(npcInitiativeCommand(state, ["c4"], { rng: fixedDice(20) })).toEqual({ t: "combat-update", updates: [{ entryId: "c4", patch: { initiative: 20 } }] })
  })
})
