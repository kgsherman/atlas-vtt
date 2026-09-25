import * as React from "react"
import { CastIcon, CopyIcon, DoorOpenIcon, RadioIcon, RotateCcwIcon, UsersIcon } from "lucide-react"
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
import type { DmSession, Membership, SessionInfo } from "@/net/sessionsRepo"
import { formatRoomCode } from "@/net/sessionsRepo"
import { cn } from "@/lib/utils"

interface JoinedGame {
  membership: Membership
  info: SessionInfo | null
}

interface SessionsData {
  hosting: DmSession[]
  joined: JoinedGame[]
}

const INFO_LIMIT = 8

/** "My sessions": my open tables (open the map / invite) and games I joined (rejoin). */
export function SessionsPanel({ sceneNames, className }: { sceneNames: Map<string, string>; className?: string }) {
  const services = useServices()
  const { sessions, identity } = services
  const q = useAsync<SessionsData>(`sessions:${services.mode}:${identity.userId}`, async () => {
    const [hosting, memberships] = await Promise.all([sessions.listMySessions(), sessions.listMyMemberships(identity.userId)])
    const infos = await Promise.allSettled(memberships.slice(0, INFO_LIMIT).map((m) => sessions.sessionInfo(m.sessionId)))
    const joined = memberships.map((membership, i) => {
      const r = infos[i]
      return { membership, info: r && r.status === "fulfilled" ? r.value : null }
    })
    return { hosting, joined }
  })
  useOnFocus(q.reload)

  const hosting = q.data?.hosting ?? []
  const active = hosting.filter((s) => s.status === "active")
  const joinedActive = (q.data?.joined ?? []).filter((j) => j.info?.status !== "ended").length
  const [tab, setTab] = React.useState<string | null>(null)
  const effectiveTab = tab ?? (active.length === 0 && joinedActive > 0 ? "joined" : "hosting")

  return (
    <Card className={cn("gap-3", className)}>
      <CardHeader className="gap-0.5">
        <CardTitle className="flex items-center gap-2">
          <RadioIcon className="size-4 text-muted-foreground" />
          My sessions
          {q.refreshing && <Spinner className="size-3 text-muted-foreground" />}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {q.error !== undefined && !q.data ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn't load your sessions</AlertTitle>
            <AlertDescription>{userMessage(q.error)}</AlertDescription>
            <AlertAction>
              <Button size="xs" variant="outline" onClick={q.reload}>
                Retry
              </Button>
            </AlertAction>
          </Alert>
        ) : (
          <Tabs value={effectiveTab} onValueChange={(v) => setTab(String(v))}>
            <TabsList className="w-full">
              <TabsTrigger value="hosting">
                Open tables
                {active.length > 0 && <Badge className="ml-1 h-4 min-w-4 px-1 text-[0.6rem]">{active.length}</Badge>}
              </TabsTrigger>
              <TabsTrigger value="joined">
                Joined
                {joinedActive > 0 && (
                  <Badge variant="secondary" className="ml-1 h-4 min-w-4 px-1 text-[0.6rem]">
                    {joinedActive}
                  </Badge>
                )}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="hosting" className="pt-2">
              {q.loading && !q.data ? <ListSkeleton /> : <HostingList sessions={hosting} sceneNames={sceneNames} />}
            </TabsContent>
            <TabsContent value="joined" className="pt-2">
              {q.loading && !q.data ? <ListSkeleton /> : <JoinedList games={q.data?.joined ?? []} />}
            </TabsContent>
          </Tabs>
        )}
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

function HostingList({ sessions, sceneNames }: { sessions: DmSession[]; sceneNames: Map<string, string> }) {
  // Closed tables are reached through their map's card; the open ones are where players can be.
  const open = sessions.filter((s) => s.status === "active")
  if (open.length === 0) {
    return (
      <Empty className="border py-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CastIcon />
          </EmptyMedia>
          <EmptyTitle>No open tables</EmptyTitle>
          <EmptyDescription>Open a map and press “Open the table” to let players in with its room code.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <ItemGroup className="gap-2">
      {open.map((s) => (
        <HostedItem key={s.id} session={s} sceneName={s.sceneId ? sceneNames.get(s.sceneId) : undefined} />
      ))}
    </ItemGroup>
  )
}

function HostedItem({ session, sceneName }: { session: DmSession; sceneName: string | undefined }) {
  const [, navigate] = useLocation()
  const invite = () => void copyText(inviteLink(window.location.origin, session.roomCode, withModeParam("")), "Invite link")
  return (
    <Item variant="outline" size="xs">
      <ItemContent className="min-w-0">
        <ItemTitle className="gap-1.5">
          <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
          <span className="font-mono tracking-wider">{formatRoomCode(session.roomCode)}</span>
        </ItemTitle>
        <ItemDescription className="truncate text-foreground/80">{sceneName ?? "Untitled scene"}</ItemDescription>
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

function JoinedList({ games }: { games: JoinedGame[] }) {
  const now = useNow()
  const [, navigate] = useLocation()
  if (games.length === 0) {
    return (
      <Empty className="border py-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UsersIcon />
          </EmptyMedia>
          <EmptyTitle>Not in any games</EmptyTitle>
          <EmptyDescription>Games you join with a room code show up here so you can hop back in.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <ItemGroup className="gap-2">
      {games.slice(0, 20).map(({ membership: m, info }) => {
        const kicked = m.status === "kicked" || info?.memberStatus === "kicked"
        const ended = info?.status === "ended"
        const closed = info?.status === "closed"
        const canRejoin = !kicked && !ended
        return (
          <Item key={m.sessionId} variant="outline" size="xs" className={cn(!canRejoin && "opacity-60")}>
            <ItemContent className="min-w-0">
              <ItemTitle className="gap-1.5">
                {info ? <span className="font-mono tracking-wider">{formatRoomCode(info.roomCode)}</span> : <span>Game</span>}
                {kicked ? (
                  <Badge variant="destructive">Removed</Badge>
                ) : ended ? (
                  <Badge variant="outline">Ended</Badge>
                ) : closed ? (
                  <Badge variant="outline">Closed</Badge>
                ) : info ? (
                  <Badge variant="secondary">Open</Badge>
                ) : null}
              </ItemTitle>
              <ItemDescription className="truncate">
                {info?.dmDisplayName ? `${info.dmDisplayName}'s table` : "DM's table"} · as {m.displayName} · {formatRelativeTime(m.joinedAt, now)}
              </ItemDescription>
            </ItemContent>
            {canRejoin && (
              <ItemActions>
                <Button size="sm" variant="secondary" onPointerEnter={() => preloadRoute("play")} onClick={() => navigate(paths.play(m.sessionId))}>
                  {info ? <DoorOpenIcon data-icon="inline-start" /> : <RotateCcwIcon data-icon="inline-start" />}
                  Rejoin
                </Button>
              </ItemActions>
            )}
          </Item>
        )
      })}
    </ItemGroup>
  )
}
