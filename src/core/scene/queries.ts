import { SIZE_FOOTPRINT } from "./defaults"
import { sampleHeight } from "./heightmap"
import type {
  ConnectorObject,
  DoorObject,
  Id,
  Level,
  Rect,
  Scene,
  SceneObject,
  SceneObjectType,
  Token,
  Vec2,
  Vec3,
  WallObject,
  WindowObject,
} from "./types"

export type Opening = DoorObject | WindowObject

export function levelById(scene: Pick<Scene, "levels">, id: Id): Level | undefined {
  return scene.levels.find((l) => l.id === id)
}

export function levelIndex(scene: Pick<Scene, "levels">, id: Id): number {
  return scene.levels.findIndex((l) => l.id === id)
}

/** Levels sorted by elevation (scene.levels should already be sorted; this is defensive). */
export function sortedLevels(scene: Pick<Scene, "levels">): Level[] {
  return [...scene.levels].sort((a, b) => a.elevation - b.elevation)
}

export function adjacentLevels(scene: Pick<Scene, "levels">, id: Id): { below?: Level; above?: Level } {
  const levels = sortedLevels(scene)
  const k = levels.findIndex((l) => l.id === id)
  return { below: k > 0 ? levels[k - 1] : undefined, above: k >= 0 ? levels[k + 1] : undefined }
}

export function objectsOfType<T extends SceneObjectType>(
  scene: Pick<Scene, "objects">,
  type: T,
  levelId?: Id
): Extract<SceneObject, { type: T }>[] {
  const out: Extract<SceneObject, { type: T }>[] = []
  for (const o of Object.values(scene.objects)) {
    if (o.type === type && (levelId === undefined || o.levelId === levelId)) {
      out.push(o as Extract<SceneObject, { type: T }>)
    }
  }
  return out
}

export function objectsOnLevel(scene: Pick<Scene, "objects">, levelId: Id): SceneObject[] {
  return Object.values(scene.objects).filter((o) => o.levelId === levelId)
}

export function wallOpenings(scene: Pick<Scene, "objects">, wallId: Id): Opening[] {
  const out: Opening[] = []
  for (const o of Object.values(scene.objects)) {
    if ((o.type === "door" || o.type === "window") && o.wallId === wallId) out.push(o)
  }
  return out.sort((a, b) => a.offset - b.offset)
}

export function wallLength(wall: Pick<WallObject, "a" | "b">): number {
  return Math.hypot(wall.b.x - wall.a.x, wall.b.z - wall.a.z)
}

/** Unit direction a→b of a wall (x,z). */
export function wallDirection(wall: Pick<WallObject, "a" | "b">): Vec2 {
  const len = wallLength(wall) || 1
  return { x: (wall.b.x - wall.a.x) / len, z: (wall.b.z - wall.a.z) / len }
}

/** Endpoints of an opening on its host wall (clamped to the wall). */
export function openingSegment(wall: Pick<WallObject, "a" | "b">, opening: Pick<Opening, "offset" | "width">): { a: Vec2; b: Vec2 } {
  const len = wallLength(wall)
  const dir = wallDirection(wall)
  const t0 = Math.max(0, Math.min(len, opening.offset - opening.width / 2))
  const t1 = Math.max(0, Math.min(len, opening.offset + opening.width / 2))
  return {
    a: { x: wall.a.x + dir.x * t0, z: wall.a.z + dir.z * t0 },
    b: { x: wall.a.x + dir.x * t1, z: wall.a.z + dir.z * t1 },
  }
}

export function rectContains(r: Rect, p: Vec2, eps = 0): boolean {
  return p.x >= r.x - eps && p.x <= r.x + r.w + eps && p.z >= r.z - eps && p.z <= r.z + r.d + eps
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.z < b.z + b.d && b.z < a.z + a.d
}

/** Ground height (world Y) of a level at x,z, ignoring connectors. */
export function levelGround(scene: Pick<Scene, "levels" | "grid">, levelId: Id, x: number, z: number): number {
  const level = levelById(scene, levelId)
  if (!level) return 0
  return level.elevation + sampleHeight(level.heightmap, scene.grid.cellSize, x, z)
}

/** 0 at the bottom edge of a connector's run, 1 at the top edge. */
export function connectorProgress(c: Pick<ConnectorObject, "rect" | "direction">, p: Vec2): number {
  const r = c.rect
  let t: number
  switch (c.direction) {
    case 0:
      t = (p.z - r.z) / r.d
      break
    case 1:
      t = (p.x - r.x) / r.w
      break
    case 2:
      t = (r.z + r.d - p.z) / r.d
      break
    case 3:
      t = (r.x + r.w - p.x) / r.w
      break
  }
  return Math.max(0, Math.min(1, t))
}

/** Connectors whose footprint contains p and that link `levelId` (as lower or upper level). */
export function connectorsAt(scene: Pick<Scene, "objects">, levelId: Id, p: Vec2): ConnectorObject[] {
  const out: ConnectorObject[] = []
  for (const o of Object.values(scene.objects)) {
    if (o.type !== "connector") continue
    if (o.levelId !== levelId && o.toLevelId !== levelId) continue
    if (rectContains(o.rect, p)) out.push(o)
  }
  return out
}

/** Ground height on a connector's run at p (world Y). */
export function connectorGround(scene: Pick<Scene, "levels" | "grid">, c: ConnectorObject, p: Vec2): number {
  const bottom = levelGround(scene, c.levelId, p.x, p.z)
  const upper = levelById(scene, c.toLevelId)
  const top = upper ? upper.elevation : bottom
  return bottom + (top - bottom) * connectorProgress(c, p)
}

/** Ground height (world Y) under a point on a level, including connector runs. */
export function groundHeightAt(scene: Pick<Scene, "levels" | "grid" | "objects">, levelId: Id, p: Vec2): number {
  const cs = connectorsAt(scene, levelId, p)
  if (cs.length > 0) return connectorGround(scene, cs[0], p)
  return levelGround(scene, levelId, p.x, p.z)
}

export function tokenGroundY(scene: Pick<Scene, "levels" | "grid" | "objects">, token: Pick<Token, "levelId" | "position">): number {
  return groundHeightAt(scene, token.levelId, token.position)
}

export function tokenEye(scene: Pick<Scene, "levels" | "grid" | "objects">, token: Pick<Token, "levelId" | "position" | "eyeHeight">): Vec3 {
  return { x: token.position.x, y: tokenGroundY(scene, token) + token.eyeHeight, z: token.position.z }
}

/** Footprint rect of a token on the ground plane. */
export function tokenRect(scene: Pick<Scene, "grid">, token: Pick<Token, "position" | "size">): Rect {
  const side = Math.max(1, SIZE_FOOTPRINT[token.size]) * scene.grid.cellSize
  return { x: token.position.x - side / 2, z: token.position.z - side / 2, w: side, d: side }
}

/** True if some floor object on the level covers (x,z). */
export function hasFloorAt(scene: Pick<Scene, "objects">, levelId: Id, p: Vec2): boolean {
  for (const o of Object.values(scene.objects)) {
    if (o.type === "floor" && o.levelId === levelId && rectContains(o.rect, p)) return true
  }
  return false
}

/** World-space position of a light (resolves attachment to a token). */
export function lightWorldPosition(scene: Scene, light: Extract<SceneObject, { type: "light" }>): Vec3 {
  if (light.attachedTokenId) {
    const t = scene.tokens[light.attachedTokenId]
    if (t) {
      return { x: t.position.x + light.position.x, y: tokenGroundY(scene, t) + light.position.y, z: t.position.z + light.position.z }
    }
  }
  const ground = levelGround(scene, light.levelId, light.position.x, light.position.z)
  return { x: light.position.x, y: ground + light.position.y, z: light.position.z }
}

/** Level a light currently belongs to (attached lights follow their token's level). */
export function lightLevelId(scene: Scene, light: Extract<SceneObject, { type: "light" }>): Id {
  if (light.attachedTokenId) {
    const t = scene.tokens[light.attachedTokenId]
    if (t) return t.levelId
  }
  return light.levelId
}
