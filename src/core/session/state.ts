/**
 * GameState construction and the small shared helpers of core/session (docs/ARCHITECTURE.md §6.2):
 * who controls which token, whose eyes a player sees through, effective movement locks, and the
 * result shapes of the reducers.
 */
import { anchorPosition } from "../movement"
import type { PathStep } from "../movement/types"
import { TOKEN_COLORS } from "../scene/defaults"
import { levelById } from "../scene/queries"
import type { Id, Scene, Token } from "../scene/types"
import { SUBCELLS, type VisibilityResult } from "../vision/types"
import { GAME_STATE_VERSION, type GameState, type RequestResult, type SceneOrigin } from "./types"
import { own } from "./util"

/** Ids touched by a state change (drives vision updates, engine updates and dirty players). */
export interface SceneDelta {
  objects: Id[]
  tokens: Id[]
  terrain: Id[]
  structure: boolean
}

export interface ReduceResult {
  state: GameState
  delta: SceneDelta
  /** Players whose views may have changed. "all" when unknown. */
  dirtyPlayers: string[] | "all"
  /** Set when a command could not be applied (the state is then unchanged). */
  error?: string
}

export interface RequestOutcome extends ReduceResult {
  result: RequestResult
  /** For applied moves: the positions visited (each needs a visibility pass for explored/memory). */
  visited: PathStep[]
  tokenId: Id | null
}

export const emptyDelta = (): SceneDelta => ({ objects: [], tokens: [], terrain: [], structure: false })

export function isEmptyDelta(d: SceneDelta): boolean {
  return !d.structure && d.objects.length === 0 && d.tokens.length === 0 && d.terrain.length === 0
}

export { own }

export function createGameState(args: { sessionId: string; roomCode: string; scene: Scene; origin?: SceneOrigin | null }): GameState {
  const state: GameState = {
    stateVersion: GAME_STATE_VERSION,
    sessionId: args.sessionId,
    roomCode: args.roomCode,
    scene: args.scene,
    players: {},
    owners: {},
    movementLocked: false,
    sharedVision: false,
    enforceSpeed: false,
    explored: {},
    memory: {},
    revealed: {},
    seq: 0,
  }
  if (args.origin !== undefined) state.origin = args.origin && { ...args.origin }
  return state
}

/** Colour for a newly added player (cycles through the token palette). */
export function nextPlayerColor(state: GameState): string {
  return TOKEN_COLORS[Object.keys(state.players).length % TOKEN_COLORS.length]
}

/** A token that exists for players: present, not hidden, on an existing level. */
export function tokenExistsForPlayers(state: Pick<GameState, "scene">, id: Id): Token | undefined {
  const t = own(state.scene.tokens, id)
  if (!t || t.hidden || !levelById(state.scene, t.levelId)) return undefined
  return t
}

/** Whether the player is listed as an owner of the token (owners is the single source of control). */
export function ownsToken(state: Pick<GameState, "owners">, userId: string, tokenId: Id): boolean {
  const owners = own(state.owners, tokenId)
  return owners !== undefined && owners.includes(userId)
}

/** Tokens the player controls (owners), excluding hidden ones. Sorted by id. */
export function controlledTokenIds(state: GameState, userId: string): Id[] {
  const out: Id[] = []
  for (const tokenId of Object.keys(state.owners)) {
    if (ownsToken(state, userId, tokenId) && tokenExistsForPlayers(state, tokenId)) out.push(tokenId)
  }
  return out.sort()
}

/**
 * Token ids whose eyes the player sees through: the player's own tokens, plus — when shared vision is
 * on and the player owns at least one PC — every PC token owned by a player of the session (each such
 * owner owns ≥ 1 PC by definition). Hidden tokens never act as viewers.
 */
export function viewerTokenIds(state: GameState, userId: string): Id[] {
  const own_ = controlledTokenIds(state, userId)
  const out = new Set(own_)
  if (state.sharedVision && own_.some((id) => state.scene.tokens[id].kind === "pc")) {
    for (const [tokenId, owners] of Object.entries(state.owners)) {
      const t = tokenExistsForPlayers(state, tokenId)
      if (!t || t.kind !== "pc") continue
      if (owners.some((uid) => Object.hasOwn(state.players, uid))) out.add(tokenId)
    }
  }
  return [...out].sort()
}

/** Global lock OR the player's own lock. */
export function movementLockedFor(state: GameState, userId: string): boolean {
  return state.movementLocked || (own(state.players, userId)?.movementLocked ?? false)
}

/** Ids of the lights carried by a token (they move with it). */
export function attachedLightIds(scene: Pick<Scene, "objects">, tokenId: Id): Id[] {
  const out: Id[] = []
  for (const o of Object.values(scene.objects)) {
    if (o.type === "light" && o.attachedTokenId === tokenId) out.push(o.id)
  }
  return out.sort()
}

/**
 * A scene revision with one token placed at a path step (for the per-step visibility passes of an
 * applied move, ARCHITECTURE §5.2 "Moves"). Returns the scene unchanged if the token is unknown.
 */
export function sceneWithTokenAt(scene: Scene, tokenId: Id, step: PathStep): Scene {
  const t = own(scene.tokens, tokenId)
  if (!t) return scene
  const position = anchorPosition(scene, t.size, step.cell)
  return { ...scene, tokens: { ...scene.tokens, [tokenId]: { ...t, levelId: step.levelId, position } } }
}

/**
 * Cell lookup for reduceRequest's `perceivedByPlayer`: true only when the whole cell is perceived
 * (a partially perceived cell counts as not perceived, so rejection reasons are masked conservatively).
 */
export function perceivedCellLookup(vis: VisibilityResult | null): (levelId: Id, i: number, j: number) => boolean {
  return (levelId, i, j) => {
    if (!vis || !Object.hasOwn(vis.perception, levelId)) return false
    const m = vis.perception[levelId]
    if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= m.width || j >= m.depth) return false
    const c = j * m.width + i
    if (m.grades[c] === 0) return false
    const p = m.partial.get(c)
    return p === undefined || p === (1 << (SUBCELLS * SUBCELLS)) - 1
  }
}
