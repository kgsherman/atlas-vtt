import { describe, expect, it } from "vitest"

import { createScene } from "@/core/scene/factory"
import { createGameState } from "@/core/session/state"
import type { GameState, PlayerView } from "@/core/session/types"

import {
  dmAudiences,
  entriesFromState,
  entriesFromView,
  parseChatInput,
  type Audience,
} from "./chatModel"

const ALL: Audience = { kind: "all" }
const players = [
  { userId: "u1", name: "Ann Marie" },
  { userId: "u2", name: "Ann" },
  { userId: "u3", name: "Bob" },
]

describe("parseChatInput", () => {
  it("is chat unless it is a command or bare dice", () => {
    expect(parseChatInput("  hello  ", "player", ALL)).toEqual({
      kind: "say",
      text: "hello",
      audience: ALL,
    })
    expect(parseChatInput("", "player", ALL)).toEqual({ kind: "none" })
    expect(parseChatInput("5", "player", ALL)).toEqual({
      kind: "say",
      text: "5",
      audience: ALL,
    })
    expect(parseChatInput("I roll 2d6 for it", "player", ALL)).toMatchObject({
      kind: "say",
    })
    expect(parseChatInput("2d6+3", "player", ALL)).toEqual({
      kind: "roll",
      formula: "2d6+3",
      audience: ALL,
    })
    expect(parseChatInput("adv+2", "player", ALL)).toMatchObject({
      kind: "roll",
      formula: "adv+2",
    })
  })

  it("rolls with /r and privately with /gr", () => {
    expect(parseChatInput("/r 1d20+5 to hit", "player", ALL)).toEqual({
      kind: "roll",
      formula: "1d20+5 to hit",
      audience: ALL,
    })
    expect(
      parseChatInput("/ROLL d8", "dm", { kind: "player", userId: "u3" })
    ).toEqual({
      kind: "roll",
      formula: "d8",
      audience: { kind: "player", userId: "u3" },
    })
    expect(parseChatInput("/gr d20 stealth", "player", ALL)).toEqual({
      kind: "roll",
      formula: "d20 stealth",
      audience: { kind: "dm" },
    })
    expect(parseChatInput("/gr d20", "dm", ALL)).toEqual({
      kind: "roll",
      formula: "d20",
      audience: { kind: "self" },
    })
    expect(parseChatInput("/r", "player", ALL)).toMatchObject({ kind: "error" })
    expect(parseChatInput("/r banana", "player", ALL)).toMatchObject({
      kind: "error",
    })
  })

  it("whispers: players to the DM, the DM to a player by name", () => {
    expect(parseChatInput("/w psst", "player", ALL)).toEqual({
      kind: "say",
      text: "psst",
      audience: { kind: "dm" },
    })
    expect(parseChatInput("/dm psst", "player", ALL)).toEqual({
      kind: "say",
      text: "psst",
      audience: { kind: "dm" },
    })
    expect(
      parseChatInput("/w ann marie you feel watched", "dm", ALL, players)
    ).toEqual({
      kind: "say",
      text: "you feel watched",
      audience: { kind: "player", userId: "u1" },
    })
    expect(parseChatInput("/w Ann hi", "dm", ALL, players)).toEqual({
      kind: "say",
      text: "hi",
      audience: { kind: "player", userId: "u2" },
    })
    expect(parseChatInput("/w Annabel hi", "dm", ALL, players)).toMatchObject({
      kind: "error",
    })
    expect(parseChatInput("/w Bob", "dm", ALL, players)).toMatchObject({
      kind: "error",
    })
    expect(parseChatInput("/dm hi", "dm", ALL, players)).toMatchObject({
      kind: "error",
    })
    expect(parseChatInput("/dance", "player", ALL)).toMatchObject({
      kind: "error",
      message: expect.stringContaining("/dance"),
    })
  })
})

describe("chat entries", () => {
  it("label whispers for the DM and for players", () => {
    const state: GameState = {
      ...createGameState({
        sessionId: "s",
        roomCode: "R",
        scene: createScene(),
      }),
      players: {
        u1: {
          userId: "u1",
          displayName: "Ann",
          color: "#112233",
          movementLocked: false,
        },
      },
      table: {
        combat: null,
        log: [
          {
            id: "a",
            at: 1,
            kind: "chat",
            from: "u1",
            name: "Ann",
            color: "#112233",
            to: [],
            text: "psst",
          },
          {
            id: "b",
            at: 2,
            kind: "chat",
            from: null,
            name: "DM",
            color: "#e0a526",
            to: ["u1", "gone"],
            text: "hi",
          },
          {
            id: "c",
            at: 3,
            kind: "chat",
            from: null,
            name: "DM",
            color: "#e0a526",
            to: [],
            text: "note",
          },
          {
            id: "d",
            at: 4,
            kind: "system",
            from: null,
            name: "",
            color: "#8b8f98",
            to: "all",
            text: "Round 2",
          },
        ],
      },
    }
    expect(
      entriesFromState(state).map((e) => [e.id, e.privacy, e.mine])
    ).toEqual([
      ["a", "to DM", false],
      ["b", "to Ann, a player who left", true],
      ["c", "secret", true],
      ["d", null, false],
    ])
    expect(
      dmAudiences([{ userId: "u1", name: "Ann" }]).map((o) => o.label)
    ).toEqual(["Everyone", "Only me (secret)", "Whisper to Ann"])

    const view = {
      table: {
        combat: null,
        log: {
          y: {
            id: "y",
            at: 5,
            kind: "chat",
            name: "DM",
            color: "#e0a526",
            mine: false,
            dm: true,
            whisper: true,
            text: "hi",
          },
          x: {
            id: "x",
            at: 5,
            kind: "chat",
            name: "Ann",
            color: "#112233",
            mine: true,
            dm: false,
            whisper: true,
            text: "psst",
          },
        },
      },
    } as unknown as PlayerView
    expect(entriesFromView(view).map((e) => [e.id, e.privacy])).toEqual([
      ["x", "to DM"],
      ["y", "from DM"],
    ])
    expect(entriesFromView(null)).toEqual([])
  })
})
