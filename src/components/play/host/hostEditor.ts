/**
 * Edit on the map screen (ARCHITECTURE §6.2 "DM edits at the table", §7): an editor store seeded with the
 * live map whose patch sink forwards every edit to HostRunner (DmCommand apply-scene-patches) and whose
 * play sink routes door/light/token-drag actions as DmCommands. The host's scene is adopted back after
 * every change (players moving, DM commands), so the editor always edits the authoritative document. One
 * editor lives for the whole visit of a map (undo survives Edit ↔ Play); another map gets a new one. The
 * editor's own components (tool rail, options bar, sidebar panels, menus) are reused as-is through the
 * editor contexts.
 */
import * as React from "react"
import { toast } from "sonner"

import type { EditorContextValue } from "@/components/editor/context"
import { describeIssues } from "@/components/editor/lib/format"
import { createToolExtrasStore } from "@/components/editor/lib/toolExtras"
import {
  createCursorStore,
  type CursorStore,
} from "@/components/editor/lib/viewportInfo"
import type { Id, Scene } from "@/core/scene/types"
import { createEditorController } from "@/editor/controller"
import type { EditorViewOptions } from "@/editor/settings"
import { createEditorStore } from "@/editor/store"
import type { HostRunnerImpl } from "@/net/host"
import type { CameraKind } from "@/render/contracts"

export interface HostEditor {
  ctx: EditorContextValue
  /** The cell and point under the cursor in Edit (the status bar's readout). */
  cursor: CursorStore
  dispose(): void
}

/** View options the editor starts with (the DM's choices for this map on this device). */
export type HostEditorView = Partial<
  Pick<
    EditorViewOptions,
    | "ghostAdjacent"
    | "levelVisibility"
    | "darkVision"
    | "showGrid"
    | "showHelpers"
  >
>

/**
 * Editor store + controller bound to the table's live map. The view starts from the editor defaults
 * (adjacent levels ghosted, so an upper storey never covers the level being edited), then `opts.view`
 * (the DM's choices for this map on this device).
 */
export function createHostEditor(
  runner: HostRunnerImpl,
  scene: Scene,
  opts: {
    camera: CameraKind
    activeLevelId: Id | null
    view?: HostEditorView
  }
): HostEditor {
  const store = createEditorStore({ scene })
  const s = store.getState()
  s.setView({ camera: opts.camera, ...opts.view })
  if (opts.activeLevelId && Object.hasOwn(scene.levels, opts.activeLevelId))
    s.setActiveLevel(opts.activeLevelId)
  s.markSaved()

  const resync = () => {
    const live = runner.getSnapshot().state?.scene
    if (live) store.getState().syncScene(live)
  }
  store.getState().setPatchSink((patches, meta) => {
    const r = runner.dispatch({ t: "apply-scene-patches", patches })
    if (!r || r.error) {
      toast.error(`Couldn't apply “${meta.label}” to the scene`, {
        description: r?.error ?? "This tab isn't running the table.",
      })
      resync()
    }
  })
  store.getState().setPlaySink((cmd) => {
    const r = runner.dispatch(cmd)
    if (!r || r.error)
      toast.error("That didn't work", {
        description: r?.error ?? "This tab isn't running the table.",
      })
  })
  const controller = createEditorController(store)
  const extras = createToolExtrasStore()
  const unsubRejected = store.subscribe((st, prev) => {
    const r = st.lastRejected
    if (!r || r === prev.lastRejected) return
    toast.error(`Can't ${r.label.charAt(0).toLowerCase()}${r.label.slice(1)}`, {
      id: "edit-rejected",
      description: describeIssues(r.issues),
    })
  })
  return {
    ctx: { store, controller, extras },
    cursor: createCursorStore(),
    dispose() {
      unsubRejected()
      store.getState().setPatchSink(null)
      store.getState().setPlaySink(null)
      controller.dispose()
    },
  }
}

/** Keep the editor on the authoritative scene (never another map's: a map change brings a new editor). */
export function useAdoptHostScene(
  editor: HostEditor | null,
  scene: Scene | null
): void {
  React.useEffect(() => {
    if (!editor || !scene) return
    const st = editor.ctx.store.getState()
    if (st.scene !== scene && st.scene.id === scene.id) st.syncScene(scene)
  }, [editor, scene])
}
