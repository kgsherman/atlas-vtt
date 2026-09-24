/**
 * The initiative order at the top of the map while combat runs (DM and players): the round, each
 * combatant with its initiative, the acting one highlighted. The DM steps turns back and forth; a
 * player rolls initiative for their own characters and ends their own turn. Players only ever get the
 * entries they may see (core/session filter.ts), so this renders what it is given.
 */
import * as React from "react"
import {
  ChevronLeft,
  ChevronRight,
  Dices,
  EyeOff,
  Hourglass,
  Swords,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { Token } from "@/core/scene/types"
import { TABLE_LIMITS } from "@/core/session/table"
import { cn } from "@/lib/utils"

import { HudButton, HudPanel } from "../hud"
import { TokenAvatar } from "../TokenAvatar"

export interface TurnStripEntry {
  id: string
  name: string
  initiative: number | null
  /** The token's look (avatar), or null for a custom entry. */
  token: Pick<Token, "name" | "label" | "color" | "imageUrl"> | null
  tokenId: string | null
  /** A character this player controls. */
  mine: boolean
  /** DM only: kept from players. */
  hidden?: boolean
}

export interface TurnStripProps {
  round: number
  activeId: string | null
  entries: TurnStripEntry[]
  role: "player" | "dm"
  onStep?(delta: 1 | -1): void
  onEndTurn?(): void
  onRollInitiative?(tokenId: string, modifier: number): void
  onFocus?(tokenId: string): void
  /** Why actions are off right now (offline…). */
  disabled?: boolean
}

const MOD_KEY = "atlas-play:initiative-mod:"
const MAX_BONUS = TABLE_LIMITS.maxInitiativeBonus

function storedModifier(tokenId: string): number {
  try {
    const v = Number(localStorage.getItem(MOD_KEY + tokenId))
    return Number.isInteger(v) && Math.abs(v) <= MAX_BONUS ? v : 0
  } catch {
    return 0
  }
}

export function TurnStrip({
  round,
  activeId,
  entries,
  role,
  onStep,
  onEndTurn,
  onRollInitiative,
  onFocus,
  disabled,
}: TurnStripProps) {
  const active = entries.find((e) => e.id === activeId) ?? null
  const listRef = React.useRef<HTMLOListElement>(null)
  React.useEffect(() => {
    const el = listRef.current?.querySelector("[data-active=true]")
    el?.scrollIntoView({
      block: "nearest",
      inline: "center",
      behavior: "smooth",
    })
  }, [activeId])

  return (
    <HudPanel
      className="flex max-w-[min(56rem,calc(100vw-2rem))] items-center gap-1 p-1"
      role="region"
      aria-label="Initiative order"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 flex-col items-center px-2 leading-none">
        <span className="text-[0.625rem] tracking-wide text-muted-foreground uppercase">
          Round
        </span>
        <span className="font-heading text-base font-semibold tabular-nums">
          {round}
        </span>
      </div>
      {role === "dm" ? (
        <HudButton
          label="Previous turn"
          icon={<ChevronLeft />}
          side="bottom"
          onClick={() => onStep?.(-1)}
          disabled={disabled}
        />
      ) : null}
      <ol
        ref={listRef}
        className="flex min-w-0 [scrollbar-width:none] items-center gap-1 overflow-x-auto"
      >
        {entries.length === 0 ? (
          <li className="px-2 text-xs text-muted-foreground">
            {role === "dm"
              ? "No combatants yet: add tokens from their menu or the Combat tab"
              : "Waiting for the DM…"}
          </li>
        ) : (
          entries.map((e) => (
            <li
              key={e.id}
              data-active={e.id === activeId || undefined}
              data-entry={e.id}
            >
              <EntryChip
                entry={e}
                active={e.id === activeId}
                role={role}
                disabled={disabled}
                onFocus={onFocus}
                onRollInitiative={onRollInitiative}
              />
            </li>
          ))
        )}
      </ol>
      {role === "dm" ? (
        <HudButton
          label={activeId === null ? "Start the first turn" : "Next turn"}
          icon={<ChevronRight />}
          side="bottom"
          onClick={() => onStep?.(1)}
          disabled={disabled || entries.length === 0}
        />
      ) : active?.mine ? (
        <Button
          size="sm"
          className="ml-1 h-7 shrink-0"
          onClick={onEndTurn}
          disabled={disabled}
        >
          <Hourglass data-icon="inline-start" />
          End turn
        </Button>
      ) : null}
    </HudPanel>
  )
}

function EntryChip({
  entry: e,
  active,
  role,
  disabled,
  onFocus,
  onRollInitiative,
}: {
  entry: TurnStripEntry
  active: boolean
  role: "player" | "dm"
  disabled?: boolean
  onFocus?(tokenId: string): void
  onRollInitiative?(tokenId: string, modifier: number): void
}) {
  const canRoll =
    role === "player" && e.mine && e.initiative === null && e.tokenId !== null
  return (
    <div
      className={cn(
        "flex h-9 items-center gap-1.5 rounded-md border border-transparent py-1 pr-1.5 pl-1 text-xs transition-colors",
        active && "border-sidebar-primary/60 bg-sidebar-primary/15",
        e.hidden && "opacity-60"
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              className="h-auto min-w-0 justify-start gap-1.5 rounded-sm p-0 text-left text-xs hover:bg-transparent dark:hover:bg-transparent"
              onClick={() => (e.tokenId ? onFocus?.(e.tokenId) : undefined)}
              aria-current={active ? "step" : undefined}
            />
          }
        >
          {e.token ? (
            <TokenAvatar token={e.token} size="sm" className="size-6" />
          ) : (
            <span className="grid size-6 place-items-center rounded-full bg-muted text-muted-foreground">
              <Swords className="size-3" />
            </span>
          )}
          <span
            className={cn(
              "max-w-24 truncate font-medium",
              e.mine && "text-sidebar-primary"
            )}
          >
            {e.name || "Unknown"}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {e.name || "Unknown"}
          {e.mine ? " (yours)" : ""}
          {e.hidden ? " · hidden from players" : ""}
          {active ? " · acting now" : ""}
        </TooltipContent>
      </Tooltip>
      {e.hidden ? <EyeOff className="size-3 text-muted-foreground" /> : null}
      {canRoll ? (
        <InitiativeRoll
          tokenId={e.tokenId!}
          name={e.name}
          disabled={disabled}
          onRoll={onRollInitiative}
        />
      ) : (
        <span
          className={cn(
            "min-w-5 rounded bg-muted px-1 text-center font-mono text-[0.6875rem] tabular-nums",
            e.initiative === null && "text-muted-foreground"
          )}
          aria-label={
            e.initiative === null
              ? "No initiative yet"
              : `Initiative ${e.initiative}`
          }
        >
          {e.initiative ?? "–"}
        </span>
      )}
    </div>
  )
}

function InitiativeRoll({
  tokenId,
  name,
  disabled,
  onRoll,
}: {
  tokenId: string
  name: string
  disabled?: boolean
  onRoll?(tokenId: string, modifier: number): void
}) {
  const [open, setOpen] = React.useState(false)
  const [mod, setMod] = React.useState(() => String(storedModifier(tokenId)))
  const id = React.useId()
  const roll = () => {
    const m = Math.max(
      -MAX_BONUS,
      Math.min(MAX_BONUS, Math.round(Number(mod) || 0))
    )
    try {
      localStorage.setItem(MOD_KEY + tokenId, String(m))
    } catch {
      // ignore
    }
    onRoll?.(tokenId, m)
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="xs"
            className="h-6"
            disabled={disabled}
            aria-label={`Roll initiative for ${name}`}
          />
        }
      >
        <Dices data-icon="inline-start" />
        Roll
      </PopoverTrigger>
      <PopoverContent side="bottom" className="w-56">
        <PopoverHeader>
          <PopoverTitle>Roll initiative</PopoverTitle>
          <PopoverDescription>
            The DM's table rolls 1d20 plus your bonus for {name}.
          </PopoverDescription>
        </PopoverHeader>
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor={id} className="text-xs">
              Initiative bonus
            </Label>
            <Input
              id={id}
              type="number"
              inputMode="numeric"
              min={-MAX_BONUS}
              max={MAX_BONUS}
              value={mod}
              onChange={(ev) => setMod(ev.target.value)}
              onKeyDown={(ev) => {
                ev.stopPropagation()
                if (ev.key === "Enter") roll()
              }}
              className="h-7"
            />
          </div>
          <Button size="sm" className="h-7" onClick={roll}>
            <Dices data-icon="inline-start" />
            Roll
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}
