/**
 * HTML chrome floating over the map screen's viewport in Edit: level switcher, camera controls and a
 * first-steps hint.
 */
import * as React from "react"
import {
  Box,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronUp,
  Eye,
  EyeOff,
  ImagePlus,
  Keyboard,
  Map as MapIcon,
  Maximize,
  MoonStar,
  X,
} from "lucide-react"

import { CommandKbd } from "@/components/keybindings/CommandKbd"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { adjacentLevels, sortedLevels } from "@/core/scene/queries"
import { cn } from "@/lib/utils"

import { useEditorActions, useEditorContext, useEditorShallow, useEditorState } from "./context"
import { formatElevation } from "./lib/format"
import { axisTicks, levelAxisBounds, minorTicks, spreadLabels } from "./lib/levelAxis"

const glass = "border bg-card/85 shadow-lg shadow-black/20 backdrop-blur-md"

/** Record has at most n own keys (stops counting early: cheap on 20k-object scenes). */
function atMost(record: object, n: number): boolean {
  let k = 0
  for (const key in record) {
    if (Object.hasOwn(record, key) && ++k > n) return false
  }
  return true
}

const AXIS_OPEN_KEY = "atlas-editor:level-axis"

function readAxisOpen(): boolean {
  try {
    return localStorage.getItem(AXIS_OPEN_KEY) !== "closed"
  } catch {
    return true
  }
}

function writeAxisOpen(open: boolean): void {
  try {
    localStorage.setItem(AXIS_OPEN_KEY, open ? "open" : "closed")
  } catch {
    // Storage blocked: not remembered.
  }
}

export function LevelSwitcher() {
  const { store } = useEditorContext()
  const [open, setOpen] = React.useState(readAxisOpen)
  const { level, above, below } = useEditorShallow((s) => {
    const level = Object.hasOwn(s.scene.levels, s.activeLevelId) ? s.scene.levels[s.activeLevelId] : null
    const adj = level ? adjacentLevels(s.scene, level.id) : {}
    return { level, above: adj.above ?? null, below: adj.below ?? null }
  })
  if (!level) return null
  return (
    <Collapsible
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        writeAxisOpen(next)
      }}
      className={cn("pointer-events-auto flex flex-col rounded-lg p-1", glass, "bg-card/75")}
    >
      <div className="flex items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <CollapsibleTrigger
                render={
                  <Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={open ? "Hide the level axis" : "Show the level axis"} />
                }
              />
            }
          >
            {open ? <ChevronsDownUp /> : <ChevronsUpDown />}
          </TooltipTrigger>
          <TooltipContent side="bottom">{open ? "Hide the level axis" : "Show the level axis"}</TooltipContent>
        </Tooltip>
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="max-w-48 truncate text-xs font-medium">{level.name}</span>
          <span className="text-[0.625rem] text-muted-foreground">{formatElevation(level.elevation)}</span>
        </div>
        <ButtonGroup orientation="vertical" className="ml-1">
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon-xs" aria-label="Level above" disabled={!above} onClick={() => store.getState().stepActiveLevel(1)} />}
            >
              <ChevronUp />
            </TooltipTrigger>
            <TooltipContent side="right">
              {above ? `Up to ${above.name}` : "No level above"} <CommandKbd scope="editor" command="level.up" />
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon-xs" aria-label="Level below" disabled={!below} onClick={() => store.getState().stepActiveLevel(-1)} />}
            >
              <ChevronDown />
            </TooltipTrigger>
            <TooltipContent side="right">
              {below ? `Down to ${below.name}` : "No level below"} <CommandKbd scope="editor" command="level.down" />
            </TooltipContent>
          </Tooltip>
        </ButtonGroup>
      </div>
      <CollapsibleContent className="max-h-[60vh] overflow-y-auto">
        <LevelAxis />
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Pixel layout of the level axis: label pitch, top/bottom padding, least height, axis and label x. */
const AXIS = { row: 30, pad: 16, minHeight: 200, x: 30, labelX: 54, width: 212 }

/**
 * Every level as a point on a vertical elevation axis, with a label (visibility eye + name) leading off
 * to the right. Labels keep to their level's height where they can and are pushed apart where levels
 * crowd (see `spreadLabels`). It sits on the switcher's glass card, so it reads over any map.
 */
function LevelAxis() {
  const { store } = useEditorContext()
  const { levels, activeLevelId, visibility } = useEditorShallow((s) => ({
    levels: s.scene.levels,
    activeLevelId: s.activeLevelId,
    visibility: s.view.levelVisibility,
  }))
  const { height, top, bottom, ticks, minor, rows } = React.useMemo(() => {
    const ordered = sortedLevels({ levels })
    const { lo, hi } = levelAxisBounds(ordered.map((l) => l.elevation))
    const height = Math.max(AXIS.minHeight, (ordered.length - 1) * AXIS.row + 2 * AXIS.pad)
    // Height above the axis' bottom end, in px (labels are laid out bottom-up, like elevations).
    const up = (e: number) => ((e - lo) / (hi - lo)) * (height - 2 * AXIS.pad)
    const labels = spreadLabels(
      ordered.map((l) => up(l.elevation)),
      AXIS.row,
      0,
      height - 2 * AXIS.pad
    )
    const y = (u: number) => height - AXIS.pad - u
    const major = axisTicks(lo, hi)
    return {
      height,
      top: y(up(hi)),
      bottom: y(0),
      ticks: major.map((v) => ({ v, y: y(up(v)) })),
      minor: minorTicks(lo, hi, major, (height - 2 * AXIS.pad) / (hi - lo)).map((v) => y(up(v))),
      rows: ordered.map((level, i) => ({ level, y: y(up(level.elevation)), labelY: y(labels[i]) })),
    }
  }, [levels])

  return (
    <div className="relative mt-1 border-t" style={{ height, width: AXIS.width }}>
      <svg className="absolute inset-0 size-full" aria-hidden>
        <line x1={AXIS.x} x2={AXIS.x} y1={top} y2={bottom} className="stroke-muted-foreground/60" />
        {minor.map((my) => (
          <line key={my} x1={AXIS.x - 2} x2={AXIS.x} y1={my} y2={my} className="stroke-muted-foreground/40" />
        ))}
        {ticks.map((t) => (
          <g key={t.v}>
            <line x1={AXIS.x - 4} x2={AXIS.x} y1={t.y} y2={t.y} className="stroke-muted-foreground/60" />
            <text x={AXIS.x - 6} y={t.y} dominantBaseline="middle" textAnchor="end" className="fill-muted-foreground text-[0.5625rem] tabular-nums">
              {t.v < 0 ? `−${-t.v}` : t.v}
            </text>
          </g>
        ))}
        {rows.map(({ level, y, labelY }) => (
          <path
            key={level.id}
            d={`M${AXIS.x} ${y} H${AXIS.x + 6} L${AXIS.labelX - 6} ${labelY} H${AXIS.labelX}`}
            fill="none"
            className={level.id === activeLevelId ? "stroke-primary" : "stroke-muted-foreground/60"}
          />
        ))}
        {rows.map(({ level, y }) => (
          <circle
            key={level.id}
            cx={AXIS.x}
            cy={y}
            r={level.id === activeLevelId ? 3.5 : 2.5}
            className={level.id === activeLevelId ? "fill-primary" : "fill-foreground"}
          />
        ))}
      </svg>
      {rows.map(({ level, labelY }) => {
        const active = level.id === activeLevelId
        const visible = visibility[level.id] !== false
        return (
          <ButtonGroup key={level.id} className="absolute -translate-y-1/2" style={{ top: labelY, left: AXIS.labelX }}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label={visible ? `Hide ${level.name}` : `Show ${level.name}`}
                    className={cn("text-muted-foreground", !visible && "text-muted-foreground/50")}
                    onClick={() => store.getState().toggleLevelVisibility(level.id)}
                  />
                }
              >
                {visible ? <Eye /> : <EyeOff />}
              </TooltipTrigger>
              <TooltipContent side="right">{visible ? "Hide in the editor" : "Show in the editor"}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={active ? "selected" : "outline"}
                    size="sm"
                    aria-pressed={active}
                    className="h-7 max-w-32 justify-start"
                    onClick={() => store.getState().setActiveLevel(level.id)}
                  />
                }
              >
                <span className={cn("truncate", !visible && !active && "opacity-50")}>{level.name}</span>
              </TooltipTrigger>
              <TooltipContent side="right">{formatElevation(level.elevation)}</TooltipContent>
            </Tooltip>
          </ButtonGroup>
        )
      })}
    </div>
  )
}

export function CameraControls() {
  const { store } = useEditorContext()
  const actions = useEditorActions()
  const camera = useEditorState((s) => s.view.camera)
  const darkVision = useEditorState((s) => s.view.darkVision)
  return (
    <div className={cn("pointer-events-auto flex items-center gap-0.5 rounded-lg p-1", glass)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={camera === "orbit" ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label="3D orbit camera"
              onClick={() => store.getState().setView({ camera: "orbit" })}
            />
          }
        >
          <Box />
        </TooltipTrigger>
        <TooltipContent side="bottom">3D orbit (right-drag orbits, middle-drag pans)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={camera === "topdown" ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label="Top-down camera"
              onClick={() => store.getState().setView({ camera: "topdown" })}
            />
          }
        >
          <MapIcon />
        </TooltipTrigger>
        <TooltipContent side="bottom">Top-down</TooltipContent>
      </Tooltip>
      <div className="mx-0.5 h-4 w-px bg-border" />
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Frame the scene" onClick={actions.frameScene} />}>
          <Maximize />
        </TooltipTrigger>
        <TooltipContent side="bottom">Frame the scene</TooltipContent>
      </Tooltip>
      <div className="mx-0.5 h-4 w-px bg-border" />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant={darkVision ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={darkVision}
              onClick={() => store.getState().toggleDarkVision()}
            />
          }
        >
          <MoonStar /> Dark Vision
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Dark vision {darkVision ? "on" : "off"}: see dark areas while you build (what it lifts is tinted blue and striped){" "}
          <CommandKbd scope="editor" command="toggle-dark-vision" />
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/** First steps for a (nearly) empty scene. */
export function GettingStarted() {
  const actions = useEditorActions()
  const { store } = useEditorContext()
  const empty = useEditorState((s) => atMost(s.scene.objects, 1) && atMost(s.scene.tokens, 0) && !Object.values(s.scene.levels).some((l) => l.backdrop))
  const readOnly = useEditorState((s) => s.readOnly)
  const [dismissed, setDismissed] = React.useState(false)
  if (!empty || dismissed || readOnly) return null
  return (
    <div className={cn("pointer-events-auto flex w-80 flex-col gap-2 rounded-lg p-3", glass)}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs font-medium">Start building</div>
        <Button variant="ghost" size="icon-xs" aria-label="Dismiss" onClick={() => setDismissed(true)}>
          <X />
        </Button>
      </div>
      <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">
        Draw walls <CommandKbd scope="editor" command="tool.wall" />, add doors <CommandKbd scope="editor" command="tool.door" /> and windows{" "}
        <CommandKbd scope="editor" command="tool.window" />, light the place <CommandKbd scope="editor" command="tool.light" /> and drop tokens{" "}
        <CommandKbd scope="editor" command="tool.token" />. Or start from a battlemap image.
      </p>
      <div className="flex gap-1.5">
        <Button size="xs" onClick={() => actions.openMapImport()}>
          <ImagePlus data-icon="inline-start" /> Import map image
        </Button>
        <Button size="xs" variant="outline" onClick={() => store.getState().setTool("wall")}>
          Draw walls
        </Button>
        <Button size="xs" variant="ghost" onClick={actions.openShortcuts}>
          <Keyboard data-icon="inline-start" /> Shortcuts
        </Button>
      </div>
    </div>
  )
}
