/**
 * Contextual options for the active tool (a compact horizontal bar above the viewport), plus the
 * snap mode, which applies to every tool.
 */
import * as React from "react"
import { Magnet, RotateCcw, RotateCw, Undo2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { SnapMode } from "@/core/grid/grid"
import { DOOR_STYLES, LIGHT_PRESETS, SIZE_FOOTPRINT } from "@/core/scene/defaults"
import { adjacentLevels } from "@/core/scene/queries"
import type { CreatureSize, DoorStyle, LightPreset, TokenKind } from "@/core/scene/types"
import type { BrushFalloff, BrushMode } from "@/core/scene/heightmapBrush"
import { BRUSH_RADIUS_MAX, BRUSH_RADIUS_MIN, type ToolSettings } from "@/editor/settings"
import { normalizeAngle } from "@/editor/transform"
import { cn } from "@/lib/utils"

import { useEditorContext, useEditorState, useToolExtras } from "./context"
import { ColorInput, NumberInput, Segmented, SelectInput, SliderInput, type Option } from "./fields"
import { degrees, formatFeet, LIGHT_PRESET_LABELS, trimNumber } from "./lib/format"
import { effectiveLightOverrides, type LightOverrides } from "./lib/toolExtras"
import { DirectionPicker, MaterialSelect, PropPicker } from "./pickers"
import { toolMeta } from "./toolMeta"

function Opt({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex shrink-0 items-center gap-1.5", className)}>
      <span className="text-[0.6875rem] whitespace-nowrap text-muted-foreground">{label}</span>
      {children}
    </div>
  )
}

const Sep = () => <Separator orientation="vertical" className="mx-1 h-5 self-center" />

function useSettings<K extends keyof ToolSettings>(tool: K): [ToolSettings[K], (partial: Partial<ToolSettings[K]>) => void] {
  const { store } = useEditorContext()
  const value = useEditorState((s) => s.toolSettings[tool])
  const set = React.useCallback((partial: Partial<ToolSettings[K]>) => store.getState().setToolSettings(tool, partial), [store, tool])
  return [value, set]
}

const DOOR_STYLE_OPTIONS: Option<DoorStyle>[] = (Object.keys(DOOR_STYLES) as DoorStyle[]).map((k) => ({ value: k, label: DOOR_STYLES[k].label }))
const PRESET_OPTIONS: Option<LightPreset>[] = (Object.keys(LIGHT_PRESETS) as LightPreset[]).map((k) => ({ value: k, label: LIGHT_PRESET_LABELS[k] }))
const SIZE_OPTIONS: Option<CreatureSize>[] = (["tiny", "small", "medium", "large", "huge", "gargantuan"] as CreatureSize[]).map((k) => ({
  value: k,
  label: `${k[0].toUpperCase()}${k.slice(1)} (${SIZE_FOOTPRINT[k] < 1 ? "½" : SIZE_FOOTPRINT[k]}×${SIZE_FOOTPRINT[k] < 1 ? "½" : SIZE_FOOTPRINT[k]})`,
}))
const KIND_OPTIONS: Option<TokenKind>[] = [
  { value: "pc", label: "PC", tooltip: "Player character" },
  { value: "npc", label: "NPC", tooltip: "Non-player character" },
  { value: "monster", label: "Monster" },
]
const BRUSH_OPTIONS: Option<BrushMode>[] = [
  { value: "raise", label: "Raise" },
  { value: "lower", label: "Lower" },
  { value: "smooth", label: "Smooth" },
  { value: "flatten", label: "Flatten" },
]
const FALLOFF_OPTIONS: Option<BrushFalloff>[] = [
  { value: "smooth", label: "Smooth falloff" },
  { value: "linear", label: "Linear falloff" },
  { value: "constant", label: "Hard edge" },
]
const SNAP_OPTIONS: Option<SnapMode>[] = [
  { value: "center", label: "Cell centres" },
  { value: "vertex", label: "Grid corners" },
  { value: "half", label: "Half cells" },
  { value: "free", label: "No snapping" },
]

function WallOptions() {
  const [s, set] = useSettings("wall")
  return (
    <>
      <Opt label="Height">
        <NumberInput className="w-20" value={s.height} min={0.5} max={200} step={0.5} unit="ft" onCommit={(height) => set({ height })} aria-label="Wall height" />
      </Opt>
      <Opt label="Thickness">
        <NumberInput className="w-20" value={s.thickness} min={0.1} max={20} step={0.25} unit="ft" onCommit={(thickness) => set({ thickness })} aria-label="Wall thickness" />
      </Opt>
      <Opt label="Material">
        <MaterialSelect className="w-32" value={s.material} onValueChange={(material) => set({ material })} />
      </Opt>
    </>
  )
}

function DoorOptions() {
  const [s, set] = useSettings("door")
  const door = useToolExtras((x) => x.door)
  const setExtras = useToolExtras((x) => x.set)
  return (
    <>
      <Opt label="Style">
        <SelectInput className="w-32" value={s.style} options={DOOR_STYLE_OPTIONS} onValueChange={(style) => set({ style })} aria-label="Door style" />
      </Opt>
      <Opt label="Starts">
        <SelectInput
          className="w-24"
          value={door.state}
          onValueChange={(state) => setExtras({ door: { ...door, state } })}
          options={[
            { value: "closed", label: "Closed" },
            { value: "open", label: "Open" },
            { value: "locked", label: "Locked" },
          ]}
          aria-label="Initial door state"
        />
      </Opt>
      <Opt label="Leaves">
        <Segmented
          value={s.leaves}
          onValueChange={(leaves) => set({ leaves })}
          options={[
            { value: "single", label: "Single" },
            { value: "double", label: "Double" },
          ]}
        />
      </Opt>
      <Opt label="Width">
        <NumberInput className="w-18" value={s.width} min={1} max={40} step={0.5} unit="ft" onCommit={(width) => set({ width })} aria-label="Door width" />
      </Opt>
      <Opt label="Height">
        <NumberInput className="w-18" value={s.height} min={1} max={100} step={0.5} unit="ft" onCommit={(height) => set({ height })} aria-label="Door height" />
      </Opt>
      <Sep />
      <Opt label="Hinge">
        <Segmented
          value={door.hinge}
          onValueChange={(hinge) => setExtras({ door: { ...door, hinge } })}
          options={[
            { value: "start", label: "Start", tooltip: "Hinge at the wall's start side" },
            { value: "end", label: "End", tooltip: "Hinge at the wall's end side" },
          ]}
        />
      </Opt>
      <Opt label="Swing">
        <Segmented
          value={door.swing === 1 ? "left" : "right"}
          onValueChange={(v) => setExtras({ door: { ...door, swing: v === "left" ? 1 : -1 } })}
          options={[
            { value: "left", label: "Left", tooltip: "Opens to the left of the wall direction" },
            { value: "right", label: "Right", tooltip: "Opens to the right of the wall direction" },
          ]}
        />
      </Opt>
    </>
  )
}

function WindowOptions() {
  const [s, set] = useSettings("window")
  return (
    <>
      <Opt label="Width">
        <NumberInput className="w-18" value={s.width} min={0.5} max={40} step={0.5} unit="ft" onCommit={(width) => set({ width })} aria-label="Window width" />
      </Opt>
      <Opt label="Height">
        <NumberInput className="w-18" value={s.height} min={0.5} max={100} step={0.5} unit="ft" onCommit={(height) => set({ height })} aria-label="Window height" />
      </Opt>
      <Opt label="Sill">
        <NumberInput className="w-18" value={s.sillHeight} min={0} max={100} step={0.5} unit="ft" onCommit={(sillHeight) => set({ sillHeight })} aria-label="Sill height" />
      </Opt>
    </>
  )
}

function ConnectorOptions() {
  const [s, set] = useSettings("connector")
  const above = useEditorState((st) => adjacentLevels(st.scene, st.activeLevelId).above ?? null)
  return (
    <>
      <Opt label="Type">
        <Segmented
          value={s.style}
          onValueChange={(style) => set({ style })}
          options={[
            { value: "stairs", label: "Stairs" },
            { value: "ladder", label: "Ladder" },
            { value: "ramp", label: "Ramp" },
          ]}
        />
      </Opt>
      {s.style !== "ladder" ? (
        <Opt label="Climbs">
          <DirectionPicker allowAuto value={s.direction} onValueChange={(direction) => set({ direction })} />
        </Opt>
      ) : null}
      <Opt label="Material">
        <MaterialSelect className="w-32" value={s.material} onValueChange={(material) => set({ material })} />
      </Opt>
      <Sep />
      {above ? (
        <Badge variant="outline" className="h-6 gap-1 text-[0.6875rem] font-normal">
          Leads to <span className="font-medium">{above.name}</span>
        </Badge>
      ) : (
        <Badge variant="destructive" className="h-6 text-[0.6875rem] font-normal">
          Add a level above first
        </Badge>
      )}
    </>
  )
}

function PillarOptions() {
  const [s, set] = useSettings("pillar")
  return (
    <>
      <Opt label="Shape">
        <Segmented
          value={s.shape}
          onValueChange={(shape) => set({ shape })}
          options={[
            { value: "round", label: "Round" },
            { value: "square", label: "Square" },
          ]}
        />
      </Opt>
      <Opt label="Size">
        <NumberInput className="w-18" value={s.size} min={0.25} max={50} step={0.25} unit="ft" onCommit={(size) => set({ size })} aria-label="Pillar size" />
      </Opt>
      <Opt label="Full height">
        <Switch size="sm" checked={s.height === null} onCheckedChange={(full) => set({ height: full ? null : 8 })} aria-label="Full storey height" />
      </Opt>
      {s.height !== null ? (
        <Opt label="Height">
          <NumberInput className="w-18" value={s.height} min={0.5} max={200} step={0.5} unit="ft" onCommit={(height) => set({ height })} aria-label="Pillar height" />
        </Opt>
      ) : null}
      <Opt label="Material">
        <MaterialSelect className="w-32" value={s.material} onValueChange={(material) => set({ material })} />
      </Opt>
    </>
  )
}

function PropOptions() {
  const [s, set] = useSettings("prop")
  const rotate = (turns: number) => set({ rotationY: normalizeAngle(s.rotationY + (turns * Math.PI) / 2) })
  return (
    <>
      <Opt label="Prop">
        <PropPicker className="w-36" value={s.kind} onValueChange={(kind) => set({ kind })} />
      </Opt>
      <Opt label="Rotation">
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => rotate(-1)} aria-label="Rotate left" />}>
              <RotateCcw />
            </TooltipTrigger>
            <TooltipContent>Rotate −90° (Shift+R)</TooltipContent>
          </Tooltip>
          <span className="w-9 text-center text-xs tabular-nums">{trimNumber(((degrees(s.rotationY) % 360) + 360) % 360, 0)}°</span>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-sm" onClick={() => rotate(1)} aria-label="Rotate right" />}>
              <RotateCw />
            </TooltipTrigger>
            <TooltipContent>Rotate 90° (R)</TooltipContent>
          </Tooltip>
        </div>
      </Opt>
    </>
  )
}

function LightOptions() {
  const [s, set] = useSettings("light")
  const extras = useToolExtras((x) => x)
  const values = effectiveLightOverrides(extras, s.preset)
  const custom = extras.light !== null && extras.light.preset === s.preset
  const patch = (p: Partial<LightOverrides>) => extras.set({ light: { ...values, ...p } })
  return (
    <>
      <Opt label="Preset">
        <SelectInput
          className="w-32"
          value={s.preset}
          options={PRESET_OPTIONS}
          onValueChange={(preset) => {
            set({ preset })
            extras.set({ light: null })
          }}
          aria-label="Light preset"
        />
      </Opt>
      <Opt label="Colour">
        <ColorInput className="w-28" value={values.color} onChange={(color) => patch({ color })} />
      </Opt>
      <Opt label="Bright">
        <NumberInput className="w-18" value={values.brightRadius} min={0} max={500} step={5} unit="ft" onCommit={(brightRadius) => patch({ brightRadius, dimRadius: Math.max(values.dimRadius, brightRadius) })} aria-label="Bright radius" />
      </Opt>
      <Opt label="Dim">
        <NumberInput className="w-18" value={values.dimRadius} min={0} max={1000} step={5} unit="ft" onCommit={(dimRadius) => patch({ dimRadius: Math.max(dimRadius, values.brightRadius) })} aria-label="Dim radius" />
      </Opt>
      <Opt label="Flicker">
        <Switch size="sm" checked={values.flicker.enabled} onCheckedChange={(enabled) => patch({ flicker: { ...values.flicker, enabled } })} aria-label="Flicker" />
      </Opt>
      <Opt label="Shadows">
        <Switch size="sm" checked={values.castsShadows} onCheckedChange={(castsShadows) => patch({ castsShadows })} aria-label="Casts shadows" />
      </Opt>
      {custom ? (
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Reset to preset" onClick={() => extras.set({ light: null })} />}>
            <Undo2 />
          </TooltipTrigger>
          <TooltipContent>Reset to the {LIGHT_PRESET_LABELS[s.preset].toLowerCase()} preset</TooltipContent>
        </Tooltip>
      ) : null}
    </>
  )
}

function TerrainOptions() {
  const [s, set] = useSettings("brush")
  const hasTerrain = useEditorState((st) => Boolean(st.scene.levels[st.activeLevelId]?.heightmap))
  return (
    <>
      <Segmented className="shrink-0" value={s.mode} onValueChange={(mode) => set({ mode })} options={BRUSH_OPTIONS} aria-label="Brush mode" />
      <Opt label="Radius">
        <SliderInput className="w-36" value={s.radius} min={BRUSH_RADIUS_MIN} max={BRUSH_RADIUS_MAX} step={0.5} onChange={(radius) => set({ radius })} format={(v) => formatFeet(v, 1)} />
      </Opt>
      <Opt label="Strength">
        <SliderInput className="w-32" value={s.strength} min={0.05} max={s.mode === "raise" || s.mode === "lower" ? 5 : 1} step={0.05} onChange={(strength) => set({ strength })} />
      </Opt>
      <SelectInput className="w-32 shrink-0" value={s.falloff} options={FALLOFF_OPTIONS} onValueChange={(falloff) => set({ falloff })} aria-label="Brush falloff" />
      {!hasTerrain ? <span className="text-[0.6875rem] whitespace-nowrap text-muted-foreground">Painting enables terrain on this level</span> : null}
    </>
  )
}

function TokenOptions() {
  const [s, set] = useSettings("token")
  const token = useToolExtras((x) => x.token)
  const setExtras = useToolExtras((x) => x.set)
  const vision = token.vision
  return (
    <>
      <Segmented className="shrink-0" value={s.kind} onValueChange={(kind) => set({ kind })} options={KIND_OPTIONS} aria-label="Token kind" />
      <Opt label="Size">
        <SelectInput className="w-36" value={s.size} options={SIZE_OPTIONS} onValueChange={(size) => set({ size })} aria-label="Token size" />
      </Opt>
      <Sep />
      <Opt label="Darkvision">
        <NumberInput className="w-18" value={vision.darkvision} min={0} max={1000} step={5} unit="ft" onCommit={(darkvision) => setExtras({ token: { vision: { ...vision, darkvision } } })} aria-label="Darkvision" />
      </Opt>
      <Opt label="Blindsight">
        <NumberInput className="w-18" value={vision.blindsight} min={0} max={1000} step={5} unit="ft" onCommit={(blindsight) => setExtras({ token: { vision: { ...vision, blindsight } } })} aria-label="Blindsight" />
      </Opt>
      <Opt label="Blind">
        <Switch size="sm" checked={vision.blind} onCheckedChange={(blind) => setExtras({ token: { vision: { ...vision, blind } } })} aria-label="Blind" />
      </Opt>
    </>
  )
}

function MeasureOptions() {
  const { controller } = useEditorContext()
  const rule = useEditorState((s) => s.scene.grid.diagonalRule)
  const [distance, setDistance] = React.useState(() => controller.tools.measure.distance())
  React.useEffect(() => controller.subscribe(() => setDistance(controller.tools.measure.distance())), [controller])
  return (
    <>
      <Badge variant="secondary" className="h-6 min-w-16 justify-center text-xs tabular-nums">
        {distance > 0 ? formatFeet(distance, 1) : "—"}
      </Badge>
      <span className="text-[0.6875rem] text-muted-foreground">Diagonals: {rule === "euclidean" ? "euclidean" : rule}</span>
    </>
  )
}

function FloorOptions() {
  const [s, set] = useSettings("floor")
  return (
    <Opt label="Material">
      <MaterialSelect className="w-32" value={s.material} onValueChange={(material) => set({ material })} />
    </Opt>
  )
}

const OPTIONS: Partial<Record<string, () => React.ReactNode>> = {
  floor: FloorOptions,
  wall: WallOptions,
  door: DoorOptions,
  window: WindowOptions,
  connector: ConnectorOptions,
  pillar: PillarOptions,
  prop: PropOptions,
  light: LightOptions,
  terrain: TerrainOptions,
  token: TokenOptions,
  measure: MeasureOptions,
}

export function ToolOptionsBar() {
  const { store } = useEditorContext()
  const tool = useEditorState((s) => s.tool)
  const snapMode = useEditorState((s) => s.snapMode)
  const altHeld = useEditorState((s) => s.altHeld)
  const meta = toolMeta(tool)
  const Body = OPTIONS[tool]
  const Icon = meta.icon

  return (
    <div className="flex min-h-10 shrink-0 items-center gap-2 border-b bg-card/40 px-3 py-1">
      <div className="flex shrink-0 items-center gap-1.5 pr-1 text-xs font-medium">
        <Icon className="size-3.5 text-primary" />
        {meta.label}
      </div>
      <Sep />
      {/* Wraps onto a second row when narrow (a hidden-scrollbar overflow hid controls with no hint). */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 *:shrink-0">
        {Body ? <Body /> : <span className="min-w-0 shrink! truncate text-[0.6875rem] text-muted-foreground">{meta.hint}</span>}
      </div>
      <Tooltip>
        <TooltipTrigger render={<div className="flex shrink-0 items-center gap-1.5" />}>
          <Magnet className={cn("size-3.5", altHeld ? "text-primary" : "text-muted-foreground")} />
          <SelectInput className="w-28" value={altHeld ? "free" : snapMode} onValueChange={(m) => store.getState().setSnapMode(m)} options={SNAP_OPTIONS} aria-label="Snap mode" />
        </TooltipTrigger>
        <TooltipContent side="bottom">{altHeld ? "Alt held: free placement" : "Snapping — hold Alt for free placement"}</TooltipContent>
      </Tooltip>
    </div>
  )
}
