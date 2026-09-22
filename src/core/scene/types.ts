/**
 * Atlas VTT scene document — the versioned JSON contract shared by the editor,
 * renderer, simulation (vision/movement) and network layers.
 *
 * Conventions (see docs/ARCHITECTURE.md §2):
 *  - 1 world unit = 1 foot. Y is up. The grid lies on the XZ plane.
 *  - Grid cell (i, j) spans x ∈ [i·cellSize, (i+1)·cellSize), z ∈ [j·cellSize, (j+1)·cellSize).
 *  - Y values of objects on a level are RELATIVE to that level's ground at the object's
 *    anchor point (see §2 "Terrain" for extended objects such as walls on slopes).
 *  - Angles are radians. Colours are "#rrggbb" strings.
 *  - Collections keyed by id are Records so immer patches stay stable for undo/redo and
 *    network diffs. Record key order carries no meaning; iterate sorted by id when order matters.
 *  - Token positions, door states and light on/off stored here are the INITIAL state for a
 *    session. Live play state lives in the session's GameState copy (core/session).
 */

export const SCENE_SCHEMA_VERSION = 1 as const

export type Id = string

/** Point on the ground plane (feet). */
export interface Vec2 {
  x: number
  z: number
}

/** Point in 3D (feet). */
export interface Vec3 {
  x: number
  y: number
  z: number
}

/** Axis-aligned rectangle on the ground plane, in feet. */
export interface Rect {
  x: number
  z: number
  w: number
  d: number
}

/** Integer grid cell coordinate. */
export interface Cell {
  i: number
  j: number
}

export type DiagonalRule = "5-5-5" | "5-10-5" | "euclidean"

export interface GridSettings {
  /** Feet per square. Default 5. */
  cellSize: number
  /** Scene extent in cells along X (max 200). */
  width: number
  /** Scene extent in cells along Z (max 200). */
  depth: number
  /** How diagonal moves are measured by the ruler and movement validation. */
  diagonalRule: DiagonalRule
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** D&D-style light level. */
export type AmbientLevel = "bright" | "dim" | "dark"

export interface DirectionalLightSettings {
  /** On/off state of the sun or moon. */
  enabled: boolean
  kind: "sun" | "moon"
  /** Compass direction the light comes FROM, radians (0 = +Z, π/2 = +X). */
  azimuth: number
  /** Angle above the horizon, radians (π/2 = straight down). Clamped to [0.1, π/2]. */
  elevation: number
  color: string
  intensity: number
  /** Light level granted to surfaces the directional light reaches (typically "bright" sun, "dim" moon). */
  grants: Exclude<AmbientLevel, "dark">
}

export interface Environment {
  /** Light level where the sky is directly overhead (bright = day, dim = overcast/moonlit night, dark = starless night). */
  skyLevel: AmbientLevel
  /** Light level under cover (a floor/roof overhead) where no light source reaches. */
  ambientLevel: AmbientLevel
  /** Visual-only ambient fill. */
  ambientColor: string
  ambientIntensity: number
  directional: DirectionalLightSettings
  backgroundColor: string
}

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

/** Edge length of a heightmap chunk, in grid cells. */
export const HEIGHTMAP_CHUNK_CELLS = 8

/**
 * Per-level terrain. Samples sit on a regular lattice: sample (sx, sz) is at world
 * (sx·s, sz·s) with s = cellSize / resolution, covering sx ∈ [0, width·resolution],
 * sz ∈ [0, depth·resolution].
 *
 * Samples are stored in chunks of N×N samples, N = HEIGHTMAP_CHUNK_CELLS·resolution.
 * Chunk "ci,cj" owns samples sx ∈ [ci·N, (ci+1)·N), sz ∈ [cj·N, (cj+1)·N); the last sample
 * row/column falls into the next chunk index (padding samples beyond the extent are ignored).
 * A missing chunk means all zeros. Values are base64 of little-endian Float32 (N·N, row-major
 * by z then x), heights in feet relative to level.elevation.
 */
export interface Heightmap {
  resolution: 1 | 2 | 4
  chunks: Record<string, string>
}

export interface Level {
  id: Id
  name: string
  /** World Y of this level's nominal ground surface (feet). */
  elevation: number
  /** Default wall height and storey height used when nothing is above (feet). */
  height: number
  /** Thickness of floor slabs on this level; the slab occupies [surface − thickness, surface]. */
  floorThickness: number
  heightmap: Heightmap | null
}

// ---------------------------------------------------------------------------
// Scene objects (discriminated union on `type`)
// ---------------------------------------------------------------------------

export type MaterialId =
  | "stone"
  | "brick"
  | "wood"
  | "plaster"
  | "dirt"
  | "grass"
  | "sand"
  | "water"
  | "metal"
  | "marble"
  | "tile"
  | "cobble"

export interface BaseObject {
  id: Id
  levelId: Id
  /** DM-facing label; never sent to players. */
  name?: string
  /** DM-only notes; never sent to players. */
  dmNotes?: string
  /** Editor lock: prevents selection/drag in the editor. (Unrelated to door locking.) */
  editorLocked?: boolean
  /** DM-only: never sent to players in any state, never rendered in player view. Still blocks on the host. */
  hidden?: boolean
}

/**
 * Floor slab over an axis-aligned rect. Its top surface is the level ground
 * (elevation + heightmap). Floors of level N are the ceiling of level N−1.
 * Connector footprints cut holes through the floors of the levels they rise through.
 */
export interface FloorObject extends BaseObject {
  type: "floor"
  rect: Rect
  material: MaterialId
  /** Overrides level.floorThickness when set. */
  thickness?: number
}

export interface WallObject extends BaseObject {
  type: "wall"
  a: Vec2
  b: Vec2
  /** Height above the wall's base (ground at its midpoint), feet. */
  height: number
  /** Strictly positive. The wall box is centred on the a→b line. */
  thickness: number
  material: MaterialId
}

export type DoorState = "open" | "closed" | "locked"

export type DoorStyle = "wood" | "iron" | "portcullis" | "bars" | "secret"

/**
 * Doors and windows are openings hosted by a wall. Their segment is derived from the
 * host wall: centre at `offset` feet along a→b, spanning `width` feet. `levelId` always
 * equals the host wall's level (enforced by core/scene/integrity).
 */
export interface DoorObject extends BaseObject {
  type: "door"
  wallId: Id
  offset: number
  width: number
  height: number
  state: DoorState
  style: DoorStyle
  leaves: "single" | "double"
  /** Which end of the opening (along a→b) the hinge is on. */
  hinge: "start" | "end"
  /** Side of the wall the leaf swings to: +1 = left of a→b (the +normal side), −1 = right. */
  swing: 1 | -1
}

export interface WindowObject extends BaseObject {
  type: "window"
  wallId: Id
  offset: number
  width: number
  sillHeight: number
  height: number
}

export type ConnectorStyle = "stairs" | "ladder" | "ramp"

/**
 * Links a lower level (`levelId`) to an upper level (`toLevelId`).
 * `rect` is cell-aligned (multiples of cellSize); ladders are exactly 1×1 cell.
 *  - Stairs/ramps: the run climbs in `direction`. A token on the run stays on `levelId` with
 *    its ground interpolated; it changes level only by an orthogonal step across the TOP edge
 *    (between the last footprint row and the next cell beyond it on `toLevelId`).
 *  - Ladders: a token on the ladder cell may switch between the two levels in place.
 */
export interface ConnectorObject extends BaseObject {
  type: "connector"
  style: ConnectorStyle
  toLevelId: Id
  rect: Rect
  /** Ascending direction: 0 = +Z, 1 = +X, 2 = -Z, 3 = -X. */
  direction: 0 | 1 | 2 | 3
  material: MaterialId
}

export interface PillarObject extends BaseObject {
  type: "pillar"
  position: Vec2
  shape: "round" | "square"
  /** Diameter / side length (feet). */
  size: number
  /** Height above ground; null = full storey height of its level. */
  height: number | null
  material: MaterialId
}

export type PropKind =
  | "table"
  | "chair"
  | "crate"
  | "barrel"
  | "chest"
  | "bookshelf"
  | "bed"
  | "altar"
  | "statue"
  | "tree"
  | "bush"
  | "rock"
  | "well"
  | "cart"

export interface PropObject extends BaseObject {
  type: "prop"
  kind: PropKind
  /** Base centre; y relative to ground (0 = resting on the ground). */
  position: Vec3
  rotationY: number
  /** Non-uniform XZ scale is allowed for box shapes; cylinder parts use max(x, z). */
  scale: Vec3
  color: string | null
  blocksMovement: boolean
  blocksSight: boolean
  castsShadows: boolean
}

export type LightPreset = "torch" | "lantern" | "brazier" | "candle" | "magical" | "custom"

export interface FlickerSettings {
  enabled: boolean
  /** Oscillations per second (roughly). */
  speed: number
  /** 0..1 fraction of INTENSITY modulation. Radii never flicker (vision thresholds use the static radii). */
  amount: number
}

export interface LightObject extends BaseObject {
  type: "light"
  preset: LightPreset
  /** y relative to the level ground (or, when attached, offset from the token's ground point). */
  position: Vec3
  color: string
  intensity: number
  /** Radius of bright light (feet, 3D distance). */
  brightRadius: number
  /** Radius of dim light (feet, 3D distance); >= brightRadius. */
  dimRadius: number
  flicker: FlickerSettings
  on: boolean
  /** false = unshadowed: lights through walls for BOTH rendering and vision. */
  castsShadows: boolean
  /** When set, the light follows this token and inherits its `hidden` flag. */
  attachedTokenId: Id | null
}

export type SceneObject =
  | FloorObject
  | WallObject
  | DoorObject
  | WindowObject
  | ConnectorObject
  | PillarObject
  | PropObject
  | LightObject

export type SceneObjectType = SceneObject["type"]

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export type CreatureSize = "tiny" | "small" | "medium" | "large" | "huge" | "gargantuan"

/**
 * Senses, combinable (e.g. darkvision 60 + blindsight 10, or blind + blindsight 10).
 * All zero / false = normal vision. Ranges are 3D distances in feet.
 */
export interface VisionSettings {
  darkvision: number
  blindsight: number
  blind: boolean
}

export type TokenKind = "pc" | "npc" | "monster"

export interface Token {
  id: Id
  /** DM-facing name. Players see `name` only for tokens they control or share vision with. */
  name: string
  /** Public nameplate shown to other players (null = none). */
  label: string | null
  kind: TokenKind
  levelId: Id
  /**
   * Footprint centre on the ground plane (feet). With grid snapping the footprint's min
   * corner sits on a cell corner, so medium tokens centre on cell centres and large
   * (2×2) tokens centre on cell corners.
   */
  position: Vec2
  size: CreatureSize
  /** Eye height above the token's ground (feet). The effective eye is clamped below ceilings. */
  eyeHeight: number
  /** Body height (feet) used for rendering and for "can I see its head over the wall". */
  height: number
  vision: VisionSettings
  /** Walking speed per turn (feet); used only when the DM enforces movement limits. */
  speed: number
  color: string
  imageUrl: string | null
  /** DM-only: hidden tokens (and lights attached to them) do not exist for players. */
  hidden: boolean
  dmNotes?: string
}

// ---------------------------------------------------------------------------
// Scene document
// ---------------------------------------------------------------------------

export interface SceneMeta {
  description: string
  author: string
  tags: string[]
}

export interface Scene {
  schemaVersion: typeof SCENE_SCHEMA_VERSION
  id: Id
  name: string
  createdAt: string
  updatedAt: string
  grid: GridSettings
  environment: Environment
  /** Keyed by id; order by (elevation, id) via sortedLevels(). */
  levels: Record<Id, Level>
  objects: Record<Id, SceneObject>
  tokens: Record<Id, Token>
  meta: SceneMeta
}

/**
 * The subset of a scene the renderer and the simulation need. A full Scene satisfies it, and
 * so does the scene a player client reconstructs from its PlayerView (core/session/viewToScene).
 */
export type SceneLike = Pick<Scene, "grid" | "environment" | "levels" | "objects" | "tokens">
