/**
 * App hotkeys on TanStack Hotkeys. Keymaps are plain binding tables (src/editor/shortcuts.ts,
 * src/play/keys.ts); pages register them with useAppHotkeys, which layers the app's rules over the
 * hotkey manager's matching:
 * - a guard decides per event whether shortcuts may fire (not while typing, not under a dialog or menu);
 * - the browser default is prevented only when the handler used the key (it returns false otherwise,
 *   so Tab / Escape / Delete keep working when there is nothing to act on);
 * - propagation is never stopped (the top-down camera tracks held pan keys on window).
 * Keymaps that share keys are enabled one at a time (editor vs play view, preview), so conflicts are
 * allowed; the keymap tests check each table for duplicates instead.
 */
import { detectPlatform, formatForDisplay, type Hotkey, type RegisterableHotkey } from "@tanstack/hotkeys"
import { useHotkeys } from "@tanstack/react-hotkeys"

export interface AppHotkey {
  hotkey: RegisterableHotkey
  /** Handle the key; return false when it did nothing so the browser default still runs. */
  run(e: KeyboardEvent): boolean | void
  /** Fire in text fields and under dialogs too (Mod+S). */
  anywhere?: boolean
  /** Fire on auto-repeat while held (default true; false = once per press). */
  repeat?: boolean
}

export interface AppHotkeyOptions {
  /** Registrations stay while disabled; nothing fires. */
  enabled?: boolean
  /** Whether shortcuts may use this event (default: canUseShortcut). */
  accepts?(e: KeyboardEvent): boolean
}

export function useAppHotkeys(hotkeys: AppHotkey[], { enabled = true, accepts = canUseShortcut }: AppHotkeyOptions = {}): void {
  useHotkeys(
    hotkeys.map((h) => ({
      hotkey: h.hotkey,
      callback: (e: KeyboardEvent) => {
        if (e.defaultPrevented || (!h.anywhere && !accepts(e))) return
        if (h.run(e) !== false) e.preventDefault()
      },
      options: { requireReset: h.repeat === false },
    })),
    { enabled, preventDefault: false, stopPropagation: false, ignoreInputs: false, conflictBehavior: "allow" }
  )
}

/** Default guard: focus is not in a text field and no dialog, sheet or menu is open. */
export function canUseShortcut(e: KeyboardEvent): boolean {
  return !isTextEntry(e.target) && !overlayOpen()
}

/** Keyboard focus is in something that takes text: shortcuts must not fire. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false
  const el = target as HTMLElement
  if (el.isContentEditable) return true
  const tag = el.tagName
  if (tag === "TEXTAREA" || tag === "SELECT") return true
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(type)
  }
  return false
}

const OVERLAY_SELECTOR = '[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"], [role="menu"], [role="listbox"]'

/**
 * A modal dialog, sheet or menu is open: map shortcuts must not fire underneath it. Only live overlays
 * count: Base UI keeps a closed Select/Menu popup mounted inside a `[hidden]` (unmounted-but-kept) or
 * `[inert]` (closing) wrapper, and those must not swallow shortcuts for the rest of the page's life.
 * `closest()` rather than `checkVisibility()` so the check also works under jsdom.
 */
export function overlayOpen(root: ParentNode = document): boolean {
  for (const el of root.querySelectorAll(OVERLAY_SELECTOR)) {
    if (!el.closest("[hidden], [inert]")) return true
  }
  return false
}

const MAC = detectPlatform() === "mac"

// macOS keeps the library's key symbols (⌫ ↵ ⇥); elsewhere keys are spelled out.
const KEY_LABELS: Record<string, string> = MAC
  ? { PageUp: "PgUp", PageDown: "PgDn", Space: "Space" }
  : { PageUp: "PgUp", PageDown: "PgDn", Space: "Space", Delete: "Del", Backspace: "Backspace", Enter: "Enter", Tab: "Tab" }

/** Key caps for a binding on this platform: ["Ctrl", "Shift", "Z"], or ["⌘", "⇧", "Z"] on macOS. */
export function hotkeyParts(hotkey: Hotkey): string[] {
  return formatForDisplay(hotkey, { parts: true, keyLabels: KEY_LABELS })
}

/** One-line label for menus and tooltips: "Ctrl+Shift+Z", or "⌘⇧Z" on macOS. */
export function hotkeyLabel(hotkey: Hotkey): string {
  return hotkeyParts(hotkey).join(MAC ? "" : "+")
}
