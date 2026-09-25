import { describe, expect, it } from "vitest"

import { createScene, createToken } from "@/core/scene/factory"
import { sortedLevels } from "@/core/scene/queries"
import { createGameState } from "@/core/session/state"
import type { GameState } from "@/core/session/types"

import {
  changeMapErrorText,
  clampToGrid,
  defaultParty,
  frameCentre,
  nameList,
  partyRows,
  saveChoice,
  saveChoiceText,
} from "./changeMapModel"

function table(): { state: GameState; ids: Record<string, string> } {
  const scene = createScene({ width: 20, depth: 10 })
  const levelId = sortedLevels(scene)[0].id
  const add = (
    name: string,
    kind: "pc" | "npc" | "monster",
    x: number
  ): string => {
    const t = createToken(levelId, { x, z: 2.5 }, { name, kind })
    scene.tokens[t.id] = t
    return t.id
  }
  const ids = {
    mira: add("Mira", "pc", 2.5),
    brother: add("Brother Ash", "npc", 7.5),
    wolf: add("Wolf", "monster", 12.5),
    pony: add("Pony", "npc", 17.5),
    aldo: add("Aldo", "pc", 22.5),
  }
  const state = createGameState({ sessionId: "s", roomCode: "ABCDEFGH", scene })
  const player = (userId: string) => ({
    userId,
    displayName: "Ana",
    color: "#ff0000",
    movementLocked: false,
  })
  state.players = { u1: player("u1"), u2: player("u2") }
  state.owners = { [ids.mira]: ["u1"], [ids.pony]: ["u1", "u2"] }
  return { state, ids }
}

describe("the party", () => {
  it("lists PCs first, then by name, with their players", () => {
    const { state, ids } = table()
    const rows = partyRows(state)
    expect(rows.map((r) => r.token.id)).toEqual([
      ids.aldo,
      ids.mira,
      ids.brother,
      ids.pony,
      ids.wolf,
    ])
    expect(rows.find((r) => r.token.id === ids.pony)?.owners).toEqual([
      "Ana",
      "Ana (2)",
    ])
    expect(rows.find((r) => r.token.id === ids.wolf)?.owners).toEqual([])
  })

  it("brings PCs and every token a player controls by default", () => {
    const { state, ids } = table()
    expect(defaultParty(partyRows(state))).toEqual([
      ids.aldo,
      ids.mira,
      ids.pony,
    ])
  })
})

describe("the arrival", () => {
  const grid = { width: 20, depth: 10, cellSize: 5 }

  it("clamps a point to the grid, to a tenth of a foot", () => {
    expect(clampToGrid({ x: -3, z: 12.345 }, grid)).toEqual({ x: 0, z: 12.3 })
    expect(clampToGrid({ x: 250, z: 99 }, grid)).toEqual({ x: 100, z: 50 })
    expect(clampToGrid({ x: Number.NaN, z: 7 }, grid)).toEqual({ x: 50, z: 7 })
  })

  it("defaults to the middle of what the level's thumbnail frames", () => {
    expect(frameCentre([10, 5, 30, 20], grid)).toEqual({ x: 25, z: 15 })
    // Framing margins may spill off the grid: the centre stays on it.
    expect(frameCentre([80, -40, 60, 40], grid)).toEqual({ x: 100, z: 0 })
  })
})

describe("the unsaved-edits guard", () => {
  const linked = {
    status: "linked" as const,
    sceneId: "row-1",
    name: "The Crooked Lantern",
  }

  it("offers nothing to save on a clean map, whatever the library says", () => {
    expect(saveChoice({ dirty: false, library: linked })).toEqual({
      kind: "clean",
    })
    expect(
      saveChoice({ dirty: false, library: { status: "deleted" } })
    ).toEqual({ kind: "clean" })
    expect(saveChoiceText({ kind: "clean" })).toBeNull()
  })

  it("keeps a restore point of a changed map in its linked library scene", () => {
    const c = saveChoice({ dirty: true, library: linked })
    expect(c).toEqual({ kind: "offer", name: "The Crooked Lantern" })
    expect(saveChoiceText(c)).toContain("“The Crooked Lantern”")
  })

  it("explains every other library state", () => {
    expect(saveChoice({ dirty: true, library: { status: "loading" } })).toEqual(
      { kind: "looking-up" }
    )
    const down = saveChoice({
      dirty: true,
      library: { status: "unavailable", error: "You're offline." },
    })
    expect(down).toEqual({ kind: "unavailable", error: "You're offline." })
    expect(saveChoiceText(down)).toContain("You're offline.")
    expect(
      saveChoiceText(
        saveChoice({ dirty: true, library: { status: "deleted" } })
      )
    ).toMatch(/no longer in your library/)
  })
})

describe("refusals", () => {
  it("lists names briefly", () => {
    expect(nameList([])).toBe("")
    expect(nameList(["Mira"])).toBe("Mira")
    expect(nameList(["Mira", "Aldo"])).toBe("Mira and Aldo")
    expect(nameList(["Mira", "Aldo", "Pony"])).toBe("Mira, Aldo and Pony")
    expect(nameList(["Mira", "Aldo", "Pony", "Wolf", "Ash"])).toBe(
      "Mira, Aldo, Pony and 2 more"
    )
  })

  it("names the tokens left without room", () => {
    expect(changeMapErrorText("no-room", ["Pony"])).toMatch(
      /no room on that level for Pony.*leave that token behind/
    )
    expect(changeMapErrorText("no-room", ["Pony", "Wolf"])).toMatch(
      /for Pony and Wolf.*leave them behind/
    )
    expect(changeMapErrorText("no-room")).toMatch(/for the party/)
  })

  it("explains the other refusals", () => {
    expect(changeMapErrorText("unknown-level")).toMatch(/arrival level/)
    expect(changeMapErrorText("too-many")).toMatch(/1,000 tokens/)
    expect(changeMapErrorText("same-map")).toMatch(/map you're playing/)
    expect(changeMapErrorText("not-hosting")).toMatch(/isn't hosting/)
  })
})
