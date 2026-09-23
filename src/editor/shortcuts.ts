/**
 * Editor keymap: every editor command with its default keys, as TanStack Hotkeys strings (`Mod` = Cmd
 * on macOS, Ctrl elsewhere). Users can rebind commands (the keymap store saves per-command overrides by
 * id); the React layer registers the effective keys with the hotkey manager and hands the matched
 * action to the editor controller, which offers the key to the active tool first (Escape, Enter, R),
 * then runs the action with runShortcut(). Tool-only actions (confirm, the terrain tool's advanced
 * mode / element / axis keys) do nothing in runShortcut, so an unused key keeps its browser default.
 *
 * Arrow nudges move one cell (or one foot) along world axes: ArrowUp = −Z, ArrowDown = +Z,
 * ArrowLeft = −X, ArrowRight = +X (screen directions in the default top-down orientation).
 */
import type { Hotkey } from "@tanstack/hotkeys"

import type { SnapMode } from "@/core/grid/grid"
import type { Id, Vec2 } from "@/core/scene/types"
import { bindingsOf, type Command, type KeyOverrides } from "@/lib/keymap"

import { TERRAIN_CREATE_SUB_TOOLS, type TerrainSubTool } from "./settings"
import type { EditorStore } from "./store"
import type { ToolId } from "./tools/types"

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
  | { type: "toggle-dark-vision" }
  | { type: "brush-size"; factor: number }
  | { type: "level"; delta: 1 | -1 }
  | { type: "escape" }
  /** Only tools use it (finish a wall chain or ruler, confirm a terrain shape's height). */
  | { type: "confirm" }
  /** Terrain tool + sub-tool; "cycle-create" steps block → ramp → cylinder. */
  | { type: "terrain-sub"; sub: "select" | "brush" | "cycle-create" }
  /** Only the terrain tool uses these: toggle the advanced (element) mode, pick the element kind, constrain a drag to an axis. */
  | { type: "terrain-advanced" }
  | { type: "terrain-element"; element: "vertex" | "edge" | "face" }
  | { type: "axis"; axis: "x" | "y" | "z" }
  /** Handled by the page, not the controller. */
  | { type: "save" }
  | { type: "help" }

export type EditorCommandGroup = "Tools" | "Editing" | "Terrain" | "View"

/** Command groups in help / settings order. */
export const EDITOR_COMMAND_GROUPS: readonly EditorCommandGroup[] = ["Tools", "Editing", "Terrain", "View"]

export interface EditorCommand extends Command {
  group: EditorCommandGroup
  action: ShortcutAction
}

export interface EditorBinding {
  hotkey: Hotkey
  action: ShortcutAction
  /** false: fire once per press (register with AppHotkey `repeat: false`); absent: auto-repeat. */
  repeat?: false
}

const TOOLS: [ToolId, string, Hotkey][] = [
  ["select", "Select", "V"],
  ["floor", "Floor", "F"],
  ["wall", "Wall", "W"],
  ["door", "Door", "D"],
  ["window", "Window", "N"],
  ["connector", "Stairs / ladder / ramp", "S"],
  ["pillar", "Pillar", "P"],
  ["prop", "Prop", "O"],
  ["light", "Light", "L"],
  ["terrain", "Terrain", "T"],
  ["token", "Token", "K"],
  ["measure", "Measure", "M"],
]

/** Brush radius multiplier per brush step. */
export const BRUSH_STEP = 1.25

const NUDGES: [string, "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight", -1 | 0 | 1, -1 | 0 | 1][] = [
  ["up", "ArrowUp", 0, -1],
  ["down", "ArrowDown", 0, 1],
  ["left", "ArrowLeft", -1, 0],
  ["right", "ArrowRight", 1, 0],
]

const TERRAIN_ELEMENTS: ["vertex" | "edge" | "face", string, Hotkey][] = [
  ["vertex", "Edit vertices", "1"],
  ["edge", "Edit edges", "2"],
  ["face", "Edit faces", "3"],
]

const AXES: ["x" | "y" | "z", Hotkey][] = [
  ["x", "X"],
  ["y", "Y"],
  ["z", "Z"],
]

/** Every editor command, in help / settings order. */
export const EDITOR_COMMANDS: EditorCommand[] = [
  ...TOOLS.map(([tool, label, key]): EditorCommand => ({ id: `tool.${tool}`, label, group: "Tools", keys: [key], action: { type: "tool", tool } })),
  { id: "undo", label: "Undo", group: "Editing", keys: ["Mod+Z"], action: { type: "undo" } },
  { id: "redo", label: "Redo", group: "Editing", keys: ["Mod+Shift+Z", "Mod+Y"], action: { type: "redo" } },
  { id: "copy", label: "Copy", group: "Editing", keys: ["Mod+C"], action: { type: "copy" } },
  { id: "cut", label: "Cut", group: "Editing", keys: ["Mod+X"], action: { type: "cut" } },
  { id: "paste", label: "Paste at the pointer (snapped)", group: "Editing", keys: ["Mod+V"], action: { type: "paste" } },
  { id: "paste-free", label: "Paste at the pointer without snapping", group: "Editing", keys: ["Mod+Alt+V"], action: { type: "paste", free: true } },
  { id: "duplicate", label: "Duplicate", group: "Editing", keys: ["Mod+D"], action: { type: "duplicate" } },
  { id: "select-all", label: "Select all on the level", group: "Editing", keys: ["Mod+A"], action: { type: "select-all" } },
  { id: "delete", label: "Delete selection", group: "Editing", keys: ["Delete", "Backspace"], action: { type: "delete" } },
  ...NUDGES.map(([dir, key, x, z]): EditorCommand => ({
    id: `nudge.${dir}`,
    label: `Nudge ${dir} one cell`,
    group: "Editing",
    keys: [key],
    action: { type: "nudge", x, z, fine: false },
  })),
  ...NUDGES.map(([dir, key, x, z]): EditorCommand => ({
    id: `nudge.${dir}-fine`,
    label: `Nudge ${dir} one foot`,
    group: "Editing",
    keys: [`Shift+${key}`],
    action: { type: "nudge", x, z, fine: true },
  })),
  { id: "rotate.cw", label: "Rotate selection 90° clockwise", group: "Editing", keys: ["R"], action: { type: "rotate", turns: 1 } },
  { id: "rotate.ccw", label: "Rotate selection 90° counter-clockwise", group: "Editing", keys: ["Shift+R"], action: { type: "rotate", turns: -1 } },
  { id: "brush.smaller", label: "Brush smaller", group: "Editing", keys: ["["], action: { type: "brush-size", factor: 1 / BRUSH_STEP } },
  { id: "brush.larger", label: "Brush larger", group: "Editing", keys: ["]"], action: { type: "brush-size", factor: BRUSH_STEP } },
  { id: "escape", label: "Cancel / clear selection", group: "Editing", keys: ["Escape"], action: { type: "escape" } },
  { id: "confirm", label: "Finish a wall chain or ruler; confirm a terrain shape", group: "Editing", keys: ["Enter"], action: { type: "confirm" } },
  { id: "terrain.select", label: "Select terrain shapes", group: "Terrain", keys: ["Q"], action: { type: "terrain-sub", sub: "select" } },
  { id: "terrain.brush", label: "Terrain brush", group: "Terrain", keys: ["Shift+B"], action: { type: "terrain-sub", sub: "brush" } },
  {
    id: "terrain.create",
    label: "Terrain block / ramp / cylinder (cycles)",
    group: "Terrain",
    keys: ["E"],
    repeat: false,
    action: { type: "terrain-sub", sub: "cycle-create" },
  },
  {
    id: "terrain.advanced",
    label: "Toggle vertex / edge / face editing",
    group: "Terrain",
    keys: ["Tab"],
    repeat: false,
    action: { type: "terrain-advanced" },
  },
  ...TERRAIN_ELEMENTS.map(([element, label, key]): EditorCommand => ({
    id: `terrain.element.${element}`,
    label,
    group: "Terrain",
    keys: [key],
    repeat: false,
    action: { type: "terrain-element", element },
  })),
  ...AXES.map(([axis, key]): EditorCommand => ({
    id: `axis.${axis}`,
    label: `Constrain a move to ${key}`,
    group: "Terrain",
    keys: [key],
    repeat: false,
    action: { type: "axis", axis },
  })),
  { id: "toggle-grid", label: "Toggle grid", group: "View", keys: ["G"], action: { type: "toggle-grid" } },
  { id: "toggle-helpers", label: "Toggle helpers", group: "View", keys: ["H"], action: { type: "toggle-helpers" } },
  { id: "toggle-dark-vision", label: "Toggle dark vision", group: "View", keys: ["B"], action: { type: "toggle-dark-vision" } },
  { id: "level.up", label: "Level above", group: "View", keys: ["PageUp"], action: { type: "level", delta: 1 } },
  { id: "level.down", label: "Level below", group: "View", keys: ["PageDown"], action: { type: "level", delta: -1 } },
  { id: "save", label: "Save", group: "View", keys: ["Mod+S"], action: { type: "save" } },
  { id: "help", label: "Keyboard shortcuts", group: "View", keys: ["?"], action: { type: "help" } },
]

/** Mouse and held-modifier input for help lists (not remappable). */
export const EDITOR_POINTER_HELP: { keys: string; label: string }[] = [
  { keys: "Alt (hold)", label: "Free placement (no snapping)" },
  { keys: "Shift (wall tool)", label: "Constrain to 45°" },
  { keys: "Right-drag", label: "Orbit the camera" },
  { keys: "Middle-drag", label: "Pan" },
  { keys: "Wheel", label: "Zoom toward the cursor" },
  { keys: "Right-click / Double-click", label: "Finish walls / rulers" },
  { keys: "Drag, then move and click (terrain)", label: "Block / ramp / cylinder: draw the base, then set the height" },
  { keys: "Right-click (terrain)", label: "Cancel the shape being drawn" },
  { keys: "Shift / Ctrl-click (terrain)", label: "Add to / toggle the shape or element selection" },
  { keys: "Drag on empty ground (terrain, advanced)", label: "Select vertices / edges / faces in a box" },
  { keys: "Drag an arrow (terrain)", label: "Move the selection along one axis" },
]

/** The bindings to register: every key of every command, after the user's overrides. */
export function editorBindings(overrides: KeyOverrides = {}): EditorBinding[] {
  return bindingsOf(EDITOR_COMMANDS, overrides).map(({ hotkey, command }) =>
    command.repeat === false ? { hotkey, action: command.action, repeat: false } : { hotkey, action: command.action }
  )
}

/**
 * The terrain sub-tool a "terrain-sub" action selects. "cycle-create" inside the terrain tool steps
 * block → ramp → cylinder → block, starting at block when the current sub-tool is not a creation one;
 * from another tool it re-enters the remembered creation sub-tool (block if none), so the first press
 * only switches to the terrain tool.
 */
export function terrainSubFor(sub: "select" | "brush" | "cycle-create", current: TerrainSubTool, inTerrainTool: boolean): TerrainSubTool {
  if (sub !== "cycle-create") return sub
  const k = TERRAIN_CREATE_SUB_TOOLS.indexOf(current)
  if (k < 0) return TERRAIN_CREATE_SUB_TOOLS[0]
  return inTerrainTool ? TERRAIN_CREATE_SUB_TOOLS[(k + 1) % TERRAIN_CREATE_SUB_TOOLS.length] : current
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
    case "toggle-dark-vision":
      s.toggleDarkVision()
      return true
    case "brush-size":
      s.scaleBrushRadius(action.factor)
      return true
    case "level":
      ctx.cancelGesture?.()
      ctx.store.getState().stepActiveLevel(action.delta)
      return true
    case "escape": {
      // Not consumed when there was nothing to deselect, so the page may use Escape (the host's
      // live editor leaves edit mode).
      const hadSelection = s.selection.length > 0
      ctx.cancelGesture?.()
      ctx.store.getState().clearSelection()
      return hadSelection
    }
    case "terrain-sub": {
      const next = terrainSubFor(action.sub, s.toolSettings.terrain.sub, s.tool === "terrain")
      s.setTool("terrain")
      if (ctx.store.getState().toolSettings.terrain.sub !== next) ctx.store.getState().setToolSettings("terrain", { sub: next })
      return true
    }
    case "confirm":
    case "terrain-advanced":
    case "terrain-element":
    case "axis":
    case "save":
    case "help":
      return false
  }
}
