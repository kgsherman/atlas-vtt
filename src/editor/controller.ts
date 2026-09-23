/**
 * Glue between the editor canvas and the tools: owns the tool instances, routes pointer/key events
 * to the active tool (then to the keymap), cancels gestures when the tool changes, and assembles
 * the overlay state the canvas passes to engine.setOverlays(). Framework-free; the React canvas
 * builds ToolPointerEvents (engine.pick + snapping) and calls in.
 */
import type { Id, Rect, Vec2 } from "@/core/scene/types"
import type { OverlayState, PickResult } from "@/render/contracts"

import { resolveShortcut, runShortcut } from "./shortcuts"
import type { EditorStore } from "./store"
import { createTools, type ToolSet } from "./tools"
import type { Tool, ToolKeyEvent, ToolPointerEvent } from "./tools/types"

export type EditorOverlays = Pick<OverlayState, "selectedIds" | "hoveredId" | "preview" | "ruler" | "dragGhosts">

export interface EditorController {
  readonly store: EditorStore
  readonly tools: ToolSet
  activeTool(): Tool
  pointerDown(e: ToolPointerEvent): void
  pointerMove(e: ToolPointerEvent): void
  pointerUp(e: ToolPointerEvent): void
  /** Returns true when the key was consumed (the canvas should preventDefault). */
  keyDown(e: ToolKeyEvent): boolean
  keyUp(e: ToolKeyEvent): void
  /** Overlay state for the engine; the same object is returned until something in it changes. */
  overlays(): EditorOverlays
  /** Listen for overlay / preview changes (the canvas pushes overlays() to the engine). */
  subscribe(listener: () => void): () => void
  /** Engine.previewTerrain (set once the engine exists). */
  setTerrainPreview(fn: ((levelId: Id, heights: Float32Array | null, dirty: Rect | null) => void) | null): void
  /** Last pointer position on the active level (paste target). */
  cursor(): { ground: Vec2 | null; pick: PickResult } | null
  /** Cancel the active tool's gesture (e.g. when the canvas loses the pointer). */
  cancelGesture(): void
  dispose(): void
}

export function createEditorController(store: EditorStore, opts: { now?: () => number } = {}): EditorController {
  const listeners = new Set<() => void>()
  let terrainPreview: ((levelId: Id, heights: Float32Array | null, dirty: Rect | null) => void) | null = null
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
      s.scene !== prev.scene ||
      s.toolSettings !== prev.toolSettings ||
      s.snapMode !== prev.snapMode ||
      s.altHeld !== prev.altHeld ||
      s.activeLevelId !== prev.activeLevelId
    ) {
      emit()
    }
  })

  const track = (e: ToolPointerEvent) => {
    lastPointer = { ground: e.ground ? { ...e.ground } : null, pick: e.pick }
  }

  const pasteTarget = (): { at?: Vec2; hostWallId?: Id } => {
    if (!lastPointer?.ground) return {}
    const s = store.getState()
    const objectId = lastPointer.pick.objectId
    const hostWallId = objectId && Object.hasOwn(s.scene.objects, objectId) && s.scene.objects[objectId].type === "wall" ? objectId : undefined
    return { at: lastPointer.ground, hostWallId }
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

    keyDown(e) {
      if (e.key === "Alt") {
        store.getState().setAltHeld(true)
        return false
      }
      if (current.onKeyDown?.(e)) return true
      const action = resolveShortcut(e)
      if (!action) return false
      return runShortcut(action, { store, cancelGesture: () => current.cancel?.(), pasteTarget })
    },

    keyUp(e) {
      if (e.key === "Alt" || !e.alt) store.getState().setAltHeld(false)
    },

    overlays() {
      const s = store.getState()
      const select = tools.select
      const preview = current.preview()
      const ruler = current === tools.measure ? tools.measure.ruler() : null
      const hoveredId = current === select ? select.hoveredId() : null
      const dragGhosts = select.dragGhosts()
      const key = [s.selection, hoveredId, preview, ruler, dragGhosts]
      if (overlayCache && overlayCache.key.every((v, k) => v === key[k])) return overlayCache.value
      const value: EditorOverlays = { selectedIds: s.selection, hoveredId, preview, ruler, dragGhosts }
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

    cursor: () => lastPointer,

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
