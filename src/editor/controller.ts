/**
 * Glue between the editor canvas and the tools: owns the tool instances, routes pointer/key events
 * to the active tool (then to the keymap), cancels gestures when the tool changes, and assembles
 * the overlay state the canvas passes to engine.setOverlays(). Framework-free; the React canvas
 * builds ToolPointerEvents (engine.pick + snapping) and calls in.
 *
 * In the terrain editing mode (tool "terrain") scene objects are neither shown as selected nor
 * editable from the keyboard: the overlays carry no object selection or hover, and keys acting on the
 * object selection never reach the keymap (the terrain tool acts on its shape selection instead).
 */
import type { Id, Rect, Vec2, Vec3 } from "@/core/scene/types"
import type { OverlayState, PickResult } from "@/render/contracts"

import { runShortcut, type PasteTarget, type ShortcutAction } from "./shortcuts"
import { currentSnapMode, type EditorStore } from "./store"
import { createTools, type ToolSet } from "./tools"
import type { Tool, ToolKeyEvent, ToolPointerEvent } from "./tools/types"

export type EditorOverlays = Pick<OverlayState, "selectedIds" | "hoveredId" | "preview" | "ruler" | "dragGhosts">

/** Engine.project: world point → canvas-relative CSS px (ToolDeps.project). */
export type Projector = (p: Vec3) => { x: number; y: number; visible: boolean } | null

/** Actions on the object selection: inert in the terrain mode unless the terrain tool uses them. */
const OBJECT_SELECTION_ACTIONS: ReadonlySet<ShortcutAction["type"]> = new Set([
  "copy",
  "cut",
  "paste",
  "duplicate",
  "delete",
  "select-all",
  "nudge",
  "rotate",
  "escape",
])

/** Shared empty selection (terrain mode), so memoised overlays keep their identity. Never mutated. */
const NO_IDS: Id[] = []

export interface EditorController {
  readonly store: EditorStore
  readonly tools: ToolSet
  activeTool(): Tool
  pointerDown(e: ToolPointerEvent): void
  pointerMove(e: ToolPointerEvent): void
  pointerUp(e: ToolPointerEvent): void
  /**
   * A bound key was pressed (see editorBindings): the active tool may consume it (it gets the action as
   * ToolKeyEvent.action), otherwise its action runs. Returns true when the key was consumed (the page
   * should preventDefault). In the terrain mode, object-selection actions the tool declines do nothing:
   * Escape returns false (the host may leave edit mode), the others true (no browser default).
   */
  keyDown(e: ToolKeyEvent, action: ShortcutAction): boolean
  /** Overlay state for the engine; the same object is returned until something in it changes. */
  overlays(): EditorOverlays
  /** Listen for overlay / preview changes (the canvas pushes overlays() to the engine). */
  subscribe(listener: () => void): () => void
  /** Engine.previewTerrain (set once the engine exists). */
  setTerrainPreview(fn: ((levelId: Id, heights: Float32Array | null, dirty: Rect | null) => void) | null): void
  /** Engine.project (set once the engine exists; null when it goes away): tools read it as ToolDeps.project. */
  setProjector(fn: Projector | null): void
  /** CSS cursor the active tool asks for (Tool.cursor), or null for the canvas default. Re-read on subscribe(). */
  toolCursor(): string | null
  /** Phase-aware hint of the active tool for the options bar (Tool.hint), or null for its static hint. Re-read on subscribe(). */
  toolHint(): string | null
  /** Last pointer position on the active level (paste target). */
  cursor(): { ground: Vec2 | null; pick: PickResult } | null
  /**
   * Where a paste at the pointer lands (Ctrl+V, the Edit menu, system paste): the pointer's ground
   * point, the wall under it (re-hosts copied openings) and the effective snap mode (Alt = free).
   * Empty when the pointer has not been over the level.
   */
  pasteTarget(): PasteTarget
  /** Cancel the active tool's gesture (e.g. when the canvas loses the pointer). */
  cancelGesture(): void
  dispose(): void
}

export function createEditorController(store: EditorStore, opts: { now?: () => number } = {}): EditorController {
  const listeners = new Set<() => void>()
  let terrainPreview: ((levelId: Id, heights: Float32Array | null, dirty: Rect | null) => void) | null = null
  let projector: Projector | null = null
  let lastPointer: { ground: Vec2 | null; pick: PickResult } | null = null
  let overlayCache: { key: unknown[]; value: EditorOverlays } | null = null

  const emit = () => {
    for (const l of [...listeners]) l()
  }

  const tools = createTools({
    store,
    invalidate: emit,
    previewTerrain: (levelId, heights, dirty) => terrainPreview?.(levelId, heights, dirty),
    now: opts.now,
    // Live indirection: tools are created before the engine exists (and outlive a remounted engine).
    project: (p) => (projector ? projector(p) : null),
  })

  let current: Tool = tools[store.getState().tool]

  // Switching tools (toolbar, shortcut or code) cancels the previous tool's gesture. Anything else
  // the overlays depend on (selection, previews through settings / snapping / level / document)
  // notifies listeners so the canvas re-reads overlays().
  const unsubscribe = store.subscribe((s, prev) => {
    if (s.tool !== prev.tool) {
      current.cancel?.()
      current = tools[s.tool]
      emit()
      return
    }
    if (
      s.selection !== prev.selection ||
      s.terrainSelection !== prev.terrainSelection ||
      s.scene !== prev.scene ||
      s.toolSettings !== prev.toolSettings ||
      s.snapMode !== prev.snapMode ||
      s.altHeld !== prev.altHeld ||
      s.activeLevelId !== prev.activeLevelId ||
      s.readOnly !== prev.readOnly
    ) {
      emit()
    }
  })

  const track = (e: ToolPointerEvent) => {
    lastPointer = { ground: e.ground ? { ...e.ground } : null, pick: e.pick }
  }

  const pasteTarget = (): PasteTarget => {
    if (!lastPointer?.ground) return {}
    const s = store.getState()
    const objectId = lastPointer.pick.objectId
    const hostWallId = objectId && Object.hasOwn(s.scene.objects, objectId) && s.scene.objects[objectId].type === "wall" ? objectId : undefined
    return { at: { ...lastPointer.ground }, hostWallId, snap: currentSnapMode(s) }
  }

  const controller: EditorController = {
    store,
    tools,

    activeTool: () => current,

    pointerDown(e) {
      track(e)
      current.onPointerDown?.(e)
    },

    pointerMove(e) {
      track(e)
      current.onPointerMove?.(e)
    },

    pointerUp(e) {
      track(e)
      current.onPointerUp?.(e)
    },

    keyDown(e, action) {
      if (current.onKeyDown?.({ ...e, action })) return true
      if (current === tools.terrain && OBJECT_SELECTION_ACTIONS.has(action.type)) return action.type !== "escape"
      return runShortcut(action, { store, cancelGesture: () => current.cancel?.(), pasteTarget })
    },

    overlays() {
      const s = store.getState()
      const select = tools.select
      const preview = current.preview()
      const ruler = current === tools.measure ? tools.measure.ruler() : null
      const hoveredId = current === select ? select.hoveredId() : null
      const dragGhosts = select.dragGhosts()
      // Terrain mode: shapes are the selection (in its preview); objects show as unselected.
      const selectedIds = current === tools.terrain ? NO_IDS : s.selection
      const key = [selectedIds, hoveredId, preview, ruler, dragGhosts]
      if (overlayCache && overlayCache.key.every((v, k) => v === key[k])) return overlayCache.value
      const value: EditorOverlays = { selectedIds, hoveredId, preview, ruler, dragGhosts }
      overlayCache = { key, value }
      return value
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    setTerrainPreview(fn) {
      terrainPreview = fn
    },

    setProjector(fn) {
      projector = fn
    },

    toolCursor: () => current.cursor?.() ?? null,

    toolHint: () => current.hint?.() ?? null,

    cursor: () => lastPointer,

    pasteTarget,

    cancelGesture() {
      current.cancel?.()
    },

    dispose() {
      current.cancel?.()
      unsubscribe()
      listeners.clear()
    },
  }
  return controller
}
