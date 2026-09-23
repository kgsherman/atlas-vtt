// @vitest-environment jsdom
import { matchesKeyboardEvent, validateHotkey } from "@tanstack/hotkeys"
import { describe, expect, it } from "vitest"

import { conflictsOf } from "@/lib/keymap"

import { EDITOR_COMMANDS, editorBindings } from "./shortcuts"

/** What a key press runs, matched by TanStack Hotkeys as in the app (Linux: Mod = Ctrl). */
function resolve(key: string, mods: { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean } = {}) {
  const e = new KeyboardEvent("keydown", { key, shiftKey: mods.shift, ctrlKey: mods.ctrl, altKey: mods.alt, metaKey: mods.meta })
  const hits = editorBindings().filter((b) => matchesKeyboardEvent(e, b.hotkey, "linux"))
  expect(hits.length).toBeLessThanOrEqual(1)
  return hits[0]?.action ?? null
}

describe("editor keymap", () => {
  it("maps tool letters, either case, without modifiers", () => {
    const tools = {
      v: "select",
      f: "floor",
      w: "wall",
      d: "door",
      n: "window",
      s: "connector",
      p: "pillar",
      o: "prop",
      l: "light",
      t: "terrain",
      k: "token",
      m: "measure",
    }
    for (const [k, tool] of Object.entries(tools)) {
      expect(resolve(k)).toEqual({ type: "tool", tool })
      expect(resolve(k.toUpperCase())).toEqual({ type: "tool", tool })
    }
    expect(resolve("w", { alt: true })).toBeNull()
    expect(resolve("W", { shift: true })).toBeNull()
  })

  it("maps editing and view keys", () => {
    expect(resolve("z", { ctrl: true })).toEqual({ type: "undo" })
    expect(resolve("Z", { ctrl: true, shift: true })).toEqual({ type: "redo" })
    expect(resolve("y", { ctrl: true })).toEqual({ type: "redo" })
    expect(resolve("c", { ctrl: true })).toEqual({ type: "copy" })
    expect(resolve("x", { ctrl: true })).toEqual({ type: "cut" })
    expect(resolve("v", { ctrl: true })).toEqual({ type: "paste" })
    expect(resolve("v", { ctrl: true, alt: true })).toEqual({ type: "paste", free: true })
    expect(resolve("d", { ctrl: true })).toEqual({ type: "duplicate" })
    expect(resolve("a", { ctrl: true })).toEqual({ type: "select-all" })
    expect(resolve("s", { ctrl: true })).toEqual({ type: "save" })
    expect(resolve("Delete")).toEqual({ type: "delete" })
    expect(resolve("Backspace")).toEqual({ type: "delete" })
    expect(resolve("ArrowUp")).toEqual({ type: "nudge", x: 0, z: -1, fine: false })
    expect(resolve("ArrowRight", { shift: true })).toEqual({ type: "nudge", x: 1, z: 0, fine: true })
    expect(resolve("r")).toEqual({ type: "rotate", turns: 1 })
    expect(resolve("R", { shift: true })).toEqual({ type: "rotate", turns: -1 })
    expect(resolve("g")).toEqual({ type: "toggle-grid" })
    expect(resolve("h")).toEqual({ type: "toggle-helpers" })
    expect(resolve("b")).toEqual({ type: "toggle-dark-vision" })
    expect(resolve("[")).toMatchObject({ type: "brush-size" })
    expect(resolve("]")).toMatchObject({ type: "brush-size" })
    expect(resolve("PageUp")).toEqual({ type: "level", delta: 1 })
    expect(resolve("PageDown")).toEqual({ type: "level", delta: -1 })
    expect(resolve("Escape")).toEqual({ type: "escape" })
    expect(resolve("Enter")).toEqual({ type: "confirm" })
    expect(resolve("?", { shift: true })).toEqual({ type: "help" })
    expect(resolve("q")).toBeNull()
    expect(resolve("q", { ctrl: true })).toBeNull()
  })

  it("uses Ctrl, not Cmd, for Mod off macOS", () => {
    expect(resolve("z", { meta: true })).toBeNull()
  })

  it("has unique ids, valid keys and no key bound twice", () => {
    expect(new Set(EDITOR_COMMANDS.map((c) => c.id)).size).toBe(EDITOR_COMMANDS.length)
    for (const c of EDITOR_COMMANDS) {
      expect(c.label.length).toBeGreaterThan(0)
      for (const k of c.keys) expect(validateHotkey(k).errors).toEqual([])
    }
    expect(conflictsOf(EDITOR_COMMANDS, {})).toEqual([])
  })

  it("applies remaps (and unbinding)", () => {
    const bindings = editorBindings({ "tool.wall": ["Shift+W"], undo: [] })
    expect(bindings.some((b) => b.hotkey === "W")).toBe(false)
    expect(bindings.find((b) => b.hotkey === "Shift+W")?.action).toEqual({ type: "tool", tool: "wall" })
    expect(bindings.some((b) => b.action.type === "undo")).toBe(false)
  })
})
