/**
 * /scene/:sceneId — open one of the DM's scenes (ARCHITECTURE §6.8): the scene's table (SessionsRepo.openMap,
 * created closed when the scene has none) opens in the scene screen (/host/:sessionId), in Edit or Play.
 * "new" first adds a blank scene to a world (`?world=`, default the first one; §6.9); `?import=1` then opens
 * the map image import, which builds it from battlemaps. The old /map/… and /editor/… links land here too.
 */
import * as React from "react"
import { AlertTriangle, ArrowLeft } from "lucide-react"
import { useLocation, useParams, useSearch } from "wouter"

import { readStartFreeAssets } from "@/app/freeAssets"
import { createBlankMap, userMessage } from "@/app/library"
import { paths, preloadRoute } from "@/app/routes"
import { useServices } from "@/app/services"
import { PageLoader } from "@/components/app/Splash"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"

export default function ScenePage() {
  const params = useParams<{ sceneId?: string }>()
  const search = useSearch()
  const [, navigate] = useLocation()
  const services = useServices()
  const sceneId = params.sceneId ?? "new"
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let alive = true
    preloadRoute("host")
    const q = new URLSearchParams(search)
    const open = async () => {
      const id = sceneId === "new" ? (await createBlankMap(services, q.get("world") ?? undefined)).id : sceneId
      const table = await services.sessions.openMap(id, { freeAssets: readStartFreeAssets() })
      if (!alive) return
      const next = new URLSearchParams()
      if (q.get("import") === "1") next.set("import", "1")
      const mode = q.get("mode")
      if (mode === "edit" || mode === "play") next.set("mode", mode)
      const qs = next.toString()
      navigate(`${paths.host(table.sessionId)}${qs ? `?${qs}` : ""}`, { replace: true })
    }
    // Deferred by a task: StrictMode's mount → unmount → mount must not create two new scenes.
    const timer = setTimeout(() => {
      open().catch((err: unknown) => {
        if (alive) setError(userMessage(err))
      })
    }, 0)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [sceneId, search, services, navigate])

  if (!error) return <PageLoader label={sceneId === "new" ? "Creating the scene…" : "Opening the scene…"} />
  return (
    <div className="grid h-svh place-items-center bg-background p-6">
      <Empty className="max-w-md border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertTriangle />
          </EmptyMedia>
          <EmptyTitle>This scene can't be opened</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button variant="outline" onClick={() => navigate(paths.home())}>
            <ArrowLeft data-icon="inline-start" /> Worlds
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  )
}
