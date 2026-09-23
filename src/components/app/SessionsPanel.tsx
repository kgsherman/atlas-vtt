import * as React from "react"
import { CastIcon, ChevronDownIcon, CopyIcon, DoorOpenIcon, EllipsisIcon, RadioIcon, RotateCcwIcon, SquareIcon, UsersIcon } from "lucide-react"
import { toast } from "sonner"
import { useLocation } from "wouter"

import { copyText } from "@/app/clipboard"
import { formatDateTime, formatRelativeTime } from "@/app/format"
import { userMessage } from "@/app/library"
import { withModeParam } from "@/app/mode"
import { inviteLink } from "@/app/roomCodeInput"
import { paths, preloadRoute } from "@/app/routes"
import { useServices } from "@/app/services"
import { useAsync, useNow, useOnFocus } from "@/app/useAsync"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
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

/** "My sessions": games I host (resume / invite / end) and games I joined (rejoin). */
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
                Hosting
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
              {q.loading && !q.data ? <ListSkeleton /> : <HostingList sessions={hosting} sceneNames={sceneNames} onChanged={q.reload} />}
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

function HostingList({ sessions, sceneNames, onChanged }: { sessions: DmSession[]; sceneNames: Map<string, string>; onChanged(): void }) {
  const [showEnded, setShowEnded] = React.useState(false)
  const [ending, setEnding] = React.useState<DmSession | null>(null)
  const active = sessions.filter((s) => s.status === "active")
  const ended = sessions.filter((s) => s.status === "ended")

  if (sessions.length === 0) {
    return (
      <Empty className="border py-6">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CastIcon />
          </EmptyMedia>
          <EmptyTitle>No games yet</EmptyTitle>
          <EmptyDescription>Press “Start session” on a scene to open a table. Players join with the room code.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {active.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">No games running. Start one from a scene.</p>}
      <ItemGroup className="gap-2">
        {active.map((s) => (
          <HostedItem key={s.id} session={s} sceneName={s.sceneId ? sceneNames.get(s.sceneId) : undefined} onEnd={() => setEnding(s)} />
        ))}
      </ItemGroup>
      {ended.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => setShowEnded((v) => !v)}
            className="flex items-center gap-1 self-start rounded px-1 py-0.5 text-[0.7rem] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <ChevronDownIcon className={cn("size-3 transition-transform", showEnded && "rotate-180")} />
            {showEnded ? "Hide" : "Show"} {ended.length} ended
          </button>
          {showEnded && (
            <ItemGroup className="gap-2">
              {ended.slice(0, 20).map((s) => (
                <HostedItem key={s.id} session={s} sceneName={s.sceneId ? sceneNames.get(s.sceneId) : undefined} />
              ))}
            </ItemGroup>
          )}
        </>
      )}
      <EndSessionDialog session={ending} onClose={() => setEnding(null)} onEnded={onChanged} />
    </div>
  )
}

function HostedItem({ session, sceneName, onEnd }: { session: DmSession; sceneName: string | undefined; onEnd?(): void }) {
  const now = useNow()
  const [, navigate] = useLocation()
  const live = session.status === "active"
  const invite = () => void copyText(inviteLink(window.location.origin, session.roomCode, withModeParam("")), "Invite link")
  return (
    <Item variant="outline" size="xs" className={cn(!live && "opacity-60")}>
      <ItemContent className="min-w-0">
        <ItemTitle className="gap-1.5">
          <span className={cn("size-1.5 shrink-0 rounded-full", live ? "animate-pulse bg-primary" : "bg-muted-foreground/50")} />
          <span className="font-mono tracking-wider">{formatRoomCode(session.roomCode)}</span>
        </ItemTitle>
        <ItemDescription className="flex flex-col">
          <span className="truncate text-foreground/80">{sceneName ?? (session.sceneId ? "Untitled scene" : "Deleted scene")}</span>
          <Tooltip>
            <TooltipTrigger render={<span className="w-fit cursor-default" />}>
              {live ? `Started ${formatRelativeTime(session.createdAt, now)}` : `Ended ${formatRelativeTime(session.endedAt ?? session.createdAt, now)}`}
            </TooltipTrigger>
            <TooltipContent>{formatDateTime(live ? session.createdAt : (session.endedAt ?? session.createdAt))}</TooltipContent>
          </Tooltip>
        </ItemDescription>
      </ItemContent>
      {live && (
        <ItemActions className="gap-1">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Copy invite link" onClick={invite} />}>
              <CopyIcon />
            </TooltipTrigger>
            <TooltipContent>Copy invite link</TooltipContent>
          </Tooltip>
          <Button size="sm" onPointerEnter={() => preloadRoute("host")} onClick={() => navigate(paths.host(session.id))}>
            Resume
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="More session actions" />}>
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={invite}>
                <CopyIcon />
                Copy invite link
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={onEnd}>
                <SquareIcon />
                End session…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </ItemActions>
      )}
    </Item>
  )
}

function EndSessionDialog({ session, onClose, onEnded }: { session: DmSession | null; onClose(): void; onEnded(): void }) {
  const { sessions } = useServices()
  const [busy, setBusy] = React.useState(false)
  const confirm = async () => {
    if (!session) return
    setBusy(true)
    try {
      await sessions.endSession(session.id)
      toast.success(`Ended game ${formatRoomCode(session.roomCode)}`)
      onEnded()
      onClose()
    } catch (err) {
      toast.error("Couldn't end the session", { description: userMessage(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <AlertDialog open={session !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>End this game for everyone?</AlertDialogTitle>
          <AlertDialogDescription>Players are disconnected and the room code stops working. The scene in your library is not affected.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Keep playing</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirm} disabled={busy}>
            {busy && <Spinner className="size-3.5" data-icon="inline-start" />}
            End session
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
                ) : info ? (
                  <Badge variant="secondary">Active</Badge>
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
