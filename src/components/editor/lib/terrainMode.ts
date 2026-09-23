/**
 * The terrain editing mode (tool "terrain", DESIGN §3.4) as the page's menus, panels and commands see it:
 * there "the selection" is the terrain tool's shape selection (store.terrainSelection). Commands on it go
 * through the controller's key path, which the terrain tool consumes, and the object selection (hidden in
 * this mode) is never acted on. Framework-free.
 */
import { selectionBounds } from "@/core/scene/integrity"
import type { Id, Rect, TerrainShape } from "@/core/scene/types"
import type { EditorController } from "@/editor/controller"
import type { ShortcutAction } from "@/editor/shortcuts"
import type { EditorState, TerrainSelection } from "@/editor/store"
import type { ToolKeyEvent } from "@/editor/tools/types"
import { shapesBounds } from "@/editor/terrainMath"

/** A command from a menu or a panel: no physical key (tools match ToolKeyEvent.action). */
const NO_KEY: ToolKeyEvent = { key: "", shift: false, alt: false, ctrl: false }

// Shared empties (never mutated), so store selectors built on these helpers return stable values.
const NO_SHAPES: readonly TerrainShape[] = Object.freeze([])
const NO_SHAPE_RECORD: Readonly<Record<Id, TerrainShape>> = Object.freeze({})

/**
 * Run an editing command the way its shortcut runs: the active tool first (the terrain tool acts on its
 * shapes and consumes the object-selection commands), then the keymap action. True when it was used.
 */
export function runEditorCommand(controller: Pick<EditorController, "keyDown">, action: ShortcutAction): boolean {
  return controller.keyDown(NO_KEY, action)
}

export function inTerrainMode(s: Pick<EditorState, "tool">): boolean {
  return s.tool === "terrain"
}

/** The terrain selection when it belongs to the active level (null otherwise). */
export function activeTerrainSelection(s: Pick<EditorState, "terrainSelection" | "activeLevelId">): TerrainSelection | null {
  const sel = s.terrainSelection
  return sel && sel.levelId === s.activeLevelId && sel.shapeIds.length > 0 ? sel : null
}

/**
 * How many elements (vertices / edges / faces) of the selected shapes the terrain tool edits: the
 * selection's elements while its advanced mode is effective (on, in the Select sub-tool: the tool's
 * editMode), 0 elsewhere, where Delete, the arrow keys and R act on the whole shapes.
 */
export function editedTerrainElements(s: Pick<EditorState, "terrainSelection" | "activeLevelId" | "toolSettings">): number {
  const t = s.toolSettings.terrain
  return t.advanced && t.sub === "select" ? (activeTerrainSelection(s)?.elements.length ?? 0) : 0
}

/** The active level's terrain shapes by id (empty when it has none). */
export function activeLevelShapes(s: Pick<EditorState, "scene" | "activeLevelId">): Readonly<Record<Id, TerrainShape>> {
  const level = Object.hasOwn(s.scene.levels, s.activeLevelId) ? s.scene.levels[s.activeLevelId] : undefined
  return level?.terrainEdits?.shapes ?? NO_SHAPE_RECORD
}

/** The selected shapes of the active level, in selection order (missing ids skipped; a new array: select it shallowly). */
export function selectedShapes(s: Pick<EditorState, "scene" | "activeLevelId" | "terrainSelection">): readonly TerrainShape[] {
  const sel = activeTerrainSelection(s)
  if (!sel) return NO_SHAPES
  const rec = activeLevelShapes(s)
  return sel.shapeIds.filter((id) => Object.hasOwn(rec, id)).map((id) => rec[id])
}

/** Size of "the selection": selected shapes in the terrain mode, objects and tokens otherwise. */
export function selectionCount(s: Pick<EditorState, "tool" | "selection" | "terrainSelection" | "activeLevelId">): number {
  return inTerrainMode(s) ? (activeTerrainSelection(s)?.shapeIds.length ?? 0) : s.selection.length
}

/** Where "focus the selection" looks: the selected shapes' footprints in the terrain mode, else the objects / tokens. */
export function selectionFocusBounds(s: Pick<EditorState, "tool" | "scene" | "selection" | "terrainSelection" | "activeLevelId">): Rect | null {
  return inTerrainMode(s) ? shapesBounds(selectedShapes(s)) : selectionBounds(s.scene, s.selection)
}
