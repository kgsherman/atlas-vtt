/**
 * /map/:sceneId — open one of the DM's maps (ARCHITECTURE §6.8): the map's table (SessionsRepo.openMap,
 * created closed when the map has none) opens in the map screen (/host/:sessionId), in Edit or Play.
 * "new" first adds a blank map to the library (?import=1: then the map image import builds it from
 * battlemaps). The old /editor/… links land here too.
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

export default function MapPage() {
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
      const id = sceneId === "new" ? (await createBlankMap(services)).id : sceneId
      const table = await services.sessions.openMap(id, { freeAssets: readStartFreeAssets() })
      if (!alive) return
      const next = new URLSearchParams()
      if (q.get("import") === "1") next.set("import", "1")
      const mode = q.get("mode")
      if (mode === "edit" || mode === "play") next.set("mode", mode)
      const qs = next.toString()
      navigate(`${paths.host(table.sessionId)}${qs ? `?${qs}` : ""}`, { replace: true })
    }
    // Deferred by a task: StrictMode's mount → unmount → mount must not create two new maps.
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

  if (!error) return <PageLoader label={sceneId === "new" ? "Creating the map…" : "Opening the map…"} />
  return (
    <div className="grid h-svh place-items-center bg-background p-6">
      <Empty className="max-w-md border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AlertTriangle />
          </EmptyMedia>
          <EmptyTitle>This map can't be opened</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button variant="outline" onClick={() => navigate(paths.home())}>
            <ArrowLeft data-icon="inline-start" /> Library
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  )
}
