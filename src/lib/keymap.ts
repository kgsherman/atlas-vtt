/**
 * Remappable keymaps (pure: no DOM, no React). A keymap is a list of commands, each with a stable id and
 * default keys; a user's remap is a set of per-command overrides (`[]` = unbound). Within one keymap a
 * key belongs to at most one command: assigning it moves it. Keys are TanStack Hotkeys strings.
 */
import { areHotkeysEqual, validateHotkey, type Hotkey } from "@tanstack/hotkeys"

export interface Command {
  /** Stable id: saved overrides refer to it. */
  id: string
  label: string
  /** Default keys (alternatives). */
  keys: readonly Hotkey[]
}

/** Keys per command id, replacing that command's defaults. */
export type KeyOverrides = Readonly<Record<string, readonly Hotkey[]>>

// Compare on one fixed platform: overrides are stored platform-neutral (Mod+…).
const sameKey = (a: Hotkey, b: Hotkey) => areHotkeysEqual(a, b, "linux")

/** A command's effective keys. */
export function keysOf(command: Command, overrides: KeyOverrides): readonly Hotkey[] {
  return Object.hasOwn(overrides, command.id) ? overrides[command.id] : command.keys
}

/** Every key of every command, after overrides. */
export function bindingsOf<C extends Command>(commands: readonly C[], overrides: KeyOverrides): { hotkey: Hotkey; command: C }[] {
  return commands.flatMap((command) => keysOf(command, overrides).map((hotkey) => ({ hotkey, command })))
}

/** The command (other than `exceptId`) that `hotkey` is bound to, if any. */
export function commandUsing<C extends Command>(commands: readonly C[], overrides: KeyOverrides, hotkey: Hotkey, exceptId?: string): C | null {
  return commands.find((c) => c.id !== exceptId && keysOf(c, overrides).some((k) => sameKey(k, hotkey))) ?? null
}

/** Keys bound to more than one command (defaults are conflict-free; stale saved overrides may not be). */
export function conflictsOf(commands: readonly Command[], overrides: KeyOverrides): { hotkey: Hotkey; ids: string[] }[] {
  const out: { hotkey: Hotkey; ids: string[] }[] = []
  for (const { hotkey, command } of bindingsOf(commands, overrides)) {
    const hit = out.find((c) => sameKey(c.hotkey, hotkey))
    if (!hit) out.push({ hotkey, ids: [command.id] })
    else if (!hit.ids.includes(command.id)) hit.ids.push(command.id)
  }
  return out.filter((c) => c.ids.length > 1)
}

/**
 * Bind `hotkey` to command `id`: it replaces the key at `slot` (or is added when `slot` is past the
 * end) and is taken away from whichever other command had it. Overrides equal to the defaults are
 * dropped, so a remap only stores what differs.
 */
export function assignKey(commands: readonly Command[], overrides: KeyOverrides, id: string, hotkey: Hotkey, slot: number): KeyOverrides {
  const next: Record<string, readonly Hotkey[]> = { ...overrides }
  for (const c of commands) {
    const keys = keysOf(c, overrides)
    if (c.id === id) {
      const own = [...keys]
      const at = Math.min(slot, own.length)
      own[at] = hotkey
      next[c.id] = own.filter((k, i) => i === at || !sameKey(k, hotkey))
    } else if (keys.some((k) => sameKey(k, hotkey))) {
      next[c.id] = keys.filter((k) => !sameKey(k, hotkey))
    }
  }
  return compactOverrides(commands, next)
}

/** Remove the key at `slot` from command `id`. */
export function removeKey(commands: readonly Command[], overrides: KeyOverrides, id: string, slot: number): KeyOverrides {
  const command = commands.find((c) => c.id === id)
  if (!command) return overrides
  return compactOverrides(commands, { ...overrides, [id]: keysOf(command, overrides).filter((_, i) => i !== slot) })
}

/** Back to the default keys for command `id`; other commands give those keys up. */
export function resetCommand(commands: readonly Command[], overrides: KeyOverrides, id: string): KeyOverrides {
  const command = commands.find((c) => c.id === id)
  if (!command) return overrides
  let next: KeyOverrides = { ...overrides, [id]: [] }
  command.keys.forEach((k, i) => (next = assignKey(commands, next, id, k, i)))
  return next
}

/** Drop unknown ids, invalid keys and overrides that equal the defaults (e.g. loaded from storage). */
export function compactOverrides(commands: readonly Command[], overrides: KeyOverrides): KeyOverrides {
  const out: Record<string, readonly Hotkey[]> = {}
  for (const c of commands) {
    if (!Object.hasOwn(overrides, c.id)) continue
    const keys = overrides[c.id]
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string" && validateHotkey(k).valid)) continue
    const same = keys.length === c.keys.length && keys.every((k, i) => sameKey(k, c.keys[i]))
    if (!same) out[c.id] = keys
  }
  return out
}
