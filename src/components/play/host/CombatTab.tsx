/**
 * The session panel's Combat tab (DM): start combat (the party, or everyone on the level shown), the
 * initiative order with editable initiative and bonus, who acts, hidden entries (kept from players
 * whatever they see), custom entries (lair actions…), NPC initiative rolls and the turn controls. The
 * order players see is filtered by the host (core/session filter.ts): only entries not hidden whose
 * token is in their view.
 */
import * as React from "react"
import {
  ChevronLeft,
  ChevronRight,
  Dices,
  Eye,
  EyeOff,
  Flag,
  Play,
  Plus,
  Swords,
  UserPlus,
  Users,
  X,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { Id, Token } from "@/core/scene/types"
import type { CombatEntry, GameState } from "@/core/session/types"
import { cn } from "@/lib/utils"
import { tokenDisplayName } from "@/play"

import { HealthBar } from "../table/health"
import { TokenAvatar } from "../TokenAvatar"
import type { HostActions } from "./hostActions"

export interface CombatTabProps {
  state: GameState
  actions: HostActions
  selectedTokenId: Id | null
  activeLevelId: Id | null
  onFocusToken(id: Id): void
}

/** Tokens a player controls, and the PCs (the party). */
function partyTokens(state: GameState): Token[] {
  return Object.values(state.scene.tokens).filter(
    (t) =>
      !t.hidden && (t.kind === "pc" || (state.owners[t.id]?.length ?? 0) > 0)
  )
}

export function CombatTab({
  state,
  actions,
  selectedTokenId,
  activeLevelId,
  onFocusToken,
}: CombatTabProps) {
  const combat = state.table?.combat ?? null
  const scene = state.scene
  const [custom, setCustom] = React.useState("")

  if (!combat) {
    const party = partyTokens(state)
    const onLevel = Object.values(scene.tokens).filter(
      (t) => t.levelId === activeLevelId
    )
    return (
      <Empty className="m-3 border border-dashed">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Swords />
          </EmptyMedia>
          <EmptyTitle>No combat running</EmptyTitle>
          <EmptyDescription>
            Start one to track initiative and turns. Players see the order, but
            never a combatant they can't see or one you hide.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="gap-2">
          <Button
            size="sm"
            onClick={() => actions.startCombat(party.map((t) => t.id))}
            disabled={party.length === 0}
          >
            <Users data-icon="inline-start" />
            Start with the party
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => actions.startCombat(onLevel.map((t) => t.id))}
            disabled={onLevel.length === 0}
          >
            <Swords data-icon="inline-start" />
            Everyone on this level ({onLevel.length})
          </Button>
          <p className="text-[0.6875rem] text-muted-foreground">
            You can also add a token from its menu on the map.
          </p>
        </EmptyContent>
      </Empty>
    )
  }

  const inCombat = new Set(
    combat.entries.map((e) => e.tokenId).filter((t) => t !== null)
  )
  const selected =
    selectedTokenId && Object.hasOwn(scene.tokens, selectedTokenId)
      ? scene.tokens[selectedTokenId]
      : null
  const unrolled = combat.entries.filter(
    (e) =>
      e.initiative === null &&
      !(e.tokenId !== null && (state.owners[e.tokenId]?.length ?? 0) > 0)
  ).length
  const addCustom = () => {
    const name = custom.trim()
    if (!name) return
    actions.addCustomCombatant(name, null)
    setCustom("")
  }

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center gap-1 rounded-md border bg-muted/30 p-1">
        <span className="flex flex-1 flex-col px-1.5 leading-tight">
          <span className="text-[0.625rem] tracking-wide text-muted-foreground uppercase">
            Round
          </span>
          <span className="font-heading text-base font-semibold tabular-nums">
            {combat.round}
          </span>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous turn"
          onClick={() => actions.stepTurn(-1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          size="sm"
          onClick={() => actions.stepTurn(1)}
          disabled={combat.entries.length === 0}
        >
          {combat.activeId === null ? "Begin" : "Next turn"}
          <ChevronRight data-icon="inline-end" />
        </Button>
      </div>
      <div className="flex flex-wrap gap-1">
        <Button
          variant="outline"
          size="xs"
          onClick={() => actions.rollNpcInitiative()}
          disabled={unrolled === 0}
        >
          <Dices data-icon="inline-start" />
          Roll for NPCs{unrolled > 0 ? ` (${unrolled})` : ""}
        </Button>
        {selected && !inCombat.has(selected.id) ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() => actions.addToCombat([selected.id])}
          >
            <UserPlus data-icon="inline-start" />
            Add {tokenDisplayName(selected)}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="xs"
          className="ml-auto text-destructive hover:text-destructive"
          onClick={() => actions.endCombat()}
        >
          <Flag data-icon="inline-start" />
          End combat
        </Button>
      </div>

      <ol className="flex flex-col gap-0.5" aria-label="Combatants">
        <li className="flex items-center gap-2 px-1.5 text-[0.625rem] tracking-wide text-muted-foreground uppercase">
          <span className="flex-1">Combatant</span>
          <span className="w-12 text-center">Init</span>
          <span className="w-10 text-center">Bonus</span>
          <span className="w-12" />
        </li>
        {combat.entries.map((e) => (
          <CombatRow
            key={e.id}
            entry={e}
            state={state}
            active={e.id === combat.activeId}
            actions={actions}
            onFocusToken={onFocusToken}
          />
        ))}
        {combat.entries.length === 0 ? (
          <li className="px-1.5 py-3 text-center text-xs text-muted-foreground">
            Nobody yet: add tokens from their menu, or a custom entry below.
          </li>
        ) : null}
      </ol>

      <form
        className="flex items-center gap-1"
        onSubmit={(ev) => {
          ev.preventDefault()
          addCustom()
        }}
      >
        <Input
          value={custom}
          onChange={(ev) => setCustom(ev.target.value)}
          onKeyDown={(ev) => ev.stopPropagation()}
          placeholder="Custom entry, e.g. Lair action"
          aria-label="Custom entry name"
          maxLength={64}
          className="h-7 text-xs"
        />
        <Button
          type="submit"
          size="icon"
          variant="outline"
          aria-label="Add custom entry"
          disabled={!custom.trim()}
        >
          <Plus />
        </Button>
      </form>
    </div>
  )
}

function CombatRow({
  entry: e,
  state,
  active,
  actions,
  onFocusToken,
}: {
  entry: CombatEntry
  state: GameState
  active: boolean
  actions: HostActions
  onFocusToken(id: Id): void
}) {
  const t =
    e.tokenId !== null && Object.hasOwn(state.scene.tokens, e.tokenId)
      ? state.scene.tokens[e.tokenId]
      : null
  const name =
    e.tokenId === null ? e.name : t ? tokenDisplayName(t) : "Removed token"
  const player =
    e.tokenId !== null && (state.owners[e.tokenId]?.length ?? 0) > 0
  const hidden = e.hidden || (t?.hidden ?? false)
  return (
    <li
      className={cn(
        "group/row flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/50",
        active && "bg-sidebar-primary/15 ring-1 ring-sidebar-primary/50"
      )}
      data-entry={e.id}
      aria-current={active ? "step" : undefined}
    >
      <Button
        variant="ghost"
        className="h-auto min-w-0 flex-1 justify-start gap-2 p-0 text-left font-normal hover:bg-transparent dark:hover:bg-transparent"
        onClick={() => (t ? onFocusToken(t.id) : undefined)}
      >
        {t ? (
          <TokenAvatar token={t} size="sm" dimmed={hidden} />
        ) : (
          <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-muted-foreground">
            <Swords className="size-3" />
          </span>
        )}
        <span className="flex min-w-0 flex-col leading-tight">
          <span
            className={cn(
              "truncate text-xs font-medium",
              hidden && "text-muted-foreground"
            )}
          >
            {name}
          </span>
          <span className="truncate text-[0.625rem] text-muted-foreground">
            {active
              ? "Acting now"
              : player
                ? "Player character"
                : e.tokenId === null
                  ? "Custom"
                  : "DM"}
            {hidden ? " · hidden" : ""}
            {t?.hp ? ` · ${t.hp.current}/${t.hp.max} HP` : ""}
            {t?.hp?.temp ? ` +${t.hp.temp}` : ""}
          </span>
          {t?.hp ? <HealthBar hp={t.hp} className="mt-0.5 h-0.5" /> : null}
        </span>
      </Button>
      <NumberCell
        value={e.initiative}
        label={`Initiative of ${name}`}
        className="w-12"
        onCommit={(v) => actions.updateCombatant(e.id, { initiative: v })}
      />
      <NumberCell
        value={e.modifier}
        label={`Initiative bonus of ${name}`}
        className="w-10"
        integer
        onCommit={(v) => actions.updateCombatant(e.id, { modifier: v ?? 0 })}
      />
      <span className="flex w-12 justify-end">
        {active ? (
          <Badge variant="secondary" className="h-5 px-1.5">
            <Play className="size-2.5" />
          </Badge>
        ) : (
          <IconAction
            label="Make it their turn"
            onClick={() => actions.setActiveCombatant(e.id)}
            className="opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
          >
            <Play />
          </IconAction>
        )}
        <IconAction
          label={
            e.hidden
              ? "Hidden from players: click to show"
              : t?.hidden
                ? "The token is hidden: players see neither"
                : "Shown to players who see it: click to hide"
          }
          onClick={() => actions.updateCombatant(e.id, { hidden: !e.hidden })}
        >
          {hidden ? <EyeOff className="text-muted-foreground" /> : <Eye />}
        </IconAction>
        <IconAction
          label="Remove from combat"
          onClick={() => actions.removeFromCombat({ entryId: e.id })}
        >
          <X />
        </IconAction>
      </span>
    </li>
  )
}

function IconAction({
  label,
  onClick,
  className,
  children,
}: {
  label: string
  onClick(): void
  className?: string
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            className={className}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** A number edited in place: committed on Enter or blur; empty means none (null). */
function NumberCell({
  value,
  label,
  className,
  integer,
  onCommit,
}: {
  value: number | null
  label: string
  className?: string
  integer?: boolean
  onCommit(v: number | null): void
}) {
  const [draft, setDraft] = React.useState<string | null>(null)
  const shown = draft ?? (value === null ? "" : String(value))
  const commit = () => {
    if (draft === null) return
    const trimmed = draft.trim()
    const n = trimmed === "" ? null : Number(trimmed)
    setDraft(null)
    if (n !== null && !Number.isFinite(n)) return
    const v = n === null ? null : integer ? Math.round(n) : n
    if (v !== value) onCommit(v)
  }
  return (
    <Input
      value={shown}
      inputMode="decimal"
      aria-label={label}
      placeholder="–"
      className={cn("h-6 px-1 text-center text-xs tabular-nums", className)}
      onChange={(ev) => setDraft(ev.target.value)}
      onBlur={commit}
      onKeyDown={(ev) => {
        ev.stopPropagation()
        if (ev.key === "Enter") commit()
        if (ev.key === "Escape") setDraft(null)
      }}
    />
  )
}
