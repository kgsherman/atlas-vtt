// @vitest-environment jsdom
import { matchesKeyboardEvent, validateHotkey } from "@tanstack/hotkeys"
import { describe, expect, it } from "vitest"

import { conflictsOf } from "@/lib/keymap"

import { createScene } from "@/core/scene/factory"

import { EDITOR_COMMAND_GROUPS, EDITOR_COMMANDS, editorBindings, runShortcut, terrainSubFor, type ShortcutAction } from "./shortcuts"
import { makeStore } from "./test-utils"

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
    expect(resolve("j")).toBeNull()
    expect(resolve("q", { ctrl: true })).toBeNull()
  })

  it("maps the terrain keys; toggles and element / axis keys do not auto-repeat", () => {
    expect(resolve("q")).toEqual({ type: "terrain-sub", sub: "select" })
    expect(resolve("B", { shift: true })).toEqual({ type: "terrain-sub", sub: "brush" })
    expect(resolve("b")).toEqual({ type: "toggle-dark-vision" })
    expect(resolve("E")).toEqual({ type: "terrain-sub", sub: "cycle-create" })
    expect(resolve("Tab")).toEqual({ type: "terrain-advanced" })
    expect(resolve("1")).toEqual({ type: "terrain-element", element: "vertex" })
    expect(resolve("2")).toEqual({ type: "terrain-element", element: "edge" })
    expect(resolve("3")).toEqual({ type: "terrain-element", element: "face" })
    expect(resolve("x")).toEqual({ type: "axis", axis: "x" })
    expect(resolve("Y")).toEqual({ type: "axis", axis: "y" })
    expect(resolve("z")).toEqual({ type: "axis", axis: "z" })
    // The modifier combinations on the same letters keep their commands.
    expect(resolve("x", { ctrl: true })).toEqual({ type: "cut" })
    expect(resolve("z", { ctrl: true })).toEqual({ type: "undo" })
    expect(resolve("Tab", { shift: true })).toBeNull()

    const once = editorBindings()
      .filter((b) => b.repeat === false)
      .map((b) => b.hotkey)
      .sort()
    expect(once).toEqual(["1", "2", "3", "E", "Tab", "X", "Y", "Z"])
    // Remapped keys keep the command's repeat rule.
    expect(editorBindings({ "terrain.advanced": ["Shift+A"] }).find((b) => b.hotkey === "Shift+A")?.repeat).toBe(false)
    expect(EDITOR_COMMANDS.find((c) => c.id === "tool.terrain")?.label).toBe("Terrain")
    expect(new Set(EDITOR_COMMANDS.map((c) => c.group))).toEqual(new Set(EDITOR_COMMAND_GROUPS))
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

describe("runShortcut: terrain actions", () => {
  it("terrain-sub switches to the terrain tool and sets the sub-tool", () => {
    const store = makeStore(createScene())
    const run = (a: ShortcutAction) => runShortcut(a, { store })
    expect(run({ type: "terrain-sub", sub: "select" })).toBe(true)
    expect(store.getState().tool).toBe("terrain")
    expect(store.getState().toolSettings.terrain.sub).toBe("select")
    expect(run({ type: "terrain-sub", sub: "brush" })).toBe(true)
    expect(store.getState().toolSettings.terrain.sub).toBe("brush")
    // E cycles block → ramp → cylinder → block, starting at block from a non-creation sub-tool.
    const cycle: string[] = []
    for (let k = 0; k < 4; k++) {
      run({ type: "terrain-sub", sub: "cycle-create" })
      cycle.push(store.getState().toolSettings.terrain.sub)
    }
    expect(cycle).toEqual(["block", "ramp", "cylinder", "block"])
    // From another tool, E re-enters the remembered creation sub-tool first.
    run({ type: "terrain-sub", sub: "cycle-create" })
    store.getState().setTool("wall")
    run({ type: "terrain-sub", sub: "cycle-create" })
    expect(store.getState().tool).toBe("terrain")
    expect(store.getState().toolSettings.terrain.sub).toBe("ramp")
  })

  it("tool-only terrain actions do nothing outside the tool", () => {
    const store = makeStore(createScene())
    const before = store.getState()
    for (const a of [{ type: "terrain-advanced" }, { type: "terrain-element", element: "edge" }, { type: "axis", axis: "y" }] as ShortcutAction[]) {
      expect(runShortcut(a, { store })).toBe(false)
    }
    expect(store.getState()).toBe(before)
  })

  it("terrainSubFor", () => {
    expect(terrainSubFor("select", "ramp", true)).toBe("select")
    expect(terrainSubFor("cycle-create", "select", true)).toBe("block")
    expect(terrainSubFor("cycle-create", "brush", false)).toBe("block")
    expect(terrainSubFor("cycle-create", "cylinder", true)).toBe("block")
    expect(terrainSubFor("cycle-create", "cylinder", false)).toBe("cylinder")
  })
})
