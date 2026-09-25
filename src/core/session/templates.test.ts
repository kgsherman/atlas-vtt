/**
 * Areas of effect (spell templates, ARCHITECTURE §6.6): who may place, move and remove them, what
 * filterForPlayer lets through (known levels, carriers in view, never a hidden template or a user id),
 * bookkeeping after map edits and player changes, persistence and the wire.
 */
import { describe, expect, it } from "vitest"

import { normalizeArea } from "../area/shape"
import type { Id } from "../scene/types"
import { createCellMask, encodeMask, setCell } from "../vision/mask"
import type { VisibilityResult } from "../vision/types"
import { applyPatchOps, diffViews } from "./diff"
import { filterForPlayer } from "./filter"
import { parseGameState, serializeGameState } from "./persist"
import { parsePlayerView } from "./playerViewSchema"
import { parseClientMessage } from "./protocol"
import { reduceDm } from "./reduceDm"
import { reduceRequest, type StateRequest } from "./reduceRequest"
import { createGameState } from "./state"
import { DM_NAME } from "./table"
import { cleanTemplate, templateArea, TEMPLATE_LIMITS } from "./templates"
import { addLevel, addToken, flatScene } from "./test-utils"
import type { AreaTemplate, AreaTemplateInput, DmCommand, GameState, PlayerView } from "./types"

const ALICE = "user-alice-7f3a"
const BOB = "user-bob-91c2"

function game() {
  const { scene, ground } = flatScene(20, 20)
  const attic = addLevel(scene, { name: "Attic", elevation: 10 }, { x: 0, z: 0, w: 100, d: 100 }).id
  const pip = addToken(scene, ground, 12.5, 12.5, { name: "Pip", label: "Pip", kind: "pc" }).id
  const aldric = addToken(scene, ground, 22.5, 12.5, { name: "Aldric", label: "Aldric", kind: "pc" }).id
  const goblin = addToken(scene, ground, 52.5, 52.5, { name: "Goblin", label: "Goblin", kind: "monster" }).id
  let state = createGameState({ sessionId: "s", roomCode: "R", scene })
  for (const cmd of [
    { t: "add-player", userId: ALICE, displayName: "Alice" },
    { t: "add-player", userId: BOB, displayName: "Bob" },
    { t: "assign-token", tokenId: pip, userId: ALICE, assigned: true },
    { t: "assign-token", tokenId: aldric, userId: BOB, assigned: true },
  ] as DmCommand[]) {
    state = dm(state, cmd)
  }
  // Both players explored the ground floor; nobody the attic.
  const mask = createCellMask(20, 20)
  setCell(mask, 0)
  const explored = { [ground]: encodeMask(mask) }
  state = { ...state, explored: { [ALICE]: explored, [BOB]: explored } }
  return { state, scene, ground, attic, pip, aldric, goblin }
}

function sees(...tokenIds: Id[]): VisibilityResult {
  return { perception: {}, sunlit: {}, visibleTokenIds: new Set(tokenIds), observedObjectIds: new Set(), illuminatingLightIds: new Set() }
}

let ids = 0
function request(state: GameState, uid: string, msg: StateRequest, view: PlayerView | null) {
  return reduceRequest(state, uid, msg, {
    world: null as never,
    currentView: view,
    perceivedByPlayer: () => false,
    table: { now: 1000, newId: () => `tpl${++ids}`, rng: () => 1 },
  })
}

function dm(state: GameState, cmd: DmCommand): GameState {
  const r = reduceDm(state, cmd)
  expect(r.error).toBeUndefined()
  return r.state
}

function input(levelId: Id, partial: Partial<AreaTemplateInput> = {}): AreaTemplateInput {
  return {
    shape: "sphere",
    levelId,
    x: 50,
    z: 50,
    elevation: 0,
    angle: 0,
    size: 20,
    width: 5,
    height: 40,
    label: "Fireball",
    color: "#F97316",
    tokenId: null,
    ...partial,
  }
}

function dmTemplate(levelId: Id, partial: Partial<AreaTemplate> = {}): AreaTemplate {
  return { id: "dm1", ...input(levelId), owner: null, hidden: false, ...partial }
}

describe("template requests", () => {
  it("a player places a template on a level they know; the host fills in the id and owner", () => {
    const g = game()
    const view = filterForPlayer(g.state, ALICE, sees(g.pip))
    const r = request(g.state, ALICE, { t: "template", reqId: "r1", template: input(g.ground, { label: "  Fire\u0000ball  " }) }, view)
    expect(r.result).toEqual({ reqId: "r1", ok: true })
    expect(r.dirtyPlayers).toBe("all")
    expect(r.state.templates).toHaveLength(1)
    const t = r.state.templates![0]
    expect(t).toMatchObject({ owner: ALICE, label: "Fire ball", color: "#f97316", hidden: false, tokenId: null, levelId: g.ground, size: 20 })
    expect(t.id).toMatch(/^tpl\d+$/)
    expect(r.state.seq).toBeGreaterThan(g.state.seq)
  })

  it("refuses levels the player does not know (no probing for levels) and points outside the scene", () => {
    const g = game()
    const view = filterForPlayer(g.state, ALICE, sees(g.pip))
    expect(request(g.state, ALICE, { t: "template", reqId: "r", template: input(g.attic) }, view).result.reason).toBe("invalid")
    expect(request(g.state, ALICE, { t: "template", reqId: "r", template: input("nope") }, view).result.reason).toBe("invalid")
    expect(request(g.state, ALICE, { t: "template", reqId: "r", template: input(g.ground) }, null).result.reason).toBe("invalid")
    expect(request(g.state, ALICE, { t: "template", reqId: "r", template: input(g.ground, { x: 5000 }) }, view).result.reason).toBe("invalid")
    expect(request(g.state, "stranger", { t: "template", reqId: "r", template: input(g.ground) }, view).result.reason).toBe("invalid")
  })

  it("a template carried by a token must be one the player controls, and stands where the token is", () => {
    const g = game()
    const view = filterForPlayer(g.state, ALICE, sees(g.pip))
    expect(request(g.state, ALICE, { t: "template", reqId: "r", template: input(g.attic, { tokenId: g.goblin }) }, view).result.reason).toBe("not-owner")
    const r = request(g.state, ALICE, { t: "template", reqId: "r", template: input(g.attic, { tokenId: g.pip, x: 0, z: 0 }) }, view)
    expect(r.result.ok).toBe(true)
    expect(r.state.templates![0]).toMatchObject({ tokenId: g.pip, levelId: g.ground, x: 12.5, z: 12.5 })
  })

  it("players move and remove only their own templates", () => {
    const g = game()
    const view = filterForPlayer(g.state, ALICE, sees(g.pip))
    let state = request(g.state, ALICE, { t: "template", reqId: "r1", template: input(g.ground) }, view).state
    const id = state.templates![0].id
    const moved = request(state, ALICE, { t: "template", reqId: "r2", id, template: input(g.ground, { x: 30, shape: "cone", angle: 1 }) }, view)
    expect(moved.result.ok).toBe(true)
    expect(moved.state.templates).toHaveLength(1)
    expect(moved.state.templates![0]).toMatchObject({ id, x: 30, shape: "cone", angle: 1 })
    state = moved.state
    const bobView = filterForPlayer(state, BOB, sees(g.aldric))
    expect(request(state, BOB, { t: "template", reqId: "r3", id, template: input(g.ground) }, bobView).result.reason).toBe("cannot")
    expect(request(state, BOB, { t: "template-remove", reqId: "r4", id }, bobView).result.reason).toBe("cannot")
    expect(request(state, ALICE, { t: "template-remove", reqId: "r5", id: "nope" }, view).result.reason).toBe("cannot")
    const removed = request(state, ALICE, { t: "template-remove", reqId: "r6", id }, view)
    expect(removed.result.ok).toBe(true)
    expect(removed.state.templates).toBeUndefined()
  })

  it("a player keeps at most perPlayer templates: another one replaces their oldest", () => {
    const g = game()
    const view = filterForPlayer(g.state, ALICE, sees(g.pip))
    let state = dm(g.state, { t: "template-set", template: dmTemplate(g.ground) })
    const placed: Id[] = []
    for (let k = 0; k < TEMPLATE_LIMITS.perPlayer + 2; k++) {
      state = request(state, ALICE, { t: "template", reqId: `r${k}`, template: input(g.ground, { x: 10 + k }) }, view).state
      placed.push(state.templates![state.templates!.length - 1].id)
    }
    const mine = state.templates!.filter((t) => t.owner === ALICE).map((t) => t.id)
    expect(mine).toEqual(placed.slice(2))
    expect(state.templates!.some((t) => t.id === "dm1")).toBe(true)
  })
})

describe("DM template commands", () => {
  it("add, replace and delete (one, or all)", () => {
    const g = game()
    let state = dm(g.state, { t: "template-set", template: dmTemplate(g.ground) })
    state = dm(state, { t: "template-set", template: dmTemplate(g.ground, { id: "dm2", shape: "line", size: 60 }) })
    state = dm(state, { t: "template-set", template: dmTemplate(g.ground, { size: 30 }) })
    expect(state.templates!.map((t) => [t.id, t.size])).toEqual([
      ["dm1", 30],
      ["dm2", 60],
    ])
    state = dm(state, { t: "template-delete", ids: ["dm1"] })
    expect(state.templates!.map((t) => t.id)).toEqual(["dm2"])
    state = dm(state, { t: "template-delete", ids: null })
    expect(state.templates).toBeUndefined()
    expect(reduceDm(state, { t: "template-delete", ids: null }).dirtyPlayers).toEqual([])
  })

  it("refuses templates that could not be loaded again", () => {
    const g = game()
    expect(cleanTemplate(g.state, dmTemplate("nope"))).toBeNull()
    expect(cleanTemplate(g.state, dmTemplate(g.ground, { id: "__bad id__" }))).toBeNull()
    expect(cleanTemplate(g.state, dmTemplate(g.ground, { owner: "stranger" }))).toBeNull()
    expect(cleanTemplate(g.state, dmTemplate(g.ground, { tokenId: "gone" }))).toBeNull()
    expect(cleanTemplate(g.state, dmTemplate(g.ground, { color: "red", size: 1e9 }))).toMatchObject({ color: "#f97316", size: 150 })
    expect(reduceDm(g.state, { t: "template-set", template: dmTemplate("nope") }).error).toBe("invalid template")
  })

  it("map edits drop templates on deleted levels or carried by deleted tokens; a new map drops all", () => {
    const g = game()
    let state = dm(g.state, { t: "template-set", template: dmTemplate(g.attic, { id: "up" }) })
    state = dm(state, { t: "template-set", template: dmTemplate(g.ground, { id: "aura", tokenId: g.goblin }) })
    state = dm(state, { t: "template-set", template: dmTemplate(g.ground, { id: "keep" }) })
    state = dm(state, {
      t: "apply-scene-patches",
      patches: [
        { op: "remove", path: ["levels", g.attic] },
        { op: "remove", path: ["tokens", g.goblin] },
      ],
    })
    expect(state.templates!.map((t) => t.id)).toEqual(["keep"])
    state = dm(state, { t: "load-scene", scene: flatScene(5, 5).scene })
    expect(state.templates).toBeUndefined()
  })

  it("a player who leaves takes their templates along; a rebound player keeps theirs", () => {
    const g = game()
    const view = filterForPlayer(g.state, ALICE, sees(g.pip))
    let state = request(g.state, ALICE, { t: "template", reqId: "r", template: input(g.ground) }, view).state
    state = request(state, BOB, { t: "template", reqId: "r", template: input(g.ground) }, filterForPlayer(state, BOB, sees(g.aldric))).state
    const rebound = dm(state, { t: "rebind-player", fromUserId: ALICE, toUserId: "user-alice-new" })
    expect(rebound.templates!.map((t) => t.owner).sort()).toEqual([BOB, "user-alice-new"].sort())
    const left = dm(state, { t: "remove-player", userId: BOB })
    expect(left.templates!.map((t) => t.owner)).toEqual([ALICE])
  })
})

describe("templates in player views", () => {
  it("players see templates on levels they know, by name and without user ids", () => {
    const g = game()
    let state = request(g.state, ALICE, { t: "template", reqId: "r", template: input(g.ground) }, filterForPlayer(g.state, ALICE, sees(g.pip))).state
    state = dm(state, { t: "template-set", template: dmTemplate(g.ground) })
    state = dm(state, { t: "template-set", template: dmTemplate(g.attic, { id: "attic" }) })
    state = dm(state, { t: "template-set", template: dmTemplate(g.ground, { id: "secret", hidden: true }) })
    const bob = filterForPlayer(state, BOB, sees(g.aldric))
    const list = Object.values(bob.templates ?? {})
    expect(list.map((t) => t.id).sort()).toEqual([state.templates![0].id, "dm1"].sort())
    const alices = list.find((t) => t.id !== "dm1")!
    expect(alices).toMatchObject({ name: "Alice", mine: false, dm: false, label: "Fireball" })
    expect(list.find((t) => t.id === "dm1")).toMatchObject({ name: DM_NAME, dm: true, mine: false })
    expect(filterForPlayer(state, ALICE, sees(g.pip)).templates![alices.id].mine).toBe(true)
    const json = JSON.stringify(bob)
    expect(json).not.toContain(ALICE)
    expect(json).not.toContain("secret")
    expect(json).not.toContain("attic")
    expect(parsePlayerView(bob)).toEqual(bob)
  })

  it("a carried template is sent only with its token in view, at the token's position", () => {
    const g = game()
    const state = dm(g.state, { t: "template-set", template: dmTemplate(g.attic, { id: "aura", tokenId: g.goblin, x: 0, z: 0 }) })
    expect(filterForPlayer(state, BOB, sees(g.aldric)).templates).toBeUndefined()
    const seen = filterForPlayer(state, BOB, sees(g.aldric, g.goblin)).templates!.aura
    expect(seen).toMatchObject({ tokenId: g.goblin, levelId: g.ground, x: 52.5, z: 52.5 })
    const hidden = dm(state, { t: "apply-scene-patches", patches: [{ op: "replace", path: ["tokens", g.goblin, "hidden"], value: true }] })
    expect(filterForPlayer(hidden, BOB, sees(g.aldric, g.goblin)).templates).toBeUndefined()
  })

  it("diffs carry templates/{id} and round-trip", () => {
    const g = game()
    const a = filterForPlayer(g.state, BOB, sees(g.aldric))
    const state = dm(g.state, { t: "template-set", template: dmTemplate(g.ground) })
    const b = filterForPlayer(state, BOB, sees(g.aldric))
    const ops = diffViews(a, b)
    expect(ops).toEqual([{ op: "set", path: ["templates"], value: b.templates }])
    const moved = filterForPlayer(dm(state, { t: "template-set", template: dmTemplate(g.ground, { x: 20 }) }), BOB, sees(g.aldric))
    expect(diffViews(b, moved).map((o) => o.path)).toEqual([["templates", "dm1"]])
    expect(applyPatchOps(b, diffViews(b, moved))).toEqual(moved)
  })

  it("the area of a carried template follows its token and is measured from the edge of its space", () => {
    const g = game()
    const t = dmTemplate(g.ground, { tokenId: g.goblin, size: 10 })
    expect(templateArea(t, g.state.scene.tokens, 5)).toEqual(normalizeArea({ ...t, levelId: g.ground, x: 52.5, z: 52.5, size: 12.5 }))
    expect(templateArea({ ...t, tokenId: null }, g.state.scene.tokens, 5).x).toBe(50)
  })
})

describe("templates on the wire and in storage", () => {
  it("parses strict template requests", () => {
    const msg = { t: "template", reqId: "r1", template: input("L1") }
    expect(parseClientMessage(msg)).toEqual(msg)
    expect(parseClientMessage({ t: "template-remove", reqId: "r1", id: "t1" })).toEqual({ t: "template-remove", reqId: "r1", id: "t1" })
    expect(parseClientMessage({ ...msg, template: { ...input("L1"), owner: ALICE } })).toBeNull()
    expect(parseClientMessage({ ...msg, template: { ...input("L1"), size: 1000 } })).toBeNull()
    expect(parseClientMessage({ ...msg, template: { ...input("L1"), shape: "donut" } })).toBeNull()
    expect(parseClientMessage({ ...msg, template: { ...input("L1"), color: "red" } })).toBeNull()
    expect(parseClientMessage({ ...msg, id: "__proto__" })).toBeNull()
  })

  it("saves and loads templates, dropping those of players who left or on missing levels", () => {
    const g = game()
    let state = dm(g.state, { t: "template-set", template: dmTemplate(g.ground) })
    state = dm(state, { t: "template-set", template: dmTemplate(g.ground, { id: "alices", owner: ALICE }) })
    const loaded = parseGameState(JSON.parse(serializeGameState(state)))
    expect(loaded?.templates).toEqual(state.templates)
    const raw = JSON.parse(serializeGameState(state))
    raw.templates.push({ ...raw.templates[0], id: "orphan", owner: "someone-else" }, { ...raw.templates[0], id: "lost", levelId: "gone" })
    expect(parseGameState(raw)?.templates?.map((t) => t.id)).toEqual(["dm1", "alices"])
    raw.templates[0].size = 1e6
    expect(parseGameState(raw)).toBeNull()
  })
})
