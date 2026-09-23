/**
 * Domain pickers shared by the tool options bar and the inspector: materials, props, directions.
 */
import * as React from "react"
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { MATERIAL_COLORS, PROP_LIBRARY } from "@/core/scene/defaults"
import type { ConnectorObject, MaterialId, PropKind } from "@/core/scene/types"
import { cn } from "@/lib/utils"

import { Segmented, SelectInput, type Option } from "./fields"
import { PROP_ICONS } from "./toolMeta"

const MATERIAL_LABELS: Record<MaterialId, string> = {
  stone: "Stone",
  brick: "Brick",
  wood: "Wood",
  plaster: "Plaster",
  dirt: "Dirt",
  grass: "Grass",
  sand: "Sand",
  water: "Water",
  metal: "Metal",
  marble: "Marble",
  tile: "Tile",
  cobble: "Cobblestone",
}

/** Data colour swatch (material / light colours come from the document, not the theme). */
export function Swatch({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cn("inline-block size-3 shrink-0 rounded-[3px] border border-foreground/15", className)} style={{ backgroundColor: color }} />
}

const MATERIAL_OPTIONS: Option<MaterialId>[] = (Object.keys(MATERIAL_LABELS) as MaterialId[]).map((m) => ({
  value: m,
  label: MATERIAL_LABELS[m],
  icon: <Swatch color={MATERIAL_COLORS[m]} />,
}))

export function MaterialSelect({ value, onValueChange, className }: { value: MaterialId; onValueChange(m: MaterialId): void; className?: string }) {
  return <SelectInput aria-label="Material" value={value} onValueChange={onValueChange} options={MATERIAL_OPTIONS} className={className} />
}

const PROP_KINDS = Object.keys(PROP_LIBRARY) as PropKind[]

/** Prop library grid in a popover. */
export function PropPicker({ value, onValueChange, className }: { value: PropKind; onValueChange(kind: PropKind): void; className?: string }) {
  const [open, setOpen] = React.useState(false)
  const Icon = PROP_ICONS[value]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" size="sm" className={cn("h-7 justify-between gap-2 px-2", className)} />}>
        <span className="flex items-center gap-1.5">
          <Icon className="size-3.5 text-muted-foreground" />
          {PROP_LIBRARY[value].label}
        </span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <div className="grid grid-cols-4 gap-1">
          {PROP_KINDS.map((kind) => {
            const KindIcon = PROP_ICONS[kind]
            const def = PROP_LIBRARY[kind]
            const selected = kind === value
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={selected}
                onClick={() => {
                  onValueChange(kind)
                  setOpen(false)
                }}
                className={cn(
                  "flex flex-col items-center gap-1 rounded-md border border-transparent px-1 py-2 text-[0.625rem] text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
                  selected && "border-primary/50 bg-primary/10 text-foreground"
                )}
              >
                <span className="relative grid size-8 place-items-center rounded-md bg-muted/60">
                  <KindIcon className="size-4" />
                  <Swatch color={def.defaultColor} className="absolute right-0.5 bottom-0.5 size-2 rounded-full" />
                </span>
                {def.label}
              </button>
            )
          })}
        </div>
        <p className="mt-2 px-1 text-[0.625rem] leading-snug text-muted-foreground">
          {PROP_LIBRARY[value].blocksSight ? "Blocks sight" : "Does not block sight"} · {PROP_LIBRARY[value].blocksMovement ? "blocks movement" : "passable"}
        </p>
      </PopoverContent>
    </Popover>
  )
}

const DIRECTION_OPTIONS: Option<"0" | "1" | "2" | "3">[] = [
  { value: "2", label: "", icon: <ArrowUp className="size-3.5" />, tooltip: "Climbs north (−Z)" },
  { value: "1", label: "", icon: <ArrowRight className="size-3.5" />, tooltip: "Climbs east (+X)" },
  { value: "0", label: "", icon: <ArrowDown className="size-3.5" />, tooltip: "Climbs south (+Z)" },
  { value: "3", label: "", icon: <ArrowLeft className="size-3.5" />, tooltip: "Climbs west (−X)" },
]

/**
 * Ascending direction of a stairs/ramp run (0 = +Z, 1 = +X, 2 = −Z, 3 = −X), shown as arrows in the
 * default top view; `allowAuto` adds "Auto" (the drag direction).
 */
export function DirectionPicker({
  value,
  onValueChange,
  allowAuto,
}: {
  value: ConnectorObject["direction"] | "auto"
  onValueChange(v: ConnectorObject["direction"] | "auto"): void
  allowAuto?: boolean
}) {
  const options: Option<"auto" | "0" | "1" | "2" | "3">[] = allowAuto
    ? [{ value: "auto", label: "Auto", tooltip: "Climb in the direction you drag" }, ...DIRECTION_OPTIONS]
    : DIRECTION_OPTIONS
  return (
    <Segmented
      aria-label="Direction"
      value={String(value) as "auto" | "0" | "1" | "2" | "3"}
      onValueChange={(v) => onValueChange(v === "auto" ? "auto" : (Number(v) as ConnectorObject["direction"]))}
      options={options}
    />
  )
}
