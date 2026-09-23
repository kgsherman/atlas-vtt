// @vitest-environment jsdom
import { matchesKeyboardEvent, validateHotkey } from "@tanstack/hotkeys"
import { describe, expect, it } from "vitest"

import { conflictsOf } from "@/lib/keymap"

import { PLAY_COMMANDS, playBindings } from "./keys"

/** What a key press runs, matched by TanStack Hotkeys as in the app (Linux: Mod = Ctrl). */
function resolve(
  key: string,
  mods: { shift?: boolean; ctrl?: boolean; alt?: boolean } = {}
) {
  const e = new KeyboardEvent("keydown", {
    key,
    shiftKey: mods.shift,
    ctrlKey: mods.ctrl,
    altKey: mods.alt,
  })
  const hits = playBindings().filter((b) =>
    matchesKeyboardEvent(e, b.hotkey, "linux")
  )
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
    expect(resolve("Tab")).toEqual({ type: "cycle-token", dir: 1 })
    expect(resolve("Tab", { shift: true })).toEqual({
      type: "cycle-token",
      dir: -1,
    })
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
    expect(conflictsOf(PLAY_COMMANDS, {})).toEqual([])
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
