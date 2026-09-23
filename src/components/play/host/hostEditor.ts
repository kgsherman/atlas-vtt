/**
 * "Edit map" during a live session (ARCHITECTURE §6.2 "DM edits during a live session", §7): an editor
 * store seeded with the live scene whose patch sink forwards every edit to HostRunner (DmCommand
 * apply-scene-patches) and whose play sink routes door/light/token-drag actions as DmCommands. The host's
 * scene is adopted back after every change (players moving, DM commands), so the editor always edits
 * the authoritative document. The editor's own components (tool rail, options bar, sidebar panels) are
 * reused as-is through the editor contexts.
 */
import * as React from "react"
import { toast } from "sonner"

import type { EditorContextValue } from "@/components/editor/context"
import { describeIssues } from "@/components/editor/lib/format"
import { createToolExtrasStore } from "@/components/editor/lib/toolExtras"
import type { Id, Scene } from "@/core/scene/types"
import { createEditorController } from "@/editor/controller"
import type { EditorViewOptions } from "@/editor/settings"
import { createEditorStore } from "@/editor/store"
import type { HostRunnerImpl } from "@/net/host"
import type { CameraKind } from "@/render/contracts"

export interface HostEditor {
  ctx: EditorContextValue
  dispose(): void
}

/** View options the DM's choices carry over between "Edit map" sessions. */
export type HostEditorView = Partial<
  Pick<EditorViewOptions, "ghostAdjacent" | "levelVisibility" | "darkVision">
>

/**
 * Editor store + controller bound to the live session. The view starts from the editor defaults
 * (adjacent levels ghosted, like the standalone editor, so an upper storey never covers the level
 * being edited), then `opts.view` (the DM's choices from the previous edit).
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
      toast.error(`Couldn't apply “${meta.label}” to the live session`, {
        description: r?.error ?? "This tab is not hosting the session.",
      })
      resync()
    }
  })
  store.getState().setPlaySink((cmd) => {
    const r = runner.dispatch(cmd)
    if (!r || r.error)
      toast.error("That didn't work", {
        description: r?.error ?? "This tab is not hosting the session.",
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
    dispose() {
      unsubRejected()
      store.getState().setPatchSink(null)
      store.getState().setPlaySink(null)
      controller.dispose()
    },
  }
}

/** Keep the editor on the authoritative scene. */
export function useAdoptHostScene(
  editor: HostEditor | null,
  scene: Scene | null
): void {
  React.useEffect(() => {
    if (!editor || !scene) return
    const st = editor.ctx.store.getState()
    if (st.scene !== scene) st.syncScene(scene)
  }, [editor, scene])
}
