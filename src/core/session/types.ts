import type { Patch } from "immer"

import type { MoveRejectReason, PathStep } from "../movement/types"
import type {
  ConnectorObject,
  DoorObject,
  DoorState,
  DoorStyle,
  Environment,
  FloorObject,
  GridSettings,
  Id,
  LightObject,
  PillarObject,
  PropObject,
  Rect,
  Scene,
  TerrainResolution,
  Token,
  VisionSettings,
  WallObject,
  WindowObject,
} from "../scene/types"
import type { EncodedGrades, EncodedMask } from "../vision/types"
import type { FreeAssetCategory } from "./freeAssets"

// ===========================================================================
// Player-facing (wire) types — ALLOWLISTS. Build them field by field in filter.ts, never by spread.
// ===========================================================================

export type PlayerFloor = Pick<FloorObject, "id" | "type" | "levelId" | "rect" | "material" | "thickness">
export type PlayerWall = Pick<WallObject, "id" | "type" | "levelId" | "a" | "b" | "height" | "thickness" | "material" | "followTerrain" | "terrainProfile">
export type PlayerDoor = Pick<DoorObject, "id" | "type" | "levelId" | "wallId" | "offset" | "width" | "height" | "leaves" | "hinge" | "swing"> & {
  /** "locked" is reported as "closed". */
  state: Exclude<DoorState, "locked">
  /** Secret doors are only ever sent once revealed, and then as "wood". */
  style: Exclude<DoorStyle, "secret">
}
export type PlayerWindow = Pick<WindowObject, "id" | "type" | "levelId" | "wallId" | "offset" | "width" | "sillHeight" | "height">
export type PlayerConnector = Pick<ConnectorObject, "id" | "type" | "levelId" | "style" | "toLevelId" | "rect" | "direction" | "material">
export type PlayerPillar = Pick<PillarObject, "id" | "type" | "levelId" | "position" | "shape" | "size" | "height" | "material">
export type PlayerProp = Pick<PropObject, "id" | "type" | "levelId" | "kind" | "position" | "rotationY" | "scale" | "color" | "blocksSight" | "castsShadows">
/**
 * Lights are always sent RESOLVED: levelId = the light's current level, position relative to that
 * level's ground at (x, z) — attachment is never sent.
 */
export type PlayerLight = Pick<LightObject, "id" | "type" | "levelId" | "position" | "color" | "intensity" | "brightRadius" | "dimRadius" | "flicker" | "on" | "castsShadows"> & {
  /** true: feeds the renderer's light list. false: memory fixture, drawn as a fixture only. */
  emitting: boolean
}

export type PlayerObject =
  | PlayerFloor
  | PlayerWall
  | PlayerDoor
  | PlayerWindow
  | PlayerConnector
  | PlayerPillar
  | PlayerProp
  | PlayerLight

export type PlayerToken = Pick<Token, "id" | "levelId" | "position" | "size" | "height" | "color" | "imageUrl" | "model"> & {
  label: string | null
  /** Only for tokens the player controls or sees through (visionTokenIds). */
  name?: string
  eyeHeight?: number
  vision?: VisionSettings
  speed?: number
}

export interface PlayerLevel {
  id: Id
  /** false = stub for a level referenced by a sent connector or own token but not explored. */
  known: boolean
  name: string | null
  elevation: number
  height: number
  floorThickness: number
  /** Heightmap resolution when the level has terrain (chunks travel in PlayerView.terrain). */
  terrainResolution: TerrainResolution | null
}

export interface PlayerSceneInfo {
  name: string
  grid: GridSettings
  environment: Environment
  levels: Record<Id, PlayerLevel>
}

/**
 * A level's battlemap image as a player sees it: only its placement. Pixels arrive separately, only
 * for cells in this player's explored mask (Supabase: per-player chunks announced by `{t: "tiles"}`,
 * see net/assets/chunks.ts; cropped per cell by net/assets BackdropTileSource).
 */
export interface PlayerBackdrop {
  rect: Rect
  opacity: number
  tintWalls: boolean
  /** Tile edge length in pixels (one tile per grid cell). */
  tilePx: number
}

export interface PlayerLevelMasks {
  perception: EncodedGrades
  explored: EncodedMask
  sunlit: EncodedMask
}

export const PLAYER_VIEW_VERSION = 1 as const

export interface PlayerView {
  viewVersion: typeof PLAYER_VIEW_VERSION
  sessionId: string
  userId: string
  scene: PlayerSceneInfo
  /**
   * Objects the player has observed, in their last-observed state, CLIPPED to explored cells.
   * Wall and floor pieces have deterministic ids `${sourceId}@${x},${z}` (their first corner);
   * openings reference the piece they sit on and their offset is rebased onto it.
   */
  objects: Record<Id, PlayerObject>
  tokens: Record<Id, PlayerToken>
  /** levelId → chunkKey → base64 Float32 chunk; samples touching no explored cell are zero. */
  terrain: Record<Id, Record<string, string>>
  masks: Record<Id, PlayerLevelMasks>
  /** Backdrop placement per known level (no pixels; see PlayerBackdrop). */
  backdrops?: Record<Id, PlayerBackdrop>
  controlledTokenIds: Id[]
  /** Tokens whose eyes this player sees through (own + party when shared vision). */
  visionTokenIds: Id[]
  flags: {
    /** Effective for this player (global lock OR per-player lock). */
    movementLocked: boolean
    sharedVision: boolean
    enforceSpeed: boolean
  }
}

// ===========================================================================
// Authoritative host state (DM browser + session_state table)
// ===========================================================================

export interface SessionPlayer {
  userId: string
  displayName: string
  color: string
  /** Per-player movement lock (in addition to the global lock). */
  movementLocked: boolean
}

export const GAME_STATE_VERSION = 1 as const

/**
 * The library scene a live session's map comes from, so the DM can save map edits made during play
 * back to the library (and be warned before ending a session with unsaved edits).
 */
export interface SceneOrigin {
  /** Library scene row id (`scenes.id`, not `Scene.id`). */
  sceneId: string
  /** Library version the live map is based on (null = unknown). */
  version: number | null
  /** The live map was edited ("apply-scene-patches") since that version. Play actions never set it. */
  dirty: boolean
}

export interface GameState {
  stateVersion: typeof GAME_STATE_VERSION
  sessionId: string
  roomCode: string
  /** THE live scene during a session (editor edits apply here as patches). */
  scene: Scene
  players: Record<string, SessionPlayer>
  /** Single source of token control: tokenId → user ids. */
  owners: Record<Id, string[]>
  movementLocked: boolean
  /** Party vision: players owning ≥ 1 PC token see through all PC tokens owned by such players. */
  sharedVision: boolean
  enforceSpeed: boolean
  /** Persistent explored masks: userId → levelId → mask. */
  explored: Record<string, Record<Id, EncodedMask>>
  /** Last-observed sanitised objects (whole, unclipped): userId → objectId → object. */
  memory: Record<string, Record<Id, PlayerObject>>
  /** Secret doors revealed to a player: userId → door ids. */
  revealed: Record<string, Id[]>
  /** Internal monotonic counter (never on the wire). */
  seq: number
  /** Library scene the map comes from (absent / null: unknown, e.g. states saved before this field). */
  origin?: SceneOrigin | null
  /**
   * Free asset categories loaded into this game (chosen when it was started, changeable by the DM):
   * what the host's asset pickers offer. DM-only; never sent to players. Absent = none.
   */
  freeAssets?: FreeAssetCategory[]
}

// ===========================================================================
// Wire protocol (see ARCHITECTURE §6)
// ===========================================================================

/** Path-based patch op produced by diffViews(); path segments index into PlayerView. */
export type PatchOp = { op: "set"; path: string[]; value: unknown } | { op: "del"; path: string[] }

export type DoorRejectReason = "cannot" | "locked"
export type RejectReason = MoveRejectReason | DoorRejectReason | "rate-limited" | "invalid"

export interface RequestResult {
  reqId: string
  ok: boolean
  reason?: RejectReason
  /** For moves: number of steps actually applied (legal prefix). */
  applied?: number
}

/**
 * player → host on topic `session:{sid}:req:{uid}`. The sender is the {uid} of the topic
 * (RLS guarantees only that user can write there) — never a payload field.
 */
export type ClientToHost =
  | { t: "hello"; nonce: string; epoch: string | null; lastSeq: number | null }
  | { t: "move"; reqId: string; tokenId: Id; path: PathStep[] }
  | { t: "door"; reqId: string; doorId: Id; action: "open" | "close" }

/**
 * host → player on topic `session:{sid}:view:{uid}`. `epoch` changes on every host start;
 * `seq` is a per-player view counter. A client applies a patch only if epoch matches and
 * baseSeq === its current seq; otherwise it sends hello.
 */
export type HostToClient =
  | { t: "snapshot"; epoch: string; seq: number; view: PlayerView; nonce?: string; results?: RequestResult[] }
  | { t: "snapshot_ready"; epoch: string; seq: number; nonce?: string }
  | { t: "patch"; epoch: string; baseSeq: number; seq: number; ops: PatchOp[]; nonce?: string; results?: RequestResult[] }
  | { t: "sync"; epoch: string; seq: number }
  | { t: "result"; epoch: string; seq: number; result: RequestResult }
  /**
   * Backdrop tiles (ARCHITECTURE §9): the player's uploaded chunks of explored cells on a level, as
   * [ci, cj, cellMask] or [ci, cj, cellMask, rev] (net/assets/chunks.ts; mask 0 = removed). `rev` is an
   * optional content revision of the chunk image: a chunk can change without its cell mask changing
   * (a partly explored cell drawn with more of its sub-cells), so clients refetch when it changes.
   * `reset`: the list replaces everything known for the level. Outside the seq order (idempotent; sent
   * before the patch revealing the cells when the uploads finish in time, else when they do).
   */
  | { t: "tiles"; epoch: string; levelId: Id; chunks: Array<TileChunkEntry>; reset?: boolean }
  | { t: "kicked"; reason: string }

/** One `{t: "tiles"}` chunk entry: [ci, cj, cellMask] or [ci, cj, cellMask, content rev]. */
export type TileChunkEntry = [number, number, number] | [number, number, number, number]

/** host → everyone on topic `session:{sid}:host` (DM-only writers). Host liveness = DM presence there. */
export type HostBroadcast =
  | { t: "status"; epoch: string; sceneName: string }
  | { t: "ended" }

/** Commands the DM issues directly to the host state (never over the wire). */
export type DmCommand =
  | { t: "move-token"; tokenId: Id; levelId: Id; x: number; z: number }
  | { t: "set-door"; doorId: Id; state: DoorState }
  | { t: "set-light"; lightId: Id; on: boolean }
  | { t: "set-movement-locked"; locked: boolean; userId?: string }
  | { t: "set-shared-vision"; enabled: boolean }
  | { t: "set-enforce-speed"; enabled: boolean }
  | { t: "assign-token"; tokenId: Id; userId: string; assigned: boolean }
  | { t: "reveal-object"; objectId: Id; userId?: string }
  /** Editor edits during a live session (immer patches against GameState.scene). */
  | { t: "apply-scene-patches"; patches: Patch[] }
  /** Switch to a different map; resets explored/memory/revealed. `origin`: its library scene (default: none). */
  | { t: "load-scene"; scene: Scene; origin?: SceneOrigin | null }
  /** Record where the live map comes from (e.g. after saving it back to the library: clean, new version). */
  | { t: "set-origin"; origin: SceneOrigin | null }
  | { t: "add-player"; userId: string; displayName: string }
  | { t: "remove-player"; userId: string }
  | { t: "rebind-player"; fromUserId: string; toUserId: string }
  | { t: "reset-fog"; userId?: string }
  /** Choose the free asset categories loaded into the game (GameState.freeAssets). */
  | { t: "set-free-assets"; categories: FreeAssetCategory[] }
