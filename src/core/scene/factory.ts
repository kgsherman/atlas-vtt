import { nanoid } from "nanoid"

import {
  DEFAULT_CELL_SIZE,
  DEFAULT_DOOR_HEIGHT,
  DEFAULT_DOOR_WIDTH,
  DEFAULT_FLOOR_THICKNESS,
  DEFAULT_LEVEL_HEIGHT,
  DEFAULT_WALL_THICKNESS,
  DEFAULT_WINDOW_HEIGHT,
  DEFAULT_WINDOW_SILL,
  DEFAULT_WINDOW_WIDTH,
  LIGHT_PRESETS,
  PROP_LIBRARY,
  SIZE_BODY,
  TOKEN_COLORS,
} from "./defaults"
import {
  SCENE_SCHEMA_VERSION,
  type ConnectorObject,
  type CreatureSize,
  type DoorObject,
  type Environment,
  type FloorObject,
  type Id,
  type Level,
  type LightObject,
  type LightPreset,
  type PillarObject,
  type PropKind,
  type PropObject,
  type Rect,
  type Scene,
  type Token,
  type Vec2,
  type Vec3,
  type WallObject,
  type WindowObject,
} from "./types"

export const newId = (): Id => nanoid(12)

export function defaultEnvironment(): Environment {
  return {
    skyLevel: "dark",
    ambientLevel: "dark",
    ambientColor: "#8090b0",
    ambientIntensity: 0.12,
    directional: {
      enabled: false,
      kind: "moon",
      azimuth: Math.PI * 0.75,
      elevation: Math.PI * 0.3,
      color: "#9fb4ff",
      intensity: 0.35,
      grants: "dim",
    },
    backgroundColor: "#0b0d10",
  }
}

export function createLevel(partial: Partial<Level> = {}): Level {
  return {
    id: newId(),
    name: "Ground Floor",
    elevation: 0,
    height: DEFAULT_LEVEL_HEIGHT,
    floorThickness: DEFAULT_FLOOR_THICKNESS,
    heightmap: null,
    ...partial,
  }
}

/**
 * A new scene has one ground level covered by a single floor (floors are what tokens stand on
 * and what blocks sight between levels; there is no implicit ground).
 */
export function createScene(partial: Partial<Pick<Scene, "name">> & { width?: number; depth?: number; groundFloor?: boolean } = {}): Scene {
  const now = new Date().toISOString()
  const width = partial.width ?? 40
  const depth = partial.depth ?? 30
  const ground = createLevel()
  const scene: Scene = {
    schemaVersion: SCENE_SCHEMA_VERSION,
    id: newId(),
    name: partial.name ?? "Untitled Scene",
    createdAt: now,
    updatedAt: now,
    grid: { cellSize: DEFAULT_CELL_SIZE, width, depth, diagonalRule: "5-5-5", visionOrigin: "square" },
    environment: defaultEnvironment(),
    levels: { [ground.id]: ground },
    objects: {},
    tokens: {},
    meta: { tags: [] },
  }
  if (partial.groundFloor !== false) {
    const floor = createFloor(ground.id, { x: 0, z: 0, w: width * DEFAULT_CELL_SIZE, d: depth * DEFAULT_CELL_SIZE }, "grass")
    scene.objects[floor.id] = floor
  }
  return scene
}

export function createFloor(levelId: Id, rect: Rect, material: FloorObject["material"] = "stone"): FloorObject {
  return { id: newId(), type: "floor", levelId, rect, material }
}

export function createWall(levelId: Id, a: Vec2, b: Vec2, partial: Partial<WallObject> = {}): WallObject {
  return {
    id: newId(),
    type: "wall",
    levelId,
    a,
    b,
    height: DEFAULT_LEVEL_HEIGHT,
    thickness: DEFAULT_WALL_THICKNESS,
    material: "stone",
    followTerrain: true,
    ...partial,
  }
}

export function createDoor(wall: WallObject, offset: number, partial: Partial<DoorObject> = {}): DoorObject {
  return {
    id: newId(),
    type: "door",
    levelId: wall.levelId,
    wallId: wall.id,
    offset,
    width: DEFAULT_DOOR_WIDTH,
    height: Math.min(DEFAULT_DOOR_HEIGHT, wall.height),
    state: "closed",
    style: "wood",
    leaves: "single",
    hinge: "start",
    swing: 1,
    ...partial,
  }
}

export function createWindow(wall: WallObject, offset: number, partial: Partial<WindowObject> = {}): WindowObject {
  return {
    id: newId(),
    type: "window",
    levelId: wall.levelId,
    wallId: wall.id,
    offset,
    width: DEFAULT_WINDOW_WIDTH,
    sillHeight: DEFAULT_WINDOW_SILL,
    height: DEFAULT_WINDOW_HEIGHT,
    ...partial,
  }
}

export function createConnector(
  levelId: Id,
  toLevelId: Id,
  rect: Rect,
  direction: ConnectorObject["direction"],
  style: ConnectorObject["style"] = "stairs"
): ConnectorObject {
  return { id: newId(), type: "connector", levelId, toLevelId, rect, direction, style, material: "wood" }
}

export function createPillar(levelId: Id, position: Vec2, partial: Partial<PillarObject> = {}): PillarObject {
  return { id: newId(), type: "pillar", levelId, position, shape: "round", size: 2, height: null, material: "stone", ...partial }
}

export function createProp(levelId: Id, kind: PropKind, position: Vec3, partial: Partial<PropObject> = {}): PropObject {
  const def = PROP_LIBRARY[kind]
  return {
    id: newId(),
    type: "prop",
    levelId,
    kind,
    position,
    rotationY: 0,
    scale: { x: 1, y: 1, z: 1 },
    color: null,
    blocksMovement: def.blocksMovement,
    blocksSight: def.blocksSight,
    castsShadows: def.castsShadows,
    ...partial,
  }
}

export function createLight(levelId: Id, preset: LightPreset, position: Vec2, partial: Partial<LightObject> = {}): LightObject {
  const def = LIGHT_PRESETS[preset]
  return {
    id: newId(),
    type: "light",
    levelId,
    preset,
    position: { x: position.x, y: def.height, z: position.z },
    color: def.color,
    intensity: def.intensity,
    brightRadius: def.brightRadius,
    dimRadius: def.dimRadius,
    flicker: { ...def.flicker },
    on: true,
    castsShadows: true,
    attachedTokenId: null,
    ...partial,
  }
}

let tokenColorCursor = 0

export function createToken(levelId: Id, position: Vec2, partial: Partial<Token> = {}): Token {
  const size: CreatureSize = partial.size ?? "medium"
  const body = SIZE_BODY[size]
  return {
    id: newId(),
    name: "Token",
    label: null,
    kind: "pc",
    levelId,
    position,
    size,
    eyeHeight: body.eyeHeight,
    height: body.height,
    vision: { darkvision: 0, blindsight: 0, blind: false },
    speed: 30,
    color: TOKEN_COLORS[tokenColorCursor++ % TOKEN_COLORS.length],
    imageUrl: null,
    hidden: false,
    ...partial,
  }
}
