/**
 * Editor contexts for "Edit map" in a live session: the editor page's actions (where they make sense
 * during a session) and the engine handle, so the editor's panels work unchanged.
 */
import * as React from "react"
import { toast } from "sonner"

import {
  EditorActionsContext,
  EditorEngineContext,
  useConfirm,
  type EditorActions,
} from "@/components/editor/context"
import { duplicateLevel } from "@/components/editor/lib/levelOps"
import { selectionBounds } from "@/core/scene/integrity"
import { groundHeightAt } from "@/core/scene/queries"
import type { Id } from "@/core/scene/types"
import type { Engine } from "@/render/contracts"

import type { HostEditor } from "./hostEditor"

/** Editor page actions as far as they make sense in a live session. */
export function HostEditorProviders({
  editor,
  engine,
  onPreviewToken,
  onExit,
  children,
}: {
  editor: HostEditor | null
  engine: Engine | null
  onPreviewToken(id: Id): void
  onExit(): void
  children: React.ReactNode
}) {
  const confirm = useConfirm()
  const store = editor?.ctx.store ?? null
  const controller = editor?.ctx.controller ?? null
  const actions = React.useMemo<EditorActions | null>(() => {
    if (!store || !controller) return null
    const unavailable = (what: string) => () =>
      toast.info(`${what} isn't available during a live session`, {
        description:
          "Open the scene in the editor after the session to do this.",
      })
    const focusSelection = () => {
      const s = store.getState()
      const b = selectionBounds(s.scene, s.selection)
      if (!engine || !b) return
      const c = { x: b.x + b.w / 2, z: b.z + b.d / 2 }
      engine.focus(
        { x: c.x, y: groundHeightAt(s.scene, s.activeLevelId, c), z: c.z },
        { distance: Math.max(30, Math.hypot(b.w, b.d) * 1.6) }
      )
    }
    return {
      save: () =>
        toast.info("Edits apply to the live session", {
          id: "live-save",
          description: "The session saves automatically.",
        }),
      newScene: unavailable("Creating a scene"),
      newFromImages: unavailable("Creating a scene"),
      openMapImport: unavailable("Importing map images"),
      openVersions: unavailable("Version history"),
      exportFile: unavailable("Exporting"),
      importFile: unavailable("Importing"),
      openShare: unavailable("Sharing"),
      startSession: () => toast.info("This session is already running"),
      goHome: onExit,
      openShortcuts: () =>
        toast.info("Editor shortcuts work as in the editor", {
          description:
            "W walls, D doors, L lights, K tokens, V select · Ctrl+Z undo.",
        }),
      enterPreview: (tokenId?: Id) => {
        const id =
          tokenId ??
          store
            .getState()
            .selection.find((sid) =>
              Object.hasOwn(store.getState().scene.tokens, sid)
            )
        if (id) onPreviewToken(id)
        else toast.info("Select a token to preview its vision")
      },
      exitPreview: () => {},
      frameScene: () => engine?.frameScene(),
      focusSelection,
      addLevel: () => {
        if (!store.getState().addLevel())
          toast.error("Could not add a level", {
            description: "A scene can have at most 32 levels.",
          })
      },
      duplicateLevel: (levelId?: Id) => {
        if (!duplicateLevel(store, levelId ?? store.getState().activeLevelId))
          toast.error("Could not duplicate the level")
      },
      deleteLevel: async (levelId: Id) => {
        const s = store.getState()
        const level = Object.hasOwn(s.scene.levels, levelId)
          ? s.scene.levels[levelId]
          : null
        if (!level) return
        const ok = await confirm({
          title: `Delete “${level.name}”?`,
          description:
            "The level and everything on it are deleted for everyone at the table, and players forget what they explored there. You can undo this.",
          confirmLabel: "Delete level",
          destructive: true,
        })
        if (ok && !store.getState().removeLevel(levelId))
          toast.error("A scene needs at least one level")
      },
      deleteSelection: () => {
        controller.cancelGesture()
        store.getState().deleteSelection()
      },
    }
  }, [store, controller, engine, confirm, onExit, onPreviewToken])
  const engineHandle = React.useMemo(() => ({ engine }), [engine])
  return (
    <EditorActionsContext.Provider value={actions}>
      <EditorEngineContext.Provider value={engineHandle}>
        {children}
      </EditorEngineContext.Provider>
    </EditorActionsContext.Provider>
  )
}
