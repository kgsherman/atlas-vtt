/**
 * Public API of core/session (docs/ARCHITECTURE.md §5.4, §6): the authoritative GameState reducer,
 * request validation, per-player knowledge (explored + memory), THE player filter, view diffs and the
 * player-side scene reconstruction.
 *
 * Host pipeline per player: parseClientMessage → reduceRequest / reduceDm → (vision) → updateKnowledge
 * → filterForPlayer → diffViews → send.
 */
export type * from "./types"
export { GAME_STATE_VERSION, PLAYER_VIEW_VERSION } from "./types"

export {
  attachedLightIds,
  controlledTokenIds,
  createGameState,
  movementLockedFor,
  perceivedCellLookup,
  sceneWithTokenAt,
  viewerTokenIds,
  type ReduceResult,
  type RequestOutcome,
  type SceneDelta,
} from "./state"
export { clientMessageSchema, parseClientMessage, PROTOCOL_LIMITS } from "./protocol"
export { deltaFromPatches, reduceDm } from "./reduceDm"
export { reduceRequest, segmentRectDistance, type RequestContext } from "./reduceRequest"
export { updateKnowledge } from "./memory"
export { filterForPlayer } from "./filter"
export { applyPatchOps, diffViews } from "./diff"
export { levelFromPlayer, objectFromPlayer, tokenFromPlayer, viewToScene } from "./viewToScene"
export { parsePlayerView, playerObjectSchema, playerTokenSchema, playerViewSchema } from "./playerViewSchema"
export { memorable, sanitizeObject } from "./sanitize"
