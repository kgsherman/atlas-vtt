/**
 * The DM console's top bar (scene, hosting status, play/edit switch, vision preview, sidebar, end
 * session) and bottom status bar (host pipeline stats, save state, frame rate).
 */
import * as React from "react"
import { useStore } from "zustand"
import {
  Activity,
  Cpu,
  DoorClosed,
  Hammer,
  PanelRight,
  PanelRightClose,
  Play,
  Radio,
  Save,
  ScanEye,
  Send,
} from "lucide-react"
import { useLocation } from "wouter"

import { paths } from "@/app/routes"
import { AppLogoMark } from "@/components/app/AppLogo"
import { ModeBadge } from "@/components/app/ModeBadge"
import { useConfirm } from "@/components/editor/context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { HostSnapshot } from "@/net/host"
import type { FrameStats } from "@/render/contracts"
import type { StoreApi } from "zustand/vanilla"

import { StatusDot } from "../hud"

export type HostMode = "play" | "edit"

function hostStatus(snap: HostSnapshot): {
  tone: "ok" | "warn" | "bad" | "off"
  label: string
} {
  switch (snap.status) {
    case "hosting":
      return { tone: "ok", label: "Hosting" }
    case "starting":
      return { tone: "warn", label: "Starting…" }
    case "standby":
      return { tone: "off", label: "Standby" }
    case "ended":
      return { tone: "off", label: "Ended" }
    default:
      return { tone: "bad", label: "Error" }
  }
}

export function HostTopBar({
  snap,
  sceneName,
  mode,
  onMode,
  previewing,
  onPreview,
  sidebar,
  onSidebar,
  onEnd,
}: {
  snap: HostSnapshot
  sceneName: string
  mode: HostMode
  onMode(m: HostMode): void
  previewing: boolean
  onPreview(): void
  sidebar: boolean
  onSidebar(open: boolean): void
  onEnd(): void
}) {
  const [, navigate] = useLocation()
  const confirm = useConfirm()
  const st = hostStatus(snap)
  const hosting = snap.status === "hosting"
  const leave = async () => {
    if (hosting) {
      const ok = await confirm({
        title: "Leave the table?",
        description:
          "The session stays open: players keep their view and wait for you. Come back from the home page to resume.",
        confirmLabel: "Leave",
      })
      if (!ok) return
    }
    navigate(paths.home())
  }
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b bg-card/60 px-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Leave the table"
              onClick={() => void leave()}
            />
          }
        >
          <AppLogoMark className="size-5" />
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Leave the table (the session stays open)
        </TooltipContent>
      </Tooltip>
      <div className="flex min-w-0 flex-col leading-tight">
        <span className="truncate font-heading text-[0.8125rem] font-medium">
          {sceneName || "Untitled scene"}
        </span>
        <span className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
          <StatusDot tone={st.tone} pulse={snap.status === "starting"} />{" "}
          {st.label}
          {snap.status === "hosting" ? (
            <span className="text-muted-foreground/70">· live session</span>
          ) : null}
        </span>
      </div>
      <ModeBadge className="ml-1" />
      <div className="flex flex-1 justify-center">
        <ToggleGroup
          value={[mode]}
          onValueChange={(v) => {
            const next = v[0] as HostMode | undefined
            if (next) onMode(next)
          }}
          className="rounded-lg bg-muted p-0.5"
          spacing={1}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <ToggleGroupItem
                  value="play"
                  aria-label="Run the table"
                  className="h-7 gap-1.5 px-3 text-xs aria-pressed:bg-background aria-pressed:shadow-sm data-[pressed]:bg-background"
                />
              }
            >
              <Play className="size-3.5" /> Play
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Run the table: move tokens, doors, lights, vision previews
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <ToggleGroupItem
                  value="edit"
                  aria-label="Edit map"
                  disabled={!hosting}
                  className="h-7 gap-1.5 px-3 text-xs aria-pressed:bg-background aria-pressed:shadow-sm data-[pressed]:bg-background"
                />
              }
            >
              <Hammer className="size-3.5" /> Edit map
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Full editor tools on the live map — players see changes as they
              explore
            </TooltipContent>
          </Tooltip>
        </ToggleGroup>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={previewing ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={previewing}
              onClick={onPreview}
              disabled={mode === "edit"}
              className={cn(previewing && "text-sidebar-primary")}
            />
          }
        >
          <ScanEye data-icon="inline-start" /> Preview vision
        </TooltipTrigger>
        <TooltipContent side="bottom">
          See what the selected token (or the first PC) perceives <Kbd>V</Kbd>
        </TooltipContent>
      </Tooltip>
      <Separator orientation="vertical" className="mx-1 h-5 self-center" />
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
      <Button
        variant="destructive"
        size="sm"
        onClick={onEnd}
        disabled={snap.status === "ended"}
      >
        <DoorClosed data-icon="inline-start" /> End session
      </Button>
    </header>
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
}: {
  snap: HostSnapshot
  frame: StoreApi<{ stats: FrameStats | null }>
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
        vision {stats.visionMs.toFixed(1)} ms · flush {stats.flushMs.toFixed(1)}{" "}
        ms
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
        {fs ? <span>{fs.quality}</span> : null}
      </Stat>
    </footer>
  )
}
