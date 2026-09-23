import { describe, expect, it } from "vitest"

import { assignKey, commandUsing, compactOverrides, conflictsOf, keysOf, removeKey, resetCommand, type Command } from "./keymap"

const COMMANDS: Command[] = [
  { id: "undo", label: "Undo", keys: ["Mod+Z"] },
  { id: "redo", label: "Redo", keys: ["Mod+Shift+Z", "Mod+Y"] },
  { id: "grid", label: "Grid", keys: ["G"] },
]
const keys = (overrides: Parameters<typeof keysOf>[1], id: string) =>
  keysOf(
    COMMANDS.find((c) => c.id === id)!,
    overrides
  )

describe("keymap overrides", () => {
  it("replaces a key, and stores only what differs from the defaults", () => {
    const o = assignKey(COMMANDS, {}, "grid", "H", 0)
    expect(o).toEqual({ grid: ["H"] })
    expect(assignKey(COMMANDS, o, "grid", "G", 0)).toEqual({})
  })

  it("adds a key past the end", () => {
    expect(keys(assignKey(COMMANDS, {}, "undo", "Alt+Z", 5), "undo")).toEqual(["Mod+Z", "Alt+Z"])
  })

  it("moves a key taken from another command", () => {
    const o = assignKey(COMMANDS, {}, "grid", "Mod+Y", 0)
    expect(keys(o, "grid")).toEqual(["Mod+Y"])
    expect(keys(o, "redo")).toEqual(["Mod+Shift+Z"])
    expect(commandUsing(COMMANDS, o, "Mod+Y")?.id).toBe("grid")
    expect(conflictsOf(COMMANDS, o)).toEqual([])
  })

  it("treats spellings of the same key as equal", () => {
    const o = assignKey(COMMANDS, {}, "grid", "Control+Z", 0)
    expect(keys(o, "undo")).toEqual([])
  })

  it("does not duplicate a key within one command", () => {
    expect(keys(assignKey(COMMANDS, {}, "redo", "Mod+Y", 0), "redo")).toEqual(["Mod+Y"])
  })

  it("removes and resets keys", () => {
    const removed = removeKey(COMMANDS, {}, "redo", 1)
    expect(keys(removed, "redo")).toEqual(["Mod+Shift+Z"])
    const stolen = assignKey(COMMANDS, removed, "grid", "Mod+Shift+Z", 0)
    const reset = resetCommand(COMMANDS, stolen, "redo")
    expect(keys(reset, "redo")).toEqual(["Mod+Shift+Z", "Mod+Y"])
    expect(keys(reset, "grid")).toEqual([])
  })

  it("finds conflicts in stale overrides and cleans stored data", () => {
    expect(conflictsOf(COMMANDS, { grid: ["Mod+Z"] })).toEqual([{ hotkey: "Mod+Z", ids: ["undo", "grid"] }])
    const stored = { grid: ["H"], gone: ["X"], undo: ["Mod+Z"], redo: "nope", bad: [""] } as never
    expect(compactOverrides(COMMANDS, stored)).toEqual({ grid: ["H"] })
  })
})
