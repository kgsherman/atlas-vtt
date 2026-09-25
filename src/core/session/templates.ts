/**
 * Areas of effect on the map (spell templates, docs/ARCHITECTURE.md §6.6): GameState.templates.
 *
 *  - Players place, move and remove their own templates (`template`, `template-remove` requests); the DM
 *    places, changes and removes anyone's (`template-set`, `template-delete` commands) and can keep one
 *    hidden from players.
 *  - A template stands on a level, or is carried by a token (an aura: it follows the token). A player may
 *    place one only on a level their view shows as explored (like pings, so templates cannot probe for
 *    levels), or carried by a token they control.
 *  - Each player keeps at most TEMPLATE_LIMITS.perPlayer; placing another removes their oldest. The game
 *    keeps at most TEMPLATE_LIMITS.max; beyond that the oldest go.
 *  - Templates reach players only through filter.ts `playerTemplates`. What an area reaches is computed by
 *    each viewer (core/area) from the geometry they have, so it never needs to travel.
 *
 * Reducers are pure: new ids come from the request context (TableContext) or with the DM's command.
 */
import { areaAroundToken } from "../area/effect"
import { normalizeArea } from "../area/shape"
import { AREA_LIMITS, type AreaGeometry } from "../area/types"
import { cleanText } from "../dice/dice"
import { levelById } from "../scene/queries"
import { SCENE_LIMITS } from "../scene/schema"
import type { GridSettings, Id, Token } from "../scene/types"
import { levelKnown } from "./filter"
import { emptyDelta, ownsToken, tokenExistsForPlayers, type ReduceResult, type RequestOutcome } from "./state"
import type { TableContext } from "./table"
import type { AreaTemplate, AreaTemplateInput, ClientToHost, DmCommand, GameState, PlayerView, RejectReason } from "./types"
import { own } from "./util"

export const TEMPLATE_LIMITS = {
  /** Templates in a game (the oldest go first beyond it). */
  max: 64,
  /** Templates one player keeps (placing another removes their oldest). */
  perPlayer: 6,
} as const

/** Default template colour (a player's own colour is used when they send none that parses). */
export const DEFAULT_TEMPLATE_COLOR = "#f97316"

const COLOR = /^#[0-9a-fA-F]{6}$/
const ID = /^[A-Za-z0-9_-]{1,64}$/

export function templatesOf(state: Pick<GameState, "templates">): AreaTemplate[] {
  return state.templates ?? []
}

function inScene(grid: GridSettings, x: number, z: number): boolean {
  const m = SCENE_LIMITS.coordMargin
  return x >= -m && z >= -m && x <= grid.width * grid.cellSize + m && z <= grid.depth * grid.cellSize + m
}

/** The geometry fields of a template or input, normalised (core/area normalizeArea). */
function geometryOf(t: AreaGeometry): AreaGeometry {
  return normalizeArea({
    shape: t.shape,
    levelId: t.levelId,
    x: t.x,
    z: t.z,
    elevation: t.elevation,
    angle: t.angle,
    size: t.size,
    width: t.width,
    height: t.height,
  })
}

/**
 * The area a template covers now: where it stands, or around the token carrying it (on the token's level,
 * round shapes measured from the edge of its space). `tokens`: the scene's (the DM) or the view's (a player).
 */
export function templateArea(
  t: AreaGeometry & { tokenId: Id | null },
  tokens: Readonly<Record<Id, Pick<Token, "levelId" | "position" | "size">>>,
  cellSize: number
): AreaGeometry {
  const g = geometryOf(t)
  const carrier = t.tokenId === null ? undefined : own(tokens, t.tokenId)
  return carrier ? areaAroundToken(g, carrier, cellSize) : g
}

/** State with this template list (oldest first, bounded). */
function withTemplates(state: GameState, templates: AreaTemplate[]): GameState {
  const list = templates.length > TEMPLATE_LIMITS.max ? templates.slice(templates.length - TEMPLATE_LIMITS.max) : templates
  const next: GameState = { ...state, seq: state.seq + 1 }
  if (list.length > 0) next.templates = list
  else delete next.templates
  return next
}

// ---------------------------------------------------------------------------
// Player requests
// ---------------------------------------------------------------------------

export type TemplateRequest = Extract<ClientToHost, { t: "template" | "template-remove" }>

export interface TemplateRequestContext {
  /** The view last sent to this player (null before the first snapshot). */
  currentView: PlayerView | null
  table: Pick<TableContext, "newId">
}

function rejected(state: GameState, reqId: string, reason: RejectReason): RequestOutcome {
  return { state, delta: emptyDelta(), dirtyPlayers: [], result: { reqId, ok: false, reason }, visited: [], tokenId: null }
}

function accepted(state: GameState, reqId: string): RequestOutcome {
  return { state, delta: emptyDelta(), dirtyPlayers: "all", result: { reqId, ok: true }, visited: [], tokenId: null }
}

/** A player's template from their input, or a reject reason. */
function playerTemplate(state: GameState, userId: string, input: AreaTemplateInput, id: Id, view: PlayerView | null): AreaTemplate | RejectReason {
  const player = own(state.players, userId)
  if (!player) return "invalid"
  let geometry = geometryOf(input)
  if (input.tokenId !== null) {
    // Authorise before any lookup, like moves: nothing is learnt about tokens the player does not own.
    if (!ownsToken(state, userId, input.tokenId)) return "not-owner"
    const carrier = tokenExistsForPlayers(state, input.tokenId)
    if (!carrier) return "cannot"
    geometry = { ...geometry, levelId: carrier.levelId, x: carrier.position.x, z: carrier.position.z }
  } else {
    if (!levelKnown(view, geometry.levelId) || !levelById(state.scene, geometry.levelId)) return "invalid"
    if (!inScene(state.scene.grid, geometry.x, geometry.z)) return "invalid"
  }
  return {
    id,
    ...geometry,
    owner: userId,
    label: cleanText(String(input.label ?? ""), AREA_LIMITS.maxLabel),
    color: COLOR.test(input.color) ? input.color.toLowerCase() : player.color,
    tokenId: input.tokenId,
    hidden: false,
  }
}

/** Place, move or remove a player's own template. The sender is `userId` (the request topic), never the payload. */
export function reduceTemplateRequest(state: GameState, userId: string, msg: TemplateRequest, ctx: TemplateRequestContext): RequestOutcome {
  if (!own(state.players, userId)) return rejected(state, msg.reqId, "invalid")
  const list = templatesOf(state)
  switch (msg.t) {
    case "template": {
      if (msg.id !== undefined) {
        const cur = list.find((t) => t.id === msg.id)
        if (!cur || cur.owner !== userId) return rejected(state, msg.reqId, "cannot")
        const t = playerTemplate(state, userId, msg.template, cur.id, ctx.currentView)
        if (typeof t === "string") return rejected(state, msg.reqId, t)
        return accepted(
          withTemplates(
            state,
            list.map((x) => (x.id === cur.id ? t : x))
          ),
          msg.reqId
        )
      }
      const t = playerTemplate(state, userId, msg.template, ctx.table.newId(), ctx.currentView)
      if (typeof t === "string") return rejected(state, msg.reqId, t)
      // Keep the player's newest perPlayer − 1, then add this one.
      const mine = list.filter((x) => x.owner === userId)
      const drop = new Set(mine.slice(0, Math.max(0, mine.length - (TEMPLATE_LIMITS.perPlayer - 1))).map((x) => x.id))
      return accepted(withTemplates(state, [...list.filter((x) => !drop.has(x.id)), t]), msg.reqId)
    }
    case "template-remove": {
      const cur = list.find((t) => t.id === msg.id)
      if (!cur || cur.owner !== userId) return rejected(state, msg.reqId, "cannot")
      return accepted(
        withTemplates(
          state,
          list.filter((x) => x.id !== cur.id)
        ),
        msg.reqId
      )
    }
  }
}

// ---------------------------------------------------------------------------
// DM commands
// ---------------------------------------------------------------------------

export type TemplateCommand = Extract<DmCommand, { t: "template-set" | "template-delete" }>

export function isTemplateCommand(cmd: DmCommand): cmd is TemplateCommand {
  return cmd.t === "template-set" || cmd.t === "template-delete"
}

const unchanged = (state: GameState, error?: string): ReduceResult => {
  const out: ReduceResult = { state, delta: emptyDelta(), dirtyPlayers: [] }
  if (error) out.error = error
  return out
}

/** A DM-built template, bounded (the DM is trusted, but the state must stay loadable), or null. */
export function cleanTemplate(state: Pick<GameState, "scene" | "players">, t: AreaTemplate): AreaTemplate | null {
  if (typeof t.id !== "string" || !ID.test(t.id)) return null
  const owner = t.owner === null ? null : typeof t.owner === "string" && Object.hasOwn(state.players, t.owner) ? t.owner : undefined
  if (owner === undefined) return null
  const tokenId = t.tokenId === null ? null : typeof t.tokenId === "string" && own(state.scene.tokens, t.tokenId) ? t.tokenId : undefined
  if (tokenId === undefined) return null
  const geometry = geometryOf(t)
  if (tokenId === null && (!levelById(state.scene, geometry.levelId) || !inScene(state.scene.grid, geometry.x, geometry.z))) return null
  return {
    id: t.id,
    ...geometry,
    owner,
    label: cleanText(String(t.label ?? ""), AREA_LIMITS.maxLabel),
    color: typeof t.color === "string" && COLOR.test(t.color) ? t.color.toLowerCase() : DEFAULT_TEMPLATE_COLOR,
    tokenId,
    hidden: t.hidden === true,
  }
}

export function reduceTemplateDm(state: GameState, cmd: TemplateCommand): ReduceResult {
  const list = templatesOf(state)
  switch (cmd.t) {
    case "template-set": {
      const t = cleanTemplate(state, cmd.template)
      if (!t) return unchanged(state, "invalid template")
      const k = list.findIndex((x) => x.id === t.id)
      const next = k < 0 ? [...list, t] : list.map((x, n) => (n === k ? t : x))
      return { state: withTemplates(state, next), delta: emptyDelta(), dirtyPlayers: "all" }
    }
    case "template-delete": {
      const drop = cmd.ids === null ? null : new Set(cmd.ids)
      const next = drop === null ? [] : list.filter((x) => !drop.has(x.id))
      if (next.length === list.length) return unchanged(state)
      return { state: withTemplates(state, next), delta: emptyDelta(), dirtyPlayers: "all" }
    }
  }
}

// ---------------------------------------------------------------------------
// Bookkeeping after other changes
// ---------------------------------------------------------------------------

/** Templates whose level or carrier token no longer exists removed (after a map edit). */
export function pruneTemplates(state: GameState): GameState {
  const list = state.templates
  if (!list) return state
  const keep = list.filter((t) => (t.tokenId === null ? levelById(state.scene, t.levelId) !== undefined : own(state.scene.tokens, t.tokenId) !== undefined))
  if (keep.length === list.length) return state
  const next: GameState = { ...state }
  if (keep.length > 0) next.templates = keep
  else delete next.templates
  return next
}

/** Templates without a player's (they left the game). */
export function withoutPlayerTemplates(templates: AreaTemplate[] | undefined, userId: string): AreaTemplate[] | undefined {
  if (!templates) return templates
  const keep = templates.filter((t) => t.owner !== userId)
  return keep.length > 0 ? keep : undefined
}

/** Templates after a player's user id changed (guest merge, `rebind-player`): theirs follow them. */
export function rebindTemplates(templates: AreaTemplate[] | undefined, from: string, to: string): AreaTemplate[] | undefined {
  if (!templates) return templates
  return templates.map((t) => (t.owner === from ? { ...t, owner: to } : t))
}
