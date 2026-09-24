/**
 * The table: chat, dice rolls and the initiative tracker of a game (docs/ARCHITECTURE.md §6.5).
 *
 * Everything lives in GameState.table and reaches players only through filter.ts `playerTable`:
 *  - messages carry an audience ("all", or the players besides the sender who may read it; [] = the DM
 *    only). Players can talk to everyone or whisper to the DM; the DM can also whisper to players or roll
 *    in secret. Dice are always rolled by the host (the DM's tab), with an unbiased RNG: a player sends a
 *    formula, never a result;
 *  - combat is an ordered list of entries (tokens or custom ones like a lair action) with initiative,
 *    a round and the acting entry. Players see an entry only when the DM has not hidden it and it is a
 *    custom entry or a token in their view, so the order never reveals a creature they cannot see.
 *
 * Reducers are pure: times, ids and dice come from a TableContext (requests) or from the command itself
 * (DM commands carry a TableStamp for the notices they post).
 */
import { cleanText, cryptoDiceRng, parseRoll, rollFormula, type DiceRng } from "../dice/dice"
import { newId as sceneId } from "../scene/factory"
import type { Id } from "../scene/types"
import { emptyDelta, ownsToken, tokenExistsForPlayers, type ReduceResult, type RequestOutcome } from "./state"
import type { ClientToHost, Combat, CombatEntry, DmCommand, GameState, RejectReason, TableMessage, TableStamp, TableState } from "./types"
import { own } from "./util"

export const TABLE_LIMITS = {
  /** Messages kept in the game (the DM's log). */
  maxLog: 200,
  /** Messages in a player's view (the newest they may read). */
  maxViewLog: 60,
  maxText: 500,
  maxName: 64,
  /** Formula + label as typed. */
  maxFormulaInput: 200,
  maxCombatants: 100,
  maxRound: 9999,
  /** |initiative| (decimals allowed, e.g. 15.5 to break a tie). */
  maxInitiative: 999,
  maxModifier: 99,
  /** |bonus| a player may add to their own initiative roll (shown on the roll, like at a real table). */
  maxInitiativeBonus: 20,
} as const

/** How the DM appears at the table. */
export const DM_NAME = "DM"
export const DM_COLOR = "#e0a526"
/** System notices ("Combat started", "Round 2"). */
export const SYSTEM_COLOR = "#8b8f98"

/** Times, ids and dice for request reducers (the host passes Date.now, random ids and crypto dice). */
export interface TableContext {
  now: number
  newId(): Id
  rng: DiceRng
}

export function defaultTableContext(): TableContext {
  return { now: Date.now(), newId: sceneId, rng: cryptoDiceRng() }
}

export const emptyTable = (): TableState => ({ log: [], combat: null })

export function tableOf(state: Pick<GameState, "table">): TableState {
  return state.table ?? emptyTable()
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Whether a player may read a message (its sender, a public message, or one addressed to them). */
export function canRead(m: Pick<TableMessage, "from" | "to">, userId: string): boolean {
  return m.from === userId || m.to === "all" || m.to.includes(userId)
}

/** Players whose views a new message changes. */
function readers(state: GameState, m: TableMessage): string[] | "all" {
  if (m.to === "all") return "all"
  const out = new Set(m.to.filter((u) => Object.hasOwn(state.players, u)))
  if (m.from !== null && Object.hasOwn(state.players, m.from)) out.add(m.from)
  return [...out].sort()
}

/** The log with `m` appended: its time made strictly later than the last one, the oldest dropped past the limit. */
function appendMessage(table: TableState, m: TableMessage): TableState {
  const last = table.log.length > 0 ? table.log[table.log.length - 1].at : -Infinity
  const at = Math.max(Math.round(m.at), Math.floor(last) + 1)
  const log = [...table.log, at === m.at ? m : { ...m, at }]
  return { ...table, log: log.length > TABLE_LIMITS.maxLog ? log.slice(log.length - TABLE_LIMITS.maxLog) : log }
}

function systemMessage(stamp: TableStamp, text: string): TableMessage {
  return { id: stamp.id, at: stamp.at, kind: "system", from: null, name: "", color: SYSTEM_COLOR, to: "all", text }
}

/** A message from the DM (the host fills in the id, time and any roll). */
export function dmMessage(args: { stamp: TableStamp; kind: "chat" | "roll"; to: TableMessage["to"]; text: string; roll?: TableMessage["roll"] }): TableMessage {
  const m: TableMessage = { id: args.stamp.id, at: args.stamp.at, kind: args.kind, from: null, name: DM_NAME, color: DM_COLOR, to: args.to, text: args.text }
  if (args.roll) m.roll = args.roll
  return m
}

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

/** Turn order: initiative high → low (unrolled last), then modifier high → low, then as listed. */
export function sortCombat(entries: readonly CombatEntry[]): CombatEntry[] {
  return entries
    .map((e, k) => ({ e, k }))
    .sort((a, b) => {
      const ia = a.e.initiative
      const ib = b.e.initiative
      if (ia !== ib) {
        if (ia === null) return 1
        if (ib === null) return -1
        return ib - ia
      }
      return b.e.modifier - a.e.modifier || a.k - b.k
    })
    .map((x) => x.e)
}

/** The acting entry (null before the first turn or if it was removed). */
export function activeEntry(combat: Combat | null): CombatEntry | null {
  if (!combat || combat.activeId === null) return null
  return combat.entries.find((e) => e.id === combat.activeId) ?? null
}

/** Next (1) or previous (-1) turn. `newRound`: the order wrapped into a new round. */
export function advanceTurn(combat: Combat, delta: 1 | -1): { combat: Combat; newRound: boolean } {
  const n = combat.entries.length
  if (n === 0) return { combat: { ...combat, activeId: null }, newRound: false }
  const idx = combat.activeId === null ? -1 : combat.entries.findIndex((e) => e.id === combat.activeId)
  const at = (k: number, round = combat.round) => ({ ...combat, round, activeId: combat.entries[k].id })
  if (delta > 0) {
    if (idx < 0) return { combat: at(0), newRound: false }
    if (idx + 1 < n) return { combat: at(idx + 1), newRound: false }
    if (combat.round >= TABLE_LIMITS.maxRound) return { combat: at(0), newRound: false }
    return { combat: at(0, combat.round + 1), newRound: true }
  }
  if (idx < 0) return { combat, newRound: false }
  if (idx > 0) return { combat: at(idx - 1), newRound: false }
  if (combat.round > 1) return { combat: at(n - 1, combat.round - 1), newRound: false }
  return { combat: { ...combat, activeId: null }, newRound: false }
}

/**
 * Combat without these entries. When the acting one goes, the turn passes to the next entry that stays
 * (wrapping into a new round like Next turn: `newRound`), or to nobody when none stays.
 */
export function removeEntries(combat: Combat, ids: ReadonlySet<Id>): { combat: Combat; newRound: boolean } {
  const entries = combat.entries.filter((e) => !ids.has(e.id))
  if (combat.activeId === null || !ids.has(combat.activeId)) return { combat: { ...combat, entries }, newRound: false }
  const idx = combat.entries.findIndex((e) => e.id === combat.activeId)
  const after = combat.entries.slice(idx + 1).find((e) => !ids.has(e.id))
  if (after) return { combat: { ...combat, entries, activeId: after.id }, newRound: false }
  if (entries.length === 0) return { combat: { ...combat, entries, activeId: null }, newRound: false }
  const round = Math.min(TABLE_LIMITS.maxRound, combat.round + 1)
  return { combat: { round, entries, activeId: entries[0].id }, newRound: round !== combat.round }
}

/** Combat entries of tokens that no longer exist removed (after a map edit deleted tokens). */
export function pruneCombat(state: GameState): GameState {
  const combat = state.table?.combat
  if (!combat) return state
  const gone = new Set(combat.entries.filter((e) => e.tokenId !== null && !own(state.scene.tokens, e.tokenId)).map((e) => e.id))
  if (gone.size === 0) return state
  // No notice for a round this starts: reducers make no ids (a map edit carries none).
  return { ...state, table: { ...state.table!, combat: removeEntries(combat, gone).combat } }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)

function clampInitiative(v: number | null): number | null {
  if (v === null || !finite(v)) return null
  const m = TABLE_LIMITS.maxInitiative
  return Math.round(Math.min(m, Math.max(-m, v)) * 100) / 100
}

function clampModifier(v: number): number {
  if (!finite(v)) return 0
  const m = TABLE_LIMITS.maxModifier
  return Math.round(Math.min(m, Math.max(-m, v)))
}

/** A valid entry, or null (unknown token, bad id). */
function cleanEntry(state: GameState, e: CombatEntry): CombatEntry | null {
  if (typeof e.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(e.id)) return null
  if (e.tokenId !== null && !own(state.scene.tokens, e.tokenId)) return null
  return {
    id: e.id,
    tokenId: e.tokenId,
    name: e.tokenId === null ? cleanText(String(e.name ?? ""), TABLE_LIMITS.maxName) || "Custom" : "",
    initiative: clampInitiative(e.initiative),
    modifier: clampModifier(e.modifier),
    hidden: e.hidden === true,
  }
}

/** `existing` plus the valid, new entries of `add` (no duplicate ids or tokens), within the limit. */
function withEntries(state: GameState, existing: readonly CombatEntry[], add: readonly CombatEntry[]): CombatEntry[] {
  const out = [...existing]
  const ids = new Set(out.map((e) => e.id))
  const tokens = new Set(out.map((e) => e.tokenId).filter((t) => t !== null))
  for (const raw of add) {
    if (out.length >= TABLE_LIMITS.maxCombatants) break
    const e = cleanEntry(state, raw)
    if (!e || ids.has(e.id) || (e.tokenId !== null && tokens.has(e.tokenId))) continue
    ids.add(e.id)
    if (e.tokenId !== null) tokens.add(e.tokenId)
    out.push(e)
  }
  return out
}

// ---------------------------------------------------------------------------
// Player requests
// ---------------------------------------------------------------------------

export type TableRequest = Extract<ClientToHost, { t: "say" | "roll" | "initiative" | "end-turn" }>

function rejected(state: GameState, reqId: string, reason: RejectReason): RequestOutcome {
  return { state, delta: emptyDelta(), dirtyPlayers: [], result: { reqId, ok: false, reason }, visited: [], tokenId: null }
}

function accepted(state: GameState, reqId: string, dirtyPlayers: string[] | "all"): RequestOutcome {
  return { state, delta: emptyDelta(), dirtyPlayers, result: { reqId, ok: true }, visited: [], tokenId: null }
}

function withTable(state: GameState, table: TableState): GameState {
  return { ...state, table, seq: state.seq + 1 }
}

/** Say, roll, roll initiative, end the turn. The sender is `userId` (the request topic), never the payload. */
export function reduceTableRequest(state: GameState, userId: string, msg: TableRequest, ctx: TableContext): RequestOutcome {
  const player = own(state.players, userId)
  if (!player) return rejected(state, msg.reqId, "invalid")
  const table = tableOf(state)
  const base = { id: ctx.newId(), at: ctx.now, from: userId, name: player.displayName, color: player.color }
  switch (msg.t) {
    case "say": {
      const text = cleanText(msg.text, TABLE_LIMITS.maxText)
      if (!text) return rejected(state, msg.reqId, "invalid")
      const m: TableMessage = { ...base, kind: "chat", to: msg.to === "dm" ? [] : "all", text }
      return accepted(withTable(state, appendMessage(table, m)), msg.reqId, readers(state, m))
    }
    case "roll": {
      const p = parseRoll(msg.formula)
      if (!p.ok) return rejected(state, msg.reqId, "bad-formula")
      const m: TableMessage = { ...base, kind: "roll", to: msg.to === "dm" ? [] : "all", text: p.label, roll: rollFormula(p.formula, ctx.rng) }
      return accepted(withTable(state, appendMessage(table, m)), msg.reqId, readers(state, m))
    }
    case "initiative": {
      // Authorise before any lookup, like moves: nothing is learnt about tokens the player does not own.
      if (!ownsToken(state, userId, msg.tokenId)) return rejected(state, msg.reqId, "not-owner")
      const combat = table.combat
      const entry = combat?.entries.find((e) => e.tokenId === msg.tokenId)
      // Once: a rolled initiative is the DM's to change (clearing it allows another roll).
      if (!combat || !entry || entry.hidden || entry.initiative !== null || !tokenExistsForPlayers(state, msg.tokenId)) {
        return rejected(state, msg.reqId, "cannot")
      }
      const bonus = msg.bonus
      if (!Number.isInteger(bonus) || Math.abs(bonus) > TABLE_LIMITS.maxInitiativeBonus) return rejected(state, msg.reqId, "invalid")
      // The host writes the formula: the player chooses only the bonus, which everyone sees on the roll.
      const formula = parseRoll(bonus === 0 ? "1d20" : `1d20${bonus > 0 ? "+" : "-"}${Math.abs(bonus)}`)
      if (!formula.ok) return rejected(state, msg.reqId, "invalid")
      const roll = rollFormula(formula.formula, ctx.rng)
      const entries = sortCombat(
        combat.entries.map((e) => (e.id === entry.id ? { ...e, initiative: clampInitiative(roll.total), modifier: clampModifier(bonus) } : e))
      )
      const m: TableMessage = { ...base, kind: "roll", to: "all", text: "Initiative", roll }
      return accepted(withTable(state, appendMessage({ ...table, combat: { ...combat, entries } }, m)), msg.reqId, "all")
    }
    case "end-turn": {
      const combat = table.combat
      const entry = activeEntry(combat)
      // The turn the player meant: a late or repeated click must not end the next one.
      if (
        !combat ||
        !entry ||
        entry.id !== msg.entryId ||
        entry.tokenId === null ||
        !ownsToken(state, userId, entry.tokenId) ||
        !tokenExistsForPlayers(state, entry.tokenId)
      ) {
        return rejected(state, msg.reqId, "cannot")
      }
      const next = advanceTurn(combat, 1)
      let t: TableState = { ...table, combat: next.combat }
      if (next.newRound) t = appendMessage(t, systemMessage({ id: ctx.newId(), at: ctx.now }, `Round ${next.combat.round}`))
      return accepted(withTable(state, t), msg.reqId, "all")
    }
  }
}

// ---------------------------------------------------------------------------
// DM commands
// ---------------------------------------------------------------------------

export type TableCommand = Extract<
  DmCommand,
  {
    t: "table-post" | "table-clear-log" | "combat-start" | "combat-end" | "combat-add" | "combat-remove" | "combat-update" | "combat-turn" | "combat-set-active"
  }
>

export function isTableCommand(cmd: DmCommand): cmd is TableCommand {
  return cmd.t.startsWith("table-") || cmd.t.startsWith("combat-")
}

const unchanged = (state: GameState, error?: string): ReduceResult => {
  const out: ReduceResult = { state, delta: emptyDelta(), dirtyPlayers: [] }
  if (error) out.error = error
  return out
}

const changed = (state: GameState, table: TableState, dirtyPlayers: string[] | "all" = "all"): ReduceResult => ({
  state: withTable(state, table),
  delta: emptyDelta(),
  dirtyPlayers,
})

/** A DM-built message, bounded (the DM is trusted, but the state must stay loadable). */
function cleanDmMessage(state: GameState, m: TableMessage): TableMessage | null {
  if (typeof m.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(m.id) || !finite(m.at)) return null
  // Recipients: players of this game (nobody else could read it; the saved state stays loadable).
  const to =
    m.to === "all" ? "all" : Array.isArray(m.to) ? [...new Set(m.to.filter((u) => typeof u === "string" && Object.hasOwn(state.players, u)))].sort() : null
  if (to === null) return null
  const out: TableMessage = {
    id: m.id,
    at: Math.round(m.at),
    kind: m.kind === "roll" || m.kind === "system" ? m.kind : "chat",
    from: null,
    name: cleanText(String(m.name ?? ""), TABLE_LIMITS.maxName),
    color: /^#[0-9a-fA-F]{6}$/.test(m.color) ? m.color : DM_COLOR,
    to,
    text: cleanText(String(m.text ?? ""), TABLE_LIMITS.maxText),
  }
  if (m.roll) out.roll = m.roll
  if (out.kind === "roll" && !out.roll) return null
  if (out.kind !== "roll" && !out.text) return null
  return out
}

export function reduceTableDm(state: GameState, cmd: TableCommand): ReduceResult {
  const table = tableOf(state)
  const combat = table.combat
  switch (cmd.t) {
    case "table-post": {
      const m = cleanDmMessage(state, cmd.message)
      if (!m) return unchanged(state, "invalid message")
      return changed(state, appendMessage(table, m), readers(state, m))
    }
    case "table-clear-log":
      if (table.log.length === 0) return unchanged(state)
      return changed(state, { ...table, log: [] })
    case "combat-start": {
      const entries = sortCombat(withEntries(state, [], cmd.entries))
      return changed(state, appendMessage({ ...table, combat: { round: 1, activeId: null, entries } }, systemMessage(cmd.stamp, "Combat started")))
    }
    case "combat-end":
      if (!combat) return unchanged(state)
      return changed(state, appendMessage({ ...table, combat: null }, systemMessage(cmd.stamp, "Combat ended")))
    case "combat-add": {
      if (!combat) return unchanged(state, "no combat")
      const entries = withEntries(state, combat.entries, cmd.entries)
      if (entries.length === combat.entries.length) return unchanged(state)
      return changed(state, { ...table, combat: { ...combat, entries: sortCombat(entries) } })
    }
    case "combat-remove": {
      if (!combat) return unchanged(state, "no combat")
      if (!combat.entries.some((e) => e.id === cmd.entryId)) return unchanged(state)
      const r = removeEntries(combat, new Set([cmd.entryId]))
      let t: TableState = { ...table, combat: r.combat }
      if (r.newRound) t = appendMessage(t, systemMessage(cmd.stamp, `Round ${r.combat.round}`))
      return changed(state, t)
    }
    case "combat-update": {
      if (!combat) return unchanged(state, "no combat")
      const byId = new Map(cmd.updates.map((u) => [u.entryId, u.patch]))
      let any = false
      const entries = combat.entries.map((e) => {
        const p = byId.get(e.id)
        if (!p) return e
        const next: CombatEntry = { ...e }
        if (p.initiative !== undefined) next.initiative = clampInitiative(p.initiative)
        if (p.modifier !== undefined) next.modifier = clampModifier(p.modifier)
        if (p.hidden !== undefined) next.hidden = p.hidden === true
        if (p.name !== undefined && e.tokenId === null) next.name = cleanText(String(p.name), TABLE_LIMITS.maxName) || e.name
        if (next.initiative !== e.initiative || next.modifier !== e.modifier || next.hidden !== e.hidden || next.name !== e.name) any = true
        return next
      })
      if (!any) return unchanged(state)
      return changed(state, { ...table, combat: { ...combat, entries: sortCombat(entries) } })
    }
    case "combat-turn": {
      if (!combat) return unchanged(state, "no combat")
      const next = advanceTurn(combat, cmd.delta)
      if (next.combat.activeId === combat.activeId && next.combat.round === combat.round) return unchanged(state)
      let t: TableState = { ...table, combat: next.combat }
      if (next.newRound) t = appendMessage(t, systemMessage(cmd.stamp, `Round ${next.combat.round}`))
      return changed(state, t)
    }
    case "combat-set-active": {
      if (!combat) return unchanged(state, "no combat")
      if (cmd.entryId !== null && !combat.entries.some((e) => e.id === cmd.entryId)) return unchanged(state, "unknown entry")
      if (combat.activeId === cmd.entryId) return unchanged(state)
      return changed(state, { ...table, combat: { ...combat, activeId: cmd.entryId } })
    }
  }
}

/**
 * The table after a player's user id changed (guest merge, `rebind-player`): their messages and whispers
 * follow them.
 */
export function rebindTable(table: TableState | undefined, from: string, to: string): TableState | undefined {
  if (!table) return table
  const swap = (u: string) => (u === from ? to : u)
  return {
    ...table,
    log: table.log.map((m) =>
      m.from === from || (m.to !== "all" && m.to.includes(from))
        ? { ...m, from: m.from === null ? null : swap(m.from), to: m.to === "all" ? "all" : [...new Set(m.to.map(swap))].sort() }
        : m
    ),
  }
}

// ---------------------------------------------------------------------------
// DM command builders (the DM's tab is the host: its dice are the table's dice)
// ---------------------------------------------------------------------------

export function tableStamp(ctx: Pick<TableContext, "now" | "newId">): TableStamp {
  return { id: ctx.newId(), at: ctx.now }
}

/** The DM says something (`to`: everyone, these players, or [] for a note only the DM sees). null when empty. */
export function dmSayCommand(text: string, to: TableMessage["to"], ctx: TableContext): DmCommand | null {
  const clean = cleanText(text, TABLE_LIMITS.maxText)
  if (!clean) return null
  return { t: "table-post", message: dmMessage({ stamp: tableStamp(ctx), kind: "chat", to, text: clean }) }
}

/** The DM rolls "formula [label]" (`to` as for dmSayCommand; [] is a secret roll). */
export function dmRollCommand(
  input: string,
  to: TableMessage["to"],
  ctx: TableContext
): { ok: true; cmd: DmCommand; total: number } | { ok: false; error: string } {
  const p = parseRoll(input)
  if (!p.ok) return p
  const roll = rollFormula(p.formula, ctx.rng)
  return { ok: true, cmd: { t: "table-post", message: dmMessage({ stamp: tableStamp(ctx), kind: "roll", to, text: p.label, roll }) }, total: roll.total }
}

/**
 * Roll 1d20 + modifier for these entries (default: every entry without initiative whose token no player
 * controls, i.e. the DM's creatures and custom entries). null when there is nothing to roll.
 */
export function npcInitiativeCommand(state: GameState, entryIds: Id[] | null, ctx: Pick<TableContext, "rng">): DmCommand | null {
  const combat = tableOf(state).combat
  if (!combat) return null
  const controlled = (tokenId: Id | null) => tokenId !== null && (own(state.owners, tokenId)?.length ?? 0) > 0
  const picked =
    entryIds === null ? combat.entries.filter((e) => e.initiative === null && !controlled(e.tokenId)) : combat.entries.filter((e) => entryIds.includes(e.id))
  if (picked.length === 0) return null
  return { t: "combat-update", updates: picked.map((e) => ({ entryId: e.id, patch: { initiative: ctx.rng(20) + e.modifier } })) }
}
