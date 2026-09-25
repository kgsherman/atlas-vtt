import * as React from "react"
import { CastIcon, CopyIcon, DoorOpenIcon, RadioIcon, UsersIcon } from "lucide-react"
import { useLocation } from "wouter"

import { copyText } from "@/app/clipboard"
import { formatRelativeTime } from "@/app/format"
import { userMessage } from "@/app/library"
import { withModeParam } from "@/app/mode"
import { inviteLink } from "@/app/roomCodeInput"
import { paths, preloadRoute } from "@/app/routes"
import { useServices } from "@/app/services"
import { useAsync, useNow, useOnFocus } from "@/app/useAsync"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { formatRoomCode } from "@/net/roomCodes"
import type { DmSession } from "@/net/sessionsRepo"
import type { JoinedWorldInfo } from "@/net/worldsRepo"
import { cn } from "@/lib/utils"

/**
 * "Tables & games" (ARCHITECTURE §6.9): the open tables of my worlds (open the scene / invite) and the
 * worlds I joined as a player (to their open table, or to wait for the DM).
 */
export function SessionsPanel({
  tables,
  tablesError,
  onRetryTables,
  worldNames,
  sceneNames,
  className,
}: {
  /** My tables (listMySessions), loaded by the page with the worlds. */
  tables: DmSession[] | undefined
  /** Why the tables could not be loaded (none: loading or loaded). */
  tablesError?: unknown
  onRetryTables?(): void
  worldNames: Map<string, string>
  sceneNames: Map<string, string>
  className?: string
}) {
  const services = useServices()
  const q = useAsync<JoinedWorldInfo[]>(`joined:${services.mode}:${services.identity.userId}`, () => services.worlds.listJoined())
  useOnFocus(q.reload)

  const open = (tables ?? []).filter((s) => s.status === "active")
  const joinedOpen = (q.data ?? []).filter((j) => j.memberStatus === "active" && j.openSessionId).length
  const [tab, setTab] = React.useState<string | null>(null)
  const effectiveTab = tab ?? (open.length === 0 && (q.data ?? []).length > 0 ? "joined" : "hosting")

  return (
    <Card className={cn("gap-3", className)}>
      <CardHeader className="gap-0.5">
        <CardTitle className="flex items-center gap-2">
          <RadioIcon className="size-4 text-muted-foreground" />
          Tables & games
          {q.refreshing && <Spinner className="size-3 text-muted-foreground" />}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs value={effectiveTab} onValueChange={(v) => setTab(String(v))}>
          <TabsList className="w-full">
            <TabsTrigger value="hosting">
              Open tables
              {open.length > 0 && <Badge className="ml-1 h-4 min-w-4 px-1 text-[0.6rem]">{open.length}</Badge>}
            </TabsTrigger>
            <TabsTrigger value="joined">
              Joined worlds
              {joinedOpen > 0 && (
                <Badge variant="secondary" className="ml-1 h-4 min-w-4 px-1 text-[0.6rem]">
                  {joinedOpen}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="hosting" className="pt-2">
            {tablesError !== undefined ? (
              <Alert variant="destructive">
                <AlertTitle>Couldn't load your tables</AlertTitle>
                <AlertDescription>{userMessage(tablesError)}</AlertDescription>
                {onRetryTables && (
                  <AlertAction>
                    <Button size="xs" variant="outline" onClick={onRetryTables}>
                      Retry
                    </Button>
                  </AlertAction>
                )}
              </Alert>
            ) : !tables ? (
              <ListSkeleton />
            ) : (
              <HostingList tables={open} worldNames={worldNames} sceneNames={sceneNames} />
            )}
          </TabsContent>
          <TabsContent value="joined" className="pt-2">
            {q.error !== undefined && !q.data ? (
              <Alert variant="destructive">
                <AlertTitle>Couldn't load your games</AlertTitle>
                <AlertDescription>{userMessage(q.error)}</AlertDescription>
                <AlertAction>
                  <Button size="xs" variant="outline" onClick={q.reload}>
                    Retry
                  </Button>
                </AlertAction>
              </Alert>
            ) : q.loading && !q.data ? (
              <ListSkeleton />
            ) : (
              <JoinedList worlds={q.data ?? []} />
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      {[0, 1].map((i) => (
        <div key={i} className="flex items-center gap-3 rounded-md border p-2.5">
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3 w-36" />
          </div>
          <Skeleton className="h-6 w-16" />
        </div>
      ))}
    </div>
  )
}

function HostingList({ tables, worldNames, sceneNames }: { tables: DmSession[]; worldNames: Map<string, string>; sceneNames: Map<string, string> }) {
  if (tables.length === 0) {
    return (
      <Empty className="border py-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CastIcon />
          </EmptyMedia>
          <EmptyTitle>No open tables</EmptyTitle>
          <EmptyDescription>Open a scene of a world and press “Open the table” to let the world's players in.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <ItemGroup className="gap-2">
      {tables.map((s) => (
        <HostedItem
          key={s.id}
          session={s}
          worldName={s.worldId ? worldNames.get(s.worldId) : undefined}
          sceneName={s.sceneId ? sceneNames.get(s.sceneId) : undefined}
        />
      ))}
    </ItemGroup>
  )
}

function HostedItem({ session, worldName, sceneName }: { session: DmSession; worldName: string | undefined; sceneName: string | undefined }) {
  const [, navigate] = useLocation()
  const invite = () => void copyText(inviteLink(window.location.origin, session.roomCode, withModeParam("")), "Invite link")
  return (
    <Item variant="outline" size="xs">
      <ItemContent className="min-w-0">
        <ItemTitle className="gap-1.5">
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
          <span className="truncate">{worldName ?? "A world"}</span>
        </ItemTitle>
        <ItemDescription className="truncate">
          <span className="text-foreground/80">{sceneName ?? "Untitled scene"}</span> ·{" "}
          <span className="font-mono tracking-wider">{formatRoomCode(session.roomCode)}</span>
        </ItemDescription>
      </ItemContent>
      <ItemActions className="gap-1">
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Copy invite link" onClick={invite} />}>
            <CopyIcon />
          </TooltipTrigger>
          <TooltipContent>Copy invite link</TooltipContent>
        </Tooltip>
        <Button size="sm" onPointerEnter={() => preloadRoute("host")} onClick={() => navigate(paths.host(session.id))}>
          Open
        </Button>
      </ItemActions>
    </Item>
  )
}

function JoinedList({ worlds }: { worlds: JoinedWorldInfo[] }) {
  const now = useNow()
  const [, navigate] = useLocation()
  if (worlds.length === 0) {
    return (
      <Empty className="border py-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersIcon />
          </EmptyMedia>
          <EmptyTitle>Not in any worlds</EmptyTitle>
          <EmptyDescription>Worlds you join with a room code show up here, so you can come back to their tables.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <ItemGroup className="gap-2">
      {worlds.slice(0, 20).map((w) => {
        const kicked = w.memberStatus === "kicked"
        const open = !kicked && w.openSessionId !== null
        return (
          <Item key={w.worldId} variant="outline" size="xs" className={cn(kicked && "opacity-60")}>
            <ItemContent className="min-w-0">
              <ItemTitle className="gap-1.5">
                <span className="truncate">{w.name}</span>
                {kicked ? (
                  <Badge variant="destructive">Removed</Badge>
                ) : open ? (
                  <Badge variant="secondary">Open</Badge>
                ) : (
                  <Badge variant="outline">Closed</Badge>
                )}
              </ItemTitle>
              <ItemDescription className="truncate">
                {w.characters.length > 0 ? `${w.characters.join(", ")} · ` : ""}as {w.displayName ?? "you"} · {formatRelativeTime(w.joinedAt, now)}
              </ItemDescription>
            </ItemContent>
            {!kicked && (
              <ItemActions>
                <Button
                  size="sm"
                  variant="secondary"
                  onPointerEnter={() => preloadRoute("play")}
                  onClick={() => navigate(open ? paths.play(w.openSessionId!) : paths.worldPlay(w.worldId))}
                >
                  <DoorOpenIcon data-icon="inline-start" />
                  {open ? "Join" : "Wait"}
                </Button>
              </ItemActions>
            )}
          </Item>
        )
      })}
    </ItemGroup>
  )
}
