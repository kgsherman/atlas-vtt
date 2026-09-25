/**
 * The Edit side of the map screen's status bar: the cell and point under the cursor, the active level,
 * the snap mode and the selection. Needs the editor context.
 */
import * as React from "react"
import { Crosshair, Layers, MousePointerClick } from "lucide-react"
import { useStore } from "zustand"

import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

import { useEditorState } from "./context"
import { formatElevation, trimNumber } from "./lib/format"
import { selectionCount } from "./lib/terrainMode"
import type { CursorStore } from "./lib/viewportInfo"

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

function CursorReadout({ cursor: store }: { cursor: CursorStore }) {
  const cursor = useStore(store, (s) => s.cursor)
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

export function EditStatusItems({ cursor }: { cursor: CursorStore }) {
  const level = useEditorState((s) => (Object.hasOwn(s.scene.levels, s.activeLevelId) ? s.scene.levels[s.activeLevelId] : null))
  const snap = useEditorState((s) => (s.altHeld ? "free" : s.snapMode))
  const selected = useEditorState(selectionCount)
  const terrain = useEditorState((s) => s.tool === "terrain")
  return (
    <>
      <CursorReadout cursor={cursor} />
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
    </>
  )
}
