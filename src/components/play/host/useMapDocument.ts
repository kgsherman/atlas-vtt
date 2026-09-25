/**
 * The map screen's document commands (ARCHITECTURE §6.8, §7): the live map is the table's (it saves
 * itself with the game); its library entry keeps restore points (versions). Restoring one, building
 * the map from battlemap images and renaming it are edits of the live map through the host editor (one
 * undo step each, for everyone at the table); sharing saves a restore point first so the link shows the
 * map as it is; export writes the live map; import and "New map" open another map (through `go`, which
 * leaves this one the usual way).
 */
import * as React from "react"
import { toast } from "sonner"

import { downloadText } from "@/app/clipboard"
import { importSceneFile, userMessage } from "@/app/library"
import { paths } from "@/app/routes"
import { useServices } from "@/app/services"
import { useConfirm } from "@/components/editor/context"
import type { ShareDocument } from "@/components/editor/dialogs/ShareDialog"
import type { MapImportTarget } from "@/components/editor/dialogs/MapImportDialog"
import type { VersionsDocument } from "@/components/editor/dialogs/VersionHistorySheet"
import { describeIssues } from "@/components/editor/lib/format"
import type { MenuDocument } from "@/components/editor/MenuBar"
import type { Scene } from "@/core/scene/types"
import type { EditorStore } from "@/editor/store"
import type { HostSnapshot } from "@/net/host"
import {
  exportSceneFileWithAssets,
  type SceneSummary,
  type SceneVersionInfo,
} from "@/net/scenesRepo"

import type { HostEditor } from "./hostEditor"
import type { SaveMap } from "./useSaveMap"

export interface MapDocument
  extends MenuDocument, ShareDocument, VersionsDocument, MapImportTarget {
  exportFile(): Promise<void>
  importFile(file: File): Promise<void>
  newMap(opts?: { importImages?: boolean }): void
  /** Rename the map (the live map and its library entry). */
  rename(name: string): void
}

/** Replace the whole live map as one edit (undoable), keeping its document id (images live under it). */
export function replaceMap(
  store: EditorStore,
  scene: Scene,
  label: string
): boolean {
  const id = store.getState().scene.id
  const patches = store.getState().apply((d) => {
    const src = structuredClone({ ...scene, id }) as Scene
    const target = d as unknown as Record<string, unknown>
    for (const key of Object.keys(target))
      if (!Object.hasOwn(src, key)) delete target[key]
    for (const [key, value] of Object.entries(src)) target[key] = value
  }, label)
  return patches.length > 0
}

export function useMapDocument({
  snap,
  editor,
  saveMap,
  go,
}: {
  snap: Pick<HostSnapshot, "library" | "state">
  editor: HostEditor | null
  saveMap: Pick<SaveMap, "library" | "dirty" | "save">
  /** Leave this map for another page (restore point and the open-table question first). */
  go(to: string): void
}): MapDocument {
  const services = useServices()
  const confirm = useConfirm()
  const { scenes, assets } = services
  const linked = saveMap.library.status === "linked"
  const libraryId = linked && snap.library ? snap.library.sceneId : null
  const [summary, setSummary] = React.useState<SceneSummary | null>(null)
  const [busy, setBusy] = React.useState<string | null>(null)
  const live = React.useRef({ snap, editor, saveMap })
  React.useEffect(() => {
    live.current = { snap, editor, saveMap }
  })

  React.useEffect(() => {
    if (!libraryId) return
    let alive = true
    scenes.get(libraryId).then(
      (s) => alive && setSummary(s),
      () => alive && setSummary(null)
    )
    return () => {
      alive = false
    }
  }, [scenes, libraryId])
  const shownSummary = summary && summary.id === libraryId ? summary : null

  /** A restore point of the map as it is now, when it changed since the last one (false: it could not be saved). */
  const keepRestorePoint = React.useCallback(async () => {
    const cur = live.current.saveMap
    if (!cur.dirty || cur.library.status !== "linked") return true
    return cur.save({ quiet: true })
  }, [])

  const listVersions = React.useCallback(
    async () => (libraryId ? scenes.listVersions(libraryId) : []),
    [scenes, libraryId]
  )

  const restoreVersion = React.useCallback(
    async (v: SceneVersionInfo) => {
      const store = live.current.editor?.ctx.store
      if (!libraryId || !store) return
      const ok = await confirm({
        title: `Restore version ${v.version}?`,
        description:
          "The map goes back to how it was then — tokens, doors and lights included — for everyone at the table. The map as it is now is kept as a restore point, and you can undo this.",
        confirmLabel: "Restore",
      })
      if (!ok) return
      setBusy(`Restoring version ${v.version}…`)
      try {
        if (!(await keepRestorePoint())) return
        const loaded = await scenes.load(libraryId, v.version)
        if (!loaded.parsed.ok)
          throw new Error(
            loaded.parsed.error === "too-new"
              ? "That version needs a newer Atlas."
              : describeIssues(loaded.parsed.issues)
          )
        if (
          replaceMap(store, loaded.parsed.scene, `Restore version ${v.version}`)
        )
          toast.success(`Restored version ${v.version}`, {
            description: "Undo puts the map back as it was.",
          })
        else toast.info(`The map is already as it was in version ${v.version}`)
      } catch (err) {
        toast.error("Could not restore the version", {
          description: userMessage(err),
        })
      } finally {
        setBusy(null)
      }
    },
    [libraryId, scenes, confirm, keepRestorePoint]
  )

  const setSharing = React.useCallback<MapDocument["setSharing"]>(
    async (visibility, opts = {}) => {
      if (!libraryId) return null
      if (visibility === "link" && !(await keepRestorePoint()))
        throw new Error("The map could not be saved to your library first.")
      const slug = await scenes.setVisibility(libraryId, visibility, opts)
      setSummary((s) =>
        s && s.id === libraryId ? { ...s, visibility, shareSlug: slug } : s
      )
      return slug
    },
    [libraryId, scenes, keepRestorePoint]
  )

  const exportFile = React.useCallback(async () => {
    const scene = live.current.snap.state?.scene
    if (!scene) return
    setBusy("Preparing the export…")
    try {
      const file = await exportSceneFileWithAssets(scene, assets)
      downloadText(file.fileName, file.mimeType, file.text)
      if (file.missing.length > 0) {
        const names = file.missing.map((id) => scene.assets?.[id]?.name ?? id)
        toast.warning("Exported without some map images", {
          description: names.join(", "),
        })
      } else toast.success(`Exported ${file.fileName}`)
    } catch (err) {
      toast.error("Export failed", { description: userMessage(err) })
    } finally {
      setBusy(null)
    }
  }, [assets])

  const importFile = React.useCallback(
    async (file: File) => {
      setBusy(`Importing ${file.name}…`)
      try {
        const { summary: created, warnings } = await importSceneFile(
          services,
          file
        )
        toast.success(`Imported “${created.name}”`, {
          description: "Added to your library as a new map.",
        })
        for (const w of warnings) toast.warning(w)
        go(paths.map(created.id))
      } catch (err) {
        toast.error("Import failed", { description: userMessage(err) })
      } finally {
        setBusy(null)
      }
    },
    [services, go]
  )

  const newMap = React.useCallback(
    (opts: { importImages?: boolean } = {}) =>
      go(opts.importImages ? paths.newFromImages() : paths.newScene()),
    [go]
  )

  /** The library entry follows the live map's name. */
  const renameEntry = React.useCallback(
    (name: string) => {
      if (!libraryId) return
      scenes.rename(libraryId, name).then(
        (s) => setSummary(s),
        (err: unknown) =>
          toast.error("The library entry kept its old name", {
            description: userMessage(err),
          })
      )
    },
    [libraryId, scenes]
  )

  const adoptNewScene = React.useCallback(
    (scene: Scene) => {
      const store = live.current.editor?.ctx.store
      if (!store) return
      const before = store.getState().scene.name
      replaceMap(store, scene, "Build the map from map images")
      if (scene.name !== before) renameEntry(scene.name)
    },
    [renameEntry]
  )

  const rename = React.useCallback(
    (name: string) => {
      const store = live.current.editor?.ctx.store
      if (!store) return
      store.getState().updateSceneInfo({ name })
      renameEntry(name)
    },
    [renameEntry]
  )

  const baseVersion = snap.library?.version ?? null
  return React.useMemo(
    () => ({
      libraryId,
      storage: scenes.storage,
      summary: shownSummary,
      baseVersion,
      busy,
      listVersions,
      restoreVersion,
      setSharing,
      exportFile,
      importFile,
      newMap,
      adoptNewScene,
      rename,
    }),
    [
      libraryId,
      scenes.storage,
      shownSummary,
      baseVersion,
      busy,
      listVersions,
      restoreVersion,
      setSharing,
      exportFile,
      importFile,
      newMap,
      adoptNewScene,
      rename,
    ]
  )
}
