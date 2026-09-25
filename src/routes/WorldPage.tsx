/**
 * /world/:worldId — one of the DM's worlds (ARCHITECTURE §6.9): its room code and invite link, the table
 * whose doors are open (where its players are), and three tabs: Scenes (the scene library of the world),
 * Characters (who plays whom, for every scene) and Players (who joined).
 */
import * as React from "react"
import { ArrowLeftIcon, CopyIcon, DoorOpenIcon, EllipsisIcon, GlobeIcon, PencilLineIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"
import { Link, useLocation, useParams, useSearch } from "wouter"

import { copyText } from "@/app/clipboard"
import { sweepUnusedImages, userMessage } from "@/app/library"
import { withModeParam } from "@/app/mode"
import { inviteLink } from "@/app/roomCodeInput"
import { paths, preloadRoute } from "@/app/routes"
import { useServices } from "@/app/services"
import { useAsync, useOnFocus } from "@/app/useAsync"
import { AppHeader } from "@/components/app/AppHeader"
import { ConfirmProvider } from "@/components/editor/ConfirmProvider"
import { useWorldRoster } from "@/components/world/roster"
import { WorldCharacters } from "@/components/world/WorldCharacters"
import { DeleteWorldDialog, WorldNameDialog } from "@/components/world/WorldDialogs"
import { WorldPlayers } from "@/components/world/WorldPlayers"
import { WorldScenes } from "@/components/world/WorldScenes"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatRoomCode } from "@/net/roomCodes"
import type { WorldSummary } from "@/net/worldsRepo"

type WorldTab = "scenes" | "characters" | "players"
const TABS: readonly WorldTab[] = ["scenes", "characters", "players"]

export default function WorldPage() {
  return (
    <ConfirmProvider>
      <World />
    </ConfirmProvider>
  )
}

function World() {
  const services = useServices()
  const params = useParams<{ worldId: string }>()
  const search = useSearch()
  const [, navigate] = useLocation()
  const worldId = params.worldId ?? ""
  const who = `${services.mode}:${services.identity.userId}`

  const worldsQ = useAsync(`worlds:${who}`, () => services.worlds.list())
  const scenesQ = useAsync(`scenes:${who}:${worldId}`, () => services.scenes.list({ worldId }))
  const tablesQ = useAsync(`tables:${who}`, () => services.sessions.listMySessions())
  const roster = useWorldRoster(worldId)
  const { reload: reloadWorlds } = worldsQ
  const { reload: reloadScenes } = scenesQ
  const { reload: reloadTables } = tablesQ
  const reloadAll = React.useCallback(() => {
    reloadWorlds()
    reloadScenes()
    reloadTables()
  }, [reloadWorlds, reloadScenes, reloadTables])
  useOnFocus(reloadAll)

  // Map images no scene uses any more (at most daily, in the background; Supabase only).
  React.useEffect(() => {
    void sweepUnusedImages(services)
  }, [services])

  const initialTab = new URLSearchParams(search).get("tab")
  const [tab, setTab] = React.useState<WorldTab>(TABS.includes(initialTab as WorldTab) ? (initialTab as WorldTab) : "scenes")
  const [dialog, setDialog] = React.useState<"rename" | "delete" | null>(null)

  const worlds = worldsQ.data ?? []
  const world = worlds.find((w) => w.id === worldId) ?? null
  const scenes = scenesQ.data ?? []
  const openTable = (tablesQ.data ?? []).find((t) => t.worldId === worldId && t.status === "active") ?? null
  const openScene = openTable ? scenes.find((s) => s.id === openTable.sceneId) : undefined
  const activePlayers = (roster.data?.members ?? []).filter((m) => m.status === "active").length

  if (worldsQ.error !== undefined && !worldsQ.data) {
    return (
      <Shell>
        <Alert variant="destructive">
          <AlertTitle>Couldn't load the world</AlertTitle>
          <AlertDescription>{userMessage(worldsQ.error)}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={worldsQ.reload}>
              Retry
            </Button>
          </AlertAction>
        </Alert>
      </Shell>
    )
  }
  if (!worldsQ.data) {
    return (
      <Shell>
        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-4 w-56" />
        </div>
      </Shell>
    )
  }
  if (!world) {
    // Not one of mine: a player of it goes to its tables.
    return (
      <Shell>
        <NotMyWorld worldId={worldId} />
      </Shell>
    )
  }
  const onRenamed = (next: WorldSummary) => worldsQ.mutate((list) => list?.map((w) => (w.id === next.id ? next : w)))
  const invite = () => void copyText(inviteLink(window.location.origin, world.roomCode, withModeParam("")), "Invite link")

  return (
    <Shell>
      <header className="flex flex-col gap-4">
        <Link href={paths.home()} className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeftIcon className="size-3.5" />
          Your worlds
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className="flex items-center gap-2 font-heading text-2xl font-semibold tracking-tight sm:text-3xl">
              <span className="truncate">{world.name}</span>
              {worldsQ.refreshing && <Spinner className="size-4 text-muted-foreground" />}
            </h1>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>Room code</span>
              <Badge variant="outline" className="font-mono tracking-wider text-foreground">
                {formatRoomCode(world.roomCode)}
              </Badge>
              <Button variant="ghost" size="xs" onClick={invite}>
                <CopyIcon data-icon="inline-start" />
                Copy invite link
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {openTable ? (
              <Button onPointerEnter={() => preloadRoute("host")} onClick={() => navigate(paths.host(openTable.id))}>
                <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                Table open · {openScene?.name ?? "a scene"}
              </Button>
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <DoorOpenIcon className="size-3.5" />
                No table open: players wait until you open one
              </span>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`More for ${world.name}`} />}>
                <EllipsisIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                <DropdownMenuItem onClick={() => setDialog("rename")}>
                  <PencilLineIcon />
                  Rename…
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setDialog("delete")}>
                  <Trash2Icon />
                  Delete world…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <Tabs value={tab} onValueChange={(v) => setTab(v as WorldTab)} className="gap-6">
        <TabsList>
          <TabsTrigger value="scenes">
            Scenes
            {scenesQ.data && <span className="text-muted-foreground tabular-nums">{scenes.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="characters">
            Characters
            {roster.data && <span className="text-muted-foreground tabular-nums">{roster.data.characters.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="players">
            Players
            {roster.data && <span className="text-muted-foreground tabular-nums">{activePlayers}</span>}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="scenes">
          <WorldScenes world={world} worlds={worlds} scenesQ={scenesQ} onTablesChanged={reloadTables} />
        </TabsContent>
        <TabsContent value="characters">
          <RosterGate roster={roster}>{(r) => <WorldCharacters roster={r} actions={roster.actions} />}</RosterGate>
        </TabsContent>
        <TabsContent value="players">
          <RosterGate roster={roster}>{(r) => <WorldPlayers roster={r} actions={roster.actions} roomCode={world.roomCode} />}</RosterGate>
        </TabsContent>
      </Tabs>

      <WorldNameDialog open={dialog === "rename"} world={world} onClose={() => setDialog(null)} onDone={onRenamed} />
      <DeleteWorldDialog
        world={dialog === "delete" ? world : null}
        sceneCount={scenes.length}
        onClose={() => setDialog(null)}
        onDeleted={(w) => {
          toast.success(`Deleted “${w.name}”`)
          navigate(paths.home())
        }}
      />
    </Shell>
  )
}

function RosterGate({
  roster,
  children,
}: {
  roster: ReturnType<typeof useWorldRoster>
  children(r: NonNullable<ReturnType<typeof useWorldRoster>["data"]>): React.ReactNode
}) {
  if (roster.data) return <>{children(roster.data)}</>
  if (roster.error !== undefined)
    return (
      <Alert variant="destructive">
        <AlertTitle>Couldn't load the characters and players</AlertTitle>
        <AlertDescription>{userMessage(roster.error)}</AlertDescription>
        <AlertAction>
          <Button size="xs" variant="outline" onClick={roster.reload}>
            Retry
          </Button>
        </AlertAction>
      </Alert>
    )
  return (
    <div className="flex flex-col gap-2">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-14 w-full" />
      ))}
    </div>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <AppHeader />
      <main className="flex-1">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-8 sm:px-6 lg:py-10">{children}</div>
      </main>
    </div>
  )
}

/** A world that isn't the caller's: its players go to its tables; anyone else is told it doesn't exist. */
function NotMyWorld({ worldId }: { worldId: string }) {
  const { worlds, mode, identity } = useServices()
  const [, navigate] = useLocation()
  const q = useAsync(`world-info:${mode}:${identity.userId}:${worldId}`, () => worlds.info(worldId))
  const player = q.data?.role === "player"
  React.useEffect(() => {
    if (player) navigate(paths.worldPlay(worldId), { replace: true })
  }, [player, worldId, navigate])
  if (q.loading || player) return <Skeleton className="h-8 w-72" />
  return (
    <Empty className="border py-12">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <GlobeIcon />
        </EmptyMedia>
        <EmptyTitle>This world doesn't exist</EmptyTitle>
        <EmptyDescription>It may have been deleted, or it belongs to another account.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button variant="outline" onClick={() => navigate(paths.home())}>
          <ArrowLeftIcon data-icon="inline-start" />
          Your worlds
        </Button>
      </EmptyContent>
    </Empty>
  )
}
