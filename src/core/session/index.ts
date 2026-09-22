/**
 * Public API of core/session. STUB bodies — implemented by the session module (docs/ARCHITECTURE.md §6).
 */
import type { OcclusionWorld } from "../occlusion/types"
import type { Id, Scene, SceneLike } from "../scene/types"
import type { VisibilityResult } from "../vision/types"
import type { ClientToHost, DmCommand, GameState, PatchOp, PlayerView, RequestResult } from "./types"
import type { PathStep } from "../movement/types"

export type * from "./types"

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
}

export interface RequestOutcome extends ReduceResult {
  result: RequestResult
  /** For applied moves: the positions visited (each needs a visibility pass for explored/memory). */
  visited: PathStep[]
  tokenId: Id | null
}

export function createGameState(_args: { sessionId: string; roomCode: string; scene: Scene }): GameState {
  throw new Error("createGameState: not implemented")
}

/** Strict zod parse of an untrusted player message (limits enforced). null = drop silently. */
export function parseClientMessage(_raw: unknown): ClientToHost | null {
  throw new Error("parseClientMessage: not implemented")
}

export function reduceDm(_state: GameState, _cmd: DmCommand): ReduceResult {
  throw new Error("reduceDm: not implemented")
}

/**
 * Apply an authorised player request. `perceivedByPlayer` reports whether a cell on a level is currently
 * perceived by that player (used to mask rejection reasons).
 */
export function reduceRequest(
  _state: GameState,
  _userId: string,
  _msg: Exclude<ClientToHost, { t: "hello" }>,
  _ctx: { world: OcclusionWorld; currentView: PlayerView | null; perceivedByPlayer: (levelId: Id, i: number, j: number) => boolean }
): RequestOutcome {
  throw new Error("reduceRequest: not implemented")
}

/** Token ids whose eyes the player sees through (own + party PCs under shared vision). */
export function viewerTokenIds(_state: GameState, _userId: string): Id[] {
  throw new Error("viewerTokenIds: not implemented")
}

/** OR perceived cells into explored, refresh memory from observation (§5.4), auto-reveal secret doors. */
export function updateKnowledge(_state: GameState, _userId: string, _vis: VisibilityResult): GameState {
  throw new Error("updateKnowledge: not implemented")
}

/** The ONLY path by which data reaches a player (allowlists, clipping, memory). */
export function filterForPlayer(_state: GameState, _userId: string, _vis: VisibilityResult): PlayerView {
  throw new Error("filterForPlayer: not implemented")
}

export function diffViews(_prev: PlayerView | null, _next: PlayerView): PatchOp[] {
  throw new Error("diffViews: not implemented")
}

export function applyPatchOps(_view: PlayerView, _ops: PatchOp[]): PlayerView {
  throw new Error("applyPatchOps: not implemented")
}

/** Rebuild a renderable/simulatable scene from a player's view (stubs for unknown levels, dense terrain from chunks). */
export function viewToScene(_view: PlayerView): SceneLike {
  throw new Error("viewToScene: not implemented")
}
