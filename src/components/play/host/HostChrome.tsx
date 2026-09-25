/**
 * The scene screen's top bar (ARCHITECTURE §6.8): back to the world, the menus, the scene's name, the
 * Edit / Play switch (Tab), undo / redo in Edit or vision preview in Play, the Token Maker, Change scene,
 * the side panel and the table's doors (open / close); and the bottom status bar (host pipeline stats,
 * save state, frame rate).
 */
import * as React from "react"
import { useStore } from "zustand"
import {
  Activity,
  ChevronDown,
  CircleUserRound,
  Copy,
  Cpu,
  DoorClosed,
  DoorOpen,
  Gauge,
  Hammer,
  Link2,
  Map as MapIcon,
  PanelRight,
  PanelRightClose,
  Play,
  Radio,
  Save,
  ScanEye,
  Send,
} from "lucide-react"

import { copyText } from "@/app/clipboard"
import { withModeParam } from "@/app/mode"
import { inviteLink } from "@/app/roomCodeInput"
import { openTokenMaker } from "@/app/routes"
import { AppLogoMark } from "@/components/app/AppLogo"
import { QualitySelect } from "@/components/canvas/QualitySelect"
import type { QualityChoice } from "@/components/canvas/qualityChoice"
import { ModeBadge } from "@/components/app/ModeBadge"
import {
  EditorMenus,
  SceneName,
  UndoRedo,
  type MenuDocument,
} from "@/components/editor/MenuBar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CommandKbd } from "@/components/keybindings/CommandKbd"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { HostSnapshot } from "@/net/host"
import { formatRoomCode } from "@/net/sessionsRepo"
import type { FrameStats } from "@/render/contracts"
import type { StoreApi } from "zustand/vanilla"

import { StatusDot } from "../hud"

export type HostMode = "play" | "edit"

export function HostTopBar({
  snap,
  sceneName,
  mode,
  onMode,
  menus,
  doc,
  previewing,
  onPreview,
  sidebar,
  onSidebar,
  onLeave,
  onChangeMap,
  savingMap,
  onOpenTable,
  onCloseTable,
}: {
  snap: HostSnapshot
  sceneName: string
  mode: HostMode
  onMode(m: HostMode): void
  /** The editor contexts are ready (menus, undo / redo). */
  menus: boolean
  doc: MenuDocument & { rename(name: string): void }
  previewing: boolean
  onPreview(): void
  sidebar: boolean
  onSidebar(open: boolean): void
  /** Back to the world's page (the table stays as it is). */
  onLeave(): void
  /** Open the Change scene dialog. */
  onChangeMap(): void
  /** A restore point is being saved (Change scene waits for it). */
  savingMap: boolean
  onOpenTable(): Promise<void>
  onCloseTable(): void
}) {
  const hosting = snap.status === "hosting"
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-card/60 px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Back to the world"
                onClick={onLeave}
              />
            }
          >
            <AppLogoMark className="size-5" />
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {snap.world ? `Back to ${snap.world.name}` : "Back to your worlds"}
          </TooltipContent>
        </Tooltip>
        {menus ? <EditorMenus doc={doc} mode={mode} /> : null}
        <Separator orientation="vertical" className="mx-1 h-5 self-center" />
        <SceneName
          name={sceneName}
          disabled={!hosting || !menus}
          onRename={doc.rename}
        />
        <ModeBadge className="ml-1" />
      </div>
      <ModeSwitch mode={mode} onMode={onMode} disabled={!hosting || !menus} />
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
        {mode === "edit" ? (
          menus ? (
            <UndoRedo disabled={!hosting} />
          ) : null
        ) : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant={previewing ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={previewing}
                  onClick={onPreview}
                  className={cn(previewing && "text-sidebar-primary")}
                />
              }
            >
              <ScanEye data-icon="inline-start" /> Preview vision
            </TooltipTrigger>
            <TooltipContent side="bottom">
              See what the selected token (or the first PC) perceives{" "}
              <CommandKbd scope="play" command="preview-vision" />
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label="Token maker"
                onClick={() => openTokenMaker({ session: snap.sessionId })}
              />
            }
          >
            <CircleUserRound />
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-64">
            Token maker: make token art in a new tab and put it on any token of
            this scene
          </TooltipContent>
        </Tooltip>
        <ChangeMapButton
          hosting={hosting}
          saving={savingMap}
          onClick={onChangeMap}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={
                  sidebar ? "Hide the side panel" : "Show the side panel"
                }
                onClick={() => onSidebar(!sidebar)}
              />
            }
          >
            {sidebar ? <PanelRightClose /> : <PanelRight />}
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {sidebar ? "Hide the side panel" : "Show the side panel"}
          </TooltipContent>
        </Tooltip>
        <Separator orientation="vertical" className="mx-1 h-5 self-center" />
        <TableDoors snap={snap} onOpen={onOpenTable} onClose={onCloseTable} />
      </div>
    </header>
  )
}

/** Edit / Play: two views of the same scene; Tab switches. */
function ModeSwitch({
  mode,
  onMode,
  disabled,
}: {
  mode: HostMode
  onMode(m: HostMode): void
  disabled: boolean
}) {
  const item =
    "h-7 gap-1.5 px-3 text-xs aria-pressed:bg-background aria-pressed:shadow-sm data-[pressed]:bg-background"
  return (
    <ToggleGroup
      value={[mode]}
      onValueChange={(v) => {
        const next = v[0] as HostMode | undefined
        if (next) onMode(next)
      }}
      className="shrink-0 rounded-lg bg-muted p-0.5"
      spacing={1}
      aria-label="Edit or play the scene"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <ToggleGroupItem
              value="edit"
              aria-label="Edit"
              disabled={disabled}
              className={item}
            />
          }
        >
          <Hammer className="size-3.5" /> Edit
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-64">
          Build the scene: walls, doors, lights, levels, terrain, tokens{" "}
          <CommandKbd scope="play" command="mode.edit" />
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <ToggleGroupItem
              value="play"
              aria-label="Play"
              disabled={disabled}
              className={item}
            />
          }
        >
          <Play className="size-3.5" /> Play
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-64">
          Run the scene: move tokens, open doors, preview vision, combat{" "}
          <CommandKbd scope="editor" command="mode.play" />
        </TooltipContent>
      </Tooltip>
    </ToggleGroup>
  )
}

/**
 * The table's doors: "Open the table" lets players in with the room code; once open, the room code and
 * "Close the table" (players are disconnected, the DM stays).
 */
function TableDoors({
  snap,
  onOpen,
  onClose,
}: {
  snap: HostSnapshot
  onOpen(): Promise<void>
  onClose(): void
}) {
  const [opening, setOpening] = React.useState(false)
  const hosting = snap.status === "hosting"
  const code = formatRoomCode(snap.roomCode)
  if (!snap.tableOpen || !hosting)
    return (
      <Tooltip>
        {/* The span keeps the tooltip working while the button is disabled. */}
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            size="sm"
            disabled={!hosting || opening}
            onClick={() => {
              setOpening(true)
              void onOpen().finally(() => setOpening(false))
            }}
          >
            {opening ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <DoorOpen data-icon="inline-start" />
            )}
            Open the table
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-64">
          {hosting
            ? "Let players in with the room code. You keep editing and playing as before."
            : "This tab isn't running the table."}
        </TooltipContent>
      </Tooltip>
    )
  const invite = () =>
    void copyText(
      inviteLink(window.location.origin, snap.roomCode, withModeParam("")),
      "Invite link"
    )
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={`Table open, room code ${code}`}
          />
        }
      >
        <StatusDot tone="ok" pulse />
        Table open
        <span className="font-mono tracking-wider text-muted-foreground">
          {code}
        </span>
        <ChevronDown data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Players join with {code}</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => void copyText(code, "Room code")}>
            <Copy /> Copy the room code
          </DropdownMenuItem>
          <DropdownMenuItem onClick={invite}>
            <Link2 /> Copy the invite link
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onClose}>
          <DoorClosed /> Close the table…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** "Change scene": disabled (with the reason as its tooltip) unless hosting with no restore point being saved. */
function ChangeMapButton({
  hosting,
  saving,
  onClick,
}: {
  hosting: boolean
  saving: boolean
  onClick(): void
}) {
  const reason = !hosting
    ? "This tab isn't running the table."
    : saving
      ? "Saving a restore point…"
      : null
  return (
    <Tooltip>
      {/* The span keeps the tooltip working while the button is disabled. */}
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Button
          variant="ghost"
          size="sm"
          disabled={reason !== null}
          onClick={onClick}
        >
          <MapIcon data-icon="inline-start" /> Change scene
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">
        {reason ??
          "Move the table to another scene of this world and bring the party along"}
      </TooltipContent>
    </Tooltip>
  )
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 5) return "just now"
  if (s < 60) return `${s}s ago`
  return `${Math.round(s / 60)}m ago`
}

function Stat({
  icon,
  children,
  tooltip,
}: {
  icon: React.ReactNode
  children: React.ReactNode
  tooltip: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="flex cursor-default items-center gap-1.5 whitespace-nowrap tabular-nums" />
        }
      >
        {icon}
        {children}
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

export function HostStatusBar({
  snap,
  frame,
  quality,
  onQuality,
  edit,
}: {
  snap: HostSnapshot
  frame: StoreApi<{ stats: FrameStats | null }>
  /** In Edit: the editor's readouts (cursor, level, snap, selection) in place of the table's stats. */
  edit?: React.ReactNode
  quality: QualityChoice
  onQuality(q: QualityChoice): void
}) {
  const stats = snap.stats
  const fs = useStore(frame, (s) => s.stats)
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(t)
  }, [])
  const online = snap.members.filter(
    (m) => m.status === "active" && m.online
  ).length
  const linked = snap.members.filter(
    (m) => m.status === "active" && m.linked
  ).length
  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t bg-card/60 px-3 text-[0.6875rem] text-muted-foreground">
      {edit ?? (
        <>
          <Stat
            icon={<Radio className="size-3" />}
            tooltip="Players online / connected to this host"
          >
            {online} online · {linked} linked
          </Stat>
          <Separator orientation="vertical" className="h-3.5 self-center" />
          <Stat
            icon={<Cpu className="size-3" />}
            tooltip="Last vision computation in the worker, and the last per-player filter + diff + send pass"
          >
            vision {stats.visionMs.toFixed(1)} ms · flush{" "}
            {stats.flushMs.toFixed(1)} ms
          </Stat>
          <Separator orientation="vertical" className="h-3.5 self-center" />
          <Stat
            icon={<Send className="size-3" />}
            tooltip="Messages and bytes sent to players (pending sends in brackets)"
          >
            {stats.messagesSent} msgs · {(stats.bytesSent / 1024).toFixed(0)} KB
            {stats.pendingSends > 0 ? ` (${stats.pendingSends} pending)` : ""}
          </Stat>
          <Separator orientation="vertical" className="h-3.5 self-center" />
          <Stat
            icon={<Save className="size-3" />}
            tooltip="The session state is saved automatically (fenced by the host epoch)"
          >
            {stats.lastSaveAt
              ? `saved ${ago(now - stats.lastSaveAt)}`
              : "not saved yet"}
          </Stat>
        </>
      )}
      <div className="flex-1" />
      {snap.epoch ? (
        <Badge
          variant="outline"
          className="h-4 font-mono text-[0.625rem] font-normal"
        >
          epoch {snap.epoch.split(".")[0]}
        </Badge>
      ) : null}
      <Stat
        icon={<Activity className="size-3" />}
        tooltip={
          fs
            ? `p95 ${fs.frameMsP95.toFixed(1)} ms · ${fs.drawCalls} draws · ${fs.activeLights} lights · quality ${fs.quality}`
            : "Renderer starting"
        }
      >
        <span
          className={cn(
            fs && fs.frameMsP95 > 18 ? "text-destructive" : "text-foreground/80"
          )}
        >
          {fs ? `${Math.round(fs.fps)} fps` : "—"}
        </span>
      </Stat>
      <Separator orientation="vertical" className="h-3.5 self-center" />
      <div className="flex items-center gap-1.5">
        <Gauge className="size-3" />
        <QualitySelect
          value={quality}
          onValueChange={onQuality}
          current={fs?.quality}
          className="h-5 gap-1 border-none bg-transparent px-1 text-[0.6875rem] dark:bg-transparent"
          itemClassName="text-xs"
        />
      </div>
    </footer>
  )
}
