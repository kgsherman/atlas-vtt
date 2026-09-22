import type {
  DoorState,
  Environment,
  GridSettings,
  Id,
  Level,
  Scene,
  SceneObject,
  Token,
} from "../scene/types"
import type { PathStep } from "../movement/types"
import type { EncodedMask } from "../vision/types"

// ---------------------------------------------------------------------------
// Authoritative host state (lives only in the DM's browser + session_state table)
// ---------------------------------------------------------------------------

export interface SessionPlayer {
  userId: string
  displayName: string
  color: string
  /** Tokens this player may move (mirrors token.ownerIds for convenience). */
  tokenIds: Id[]
  /** Per-player movement lock (in addition to the global lock). */
  movementLocked: boolean
}

export interface GameState {
  sessionId: string
  roomCode: string
  /** Live working copy of the scene: tokens move, doors open, lights toggle. */
  scene: Scene
  players: Record<string, SessionPlayer>
  movementLocked: boolean
  /** When true, every player sees through every PC token owned by any player in the session. */
  sharedVision: boolean
  enforceSpeed: boolean
  /** Persistent explored masks per player per level. */
  explored: Record<string, Record<Id, EncodedMask>>
  /** Last-seen (sanitised) state of objects per player, for fog-of-war memory. */
  memory: Record<string, Record<Id, SceneObject>>
  /** Monotonic state counter. */
  seq: number
}

// ---------------------------------------------------------------------------
// What a player receives. Built ONLY by core/session/filter.ts.
// ---------------------------------------------------------------------------

export interface PlayerSceneInfo {
  id: Id
  name: string
  grid: GridSettings
  environment: Environment
  levels: Level[]
}

export interface PlayerLevelMasks {
  visible: EncodedMask
  explored: EncodedMask
}

export interface PlayerView {
  sessionId: string
  userId: string
  seq: number
  scene: PlayerSceneInfo
  objects: Record<Id, SceneObject>
  tokens: Record<Id, Token>
  masks: Record<Id, PlayerLevelMasks>
  controlledTokenIds: Id[]
  /** Tokens whose eyes this player sees through (own + party when shared vision). */
  visionTokenIds: Id[]
  flags: {
    movementLocked: boolean
    sharedVision: boolean
    enforceSpeed: boolean
    hostOnline: boolean
  }
}

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

/** Path-based patch op produced by diffViews(); path segments index into PlayerView. */
export type PatchOp =
  | { op: "set"; path: string[]; value: unknown }
  | { op: "del"; path: string[] }

/**
 * player → host, sent on topic `session:{sid}:req:{uid}`.
 * The host derives the sender from the topic (RLS guarantees only {uid} can send there),
 * never from the payload.
 */
export type ClientToHost =
  | { t: "hello"; lastSeq: number | null }
  | { t: "move"; reqId: string; tokenId: Id; path: PathStep[] }
  | { t: "door"; reqId: string; doorId: Id; action: "open" | "close" }
  | { t: "resync" }

/** host → player, sent on topic `session:{sid}:view:{uid}`. */
export type HostToClient =
  | { t: "snapshot"; seq: number; view: PlayerView }
  | { t: "patch"; seq: number; baseSeq: number; ops: PatchOp[] }
  | { t: "snapshot_ready"; seq: number }
  | { t: "result"; reqId: string; ok: boolean; reason?: string }
  | { t: "kicked"; reason: string }

/** host → everyone, on topic `session:{sid}:lobby` (non-secret only). */
export type LobbyMessage =
  | { t: "status"; hostOnline: boolean; sceneName: string }
  | { t: "ended" }

/** Commands the DM issues directly to the host state (not over the wire). */
export type DmCommand =
  | { t: "move-token"; tokenId: Id; levelId: Id; x: number; z: number }
  | { t: "set-door"; doorId: Id; state: DoorState }
  | { t: "set-light"; lightId: Id; on: boolean }
  | { t: "set-movement-locked"; locked: boolean; userId?: string }
  | { t: "set-shared-vision"; enabled: boolean }
  | { t: "set-enforce-speed"; enabled: boolean }
  | { t: "assign-token"; tokenId: Id; userId: string; assigned: boolean }
  | { t: "set-token-hidden"; tokenId: Id; hidden: boolean }
  | { t: "upsert-token"; token: Token }
  | { t: "remove-token"; tokenId: Id }
  | { t: "replace-scene"; scene: Scene }
  | { t: "add-player"; userId: string; displayName: string }
  | { t: "remove-player"; userId: string }
  | { t: "reset-fog"; userId?: string }
