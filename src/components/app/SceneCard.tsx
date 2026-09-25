import {
  CopyIcon,
  DownloadIcon,
  EllipsisIcon,
  FolderInputIcon,
  ImageIcon,
  Link2Icon,
  HammerIcon,
  PencilLineIcon,
  PlayIcon,
  Share2Icon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react"

import { useSceneDigest, useSeenOnce, type DigestEntry, type DigestStatus } from "@/app/digestCache"
import { formatDateTime, formatRelativeTime, plural } from "@/app/format"
import { useServices } from "@/app/services"
import { useNow } from "@/app/useAsync"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { SceneSummary } from "@/net/scenesRepo"
import { cn } from "@/lib/utils"

import { SceneThumbnail } from "./SceneThumbnail"

/** "open" opens the scene in Edit, "play" in Play (the same scene screen: ARCHITECTURE §6.8). */
export type SceneAction = "open" | "play" | "rename" | "duplicate" | "move" | "export" | "share" | "delete"

export interface SceneCardProps {
  scene: SceneSummary
  /** Action in progress on this card (shows a spinner, disables the others). */
  busy: SceneAction | null
  /** Another action is running: disable this card's actions. */
  disabled?: boolean
  /** The DM has other worlds to move the scene to. */
  canMove?: boolean
  onAction(action: SceneAction, scene: SceneSummary): void
  onIntent?(): void
}

export function SceneCard({ scene, busy, disabled: otherBusy = false, canMove = false, onAction, onIntent }: SceneCardProps) {
  const services = useServices()
  const now = useNow()
  const [ref, seen] = useSeenOnce<HTMLDivElement>()
  const { entry, status } = useSceneDigest(services, scene, seen)
  const digest = entry?.digest
  const act = (a: SceneAction) => () => onAction(a, scene)
  const disabled = busy !== null || otherBusy

  return (
    <Card ref={ref} className="group/scene gap-0 py-0 transition-shadow duration-200 hover:ring-foreground/20">
      <button
        type="button"
        onClick={act("open")}
        onPointerEnter={() => onIntent?.()}
        onFocus={() => onIntent?.()}
        disabled={disabled}
        className="relative block aspect-[16/10] w-full overflow-hidden bg-muted/40 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
        aria-label={`Open ${scene.name}`}
      >
        <SceneCardPreview entry={entry} status={status} thumbnailClassName="transition-transform duration-500 ease-out group-hover/scene:scale-[1.03]" />
        <div className="pointer-events-none absolute inset-0 bg-linear-to-t from-background/70 via-transparent to-transparent opacity-80" />
        <div className="absolute top-2 left-2 flex gap-1.5">
          {scene.visibility === "link" && (
            <Badge variant="secondary" className="bg-background/80 backdrop-blur-sm">
              <Link2Icon data-icon="inline-start" />
              Shared
            </Badge>
          )}
          {digest && digest.counts.images > 0 && (
            <Badge variant="secondary" className="bg-background/80 backdrop-blur-sm">
              <ImageIcon data-icon="inline-start" />
              Map
            </Badge>
          )}
        </div>
        <span className="pointer-events-none absolute right-2 bottom-2 inline-flex translate-y-1 items-center gap-1 rounded-full bg-background/85 px-2 py-0.5 text-[0.65rem] font-medium opacity-0 shadow-sm backdrop-blur-sm transition-all duration-200 group-hover/scene:translate-y-0 group-hover/scene:opacity-100">
          <HammerIcon className="size-3" />
          Open in Edit
        </span>
      </button>

      <div className="flex flex-col gap-1 px-4 pt-3 pb-2">
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 truncate font-heading text-sm font-medium" title={scene.name}>
            {scene.name}
          </h3>
          <SceneMenu scene={scene} disabled={disabled} canMove={canMove} onAction={onAction} />
        </div>
        <div className="flex items-center gap-1.5 text-[0.7rem] text-muted-foreground">
          <Tooltip>
            <TooltipTrigger render={<span className="cursor-default" />}>Edited {formatRelativeTime(scene.updatedAt, now)}</TooltipTrigger>
            <TooltipContent>{formatDateTime(scene.updatedAt)}</TooltipContent>
          </Tooltip>
          <span aria-hidden>·</span>
          <span>v{scene.latestVersion}</span>
        </div>
        <div className="flex h-4 items-center text-[0.7rem] text-muted-foreground">
          {digest ? (
            <span className="truncate">
              {plural(digest.levels.length, "level")} · {plural(digest.counts.objects, "object")} · {plural(digest.counts.tokens, "token")}
            </span>
          ) : status === "error" ? (
            <span>Couldn't read this scene</span>
          ) : (
            <Skeleton className="h-3 w-40" />
          )}
        </div>
      </div>

      <div className="flex gap-2 px-4 pb-4">
        <Button variant="outline" className="flex-1" onClick={act("open")} onPointerEnter={() => onIntent?.()} disabled={disabled}>
          {busy === "open" ? <Spinner className="size-3.5" data-icon="inline-start" /> : <HammerIcon data-icon="inline-start" />}
          Edit
        </Button>
        <Button className="flex-1" onClick={act("play")} onPointerEnter={() => onIntent?.()} disabled={disabled}>
          {busy === "play" ? <Spinner className="size-3.5" data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}
          Play
        </Button>
      </div>
    </Card>
  )
}

/**
 * A scene's thumbnail from the digest cache (useSceneDigest): its primary level, a placeholder
 * while it loads, or a notice when it can't be read. Fills its box, cropping whatever overflows it.
 */
export function SceneCardPreview({ entry, status, thumbnailClassName }: { entry: DigestEntry | null; status: DigestStatus; thumbnailClassName?: string }) {
  const digest = entry?.digest
  if (digest)
    return (
      <SceneThumbnail
        level={digest.primary}
        palette={digest.palette}
        cellSize={digest.grid.cellSize}
        image={entry?.image}
        fit="cover"
        className={cn("relative", thumbnailClassName)}
      />
    )
  if (status === "error")
    return (
      <div className="flex size-full flex-col items-center justify-center gap-1.5 text-muted-foreground">
        <TriangleAlertIcon className="size-5" />
        <span className="text-[0.7rem]">Preview unavailable</span>
      </div>
    )
  return <Skeleton className="size-full rounded-none" />
}

function SceneMenu({ scene, disabled, canMove, onAction }: { scene: SceneSummary; disabled: boolean; canMove: boolean; onAction: SceneCardProps["onAction"] }) {
  const { mode } = useServices()
  const item = (action: SceneAction) => () => onAction(action, scene)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={<Button variant="ghost" size="icon-sm" className="-mt-0.5 -mr-1 text-muted-foreground" aria-label={`More actions for ${scene.name}`} />}
      >
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={item("open")}>
            <HammerIcon />
            Edit
          </DropdownMenuItem>
          <DropdownMenuItem onClick={item("play")}>
            <PlayIcon />
            Play
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={item("rename")}>
            <PencilLineIcon />
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem onClick={item("duplicate")}>
            <CopyIcon />
            Duplicate
          </DropdownMenuItem>
          {canMove && (
            <DropdownMenuItem onClick={item("move")}>
              <FolderInputIcon />
              Move to another world…
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={item("export")}>
            <DownloadIcon />
            Export .atlas.json
          </DropdownMenuItem>
          <DropdownMenuItem onClick={item("share")}>
            <Share2Icon />
            {mode === "supabase" ? "Share link…" : "Share link (Cloud only)"}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={item("delete")}>
          <Trash2Icon />
          Delete…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Placeholder card while the scenes load. */
export function SceneCardSkeleton({ className }: { className?: string }) {
  return (
    <Card className={cn("gap-0 py-0", className)}>
      <Skeleton className="aspect-[16/10] w-full rounded-none" />
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-4 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
        <Skeleton className="h-3 w-3/4" />
        <div className="mt-1 flex gap-2">
          <Skeleton className="h-7 flex-1" />
          <Skeleton className="h-7 flex-1" />
        </div>
      </div>
    </Card>
  )
}
