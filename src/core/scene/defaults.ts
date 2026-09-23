/**
 * Shared presets and physical dimensions. Both the renderer (geometry) and the
 * simulation (occlusion/movement) read these tables, so the visible shape of a prop
 * and the shape that blocks sight/movement always agree.
 */
import type {
  CreatureSize,
  DoorStyle,
  LightPreset,
  MaterialId,
  PropKind,
  Vec3,
} from "./types"

export const DEFAULT_CELL_SIZE = 5
export const DEFAULT_LEVEL_HEIGHT = 10
export const DEFAULT_FLOOR_THICKNESS = 1
export const DEFAULT_WALL_THICKNESS = 0.5
/** Shortest wall (a→b, feet) the schema accepts. */
export const MIN_WALL_LENGTH = 0.01
export const DEFAULT_DOOR_WIDTH = 4
export const DEFAULT_DOOR_HEIGHT = 7
export const DEFAULT_WINDOW_WIDTH = 3
export const DEFAULT_WINDOW_SILL = 3
export const DEFAULT_WINDOW_HEIGHT = 3

/** Footprint in cells (tiny creatures occupy half a cell but reserve one). */
export const SIZE_FOOTPRINT: Record<CreatureSize, number> = {
  tiny: 0.5,
  small: 1,
  medium: 1,
  large: 2,
  huge: 3,
  gargantuan: 4,
}

/** Typical body height and eye height in feet, used as token defaults. */
export const SIZE_BODY: Record<CreatureSize, { height: number; eyeHeight: number }> = {
  tiny: { height: 1.5, eyeHeight: 1 },
  small: { height: 3.5, eyeHeight: 3 },
  medium: { height: 6, eyeHeight: 5.5 },
  large: { height: 10, eyeHeight: 9 },
  huge: { height: 16, eyeHeight: 14 },
  gargantuan: { height: 24, eyeHeight: 21 },
}

export interface LightPresetDef {
  color: string
  intensity: number
  brightRadius: number
  dimRadius: number
  flicker: { enabled: boolean; speed: number; amount: number }
  /** Default mounting height above ground. */
  height: number
}

export const LIGHT_PRESETS: Record<LightPreset, LightPresetDef> = {
  torch: { color: "#ff9a3c", intensity: 1.4, brightRadius: 20, dimRadius: 40, flicker: { enabled: true, speed: 6, amount: 0.18 }, height: 5 },
  lantern: { color: "#ffc27a", intensity: 1.2, brightRadius: 30, dimRadius: 60, flicker: { enabled: true, speed: 3, amount: 0.06 }, height: 4 },
  brazier: { color: "#ff7a2a", intensity: 1.6, brightRadius: 15, dimRadius: 30, flicker: { enabled: true, speed: 5, amount: 0.22 }, height: 3 },
  candle: { color: "#ffb45e", intensity: 0.8, brightRadius: 5, dimRadius: 10, flicker: { enabled: true, speed: 8, amount: 0.25 }, height: 3 },
  magical: { color: "#8fb8ff", intensity: 1.3, brightRadius: 20, dimRadius: 40, flicker: { enabled: false, speed: 1, amount: 0.05 }, height: 6 },
  custom: { color: "#ffffff", intensity: 1, brightRadius: 20, dimRadius: 40, flicker: { enabled: false, speed: 2, amount: 0.1 }, height: 5 },
}

/**
 * Occluder / collision shape of a prop, in the prop's local frame (unscaled feet, base at y = 0,
 * centred on x/z). Both render/builders and core/occlusion read this, so what you see is what blocks.
 */
export interface PropPart {
  shape: "box" | "cylinder"
  /** Centre of the part's base, local. */
  offset: Vec3
  /** Box: full extents. Cylinder: x = z = diameter, y = height. */
  size: Vec3
}

export interface PropDef {
  label: string
  /** Unscaled bounding box size (feet): x = width, y = height, z = depth. Base sits on the ground. */
  size: Vec3
  /** Parts that block (movement/sight/light per the prop's flags). */
  parts: PropPart[]
  blocksMovement: boolean
  blocksSight: boolean
  castsShadows: boolean
  defaultColor: string
}

const box = (x: number, y: number, z: number, oy = 0): PropPart => ({ shape: "box", offset: { x: 0, y: oy, z: 0 }, size: { x, y, z } })
const cyl = (d: number, h: number, oy = 0): PropPart => ({ shape: "cylinder", offset: { x: 0, y: oy, z: 0 }, size: { x: d, y: h, z: d } })

export const PROP_LIBRARY: Record<PropKind, PropDef> = {
  table: { label: "Table", size: { x: 5, y: 2.5, z: 3 }, parts: [box(5, 2.5, 3)], blocksMovement: true, blocksSight: false, castsShadows: true, defaultColor: "#8a5a34" },
  chair: { label: "Chair", size: { x: 1.5, y: 3, z: 1.5 }, parts: [box(1.5, 3, 1.5)], blocksMovement: false, blocksSight: false, castsShadows: true, defaultColor: "#7a4e2c" },
  crate: { label: "Crate", size: { x: 3, y: 3, z: 3 }, parts: [box(3, 3, 3)], blocksMovement: true, blocksSight: true, castsShadows: true, defaultColor: "#a07444" },
  barrel: { label: "Barrel", size: { x: 2.5, y: 3.5, z: 2.5 }, parts: [cyl(2.5, 3.5)], blocksMovement: true, blocksSight: true, castsShadows: true, defaultColor: "#6f4a2a" },
  chest: { label: "Chest", size: { x: 3, y: 2, z: 2 }, parts: [box(3, 2, 2)], blocksMovement: true, blocksSight: false, castsShadows: true, defaultColor: "#7b5530" },
  bookshelf: { label: "Bookshelf", size: { x: 4, y: 7, z: 1.5 }, parts: [box(4, 7, 1.5)], blocksMovement: true, blocksSight: true, castsShadows: true, defaultColor: "#5e3b22" },
  bed: { label: "Bed", size: { x: 3.5, y: 2, z: 7 }, parts: [box(3.5, 2, 7)], blocksMovement: true, blocksSight: false, castsShadows: true, defaultColor: "#9b6b4a" },
  altar: { label: "Altar", size: { x: 5, y: 3.5, z: 3 }, parts: [box(5, 3.5, 3)], blocksMovement: true, blocksSight: false, castsShadows: true, defaultColor: "#bdb6a8" },
  statue: { label: "Statue", size: { x: 3, y: 8, z: 3 }, parts: [box(3, 1, 3), cyl(1.8, 7, 1)], blocksMovement: true, blocksSight: true, castsShadows: true, defaultColor: "#c8c2b4" },
  // Trunk + raised canopy: ground-level sight passes under the canopy except at the trunk.
  tree: { label: "Tree", size: { x: 8, y: 18, z: 8 }, parts: [cyl(1.5, 7), cyl(8, 11, 7)], blocksMovement: true, blocksSight: true, castsShadows: true, defaultColor: "#3f7a3a" },
  bush: { label: "Bush", size: { x: 4, y: 3, z: 4 }, parts: [cyl(4, 3)], blocksMovement: false, blocksSight: true, castsShadows: true, defaultColor: "#4d8a42" },
  rock: { label: "Boulder", size: { x: 5, y: 4, z: 5 }, parts: [cyl(4.5, 4)], blocksMovement: true, blocksSight: true, castsShadows: true, defaultColor: "#8d8a85" },
  well: { label: "Well", size: { x: 5, y: 3, z: 5 }, parts: [cyl(5, 3)], blocksMovement: true, blocksSight: false, castsShadows: true, defaultColor: "#9a948a" },
  cart: { label: "Cart", size: { x: 5, y: 4, z: 8 }, parts: [box(5, 4, 8)], blocksMovement: true, blocksSight: false, castsShadows: true, defaultColor: "#7d5634" },
}

export interface DoorStyleDef {
  label: string
  /** When closed or locked. Open doors never block. */
  blocksSightClosed: boolean
  blocksLightClosed: boolean
  motion: "swing" | "lift" | "slide"
}

export const DOOR_STYLES: Record<DoorStyle, DoorStyleDef> = {
  wood: { label: "Wooden door", blocksSightClosed: true, blocksLightClosed: true, motion: "swing" },
  iron: { label: "Iron door", blocksSightClosed: true, blocksLightClosed: true, motion: "swing" },
  portcullis: { label: "Portcullis", blocksSightClosed: false, blocksLightClosed: false, motion: "lift" },
  bars: { label: "Barred gate", blocksSightClosed: false, blocksLightClosed: false, motion: "swing" },
  secret: { label: "Secret door", blocksSightClosed: true, blocksLightClosed: true, motion: "swing" },
}

/** Base albedo per material (sRGB hex). The renderer may add procedural detail. */
export const MATERIAL_COLORS: Record<MaterialId, string> = {
  stone: "#8f8b85",
  brick: "#9a5b45",
  wood: "#8a6039",
  plaster: "#d8d0c0",
  dirt: "#6e5a40",
  grass: "#5b8a3c",
  sand: "#cdb887",
  water: "#3a6d8c",
  metal: "#7c828a",
  marble: "#e3e0da",
  tile: "#a39a8c",
  cobble: "#7a756c",
}

export const TOKEN_COLORS = [
  "#e05252",
  "#e0a052",
  "#d8d052",
  "#52c060",
  "#52b0e0",
  "#6a6ae0",
  "#b060e0",
  "#e060a8",
]
