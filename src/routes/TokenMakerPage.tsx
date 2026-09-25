/**
 * Token Maker (ARCHITECTURE §11): layer a background, character art and a frame, mask them into a round
 * token (with parts breaking out of the frame), remove a background with an image model, download a
 * PNG, or put the token on a character of a game open in another tab.
 *
 * `?session=<id>&token=<id>`: the game (and token) the page was opened for; the game itself is found
 * through its open tab (net/tokenMakerLink), so the page never joins a session itself.
 */
import * as React from "react"
import { CircleUserRound, FilePlus2, Redo2, Undo2 } from "lucide-react"
import { toast } from "sonner"
import { useSearch } from "wouter"

import { useServices } from "@/app/services"
import { AppHeader } from "@/components/app/AppHeader"
import { useCommandKeys } from "@/components/keybindings/keymapStore"
import { useSessionResource } from "@/components/play/useSessionResource"
import { TokenMakerContext, useMaker, useTokenMaker, type TokenMakerContextValue } from "@/components/tokenMaker/context"
import { DownloadSection, GameSection } from "@/components/tokenMaker/ExportPanel"
import { DiscSection, LayerInspector } from "@/components/tokenMaker/Inspector"
import { LayersPanel } from "@/components/tokenMaker/LayersPanel"
import { Stage } from "@/components/tokenMaker/Stage"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { findLayer, removeLayer, setTransform, translateLayer } from "@/core/tokenMaker/design"
import type { LayerRole } from "@/core/tokenMaker/types"
import { BRUSH_STEP } from "@/editor/shortcuts"
import { useAppHotkeys } from "@/lib/hotkeys"
import { MakerLink } from "@/net/tokenMakerLink"
import { addImageFile, nameFromFile, startTemplate } from "@/tokenMaker/actions"
import { loadTokenDraft, saveTokenDraft } from "@/tokenMaker/draft"
import { createTokenMaker } from "@/tokenMaker/store"

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      !!target.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='alertdialog'], [role='menu'], [role='slider']"))
  )
}

const imageFiles = (list: FileList | null | undefined): File[] => [...(list ?? [])].filter((f) => f.type.startsWith("image/"))

export default function TokenMakerPage() {
  const services = useServices()
  const search = useSearch()
  const params = React.useMemo(() => new URLSearchParams(search), [search])
  // One pair: StrictMode may run this initialiser twice, and the cache must report to the kept store.
  const [{ store, cache }] = React.useState(createTokenMaker)
  const link = useSessionResource(
    "token-maker",
    () => new MakerLink(),
    (l) => l.dispose()
  )
  const [ready, setReady] = React.useState(false)
  const [fileInput, setFileInput] = React.useState<HTMLInputElement | null>(null)
  const [pickRole, setPickRole] = React.useState<LayerRole>("subject")
  const started = React.useRef(false)

  // The saved draft, else a fresh token from the free parts.
  React.useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      const draft = await loadTokenDraft().catch(() => null)
      if (draft && draft.design.layers.length > 0) store.getState().load(draft.design, draft.images)
      else
        await startTemplate(store, cache, services.freeAssets.tokenParts()).catch((err: unknown) =>
          toast.error("Couldn't load the free token parts", { description: err instanceof Error ? err.message : String(err) })
        )
      setReady(true)
    })()
  }, [store, cache, services.freeAssets])

  // Autosave (the design and the images it uses) shortly after every change.
  React.useEffect(() => {
    if (!ready) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsub = store.subscribe((s, prev) => {
      if (s.design === prev.design) return
      clearTimeout(timer)
      timer = setTimeout(() => void saveTokenDraft(s.design, s.images).catch((err: unknown) => console.warn("[atlas] token draft not saved", err)), 600)
    })
    return () => {
      unsub()
      clearTimeout(timer)
    }
  }, [store, ready])

  const addFiles = React.useCallback(
    async (files: File[], role: LayerRole) => {
      for (const f of files) {
        try {
          await addImageFile(store, cache, f, nameFromFile(f.name), role)
        } catch (err) {
          toast.error(`Couldn't add ${f.name || "that image"}`, { description: err instanceof Error ? err.message : String(err) })
        }
      }
    },
    [store, cache]
  )

  const pickFile = React.useCallback(
    (role: LayerRole) => {
      setPickRole(role)
      fileInput?.click()
    },
    [fileInput]
  )

  // Paste an image: character art.
  React.useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isEditable(e.target)) return
      const files = imageFiles(e.clipboardData?.files)
      if (files.length === 0) return
      e.preventDefault()
      void addFiles(files, "subject")
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [addFiles])

  // Brush size: the terrain brush's keys (the editor keymap's brush.smaller / brush.larger, [ and ] by
  // default, remaps included).
  const smallerKeys = useCommandKeys("editor", "brush.smaller")
  const largerKeys = useCommandKeys("editor", "brush.larger")
  useAppHotkeys(
    React.useMemo(
      () => [
        ...smallerKeys.map((hotkey) => ({ hotkey, run: () => store.getState().setBrush(store.getState().brush / BRUSH_STEP) })),
        ...largerKeys.map((hotkey) => ({ hotkey, run: () => store.getState().setBrush(store.getState().brush * BRUSH_STEP) })),
      ],
      [smallerKeys, largerKeys, store]
    )
  )

  // Keyboard: undo/redo, tools, nudging and deleting the selected layer.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditable(e.target) || e.altKey) return
      const s = store.getState()
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (mod && key === "z") {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
        return
      }
      if (mod && key === "y") {
        e.preventDefault()
        s.redo()
        return
      }
      if (mod) return
      const layer = findLayer(s.design, s.selectedId)
      if (key === "v") s.setTool("move")
      else if (key === "b") s.setTool("reveal")
      else if (key === "e") s.setTool("hide")
      else if (key === "escape") {
        if (s.tool !== "move") s.setTool("move")
        else s.select(null)
      } else if ((key === "delete" || key === "backspace") && layer) {
        e.preventDefault()
        s.commit(removeLayer(s.design, layer.id))
      } else if (key.startsWith("arrow") && layer && layer.source.type === "image") {
        e.preventDefault()
        const step = e.shiftKey ? 0.02 : 0.002
        const dx = key === "arrowleft" ? -step : key === "arrowright" ? step : 0
        const dy = key === "arrowup" ? -step : key === "arrowdown" ? step : 0
        s.commit(setTransform(s.design, layer.id, translateLayer(layer.transform, dx, dy)), `nudge:${layer.id}`)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [store])

  const ctx = React.useMemo<TokenMakerContextValue | null>(() => (link ? { store, cache, link, pickFile } : null), [store, cache, link, pickFile])
  const [dragging, setDragging] = React.useState(false)

  if (!ctx) return null
  return (
    <TokenMakerContext.Provider value={ctx}>
      <div className="flex min-h-svh flex-col">
        <AppHeader />
        <main
          className="relative mx-auto grid w-full max-w-7xl flex-1 grid-cols-[minmax(0,1fr)] gap-4 px-4 py-4 sm:px-6 lg:h-[calc(100svh-3.5rem)] lg:grid-cols-[17rem_minmax(0,1fr)_19rem] lg:gap-5"
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes("Files")) return
            e.preventDefault()
            setDragging(true)
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDragging(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            const files = imageFiles(e.dataTransfer.files)
            if (files.length) void addFiles(files, "subject")
          }}
        >
          <aside className="atlas-gilt-frame atlas-filigree atlas-sheen relative order-2 min-h-0 overflow-y-auto rounded-lg bg-card lg:order-1">
            <LayersPanel />
          </aside>

          <section className="order-1 flex min-h-0 flex-col gap-3 lg:order-2">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="mr-auto flex items-center gap-2 font-heading text-lg font-semibold tracking-tight">
                <CircleUserRound className="size-5 text-primary" /> Token maker
              </h1>
              <UndoRedo />
              <NewTokenButton />
            </div>
            {ready ? (
              <Stage className="aspect-square w-full lg:aspect-auto lg:min-h-0 lg:flex-1" />
            ) : (
              <div className="grid aspect-square w-full place-items-center lg:aspect-auto lg:flex-1">
                <Spinner />
              </div>
            )}
            <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[0.6875rem] text-muted-foreground">
              <span>Drag to move · scroll to resize</span>
              <span>
                <Kbd>Shift</Kbd> + scroll to rotate
              </span>
              <span>
                <Kbd>Ctrl</Kbd> + scroll to zoom · <Kbd>Space</Kbd> + drag to pan
              </span>
            </p>
          </section>

          <aside className="atlas-gilt-frame atlas-filigree atlas-sheen relative order-3 min-h-0 overflow-y-auto rounded-lg bg-card">
            <LayerInspector />
            <DiscSection />
            <DownloadSection />
            <GameSection preferredSession={params.get("session")} preferredToken={params.get("token")} />
          </aside>

          {dragging ? (
            <div className="pointer-events-none absolute inset-2 grid place-items-center rounded-2xl border-2 border-dashed border-primary bg-background/70 text-sm font-medium backdrop-blur-sm">
              Drop to add character art
            </div>
          ) : null}
        </main>
        <input
          ref={setFileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = imageFiles(e.currentTarget.files)
            e.currentTarget.value = ""
            if (files.length) void addFiles(files, pickRole)
          }}
        />
      </div>
    </TokenMakerContext.Provider>
  )
}

function UndoRedo() {
  const { store } = useTokenMaker()
  const canUndo = useMaker((s) => s.past.length > 0)
  const canRedo = useMaker((s) => s.future.length > 0)
  return (
    <div className="flex items-center">
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label="Undo" disabled={!canUndo} onClick={() => store.getState().undo()} />}>
          <Undo2 />
        </TooltipTrigger>
        <TooltipContent>
          Undo <Kbd>Ctrl</Kbd>+<Kbd>Z</Kbd>
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon" aria-label="Redo" disabled={!canRedo} onClick={() => store.getState().redo()} />}>
          <Redo2 />
        </TooltipTrigger>
        <TooltipContent>
          Redo <Kbd>Ctrl</Kbd>+<Kbd>Shift</Kbd>+<Kbd>Z</Kbd>
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/** Start over from the free parts; the old token comes back with the toast's Undo. */
function NewTokenButton() {
  const { store, cache } = useTokenMaker()
  const services = useServices()
  const [busy, setBusy] = React.useState(false)
  const start = async () => {
    const { design, images } = store.getState()
    setBusy(true)
    try {
      await startTemplate(store, cache, services.freeAssets.tokenParts())
      toast.success("Started a new token", { action: { label: "Undo", onClick: () => store.getState().load(design, images) } })
    } catch (err) {
      toast.error("Couldn't start a new token", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void start()}>
      {busy ? <Spinner data-icon="inline-start" /> : <FilePlus2 data-icon="inline-start" />} New token
    </Button>
  )
}
