/**
 * The DM's session sidebar: room code + invite link, host status (with "Take over" on standby), and
 * three tabs — Players (online state, token assignment, per-player movement lock, fog reset, kick),
 * Tokens (by level: hide/reveal, move to level, preview vision, focus) and Table (global locks, party
 * vision, speed rule, sun/moon, fog reset).
 */
import * as React from "react"
import {
  Check,
  Copy,
  Crown,
  Eye,
  EyeOff,
  Footprints,
  Layers,
  Link2,
  Lock,
  LockOpen,
  Moon,
  MoreHorizontal,
  RotateCcw,
  ScanEye,
  Sun,
  Swords,
  UserMinus,
  UserPlus,
  Users,
  Crosshair,
} from "lucide-react"
import { toast } from "sonner"

import { copyText } from "@/app/clipboard"
import { currentMode, withModeParam } from "@/app/mode"
import { paths } from "@/app/routes"
import { useConfirm } from "@/components/editor/context"
import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { initials } from "@/app/format"
import { sortedLevels } from "@/core/scene/queries"
import type { Id, Token } from "@/core/scene/types"
import type { GameState, SessionPlayer } from "@/core/session/types"
import { cn } from "@/lib/utils"
import type { HostMember, HostSnapshot } from "@/net/host"
import { formatRoomCode } from "@/net/sessionsRepo"
import { TOKEN_KIND_LABELS, tokenDisplayName } from "@/play"

import { StatusDot } from "../hud"
import { TokenAvatar } from "../TokenAvatar"
import type { HostActions } from "./hostActions"

export type SessionTab = "players" | "tokens" | "table"

export interface SessionPanelProps {
  snap: HostSnapshot
  state: GameState
  actions: HostActions
  tab: SessionTab
  onTab(tab: SessionTab): void
  selectedTokenId: Id | null
  onSelectToken(id: Id): void
  onFocusToken(id: Id): void
  onPreviewToken(id: Id): void
  onKick(userId: string): Promise<void>
  onTakeOver(): void
}

export function SessionPanel(props: SessionPanelProps) {
  const { snap, state, tab, onTab } = props
  const players = snap.members.filter((m) => m.status === "active")
  const online = players.filter((m) => m.online).length
  return (
    <aside
      aria-label="Session"
      className="flex w-80 shrink-0 flex-col border-l bg-card/40"
    >
      <RoomCodeCard roomCode={snap.roomCode || state.roomCode} />
      {snap.status === "standby" ? (
        <StandbyNotice error={snap.error} onTakeOver={props.onTakeOver} />
      ) : null}
      <Tabs
        value={tab}
        onValueChange={(v) => onTab(v as SessionTab)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <div className="shrink-0 border-b px-2 py-2">
          <TabsList className="w-full">
            <TabsTrigger value="players" className="gap-1 text-[0.6875rem]">
              <Users /> Players
              <Badge variant="secondary" className="h-4 px-1.5 tabular-nums">
                {online}/{players.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="tokens" className="gap-1 text-[0.6875rem]">
              <Swords /> Tokens
            </TabsTrigger>
            <TabsTrigger value="table" className="gap-1 text-[0.6875rem]">
              <Crown /> Table
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="players" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <PlayersTab {...props} />
          </ScrollArea>
        </TabsContent>
        <TabsContent value="tokens" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <TokensTab {...props} />
          </ScrollArea>
        </TabsContent>
        <TabsContent value="table" className="min-h-0 flex-1">
          <ScrollArea className="h-full">
            <TableTab {...props} />
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Room code
// ---------------------------------------------------------------------------

function RoomCodeCard({ roomCode }: { roomCode: string }) {
  const code = formatRoomCode(roomCode)
  const link = `${location.origin}${withModeParam(paths.join(code))}`
  const local = currentMode().mode === "local"
  const [copied, setCopied] = React.useState(false)
  React.useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <div className="flex flex-col gap-2 border-b p-3">
      <div className="flex items-center justify-between">
        <span className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
          Room code
        </span>
        {local ? (
          <Tooltip>
            <TooltipTrigger
              render={<Badge variant="outline" className="cursor-default" />}
            >
              Local
            </TooltipTrigger>
            <TooltipContent className="max-w-60">
              Local mode: players join from another tab of this browser.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Copy the room code"
          onClick={() =>
            void copyText(code, "Room code").then((ok) => setCopied(ok))
          }
          className="flex-1 rounded-md border border-dashed border-primary/40 bg-primary/5 py-2 text-center font-mono text-2xl font-semibold tracking-[0.2em] text-foreground transition-colors outline-none hover:bg-primary/10 focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {code || "········"}
        </button>
        <div className="flex flex-col gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Copy code"
                  onClick={() =>
                    void copyText(code, "Room code").then((ok) => setCopied(ok))
                  }
                />
              }
            >
              {copied ? <Check /> : <Copy />}
            </TooltipTrigger>
            <TooltipContent side="left">Copy the code</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Copy invite link"
                  onClick={() => void copyText(link, "Invite link")}
                />
              }
            >
              <Link2 />
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-72 break-all">
              Copy the invite link · {link}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}

function StandbyNotice({
  error,
  onTakeOver,
}: {
  error: string | null
  onTakeOver(): void
}) {
  return (
    <div className="flex flex-col gap-2 border-b bg-muted/40 p-3 text-xs">
      <span className="font-medium">Not hosting from this tab</span>
      <span className="text-muted-foreground">
        {error ??
          "Another tab or device is running this table. Changes here are disabled."}
      </span>
      <Button size="sm" onClick={onTakeOver} className="self-start">
        <Crown data-icon="inline-start" /> Take over hosting
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

function sortTokensForAssignment(tokens: Token[]): Token[] {
  const rank = { pc: 0, npc: 1, monster: 2 } as const
  return tokens
    .slice()
    .sort(
      (a, b) =>
        rank[a.kind] - rank[b.kind] ||
        tokenDisplayName(a).localeCompare(tokenDisplayName(b))
    )
}

function PlayersTab({ snap, state, actions, onKick }: SessionPanelProps) {
  const confirm = useConfirm()
  const members = snap.members.filter((m) => m.status === "active")
  if (members.length === 0) {
    return (
      <Empty className="m-3 border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <UserPlus />
          </EmptyMedia>
          <EmptyTitle>No players yet</EmptyTitle>
          <EmptyDescription>
            Share the room code above. Players appear here as they join, and you
            can hand them their characters.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  const tokens = sortTokensForAssignment(Object.values(state.scene.tokens))
  const kick = async (m: HostMember) => {
    const ok = await confirm({
      title: `Remove ${m.displayName}?`,
      description:
        "They are disconnected, lose their characters and can't rejoin this session with the room code.",
      confirmLabel: "Remove player",
      destructive: true,
    })
    if (!ok) return
    try {
      await onKick(m.userId)
      toast.success(`${m.displayName} was removed`)
    } catch (err) {
      toast.error(`Couldn't remove ${m.displayName}`, {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return (
    <div className="flex flex-col gap-1.5 p-2">
      {members.map((m) => {
        const p = state.players[m.userId] as SessionPlayer | undefined
        const owned = tokens.filter((t) =>
          (state.owners[t.id] ?? []).includes(m.userId)
        )
        const locked = state.movementLocked || (p?.movementLocked ?? false)
        return (
          <div
            key={m.userId}
            className="flex flex-col gap-2 rounded-lg border bg-card/60 p-2.5"
          >
            <div className="flex items-center gap-2.5">
              <Avatar size="sm">
                <AvatarFallback
                  className="text-[0.625rem] font-medium"
                  style={
                    p
                      ? { backgroundColor: `${p.color}33`, color: p.color }
                      : undefined
                  }
                >
                  {initials(m.displayName)}
                </AvatarFallback>
                <AvatarBadge
                  className={cn(
                    "size-2 ring-1",
                    m.online ? "bg-primary" : "bg-muted-foreground/60"
                  )}
                />
              </Avatar>
              <div className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-xs font-medium">
                  {m.displayName}
                </span>
                <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                  <StatusDot
                    tone={m.linked ? "ok" : m.online ? "warn" : "off"}
                    pulse={m.online && !m.linked}
                  />
                  {m.linked
                    ? "Connected"
                    : m.online
                      ? "Connecting…"
                      : "Offline"}
                </span>
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant={p?.movementLocked ? "secondary" : "ghost"}
                      size="icon-sm"
                      aria-label={
                        p?.movementLocked
                          ? "Unlock this player's movement"
                          : "Lock this player's movement"
                      }
                      aria-pressed={p?.movementLocked ?? false}
                      disabled={!p}
                      onClick={() =>
                        actions.setMovementLocked(
                          !(p?.movementLocked ?? false),
                          m.userId
                        )
                      }
                    />
                  }
                >
                  {p?.movementLocked ? (
                    <Lock className="text-sidebar-primary" />
                  ) : (
                    <LockOpen />
                  )}
                </TooltipTrigger>
                <TooltipContent>
                  {state.movementLocked
                    ? "All movement is locked (Table tab)"
                    : p?.movementLocked
                      ? "Movement locked — click to unlock"
                      : "Lock this player's movement"}
                </TooltipContent>
              </Tooltip>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`More for ${m.displayName}`}
                    />
                  }
                >
                  <MoreHorizontal />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuItem onClick={() => actions.resetFog(m.userId)}>
                    <RotateCcw /> Reset their fog of war
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => void kick(m)}
                  >
                    <UserMinus /> Remove from session…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {owned.map((t) => (
                <Badge
                  key={t.id}
                  variant="outline"
                  className="h-6 gap-1 pr-1 pl-0.5"
                >
                  <TokenAvatar
                    token={t}
                    size="sm"
                    className="size-4 ring-1 ring-offset-0"
                  />
                  <span className="max-w-24 truncate">
                    {tokenDisplayName(t)}
                  </span>
                  <button
                    type="button"
                    aria-label={`Unassign ${tokenDisplayName(t)}`}
                    className="rounded-sm px-0.5 text-muted-foreground hover:text-foreground"
                    onClick={() => actions.assign(t.id, m.userId, false)}
                  >
                    ×
                  </button>
                </Badge>
              ))}
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="xs"
                      className="h-6"
                      disabled={!p}
                    />
                  }
                >
                  <UserPlus data-icon="inline-start" />{" "}
                  {owned.length === 0 ? "Assign character" : "Assign"}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-72 w-60">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>
                      Characters {m.displayName} controls
                    </DropdownMenuLabel>
                    {tokens.map((t) => (
                      <DropdownMenuCheckboxItem
                        key={t.id}
                        checked={owned.some((o) => o.id === t.id)}
                        onCheckedChange={(c) =>
                          actions.assign(t.id, m.userId, c)
                        }
                        closeOnClick={false}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: t.color }}
                          />
                          <span className="truncate">
                            {tokenDisplayName(t)}
                          </span>
                          <span className="text-[0.625rem] text-muted-foreground">
                            {t.kind === "pc" ? "PC" : TOKEN_KIND_LABELS[t.kind]}
                          </span>
                          {t.hidden ? (
                            <EyeOff className="size-3 text-muted-foreground" />
                          ) : null}
                        </span>
                      </DropdownMenuCheckboxItem>
                    ))}
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              {locked && !p?.movementLocked ? (
                <span className="ml-auto flex items-center gap-1 text-[0.625rem] text-muted-foreground">
                  <Lock className="size-3" /> all locked
                </span>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

function TokensTab({
  state,
  actions,
  selectedTokenId,
  onSelectToken,
  onFocusToken,
  onPreviewToken,
}: SessionPanelProps) {
  const scene = state.scene
  const levels = sortedLevels(scene).reverse()
  const byLevel = new Map<Id, Token[]>()
  for (const t of Object.values(scene.tokens)) {
    const list = byLevel.get(t.levelId) ?? []
    list.push(t)
    byLevel.set(t.levelId, list)
  }
  const playerName = (uid: string) =>
    state.players[uid]?.displayName ?? "Player"
  if (Object.keys(scene.tokens).length === 0) {
    return (
      <Empty className="m-3 border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Swords />
          </EmptyMedia>
          <EmptyTitle>No tokens on this map</EmptyTitle>
          <EmptyDescription>
            Use “Edit map” and the token tool (K) to place characters and
            monsters.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className="flex flex-col gap-3 p-2">
      {levels.map((level) => {
        const list = sortTokensForAssignment(byLevel.get(level.id) ?? [])
        if (list.length === 0) return null
        return (
          <section key={level.id} className="flex flex-col gap-0.5">
            <h3 className="flex items-center gap-1.5 px-1.5 pb-1 text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
              <Layers className="size-3" /> {level.name}
              <span className="ml-auto normal-case tabular-nums">
                {list.length}
              </span>
            </h3>
            {list.map((t) => {
              const owners = state.owners[t.id] ?? []
              const active = t.id === selectedTokenId
              return (
                <div
                  key={t.id}
                  className={cn(
                    "group/token flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/50",
                    active &&
                      "bg-primary/25 ring-1 ring-primary/50 hover:bg-primary/30"
                  )}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
                    onClick={() => onSelectToken(t.id)}
                    onDoubleClick={() => onFocusToken(t.id)}
                  >
                    <TokenAvatar token={t} size="sm" dimmed={t.hidden} />
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span
                        className={cn(
                          "truncate text-xs font-medium",
                          t.hidden && "text-muted-foreground",
                          active && "font-semibold"
                        )}
                      >
                        {tokenDisplayName(t)}
                      </span>
                      <span className="truncate text-[0.625rem] text-muted-foreground">
                        {t.hidden ? "Hidden · " : ""}
                        {owners.length > 0
                          ? owners.map(playerName).join(", ")
                          : TOKEN_KIND_LABELS[t.kind]}
                      </span>
                    </span>
                  </button>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={
                            t.hidden ? "Reveal to players" : "Hide from players"
                          }
                          onClick={() =>
                            actions.setTokensHidden([t.id], !t.hidden)
                          }
                        />
                      }
                    >
                      {t.hidden ? (
                        <EyeOff className="text-muted-foreground" />
                      ) : (
                        <Eye />
                      )}
                    </TooltipTrigger>
                    <TooltipContent>
                      {t.hidden
                        ? "Hidden — click to reveal"
                        : "Visible to players — click to hide"}
                    </TooltipContent>
                  </Tooltip>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`More for ${tokenDisplayName(t)}`}
                        />
                      }
                    >
                      <MoreHorizontal />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem onClick={() => onFocusToken(t.id)}>
                        <Crosshair /> Find on the map
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onPreviewToken(t.id)}>
                        <ScanEye /> Preview its vision
                      </DropdownMenuItem>
                      <DropdownMenuSub>
                        <DropdownMenuSubTrigger>
                          <Layers /> Move to level
                        </DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="w-44">
                          {levels.map((l) => (
                            <DropdownMenuCheckboxItem
                              key={l.id}
                              checked={l.id === t.levelId}
                              disabled={l.id === t.levelId}
                              onClick={() =>
                                actions.moveTokenToLevel(t.id, l.id)
                              }
                            >
                              {l.name}
                            </DropdownMenuCheckboxItem>
                          ))}
                        </DropdownMenuSubContent>
                      </DropdownMenuSub>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Table (global rules)
// ---------------------------------------------------------------------------

function ToggleRow({
  icon,
  title,
  description,
  checked,
  onChange,
  disabled,
}: {
  icon: React.ReactNode
  title: string
  description: string
  checked: boolean
  onChange(v: boolean): void
  disabled?: boolean
}) {
  const id = React.useId()
  return (
    <Field orientation="horizontal" className="items-start gap-3">
      <span className="mt-0.5 text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <FieldContent>
        <FieldLabel htmlFor={id}>
          <FieldTitle>{title}</FieldTitle>
        </FieldLabel>
        <FieldDescription className="text-[0.6875rem]">
          {description}
        </FieldDescription>
      </FieldContent>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </Field>
  )
}

function TableTab({ state, actions }: SessionPanelProps) {
  const confirm = useConfirm()
  const env = state.scene.environment
  const moon = env.directional.kind === "moon"
  const resetAll = async () => {
    const ok = await confirm({
      title: "Reset the fog of war for everyone?",
      description:
        "Players forget every explored area and remembered object. What their characters see right now stays visible.",
      confirmLabel: "Reset fog",
      destructive: true,
    })
    if (ok) actions.resetFog()
  }
  return (
    <div className="flex flex-col gap-4 p-3">
      <FieldGroup className="gap-4">
        <ToggleRow
          icon={<Lock />}
          title="Lock all movement"
          description="Players can't move tokens or open doors (e.g. between rounds)."
          checked={state.movementLocked}
          onChange={(v) => actions.setMovementLocked(v)}
        />
        <ToggleRow
          icon={<Users />}
          title="Shared party vision"
          description="Players who own a PC see through every PC of the party."
          checked={state.sharedVision}
          onChange={(v) => actions.setSharedVision(v)}
        />
        <ToggleRow
          icon={<Footprints />}
          title="Enforce speed"
          description="A move may not exceed the token's walking speed."
          checked={state.enforceSpeed}
          onChange={(v) => actions.setEnforceSpeed(v)}
        />
      </FieldGroup>
      <Separator />
      <FieldGroup className="gap-4">
        <ToggleRow
          icon={moon ? <Moon /> : <Sun />}
          title={moon ? "Moonlight" : "Sunlight"}
          description={`The ${moon ? "moon" : "sun"} lights outdoor areas and casts shadows. Sky: ${env.skyLevel}, indoors: ${env.ambientLevel}.`}
          checked={env.directional.enabled}
          onChange={(v) => actions.setSun(v)}
        />
      </FieldGroup>
      <Separator />
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium">Fog of war</span>
        <span className="text-[0.6875rem] text-muted-foreground">
          Reset one player from the Players tab, or everyone at once.
        </span>
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => void resetAll()}
        >
          <RotateCcw data-icon="inline-start" /> Reset for everyone…
        </Button>
      </div>
    </div>
  )
}
