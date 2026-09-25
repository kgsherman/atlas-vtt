/**
 * Editor keyboard for the editor page and the host's live editor: registers the editor keymap (with the
 * user's remaps) and hands matched keys to the controller (active tool first, then the action), tracks
 * Alt for free placement, and runs the page's commands (save works even while typing or previewing).
 */
import { getKeyStateTracker } from "@tanstack/hotkeys"
import * as React from "react"

import { useKeyOverrides } from "@/components/keybindings/keymapStore"
import type { EditorController } from "@/editor/controller"
import { editorBindings } from "@/editor/shortcuts"
import { overlayOpen, useAppHotkeys, type AppHotkey } from "@/lib/hotkeys"

import { editorMayHandleKey } from "./lib/pointer"

/** Editor shortcuts may use this key: focus is not in a text field or on a widget that owns it, and no dialog is open. */
export function acceptsEditorKey(e: KeyboardEvent): boolean {
  return editorMayHandleKey(e.key, e.target) && !overlayOpen()
}

export interface EditorHotkeysOptions {
  /** Keymap on/off (off while previewing); save stays on. */
  enabled: boolean
  save(): void
  /** The "help" command (keyboard shortcuts dialog). */
  help?(): void
  /** Escape the editor did not use (no gesture to cancel, nothing selected). */
  escape?(): void
  /**
   * The "mode" command (Tab: switch to Play). Unlike the other navigation keys it also fires on a
   * focused button or toggle (only text fields, dialogs and menus keep it); without a handler the key
   * stays with the browser.
   */
  mode?(): void
}

export function useEditorHotkeys(controller: EditorController | null, { enabled, save, help, escape, mode }: EditorHotkeysOptions): void {
  const active = controller !== null && enabled
  const overrides = useKeyOverrides("editor")
  const bindings = React.useMemo(() => editorBindings(overrides), [overrides])

  const saveKeys: AppHotkey[] = []
  const modeKeys: AppHotkey[] = []
  const keymap: AppHotkey[] = []
  if (controller) {
    // `repeat: false` commands (toggles: Tab, 1/2/3, X/Y/Z, E) fire once per press, not on auto-repeat.
    for (const { hotkey, action, repeat } of bindings) {
      if (action.type === "save") saveKeys.push({ hotkey, anywhere: true, run: () => save() })
      else if (action.type === "mode") {
        if (mode) modeKeys.push({ hotkey, repeat, run: () => mode() })
      } else if (action.type === "help") keymap.push({ hotkey, repeat, run: () => (help ? help() : false) })
      else
        keymap.push({
          hotkey,
          repeat,
          run: (e) => {
            const used = controller.keyDown({ key: e.key, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey }, action)
            if (used || action.type !== "escape" || !escape) return used
            escape()
          },
        })
    }
    // Tapping Alt focuses the browser's menu on Windows; here Alt is held for free placement.
    keymap.push({ hotkey: { key: "Alt", alt: true }, run: () => {} })
  }
  useAppHotkeys(saveKeys)
  useAppHotkeys(modeKeys, { enabled: active })
  useAppHotkeys(keymap, { enabled: active, accepts: acceptsEditorKey })

  // Alt held → free placement. The key-state tracker also drops held keys when the window blurs.
  React.useEffect(() => {
    if (!controller || !active) return
    const { store } = controller
    const tracker = getKeyStateTracker()
    const sync = () => store.getState().setAltHeld(tracker.isKeyHeld("Alt"))
    sync()
    const subscription = tracker.store.subscribe(sync)
    return () => {
      subscription.unsubscribe()
      store.getState().setAltHeld(false)
    }
  }, [controller, active])
}
