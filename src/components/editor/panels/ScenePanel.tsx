import * as React from "react"
import { CloudMoon, Moon, Sun, Sunrise, Warehouse } from "lucide-react"

import { Button } from "@/components/ui/button"
import { finestTerrainResolution, maxCellsForResolution } from "@/core/scene/heightmap"
import { SCENE_LIMITS } from "@/core/scene/schema"
import type { AmbientLevel, DiagonalRule, DirectionalLightSettings, Environment, VisionOrigin } from "@/core/scene/types"
import type { EnvironmentUpdate } from "@/editor/store"
import { cn } from "@/lib/utils"

import { useEditorContext, useEditorState } from "../context"
import { ColorInput, FieldPair, FieldRow, Hint, NumberInput, PanelSection, Segmented, SelectInput, SliderInput, SwitchField, type Option } from "../fields"
import { ENV_PRESETS, SUN_DEFAULTS, type EnvPresetId } from "../lib/environmentPresets"
import { degrees, radians, trimNumber } from "../lib/format"

const LEVEL_OPTIONS: Option<AmbientLevel>[] = [
  { value: "bright", label: "Bright" },
  { value: "dim", label: "Dim" },
  { value: "dark", label: "Dark" },
]

const DIAGONAL_OPTIONS: Option<DiagonalRule>[] = [
  { value: "5-5-5", label: "5-5-5 (every step 5 ft)" },
  { value: "5-10-5", label: "5-10-5 (alternating)" },
  { value: "euclidean", label: "Euclidean" },
]

const VISION_ORIGIN_OPTIONS: Option<VisionOrigin>[] = [
  { value: "square", label: "Whole square" },
  { value: "eye", label: "Eye point" },
]

const PRESET_ICONS: Record<EnvPresetId, React.ReactNode> = {
  day: <Sun />,
  dusk: <Sunrise />,
  moonlit: <CloudMoon />,
  night: <Moon />,
  dungeon: <Warehouse />,
}

/** Compass dial for the direction light comes from (0 = +Z = south in the default top view; north up). */
function AzimuthDial({ value, onChange, onCommit, disabled }: { value: number; onChange(v: number): void; onCommit(v: number): void; disabled?: boolean }) {
  const ref = React.useRef<SVGSVGElement | null>(null)
  const angleAt = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    let a = Math.atan2(dx, dy)
    if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12)
    return (a + 2 * Math.PI) % (2 * Math.PI)
  }
  const knob = { x: 32 + 24 * Math.sin(value), y: 32 + 24 * Math.cos(value) }
  return (
    <svg
      ref={ref}
      viewBox="0 0 64 64"
      role="slider"
      aria-label="Direction the light comes from"
      aria-valuenow={Math.round(degrees(value))}
      aria-valuemin={0}
      aria-valuemax={360}
      tabIndex={disabled ? -1 : 0}
      className={cn("size-16 shrink-0 touch-none select-none", disabled ? "opacity-50" : "cursor-grab active:cursor-grabbing")}
      onPointerDown={(e) => {
        if (disabled) return
        e.currentTarget.setPointerCapture(e.pointerId)
        onChange(angleAt(e))
      }}
      onPointerMove={(e) => {
        if (!disabled && e.currentTarget.hasPointerCapture(e.pointerId)) onChange(angleAt(e))
      }}
      onPointerUp={(e) => {
        if (!disabled && e.currentTarget.hasPointerCapture(e.pointerId)) onCommit(angleAt(e))
      }}
      onKeyDown={(e) => {
        if (disabled) return
        const step = radians(e.shiftKey ? 15 : 5)
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") onCommit((value - step + 2 * Math.PI) % (2 * Math.PI))
        if (e.key === "ArrowRight" || e.key === "ArrowUp") onCommit((value + step) % (2 * Math.PI))
      }}
    >
      <circle cx="32" cy="32" r="28" className="fill-muted/40 stroke-border" strokeWidth="1" />
      {[0, 90, 180, 270].map((d) => (
        <line key={d} x1={32 + 22 * Math.sin(radians(d))} y1={32 + 22 * Math.cos(radians(d))} x2={32 + 28 * Math.sin(radians(d))} y2={32 + 28 * Math.cos(radians(d))} className="stroke-muted-foreground/50" strokeWidth="1" />
      ))}
      <text x="32" y="11" textAnchor="middle" className="fill-muted-foreground text-[7px]">
        N
      </text>
      <line x1="32" y1="32" x2={knob.x} y2={knob.y} className="stroke-primary" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="32" cy="32" r="2" className="fill-muted-foreground" />
      <circle cx={knob.x} cy={knob.y} r="4.5" className="fill-primary stroke-background" strokeWidth="1.5" />
    </svg>
  )
}

/** Quarter-circle dial for the light's elevation above the horizon (≈6°–90°). */
function ElevationDial({ value, onChange, onCommit, disabled }: { value: number; onChange(v: number): void; onCommit(v: number): void; disabled?: boolean }) {
  const ref = React.useRef<SVGSVGElement | null>(null)
  const clamp = (a: number) => Math.min(Math.PI / 2, Math.max(0.1, a))
  const angleAt = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const sx = r.width / 64
    const dx = (e.clientX - (r.left + 8 * sx)) / sx
    const dy = (e.clientY - (r.top + 56 * sx)) / sx
    let a = Math.atan2(-dy, dx)
    if (e.shiftKey) a = Math.round(a / (Math.PI / 36)) * (Math.PI / 36)
    return clamp(a)
  }
  const knob = { x: 8 + 46 * Math.cos(value), y: 56 - 46 * Math.sin(value) }
  return (
    <svg
      ref={ref}
      viewBox="0 0 64 64"
      role="slider"
      aria-label="Elevation above the horizon"
      aria-valuenow={Math.round(degrees(value))}
      aria-valuemin={6}
      aria-valuemax={90}
      tabIndex={disabled ? -1 : 0}
      className={cn("size-16 shrink-0 touch-none select-none", disabled ? "opacity-50" : "cursor-grab active:cursor-grabbing")}
      onPointerDown={(e) => {
        if (disabled) return
        e.currentTarget.setPointerCapture(e.pointerId)
        onChange(angleAt(e))
      }}
      onPointerMove={(e) => {
        if (!disabled && e.currentTarget.hasPointerCapture(e.pointerId)) onChange(angleAt(e))
      }}
      onPointerUp={(e) => {
        if (!disabled && e.currentTarget.hasPointerCapture(e.pointerId)) onCommit(angleAt(e))
      }}
      onKeyDown={(e) => {
        if (disabled) return
        const step = radians(e.shiftKey ? 10 : 2)
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") onCommit(clamp(value - step))
        if (e.key === "ArrowRight" || e.key === "ArrowUp") onCommit(clamp(value + step))
      }}
    >
      <path d="M 8 56 L 58 56 A 50 50 0 0 0 8 6 Z" className="fill-muted/40 stroke-border" strokeWidth="1" />
      <line x1="8" y1="56" x2={knob.x} y2={knob.y} className="stroke-primary" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx={knob.x} cy={knob.y} r="4.5" className="fill-primary stroke-background" strokeWidth="1.5" />
    </svg>
  )
}

function SunSection({ env }: { env: Environment }) {
  const { store } = useEditorContext()
  const readOnly = useEditorState((s) => s.readOnly)
  const d = env.directional
  // Live value while a dial is dragged (committed as one coalesced undo step).
  const [live, setLive] = React.useState<{ azimuth?: number; elevation?: number }>({})
  const lastLive = React.useRef(0)
  const set = (partial: Partial<DirectionalLightSettings>) => store.getState().updateEnvironment({ directional: partial })
  /** Live dial updates re-render the sun shadows: throttle them while dragging. */
  const setLiveThrottled = (partial: Partial<DirectionalLightSettings>) => {
    const now = performance.now()
    if (now - lastLive.current < 120) return
    lastLive.current = now
    set(partial)
  }
  const az = live.azimuth ?? d.azimuth
  const el = live.elevation ?? d.elevation
  const disabled = readOnly || !d.enabled

  return (
    <PanelSection title="Sun & moon">
      <SwitchField label={d.kind === "sun" ? "Sunlight" : "Moonlight"} description="A directional light with its own shadows, blocked by roofs and walls." checked={d.enabled} disabled={readOnly} onCheckedChange={(enabled) => set({ enabled })} />
      <FieldRow label="Source">
        <Segmented
          value={d.kind}
          disabled={disabled}
          onValueChange={(kind) => set({ kind, ...SUN_DEFAULTS[kind] })}
          options={[
            { value: "sun", label: "Sun", icon: <Sun className="size-3" /> },
            { value: "moon", label: "Moon", icon: <Moon className="size-3" /> },
          ]}
        />
      </FieldRow>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col items-center gap-1">
          <AzimuthDial
            value={az}
            disabled={disabled}
            onChange={(azimuth) => {
              setLive((l) => ({ ...l, azimuth }))
              setLiveThrottled({ azimuth })
            }}
            onCommit={(azimuth) => {
              setLive((l) => ({ ...l, azimuth: undefined }))
              set({ azimuth })
            }}
          />
          <NumberInput className="w-20" value={Number(degrees(az).toFixed(0))} min={0} max={360} step={5} unit="°" disabled={disabled} onCommit={(v) => set({ azimuth: radians(((v % 360) + 360) % 360) })} aria-label="Azimuth" />
          <span className="text-[0.625rem] text-muted-foreground">Direction</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <ElevationDial
            value={el}
            disabled={disabled}
            onChange={(elevation) => {
              setLive((l) => ({ ...l, elevation }))
              setLiveThrottled({ elevation })
            }}
            onCommit={(elevation) => {
              setLive((l) => ({ ...l, elevation: undefined }))
              set({ elevation })
            }}
          />
          <NumberInput className="w-20" value={Number(degrees(el).toFixed(0))} min={6} max={90} step={5} unit="°" disabled={disabled} onCommit={(v) => set({ elevation: radians(v) })} aria-label="Elevation" />
          <span className="text-[0.625rem] text-muted-foreground">Elevation</span>
        </div>
      </div>
      <FieldRow label="Colour">
        <ColorInput className="flex-1" value={d.color} disabled={disabled} onChange={(color) => set({ color })} />
      </FieldRow>
      <FieldRow label="Intensity">
        <SliderInput value={d.intensity} min={0} max={3} step={0.05} disabled={disabled} onChange={(intensity) => set({ intensity })} />
      </FieldRow>
      <FieldRow label="Lit areas are" hint="The light level granted to surfaces it reaches (for vision).">
        <Segmented
          value={d.grants}
          disabled={disabled}
          onValueChange={(grants) => set({ grants })}
          options={[
            { value: "bright", label: "Bright" },
            { value: "dim", label: "Dim" },
          ]}
        />
      </FieldRow>
    </PanelSection>
  )
}

export function ScenePanel() {
  const { store } = useEditorContext()
  const readOnly = useEditorState((s) => s.readOnly)
  const grid = useEditorState((s) => s.scene.grid)
  const finest = useEditorState((s) => finestTerrainResolution(s.scene.levels))
  const maxCells = Math.min(SCENE_LIMITS.maxGridCells, finest === null ? Infinity : maxCellsForResolution(finest))
  const env = useEditorState((s) => s.scene.environment)
  const setEnv = (partial: EnvironmentUpdate) => store.getState().updateEnvironment(partial)

  return (
    <div className="flex flex-col">
      <PanelSection title="Grid">
        <FieldRow
          label="Size"
          hint={`Scene extent in 5 ft cells (max ${maxCells} × ${maxCells}${maxCells < SCENE_LIMITS.maxGridCells ? `: terrain at ${finest}× resolution` : ""}). Shrinking is refused if content would fall outside.`}
        >
          <FieldPair>
            <NumberInput prefix="W" value={grid.width} min={1} max={maxCells} step={1} precision={0} disabled={readOnly} onCommit={(width) => store.getState().updateGrid({ width })} aria-label="Grid width" />
            <NumberInput prefix="D" value={grid.depth} min={1} max={maxCells} step={1} precision={0} disabled={readOnly} onCommit={(depth) => store.getState().updateGrid({ depth })} aria-label="Grid depth" />
          </FieldPair>
        </FieldRow>
        <Hint>
          {grid.width}×{grid.depth} cells of {trimNumber(grid.cellSize)} ft = {trimNumber(grid.width * grid.cellSize)}×{trimNumber(grid.depth * grid.cellSize)} ft
        </Hint>
        <FieldRow label="Diagonals" hint="How the ruler and movement count diagonal steps.">
          <SelectInput value={grid.diagonalRule} options={DIAGONAL_OPTIONS} disabled={readOnly} onValueChange={(diagonalRule) => store.getState().updateGrid({ diagonalRule })} />
        </FieldRow>
        <FieldRow label="Sight from" hint="Whole square: tokens see from any corner of their space, as if leaning around corners (5e cover rules). Eye point: only from the token's eye.">
          <SelectInput value={grid.visionOrigin} options={VISION_ORIGIN_OPTIONS} disabled={readOnly} onValueChange={(visionOrigin) => store.getState().updateGrid({ visionOrigin })} />
        </FieldRow>
      </PanelSection>

      <PanelSection title="Lighting">
        <div className="grid grid-cols-5 gap-1">
          {(Object.keys(ENV_PRESETS) as EnvPresetId[]).map((id) => (
            <Button key={id} variant="outline" size="sm" disabled={readOnly} className="h-auto flex-col gap-1 px-1 py-1.5 text-[0.625rem] font-normal" onClick={() => setEnv(ENV_PRESETS[id].env)}>
              {PRESET_ICONS[id]}
              {ENV_PRESETS[id].label}
            </Button>
          ))}
        </div>
        <FieldRow label="Open sky" hint="Light level where the sky is overhead and no light source reaches.">
          <Segmented value={env.skyLevel} disabled={readOnly} onValueChange={(skyLevel) => setEnv({ skyLevel })} options={LEVEL_OPTIONS} />
        </FieldRow>
        <FieldRow label="Under cover" hint="Light level under a roof or floor where no light source reaches.">
          <Segmented value={env.ambientLevel} disabled={readOnly} onValueChange={(ambientLevel) => setEnv({ ambientLevel })} options={LEVEL_OPTIONS} />
        </FieldRow>
        <FieldRow label="Ambient fill" hint="Visual-only fill light (does not affect vision).">
          <ColorInput className="w-28" value={env.ambientColor} disabled={readOnly} onChange={(ambientColor) => setEnv({ ambientColor })} />
        </FieldRow>
        <FieldRow label="Fill strength">
          <SliderInput value={env.ambientIntensity} min={0} max={1} step={0.01} disabled={readOnly} format={(v) => `${Math.round(v * 100)}%`} onChange={(ambientIntensity) => setEnv({ ambientIntensity })} />
        </FieldRow>
        <FieldRow label="Background">
          <ColorInput className="w-28" value={env.backgroundColor} disabled={readOnly} onChange={(backgroundColor) => setEnv({ backgroundColor })} />
        </FieldRow>
      </PanelSection>

      <SunSection env={env} />
    </div>
  )
}
