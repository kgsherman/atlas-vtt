/**
 * Editor contexts of the map screen (ARCHITECTURE §7): the page commands the editor's menus and panels
 * call, and the engine handle, so the editor's components work unchanged on the table's live map.
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
import {
  inTerrainMode,
  runEditorCommand,
  selectionFocusBounds,
} from "@/components/editor/lib/terrainMode"
import { groundHeightAt } from "@/core/scene/queries"
import type { Id } from "@/core/scene/types"
import type { Engine } from "@/render/contracts"

import type { HostEditor } from "./hostEditor"

/** The map screen's commands that live outside the editor (dialogs, files, navigation). */
export interface MapScreenCommands {
  /** Save a restore point (Ctrl+S / File › Save a restore point). */
  save(): void
  newMap(opts?: { importImages?: boolean }): void
  openMapImport(levelId?: Id): void
  openVersions(): void
  exportFile(): void
  importFile(): void
  openShare(): void
  /** Back to the library. */
  leave(): void
  openShortcuts(): void
}

export function HostEditorProviders({
  editor,
  engine,
  commands,
  children,
}: {
  editor: HostEditor | null
  engine: Engine | null
  commands: MapScreenCommands
  children: React.ReactNode
}) {
  const confirm = useConfirm()
  const store = editor?.ctx.store ?? null
  const controller = editor?.ctx.controller ?? null
  const actions = React.useMemo<EditorActions | null>(() => {
    if (!store || !controller) return null
    // In the terrain mode "the selection" is the terrain tool's shapes.
    const focusSelection = () => {
      const s = store.getState()
      const b = selectionFocusBounds(s)
      if (!engine || !b) return
      const c = { x: b.x + b.w / 2, z: b.z + b.d / 2 }
      engine.focus(
        { x: c.x, y: groundHeightAt(s.scene, s.activeLevelId, c), z: c.z },
        { distance: Math.max(30, Math.hypot(b.w, b.d) * 1.6) }
      )
    }
    return {
      save: commands.save,
      newScene: () => commands.newMap(),
      newFromImages: () => commands.newMap({ importImages: true }),
      openMapImport: (levelId?: Id) => commands.openMapImport(levelId),
      openVersions: commands.openVersions,
      exportFile: commands.exportFile,
      importFile: commands.importFile,
      openShare: commands.openShare,
      goHome: commands.leave,
      openShortcuts: commands.openShortcuts,
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
            "The level and everything on it are deleted (for everyone at the table, if it is open), and players forget what they explored there. You can undo this.",
          confirmLabel: "Delete level",
          destructive: true,
        })
        if (ok && !store.getState().removeLevel(levelId))
          toast.error("A scene needs at least one level")
      },
      deleteSelection: () => {
        controller.cancelGesture()
        if (inTerrainMode(store.getState()))
          runEditorCommand(controller, { type: "delete" })
        else store.getState().deleteSelection()
      },
    }
  }, [store, controller, engine, confirm, commands])
  const engineHandle = React.useMemo(() => ({ engine }), [engine])
  return (
    <EditorActionsContext.Provider value={actions}>
      <EditorEngineContext.Provider value={engineHandle}>
        {children}
      </EditorEngineContext.Provider>
    </EditorActionsContext.Provider>
  )
}
