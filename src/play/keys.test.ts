// @vitest-environment jsdom
import { matchesKeyboardEvent, validateHotkey } from "@tanstack/hotkeys"
import { describe, expect, it } from "vitest"

import { conflictsOf } from "@/lib/keymap"

import { PLAY_COMMANDS, playBindings, playCommandsFor } from "./keys"

/** What a key press runs, matched by TanStack Hotkeys as in the app (Linux: Mod = Ctrl). */
function resolve(
  key: string,
  mods: { shift?: boolean; ctrl?: boolean; alt?: boolean } = {},
  host = true
) {
  const e = new KeyboardEvent("keydown", {
    key,
    shiftKey: mods.shift,
    ctrlKey: mods.ctrl,
    altKey: mods.alt,
  })
  const hits = playBindings()
    .filter((b) => (host ? !b.playerOnly : !b.hostOnly))
    .filter((b) => matchesKeyboardEvent(e, b.hotkey, "linux"))
  expect(hits.length).toBeLessThanOrEqual(1)
  return hits[0]?.action ?? null
}

describe("play keymap", () => {
  it("maps play keys", () => {
    expect(resolve("q")).toEqual({ type: "rotate", quarterTurns: -1 })
    expect(resolve("E")).toEqual({ type: "rotate", quarterTurns: 1 })
    expect(resolve("=")).toEqual({ type: "zoom", direction: 1 })
    expect(resolve("+", { shift: true })).toEqual({
      type: "zoom",
      direction: 1,
    })
    expect(resolve("-")).toEqual({ type: "zoom", direction: -1 })
    expect(resolve("_", { shift: true })).toEqual({
      type: "zoom",
      direction: -1,
    })
    // Players Tab through their characters; the DM's Tab switches to Edit, ] / [ go through the PCs.
    expect(resolve("Tab", {}, false)).toEqual({ type: "cycle-token", dir: 1 })
    expect(resolve("Tab", { shift: true }, false)).toEqual({
      type: "cycle-token",
      dir: -1,
    })
    expect(resolve("Tab")).toEqual({ type: "mode" })
    expect(resolve("Tab", { shift: true })).toBeNull()
    expect(resolve("]")).toEqual({ type: "cycle-token", dir: 1 })
    expect(resolve("[")).toEqual({ type: "cycle-token", dir: -1 })
    expect(resolve("]", {}, false)).toBeNull()
    expect(resolve("v", {}, false)).toBeNull()
    expect(resolve(" ")).toEqual({ type: "focus-selected" })
    expect(resolve("m")).toEqual({ type: "toggle-measure" })
    expect(resolve("Escape")).toEqual({ type: "cancel" })
    expect(resolve("v")).toEqual({ type: "preview-vision" })
  })

  it("leaves camera keys and modifier combos alone", () => {
    expect(resolve("w")).toBeNull()
    expect(resolve("ArrowLeft")).toBeNull()
    expect(resolve("q", { ctrl: true })).toBeNull()
    expect(resolve("g", { alt: true })).toBeNull()
  })

  it("has unique ids, valid keys and no key bound twice", () => {
    expect(new Set(PLAY_COMMANDS.map((c) => c.id)).size).toBe(
      PLAY_COMMANDS.length
    )
    for (const c of PLAY_COMMANDS)
      for (const k of c.keys) expect(validateHotkey(k).errors).toEqual([])
    // Each audience's commands are conflict-free (player-only and host-only ones never register together).
    expect(conflictsOf(playCommandsFor(true), {})).toEqual([])
    expect(conflictsOf(playCommandsFor(false), {})).toEqual([])
    expect(PLAY_COMMANDS.filter((c) => c.hostOnly && c.playerOnly)).toEqual([])
  })

  it("applies remaps", () => {
    const bindings = playBindings({ "rotate.left": ["Z"] })
    expect(bindings.filter((b) => b.hotkey === "Q")).toEqual([])
    expect(bindings.find((b) => b.hotkey === "Z")?.action).toEqual({
      type: "rotate",
      quarterTurns: -1,
    })
  })
})
