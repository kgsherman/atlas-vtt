/**
 * A world's scenes (ARCHITECTURE §6.9): the cards (Edit / Play — the same scene screen —, rename,
 * duplicate, move to another world, export, share, delete), new scenes (blank, from map images, a
 * sample, an imported .atlas.json, also dropped on the page).
 */
import * as React from "react"
import { FileUpIcon, ImagePlusIcon, LibraryBigIcon, PlusIcon, SearchIcon, UploadIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { useLocation } from "wouter"

import { downloadText } from "@/app/clipboard"
import { forgetDigest } from "@/app/digestCache"
import { createFromSample, duplicateScene, exportScene, importSceneFile, LibraryError, userMessage } from "@/app/library"
import { paths, preloadRoute } from "@/app/routes"
import { useServices } from "@/app/services"
import type { AsyncState } from "@/app/useAsync"
import { SampleSceneCard } from "@/components/app/SampleSceneCard"
import { SceneCard, SceneCardSkeleton, type SceneAction } from "@/components/app/SceneCard"
import { DeleteSceneDialog, RenameSceneDialog, ShareSceneDialog } from "@/components/app/SceneDialogs"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { SAMPLE_SCENES } from "@/core/scene/samples"
import type { SceneSummary } from "@/net/scenesRepo"
import type { WorldSummary } from "@/net/worldsRepo"

import { MoveSceneDialog } from "./WorldDialogs"

const SHOWN_SAMPLES = SAMPLE_SCENES.filter((s) => s.id === "crooked-lantern" || s.id === "stress-test")

type DialogState = { kind: "rename" | "share" | "delete" | "move"; scene: SceneSummary } | null

function describeLibraryError(err: unknown): string {
  if (err instanceof LibraryError && err.details.length > 0) return `${err.message} ${err.details.slice(0, 3).join(" · ")}`
  return userMessage(err)
}

export function WorldScenes({
  world,
  worlds,
  scenesQ,
  onTablesChanged,
}: {
  world: WorldSummary
  worlds: WorldSummary[]
  scenesQ: AsyncState<SceneSummary[]>
  /** A scene (and its table) was deleted or moved: the page's table status is stale. */
  onTablesChanged?(): void
}) {
  const services = useServices()
  const [, navigate] = useLocation()
  const [busy, setBusy] = React.useState<{ id: string; action: SceneAction } | null>(null)
  const [sampleBusy, setSampleBusy] = React.useState<string | null>(null)
  const [dialog, setDialog] = React.useState<DialogState>(null)
  const [query, setQuery] = React.useState("")
  const [dragging, setDragging] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const reloadScenes = scenesQ.reload

  const scenes = React.useMemo(() => scenesQ.data ?? [], [scenesQ.data])
  const needle = query.trim().toLowerCase()
  const filtered = needle ? scenes.filter((s) => s.name.toLowerCase().includes(needle)) : scenes
  const replaceScene = (next: SceneSummary) => scenesQ.mutate((list) => list?.map((s) => (s.id === next.id ? next : s)))
  const openEditor = React.useCallback((id: string) => navigate(paths.scene(id)), [navigate])
  const warmEditor = () => preloadRoute("host")
  const libraryBusy = busy !== null || sampleBusy !== null

  const onAction = async (action: SceneAction, scene: SceneSummary) => {
    switch (action) {
      case "open":
        navigate(paths.scene(scene.id, { mode: "edit" }))
        return
      case "play":
        navigate(paths.scene(scene.id, { mode: "play" }))
        return
      case "rename":
      case "share":
      case "delete":
      case "move":
        setDialog({ kind: action, scene })
        return
      default:
        break
    }
    setBusy({ id: scene.id, action })
    try {
      if (action === "duplicate") {
        const { summary, warnings } = await duplicateScene(
          services,
          scene,
          scenes.map((s) => s.name)
        )
        toast.success(`Created “${summary.name}”`, { action: { label: "Open", onClick: () => openEditor(summary.id) } })
        for (const w of warnings) toast.warning(w)
        scenesQ.reload()
      } else if (action === "export") {
        const file = await exportScene(services, scene)
        downloadText(file.fileName, file.mimeType, file.text)
        toast.success(`Exported ${file.fileName}`)
        for (const w of file.warnings) toast.warning(w)
      }
    } catch (err) {
      const verb = action === "duplicate" ? "duplicate the scene" : "export the scene"
      toast.error(`Couldn't ${verb}`, { description: describeLibraryError(err) })
    } finally {
      setBusy(null)
    }
  }

  const openSampleCopy = async (sampleId: string) => {
    setSampleBusy(sampleId)
    try {
      const { summary } = await createFromSample(services, sampleId, world.id)
      toast.success(`Added “${summary.name}” to ${world.name}`)
      openEditor(summary.id)
    } catch (err) {
      toast.error("Couldn't copy the sample", { description: describeLibraryError(err) })
      setSampleBusy(null)
    }
  }

  const importFiles = React.useCallback(
    async (files: Iterable<File>) => {
      let imported = 0
      for (const file of files) {
        if (file.type.startsWith("image/")) {
          toast.info("Map images are imported into a new scene", {
            description: file.name,
            action: { label: "New from map images", onClick: () => navigate(paths.newFromImages(world.id)) },
          })
          continue
        }
        const id = toast.loading(`Importing ${file.name}…`)
        try {
          const { summary, warnings } = await importSceneFile(services, file, world.id)
          imported++
          toast.success(`Imported “${summary.name}”`, { id, action: { label: "Open", onClick: () => navigate(paths.scene(summary.id)) } })
          for (const w of warnings) toast.warning(w)
        } catch (err) {
          toast.error(`Couldn't import ${file.name}`, { id, description: describeLibraryError(err) })
        }
      }
      if (imported > 0) reloadScenes()
    },
    [navigate, reloadScenes, services, world.id]
  )
  const pickFile = () => fileRef.current?.click()

  // ---- drag-and-drop -------------------------------------------------------------------------
  React.useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files")
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      if (e.dataTransfer?.files.length) void importFiles(e.dataTransfer.files)
    }
    window.addEventListener("dragenter", enter)
    window.addEventListener("dragleave", leave)
    window.addEventListener("dragover", over)
    window.addEventListener("drop", drop)
    return () => {
      window.removeEventListener("dragenter", enter)
      window.removeEventListener("dragleave", leave)
      window.removeEventListener("dragover", over)
      window.removeEventListener("drop", drop)
    }
  }, [importFiles])

  return (
    <div className="flex flex-col gap-10">
      <section aria-label="Scenes" className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {scenes.length > 3 && (
            <InputGroup className="h-7 sm:mr-auto sm:w-56">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search scenes"
                aria-label="Search scenes"
                onKeyDown={(e) => e.key === "Escape" && (setQuery(""), e.currentTarget.blur())}
              />
              {query && (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                    <XIcon />
                  </InputGroupButton>
                </InputGroupAddon>
              )}
            </InputGroup>
          )}
          {scenes.length > 0 && (
            <>
              <Button variant="outline" onClick={pickFile} className="max-sm:flex-1">
                <FileUpIcon data-icon="inline-start" />
                Import
              </Button>
              <Button variant="outline" onClick={() => navigate(paths.newFromImages(world.id))} onPointerEnter={warmEditor} className="max-sm:flex-1">
                <ImagePlusIcon data-icon="inline-start" />
                From map images
              </Button>
              <Button onClick={() => navigate(paths.newScene(world.id))} onPointerEnter={warmEditor} className="max-sm:flex-1">
                <PlusIcon data-icon="inline-start" />
                New scene
              </Button>
            </>
          )}
        </div>

        {scenesQ.error !== undefined && !scenesQ.data ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn't load the scenes</AlertTitle>
            <AlertDescription>{userMessage(scenesQ.error)}</AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" onClick={scenesQ.reload}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : scenesQ.loading && !scenesQ.data ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <SceneCardSkeleton key={i} />
            ))}
          </div>
        ) : scenes.length === 0 ? (
          <Empty className="border bg-card/30 py-12">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <LibraryBigIcon />
              </EmptyMedia>
              <EmptyTitle>No scenes in {world.name} yet</EmptyTitle>
              <EmptyDescription>
                Create a scene from scratch, start from your battlemap images, import a scene file, or add a copy of a sample below.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="flex-row flex-wrap justify-center">
              <Button onClick={() => navigate(paths.newScene(world.id))} onPointerEnter={warmEditor}>
                <PlusIcon data-icon="inline-start" />
                New scene
              </Button>
              <Button variant="outline" onClick={() => navigate(paths.newFromImages(world.id))} onPointerEnter={warmEditor}>
                <ImagePlusIcon data-icon="inline-start" />
                From map images
              </Button>
              <Button variant="outline" onClick={pickFile}>
                <FileUpIcon data-icon="inline-start" />
                Import file
              </Button>
            </EmptyContent>
          </Empty>
        ) : filtered.length === 0 ? (
          <Empty className="border py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SearchIcon />
              </EmptyMedia>
              <EmptyTitle>No scenes match “{query.trim()}”</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" onClick={() => setQuery("")}>
                Clear search
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((scene) => (
              <SceneCard
                key={scene.id}
                scene={scene}
                busy={busy?.id === scene.id ? busy.action : null}
                disabled={libraryBusy}
                canMove={worlds.length > 1}
                onAction={(a, s) => void onAction(a, s)}
                onIntent={warmEditor}
              />
            ))}
          </div>
        )}
      </section>

      <section aria-labelledby="samples" className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-0.5">
          <h2 id="samples" className="font-heading text-lg font-semibold tracking-tight">
            Sample scenes
          </h2>
          <p className="text-xs text-muted-foreground">
            Ready-made scenes to explore the lighting, levels and vision. Opening one adds a copy to {world.name}.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {SHOWN_SAMPLES.map((sample) => (
            <SampleSceneCard
              key={sample.id}
              sample={sample}
              busy={sampleBusy === sample.id}
              disabled={libraryBusy}
              onOpenCopy={() => void openSampleCopy(sample.id)}
              onIntent={warmEditor}
            />
          ))}
        </div>
      </section>

      <input
        ref={fileRef}
        type="file"
        accept=".json,.atlas.json,application/json"
        multiple
        hidden
        onChange={(e) => {
          const files = e.currentTarget.files ? [...e.currentTarget.files] : []
          e.currentTarget.value = ""
          if (files.length) void importFiles(files)
        }}
      />

      <RenameSceneDialog scene={dialog?.kind === "rename" ? dialog.scene : null} onClose={() => setDialog(null)} onRenamed={replaceScene} />
      <ShareSceneDialog scene={dialog?.kind === "share" ? dialog.scene : null} onClose={() => setDialog(null)} onChanged={replaceScene} />
      <MoveSceneDialog
        scene={dialog?.kind === "move" ? dialog.scene : null}
        worlds={worlds}
        onClose={() => setDialog(null)}
        onMoved={(scene, to) => {
          scenesQ.mutate((list) => list?.filter((s) => s.id !== scene.id))
          onTablesChanged?.()
          toast.success(`Moved “${scene.name}” to ${to.name}`, { action: { label: "Open world", onClick: () => navigate(paths.world(to.id)) } })
        }}
      />
      <DeleteSceneDialog
        scene={dialog?.kind === "delete" ? dialog.scene : null}
        onClose={() => setDialog(null)}
        onDeleted={(scene) => {
          forgetDigest(scene)
          scenesQ.mutate((list) => list?.filter((s) => s.id !== scene.id))
          onTablesChanged?.()
          toast.success(`Deleted “${scene.name}”`)
        }}
      />

      {dragging && <DropOverlay />}
    </div>
  )
}

function DropOverlay() {
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex animate-in items-center justify-center bg-background/80 p-6 backdrop-blur-sm duration-150 fade-in-0">
      <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary/60 bg-card/80 px-8 py-12 text-center">
        <div className="flex size-12 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <UploadIcon className="size-6" />
        </div>
        <div className="font-heading text-base font-semibold">Drop to import</div>
        <p className="text-xs text-muted-foreground">.atlas.json scene files are added to this world.</p>
      </div>
    </div>
  )
}
