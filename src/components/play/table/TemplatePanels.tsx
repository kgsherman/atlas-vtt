/**
 * HUD panels of the Template tool (ARCHITECTURE §6.6), for players and the DM:
 *  - TemplatePicker: what the next area is (a spell preset, or a shape, size, colour and label; round
 *    shapes can be carried by a token as an aura), shown above the tool dock while the tool is on;
 *  - TemplateCard: the selected area — its shape, who placed it, the creatures it catches (only those
 *    this page has: a player's list never names a creature they cannot see) — with Move / Remove for its
 *    owner and the DM, and for the DM "Hide from players" and "Roll damage", which rolls once in the
 *    log and deals it to each creature caught (half to those marked as having saved).
 */
import * as React from "react"
import {
  Box,
  CircleDashed,
  Cone,
  Cylinder,
  Dices,
  Eye,
  EyeOff,
  Move,
  MoveRight,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"

import { NumberInput, TextInput } from "@/components/editor/fields"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  AREA_COLORS,
  AREA_LIMITS,
  AREA_PRESETS,
  AREA_SHAPES,
  describeArea,
  type AreaShape,
} from "@/core/area"
import type { Id, SceneLike } from "@/core/scene/types"
import { cn } from "@/lib/utils"
import {
  templateTitle,
  tokenDisplayName,
  type TemplateSpec,
  type TemplateView,
} from "@/play"

import { HudPanel } from "../hud"

const SHAPE_ICONS: Record<AreaShape, typeof Box> = {
  sphere: CircleDashed,
  cylinder: Cylinder,
  cone: Cone,
  line: MoveRight,
  cube: Box,
}

const SHAPE_LABELS: Record<AreaShape, string> = {
  sphere: "Sphere",
  cylinder: "Cylinder",
  cone: "Cone",
  line: "Line",
  cube: "Cube",
}

const SIZE_LABELS: Record<AreaShape, string> = {
  sphere: "Radius",
  cylinder: "Radius",
  cone: "Length",
  line: "Length",
  cube: "Side",
}

const isRound = (s: AreaShape) => s === "sphere" || s === "cylinder"

export function TemplatePicker({
  spec,
  onSpec,
  onClose,
}: {
  spec: TemplateSpec
  onSpec(spec: TemplateSpec): void
  onClose(): void
}) {
  const set = (patch: Partial<TemplateSpec>) => onSpec({ ...spec, ...patch })
  return (
    <HudPanel
      className="flex w-[22rem] flex-col gap-2.5 p-3 text-xs"
      data-slot="template-picker"
    >
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Area of effect</span>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="xs"
                className="ml-auto"
                aria-label="Spell presets"
              />
            }
          >
            Spells…
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-56">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Common spells</DropdownMenuLabel>
              {AREA_PRESETS.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  onClick={() =>
                    onSpec({
                      ...spec,
                      shape: p.shape,
                      size: p.size,
                      width: p.width,
                      height: p.height,
                      color: p.color,
                      label: p.name,
                      aura: p.aura === true,
                    })
                  }
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: p.color }}
                  />
                  {p.name}
                  <span className="ml-auto text-muted-foreground">
                    {describeArea(p)}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Leave the area tool"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>

      <ToggleGroup
        value={[spec.shape]}
        onValueChange={(v) => {
          const shape = v[0] as AreaShape | undefined
          if (shape) set({ shape, aura: isRound(shape) && spec.aura })
        }}
        spacing={1}
        className="gap-0.5"
        aria-label="Shape"
      >
        {AREA_SHAPES.map((s) => {
          const Icon = SHAPE_ICONS[s]
          return (
            <Tooltip key={s}>
              <TooltipTrigger
                render={
                  <ToggleGroupItem
                    value={s}
                    aria-label={SHAPE_LABELS[s]}
                    className="h-7 flex-1 gap-1 px-1.5 text-[0.6875rem] aria-pressed:bg-primary aria-pressed:text-primary-foreground data-[pressed]:bg-primary data-[pressed]:text-primary-foreground"
                  />
                }
              >
                <Icon className="size-3.5" />
                {SHAPE_LABELS[s]}
              </TooltipTrigger>
              <TooltipContent side="top">{shapeHint(s)}</TooltipContent>
            </Tooltip>
          )
        })}
      </ToggleGroup>

      <div className="grid grid-cols-3 gap-2">
        <Field label={SIZE_LABELS[spec.shape]}>
          <NumberInput
            aria-label={SIZE_LABELS[spec.shape]}
            value={spec.size}
            min={AREA_LIMITS.minSize}
            max={AREA_LIMITS.maxSize}
            step={5}
            precision={1}
            unit="ft"
            onCommit={(size) => set({ size })}
          />
        </Field>
        {spec.shape === "line" ? (
          <Field label="Width">
            <NumberInput
              aria-label="Width"
              value={spec.width}
              min={AREA_LIMITS.minWidth}
              max={AREA_LIMITS.maxWidth}
              step={5}
              precision={1}
              unit="ft"
              onCommit={(width) => set({ width })}
            />
          </Field>
        ) : spec.shape === "cylinder" ? (
          <Field label="Height">
            <NumberInput
              aria-label="Height"
              value={spec.height}
              min={AREA_LIMITS.minHeight}
              max={AREA_LIMITS.maxHeight}
              step={5}
              precision={1}
              unit="ft"
              onCommit={(height) => set({ height })}
            />
          </Field>
        ) : (
          <div />
        )}
        <Field label="Above ground">
          <NumberInput
            aria-label="Origin height above the ground"
            value={spec.elevation}
            placeholder="auto"
            min={0}
            max={AREA_LIMITS.maxElevation}
            step={5}
            precision={1}
            unit="ft"
            onCommit={(elevation) => set({ elevation })}
          />
        </Field>
      </div>

      <div className="flex items-end gap-2">
        <Field label="Label" className="flex-1">
          <TextInput
            aria-label="Label"
            value={spec.label}
            placeholder={describeArea(spec)}
            maxLength={AREA_LIMITS.maxLabel}
            onCommit={(label) => set({ label })}
          />
        </Field>
        <div className="flex h-7 items-center gap-1" aria-label="Colour">
          {AREA_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Colour ${c}`}
              aria-pressed={spec.color === c}
              onClick={() => set({ color: c })}
              className={cn(
                "size-4 rounded-full border border-border transition-transform hover:scale-110",
                spec.color === c &&
                  "ring-2 ring-foreground ring-offset-1 ring-offset-card"
              )}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </div>

      {isRound(spec.shape) ? (
        <label className="flex items-center gap-2 text-muted-foreground">
          <Switch
            size="sm"
            checked={spec.aura}
            onCheckedChange={(aura) => set({ aura })}
            aria-label="Carried by a token"
          />
          Carried by a token (an aura that moves with it)
        </label>
      ) : null}

      <p className="text-[0.6875rem] leading-snug text-muted-foreground">
        {spec.aura && isRound(spec.shape)
          ? "Click a token to give it the aura. Esc cancels."
          : isRound(spec.shape)
            ? "Click to place it (it snaps to grid corners), drag to adjust. Alt: no snapping. Esc cancels."
            : "Press at the point of origin (or on a token) and drag to aim. Shift snaps the angle, Alt the origin. Esc cancels."}
      </p>
    </HudPanel>
  )
}

function shapeHint(s: AreaShape): string {
  switch (s) {
    case "sphere":
      return "Everything within the radius of a point (Fireball)"
    case "cylinder":
      return "A column from the ground up (Moonbeam, Flame Strike)"
    case "cone":
      return "Widens as far as it reaches (Burning Hands, breath weapons)"
    case "line":
      return "A straight line (Lightning Bolt)"
    case "cube":
      return "A cube starting at its origin (Thunderwave)"
  }
}

function Field({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-[0.625rem] font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      {children}
    </div>
  )
}

export interface TemplateCardProps {
  view: TemplateView
  scene: SceneLike
  role: "player" | "dm"
  onClose(): void
  onMove(): void
  onRemove(): void
  /** DM: keep it from players (or show it). */
  onHidden?(hidden: boolean): void
  /** DM: roll damage and deal it to the creatures caught. Returns an error to show, or null. */
  onDamage?(
    formula: string,
    targets: { tokenId: Id; half: boolean }[]
  ): string | null
  onFocusToken?(tokenId: Id): void
  disabled?: boolean
}

export function TemplateCard({
  view,
  scene,
  role,
  onClose,
  onMove,
  onRemove,
  onHidden,
  onDamage,
  onFocusToken,
  disabled,
}: TemplateCardProps) {
  const targets = view.tokenIds
    .filter((id) => Object.hasOwn(scene.tokens, id))
    .map((id) => scene.tokens[id])
  const [saved, setSaved] = React.useState<ReadonlySet<Id>>(new Set())
  const [formula, setFormula] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const who = view.dm ? "the DM" : view.mine ? "you" : view.name || "a player"
  const roll = () => {
    if (!onDamage) return
    const e = onDamage(
      formula.trim() + (view.label ? ` ${view.label}` : ""),
      targets.map((t) => ({ tokenId: t.id, half: saved.has(t.id) }))
    )
    setError(e)
  }
  return (
    <HudPanel
      className="flex w-80 flex-col gap-2.5 p-3 text-xs"
      data-slot="template-card"
    >
      <div className="flex items-start gap-2">
        <span
          className="mt-1 size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: view.color }}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {templateTitle(view)}
          </div>
          <div className="text-muted-foreground">
            {view.label ? `${describeArea(view.source)} · ` : ""}
            {view.source.tokenId ? "aura · " : ""}placed by {who}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Close"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[0.625rem] font-medium tracking-wide text-muted-foreground uppercase">
          {targets.length === 0
            ? "No creature caught"
            : `${targets.length} ${targets.length === 1 ? "creature" : "creatures"} caught`}
        </span>
        {targets.length > 0 ? (
          <ul className="flex max-h-36 flex-col gap-0.5 overflow-y-auto">
            {targets.map((t) => (
              <li key={t.id} className="flex items-center gap-2">
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left hover:underline"
                  onClick={() => onFocusToken?.(t.id)}
                >
                  {tokenDisplayName(t)}
                </button>
                {role === "dm" && onDamage ? (
                  <Label className="gap-1 text-[0.6875rem] font-normal text-muted-foreground">
                    <Checkbox
                      checked={saved.has(t.id)}
                      onCheckedChange={(on) =>
                        setSaved((s) => {
                          const next = new Set(s)
                          if (on) next.add(t.id)
                          else next.delete(t.id)
                          return next
                        })
                      }
                      aria-label={`${tokenDisplayName(t)} saved (half damage)`}
                    />
                    saved
                  </Label>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">
            Walls, closed doors and floors stop an area: only creatures it
            reaches are caught.
          </p>
        )}
      </div>

      {role === "dm" && onDamage && targets.length > 0 ? (
        <form
          className="flex flex-col gap-1"
          onSubmit={(e) => {
            e.preventDefault()
            roll()
          }}
        >
          <div className="flex items-center gap-1.5">
            <Input
              aria-label="Damage dice"
              value={formula}
              placeholder="8d6"
              className="h-7 flex-1 text-xs"
              onChange={(e) => {
                setFormula(e.target.value)
                setError(null)
              }}
              disabled={disabled}
            />
            <Button
              type="submit"
              size="sm"
              className="h-7"
              disabled={disabled || formula.trim() === ""}
            >
              <Dices data-icon="inline-start" />
              Roll damage
            </Button>
          </div>
          {error ? (
            <p className="text-[0.6875rem] text-destructive">{error}</p>
          ) : (
            <p className="text-[0.6875rem] text-muted-foreground">
              One roll for all, halved for those marked saved; dealt to
              creatures whose hit points you track.
            </p>
          )}
        </form>
      ) : null}

      {view.canEdit ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={onMove}
            disabled={disabled}
          >
            <Move data-icon="inline-start" />
            Move
          </Button>
          {role === "dm" && onHidden ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => onHidden(!view.hidden)}
              disabled={disabled}
            >
              {view.hidden ? (
                <Eye data-icon="inline-start" />
              ) : (
                <EyeOff data-icon="inline-start" />
              )}
              {view.hidden ? "Show players" : "Hide from players"}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            className="ml-auto h-7"
            onClick={onRemove}
            disabled={disabled}
          >
            <Trash2 data-icon="inline-start" />
            Remove
          </Button>
        </div>
      ) : null}
    </HudPanel>
  )
}
