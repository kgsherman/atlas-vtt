import * as React from "react"
import { Activity, Crosshair, Gauge, Layers, MousePointerClick } from "lucide-react"
import { useStore } from "zustand"

import { QualitySelect } from "@/components/canvas/QualitySelect"
import type { QualityChoice } from "@/components/canvas/qualityChoice"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { Quality } from "@/render/contracts"
import { cn } from "@/lib/utils"

import { useEditorState } from "./context"
import { formatElevation, trimNumber } from "./lib/format"
import { selectionCount } from "./lib/terrainMode"
import type { ViewportInfoStore } from "./lib/viewportInfo"

export type { QualityChoice }

const SNAP_LABELS = { center: "Cell centre", vertex: "Vertex", half: "Half cell", free: "Free" } as const

function Item({ icon, children, tooltip, className }: { icon?: React.ReactNode; children: React.ReactNode; tooltip?: string; className?: string }) {
  const body = (
    <span className={cn("flex items-center gap-1.5 whitespace-nowrap", className)}>
      {icon}
      {children}
    </span>
  )
  if (!tooltip) return body
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex cursor-default items-center" />}>{body}</TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  )
}

const AXIS_LABEL = { x: "text-axis-x/70", z: "text-axis-z/70", y: "text-axis-y/70" } as const

function Axis({ axis, value }: { axis: keyof typeof AXIS_LABEL; value: number }) {
  return (
    <span className="flex min-w-12 items-baseline gap-1">
      <span className={cn("font-medium", AXIS_LABEL[axis])}>{axis.toUpperCase()}</span>
      <span className="text-foreground/80">{trimNumber(value, 1)}</span>
    </span>
  )
}

function CursorReadout({ info }: { info: ViewportInfoStore }) {
  const cursor = useStore(info, (s) => s.cursor)
  return (
    <>
      <Item icon={<Crosshair className="size-3" />} tooltip="Cell (column, row) under the cursor" className="w-16 tabular-nums">
        {cursor ? (
          <span className={cn(!cursor.inside && "text-destructive")}>
            {cursor.i}, {cursor.j}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </Item>
      <Item tooltip="Position under the cursor in feet (Y: height above the level's ground)" className="w-52 gap-2 tabular-nums">
        {cursor ? (
          <>
            <Axis axis="x" value={cursor.x} />
            <Axis axis="z" value={cursor.z} />
            <Axis axis="y" value={cursor.y} />
            <span className="text-muted-foreground">ft</span>
          </>
        ) : null}
      </Item>
    </>
  )
}

function FrameReadout({ info }: { info: ViewportInfoStore }) {
  const stats = useStore(info, (s) => s.stats)
  if (!stats) return <span className="text-muted-foreground">Starting renderer…</span>
  const slow = stats.frameMsP95 > 18
  return (
    <Item
      icon={<Activity className="size-3" />}
      tooltip={`Frame ${trimNumber(stats.frameMs, 1)} ms · ${stats.drawCalls} draws · ${Math.round(stats.triangles / 1000)}k tris · ${stats.activeLights} lights · shadow tiles ${stats.shadowTilesUpdated}/${stats.shadowTilesTotal} · px ratio ${trimNumber(stats.pixelRatio, 2)}`}
      className="tabular-nums"
    >
      <span className={cn(slow ? "text-destructive" : "text-foreground/80")}>{Math.round(stats.fps)} fps</span>
      <span className="text-muted-foreground">p95 {trimNumber(stats.frameMsP95, 1)} ms</span>
      <span className="text-muted-foreground">{stats.drawCalls} draws</span>
    </Item>
  )
}

export function StatusBar({
  info,
  quality,
  onQualityChange,
  actualQuality,
}: {
  info: ViewportInfoStore
  quality: QualityChoice
  onQualityChange(q: QualityChoice): void
  actualQuality?: Quality | null
}) {
  const level = useEditorState((s) => (Object.hasOwn(s.scene.levels, s.activeLevelId) ? s.scene.levels[s.activeLevelId] : null))
  const snap = useEditorState((s) => (s.altHeld ? "free" : s.snapMode))
  const selected = useEditorState(selectionCount)
  const terrain = useEditorState((s) => s.tool === "terrain")
  const stats = useStore(info, (s) => s.stats)

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t bg-card/60 px-3 text-[0.6875rem] text-muted-foreground">
      <CursorReadout info={info} />
      <Separator orientation="vertical" className="h-3.5 self-center" />
      <Item icon={<Layers className="size-3" />} tooltip="Active level (PageUp / PageDown)">
        <span className="max-w-40 truncate text-foreground/80">{level?.name ?? "—"}</span>
        {level ? <span>{formatElevation(level.elevation)}</span> : null}
      </Item>
      <Separator orientation="vertical" className="h-3.5 self-center" />
      <Item tooltip="Snap mode (hold Alt for free placement)">Snap: {SNAP_LABELS[snap]}</Item>
      {selected > 0 ? (
        <>
          <Separator orientation="vertical" className="h-3.5 self-center" />
          <Item icon={<MousePointerClick className="size-3" />}>
            {terrain ? `${selected} shape${selected === 1 ? "" : "s"} selected` : `${selected} selected`}
          </Item>
        </>
      ) : null}
      <div className="flex-1" />
      <FrameReadout info={info} />
      <Separator orientation="vertical" className="h-3.5 self-center" />
      <div className="flex items-center gap-1.5">
        <Gauge className="size-3" />
        <QualitySelect
          value={quality}
          onValueChange={onQualityChange}
          current={stats?.quality ?? actualQuality}
          className="h-5 gap-1 border-none bg-transparent px-1 text-[0.6875rem] dark:bg-transparent"
          itemClassName="text-xs"
        />
      </div>
    </footer>
  )
}
