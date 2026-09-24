/**
 * The user's key remaps for the editor and play keymaps: per-command overrides saved in localStorage
 * (shared across tabs), read by the hotkey hooks, menus, tooltips and the key-bindings dialog.
 */
import type { Hotkey } from "@tanstack/hotkeys"
import * as React from "react"
import { useStore } from "zustand"
import { createStore } from "zustand/vanilla"

import { EDITOR_COMMANDS, isEditorCameraKey } from "@/editor/shortcuts"
import { hotkeyLabel } from "@/lib/hotkeys"
import { compactOverrides, keysOf, type Command, type KeyOverrides } from "@/lib/keymap"
import { PLAY_COMMANDS } from "@/play"

export const KEYMAPS = { editor: EDITOR_COMMANDS, play: PLAY_COMMANDS } satisfies Record<string, readonly Command[]>
export type KeymapScope = keyof typeof KEYMAPS

type Remaps = Record<KeymapScope, KeyOverrides>

const STORAGE_KEY = "atlas-vtt:keymap"
const VERSION = 1

function parse(raw: string | null): Remaps {
  const empty: Remaps = { editor: {}, play: {} }
  if (!raw) return empty
  try {
    const data = JSON.parse(raw) as { version?: unknown; editor?: unknown; play?: unknown }
    if (data.version !== VERSION) return empty
    const scope = (s: KeymapScope) => {
      const v = data[s]
      return v && typeof v === "object" ? compactOverrides(KEYMAPS[s], v as KeyOverrides) : {}
    }
    return { editor: withoutCameraKeys(scope("editor")), play: scope("play") }
  } catch {
    return empty
  }
}

/**
 * Remaps saved before W A S D panned the editor camera may still bind them: those keys are dropped, and a
 * command left with none of its remapped keys goes back to its defaults.
 */
function withoutCameraKeys(overrides: KeyOverrides): KeyOverrides {
  const out: Record<string, readonly Hotkey[]> = {}
  for (const [id, keys] of Object.entries(overrides)) {
    const kept = keys.filter((k) => !isEditorCameraKey(k))
    if (kept.length > 0 || keys.length === 0) out[id] = kept
  }
  return compactOverrides(EDITOR_COMMANDS, out)
}

function read(): Remaps {
  try {
    return parse(localStorage.getItem(STORAGE_KEY))
  } catch {
    return parse(null)
  }
}

export const keymapStore = createStore<Remaps>()(() => read())

if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) keymapStore.setState(parse(e.newValue), true)
  })
}

/** Replace a keymap's overrides (only differences from the defaults are kept) and save them. */
export function setKeyOverrides(scope: KeymapScope, overrides: KeyOverrides): void {
  const next = { ...keymapStore.getState(), [scope]: scope === "editor" ? withoutCameraKeys(overrides) : compactOverrides(KEYMAPS[scope], overrides) }
  keymapStore.setState(next, true)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: VERSION, ...next }))
  } catch {
    // Storage full or blocked: the remap still applies for this page.
  }
}

export function useKeyOverrides(scope: KeymapScope): KeyOverrides {
  return useStore(keymapStore, (s) => s[scope])
}

/** A command's current keys. */
export function useCommandKeys(scope: KeymapScope, id: string): readonly Hotkey[] {
  const overrides = useKeyOverrides(scope)
  return React.useMemo(() => {
    const command = (KEYMAPS[scope] as readonly Command[]).find((c) => c.id === id)
    return command ? keysOf(command, overrides) : []
  }, [scope, id, overrides])
}

/** Label of a command's first key for menus and tooltips ("" when unbound). */
export function useCommandLabel(scope: KeymapScope, id: string): string {
  const keys = useCommandKeys(scope, id)
  return keys.length > 0 ? hotkeyLabel(keys[0]) : ""
}
