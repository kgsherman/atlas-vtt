/**
 * A link-shared scene (/shared/:slug): preview (top-down schematic + stats) and "Copy to my scenes".
 * Shared links are read through the get_shared_scene RPC only (Cloud mode).
 */
import * as React from "react"
import { CloudIcon, CopyPlusIcon, ImageOffIcon, LayersIcon, Link2OffIcon, MapIcon, SparklesIcon, TriangleAlertIcon } from "lucide-react"
import { toast } from "sonner"
import { useLocation, useParams } from "wouter"

import { plural } from "@/app/format"
import { copySharedScene, hasMapImages, userMessage } from "@/app/library"
import { currentMode, modeSwitchUrl } from "@/app/mode"
import { paths, preloadRoute } from "@/app/routes"
import { sceneDigest, type SceneDigest } from "@/app/sceneDigest"
import { useServices } from "@/app/services"
import { useAsync } from "@/app/useAsync"
import { AppHeader } from "@/components/app/AppHeader"
import { SceneThumbnail } from "@/components/app/SceneThumbnail"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import type { Scene } from "@/core/scene/types"
import { SHARE_SLUG_RE, type SharedScene } from "@/net/scenesRepo"
import { isNetError, NetError } from "@/net/supabase"

export default function SharedScenePage() {
  const services = useServices()
  const { slug = "" } = useParams<{ slug: string }>()
  const valid = SHARE_SLUG_RE.test(slug)
  const q = useAsync<SharedScene>(`shared:${services.mode}:${slug}`, async () => {
    if (!valid) throw new NetError("not_found", "malformed share link")
    return services.scenes.getShared(slug)
  })

  return (
    <div className="flex min-h-svh flex-col bg-background">
      <AppHeader />
      <main className="relative isolate flex flex-1 flex-col">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-96 overflow-hidden">
          <div className="absolute -top-40 left-1/2 h-96 w-[48rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
        </div>
        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-4 py-8 sm:px-6 sm:py-12">
          {q.loading ? (
            <SharedSkeleton />
          ) : q.error !== undefined ? (
            <SharedError error={q.error} onRetry={q.reload} />
          ) : q.data ? (
            <SharedView shared={q.data} />
          ) : null}
        </div>
      </main>
    </div>
  )
}

function SharedSkeleton() {
  return (
    <div className="grid gap-8 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <Skeleton className="aspect-[4/3] w-full rounded-xl" />
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="mt-4 h-9 w-44" />
      </div>
    </div>
  )
}

function SharedError({ error, onRetry }: { error: unknown; onRetry(): void }) {
  const mode = currentMode()
  if (isNetError(error, "unsupported_offline")) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CloudIcon />
          </EmptyMedia>
          <EmptyTitle className="text-base">Shared links need Cloud mode</EmptyTitle>
          <EmptyDescription>This tab is running in local mode, where scenes live only in this browser.</EmptyDescription>
        </EmptyHeader>
        {mode.cloudAvailable && (
          <EmptyContent>
            <Button onClick={() => window.location.assign(modeSwitchUrl("supabase", window.location.href))}>
              <CloudIcon data-icon="inline-start" />
              Switch to Cloud mode
            </Button>
          </EmptyContent>
        )}
      </Empty>
    )
  }
  if (isNetError(error, "not_found") || isNetError(error, "invalid_argument")) {
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Link2OffIcon />
          </EmptyMedia>
          <EmptyTitle className="text-base">This link doesn't work</EmptyTitle>
          <EmptyDescription>The link may be mistyped, or its owner turned sharing off or reset the link.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={() => window.location.assign("/")}>
            Go to your scenes
          </Button>
        </EmptyContent>
      </Empty>
    )
  }
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TriangleAlertIcon />
        </EmptyMedia>
        <EmptyTitle className="text-base">Couldn't open this scene</EmptyTitle>
        <EmptyDescription>{userMessage(error)}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button onClick={onRetry}>Try again</Button>
      </EmptyContent>
    </Empty>
  )
}

function SharedView({ shared }: { shared: SharedScene }) {
  const services = useServices()
  const [, navigate] = useLocation()
  const [copying, setCopying] = React.useState(false)
  const parsed = shared.parsed
  const scene: Scene | null = parsed.ok ? parsed.scene : null
  const digest: SceneDigest | null = React.useMemo(() => (scene ? sceneDigest(scene) : null), [scene])
  const images = scene ? hasMapImages(scene) : false

  const copy = async () => {
    setCopying(true)
    try {
      const { summary, warnings } = await copySharedScene(services, shared)
      toast.success(`Copied “${summary.name}” to your scenes`)
      for (const w of warnings) toast.warning(w)
      navigate(paths.editor(summary.id))
    } catch (err) {
      toast.error("Couldn't copy the scene", { description: userMessage(err) })
      setCopying(false)
    }
  }

  return (
    <div className="grid animate-in items-start gap-8 duration-300 fade-in-0 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
      <Card className="overflow-hidden p-0 shadow-2xl">
        <div className="relative aspect-[4/3] w-full bg-muted/40">
          {digest ? (
            <SceneThumbnail level={digest.primary} palette={digest.palette} cellSize={digest.grid.cellSize} mood="night" />
          ) : (
            <div className="flex size-full items-center justify-center text-muted-foreground">
              <MapIcon className="size-8" />
            </div>
          )}
          {digest && (
            <Badge variant="secondary" className="absolute bottom-3 left-3 bg-background/80 backdrop-blur-sm">
              <LayersIcon data-icon="inline-start" />
              {digest.primary.name || "Level"}
            </Badge>
          )}
        </div>
      </Card>

      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <Badge variant="outline" className="w-fit">
            <SparklesIcon data-icon="inline-start" />
            Shared scene · v{shared.version}
          </Badge>
          <h1 className="font-heading text-3xl font-semibold tracking-tight text-balance">{shared.name}</h1>
        </div>

        {digest && scene && (
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <Stat
              label="Grid"
              value={`${scene.grid.width} × ${scene.grid.depth} cells`}
              hint={`${scene.grid.width * scene.grid.cellSize} × ${scene.grid.depth * scene.grid.cellSize} ft`}
            />
            <Stat label="Levels" value={String(digest.levels.length)} hint={digest.levels.map((l) => l.name).join(" · ")} />
            <Stat
              label="Objects"
              value={digest.counts.objects.toLocaleString("en-US")}
              hint={`${plural(digest.counts.walls, "wall")} · ${plural(digest.counts.doors, "door")}`}
            />
            <Stat
              label="Lights & tokens"
              value={`${digest.counts.lights} · ${digest.counts.tokens}`}
              hint={`${plural(digest.counts.lights, "light")}, ${plural(digest.counts.tokens, "token")}`}
            />
          </dl>
        )}

        {!parsed.ok && (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>{parsed.error === "too-new" ? "Made with a newer version of Atlas" : "This scene's data is damaged"}</AlertTitle>
            <AlertDescription>{parsed.error === "too-new" ? "Update the app to open or copy it." : "It can't be opened or copied."}</AlertDescription>
          </Alert>
        )}
        {images && (
          <Alert>
            <ImageOffIcon />
            <AlertTitle>Map images aren't included</AlertTitle>
            <AlertDescription>Shared links carry the geometry, lights and tokens but not the owner's battlemap images.</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-2">
          <Button
            size="lg"
            className="h-9 px-4 text-sm"
            onClick={() => void copy()}
            onPointerEnter={() => preloadRoute("editor")}
            disabled={!parsed.ok || copying}
          >
            {copying ? <Spinner className="size-4" data-icon="inline-start" /> : <CopyPlusIcon data-icon="inline-start" />}
            Copy to my scenes
          </Button>
        </div>
        <p className="text-[0.7rem] text-muted-foreground">The copy is yours to edit and play; the original is not affected.</p>
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg bg-card p-3 ring-1 ring-foreground/10">
      <dt className="text-[0.7rem] text-muted-foreground">{label}</dt>
      <dd className="font-heading text-base font-semibold tabular-nums">{value}</dd>
      {hint && (
        <dd className="truncate text-[0.7rem] text-muted-foreground" title={hint}>
          {hint}
        </dd>
      )}
    </div>
  )
}
