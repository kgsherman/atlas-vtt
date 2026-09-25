/**
 * A world on the home page (ARCHITECTURE §6.9): the thumbnail of its most recently edited scene, its name,
 * how many scenes it has, its room code, and whether a table of it is open.
 */
import { GlobeIcon, LibraryBigIcon } from "lucide-react"
import { useLocation } from "wouter"

import { useSceneDigest, useSeenOnce } from "@/app/digestCache"
import { formatRelativeTime, plural } from "@/app/format"
import { paths } from "@/app/routes"
import { useServices } from "@/app/services"
import { useNow } from "@/app/useAsync"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { formatRoomCode } from "@/net/roomCodes"
import type { SceneSummary } from "@/net/scenesRepo"
import type { WorldSummary } from "@/net/worldsRepo"

import { SceneCardPreview } from "./SceneCard"

export function WorldCard({ world, scenes, tableOpen }: { world: WorldSummary; scenes: SceneSummary[]; tableOpen: boolean }) {
  const [, navigate] = useLocation()
  const now = useNow()
  const latest = scenes[0] ?? null
  const lastEdit = latest && latest.updatedAt > world.updatedAt ? latest.updatedAt : world.updatedAt

  return (
    <Card className="group/world gap-0 py-0 transition-shadow duration-200 hover:ring-foreground/20">
      <button
        type="button"
        onClick={() => navigate(paths.world(world.id))}
        className="relative block aspect-[16/9] w-full overflow-hidden bg-muted/40 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        aria-label={`Open ${world.name}`}
      >
        {latest ? (
          <LatestScenePreview scene={latest} />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
            <LibraryBigIcon className="size-6" />
            <span className="text-[0.7rem]">No scenes yet</span>
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-background/80 via-background/10 to-transparent" />
        {tableOpen && (
          <Badge className="absolute top-2 left-2 gap-1.5">
            <span className="size-1.5 animate-pulse rounded-full bg-primary-foreground" />
            Table open
          </Badge>
        )}
        <div className="absolute inset-x-0 bottom-0 flex items-end gap-2 px-4 pb-3">
          <GlobeIcon className="mb-0.5 size-4 shrink-0 text-muted-foreground" />
          <h3 className="min-w-0 flex-1 truncate font-heading text-base font-semibold" title={world.name}>
            {world.name}
          </h3>
        </div>
      </button>
      <div className="flex items-center gap-1.5 px-4 py-2.5 text-[0.7rem] text-muted-foreground">
        <span>{plural(scenes.length, "scene")}</span>
        <span aria-hidden>·</span>
        <span className="truncate">Edited {formatRelativeTime(lastEdit, now)}</span>
        <Badge variant="outline" className="ml-auto font-mono tracking-wider">
          {formatRoomCode(world.roomCode)}
        </Badge>
      </div>
    </Card>
  )
}

function LatestScenePreview({ scene }: { scene: SceneSummary }) {
  const services = useServices()
  const [ref, seen] = useSeenOnce<HTMLDivElement>()
  const { entry, status } = useSceneDigest(services, scene, seen)
  return (
    <div ref={ref} className="size-full">
      <SceneCardPreview entry={entry} status={status} thumbnailClassName="transition-transform duration-500 ease-out group-hover/world:scale-[1.03]" />
    </div>
  )
}

/** Placeholder card while the worlds load. */
export function WorldCardSkeleton() {
  return (
    <Card className="gap-0 py-0">
      <Skeleton className="aspect-[16/9] w-full rounded-none" />
      <div className="flex gap-2 p-3">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="ml-auto h-3 w-16" />
      </div>
    </Card>
  )
}
