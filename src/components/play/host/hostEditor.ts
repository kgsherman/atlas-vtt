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
import { isTextEntryTarget } from "@/components/editor/lib/pointer"
import { createToolExtrasStore } from "@/components/editor/lib/toolExtras"
import type { Id, Scene } from "@/core/scene/types"
import { createEditorController } from "@/editor/controller"
import { createEditorStore } from "@/editor/store"
import type { HostRunnerImpl } from "@/net/host"
import type { CameraKind } from "@/render/contracts"

import { overlayOpen } from "../input"

export interface HostEditor {
  ctx: EditorContextValue
  dispose(): void
}

/** Editor store + controller bound to the live session. */
export function createHostEditor(
  runner: HostRunnerImpl,
  scene: Scene,
  opts: { camera: CameraKind; activeLevelId: Id | null }
): HostEditor {
  const store = createEditorStore({ scene })
  const s = store.getState()
  s.setView({ camera: opts.camera, ghostAdjacent: false })
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

/** Editor keyboard shortcuts while editing (capture phase, like the editor page). */
export function useHostEditKeys(
  editor: HostEditor | null,
  onExit: () => void
): void {
  const exitRef = React.useRef(onExit)
  React.useEffect(() => {
    exitRef.current = onExit
  })
  React.useEffect(() => {
    if (!editor) return
    const { store, controller } = editor.ctx
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (ctrl && !e.altKey && key === "s") {
        e.preventDefault()
        toast.info("Edits apply to the live session", {
          id: "live-save",
          description:
            "The session saves automatically; your library scene is unchanged.",
        })
        return
      }
      if (isTextEntryTarget(e.target) || overlayOpen()) return
      if (e.key === "Alt") e.preventDefault()
      const consumed = controller.keyDown({
        key: e.key,
        shift: e.shiftKey,
        alt: e.altKey,
        ctrl,
      })
      if (consumed) e.preventDefault()
      else if (e.key === "Escape" && store.getState().selection.length === 0) {
        e.preventDefault()
        exitRef.current()
      }
      if (!ctrl && !e.altKey && e.key.length === 1 && (consumed || key === "d"))
        e.stopPropagation()
    }
    const onKeyUp = (e: KeyboardEvent) =>
      controller.keyUp({
        key: e.key,
        shift: e.shiftKey,
        alt: e.altKey,
        ctrl: e.ctrlKey || e.metaKey,
      })
    const onBlur = () => store.getState().setAltHeld(false)
    window.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", onBlur)
    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", onBlur)
    }
  }, [editor])
}
