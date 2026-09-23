/**
 * HTML chrome floating over the viewport: level switcher, camera controls, document banners
 * (read-only version, recoverable draft), the player-preview bar and a first-steps hint.
 */
import * as React from "react"
import { Box, ChevronDown, ChevronsDownUp, ChevronsUpDown, ChevronUp, Eye, EyeOff, History, ImagePlus, Keyboard, LifeBuoy, Map as MapIcon, Maximize, RotateCcw, Undo2, X } from "lucide-react"

import { CommandKbd } from "@/components/keybindings/CommandKbd"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Kbd } from "@/components/ui/kbd"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { adjacentLevels, sortedLevels } from "@/core/scene/queries"
import type { Id } from "@/core/scene/types"
import { cn } from "@/lib/utils"

import { useEditorActions, useEditorContext, useEditorShallow, useEditorState } from "./context"
import { SelectInput } from "./fields"
import { clockTime, formatElevation, relativeTime, tokenLabel } from "./lib/format"
import { axisTicks, levelAxisBounds, spreadLabels } from "./lib/levelAxis"
import { previewCandidates, type PreviewResult } from "./lib/preview"
import type { SceneDocument } from "./useSceneDocument"

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
      className={cn("pointer-events-auto flex flex-col rounded-lg p-1", glass)}
    >
      <div className="flex items-center gap-1 pl-1.5">
        <div className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="max-w-48 truncate text-xs font-medium">{level.name}</span>
          <span className="text-[0.625rem] text-muted-foreground">{formatElevation(level.elevation)}</span>
        </div>
        <ButtonGroup orientation="vertical" className="ml-1">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Level above" disabled={!above} onClick={() => store.getState().stepActiveLevel(1)} />}>
              <ChevronUp />
            </TooltipTrigger>
            <TooltipContent side="right">
              {above ? `Up to ${above.name}` : "No level above"} <CommandKbd scope="editor" command="level.up" />
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Level below" disabled={!below} onClick={() => store.getState().stepActiveLevel(-1)} />}>
              <ChevronDown />
            </TooltipTrigger>
            <TooltipContent side="right">
              {below ? `Down to ${below.name}` : "No level below"} <CommandKbd scope="editor" command="level.down" />
            </TooltipContent>
          </Tooltip>
        </ButtonGroup>
        <Tooltip>
          <TooltipTrigger
            render={<CollapsibleTrigger render={<Button variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={open ? "Hide the level axis" : "Show the level axis"} />} />}
          >
            {open ? <ChevronsDownUp /> : <ChevronsUpDown />}
          </TooltipTrigger>
          <TooltipContent side="right">{open ? "Hide the level axis" : "Show the level axis"}</TooltipContent>
        </Tooltip>
      </div>
      <CollapsibleContent className="max-h-[60vh] overflow-y-auto">
        <LevelAxis />
      </CollapsibleContent>
    </Collapsible>
  )
}

/** Pixel layout of the level axis: label pitch, top/bottom padding, least height, axis and label x. */
const AXIS = { row: 26, pad: 14, minHeight: 200, x: 30, labelX: 54, width: 208 }

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
  const { height, top, bottom, ticks, rows } = React.useMemo(() => {
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
    return {
      height,
      top: y(up(hi)),
      bottom: y(0),
      ticks: axisTicks(lo, hi).map((v) => ({ v, y: y(up(v)) })),
      rows: ordered.map((level, i) => ({ level, y: y(up(level.elevation)), labelY: y(labels[i]) })),
    }
  }, [levels])

  return (
    <div className="relative mt-1 border-t" style={{ height, width: AXIS.width }}>
      <svg className="absolute inset-0 size-full" aria-hidden>
        <line x1={AXIS.x} x2={AXIS.x} y1={top} y2={bottom} className="stroke-muted-foreground/60" />
        {ticks.map((t) => (
          <g key={t.v}>
            <line x1={AXIS.x - 3} x2={AXIS.x} y1={t.y} y2={t.y} className="stroke-muted-foreground/60" />
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
          <circle key={level.id} cx={AXIS.x} cy={y} r={level.id === activeLevelId ? 3.5 : 2.5} className={level.id === activeLevelId ? "fill-primary" : "fill-foreground"} />
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
                    size="icon-sm"
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
                    variant={active ? "default" : "outline"}
                    size="sm"
                    aria-pressed={active}
                    className="max-w-32 justify-start"
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
  return (
    <div className={cn("pointer-events-auto flex items-center gap-0.5 rounded-lg p-1", glass)}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant={camera === "orbit" ? "secondary" : "ghost"} size="icon-sm" aria-label="3D orbit camera" onClick={() => store.getState().setView({ camera: "orbit" })} />
          }
        >
          <Box />
        </TooltipTrigger>
        <TooltipContent side="bottom">3D orbit (right-drag orbits, middle-drag pans)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button variant={camera === "topdown" ? "secondary" : "ghost"} size="icon-sm" aria-label="Top-down camera" onClick={() => store.getState().setView({ camera: "topdown" })} />
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
    </div>
  )
}

export function DocumentBanners({ doc }: { doc: SceneDocument }) {
  const v = doc.viewingVersion
  return (
    <div className="pointer-events-none flex flex-col items-center gap-2">
      {v ? (
        <div className={cn("pointer-events-auto flex items-center gap-3 rounded-lg px-3 py-2 text-xs", glass)}>
          <History className="size-4 text-primary" />
          <span>
            Viewing <span className="font-medium">version {v.version}</span> from {relativeTime(v.createdAt)} — read-only
          </span>
          <Button size="xs" variant="outline" disabled={doc.busy !== null} onClick={() => void doc.restoreVersion(v)}>
            <RotateCcw data-icon="inline-start" /> Restore this version
          </Button>
          <Button size="xs" variant="ghost" disabled={doc.busy !== null} onClick={() => void doc.backToLatest()}>
            Back to latest
          </Button>
        </div>
      ) : null}
      {doc.recoverable ? (
        <div className={cn("pointer-events-auto flex items-center gap-3 rounded-lg px-3 py-2 text-xs", glass)}>
          <LifeBuoy className="size-4 text-primary" />
          <span>
            Unsaved changes from {clockTime(doc.recoverable.savedAt)} ({relativeTime(doc.recoverable.savedAt)}) were found on this device.
          </span>
          <Button size="xs" variant="outline" onClick={doc.restoreDraft}>
            <Undo2 data-icon="inline-start" /> Restore
          </Button>
          <Button size="xs" variant="ghost" onClick={() => void doc.discardDraft()}>
            Discard
          </Button>
        </div>
      ) : null}
      {doc.busy ? (
        <div className={cn("pointer-events-auto flex items-center gap-2 rounded-full px-3 py-1.5 text-xs", glass)}>
          <Spinner className="size-3.5" /> {doc.busy}
        </div>
      ) : null}
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

export function PreviewBar({ tokenId, result, onTokenChange }: { tokenId: Id; result: PreviewResult | null; onTokenChange(id: Id): void }) {
  const actions = useEditorActions()
  const tokens = useEditorState((s) => s.scene.tokens)
  const levelName = useEditorState((s) => {
    const t = Object.hasOwn(s.scene.tokens, tokenId) ? s.scene.tokens[tokenId] : null
    return t && Object.hasOwn(s.scene.levels, t.levelId) ? s.scene.levels[t.levelId].name : null
  })
  const options = previewCandidates({ tokens }).map((id) => ({ value: id, label: `${tokenLabel(tokens[id])}${tokens[id].hidden ? " (hidden)" : ""}` }))
  const t = Object.hasOwn(tokens, tokenId) ? tokens[tokenId] : null
  const senses = t ? [t.vision.blind ? "blind" : t.vision.darkvision > 0 ? `darkvision ${t.vision.darkvision} ft` : "normal vision", t.vision.blindsight > 0 ? `blindsight ${t.vision.blindsight} ft` : null].filter(Boolean).join(" · ") : ""
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b bg-primary/10 px-3">
      <div className="flex shrink-0 items-center gap-1.5 text-xs font-medium whitespace-nowrap text-primary">
        <Eye className="size-3.5" /> Player view preview
      </div>
      <div className="h-5 w-px shrink-0 bg-border" />
      <span className="shrink-0 text-[0.6875rem] whitespace-nowrap text-muted-foreground">Seeing as</span>
      <SelectInput className="w-44 shrink-0" value={tokenId} options={options} onValueChange={onTokenChange} aria-label="Previewed token" />
      <Tooltip>
        <TooltipTrigger render={<span className="min-w-0 cursor-default truncate text-[0.6875rem] whitespace-nowrap text-muted-foreground" />}>
          {levelName ? `${levelName} · ` : ""}
          {senses}
        </TooltipTrigger>
        <TooltipContent>
          {levelName ? `${levelName} · ` : ""}
          {senses}
        </TooltipContent>
      </Tooltip>
      <div className="flex-1" />
      {result ? (
        <Tooltip>
          <TooltipTrigger render={<Badge variant="outline" className="shrink-0 cursor-default font-normal tabular-nums" />}>
            {result.visibleTokenIds.length} other token{result.visibleTokenIds.length === 1 ? "" : "s"} visible · {Math.round(result.ms)} ms
          </TooltipTrigger>
          <TooltipContent>Computed locally by the vision engine; explored = what is perceived right now. Click another token to switch.</TooltipContent>
        </Tooltip>
      ) : (
        <Spinner className="size-3.5" />
      )}
      <Button size="sm" variant="outline" className="shrink-0" onClick={actions.exitPreview}>
        <X data-icon="inline-start" /> Exit preview <Kbd className="ml-1">Esc</Kbd>
      </Button>
    </div>
  )
}
