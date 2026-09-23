/**
 * Home / library: brand hero with the primary actions, "My scenes" (open, start a session, rename,
 * duplicate, export, share, delete), sample scenes, and "My sessions" (resume hosting, rejoin).
 */
import * as React from "react"
import { FileUpIcon, HardDriveIcon, LibraryBigIcon, PlusIcon, SearchIcon, UploadIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { useLocation } from "wouter"

import { downloadText } from "@/app/clipboard"
import { forgetDigest } from "@/app/digestCache"
import { describeJoinError } from "@/app/joinErrors"
import { createFromSample, duplicateScene, exportScene, importSceneFile, LibraryError, sweepUnusedImages, userMessage } from "@/app/library"
import { currentMode, modeSwitchUrl } from "@/app/mode"
import { paths, preloadRoute } from "@/app/routes"
import { useServices } from "@/app/services"
import { useAsync, useOnFocus } from "@/app/useAsync"
import { AppHeader } from "@/components/app/AppHeader"
import { HomeHero } from "@/components/app/HomeHero"
import { SampleSceneCard } from "@/components/app/SampleSceneCard"
import { SceneCard, SceneCardSkeleton, type SceneAction } from "@/components/app/SceneCard"
import { DeleteSceneDialog, RenameSceneDialog, ShareSceneDialog } from "@/components/app/SceneDialogs"
import { SessionsPanel } from "@/components/app/SessionsPanel"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { SAMPLE_SCENES } from "@/core/scene/samples"
import type { SceneSummary } from "@/net/scenesRepo"
import { formatRoomCode } from "@/net/sessionsRepo"

const SHOWN_SAMPLES = SAMPLE_SCENES.filter((s) => s.id === "crooked-lantern" || s.id === "stress-test")

type DialogState = { kind: "rename" | "share" | "delete"; scene: SceneSummary } | null

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || !!target.closest("input, textarea, select, [contenteditable='true'], [role='dialog'], [role='alertdialog'], [role='menu']"))
  )
}

export default function HomePage() {
  const services = useServices()
  const [, navigate] = useLocation()
  const scenesQ = useAsync(`scenes:${services.mode}:${services.identity.userId}`, () => services.scenes.list())
  const reloadScenes = scenesQ.reload
  useOnFocus(reloadScenes)

  // Map images no scene uses any more (at most daily, in the background; Supabase only).
  React.useEffect(() => {
    void sweepUnusedImages(services)
  }, [services])

  const [busy, setBusy] = React.useState<{ id: string; action: SceneAction } | null>(null)
  const [sampleBusy, setSampleBusy] = React.useState<string | null>(null)
  const [dialog, setDialog] = React.useState<DialogState>(null)
  const [query, setQuery] = React.useState("")
  const [joinCode, setJoinCode] = React.useState("")
  const [joinHint, setJoinHint] = React.useState<string | null>(null)
  const [joining, setJoining] = React.useState(false)
  const [dragging, setDragging] = React.useState(false)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const joinRef = React.useRef<HTMLInputElement>(null)

  const scenes = React.useMemo(() => scenesQ.data ?? [], [scenesQ.data])
  const sceneNames = React.useMemo(() => new Map(scenes.map((s) => [s.id, s.name])), [scenes])
  const needle = query.trim().toLowerCase()
  const filtered = needle ? scenes.filter((s) => s.name.toLowerCase().includes(needle)) : scenes

  const replaceScene = (next: SceneSummary) => scenesQ.mutate((list) => list?.map((s) => (s.id === next.id ? next : s)))

  // ---- scene actions ---------------------------------------------------------------------------

  const openEditor = React.useCallback((id: string) => navigate(paths.editor(id)), [navigate])

  const onAction = async (action: SceneAction, scene: SceneSummary) => {
    switch (action) {
      case "open":
        openEditor(scene.id)
        return
      case "rename":
      case "share":
      case "delete":
        setDialog({ kind: action, scene })
        return
      default:
        break
    }
    setBusy({ id: scene.id, action })
    try {
      if (action === "start") {
        const created = await services.sessions.createSession(scene.id)
        toast.success(`Game started · room ${formatRoomCode(created.roomCode)}`, { description: "Share the room code with your players." })
        navigate(paths.host(created.sessionId))
      } else if (action === "duplicate") {
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
      const verb = action === "start" ? "start the game" : action === "duplicate" ? "duplicate the scene" : "export the scene"
      toast.error(`Couldn't ${verb}`, { description: describeError(err) })
    } finally {
      setBusy(null)
    }
  }

  const openSampleCopy = async (sampleId: string) => {
    setSampleBusy(sampleId)
    try {
      const { summary } = await createFromSample(services, sampleId)
      toast.success(`Added “${summary.name}” to your library`)
      openEditor(summary.id)
    } catch (err) {
      toast.error("Couldn't copy the sample", { description: describeError(err) })
      setSampleBusy(null)
    }
  }

  // ---- import ----------------------------------------------------------------------------------

  const importFiles = React.useCallback(
    async (files: Iterable<File>) => {
      let imported = 0
      for (const file of files) {
        if (file.type.startsWith("image/")) {
          toast.info("Map images are imported into a new scene", {
            description: file.name,
            action: { label: "New from map images", onClick: () => navigate(paths.newFromImages()) },
          })
          continue
        }
        const id = toast.loading(`Importing ${file.name}…`)
        try {
          const { summary, warnings } = await importSceneFile(services, file)
          imported++
          toast.success(`Imported “${summary.name}”`, { id, action: { label: "Open", onClick: () => navigate(paths.editor(summary.id)) } })
          for (const w of warnings) toast.warning(w)
        } catch (err) {
          toast.error(`Couldn't import ${file.name}`, { id, description: describeError(err) })
        }
      }
      if (imported > 0) reloadScenes()
    },
    [navigate, reloadScenes, services]
  )

  const pickFile = () => fileRef.current?.click()

  // ---- quick join ------------------------------------------------------------------------------

  const join = async () => {
    if (joinCode.length !== 8 || joining) return
    const name = services.identity.displayName
    if (!name) {
      navigate(paths.join(formatRoomCode(joinCode)))
      return
    }
    setJoining(true)
    try {
      const sid = await services.sessions.joinSession(joinCode, name)
      navigate(paths.play(sid))
    } catch (err) {
      const f = describeJoinError(err, services.mode)
      if (f.isDm) {
        const mine = await services.sessions.listMySessions().catch(() => [])
        const hosted = mine.find((s) => s.roomCode === joinCode && s.status === "active")
        toast.info(f.title, { description: f.description, action: hosted ? { label: "Host it", onClick: () => navigate(paths.host(hosted.id)) } : undefined })
      } else {
        toast.error(f.title, { description: f.description })
      }
      setJoining(false)
    }
  }

  const onJoinCodeChange = (code: string, info: { rejected: string[] }) => {
    setJoinCode(code)
    const bad = info.rejected.filter((c) => /\S/u.test(c))
    setJoinHint(bad.length > 0 ? `“${bad[0]}” never appears in room codes — they use digits and letters except I, L, O and U.` : null)
  }

  // ---- keyboard shortcuts & drag-and-drop ----------------------------------------------------

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target) || document.querySelector("[role='dialog'], [role='alertdialog']")) return
      const k = e.key.toLowerCase()
      if (k === "n") navigate(paths.newScene())
      else if (k === "m") navigate(paths.newFromImages())
      else if (k === "i") fileRef.current?.click()
      else if (k === "j") joinRef.current?.focus()
      else if (e.key === "/") searchRef.current?.focus()
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [navigate])

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

  const warmEditor = () => preloadRoute("editor")
  const onIntent = (action: "open" | "start") => preloadRoute(action === "open" ? "editor" : "host")
  const libraryBusy = busy !== null || sampleBusy !== null

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <AppHeader />
      <main className="flex-1">
        <HomeHero
          onNewScene={() => navigate(paths.newScene())}
          onNewFromImages={() => navigate(paths.newFromImages())}
          onImportFile={pickFile}
          onIntent={warmEditor}
          joinCode={joinCode}
          onJoinCodeChange={onJoinCodeChange}
          onJoin={() => void join()}
          joining={joining}
          joinInputRef={joinRef}
          joinHint={joinHint}
        />

        <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:py-10">
          {services.mode === "local" && <LocalModeNotice />}

          {/* Narrow: scenes, sessions, samples. Wide: scenes and samples beside a sticky sessions column. */}
          <div className="grid grid-cols-1 gap-10 [grid-template-areas:'scenes'_'sessions'_'samples'] xl:grid-cols-[minmax(0,1fr)_22rem] xl:grid-rows-[auto_1fr] xl:gap-x-8 xl:[grid-template-areas:'scenes_sessions'_'samples_sessions']">
            <section aria-labelledby="my-scenes" className="flex min-w-0 flex-col gap-4 [grid-area:scenes]">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-col gap-0.5">
                  <h2 id="my-scenes" className="flex items-center gap-2 font-heading text-lg font-semibold tracking-tight">
                    My scenes
                    {scenes.length > 0 && <span className="text-sm font-normal text-muted-foreground tabular-nums">{scenes.length}</span>}
                    {scenesQ.refreshing && <Spinner className="size-3.5 text-muted-foreground" />}
                  </h2>
                  <p className="text-xs text-muted-foreground">{services.mode === "supabase" ? "Saved to your Atlas account." : "Stored in this browser."}</p>
                </div>
                <div className="flex w-full items-center gap-2 sm:w-auto">
                  {scenes.length > 3 && (
                    <InputGroup className="h-7 sm:w-56">
                      <InputGroupAddon>
                        <SearchIcon />
                      </InputGroupAddon>
                      <InputGroupInput
                        ref={searchRef}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Search scenes"
                        aria-label="Search scenes"
                        onKeyDown={(e) => e.key === "Escape" && (setQuery(""), e.currentTarget.blur())}
                      />
                      <InputGroupAddon align="inline-end">
                        {query ? (
                          <InputGroupButton size="icon-xs" aria-label="Clear search" onClick={() => setQuery("")}>
                            <XIcon />
                          </InputGroupButton>
                        ) : (
                          <Kbd>/</Kbd>
                        )}
                      </InputGroupAddon>
                    </InputGroup>
                  )}
                  {scenes.length > 0 && (
                    <>
                      <Button variant="outline" onClick={pickFile} className="max-sm:flex-1">
                        <FileUpIcon data-icon="inline-start" />
                        Import
                      </Button>
                      <Button onClick={() => navigate(paths.newScene())} onPointerEnter={warmEditor} className="max-sm:flex-1">
                        <PlusIcon data-icon="inline-start" />
                        New scene
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {scenesQ.error !== undefined && !scenesQ.data ? (
                <Alert variant="destructive">
                  <AlertTitle>Couldn't load your scenes</AlertTitle>
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
                    <EmptyTitle>Your library is empty</EmptyTitle>
                    <EmptyDescription>Create a scene from scratch, start from your battlemap images, or open a copy of a sample below.</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent className="flex-row justify-center">
                    <Button onClick={() => navigate(paths.newScene())} onPointerEnter={warmEditor}>
                      <PlusIcon data-icon="inline-start" />
                      New scene
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
                      onAction={(a, s) => void onAction(a, s)}
                      onIntent={onIntent}
                    />
                  ))}
                </div>
              )}
            </section>

            <section aria-labelledby="samples" className="flex min-w-0 flex-col gap-4 [grid-area:samples]">
              <div className="flex flex-col gap-0.5">
                <h2 id="samples" className="font-heading text-lg font-semibold tracking-tight">
                  Sample scenes
                </h2>
                <p className="text-xs text-muted-foreground">
                  Ready-made maps to explore the lighting, levels and vision. Opening one adds a copy to your library.
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

            <aside className="flex min-w-0 flex-col gap-4 [grid-area:sessions] xl:sticky xl:top-20 xl:self-start">
              <SessionsPanel sceneNames={sceneNames} />
            </aside>
          </div>
        </div>
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex w-full max-w-7xl flex-wrap items-center justify-between gap-2 px-4 py-4 text-[0.7rem] text-muted-foreground sm:px-6">
          <span>Atlas VTT · DM-authoritative play: players only ever receive what their tokens can see.</span>
          <span className="hidden items-center gap-1.5 sm:flex">
            <Kbd>N</Kbd> new <Kbd>M</Kbd> from images <Kbd>I</Kbd> import <Kbd>J</Kbd> join <Kbd>/</Kbd> search
          </span>
        </div>
      </footer>

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
      <DeleteSceneDialog
        scene={dialog?.kind === "delete" ? dialog.scene : null}
        onClose={() => setDialog(null)}
        onDeleted={(scene) => {
          forgetDigest(scene)
          scenesQ.mutate((list) => list?.filter((s) => s.id !== scene.id))
          toast.success(`Deleted “${scene.name}”`)
        }}
      />

      {dragging && <DropOverlay />}
    </div>
  )
}

function describeError(err: unknown): string {
  if (err instanceof LibraryError && err.details.length > 0) return `${err.message} ${err.details.slice(0, 3).join(" · ")}`
  return userMessage(err)
}

function LocalModeNotice() {
  const { cloudAvailable } = currentMode()
  return (
    <Alert>
      <HardDriveIcon />
      <AlertTitle>Local mode</AlertTitle>
      <AlertDescription>
        Scenes are stored in this browser and games only work between its tabs — each tab is a separate user. Use it for testing; it is not secure.
      </AlertDescription>
      {cloudAvailable && (
        <AlertAction>
          <Button size="xs" variant="outline" onClick={() => window.location.assign(modeSwitchUrl("supabase", window.location.origin + "/"))}>
            Switch to Cloud
          </Button>
        </AlertAction>
      )}
    </Alert>
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
        <p className="text-xs text-muted-foreground">.atlas.json scene files are added to your library.</p>
      </div>
    </div>
  )
}
