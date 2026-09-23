/**
 * Editor keymap. resolveShortcut() maps a key event to an action (pure, testable); the editor
 * controller runs it with runShortcut(). The canvas should only forward keys while focus is not in a
 * text field, and should report Cmd as `ctrl` on macOS.
 *
 * Arrow nudges move one cell (Shift: one foot) along world axes: ArrowUp = −Z, ArrowDown = +Z,
 * ArrowLeft = −X, ArrowRight = +X (screen directions in the default top-down orientation).
 */
import type { SnapMode } from "@/core/grid/grid"
import type { Id, Vec2 } from "@/core/scene/types"

import type { EditorStore } from "./store"
import type { ToolId, ToolKeyEvent } from "./tools/types"

export type ShortcutAction =
  | { type: "tool"; tool: ToolId }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "copy" }
  | { type: "cut" }
  /** `free`: keep the raw pointer point (no snapping). */
  | { type: "paste"; free?: boolean }
  | { type: "duplicate" }
  | { type: "delete" }
  | { type: "select-all" }
  /** Unit direction; `fine` = one foot instead of one cell. */
  | { type: "nudge"; x: -1 | 0 | 1; z: -1 | 0 | 1; fine: boolean }
  | { type: "rotate"; turns: 1 | -1 }
  | { type: "toggle-grid" }
  | { type: "toggle-helpers" }
  | { type: "brush-size"; factor: number }
  | { type: "level"; delta: 1 | -1 }
  | { type: "escape" }

export interface ShortcutDef {
  /** Human-readable binding ("Ctrl+Z"). */
  keys: string
  description: string
  action: ShortcutAction
}

const TOOL_KEYS: Record<string, ToolId> = {
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

const TOOL_NAMES: Record<ToolId, string> = {
  select: "Select",
  floor: "Floor",
  wall: "Wall",
  door: "Door",
  window: "Window",
  connector: "Stairs / ladder / ramp",
  pillar: "Pillar",
  prop: "Prop",
  light: "Light",
  terrain: "Terrain brush",
  token: "Token",
  measure: "Measure",
}

/** Brush radius multiplier per [ / ] press. */
export const BRUSH_STEP = 1.25

/** Every binding, for help panels / tooltips. */
export const SHORTCUTS: ShortcutDef[] = [
  ...Object.entries(TOOL_KEYS).map(([key, tool]) => ({ keys: key.toUpperCase(), description: TOOL_NAMES[tool], action: { type: "tool", tool } as const })),
  { keys: "Ctrl+Z", description: "Undo", action: { type: "undo" } },
  { keys: "Ctrl+Shift+Z / Ctrl+Y", description: "Redo", action: { type: "redo" } },
  { keys: "Ctrl+C", description: "Copy", action: { type: "copy" } },
  { keys: "Ctrl+X", description: "Cut", action: { type: "cut" } },
  { keys: "Ctrl+V", description: "Paste at the pointer (snapped)", action: { type: "paste" } },
  { keys: "Ctrl+Alt+V", description: "Paste at the pointer without snapping", action: { type: "paste", free: true } },
  { keys: "Ctrl+D", description: "Duplicate", action: { type: "duplicate" } },
  { keys: "Ctrl+A", description: "Select all on the level", action: { type: "select-all" } },
  { keys: "Delete / Backspace", description: "Delete selection", action: { type: "delete" } },
  { keys: "Arrows", description: "Nudge one cell (Shift: one foot)", action: { type: "nudge", x: 0, z: 0, fine: false } },
  { keys: "R / Shift+R", description: "Rotate selection 90°", action: { type: "rotate", turns: 1 } },
  { keys: "G", description: "Toggle grid", action: { type: "toggle-grid" } },
  { keys: "H", description: "Toggle helpers", action: { type: "toggle-helpers" } },
  { keys: "[ / ]", description: "Brush smaller / larger", action: { type: "brush-size", factor: BRUSH_STEP } },
  { keys: "PageUp / PageDown", description: "Level above / below", action: { type: "level", delta: 1 } },
  { keys: "Escape", description: "Cancel / clear selection", action: { type: "escape" } },
]

/** Map a key event to an editor action, or null. */
export function resolveShortcut(e: ToolKeyEvent): ShortcutAction | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (e.ctrl && e.alt && !e.shift && key === "v") return { type: "paste", free: true }
  if (e.ctrl && !e.alt) {
    switch (key) {
      case "z":
        return e.shift ? { type: "redo" } : { type: "undo" }
      case "y":
        return e.shift ? null : { type: "redo" }
      case "c":
        return e.shift ? null : { type: "copy" }
      case "x":
        return e.shift ? null : { type: "cut" }
      case "v":
        return e.shift ? null : { type: "paste" }
      case "d":
        return e.shift ? null : { type: "duplicate" }
      case "a":
        return e.shift ? null : { type: "select-all" }
      default:
        return null
    }
  }
  if (e.ctrl || e.alt) return null
  switch (key) {
    case "Delete":
    case "Backspace":
      return { type: "delete" }
    case "ArrowUp":
      return { type: "nudge", x: 0, z: -1, fine: e.shift }
    case "ArrowDown":
      return { type: "nudge", x: 0, z: 1, fine: e.shift }
    case "ArrowLeft":
      return { type: "nudge", x: -1, z: 0, fine: e.shift }
    case "ArrowRight":
      return { type: "nudge", x: 1, z: 0, fine: e.shift }
    case "PageUp":
      return { type: "level", delta: 1 }
    case "PageDown":
      return { type: "level", delta: -1 }
    case "Escape":
      return { type: "escape" }
    case "[":
      return { type: "brush-size", factor: 1 / BRUSH_STEP }
    case "]":
      return { type: "brush-size", factor: BRUSH_STEP }
    case "r":
      return { type: "rotate", turns: e.shift ? -1 : 1 }
    default:
      break
  }
  if (e.shift) return null
  if (key === "g") return { type: "toggle-grid" }
  if (key === "h") return { type: "toggle-helpers" }
  if (Object.hasOwn(TOOL_KEYS, key)) return { type: "tool", tool: TOOL_KEYS[key] }
  return null
}

export interface PasteTarget {
  at?: Vec2
  hostWallId?: Id
  snap?: SnapMode
}

export interface ShortcutContext {
  store: EditorStore
  /** Abort the active tool's gesture (before undo/redo/level switches). */
  cancelGesture?(): void
  /** Where Ctrl+V pastes: the pointer's ground point, the wall under it and the snap mode to apply. */
  pasteTarget?(): PasteTarget
}

/** Run an action against the store. Returns whether it did anything (i.e. the key was consumed). */
export function runShortcut(action: ShortcutAction, ctx: ShortcutContext): boolean {
  const s = ctx.store.getState()
  switch (action.type) {
    case "tool":
      s.setTool(action.tool)
      return true
    case "undo": {
      // Mid-gesture (an open transaction, e.g. a drag), undo only aborts the gesture.
      const midGesture = s.history.transaction !== null
      ctx.cancelGesture?.()
      if (midGesture) {
        if (ctx.store.getState().history.transaction) ctx.store.getState().cancelTransaction()
        return true
      }
      ctx.store.getState().undo()
      return true
    }
    case "redo":
      ctx.cancelGesture?.()
      ctx.store.getState().redo()
      return true
    case "copy":
      return s.copySelection() !== null
    case "cut":
      return s.cutSelection() !== null
    case "paste": {
      if (!s.clipboard) return false
      const target = ctx.pasteTarget?.() ?? {}
      s.paste(action.free && target.at ? { ...target, snap: "free" } : target)
      return true
    }
    case "duplicate":
      return s.duplicateSelection().length > 0
    case "delete":
      return s.deleteSelection() > 0
    case "select-all":
      s.selectAll()
      return true
    case "nudge": {
      if (s.selection.length === 0) return false
      const step = action.fine ? 1 : s.scene.grid.cellSize
      s.nudgeSelection(action.x * step, action.z * step)
      return true
    }
    case "rotate":
      if (s.selection.length === 0) return false
      s.rotateSelection(action.turns)
      return true
    case "toggle-grid":
      s.toggleGrid()
      return true
    case "toggle-helpers":
      s.toggleHelpers()
      return true
    case "brush-size":
      s.scaleBrushRadius(action.factor)
      return true
    case "level":
      ctx.cancelGesture?.()
      ctx.store.getState().stepActiveLevel(action.delta)
      return true
    case "escape":
      ctx.cancelGesture?.()
      ctx.store.getState().clearSelection()
      return true
  }
}
