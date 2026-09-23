/**
 * The editor page's document lifecycle: open (/editor/new or a library id), save (first save
 * creates the library entry and replaces the URL), autosave drafts to IndexedDB every ~10 s with
 * recovery, version history (open read-only / restore), .atlas.json export/import with embedded
 * images, link sharing and "Start session".
 */
import * as React from "react"
import { toast } from "sonner"

import { importedName } from "@/app/library"
import { paths } from "@/app/routes"
import type { AppServices } from "@/app/services"
import { createScene } from "@/core/scene/factory"
import { parseScene } from "@/core/scene/schema"
import type { Scene } from "@/core/scene/types"
import type { DocumentStash, EditorStore } from "@/editor/store"
import { deleteDraft, getLocalStore, listDrafts, loadDraft, saveDraft } from "@/net/localStore"
import { exportSceneFileWithAssets, importSceneFileWithAssets, type SceneSummary, type SceneVersionInfo, type SceneVisibility } from "@/net/scenesRepo"
import { describeNetError, isNetError } from "@/net/supabase"
import type { CreateSessionOptions } from "@/net/sessionsRepo"

import type { ConfirmFn } from "./context"
import { withPreset } from "./lib/environmentPresets"
import { describeIssues } from "./lib/format"
import { retainLevelImages } from "./lib/levelImages"

export type DocStatus = "loading" | "ready" | "error" | "too-new"

export interface DraftData {
  /** As saved: possibly an older schema version (recovered through draftScene). */
  scene: Scene
  libraryId: string | null
  baseVersion: number | null
}

export interface RecoverableDraft {
  key: string
  savedAt: string
  scene: Scene
}

interface DocMeta {
  /** Route id these fields describe (a different route id means "loading"). */
  routeId: string
  status: Exclude<DocStatus, "loading">
  error: string | null
  libraryId: string | null
  summary: SceneSummary | null
  /** Latest saved version known to this tab (optimistic base for the next save). */
  baseVersion: number | null
  /** Set while an older version is open read-only. */
  viewingVersion: SceneVersionInfo | null
  /** Schema version of a too-new document. */
  tooNewSchema: number | null
}

export interface SceneDocument {
  status: DocStatus
  error: string | null
  libraryId: string | null
  summary: SceneSummary | null
  baseVersion: number | null
  viewingVersion: SceneVersionInfo | null
  tooNewSchema: number | null
  storage: "remote" | "local"
  saving: boolean
  lastSavedAt: string | null
  draftSavedAt: string | null
  recoverable: RecoverableDraft | null
  busy: string | null

  save(opts?: { force?: boolean }): Promise<string | null>
  newScene(opts?: { importImages?: boolean }): Promise<void>
  listVersions(): Promise<SceneVersionInfo[]>
  openVersion(v: SceneVersionInfo): Promise<void>
  backToLatest(): Promise<void>
  restoreVersion(v: SceneVersionInfo): Promise<void>
  exportFile(): Promise<void>
  importFile(file: File): Promise<void>
  setSharing(visibility: SceneVisibility, opts?: { rotate?: boolean }): Promise<string | null>
  /** Save if needed, then start a game (with the free asset categories it loads) and open the host console. */
  startSession(opts?: CreateSessionOptions): Promise<void>
  restoreDraft(): void
  discardDraft(): Promise<void>
  /** Adopt a scene created outside the store (e.g. "new scene from map images") as an unsaved document. */
  adoptNewScene(scene: Scene): void
}

export const AUTOSAVE_INTERVAL_MS = 10_000

/** A new editor scene: one grassy ground level under a moonlit sky (so the DM can see what they build). */
export function blankScene(): Scene {
  const scene = createScene()
  scene.environment = withPreset(scene.environment, "moonlit")
  return scene
}
const UNSAVED_PREFIX = "editor:unsaved:"

export function draftKey(libraryId: string | null, sceneId: string): string {
  return libraryId ? `editor:${libraryId}` : `${UNSAVED_PREFIX}${sceneId}`
}

/**
 * A recovered autosave draft as a current document, or null when it cannot be opened. Drafts are stored
 * as they were saved, possibly by an older app version (or damaged), so they go through the migrations and
 * the strict validation like any stored document (parseScene; a current draft passes through unchanged).
 */
export function draftScene(raw: unknown): Scene | null {
  const parsed = parseScene(raw)
  if (parsed.ok) return parsed.scene
  console.warn(`[atlas] ignoring an autosave draft that cannot be opened (${parsed.error})`, parsed.issues)
  return null
}

export function errorText(err: unknown): string {
  if (isNetError(err)) return describeNetError(err.code)
  return err instanceof Error ? err.message : String(err)
}

function downloadText(fileName: string, text: string, mime = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement("a")
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Replace the whole document as one undoable edit (restoring a draft keeps the saved version under undo). */
function replaceDocument(store: EditorStore, scene: Scene, label: string): boolean {
  const patches = store.getState().apply((d) => {
    const src = structuredClone(scene) as Scene
    const target = d as unknown as Record<string, unknown>
    for (const key of Object.keys(target)) if (!Object.hasOwn(src, key)) delete target[key]
    for (const [key, value] of Object.entries(src)) target[key] = value
  }, label)
  return patches.length > 0
}

export interface UseSceneDocumentOptions {
  store: EditorStore
  services: AppServices
  routeId: string
  wantsImport: boolean
  navigate(to: string, opts?: { replace?: boolean }): void
  confirm: ConfirmFn
  onRequestImport(): void
}

export function useSceneDocument({ store, services, routeId, wantsImport, navigate, confirm, onRequestImport }: UseSceneDocumentOptions): SceneDocument {
  const { scenes, sessions, assets } = services
  const [meta, setMeta] = React.useState<DocMeta | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [busy, setBusy] = React.useState<string | null>(null)
  const [lastSavedAt, setLastSavedAt] = React.useState<string | null>(null)
  const [draftSavedAt, setDraftSavedAt] = React.useState<string | null>(null)
  const [recoverable, setRecoverable] = React.useState<RecoverableDraft | null>(null)

  const libraryIdRef = React.useRef<string | null>(null)
  const baseVersionRef = React.useRef<number | null>(null)
  const savingRef = React.useRef<Promise<string | null> | null>(null)
  const draftRevision = React.useRef(-1)
  const forceSaveRef = React.useRef<() => void>(() => {})
  const loadSeq = React.useRef(0)
  const opts = React.useRef({ wantsImport, onRequestImport, navigate })
  React.useEffect(() => {
    opts.current = { wantsImport, onRequestImport, navigate }
  })

  const setLibrary = React.useCallback((libraryId: string | null, baseVersion: number | null) => {
    libraryIdRef.current = libraryId
    baseVersionRef.current = baseVersion
  }, [])

  const checkDrafts = React.useCallback(async (key: string | null, loadedAt: string | null, current: Scene) => {
    try {
      const local = await getLocalStore()
      let draftKeyToUse = key
      if (!draftKeyToUse) {
        // New document: offer the most recent unsaved scene from an earlier visit (≤ 7 days).
        const recent = (await listDrafts(local)).find((d) => d.key.startsWith(UNSAVED_PREFIX))
        if (!recent || Date.now() - Date.parse(recent.savedAt) > 7 * 24 * 3600 * 1000) return
        draftKeyToUse = recent.key
      }
      const draft = await loadDraft<DraftData>(local, draftKeyToUse)
      if (!draft || !draft.data?.scene) return
      if (loadedAt && Date.parse(draft.savedAt) <= Date.parse(loadedAt)) {
        await deleteDraft(local, draftKeyToUse)
        return
      }
      if (draft.data.scene.id === current.id && JSON.stringify(draft.data.scene) === JSON.stringify(current)) return
      const scene = draftScene(draft.data.scene)
      if (!scene) return
      setRecoverable({ key: draftKeyToUse, savedAt: draft.savedAt, scene })
    } catch (err) {
      console.warn("[atlas] could not read autosave drafts", err)
    }
  }, [])

  const openNew = React.useCallback(
    async (forRoute: string, scene: Scene = blankScene()) => {
      store.getState().loadScene(scene)
      retainLevelImages(scene.id)
      setLibrary(null, null)
      draftRevision.current = store.getState().revision
      setRecoverable(null)
      setLastSavedAt(null)
      setDraftSavedAt(null)
      setMeta({ routeId: forRoute, status: "ready", error: null, libraryId: null, summary: null, baseVersion: null, viewingVersion: null, tooNewSchema: null })
    },
    [store, setLibrary]
  )

  // ---- open the route's document --------------------------------------------------------------
  React.useEffect(() => {
    // Already showing it (the URL was replaced after the first save or an import).
    if (routeId !== "new" && routeId === libraryIdRef.current) return
    const seq = ++loadSeq.current
    const open = async () => {
      await Promise.resolve()
      if (seq !== loadSeq.current) return
      if (routeId === "new") {
        await openNew(routeId)
        if (opts.current.wantsImport) opts.current.onRequestImport()
        else await checkDrafts(null, null, store.getState().scene)
        return
      }
      try {
        const loaded = await scenes.load(routeId)
        if (seq !== loadSeq.current) return
        if (!loaded.parsed.ok) {
          const tooNew = loaded.parsed.error === "too-new"
          setLibrary(routeId, loaded.summary.latestVersion)
          setMeta({
            routeId,
            status: tooNew ? "too-new" : "error",
            error: tooNew ? null : `This scene could not be opened: ${describeIssues(loaded.parsed.issues)}`,
            libraryId: routeId,
            summary: loaded.summary,
            baseVersion: loaded.summary.latestVersion,
            viewingVersion: null,
            tooNewSchema: loaded.schemaVersion,
          })
          return
        }
        const scene = loaded.parsed.scene
        store.getState().loadScene(scene)
        retainLevelImages(scene.id)
        setLibrary(routeId, loaded.version)
        draftRevision.current = store.getState().revision
        setRecoverable(null)
        setLastSavedAt(loaded.summary.updatedAt)
        setDraftSavedAt(null)
        setMeta({ routeId, status: "ready", error: null, libraryId: routeId, summary: loaded.summary, baseVersion: loaded.version, viewingVersion: null, tooNewSchema: null })
        if (loaded.parsed.migratedFrom !== null) toast.info(`Upgraded from scene format v${loaded.parsed.migratedFrom}`, { description: "Save to keep the upgraded document." })
        await checkDrafts(draftKey(routeId, scene.id), loaded.summary.updatedAt, scene)
      } catch (err) {
        if (seq !== loadSeq.current) return
        setMeta({
          routeId,
          status: "error",
          error: isNetError(err, "not_found") ? "This scene does not exist, or you do not have access to it." : errorText(err),
          libraryId: null,
          summary: null,
          baseVersion: null,
          viewingVersion: null,
          tooNewSchema: null,
        })
      }
    }
    void open()
  }, [routeId, scenes, store, openNew, checkDrafts, setLibrary])

  const ready = meta !== null && meta.status === "ready" && (meta.routeId === routeId || meta.libraryId === routeId)

  // ---- autosave drafts ------------------------------------------------------------------------
  React.useEffect(() => {
    if (!ready) return
    const timer = setInterval(() => {
      const s = store.getState()
      if (!s.dirty || s.readOnly || s.revision === draftRevision.current) return
      draftRevision.current = s.revision
      const data: DraftData = { scene: s.scene, libraryId: libraryIdRef.current, baseVersion: baseVersionRef.current }
      getLocalStore()
        .then((local) => saveDraft(local, draftKey(libraryIdRef.current, s.scene.id), data))
        .then((d) => setDraftSavedAt(d.savedAt))
        .catch((err) => console.warn("[atlas] autosave failed", err))
    }, AUTOSAVE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [ready, store])

  // Unsaved changes: ask before leaving the page.
  React.useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!store.getState().dirty) return
      e.preventDefault()
      e.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [store])

  // ---- save -----------------------------------------------------------------------------------
  const doSave = React.useCallback(
    async (force: boolean): Promise<string | null> => {
      const s = store.getState()
      if (s.readOnly) {
        toast.info("This document is read-only", { description: "Restore the version or go back to the latest one to edit." })
        return null
      }
      if (s.history.transaction) s.commitTransaction()
      const headBefore = store.getState().history.head
      const scene: Scene = { ...store.getState().scene, updatedAt: new Date().toISOString() }
      const unsavedKey = libraryIdRef.current ? null : draftKey(null, scene.id)
      setSaving(true)
      try {
        let id = libraryIdRef.current
        let version: number
        let summary: SceneSummary | null = null
        if (!id) {
          summary = await scenes.create(scene)
          id = summary.id
          version = summary.latestVersion
        } else {
          version = await scenes.saveVersion(id, scene, force ? {} : { baseVersion: baseVersionRef.current ?? undefined })
        }
        setLibrary(id, version)
        if (store.getState().history.head === headBefore) store.getState().markSaved()
        const savedAt = new Date().toISOString()
        setLastSavedAt(savedAt)
        setDraftSavedAt(null)
        draftRevision.current = store.getState().revision
        setMeta((m) =>
          m
            ? {
                ...m,
                routeId: id,
                libraryId: id,
                baseVersion: version,
                summary: summary ?? (m.summary ? { ...m.summary, latestVersion: version, name: scene.name, updatedAt: savedAt } : m.summary),
              }
            : m
        )
        getLocalStore()
          .then(async (local) => {
            await deleteDraft(local, draftKey(id, scene.id))
            if (unsavedKey) await deleteDraft(local, unsavedKey)
          })
          .catch(() => {})
        if (summary) {
          opts.current.navigate(paths.editor(id), { replace: true })
          toast.success("Scene saved to your library")
        } else {
          toast.success(`Saved version ${version}`, { duration: 1800 })
        }
        return id
      } catch (err) {
        if (isNetError(err, "version_conflict")) {
          toast.error("This scene was saved from another tab or device", {
            description: "Overwrite it with your version, or reopen the latest one (your changes stay in the draft).",
            duration: 12_000,
            action: { label: "Overwrite", onClick: () => forceSaveRef.current() },
          })
        } else {
          toast.error("Could not save the scene", { description: errorText(err) })
        }
        return null
      } finally {
        setSaving(false)
      }
    },
    [scenes, store, setLibrary]
  )

  const save = React.useCallback(
    (o: { force?: boolean } = {}): Promise<string | null> => {
      if (savingRef.current) return savingRef.current
      const p = doSave(o.force ?? false).finally(() => {
        savingRef.current = null
      })
      savingRef.current = p
      return p
    },
    [doSave]
  )

  React.useEffect(() => {
    forceSaveRef.current = () => void save({ force: true })
  })

  const confirmDiscard = React.useCallback(
    async (action: string): Promise<boolean> => {
      if (!store.getState().dirty) return true
      return confirm({
        title: "Discard unsaved changes?",
        description: `You have unsaved changes. ${action} will discard them (a recent draft may still be recoverable).`,
        confirmLabel: "Discard changes",
        destructive: true,
      })
    },
    [confirm, store]
  )

  // ---- new / versions -------------------------------------------------------------------------
  const newScene = React.useCallback(
    async (o: { importImages?: boolean } = {}) => {
      if (!(await confirmDiscard("Starting a new scene"))) return
      if (routeId === "new") {
        await openNew("new")
        if (o.importImages) opts.current.onRequestImport()
        return
      }
      opts.current.navigate(o.importImages ? paths.newFromImages() : paths.newScene())
    },
    [confirmDiscard, openNew, routeId]
  )

  const adoptNewScene = React.useCallback(
    (scene: Scene) => {
      void openNew(meta?.routeId ?? "new", scene)
    },
    [openNew, meta?.routeId]
  )

  const listVersions = React.useCallback(async () => {
    const id = libraryIdRef.current
    if (!id) return []
    return scenes.listVersions(id)
  }, [scenes])

  /**
   * The latest document with its undo history, set aside while an old version is viewed read-only, so
   * "Back to latest" returns to it (history included) when the library's latest is still the same.
   */
  const latestStash = React.useRef<{ libraryId: string; version: number; stash: DocumentStash } | null>(null)

  const loadLibraryVersion = React.useCallback(
    async (version: SceneVersionInfo | null) => {
      const id = libraryIdRef.current
      if (!id) return
      setBusy(version ? `Opening version ${version.version}…` : "Opening the latest version…")
      try {
        const loaded = await scenes.load(id, version?.version)
        if (!loaded.parsed.ok) {
          toast.error(loaded.parsed.error === "too-new" ? "That version needs a newer Atlas" : "That version could not be opened", {
            description: loaded.parsed.error === "too-new" ? undefined : describeIssues(loaded.parsed.issues),
          })
          return
        }
        const latest = loaded.summary.latestVersion
        const viewingOld = version !== null && loaded.version !== latest
        // Only a stash of this scene's current latest version is worth keeping.
        const prevStash = latestStash.current
        const kept = prevStash && prevStash.libraryId === id && prevStash.version === latest && prevStash.stash.scene.id === loaded.parsed.scene.id ? prevStash : null
        latestStash.current = null
        const st = store.getState()
        if (viewingOld) {
          // Leaving the (saved, editable) latest: keep it and its history for "Back to latest".
          const keep = kept ?? (!st.readOnly && !st.dirty && baseVersionRef.current === latest ? { libraryId: id, version: latest, stash: st.detachDocument() } : null)
          latestStash.current = keep
          st.loadScene(loaded.parsed.scene, { readOnly: true })
        } else if (kept) {
          st.restoreDocument(kept.stash)
        } else {
          st.loadScene(loaded.parsed.scene, { readOnly: false })
        }
        setLibrary(id, latest)
        draftRevision.current = store.getState().revision
        setMeta((m) =>
          m
            ? { ...m, status: "ready", summary: loaded.summary, baseVersion: latest, viewingVersion: version && loaded.version !== latest ? version : null, error: null, tooNewSchema: null }
            : m
        )
      } catch (err) {
        toast.error("Could not open the version", { description: errorText(err) })
      } finally {
        setBusy(null)
      }
    },
    [scenes, store, setLibrary]
  )

  const openVersion = React.useCallback(
    async (v: SceneVersionInfo) => {
      if (!(await confirmDiscard("Opening another version"))) return
      await loadLibraryVersion(v)
    },
    [confirmDiscard, loadLibraryVersion]
  )

  const backToLatest = React.useCallback(() => loadLibraryVersion(null), [loadLibraryVersion])

  const restoreVersion = React.useCallback(
    async (v: SceneVersionInfo) => {
      const id = libraryIdRef.current
      if (!id) return
      if (!(await confirmDiscard("Restoring a version"))) return
      setBusy(`Restoring version ${v.version}…`)
      try {
        const loaded = await scenes.load(id, v.version)
        if (!loaded.parsed.ok) throw new Error(describeIssues(loaded.parsed.issues))
        const version = await scenes.saveVersion(id, loaded.parsed.scene, { baseVersion: baseVersionRef.current ?? undefined })
        store.getState().loadScene(loaded.parsed.scene)
        setLibrary(id, version)
        draftRevision.current = store.getState().revision
        setLastSavedAt(new Date().toISOString())
        setMeta((m) => (m ? { ...m, status: "ready", baseVersion: version, viewingVersion: null, summary: m.summary ? { ...m.summary, latestVersion: version } : m.summary } : m))
        toast.success(`Restored version ${v.version}`, { description: `Saved as version ${version}.` })
      } catch (err) {
        toast.error("Could not restore the version", { description: errorText(err) })
      } finally {
        setBusy(null)
      }
    },
    [confirmDiscard, scenes, store, setLibrary]
  )

  // ---- files ----------------------------------------------------------------------------------
  const exportFile = React.useCallback(async () => {
    const scene = store.getState().scene
    setBusy("Preparing the export…")
    try {
      const file = await exportSceneFileWithAssets(scene, assets)
      downloadText(file.fileName, file.text, file.mimeType)
      if (file.missing.length > 0) {
        const names = file.missing.map((id) => scene.assets?.[id]?.name ?? id)
        toast.warning("Exported without some map images", { description: names.join(", ") })
      } else toast.success(`Exported ${file.fileName}`)
    } catch (err) {
      toast.error("Export failed", { description: errorText(err) })
    } finally {
      setBusy(null)
    }
  }, [assets, store])

  const importFile = React.useCallback(
    async (file: File) => {
      if (!(await confirmDiscard("Importing a scene"))) return
      setBusy(`Importing ${file.name}…`)
      try {
        // Never throws for the image store: a failure comes back as storeError (same scene and id).
        const { parsed, missing, storeError } = await importSceneFileWithAssets(await file.text(), assets)
        if (!parsed.ok) {
          toast.error(parsed.error === "too-new" ? "This file needs a newer version of Atlas" : "This is not a valid Atlas scene", {
            description: parsed.error === "too-new" ? undefined : describeIssues(parsed.issues),
          })
          return
        }
        const scene = parsed.scene
        try {
          // A second library entry with an identical name is ambiguous: suffix it.
          scene.name = importedName(scene.name, (await scenes.list()).map((s) => s.name))
        } catch {
          // Listing failed: keep the file's name.
        }
        let summary: SceneSummary
        try {
          summary = await scenes.create(scene)
        } catch (err) {
          // Nothing references the images just stored for this document: remove them (best-effort).
          for (const id of Object.keys(scene.assets ?? {})) await assets.deleteImage(scene.id, id).catch(() => {})
          throw err
        }
        store.getState().loadScene(scene)
        retainLevelImages(scene.id)
        setLibrary(summary.id, summary.latestVersion)
        draftRevision.current = store.getState().revision
        setRecoverable(null)
        setLastSavedAt(summary.updatedAt)
        setMeta({ routeId: summary.id, status: "ready", error: null, libraryId: summary.id, summary, baseVersion: summary.latestVersion, viewingVersion: null, tooNewSchema: null })
        opts.current.navigate(paths.editor(summary.id))
        if (storeError !== undefined)
          toast.warning(`Imported “${summary.name}” without some map images`, {
            description: `Map images could not be stored: ${errorText(storeError)}`,
          })
        else
          toast.success(`Imported “${summary.name}”`, {
            description: missing.length > 0 ? `${missing.length} map image(s) were not in the file.` : "Added to your library as a new scene.",
          })
      } catch (err) {
        toast.error("Import failed", { description: errorText(err) })
      } finally {
        setBusy(null)
      }
    },
    [assets, confirmDiscard, scenes, store, setLibrary]
  )

  // ---- sharing / session ----------------------------------------------------------------------
  const setSharing = React.useCallback(
    async (visibility: SceneVisibility, o: { rotate?: boolean } = {}) => {
      let id = libraryIdRef.current
      if (!id) id = await save()
      if (!id) return null
      const slug = await scenes.setVisibility(id, visibility, o)
      setMeta((m) => (m && m.summary ? { ...m, summary: { ...m.summary, visibility, shareSlug: slug } } : m))
      return slug
    },
    [save, scenes]
  )

  const startSession = React.useCallback(async (sessionOpts: CreateSessionOptions = {}) => {
    const s = store.getState()
    if (s.readOnly) {
      toast.info("Open the latest version to start a session")
      return
    }
    let id = libraryIdRef.current
    if (!id || s.dirty) id = await save()
    if (!id) return
    setBusy("Starting the session…")
    try {
      const created = await sessions.createSession(id, sessionOpts)
      opts.current.navigate(paths.host(created.sessionId))
    } catch (err) {
      toast.error("Could not start a session", { description: errorText(err) })
    } finally {
      setBusy(null)
    }
  }, [save, sessions, store])

  // ---- draft recovery -------------------------------------------------------------------------
  const restoreDraft = React.useCallback(() => {
    if (!recoverable) return
    const cur = store.getState().scene
    const draft = recoverable.scene
    // An unsaved scene from an earlier visit replaces the blank new document (it is still unsaved); a
    // library draft is applied on top of the saved version as one edit (undo returns to it).
    if (!libraryIdRef.current && draft.id !== cur.id) {
      void openNew(meta?.routeId ?? "new", draft)
    } else if (!replaceDocument(store, { ...draft, id: cur.id }, "Restore draft")) {
      toast.error("The draft could not be restored", { description: describeIssues(store.getState().lastRejected?.issues ?? []) })
      return
    }
    setRecoverable(null)
    toast.success("Draft restored")
  }, [recoverable, store, openNew, meta?.routeId])

  const discardDraft = React.useCallback(async () => {
    const r = recoverable
    setRecoverable(null)
    if (!r) return
    try {
      await deleteDraft(await getLocalStore(), r.key)
    } catch {
      // ignore
    }
  }, [recoverable])

  const status: DocStatus = meta && (meta.routeId === routeId || meta.libraryId === routeId) ? meta.status : "loading"
  return {
    status,
    error: meta?.error ?? null,
    libraryId: meta?.libraryId ?? null,
    summary: meta?.summary ?? null,
    baseVersion: meta?.baseVersion ?? null,
    viewingVersion: meta?.viewingVersion ?? null,
    tooNewSchema: meta?.tooNewSchema ?? null,
    storage: scenes.storage,
    saving,
    lastSavedAt,
    draftSavedAt,
    recoverable,
    busy,
    save,
    newScene,
    listVersions,
    openVersion,
    backToLatest,
    restoreVersion,
    exportFile,
    importFile,
    setSharing,
    startSession,
    restoreDraft,
    discardDraft,
    adoptNewScene,
  }
}
