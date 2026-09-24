/**
 * Play-mode keymap (players and the DM's play view): every play command with its default keys, as
 * TanStack Hotkeys strings. Users can rebind commands (saved overrides refer to the ids). WASD / arrow
 * panning is handled by the engine's top-down camera itself and is not remappable.
 */
import type { Hotkey } from "@tanstack/hotkeys"

import { bindingsOf, type Command, type KeyOverrides } from "@/lib/keymap"

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
  | { type: "preview-vision" }
  | { type: "chat" }

export interface PlayCommand extends Command {
  action: PlayKeyAction
  /** Fire on auto-repeat while held (default: once per press). */
  repeat?: boolean
  /** Only the DM's view uses it (hidden from players' help and settings). */
  hostOnly?: boolean
}

export interface PlayBinding {
  hotkey: Hotkey
  action: PlayKeyAction
  repeat?: boolean
  hostOnly?: boolean
}

/** Every play command, in help / settings order. `+` / `_` are Shift+= / Shift+- on US layouts. */
export const PLAY_COMMANDS: PlayCommand[] = [
  {
    id: "rotate.left",
    label: "Rotate 90° left",
    keys: ["Q"],
    action: { type: "rotate", quarterTurns: -1 },
  },
  {
    id: "rotate.right",
    label: "Rotate 90° right",
    keys: ["E"],
    action: { type: "rotate", quarterTurns: 1 },
  },
  {
    id: "zoom.in",
    label: "Zoom in",
    keys: ["+", "="],
    action: { type: "zoom", direction: 1 },
    repeat: true,
  },
  {
    id: "zoom.out",
    label: "Zoom out",
    keys: ["-", "_"],
    action: { type: "zoom", direction: -1 },
    repeat: true,
  },
  {
    id: "token.next",
    label: "Next character",
    keys: ["Tab"],
    action: { type: "cycle-token", dir: 1 },
  },
  {
    id: "token.previous",
    label: "Previous character",
    keys: ["Shift+Tab"],
    action: { type: "cycle-token", dir: -1 },
  },
  {
    id: "focus-selected",
    label: "Centre on the selected token",
    keys: ["Space"],
    action: { type: "focus-selected" },
  },
  {
    id: "measure",
    label: "Measure tool",
    keys: ["M"],
    action: { type: "toggle-measure" },
  },
  {
    id: "toggle-grid",
    label: "Toggle the grid",
    keys: ["G"],
    action: { type: "toggle-grid" },
  },
  {
    id: "chat",
    label: "Chat & dice",
    keys: ["Enter"],
    action: { type: "chat" },
  },
  {
    id: "cancel",
    label: "Cancel / clear the ruler",
    keys: ["Escape"],
    action: { type: "cancel" },
  },
  {
    id: "level.up",
    label: "Level above",
    keys: ["PageUp"],
    action: { type: "level", delta: 1 },
    hostOnly: true,
  },
  {
    id: "level.down",
    label: "Level below",
    keys: ["PageDown"],
    action: { type: "level", delta: -1 },
    hostOnly: true,
  },
  {
    id: "preview-vision",
    label: "Preview vision",
    keys: ["V"],
    action: { type: "preview-vision" },
    hostOnly: true,
  },
]

/** The bindings to register: every key of every command, after the user's overrides. */
export function playBindings(overrides: KeyOverrides = {}): PlayBinding[] {
  return bindingsOf(PLAY_COMMANDS, overrides).map(({ hotkey, command }) => ({
    hotkey,
    action: command.action,
    repeat: command.repeat,
    hostOnly: command.hostOnly,
  }))
}

/** Mouse and camera input for help lists (not remappable). */
export const PLAY_POINTER_HELP: {
  keys: string
  label: string
  hostOnly?: boolean
}[] = [
  { keys: "W A S D / Arrows", label: "Pan the camera" },
  { keys: "Wheel", label: "Zoom at the cursor" },
  { keys: "Right-drag", label: "Pan (no token selected)" },
  { keys: "Middle-drag", label: "Pan" },
  {
    keys: "Right-hold",
    label: "Move the selected token: release to go, click or Esc to cancel",
  },
  { keys: "Alt + move", label: "Move off the grid (when allowed)" },
  { keys: "Hold left click", label: "Ping the spot for the table" },
  {
    keys: "Shift + hold left click",
    label: "Ping and centre everyone's view on it",
    hostOnly: true,
  },
  {
    keys: "Right-click",
    label: "Token, door and light actions",
    hostOnly: true,
  },
]
