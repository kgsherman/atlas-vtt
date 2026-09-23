/**
 * Play-mode keyboard map (players and the DM's play view). WASD / arrow panning is handled by the
 * engine's top-down camera itself; everything else resolves to a PlayKeyAction here so the pages share
 * one keymap and one shortcut list for tooltips and help.
 */

export type PlayKeyAction =
  | { type: "rotate"; quarterTurns: 1 | -1 }
  | { type: "zoom"; direction: 1 | -1 }
  | { type: "cycle-token"; dir: 1 | -1 }
  | { type: "tool"; tool: "move" | "measure" }
  | { type: "toggle-measure" }
  | { type: "focus-selected" }
  | { type: "toggle-grid" }
  | { type: "level"; delta: 1 | -1 }
  | { type: "cancel" }

export interface PlayKeyEvent {
  key: string
  code?: string
  shift: boolean
  ctrl: boolean
  alt: boolean
}

export interface PlayShortcut {
  keys: string
  label: string
}

/** Shortcut list for help popovers (display strings). */
export const PLAY_SHORTCUTS: PlayShortcut[] = [
  { keys: "W A S D", label: "Pan the camera" },
  { keys: "Q / E", label: "Rotate 90°" },
  { keys: "+ / −", label: "Zoom in / out" },
  { keys: "Wheel", label: "Zoom at the cursor" },
  { keys: "Right-drag", label: "Pan" },
  { keys: "Tab", label: "Next character" },
  { keys: "Space", label: "Centre on the selected token" },
  { keys: "M", label: "Measure tool" },
  { keys: "G", label: "Toggle the grid" },
  { keys: "Esc", label: "Cancel / clear the ruler" },
]

/** Resolve a key press (null = not a play shortcut). Modifier combos are never play shortcuts. */
export function resolvePlayKey(e: PlayKeyEvent): PlayKeyAction | null {
  if (e.ctrl || e.alt) return null
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key
  switch (k) {
    case "q":
      return { type: "rotate", quarterTurns: -1 }
    case "e":
      return { type: "rotate", quarterTurns: 1 }
    case "+":
    case "=":
      return { type: "zoom", direction: 1 }
    case "-":
    case "_":
      return { type: "zoom", direction: -1 }
    case "Tab":
      return { type: "cycle-token", dir: e.shift ? -1 : 1 }
    case "m":
      return { type: "toggle-measure" }
    case " ":
      return { type: "focus-selected" }
    case "g":
      return { type: "toggle-grid" }
    case "PageUp":
      return { type: "level", delta: 1 }
    case "PageDown":
      return { type: "level", delta: -1 }
    case "Escape":
      return { type: "cancel" }
    default:
      return null
  }
}
