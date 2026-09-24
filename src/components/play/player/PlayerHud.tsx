/**
 * The player's HUD over the map: session chip (scene, connection), status banners (own connection
 * offline, DM away, movement locked, reconnecting), the party panel (own characters, selected
 * character card with senses, speed and level changes: ladder climbs, stairs/ramp steps), the tool
 * dock and the camera dock. Everything floats in fixed-size glass panels so nothing shifts the map.
 */
import * as React from "react"
import {
  ArrowDownToLine,
  ArrowUpToLine,
  CircleUserRound,
  Eye,
  Footprints,
  Hourglass,
  Layers,
  Lock,
  LogOut,
  UserRoundSearch,
  Users,
  WifiOff,
} from "lucide-react"
import { useLocation } from "wouter"

import { openTokenMaker, paths } from "@/app/routes"
import { AppLogoMark } from "@/components/app/AppLogo"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { CommandKbd } from "@/components/keybindings/CommandKbd"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { Id, SceneLike, Token } from "@/core/scene/types"
import { cn } from "@/lib/utils"
import type { PlayerClientSnapshot } from "@/net/player"
import {
  describeSenses,
  formatFeet,
  presentTokens,
  tokenDisplayName,
  type ClimbOption,
  type PlayTool,
} from "@/play"

import {
  CameraDock,
  glass,
  HudButton,
  HudPanel,
  ShortcutsButton,
  StatusDot,
  ToolSwitch,
  type CameraDockProps,
} from "../hud"
import { TokenAvatar } from "../TokenAvatar"

export interface PlayerHudProps {
  snap: PlayerClientSnapshot
  scene: SceneLike
  selectedId: Id | null
  onSelect(id: Id): void
  tool: PlayTool
  onTool(t: PlayTool): void
  climbs: ClimbOption[]
  onClimb(o: ClimbOption): void
  camera: Omit<CameraDockProps, "className" | "side">
}

export function PlayerHud({
  snap,
  scene,
  selectedId,
  onSelect,
  tool,
  onTool,
  climbs,
  onClimb,
  camera,
}: PlayerHudProps) {
  const view = snap.view!
  const mine = presentTokens(scene, view.controlledTokenIds)
  const selected = mine.find((t) => t.id === selectedId) ?? null
  const pendingTokens = new Set(
    snap.pending
      .filter((p) => p.kind === "move" && p.tokenId)
      .map((p) => p.tokenId as Id)
  )

  return (
    <div className="pointer-events-none absolute inset-0 z-10 select-none">
      {/* top-left: session */}
      <div className="absolute top-3 left-3 flex w-72 flex-col gap-2">
        <SessionChip snap={snap} />
        {mine.length > 0 ? (
          <PartyPanel
            tokens={mine}
            scene={scene}
            selectedId={selectedId}
            onSelect={onSelect}
            pending={pendingTokens}
            sharedVision={view.flags.sharedVision}
            visionCount={view.visionTokenIds.length}
          />
        ) : null}
        {selected ? (
          <CharacterCard
            token={selected}
            scene={scene}
            snap={snap}
            climbs={climbs}
            tool={tool}
          />
        ) : null}
      </div>

      {/* top-centre: status banners */}
      <div className="absolute inset-x-0 top-3 flex justify-center">
        <StatusBanners snap={snap} />
      </div>

      {/* centre: no character yet */}
      {mine.length === 0 ? (
        <div className="absolute inset-0 grid place-items-center p-6">
          <Empty
            className={cn("pointer-events-auto max-w-sm rounded-xl", glass)}
          >
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <UserRoundSearch />
              </EmptyMedia>
              <EmptyTitle>Waiting for the DM to assign a character</EmptyTitle>
              <EmptyDescription>
                You'll see the map through your character's eyes as soon as the
                DM gives you one. Hang tight.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : null}

      {/* bottom-centre: tools (the switch stays put; contextual actions dock to its right) */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2">
        <HudPanel className="flex items-center p-1">
          <ToolSwitch tool={tool} onTool={onTool} />
        </HudPanel>
        {climbs.length > 0 ? (
          <HudPanel className="absolute bottom-0 left-full ml-2 flex items-center gap-1 p-1">
            {climbs.map((c) => (
              <Button
                key={c.connectorId + c.toLevelId}
                size="sm"
                className="h-7 whitespace-nowrap"
                onClick={() => onClimb(c)}
                disabled={
                  view.flags.movementLocked ||
                  snap.status !== "live" ||
                  snap.networkOffline
                }
              >
                {c.direction === "up" ? (
                  <ArrowUpToLine data-icon="inline-start" />
                ) : (
                  <ArrowDownToLine data-icon="inline-start" />
                )}
                {climbLabel(c)}
                {c.toLevelName ? (
                  <span className="opacity-75">· {c.toLevelName}</span>
                ) : null}
              </Button>
            ))}
          </HudPanel>
        ) : null}
      </div>

      {/* bottom-right: camera */}
      <div className="absolute right-3 bottom-3 flex items-center gap-2">
        <CameraDock {...camera} />
        <HudPanel className="p-1">
          <ShortcutsButton />
        </HudPanel>
      </div>
    </div>
  )
}

function statusInfo(snap: PlayerClientSnapshot): {
  tone: "ok" | "warn" | "bad" | "off"
  label: string
  pulse: boolean
} {
  // The player's own connection is down: say so rather than blaming the DM.
  if (
    snap.networkOffline &&
    snap.status !== "ended" &&
    snap.status !== "kicked"
  )
    return { tone: "bad", label: "You're offline", pulse: true }
  switch (snap.status) {
    case "live":
      return snap.hostUnresponsive
        ? { tone: "warn", label: "DM not responding", pulse: true }
        : { tone: "ok", label: "Live", pulse: false }
    case "host-offline":
      return { tone: "off", label: "DM away", pulse: false }
    case "syncing":
      return { tone: "warn", label: "Syncing…", pulse: true }
    case "connecting":
      return { tone: "warn", label: "Reconnecting…", pulse: true }
    default:
      return { tone: "bad", label: "Disconnected", pulse: false }
  }
}

function SessionChip({ snap }: { snap: PlayerClientSnapshot }) {
  const [, navigate] = useLocation()
  const st = statusInfo(snap)
  const name = snap.view?.scene.name || "Untitled scene"
  return (
    <HudPanel className="flex h-11 items-center gap-2.5 pr-1 pl-2.5">
      <AppLogoMark className="size-5" />
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate font-heading text-[0.8125rem] font-medium">
          {name}
        </span>
        <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
          <StatusDot tone={st.tone} pulse={st.pulse} />
          {st.label}
        </span>
      </div>
      <HudButton
        label="Token maker (opens a new tab)"
        side="bottom"
        icon={<CircleUserRound />}
        onClick={() => openTokenMaker({ session: snap.sessionId })}
      />
      <HudButton
        label="Leave the table"
        side="bottom"
        icon={<LogOut />}
        onClick={() => navigate(paths.home())}
      />
    </HudPanel>
  )
}

function StatusBanners({ snap }: { snap: PlayerClientSnapshot }) {
  const locked = snap.view?.flags.movementLocked ?? false
  let main: React.ReactNode = null
  if (snap.networkOffline) {
    main = (
      <HudPanel className="flex items-center gap-2.5 px-3 py-2 text-xs">
        <WifiOff className="size-4 text-destructive" />
        <div className="flex flex-col">
          <span className="font-medium">You're offline, reconnecting…</span>
          <span className="text-[0.6875rem] text-muted-foreground">
            Check your connection. Moves resume when you're back online.
          </span>
        </div>
      </HudPanel>
    )
  } else if (snap.status === "host-offline") {
    main = (
      <HudPanel className="flex items-center gap-2.5 px-3 py-2 text-xs">
        <Hourglass className="size-4 text-muted-foreground" />
        <div className="flex flex-col">
          <span className="font-medium">Waiting for the DM…</span>
          <span className="text-[0.6875rem] text-muted-foreground">
            You can look around. Moves resume when the DM is back.
          </span>
        </div>
      </HudPanel>
    )
  } else if (snap.status === "connecting" || snap.status === "syncing") {
    main = (
      <HudPanel className="flex items-center gap-2 px-3 py-2 text-xs">
        <Spinner className="size-3.5" />{" "}
        {snap.status === "syncing" ? "Syncing with the DM…" : "Reconnecting…"}
      </HudPanel>
    )
  } else if (snap.status === "live" && snap.hostUnresponsive) {
    main = (
      <HudPanel className="flex items-center gap-2 px-3 py-2 text-xs">
        <WifiOff className="size-3.5 text-destructive" /> The DM isn't
        responding — your last move may not have arrived.
      </HudPanel>
    )
  }
  if (!main && !locked) return null
  return (
    <div className="flex flex-col items-center gap-2">
      {main}
      {locked ? (
        <HudPanel className="flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.6875rem] font-medium">
          <Lock className="size-3 text-sidebar-primary" /> Movement locked by
          the DM
        </HudPanel>
      ) : null}
    </div>
  )
}

function levelName(scene: SceneLike, levelId: Id): string {
  const l = Object.hasOwn(scene.levels, levelId) ? scene.levels[levelId] : null
  return l?.name || "Unknown level"
}

function PartyPanel({
  tokens,
  scene,
  selectedId,
  onSelect,
  pending,
  sharedVision,
  visionCount,
}: {
  tokens: Token[]
  scene: SceneLike
  selectedId: Id | null
  onSelect(id: Id): void
  pending: Set<Id>
  sharedVision: boolean
  visionCount: number
}) {
  return (
    <HudPanel className="flex flex-col p-1.5">
      <div className="flex items-center justify-between px-1.5 pt-0.5 pb-1.5">
        <span className="text-[0.6875rem] font-medium tracking-wide text-muted-foreground uppercase">
          Your characters
        </span>
        <span className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
          {tokens.length > 1 ? (
            <>
              <CommandKbd scope="play" command="token.next" /> to switch
            </>
          ) : null}
        </span>
      </div>
      <ScrollArea className={cn(tokens.length > 4 && "h-44")}>
        <div className="flex flex-col gap-0.5">
          {tokens.map((t) => {
            const active = t.id === selectedId
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onSelect(t.id)}
                aria-pressed={active}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/40",
                  active &&
                    "bg-primary/25 ring-1 ring-primary/50 hover:bg-primary/30"
                )}
              >
                <TokenAvatar token={t} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span
                    className={cn(
                      "truncate text-xs font-medium",
                      active && "font-semibold"
                    )}
                  >
                    {tokenDisplayName(t)}
                  </span>
                  <span className="truncate text-[0.6875rem] text-muted-foreground">
                    {levelName(scene, t.levelId)}
                  </span>
                </span>
                {pending.has(t.id) ? (
                  <Spinner className="size-3.5 text-muted-foreground" />
                ) : null}
              </button>
            )
          })}
        </div>
      </ScrollArea>
      {sharedVision && visionCount > tokens.length ? (
        <div className="mt-1 flex items-center gap-1.5 border-t px-1.5 pt-1.5 text-[0.6875rem] text-muted-foreground">
          <Users className="size-3" /> Party vision: seeing through{" "}
          {visionCount} characters
        </div>
      ) : null}
    </HudPanel>
  )
}

/** "Climb up" for ladders, "Go up" for stairs and ramps. */
function climbLabel(c: ClimbOption): string {
  return `${c.style === "ladder" ? "Climb" : "Go"} ${c.direction}`
}

function cardHint(tool: PlayTool, climbs: ClimbOption[]): string {
  if (tool === "measure")
    return "Measuring: press and drag from a point to measure. Hold Shift when you press to add another leg. Esc clears it."
  if (climbs.length > 0) {
    const where = climbs.every((c) => c.style === "ladder")
      ? "Standing on a ladder"
      : "At the stairs"
    const moves = climbs
      .map((c) =>
        c.toLevelName ? `${c.direction} to ${c.toLevelName}` : c.direction
      )
      .join(" or ")
    return `${where}: go ${moves} with the button below.`
  }
  return "Drag your token to move. Click a door next to you to open or close it."
}

function CharacterCard({
  token,
  scene,
  snap,
  climbs,
  tool,
}: {
  token: Token
  scene: SceneLike
  snap: PlayerClientSnapshot
  climbs: ClimbOption[]
  tool: PlayTool
}) {
  const view = snap.view!
  const pt = Object.hasOwn(view.tokens, token.id) ? view.tokens[token.id] : null
  const senses = describeSenses(pt?.vision)
  const speed = pt?.speed ?? token.speed
  return (
    <HudPanel className="flex flex-col gap-2.5 p-3">
      <div className="flex items-center gap-2.5">
        <TokenAvatar token={token} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate font-heading text-sm font-medium">
            {tokenDisplayName(token)}
          </span>
          <span className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
            <Layers className="size-3" /> {levelName(scene, token.levelId)}
          </span>
        </div>
        <HudButton
          label="Make this character's token (opens a new tab)"
          side="bottom"
          icon={<CircleUserRound />}
          onClick={() =>
            openTokenMaker({ session: snap.sessionId, token: token.id })
          }
        />
      </div>
      <div className="flex flex-wrap gap-1">
        {senses.map((s) => (
          <Badge
            key={s.label}
            variant={s.kind === "normal" ? "outline" : "secondary"}
            className="gap-1"
          >
            <Eye /> {s.label}
          </Badge>
        ))}
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge variant="outline" className="cursor-default gap-1" />
            }
          >
            <Footprints /> {speed > 0 ? formatFeet(speed) : "—"}
          </TooltipTrigger>
          <TooltipContent>
            {view.flags.enforceSpeed
              ? "Speed per move (enforced by the DM)"
              : "Walking speed (not enforced)"}
          </TooltipContent>
        </Tooltip>
      </div>
      <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
        {cardHint(tool, climbs)}
      </p>
    </HudPanel>
  )
}
