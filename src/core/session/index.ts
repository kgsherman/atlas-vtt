/**
 * Public API of core/session (docs/ARCHITECTURE.md §5.4, §6): the authoritative GameState reducer,
 * request validation, per-player knowledge (explored + memory), THE player filter, view diffs and the
 * player-side scene reconstruction.
 *
 * Host pipeline per player: parseClientMessage → reduceRequest / reduceDm → (vision) → updateKnowledge
 * → filterForPlayer → diffViews → send. Saved games (session_state) round-trip through
 * serializeGameState / parseGameState.
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
export { filterForPlayer, MAX_BACKDROP_TILE_PX, playerBackdrop } from "./filter"
export { applyPatchOps, diffViews } from "./diff"
export { backdropFromPlayer, levelFromPlayer, objectFromPlayer, playerBackdropAssetId, tokenFromPlayer, viewToScene } from "./viewToScene"
export { memoryObjectSchema, parsePlayerView, playerObjectSchema, playerTokenSchema, playerViewSchema } from "./playerViewSchema"
export { memorable, sanitizeObject, type MemoryFloor } from "./sanitize"
export {
  GAME_STATE_LIMITS,
  parseGameState,
  parseGameStateDetailed,
  parseGameStateJson,
  serializeGameState,
  type ParseGameStateResult,
} from "./persist"
