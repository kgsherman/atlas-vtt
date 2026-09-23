/**
 * Editor layout and page-level behaviour: top bar, tool rail, contextual options, viewport, sidebar,
 * status bar, dialogs; editor actions shared by menus/panels; keyboard routing; refused-edit toasts.
 */
import * as React from "react"
import { ImagePlus } from "lucide-react"
import { toast } from "sonner"

import { selectionBounds } from "@/core/scene/integrity"
import { groundHeightAt } from "@/core/scene/queries"
import type { Id } from "@/core/scene/types"
import type { EditorController } from "@/editor/controller"
import type { EditorStore } from "@/editor/store"
import type { Engine, Quality } from "@/render/contracts"

import {
  EditorActionsContext,
  EditorEngineContext,
  useConfirm,
  useEditorContext,
  useEditorState,
  type EditorActions,
} from "./context"
import { EditorViewport, type PreviewState } from "./EditorViewport"
import { MapImportDialog, type MapImportRequest } from "./dialogs/MapImportDialog"
import { ShareDialog } from "./dialogs/ShareDialog"
import { ShortcutsDialog } from "./dialogs/ShortcutsDialog"
import { VersionHistorySheet } from "./dialogs/VersionHistorySheet"
import { describeIssues } from "./lib/format"
import { duplicateLevel } from "./lib/levelOps"
import { editorMayHandleKey, isTextEntryTarget } from "./lib/pointer"
import { defaultPreviewToken, type PreviewResult } from "./lib/preview"
import { createViewportInfoStore } from "./lib/viewportInfo"
import { Sidebar } from "./Sidebar"
import { StatusBar, type QualityChoice } from "./StatusBar"
import { ToolOptionsBar } from "./ToolOptionsBar"
import { ToolRail } from "./ToolRail"
import { TopBar } from "./TopBar"
import type { SceneDocument } from "./useSceneDocument"
import { CameraControls, DocumentBanners, GettingStarted, LevelSwitcher, PreviewBar } from "./ViewportOverlays"

declare global {
  interface Window {
    /** Dev-only automation handle (see EditorShell). */
    __atlasEditor?: { store: EditorStore; controller: EditorController; engine: Engine | null }
  }
}

const QUALITY_KEY = "atlas-editor:quality"

function readQuality(): QualityChoice {
  try {
    const v = localStorage.getItem(QUALITY_KEY)
    if (v === "low" || v === "medium" || v === "high" || v === "ultra" || v === "auto") return v
  } catch {
    // Storage unavailable: default.
  }
  return "auto"
}

/** A modal dialog, sheet or menu is open: canvas shortcuts must not fire underneath it. */
function overlayOpen(): boolean {
  return document.querySelector('[data-slot="dialog-content"], [data-slot="alert-dialog-content"], [data-slot="sheet-content"], [role="menu"], [role="listbox"]') !== null
}

export interface EditorShellProps {
  doc: SceneDocument
  goHome(): void
  importRequest: MapImportRequest | null
  setImportRequest(r: MapImportRequest | null): void
}

export function EditorShell({ doc, goHome, importRequest, setImportRequest }: EditorShellProps) {
  const { store, controller } = useEditorContext()
  const confirm = useConfirm()
  const [engine, setEngine] = React.useState<Engine | null>(null)
  const [info] = React.useState(createViewportInfoStore)
  const [quality, setQualityChoice] = React.useState<QualityChoice>(readQuality)
  const [engineKey, setEngineKey] = React.useState(0)
  const [preview, setPreview] = React.useState<PreviewState | null>(null)
  const [previewResult, setPreviewResult] = React.useState<PreviewResult | null>(null)
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false)
  const [versionsOpen, setVersionsOpen] = React.useState(false)
  const [shareOpen, setShareOpen] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement | null>(null)
  const [dropHint, setDropHint] = React.useState(false)
  const activeLevelName = useEditorState((s) => s.scene.levels[s.activeLevelId]?.name ?? "the active level")

  // Preview of a token that was deleted (undo, …) ends.
  const previewTokenExists = useEditorState((s) => (preview ? Object.hasOwn(s.scene.tokens, preview.tokenId) : true))
  const activePreview = preview && previewTokenExists ? preview : null

  const changeQuality = (q: QualityChoice) => {
    try {
      localStorage.setItem(QUALITY_KEY, q)
    } catch {
      // ignore
    }
    // "Auto" hands control back to the engine's own benchmark + adaptation: recreate it.
    if (q === "auto" && quality !== "auto") setEngineKey((k) => k + 1)
    setQualityChoice(q)
  }

  // ---- actions ----------------------------------------------------------------------------------
  const actions = React.useMemo<EditorActions>(() => {
    const focusSelection = () => {
      const s = store.getState()
      const b = selectionBounds(s.scene, s.selection)
      if (!engine || !b) return
      const c = { x: b.x + b.w / 2, z: b.z + b.d / 2 }
      engine.focus({ x: c.x, y: groundHeightAt(s.scene, s.activeLevelId, c), z: c.z }, { distance: Math.max(30, Math.hypot(b.w, b.d) * 1.6) })
    }
    return {
      save: () => void doc.save(),
      newScene: () => void doc.newScene(),
      newFromImages: () => void doc.newScene({ importImages: true }),
      openMapImport: (levelId?: Id) => setImportRequest({ mode: "existing", levelId: levelId ?? null }),
      openVersions: () => setVersionsOpen(true),
      exportFile: () => void doc.exportFile(),
      importFile: () => fileRef.current?.click(),
      openShare: () => setShareOpen(true),
      startSession: () => void doc.startSession(),
      goHome,
      openShortcuts: () => setShortcutsOpen(true),
      enterPreview: (tokenId?: Id) => {
        const s = store.getState()
        const id = tokenId ?? defaultPreviewToken(s.scene, s.selection)
        if (!id) {
          toast.info("Place a token first", { description: "The preview shows what a token can see." })
          return
        }
        controller.cancelGesture()
        setPreviewResult(null)
        setPreview({ tokenId: id })
      },
      exitPreview: () => setPreview(null),
      frameScene: () => engine?.frameScene(),
      focusSelection,
      addLevel: () => {
        if (!store.getState().addLevel()) toast.error("Could not add a level", { description: "A scene can have at most 32 levels." })
      },
      duplicateLevel: (levelId?: Id) => {
        const id = levelId ?? store.getState().activeLevelId
        if (!duplicateLevel(store, id)) toast.error("Could not duplicate the level")
      },
      deleteLevel: async (levelId: Id) => {
        const s = store.getState()
        const level = s.scene.levels[levelId]
        if (!level) return
        const count = Object.values(s.scene.objects).filter((o) => o.levelId === levelId).length + Object.values(s.scene.tokens).filter((t) => t.levelId === levelId).length
        const ok = await confirm({
          title: `Delete “${level.name}”?`,
          description: count > 0 ? `The level and everything on it (${count} item${count === 1 ? "" : "s"}) will be deleted. Stairs leading to it are removed. You can undo this.` : "The level will be deleted. You can undo this.",
          confirmLabel: "Delete level",
          destructive: true,
        })
        if (ok && !store.getState().removeLevel(levelId)) toast.error("A scene needs at least one level")
      },
      deleteSelection: () => {
        controller.cancelGesture()
        store.getState().deleteSelection()
      },
    }
  }, [store, controller, doc, engine, goHome, confirm, setImportRequest])

  // ---- refused edits → toasts ----------------------------------------------------------------------
  React.useEffect(
    () =>
      store.subscribe((s, prev) => {
        const r = s.lastRejected
        if (!r || r === prev.lastRejected) return
        toast.error(`Can't ${r.label.charAt(0).toLowerCase()}${r.label.slice(1)}`, { id: "edit-rejected", description: describeIssues(r.issues) })
      }),
    [store]
  )

  // ---- keyboard --------------------------------------------------------------------------------
  const keyState = React.useRef({ previewing: false, actions })
  React.useEffect(() => {
    keyState.current = { previewing: activePreview !== null, actions }
  })
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (ctrl && !e.altKey && key === "s") {
        e.preventDefault()
        keyState.current.actions.save()
        return
      }
      if (!editorMayHandleKey(e.key, e.target) || overlayOpen()) return
      if (keyState.current.previewing) {
        if (e.key === "Escape") {
          e.preventDefault()
          keyState.current.actions.exitPreview()
        }
        if (key === "d" && !ctrl && !e.altKey) e.stopPropagation()
        return
      }
      if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
        e.preventDefault()
        keyState.current.actions.openShortcuts()
        return
      }
      if (e.key === "Alt") e.preventDefault()
      const consumed = controller.keyDown({ key: e.key, shift: e.shiftKey, alt: e.altKey, ctrl })
      if (consumed) e.preventDefault()
      // Editor letter shortcuts own the key: stop app-wide single-key handlers (e.g. the theme
      // provider's "d" toggle, which would fire on every Door tool shortcut).
      if (!ctrl && !e.altKey && e.key.length === 1 && (consumed || key === "d")) e.stopPropagation()
    }
    const onKeyUp = (e: KeyboardEvent) => {
      controller.keyUp({ key: e.key, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey })
    }
    const onBlur = () => store.getState().setAltHeld(false)
    const onPaste = (e: ClipboardEvent) => {
      if (isTextEntryTarget(e.target) || overlayOpen() || keyState.current.previewing) return
      const text = e.clipboardData?.getData("text/plain")
      if (!text || !text.includes("atlas-clipboard")) return
      e.preventDefault()
      const at = controller.cursor()?.ground ?? undefined
      const r = store.getState().pasteText(text, at ? { at } : {})
      if (!r.ok) toast.error("Could not paste", { description: describeIssues(r.issues) })
    }
    // Capture phase: the editor sees keys before app-wide window listeners.
    window.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", onBlur)
    window.addEventListener("paste", onPaste)
    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", onBlur)
      window.removeEventListener("paste", onPaste)
    }
  }, [store, controller])

  // Dev builds: expose the editor to browser automation (window.__atlasEditor).
  React.useEffect(() => {
    if (!import.meta.env.DEV) return
    window.__atlasEditor = { store, controller, engine }
    return () => {
      if (window.__atlasEditor?.store === store) delete window.__atlasEditor
    }
  }, [store, controller, engine])

  const engineHandle = React.useMemo(() => ({ engine }), [engine])
  const previewing = activePreview !== null

  return (
    <EditorActionsContext.Provider value={actions}>
      <EditorEngineContext.Provider value={engineHandle}>
        <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
          <TopBar doc={doc} previewing={previewing} onModeChange={(m) => (m === "preview" ? actions.enterPreview() : actions.exitPreview())} />
          <div className="flex min-h-0 flex-1">
            <ToolRail disabled={previewing} />
            <main className="flex min-w-0 flex-1 flex-col">
              {activePreview ? (
                <PreviewBar tokenId={activePreview.tokenId} result={previewResult} onTokenChange={(id) => actions.enterPreview(id)} />
              ) : (
                <ToolOptionsBar />
              )}
              <div
                className="relative min-h-0 flex-1"
                onDragOver={(e) => {
                  if (!e.dataTransfer.types.includes("Files")) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = "copy"
                  if (!dropHint) setDropHint(true)
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropHint(false)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  setDropHint(false)
                  const files = [...e.dataTransfer.files]
                  const scene = files.find((f) => /\.json$/i.test(f.name))
                  if (scene) return void doc.importFile(scene)
                  const images = files.filter((f) => /^image\//.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name))
                  if (images.length === 0) return void toast.error("Drop battlemap images (PNG, JPEG, WebP) or an .atlas.json file")
                  if (store.getState().readOnly) return void toast.info("This document is read-only")
                  setImportRequest({ mode: "existing", levelId: store.getState().activeLevelId, files: images })
                }}
              >
                {dropHint ? (
                  <div className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-xl border-2 border-dashed border-primary/60 bg-background/60 backdrop-blur-sm">
                    <div className="flex flex-col items-center gap-2 text-sm text-foreground">
                      <ImagePlus className="size-6 text-primary" />
                      Drop battlemaps to import them onto “{activeLevelName}”
                      <span className="text-xs text-muted-foreground">…or an .atlas.json scene file to open it</span>
                    </div>
                  </div>
                ) : null}
                <EditorViewport
                  key={engineKey}
                  quality={quality === "auto" ? undefined : (quality as Quality)}
                  preview={activePreview}
                  onPreviewToken={(id) => actions.enterPreview(id)}
                  onPreviewResult={setPreviewResult}
                  onEngine={setEngine}
                  info={info}
                >
                  <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start justify-between gap-3">
                    {previewing ? <span /> : <LevelSwitcher />}
                    <DocumentBanners doc={doc} />
                    {previewing ? <span /> : <CameraControls />}
                  </div>
                  {!previewing ? (
                    <div className="pointer-events-none absolute bottom-3 left-3">
                      <GettingStarted />
                    </div>
                  ) : null}
                </EditorViewport>
              </div>
            </main>
            <Sidebar />
          </div>
          <StatusBar info={info} quality={quality} onQualityChange={changeQuality} />
        </div>

        <input
          ref={fileRef}
          type="file"
          accept=".json,.atlas.json,application/json"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ""
            if (file) void doc.importFile(file)
          }}
        />
        <MapImportDialog request={importRequest} onClose={() => setImportRequest(null)} doc={doc} />
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        <VersionHistorySheet open={versionsOpen} onOpenChange={setVersionsOpen} doc={doc} />
        <ShareDialog open={shareOpen} onOpenChange={setShareOpen} doc={doc} />
      </EditorEngineContext.Provider>
    </EditorActionsContext.Provider>
  )
}
