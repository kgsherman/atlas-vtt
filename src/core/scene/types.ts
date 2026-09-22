/**
 * Atlas VTT scene document — the versioned JSON contract shared by the editor,
 * renderer, simulation (vision/movement) and network layers.
 *
 * Conventions (see docs/ARCHITECTURE.md §2):
 *  - 1 world unit = 1 foot. Y is up. The grid lies on the XZ plane.
 *  - Grid cell (i, j) spans x ∈ [i·cellSize, (i+1)·cellSize), z ∈ [j·cellSize, (j+1)·cellSize).
 *  - Positions of objects on a level are in world X/Z; their Y values are RELATIVE to
 *    the level's ground (level.elevation + heightmap sample), unless stated otherwise.
 *  - Angles are radians. Colours are "#rrggbb" strings.
 *  - Collections keyed by id are Records so immer patches stay stable for undo/redo
 *    and network diffs.
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
  /** Scene extent in cells along X. */
  width: number
  /** Scene extent in cells along Z. */
  depth: number
  /** How diagonal moves are measured by the ruler and movement validation. */
  diagonalRule: DiagonalRule
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Baseline light level where no light source reaches (D&D-style). */
export type AmbientLevel = "bright" | "dim" | "dark"

export interface DirectionalLightSettings {
  enabled: boolean
  kind: "sun" | "moon"
  /** Compass direction the light comes FROM, radians (0 = +Z/north, π/2 = +X/east). */
  azimuth: number
  /** Angle above the horizon, radians (π/2 = straight down). */
  elevation: number
  color: string
  intensity: number
  castsShadows: boolean
  /** Light level the directional light grants to surfaces it reaches ("bright" for sun, "dim" for moon). */
  grants: Exclude<AmbientLevel, "dark">
}

export interface Environment {
  /** Unlit-area light level used by the vision rules. */
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

export interface Heightmap {
  /** Samples per cell edge (1 = one sample per 5 ft; 4 = one per 1.25 ft). */
  resolution: number
  /** Sample counts = grid.width * resolution + 1 and grid.depth * resolution + 1. */
  samplesX: number
  samplesZ: number
  /** base64 of a little-endian Float32Array (samplesX * samplesZ, row-major by z then x); heights in feet relative to level.elevation. */
  data: string
}

export interface Level {
  id: Id
  name: string
  /** World Y of this level's ground surface (feet). */
  elevation: number
  /** Storey height: default wall height and the Y above which the next level begins (feet). */
  height: number
  /** Thickness of floor slabs placed on this level (extends downward from elevation). */
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
  name?: string
  /** DM-only notes; always stripped from player views. */
  dmNotes?: string
  /** Editor lock (prevents selection/drag in the editor). */
  locked?: boolean
  /** DM-only: never sent to players, never rendered in player view. */
  hidden?: boolean
}

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
  /** Height above ground (feet). */
  height: number
  thickness: number
  material: MaterialId
}

export type DoorState = "open" | "closed" | "locked"

/**
 * Doors and windows are openings hosted by a wall. Their segment is derived from the
 * host wall: centre at `offset` feet along a→b, spanning `width` feet.
 */
export interface DoorObject extends BaseObject {
  type: "door"
  wallId: Id
  offset: number
  width: number
  height: number
  state: DoorState
  style: "wood" | "iron" | "portcullis" | "secret"
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
 * Links two levels. The footprint lies on `levelId` (the lower level) and climbs in
 * `direction` towards `toLevelId`. A token standing on any footprint cell may switch
 * between the two levels; its ground height is interpolated along the run.
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
  /** Base centre; y relative to ground. */
  position: Vec3
  rotationY: number
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
  /** 0..1 fraction of intensity/radius modulation. */
  amount: number
}

export interface LightObject extends BaseObject {
  type: "light"
  preset: LightPreset
  /** y relative to the level ground. */
  position: Vec3
  color: string
  intensity: number
  /** Radius of bright light (feet). */
  brightRadius: number
  /** Radius of dim light (feet); >= brightRadius. */
  dimRadius: number
  flicker: FlickerSettings
  on: boolean
  castsShadows: boolean
  /** When set, the light follows this token (position is then an offset from the token's ground point). */
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

export type VisionType = "normal" | "darkvision" | "blindsight" | "blind"

export interface VisionSettings {
  type: VisionType
  /** Range for darkvision / blindsight (feet). Ignored for normal/blind. */
  range: number
}

export type TokenKind = "pc" | "npc" | "monster"

export interface Token {
  id: Id
  name: string
  kind: TokenKind
  levelId: Id
  /** Centre on the ground plane (feet). Snapped to cell centres unless free placement. */
  position: Vec2
  size: CreatureSize
  /** Eye height above the token's ground (feet). */
  eyeHeight: number
  /** Body height (feet) used for rendering and for "can I see its head over the wall". */
  height: number
  vision: VisionSettings
  /** Walking speed per turn (feet); used only when the DM enforces movement limits. */
  speed: number
  /** Auth user ids of the players who control this token. */
  ownerIds: string[]
  color: string
  imageUrl: string | null
  /** DM-only: hidden tokens are never sent to players. */
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
  /** Ordered by elevation ascending. */
  levels: Level[]
  objects: Record<Id, SceneObject>
  tokens: Record<Id, Token>
  meta: SceneMeta
}
