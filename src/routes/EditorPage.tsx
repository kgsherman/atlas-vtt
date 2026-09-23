/**
 * /editor/:sceneId — the DM scene editor. "new" starts an unsaved scene (?import=1 opens the map image
 * import to build it from battlemaps); any other id opens that library scene.
 */
import * as React from "react"
import { AlertTriangle, ArrowLeft, History, Sparkles } from "lucide-react"
import { useLocation, useParams, useSearch } from "wouter"

import { paths } from "@/app/routes"
import { useServices } from "@/app/services"
import { AppLogoMark } from "@/components/app/AppLogo"
import { ConfirmProvider } from "@/components/editor/ConfirmProvider"
import { EditorContext, useConfirm, type EditorContextValue } from "@/components/editor/context"
import { VersionHistorySheet } from "@/components/editor/dialogs/VersionHistorySheet"
import { EditorShell } from "@/components/editor/EditorShell"
import type { MapImportRequest } from "@/components/editor/dialogs/MapImportDialog"
import { createToolExtrasStore } from "@/components/editor/lib/toolExtras"
import { useSceneDocument } from "@/components/editor/useSceneDocument"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { SCENE_SCHEMA_VERSION } from "@/core/scene/types"
import { createEditorController } from "@/editor/controller"
import { createEditorStore } from "@/editor/store"

function LoadingScreen() {
  return (
    <div className="flex h-svh flex-col bg-background">
      <div className="flex h-11 items-center gap-3 border-b px-3">
        <AppLogoMark className="size-5" />
        <Skeleton className="h-4 w-56" />
        <div className="flex-1" />
        <Skeleton className="h-7 w-28" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-11 border-r" />
        <div className="grid flex-1 place-items-center">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner /> Opening the scene…
          </div>
        </div>
        <div className="flex w-80 flex-col gap-2 border-l p-3">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </div>
    </div>
  )
}

function Problem({ icon, title, description, children }: { icon: React.ReactNode; title: string; description: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="grid h-svh place-items-center bg-background p-6">
      <Empty className="max-w-md border">
        <EmptyHeader>
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
        {children ? <EmptyContent className="flex-row justify-center">{children}</EmptyContent> : null}
      </Empty>
    </div>
  )
}

function EditorRoute() {
  const params = useParams<{ sceneId: string }>()
  const search = useSearch()
  const [, navigate] = useLocation()
  const services = useServices()
  const confirm = useConfirm()
  const routeId = params.sceneId ?? "new"
  const wantsImport = new URLSearchParams(search).get("import") === "1"
  const [ctx] = React.useState<EditorContextValue>(() => {
    const store = createEditorStore()
    return { store, controller: createEditorController(store), extras: createToolExtrasStore() }
  })
  const [importRequest, setImportRequest] = React.useState<MapImportRequest | null>(null)
  const [versionsOpen, setVersionsOpen] = React.useState(false)

  const doc = useSceneDocument({
    store: ctx.store,
    services,
    routeId,
    wantsImport,
    navigate,
    confirm,
    onRequestImport: () => setImportRequest({ mode: "new" }),
  })

  const goHome = React.useCallback(async () => {
    if (ctx.store.getState().dirty) {
      const ok = await confirm({
        title: "Leave the editor?",
        description: "You have unsaved changes. A draft is kept on this device and offered the next time you open the scene.",
        confirmLabel: "Leave",
      })
      if (!ok) return
    }
    navigate(paths.home())
  }, [confirm, ctx.store, navigate])

  if (doc.status === "loading") return <LoadingScreen />
  if (doc.status === "error") {
    return (
      <Problem icon={<AlertTriangle />} title="This scene can't be opened" description={doc.error ?? "Something went wrong."}>
        <Button variant="outline" onClick={() => navigate(paths.home())}>
          <ArrowLeft data-icon="inline-start" /> Library
        </Button>
        <Button onClick={() => navigate(paths.newScene())}>
          <Sparkles data-icon="inline-start" /> New scene
        </Button>
      </Problem>
    )
  }
  if (doc.status === "too-new") {
    return (
      <>
        <Problem
          icon={<AlertTriangle />}
          title="Saved by a newer version of Atlas"
          description={`“${doc.summary?.name ?? "This scene"}” uses scene format v${doc.tooNewSchema ?? "?"}, but this version of Atlas understands up to v${SCENE_SCHEMA_VERSION}. Reload to update the app, or open an older version of the scene.`}
        >
          <Button variant="outline" onClick={() => navigate(paths.home())}>
            <ArrowLeft data-icon="inline-start" /> Library
          </Button>
          <Button variant="outline" onClick={() => setVersionsOpen(true)}>
            <History data-icon="inline-start" /> Older versions
          </Button>
          <Button onClick={() => location.reload()}>Reload</Button>
        </Problem>
        <VersionHistorySheet open={versionsOpen} onOpenChange={setVersionsOpen} doc={doc} />
      </>
    )
  }

  return (
    <EditorContext.Provider value={ctx}>
      <EditorShell doc={doc} goHome={() => void goHome()} importRequest={importRequest} setImportRequest={setImportRequest} />
    </EditorContext.Provider>
  )
}

export default function EditorPage() {
  return (
    <TooltipProvider delay={350}>
      <ConfirmProvider>
        <EditorRoute />
      </ConfirmProvider>
    </TooltipProvider>
  )
}
