import type { Patch } from "immer"

import type { AreaGeometry } from "../area/types"
import type { RollResult } from "../dice/dice"
import type { ConditionChange, HealthBand, HpAmountChange, HpChange, TokenCondition, TokenHp } from "../scene/tokenStatus"
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
  Vec2,
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
export type PlayerLight = Pick<
  LightObject,
  "id" | "type" | "levelId" | "position" | "color" | "intensity" | "brightRadius" | "dimRadius" | "flicker" | "on" | "castsShadows"
> & {
  /** true: feeds the renderer's light list. false: memory fixture, drawn as a fixture only. */
  emitting: boolean
}

export type PlayerObject = PlayerFloor | PlayerWall | PlayerDoor | PlayerWindow | PlayerConnector | PlayerPillar | PlayerProp | PlayerLight

export type PlayerToken = Pick<Token, "id" | "levelId" | "position" | "size" | "height" | "color" | "imageUrl" | "model"> & {
  label: string | null
  /** Only for tokens the player controls or sees through (visionTokenIds). */
  name?: string
  eyeHeight?: number
  vision?: VisionSettings
  speed?: number
  /** Exact hit points: only for tokens the player controls or sees through. */
  hp?: TokenHp
  /** Other tokens with hit points: the coarse band, unless the DM hides wounds (GameState.hideWounds). */
  health?: HealthBand
  /** Conditions shown on the token (every player who sees it sees them). */
  conditions?: TokenCondition[]
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
  /**
   * Which map of the game this is (GameState.mapSerial; absent: the first). A client whose view changes it
   * knows the DM switched maps, even between duplicated scenes that share level and token ids.
   */
  mapSerial?: number
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

/**
 * A table message as one player may read it (built by filter.ts `playerTable`): never its sender's or
 * recipients' user ids.
 */
export interface PlayerTableMessage {
  id: Id
  /** Host time (ms since the epoch); messages are ordered by it (ties: id). */
  at: number
  kind: TableMessageKind
  /** The sender's name and colour when it was sent ("DM" for the DM, "" for system notices). */
  name: string
  color: string
  /** Sent by this player. */
  mine: boolean
  /** Sent by the DM. */
  dm: boolean
  /** Not public: between this player and the DM. */
  whisper: boolean
  /** Chat text, a roll's label, or a system notice. */
  text: string
  roll?: RollResult
}

/** A combatant a player may see: not hidden by the DM, and a custom entry or a token in their view. */
export interface PlayerCombatEntry {
  id: Id
  /** The token (always one in PlayerView.tokens), or null for a custom entry (a lair action…). */
  tokenId: Id | null
  /** Custom entries: their name. Tokens: the name the player may see (`name` if full, else `label`, else ""). */
  name: string
  initiative: number | null
}

export interface PlayerCombat {
  round: number
  /** The acting entry when it is one of `entries`; null before the first turn or while someone unseen acts. */
  activeId: Id | null
  /** In turn order. */
  entries: PlayerCombatEntry[]
}

export interface PlayerTable {
  /** The newest TABLE_LIMITS.maxViewLog messages this player may read, keyed by id (order by `at`, then id). */
  log: Record<Id, PlayerTableMessage>
  combat: PlayerCombat | null
}

/** A map ping as one player receives it (filter.ts `pingForPlayer`): only on levels the player knows. */
export interface PlayerPing {
  levelId: Id
  x: number
  z: number
  name: string
  color: string
  /** The DM asks everyone to look here (clients centre the camera on it). */
  focus: boolean
}

/**
 * An area of effect (spell template, ARCHITECTURE §6.6) as one player receives it (filter.ts
 * `playerTemplates`): never its placer's user id. A template carried by a token is sent only while that
 * token is in the view, at the token's position.
 */
export interface PlayerTemplate extends AreaGeometry {
  id: Id
  label: string
  color: string
  /** The placer's name ("DM" for the DM). */
  name: string
  /** Placed by this player (they may move or remove it). */
  mine: boolean
  /** Placed by the DM. */
  dm: boolean
  /** The token carrying it (always one in PlayerView.tokens), or null. */
  tokenId: Id | null
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
    /** Players may move off the grid (gridless moves and jumps). Absent = grid only. */
    freeMovement?: boolean
  }
  /** Chat, dice and the initiative order as this player may see them (absent: nothing to show). */
  table?: PlayerTable
  /** Areas of effect this player may see, keyed by id (absent: none). */
  templates?: Record<Id, PlayerTemplate>
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

export type TableMessageKind = "chat" | "roll" | "system"

/** Who may read a table message besides its sender and the DM: everyone, or these players ([] = the DM only). */
export type TableAudience = "all" | string[]

export interface TableMessage {
  id: Id
  /** Host time (ms since the epoch), strictly increasing along the log. */
  at: number
  kind: TableMessageKind
  /** The sender's user id; null = the DM (or the table, for system notices). */
  from: string | null
  /** The sender's name and colour when it was sent. */
  name: string
  color: string
  to: TableAudience
  /** Chat text, a roll's label, or a system notice. */
  text: string
  /** Rolled by the host (players never supply results). */
  roll?: RollResult
}

export interface CombatEntry {
  id: Id
  /** The token acting on this turn; null = a custom entry (a lair action, a trap…). */
  tokenId: Id | null
  /** Custom entries' name ("" for token entries, which use their token's). */
  name: string
  initiative: number | null
  /** Added to the d20 when the DM rolls initiative for the entry. */
  modifier: number
  /** Kept from players (e.g. an ambusher), whatever they see of its token. */
  hidden: boolean
}

export interface Combat {
  /** ≥ 1. */
  round: number
  /** The acting entry; null before the first turn. */
  activeId: Id | null
  /** Turn order: initiative high → low, unrolled entries last (core/session/table sortCombat). */
  entries: CombatEntry[]
}

/** Chat, dice rolls and the initiative tracker of a game (ARCHITECTURE §6.5). */
export interface TableState {
  /** Newest last, at most TABLE_LIMITS.maxLog. */
  log: TableMessage[]
  combat: Combat | null
}

/**
 * An area of effect on the map (a spell template, ARCHITECTURE §6.6): where it is, who placed it and how
 * it looks. What it reaches is computed by each viewer from the geometry they know (core/area).
 */
export interface AreaTemplate extends AreaGeometry {
  id: Id
  /** The player who placed it (user id), or null for the DM. */
  owner: string | null
  /** Shown next to it ("Fireball"); may be empty. */
  label: string
  /** #rrggbb. */
  color: string
  /** Carried by this token: levelId, x and z follow it (ignored while carried). */
  tokenId: Id | null
  /** The DM's alone: never sent to players. */
  hidden: boolean
}

/** What a player sends to place a template (the host fills in the id, owner and visibility). */
export type AreaTemplateInput = AreaGeometry & Pick<AreaTemplate, "label" | "color" | "tokenId">

export const GAME_STATE_VERSION = 1 as const

/**
 * A world character as a table knows it (ARCHITECTURE §6.9): its name and the world players who play it.
 * DM-only (never sent to players); the host keeps it in step with the world's roster.
 */
export interface TableCharacter {
  name: string
  /** User ids, sorted and unique. */
  players: string[]
}

/**
 * The library scene the table's live map comes from: restore points (library versions) of the map as it
 * is now are saved to it (ARCHITECTURE §6.8).
 */
export interface SceneOrigin {
  /** Library scene row id (`scenes.id`, not `Scene.id`). */
  sceneId: string
  /** Library version the live map is based on (null = unknown). */
  version: number | null
  /**
   * The live map changed since that version: edited ("apply-scene-patches") or played on (tokens moved,
   * doors, lights: the map remembers everything that happens on it). Set by the host runner.
   */
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
  /**
   * Players may move off the grid: gridless moves (`move.end`) and free jump points. Absent / false:
   * players are forced to the grid (jumps snap to anchors, `end` is refused).
   */
  freeMovement?: boolean
  /** Chat log and initiative tracker (absent: nothing said or rolled yet, no combat). */
  table?: TableState
  /** Players get no health band of creatures they do not control (absent / false: they do). */
  hideWounds?: boolean
  /** Areas of effect on the map, oldest first (absent: none). */
  templates?: AreaTemplate[]
  /** Maps played so far in this game besides the first (bumped by every `load-scene`; absent: 0). */
  mapSerial?: number
  /**
   * The world's characters (ARCHITECTURE §6.9), kept in step with the world by the host. A token linked to
   * one (Token.characterId) is controlled by that character's players: its `owners` entry is derived from
   * here (core/session/characters.ts) and cannot be assigned at the table. Absent: no roster known (every
   * token is handed out at the table).
   */
  characters?: Record<Id, TableCharacter>
}

// ===========================================================================
// Wire protocol (see ARCHITECTURE §6)
// ===========================================================================

/** Path-based patch op produced by diffViews(); path segments index into PlayerView. */
export type PatchOp = { op: "set"; path: string[]; value: unknown } | { op: "del"; path: string[] }

export type DoorRejectReason = "cannot" | "locked"
/**
 * Table requests: "bad-formula" (the host could not read the dice); "cannot" (not your turn, not in combat,
 * not your template…).
 */
export type TableRejectReason = "bad-formula" | "cannot"
export type RejectReason = MoveRejectReason | DoorRejectReason | TableRejectReason | "rate-limited" | "invalid"

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
 *
 * `map` on requests tied to a place (moves, jumps, doors, templates): the map they were made on (the view's
 * PlayerSceneInfo.mapSerial, 0 for the first). The host refuses them ("cannot") once the game is on another
 * map; absent, it relies on whether it sent the client a view of the current map yet.
 */
export type ClientToHost =
  | { t: "hello"; nonce: string; epoch: string | null; lastSeq: number | null }
  /**
   * Walk `path` (grid steps from the token's anchor). `end` (gridless moves, GameState.freeMovement):
   * the exact final position, in the last step's anchor cell, reached from its centre.
   */
  | { t: "move"; reqId: string; tokenId: Id; path: PathStep[]; end?: Vec2; map?: number }
  /** Put a token at a point without walking there (no path could be found). */
  | { t: "jump"; reqId: string; tokenId: Id; levelId: Id; x: number; z: number; map?: number }
  | { t: "door"; reqId: string; doorId: Id; action: "open" | "close"; map?: number }
  /** Chat: to everyone, or a whisper to the DM. */
  | { t: "say"; reqId: string; text: string; to: "all" | "dm" }
  /** Roll dice ("1d20+5 to hit": formula, then an optional label); the host rolls. */
  | { t: "roll"; reqId: string; formula: string; to: "all" | "dm" }
  /**
   * Roll initiative for one of the player's tokens in combat that has none yet: the host rolls 1d20 +
   * `bonus` (an integer within ±TABLE_LIMITS.maxInitiativeBonus, shown on the roll), once.
   */
  | { t: "initiative"; reqId: string; tokenId: Id; bonus: number }
  /** End the turn of `entryId` (only while it acts and is a token the player controls). */
  | { t: "end-turn"; reqId: string; entryId: Id }
  /** Point at a spot (ephemeral: no result, never stored). Only on levels the player knows. */
  | { t: "ping"; levelId: Id; x: number; z: number }
  /**
   * Change one of the player's own tokens: damage, healing or temporary hit points (only when the DM
   * tracks its hit points; max stays the DM's), and/or conditions to add and remove. Relative: the host
   * applies it to the token as it is then, so a change made meanwhile is never overwritten.
   */
  | { t: "token-status"; reqId: string; tokenId: Id; hp?: HpAmountChange; conditions?: { add?: TokenCondition[]; remove?: TokenCondition[] } }
  /**
   * Put an image on a token the player controls (Token Maker, ARCHITECTURE §11), or clear it (null). The
   * image must be in the player's own folder of the token image store (core/session/tokenImages.ts).
   */
  | { t: "token-image"; reqId: string; tokenId: Id; imageUrl: string | null }
  /**
   * Place an area of effect (spell template), or with `id` move / change one of the player's own. Carried
   * by `template.tokenId` (a token the player controls) or on a level the player knows.
   */
  | { t: "template"; reqId: string; id?: Id; template: AreaTemplateInput; map?: number }
  /** Remove one of the player's own templates. */
  | { t: "template-remove"; reqId: string; id: Id; map?: number }

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
  /** Someone pointed at a spot (filter.ts pingForPlayer). Outside the seq order, best-effort. */
  | { t: "ping"; epoch: string; ping: PlayerPing }

/** One `{t: "tiles"}` chunk entry: [ci, cj, cellMask] or [ci, cj, cellMask, content rev]. */
export type TileChunkEntry = [number, number, number] | [number, number, number, number]

/** host → everyone on topic `session:{sid}:host` (DM-only writers). Host liveness = DM presence there. */
export type HostBroadcast =
  | { t: "status"; epoch: string; sceneName: string }
  | { t: "ended" }
  /** The DM closed the table: players disconnect until it opens again (ARCHITECTURE §6.8). */
  | { t: "closed" }

/** Commands the DM issues directly to the host state (never over the wire). */
export type DmCommand =
  | { t: "move-token"; tokenId: Id; levelId: Id; x: number; z: number }
  | { t: "set-door"; doorId: Id; state: DoorState }
  | { t: "set-light"; lightId: Id; on: boolean }
  | { t: "set-movement-locked"; locked: boolean; userId?: string }
  | { t: "set-shared-vision"; enabled: boolean }
  | { t: "set-enforce-speed"; enabled: boolean }
  | { t: "set-free-movement"; enabled: boolean }
  /** Hand a token to a player (or take it back). Character tokens are refused: their players come from the world. */
  | { t: "assign-token"; tokenId: Id; userId: string; assigned: boolean }
  /** The world's characters and who plays them (GameState.characters); owners of character tokens follow. */
  | { t: "set-characters"; characters: Record<Id, TableCharacter> }
  | { t: "reveal-object"; objectId: Id; userId?: string }
  /** Editor edits on the map screen (immer patches against GameState.scene). */
  | { t: "apply-scene-patches"; patches: Patch[] }
  /**
   * Switch to a different map; resets explored/memory/revealed, ends combat, clears templates. `origin`: its
   * library scene (default: none). `carried` (a map change bringing the party along, core/session/changeMap):
   * the tokens of the old map already placed in `scene` (old id → id in `scene`), the only ones whose owners
   * are kept. `notice` with `stamp`: a system line for the log ("The party travels to …").
   */
  | { t: "load-scene"; scene: Scene; origin?: SceneOrigin | null; carried?: Record<Id, Id>; stamp?: TableStamp; notice?: string }
  /** Record where the live map comes from (e.g. after saving it back to the library: clean, new version). */
  | { t: "set-origin"; origin: SceneOrigin | null }
  | { t: "add-player"; userId: string; displayName: string }
  | { t: "remove-player"; userId: string }
  | { t: "rebind-player"; fromUserId: string; toUserId: string }
  | { t: "reset-fog"; userId?: string }
  /** Choose the free asset categories loaded into the game (GameState.freeAssets). */
  | { t: "set-free-assets"; categories: FreeAssetCategory[] }
  /** A token's hit points (null: stop tracking them) and/or conditions. A play action, like a move. */
  | { t: "set-token-status"; tokenId: Id; hp?: TokenHp | null; conditions?: TokenCondition[] }
  /**
   * A relative change (core/scene/tokenStatus.ts): applied to the token as the host holds it, so a
   * player's change made meanwhile is never overwritten. Hit points only when tracked.
   */
  | { t: "change-token-status"; tokenId: Id; hp?: HpChange; conditions?: ConditionChange }
  /** Hide (or show) the health band of creatures players do not control. */
  | { t: "set-hide-wounds"; hidden: boolean }
  /** Add a message to the table log (the host builds it: id, time, the DM's name, a host-side roll). */
  | { t: "table-post"; message: TableMessage }
  /** Forget the table log (combat stays). */
  | { t: "table-clear-log" }
  /**
   * Start combat with these entries (replacing any combat), round 1, nobody acting yet. `stamp`: id and
   * time of the "Combat started" notice.
   */
  | { t: "combat-start"; entries: CombatEntry[]; stamp: TableStamp }
  | { t: "combat-end"; stamp: TableStamp }
  /** Add entries (tokens already in combat are skipped). */
  | { t: "combat-add"; entries: CombatEntry[] }
  /** Remove an entry; when it was acting, the turn passes on (a new round posts a notice with `stamp`). */
  | { t: "combat-remove"; entryId: Id; stamp: TableStamp }
  /** Change entries (initiative, modifier, hidden, a custom entry's name); the order is re-sorted. */
  | { t: "combat-update"; updates: { entryId: Id; patch: Partial<Pick<CombatEntry, "initiative" | "modifier" | "hidden" | "name">> }[] }
  /** Next (1) or previous (-1) turn; a new round posts a notice with `stamp`. */
  | { t: "combat-turn"; delta: 1 | -1; stamp: TableStamp }
  /** Make an entry the acting one (null: nobody). */
  | { t: "combat-set-active"; entryId: Id | null }
  /** Add an area of effect, or replace the one with its id (the DM may change anyone's). */
  | { t: "template-set"; template: AreaTemplate }
  /** Remove templates (ids), or every template (null). */
  | { t: "template-delete"; ids: Id[] | null }

/** Id and host time for a message a command may post (reducers stay pure). */
export interface TableStamp {
  id: Id
  at: number
}
