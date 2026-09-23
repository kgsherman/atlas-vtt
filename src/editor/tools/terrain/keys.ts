/**
 * The keys the terrain tool reacts to, from the keymap action the controller attaches to a ToolKeyEvent
 * (so remapped keys work). Events without an action (tools driven directly, tests) fall back to the
 * default keys (EDITOR_COMMANDS).
 */
import type { GizmoAxis } from "@/core/geometry/gizmo"
import type { TerrainElementMode } from "@/core/scene/terrainShapes"

import type { ShortcutAction } from "../../shortcuts"
import type { ToolKeyEvent } from "../types"

export type TerrainKey =
  | { type: "escape" }
  | { type: "confirm" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "delete" }
  | { type: "duplicate" }
  | { type: "select-all" }
  | { type: "copy" }
  | { type: "cut" }
  | { type: "paste" }
  /** Unit direction; `fine` = one foot instead of one cell (Shift). */
  | { type: "nudge"; x: number; z: number; fine: boolean }
  | { type: "rotate"; turns: 1 | -1 }
  /** Toggle the advanced (edit) mode. */
  | { type: "advanced" }
  | { type: "element"; mode: TerrainElementMode }
  | { type: "axis"; axis: GizmoAxis }
  | { type: "other" }

const ELEMENT_MODES: readonly TerrainElementMode[] = ["vertex", "edge", "face"]
const AXES: readonly string[] = ["x", "y", "z"]

function fromAction(a: ShortcutAction): TerrainKey {
  switch (a.type) {
    case "escape":
    case "confirm":
    case "undo":
    case "redo":
    case "delete":
    case "duplicate":
    case "select-all":
    case "copy":
    case "cut":
    case "paste":
      return { type: a.type }
    case "nudge":
      return { type: "nudge", x: a.x, z: a.z, fine: a.fine }
    case "rotate":
      return { type: "rotate", turns: a.turns }
    case "terrain-advanced":
      return { type: "advanced" }
    case "terrain-element":
      return { type: "element", mode: a.element }
    case "axis":
      return { type: "axis", axis: a.axis }
    default:
      return { type: "other" }
  }
}

const NUDGE_KEYS: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }

/** The default keys (EDITOR_COMMANDS defaults, DESIGN §3.5) for events that carry no action. */
function fromKey(e: ToolKeyEvent): TerrainKey {
  const k = e.key
  const lower = k.toLowerCase()
  if (e.ctrl) {
    if (lower === "z") return { type: e.shift ? "redo" : "undo" }
    if (lower === "y") return { type: "redo" }
    if (lower === "d") return { type: "duplicate" }
    if (lower === "a") return { type: "select-all" }
    if (lower === "c") return { type: "copy" }
    if (lower === "x") return { type: "cut" }
    if (lower === "v") return { type: "paste" }
    return { type: "other" }
  }
  if (k === "Escape") return { type: "escape" }
  if (k === "Enter") return { type: "confirm" }
  if (k === "Delete" || k === "Backspace") return { type: "delete" }
  if (k === "Tab") return { type: "advanced" }
  if (Object.hasOwn(NUDGE_KEYS, k)) {
    const [x, z] = NUDGE_KEYS[k]
    return { type: "nudge", x, z, fine: e.shift }
  }
  if (e.alt) return { type: "other" }
  if (lower === "r") return { type: "rotate", turns: e.shift ? -1 : 1 }
  if (k === "1" || k === "2" || k === "3") return { type: "element", mode: ELEMENT_MODES[Number(k) - 1] }
  if (AXES.includes(lower)) return { type: "axis", axis: lower as GizmoAxis }
  return { type: "other" }
}

export function terrainKey(e: ToolKeyEvent): TerrainKey {
  return e.action ? fromAction(e.action) : fromKey(e)
}
