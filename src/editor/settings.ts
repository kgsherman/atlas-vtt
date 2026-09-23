/**
 * Editor tool settings and view options (plain data kept in the editor store).
 */
import type { SnapMode } from "@/core/grid/grid"
import {
  DEFAULT_DOOR_HEIGHT,
  DEFAULT_DOOR_WIDTH,
  DEFAULT_LEVEL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_SILL,
  DEFAULT_WINDOW_WIDTH,
} from "@/core/scene/defaults"
import type { BrushFalloff, BrushMode } from "@/core/scene/heightmapBrush"
import type {
  ConnectorObject,
  ConnectorStyle,
  CreatureSize,
  DoorObject,
  DoorStyle,
  Id,
  LightPreset,
  MaterialId,
  PillarObject,
  PropKind,
  TokenKind,
} from "@/core/scene/types"
import type { CameraKind } from "@/render/contracts"

export interface WallToolSettings {
  height: number
  thickness: number
  material: MaterialId
}

export interface FloorToolSettings {
  material: MaterialId
}

export interface DoorToolSettings {
  style: DoorStyle
  width: number
  height: number
  leaves: DoorObject["leaves"]
}

export interface WindowToolSettings {
  width: number
  height: number
  sillHeight: number
}

export interface ConnectorToolSettings {
  style: ConnectorStyle
  /** Ascending direction, or "auto" = the dominant axis of the drag (from the bottom of the run to the top). */
  direction: ConnectorObject["direction"] | "auto"
  material: MaterialId
}

export interface PillarToolSettings {
  shape: PillarObject["shape"]
  size: number
  /** null = full storey height. */
  height: number | null
  material: MaterialId
}

export interface PropToolSettings {
  kind: PropKind
  /** Rotation of the next placed prop (radians); R rotates the preview. */
  rotationY: number
}

export interface LightToolSettings {
  preset: LightPreset
}

export interface BrushToolSettings {
  mode: BrushMode
  /** Feet. */
  radius: number
  /** raise/lower: feet per dab at the centre; smooth/flatten: blend factor 0..1 per dab. */
  strength: number
  falloff: BrushFalloff
}

export interface TokenToolSettings {
  size: CreatureSize
  kind: TokenKind
}

export interface ToolSettings {
  wall: WallToolSettings
  floor: FloorToolSettings
  door: DoorToolSettings
  window: WindowToolSettings
  connector: ConnectorToolSettings
  pillar: PillarToolSettings
  prop: PropToolSettings
  light: LightToolSettings
  brush: BrushToolSettings
  token: TokenToolSettings
}

export const BRUSH_RADIUS_MIN = 1
export const BRUSH_RADIUS_MAX = 100

export function defaultToolSettings(): ToolSettings {
  return {
    wall: { height: DEFAULT_LEVEL_HEIGHT, thickness: DEFAULT_WALL_THICKNESS, material: "stone" },
    floor: { material: "stone" },
    door: { style: "wood", width: DEFAULT_DOOR_WIDTH, height: DEFAULT_DOOR_HEIGHT, leaves: "single" },
    window: { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT, sillHeight: DEFAULT_WINDOW_SILL },
    connector: { style: "stairs", direction: "auto", material: "wood" },
    pillar: { shape: "round", size: 2, height: null, material: "stone" },
    prop: { kind: "crate", rotationY: 0 },
    light: { preset: "torch" },
    brush: { mode: "raise", radius: 10, strength: 0.5, falloff: "smooth" },
    token: { size: "medium", kind: "pc" },
  }
}

export interface EditorViewOptions {
  /** Per-level visibility (missing = visible). */
  levelVisibility: Record<Id, boolean>
  /** Draw the levels directly above/below the active level as translucent ghosts. */
  ghostAdjacent: boolean
  showGrid: boolean
  /** Light radius gizmos, connector arrows, hidden objects outlined. */
  showHelpers: boolean
  /** DM dark vision: dark areas lifted (and marked) so a dark level stays workable. */
  darkVision: boolean
  camera: CameraKind
}

export function defaultViewOptions(): EditorViewOptions {
  return { levelVisibility: {}, ghostAdjacent: true, showGrid: true, showHelpers: true, darkVision: false, camera: "orbit" }
}

export const DEFAULT_SNAP_MODE: SnapMode = "center"
