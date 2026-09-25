/**
 * Changing the map mid-game and bringing the party along (ARCHITECTURE §6.7): composing the new map,
 * the load-scene command and what the reducer keeps (owners of carried tokens only, the log with a
 * notice), the players' views on the new map and persistence.
 */
import { describe, expect, it } from "vitest"

import { buildOcclusionWorld } from "../occlusion"
import { createLight, createProp, newId } from "../scene/factory"
import { validateReferences } from "../scene/integrity"
import { parseScene } from "../scene/schema"
import type { Id, Scene } from "../scene/types"
import { carryParty, changeMapCommand, travelNotice } from "./changeMap"
import { parseGameState, serializeGameState } from "./persist"
import { parsePlayerView } from "./playerViewSchema"
import { reduceDm } from "./reduceDm"
import { add, addToken, flatScene, TestHost } from "./test-utils"
import type { DmCommand, GameState } from "./types"

function counter(prefix = "fresh") {
  let n = 0
  return () => `${prefix}${++n}`
}

/** The tavern: two PCs (one carrying a lantern), an NPC, a crate. */
function tavern() {
  const { scene, ground } = flatScene(12, 12)
  scene.name = "Tavern"
  const pc = addToken(scene, ground, 12.5, 12.5, {
    name: "Ada",
    kind: "pc",
    hp: { max: 30, current: 17, temp: 3 },
    conditions: ["prone"],
    imageUrl: "https://example.test/ada.webp",
  })
  const pc2 = addToken(scene, ground, 22.5, 12.5, { name: "Bo", kind: "pc" })
  const npc = addToken(scene, ground, 42.5, 42.5, { name: "Innkeeper", kind: "npc" })
  const lantern = add(scene, createLight(ground, "lantern", { x: 0, z: 0 }, { attachedTokenId: pc.id }))
  return { scene, ground, pc, pc2, npc, lantern }
}

/** A dungeon with its own level ids, a crate by the entrance and a guard. */
function dungeon() {
  const { scene, ground } = flatScene(20, 20, "dark")
  scene.name = "Dungeon"
  add(scene, createProp(ground, "crate", { x: 52.5, y: 0, z: 52.5 }))
  const guard = addToken(scene, ground, 57.5, 52.5, { name: "Guard", kind: "monster" })
  return { scene, ground, guard }
}

describe("carryParty", () => {
  it("copies the chosen tokens whole, with their lights, onto free squares around the arrival point", () => {
    const t = tavern()
    const d = dungeon()
    const r = carryParty(t.scene, d.scene, { tokenIds: [t.pc.id, t.pc2.id], arrival: { levelId: d.ground, x: 52.5, z: 52.5 } })
    if (!r.ok) throw new Error(r.error)
    expect(r.carried).toEqual({ [t.pc.id]: t.pc.id, [t.pc2.id]: t.pc2.id })
    const ada = r.scene.tokens[t.pc.id]
    expect(ada).toMatchObject({
      name: "Ada",
      levelId: d.ground,
      hp: { max: 30, current: 17, temp: 3 },
      conditions: ["prone"],
      imageUrl: "https://example.test/ada.webp",
    })
    // Not on the crate, not on the guard, next to each other.
    const cells = [ada, r.scene.tokens[t.pc2.id]].map((x) => `${Math.floor(x.position.x / 5)},${Math.floor(x.position.z / 5)}`)
    expect(cells).not.toContain("10,10")
    expect(cells).not.toContain("11,10")
    expect(new Set(cells).size).toBe(2)
    expect(r.scene.objects[t.lantern.id]).toMatchObject({ attachedTokenId: t.pc.id, levelId: d.ground })
    expect(r.scene.tokens[t.npc.id]).toBeUndefined()
    expect(r.scene.tokens[d.guard.id]).toEqual(d.guard)
    expect(validateReferences(r.scene)).toEqual([])
    expect(parseScene(JSON.parse(JSON.stringify(r.scene))).ok).toBe(true)
    // Neither scene changed.
    expect(d.scene.tokens[t.pc.id]).toBeUndefined()
    expect(t.scene.tokens[t.pc.id].levelId).toBe(t.ground)
  })

  it("replaces a token of the same id on a duplicated map (and the lights it carried)", () => {
    const t = tavern()
    const copy: Scene = structuredClone(t.scene)
    copy.id = newId()
    copy.name = "Tavern (night)"
    // The copy's Ada is untouched (full health, standing elsewhere) and carries its own lantern.
    copy.tokens[t.pc.id] = { ...copy.tokens[t.pc.id], hp: { max: 30, current: 30, temp: 0 }, position: { x: 52.5, z: 52.5 } }
    const r = carryParty(t.scene, copy, { tokenIds: [t.pc.id], arrival: { levelId: t.ground, x: 32.5, z: 32.5 } })
    if (!r.ok) throw new Error(r.error)
    expect(Object.values(r.scene.tokens).filter((x) => x.name === "Ada")).toHaveLength(1)
    expect(r.scene.tokens[t.pc.id].hp).toEqual({ max: 30, current: 17, temp: 3 })
    expect(Object.values(r.scene.objects).filter((o) => o.type === "light" && o.attachedTokenId === t.pc.id)).toHaveLength(1)
    // Bo stays where the copy has him (he was not carried).
    expect(r.scene.tokens[t.pc2.id].position).toEqual(t.pc2.position)
    expect(validateReferences(r.scene)).toEqual([])
  })

  it("renames a token (and a light) whose id is taken by a level or object of the target", () => {
    const t = tavern()
    const d = dungeon()
    const clash = createProp(d.ground, "barrel", { x: 12.5, y: 0, z: 82.5 })
    clash.id = t.pc.id
    d.scene.objects[clash.id] = clash
    const lamp = createProp(d.ground, "crate", { x: 12.5, y: 0, z: 92.5 })
    lamp.id = t.lantern.id
    d.scene.objects[lamp.id] = lamp
    const r = carryParty(t.scene, d.scene, { tokenIds: [t.pc.id], arrival: { levelId: d.ground, x: 12.5, z: 12.5 } }, { newId: counter() })
    if (!r.ok) throw new Error(r.error)
    expect(r.carried).toEqual({ [t.pc.id]: "fresh1" })
    expect(r.scene.tokens.fresh1.name).toBe("Ada")
    expect(r.scene.objects.fresh2).toMatchObject({ type: "light", attachedTokenId: "fresh1" })
    expect(r.scene.objects[t.pc.id]).toEqual(clash)
    expect(validateReferences(r.scene)).toEqual([])
  })

  it("refuses an unknown arrival level, and a party with no room", () => {
    const t = tavern()
    const d = dungeon()
    expect(carryParty(t.scene, d.scene, { tokenIds: [t.pc.id], arrival: { levelId: "nope", x: 1, z: 1 } })).toEqual({
      ok: false,
      error: "unknown-level",
      unplaced: [],
    })
    for (const o of Object.values(d.scene.objects)) if (o.type === "floor") delete d.scene.objects[o.id]
    const r = carryParty(
      t.scene,
      d.scene,
      { tokenIds: [t.pc.id, t.pc2.id], arrival: { levelId: d.ground, x: 10, z: 10 } },
      { world: buildOcclusionWorld(d.scene) }
    )
    expect(r).toEqual({ ok: false, error: "no-room", unplaced: [t.pc.id, t.pc2.id].sort() })
  })

  it("brings nobody when no token is chosen (unknown ids are ignored)", () => {
    const t = tavern()
    const d = dungeon()
    expect(carryParty(t.scene, d.scene, { tokenIds: ["ghost"], arrival: { levelId: d.ground, x: 5, z: 5 } })).toEqual({ ok: true, scene: d.scene, carried: {} })
  })
})

describe("changing the map in a game", () => {
  function game() {
    const t = tavern()
    const host = new TestHost(t.scene, ["p1", "p2"])
    host.assign(t.pc.id, "p1")
    host.assign(t.pc2.id, "p2")
    host.assign(t.npc.id, "p2")
    host.dm({ t: "table-post", message: { id: "m1", at: 1000, kind: "chat", from: null, name: "DM", color: "#e0a526", to: "all", text: "Onward!" } })
    host.refresh("p1")
    host.refresh("p2")
    return { t, host }
  }

  const change = (state: GameState, target: Scene, tokenIds: Id[], arrival: { levelId: Id; x: number; z: number }) => {
    const r = changeMapCommand(state, target, { tokenIds, arrival, origin: { sceneId: "row-2", version: 3, dirty: false } }, { now: 5000, newId: counter("n") })
    if (!r.ok) throw new Error(r.error)
    return r.cmd
  }

  it("builds a load-scene with the placed party, the carried ids and a notice", () => {
    const { t, host } = game()
    const d = dungeon()
    const cmd = change(host.state, d.scene, [t.pc.id], { levelId: d.ground, x: 12.5, z: 12.5 })
    expect(cmd).toMatchObject({
      t: "load-scene",
      carried: { [t.pc.id]: t.pc.id },
      stamp: { id: "n1", at: 5000 },
      notice: "The party travels to Dungeon",
      origin: { sceneId: "row-2", version: 3, dirty: false },
    })
    expect(cmd.scene.tokens[t.pc.id].levelId).toBe(d.ground)
    expect(travelNotice("", 0)).toBe("The game moves to a new map")
  })

  it("keeps only the carried tokens' owners, the log (with the notice), and counts the map", () => {
    const { t, host } = game()
    const copy: Scene = structuredClone(t.scene)
    copy.id = newId()
    copy.name = "Tavern (night)"
    const before = host.state
    // Only Ada travels; Bo's and the innkeeper's twins stand on the copy but stay the DM's.
    const r = reduceDm(before, change(before, copy, [t.pc.id], { levelId: t.ground, x: 32.5, z: 32.5 }))
    expect(r.error).toBeUndefined()
    const s = r.state
    expect(s.owners).toEqual({ [t.pc.id]: ["p1"] })
    expect(s.mapSerial).toBe(1)
    expect(s.explored).toEqual({})
    expect(s.memory).toEqual({})
    expect(s.origin).toEqual({ sceneId: "row-2", version: 3, dirty: false })
    expect(s.table!.log.map((m) => [m.kind, m.text])).toEqual([
      ["chat", "Onward!"],
      ["system", "The party travels to Tavern (night)"],
    ])
    expect(s.players).toEqual(before.players)
    expect(r.dirtyPlayers).toBe("all")
    expect(r.delta.structure).toBe(true)
  })

  it("players land on the new map with their characters, a view that passes the strict schema, and nothing of the old map", () => {
    const { t, host } = game()
    const d = dungeon()
    const before = host.refresh("p1").view
    host.dm(change(host.state, d.scene, [t.pc.id, t.pc2.id], { levelId: d.ground, x: 12.5, z: 12.5 }))
    const a = host.refresh("p1").view
    expect(a.scene.mapSerial).toBe(1)
    expect(a.scene.name).toBe("Dungeon")
    expect(a.controlledTokenIds).toEqual([t.pc.id])
    expect(a.tokens[t.pc.id]).toMatchObject({ levelId: d.ground, hp: { max: 30, current: 17, temp: 3 }, conditions: ["prone"] })
    expect(parsePlayerView(a)).toEqual(a)
    const json = JSON.stringify(a)
    for (const id of [t.ground, t.npc.id, ...Object.keys(t.scene.objects).filter((id) => id !== t.lantern.id)]) expect(json).not.toContain(id)
    expect(Object.keys(before.scene.levels)).toEqual([t.ground])
    // p2 still plays Bo (carried); the innkeeper stayed behind.
    const b = host.refresh("p2").view
    expect(b.controlledTokenIds).toEqual([t.pc2.id])
    // A move on the new map is validated against it.
    const at = a.tokens[t.pc.id].position
    const i = Math.floor(at.x / 5)
    const j = Math.floor(at.z / 5)
    const moved = host.request("p1", {
      t: "move",
      reqId: "r1",
      tokenId: t.pc.id,
      path: [
        { cell: { i, j }, levelId: d.ground },
        { cell: { i, j: j + 1 }, levelId: d.ground },
      ],
    })
    expect(moved.result).toMatchObject({ ok: true })
  })

  it("saves and loads the game after the change", () => {
    const { t, host } = game()
    const d = dungeon()
    host.dm(change(host.state, d.scene, [t.pc.id], { levelId: d.ground, x: 12.5, z: 12.5 }))
    host.refresh("p1")
    const loaded = parseGameState(JSON.parse(serializeGameState(host.state)))
    expect(loaded).toEqual(JSON.parse(serializeGameState(host.state)))
    expect(loaded?.mapSerial).toBe(1)
  })

  it("a plain load-scene still keeps owners by id and counts the map", () => {
    const { t, host } = game()
    const copy: Scene = structuredClone(t.scene)
    copy.id = newId()
    const cmd: DmCommand = { t: "load-scene", scene: copy }
    const s = reduceDm(host.state, cmd).state
    expect(Object.keys(s.owners).sort()).toEqual([t.pc.id, t.pc2.id, t.npc.id].sort())
    expect(s.mapSerial).toBe(1)
    expect(reduceDm(s, { t: "load-scene", scene: d0() }).state.mapSerial).toBe(2)
  })
})

function d0(): Scene {
  return dungeon().scene
}
