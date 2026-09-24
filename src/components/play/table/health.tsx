/**
 * Token health and conditions UI shared by the host console and the player view: health bars (exact
 * hit points, or the coarse band players see of creatures they do not control), condition icons and
 * chips, the conditions menu and the hit point editor (damage, healing, temporary and max hit points).
 */
import * as React from "react"
import { Heart, HeartPulse, Plus, Shield, Swords, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  applyDamage,
  applyHealing,
  CONDITION_LABELS,
  healthBand,
  HP_LIMITS,
  TOKEN_CONDITIONS,
  type HealthBand,
  type TokenCondition,
  type TokenHp,
  withMaxHp,
} from "@/core/scene/tokenStatus"
import { cn } from "@/lib/utils"

import { BAND_LABELS, bandClass, CONDITION_ICONS } from "./healthStyle"

/**
 * A slim health bar: exact (`hp`, with temporary hit points as a lighter tail) or a band only (players'
 * view of creatures they do not control: a full bar in the band's colour).
 */
export function HealthBar({
  hp,
  band,
  className,
}: {
  hp?: TokenHp | null
  band?: HealthBand | null
  className?: string
}) {
  const b = hp ? healthBand(hp) : (band ?? null)
  if (!b) return null
  const total = hp ? Math.max(hp.max, hp.current + hp.temp) : 1
  const fill = hp ? hp.current / total : 1
  const temp = hp ? hp.temp / total : 0
  return (
    <div
      className={cn(
        "flex h-1.5 w-full overflow-hidden rounded-full bg-muted",
        className
      )}
      role="meter"
      aria-label={hp ? "Hit points" : "Health"}
      aria-valuemin={0}
      aria-valuemax={hp ? total : 1}
      aria-valuenow={hp ? hp.current : 1}
      aria-valuetext={
        hp
          ? `${hp.current} of ${hp.max}${hp.temp ? ` (+${hp.temp} temporary)` : ""}`
          : BAND_LABELS[b]
      }
    >
      <div
        className={cn("h-full", bandClass(b), !hp && "opacity-80")}
        style={{ width: `${fill * 100}%` }}
      />
      {temp > 0 ? (
        <div
          className="h-full bg-foreground/60"
          style={{ width: `${temp * 100}%` }}
        />
      ) : null}
    </div>
  )
}

/** The conditions as small removable badges. */
export function ConditionChips({
  conditions,
  onRemove,
  className,
}: {
  conditions: readonly TokenCondition[]
  onRemove?: (c: TokenCondition) => void
  className?: string
}) {
  if (conditions.length === 0) return null
  return (
    <div className={cn("flex flex-wrap gap-1", className)}>
      {conditions.map((c) => {
        const Icon = CONDITION_ICONS[c]
        return (
          <Badge key={c} variant="secondary" className="gap-1 pr-1">
            <Icon /> {CONDITION_LABELS[c]}
            {onRemove ? (
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-3.5 rounded-sm"
                aria-label={`Remove ${CONDITION_LABELS[c]}`}
                onClick={() => onRemove(c)}
              >
                <X />
              </Button>
            ) : null}
          </Badge>
        )
      })}
    </div>
  )
}

/** A button opening the list of conditions to tick. */
export function ConditionMenu({
  conditions,
  onChange,
  disabled,
}: {
  conditions: readonly TokenCondition[]
  onChange(next: TokenCondition[]): void
  disabled?: boolean
}) {
  const have = new Set(conditions)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button size="xs" variant="outline" disabled={disabled}>
            <Plus data-icon="inline-start" /> Condition
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="max-h-80 w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Conditions</DropdownMenuLabel>
          {TOKEN_CONDITIONS.map((c) => {
            const Icon = CONDITION_ICONS[c]
            return (
              <DropdownMenuCheckboxItem
                key={c}
                checked={have.has(c)}
                closeOnClick={false}
                onCheckedChange={(on) =>
                  onChange(
                    TOKEN_CONDITIONS.filter((x) => (x === c ? on : have.has(x)))
                  )
                }
              >
                <Icon /> {CONDITION_LABELS[c]}
              </DropdownMenuCheckboxItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Hit points with quick damage and healing. `canSetMax`: the DM also edits max (and can stop tracking);
 * players change current and temporary hit points only.
 */
export function HpEditor({
  hp,
  onChange,
  canSetMax,
  onUntrack,
  disabled,
}: {
  hp: TokenHp
  onChange(next: TokenHp): void
  canSetMax: boolean
  onUntrack?: () => void
  disabled?: boolean
}) {
  const [amount, setAmount] = React.useState("")
  const id = React.useId()
  const n = Math.round(Number(amount))
  const valid = amount.trim() !== "" && Number.isFinite(n) && n > 0
  const apply = (kind: "damage" | "heal" | "temp") => {
    if (!valid) return
    onChange(
      kind === "damage"
        ? applyDamage(hp, n)
        : kind === "heal"
          ? applyHealing(hp, n)
          : { ...hp, temp: Math.min(HP_LIMITS.max, Math.max(hp.temp, n)) }
    )
    setAmount("")
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-1.5">
        <HeartPulse className="size-3.5 translate-y-0.5 text-muted-foreground" />
        <span className="font-heading text-sm font-semibold tabular-nums">
          {hp.current}
        </span>
        <span className="text-xs text-muted-foreground tabular-nums">
          /{" "}
          {canSetMax ? (
            <MaxField hp={hp} onChange={onChange} disabled={disabled} />
          ) : (
            hp.max
          )}
        </span>
        {hp.temp > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge
                  variant="secondary"
                  className="cursor-default gap-1 tabular-nums"
                />
              }
            >
              <Shield /> +{hp.temp}
            </TooltipTrigger>
            <TooltipContent>Temporary hit points (spent first)</TooltipContent>
          </Tooltip>
        ) : null}
        <span className="ml-auto text-[0.6875rem] text-muted-foreground">
          {BAND_LABELS[healthBand(hp)]}
        </span>
      </div>
      <HealthBar hp={hp} />
      <div className="flex items-center gap-1">
        <label htmlFor={id} className="sr-only">
          Amount
        </label>
        <Input
          id={id}
          value={amount}
          inputMode="numeric"
          placeholder="Amount"
          className="h-6 w-16 px-1.5 text-xs tabular-nums"
          disabled={disabled}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Enter") apply(e.shiftKey ? "heal" : "damage")
          }}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || !valid}
          onClick={() => apply("damage")}
        >
          <Swords data-icon="inline-start" /> Damage
        </Button>
        <Button
          size="xs"
          variant="outline"
          disabled={disabled || !valid}
          onClick={() => apply("heal")}
        >
          <Heart data-icon="inline-start" /> Heal
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Set temporary hit points"
                disabled={disabled || !valid}
                onClick={() => apply("temp")}
              />
            }
          >
            <Shield />
          </TooltipTrigger>
          <TooltipContent>
            Temporary hit points (keeps the higher)
          </TooltipContent>
        </Tooltip>
        {onUntrack ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="ml-auto"
                  aria-label="Stop tracking hit points"
                  disabled={disabled}
                  onClick={onUntrack}
                />
              }
            >
              <X />
            </TooltipTrigger>
            <TooltipContent>Stop tracking hit points</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
}

/** Max hit points edited in place (committed on Enter or blur). */
function MaxField({
  hp,
  onChange,
  disabled,
}: {
  hp: TokenHp
  onChange(next: TokenHp): void
  disabled?: boolean
}) {
  const [draft, setDraft] = React.useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const n = Math.round(Number(draft))
    setDraft(null)
    if (!Number.isFinite(n) || n < 1 || n === hp.max) return
    onChange(withMaxHp(hp, n))
  }
  return (
    <Input
      value={draft ?? String(hp.max)}
      inputMode="numeric"
      aria-label="Max hit points"
      disabled={disabled}
      className="inline-flex h-5 w-12 px-1 text-xs tabular-nums"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === "Enter") commit()
        if (e.key === "Escape") setDraft(null)
      }}
    />
  )
}

/** "Track hit points" for a token without them: asks for max. */
export function TrackHp({
  onTrack,
  disabled,
}: {
  onTrack(max: number): void
  disabled?: boolean
}) {
  const [max, setMax] = React.useState("")
  const id = React.useId()
  const n = Math.round(Number(max))
  const ok =
    max.trim() !== "" && Number.isFinite(n) && n >= 1 && n <= HP_LIMITS.max
  return (
    <div className="flex items-center gap-1">
      <HeartPulse className="size-3.5 text-muted-foreground" />
      <label htmlFor={id} className="text-[0.6875rem] text-muted-foreground">
        Max HP
      </label>
      <Input
        id={id}
        value={max}
        inputMode="numeric"
        placeholder="e.g. 27"
        className="h-6 w-16 px-1.5 text-xs tabular-nums"
        disabled={disabled}
        onChange={(e) => setMax(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === "Enter" && ok) {
            onTrack(n)
            setMax("")
          }
        }}
      />
      <Button
        size="xs"
        variant="outline"
        disabled={disabled || !ok}
        onClick={() => {
          onTrack(n)
          setMax("")
        }}
      >
        Track hit points
      </Button>
    </div>
  )
}

/**
 * A token's health section: the hit point editor (or "Track hit points" for the DM), the conditions as
 * removable chips and the conditions menu. `dm`: sets max and starts/stops tracking.
 */
export function TokenHealth({
  hp,
  conditions,
  dm,
  onChange,
  disabled,
}: {
  hp: TokenHp | null
  conditions: readonly TokenCondition[]
  dm: boolean
  onChange(status: { hp?: TokenHp | null; conditions?: TokenCondition[] }): void
  disabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-2" data-slot="token-health">
      {hp ? (
        <HpEditor
          hp={hp}
          canSetMax={dm}
          disabled={disabled}
          onChange={(next) => onChange({ hp: next })}
          onUntrack={dm ? () => onChange({ hp: null }) : undefined}
        />
      ) : dm ? (
        <TrackHp
          disabled={disabled}
          onTrack={(max) => onChange({ hp: { current: max, max, temp: 0 } })}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        <ConditionChips
          conditions={conditions}
          className="contents"
          onRemove={
            disabled
              ? undefined
              : (c) =>
                  onChange({ conditions: conditions.filter((x) => x !== c) })
          }
        />
        <ConditionMenu
          conditions={conditions}
          disabled={disabled}
          onChange={(next) => onChange({ conditions: next })}
        />
      </div>
    </div>
  )
}
