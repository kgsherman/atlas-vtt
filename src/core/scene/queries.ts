import { SIZE_FOOTPRINT } from "./defaults"
import { sampleHeight } from "./heightmap"
import type {
  ConnectorObject,
  DoorObject,
  Id,
  Level,
  LightObject,
  Rect,
  SceneLike,
  SceneObject,
  SceneObjectType,
  Token,
  Vec2,
  Vec3,
  WallObject,
  WindowObject,
} from "./types"

export type Opening = DoorObject | WindowObject

type Levels = Pick<SceneLike, "levels">

// ---------------------------------------------------------------------------
// Levels
// ---------------------------------------------------------------------------

export function levelById(scene: Levels, id: Id): Level | undefined {
  return Object.hasOwn(scene.levels, id) ? scene.levels[id] : undefined
}

const sortedCache = new WeakMap<object, Level[]>()

/** Levels ordered by (elevation, id). Memoised on the identity of scene.levels. */
export function sortedLevels(scene: Levels): Level[] {
  let out = sortedCache.get(scene.levels)
  if (!out) {
    out = Object.values(scene.levels).sort((a, b) => a.elevation - b.elevation || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    sortedCache.set(scene.levels, out)
  }
  return out
}

export function levelIndex(scene: Levels, id: Id): number {
  return sortedLevels(scene).findIndex((l) => l.id === id)
}

export function adjacentLevels(scene: Levels, id: Id): { below?: Level; above?: Level } {
  const levels = sortedLevels(scene)
  const k = levels.findIndex((l) => l.id === id)
  if (k < 0) return {}
  return { below: k > 0 ? levels[k - 1] : undefined, above: levels[k + 1] }
}

/** Underside Y of the level above (where this level's ceiling is), or elevation + height if none. */
export function levelCeilingY(scene: Levels, id: Id): number {
  const level = levelById(scene, id)
  if (!level) return 0
  const { above } = adjacentLevels(scene, id)
  return above ? above.elevation - above.floorThickness : level.elevation + level.height
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

export function objectsOfType<T extends SceneObjectType>(
  scene: Pick<SceneLike, "objects">,
  type: T,
  levelId?: Id
): Extract<SceneObject, { type: T }>[] {
  const out: Extract<SceneObject, { type: T }>[] = []
  for (const o of Object.values(scene.objects)) {
    if (o.type === type && (levelId === undefined || o.levelId === levelId)) {
      out.push(o as Extract<SceneObject, { type: T }>)
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function objectsOnLevel(scene: Pick<SceneLike, "objects">, levelId: Id): SceneObject[] {
  return Object.values(scene.objects)
    .filter((o) => o.levelId === levelId)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export function wallOpenings(scene: Pick<SceneLike, "objects">, wallId: Id): Opening[] {
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

/** Unit normal of a wall: a→b rotated +90° about Y (the "left" side, swing = +1). */
export function wallNormal(wall: Pick<WallObject, "a" | "b">): Vec2 {
  const d = wallDirection(wall)
  return { x: -d.z, z: d.x }
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

// ---------------------------------------------------------------------------
// Rects
// ---------------------------------------------------------------------------

/** Half-open containment: [x, x+w) × [z, z+d). */
export function rectContains(r: Rect, p: Vec2): boolean {
  return p.x >= r.x && p.x < r.x + r.w && p.z >= r.z && p.z < r.z + r.d
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.z < b.z + b.d && b.z < a.z + a.d
}

export function rectIntersection(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x)
  const z0 = Math.max(a.z, b.z)
  const x1 = Math.min(a.x + a.w, b.x + b.w)
  const z1 = Math.min(a.z + a.d, b.z + b.d)
  if (x1 <= x0 || z1 <= z0) return null
  return { x: x0, z: z0, w: x1 - x0, d: z1 - z0 }
}

/** a minus b as at most 4 disjoint rects. */
export function rectSubtract(a: Rect, b: Rect): Rect[] {
  const i = rectIntersection(a, b)
  if (!i) return [a]
  const out: Rect[] = []
  if (i.z > a.z) out.push({ x: a.x, z: a.z, w: a.w, d: i.z - a.z })
  if (i.z + i.d < a.z + a.d) out.push({ x: a.x, z: i.z + i.d, w: a.w, d: a.z + a.d - (i.z + i.d) })
  if (i.x > a.x) out.push({ x: a.x, z: i.z, w: i.x - a.x, d: i.d })
  if (i.x + i.w < a.x + a.w) out.push({ x: i.x + i.w, z: i.z, w: a.x + a.w - (i.x + i.w), d: i.d })
  return out
}

// ---------------------------------------------------------------------------
// Ground, floors and connectors
// ---------------------------------------------------------------------------

/** Ground height (world Y) of a level at x,z from elevation + heightmap, ignoring connectors. */
export function levelGround(scene: Pick<SceneLike, "levels" | "grid">, levelId: Id, x: number, z: number): number {
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

/** Unit XZ vector of a connector's ascending direction. */
export function connectorForward(direction: ConnectorObject["direction"]): Vec2 {
  return [
    { x: 0, z: 1 },
    { x: 1, z: 0 },
    { x: 0, z: -1 },
    { x: -1, z: 0 },
  ][direction]
}

/**
 * Connectors whose footprint contains p (half-open) and whose rules apply to a token on `levelId`:
 * stairs/ramps only for their lower level; ladders for both levels. Sorted by id.
 */
export function connectorsAt(scene: Pick<SceneLike, "objects">, levelId: Id, p: Vec2): ConnectorObject[] {
  const out: ConnectorObject[] = []
  for (const o of Object.values(scene.objects)) {
    if (o.type !== "connector") continue
    const applies = o.style === "ladder" ? o.levelId === levelId || o.toLevelId === levelId : o.levelId === levelId
    if (applies && rectContains(o.rect, p)) out.push(o)
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Ground (world Y) on a stairs/ramp run at p: lower ground at the bottom edge → upper ground at the top edge. */
export function connectorGround(scene: Pick<SceneLike, "levels" | "grid">, c: ConnectorObject, p: Vec2): number {
  const t = connectorProgress(c, p)
  const f = connectorForward(c.direction)
  const r = c.rect
  // Point on the bottom and top edges in line with p.
  const cx = Math.min(Math.max(p.x, r.x), r.x + r.w)
  const cz = Math.min(Math.max(p.z, r.z), r.z + r.d)
  const bottomPt = { x: f.x > 0 ? r.x : f.x < 0 ? r.x + r.w : cx, z: f.z > 0 ? r.z : f.z < 0 ? r.z + r.d : cz }
  const topPt = { x: f.x > 0 ? r.x + r.w : f.x < 0 ? r.x : cx, z: f.z > 0 ? r.z + r.d : f.z < 0 ? r.z : cz }
  const bottom = levelGround(scene, c.levelId, bottomPt.x, bottomPt.z)
  const top = levelGround(scene, c.toLevelId, topPt.x, topPt.z)
  return bottom + (top - bottom) * t
}

/** Ground height (world Y) under a point on a level, including stairs/ramp runs. */
export function groundHeightAt(scene: Pick<SceneLike, "levels" | "grid" | "objects">, levelId: Id, p: Vec2): number {
  for (const c of connectorsAt(scene, levelId, p)) {
    if (c.style !== "ladder") return connectorGround(scene, c, p)
  }
  return levelGround(scene, levelId, p.x, p.z)
}

/**
 * Connector footprints that cut through a level's floors: connectors whose rise passes through
 * this level's slab (bottom elevation < level.elevation <= top elevation).
 */
export function floorCutouts(scene: Pick<SceneLike, "levels" | "objects">, levelId: Id): Rect[] {
  const level = levelById(scene, levelId)
  if (!level) return []
  const out: Rect[] = []
  for (const o of Object.values(scene.objects)) {
    if (o.type !== "connector") continue
    const lo = levelById(scene, o.levelId)
    const hi = levelById(scene, o.toLevelId)
    if (!lo || !hi) continue
    const bottom = Math.min(lo.elevation, hi.elevation)
    const top = Math.max(lo.elevation, hi.elevation)
    if (bottom < level.elevation && level.elevation <= top) out.push(o.rect)
  }
  return out
}

export interface EffectiveFloor {
  floorId: Id
  rect: Rect
}

/** Floor rects of a level with connector cutouts subtracted. Single source for render, occlusion and movement. */
export function effectiveFloorRects(scene: Pick<SceneLike, "levels" | "objects">, levelId: Id): EffectiveFloor[] {
  const cutouts = floorCutouts(scene, levelId)
  const out: EffectiveFloor[] = []
  for (const f of objectsOfType(scene, "floor", levelId)) {
    let pieces: Rect[] = [f.rect]
    for (const c of cutouts) pieces = pieces.flatMap((p) => rectSubtract(p, c))
    for (const rect of pieces) out.push({ floorId: f.id, rect })
  }
  return out
}

/** True if a floor (after cutouts) covers p on the level, or p is on a connector usable from this level. */
export function hasGroundAt(scene: Pick<SceneLike, "levels" | "objects">, levelId: Id, p: Vec2): boolean {
  if (connectorsAt(scene, levelId, p).length > 0) return true
  return effectiveFloorRects(scene, levelId).some((f) => rectContains(f.rect, p))
}

// ---------------------------------------------------------------------------
// Tokens and lights
// ---------------------------------------------------------------------------

export function tokenGroundY(scene: Pick<SceneLike, "levels" | "grid" | "objects">, token: Pick<Token, "levelId" | "position">): number {
  return groundHeightAt(scene, token.levelId, token.position)
}

/**
 * Nominal eye position (ground + eyeHeight), NOT clamped below ceilings. Vision and the renderer
 * must use core/vision's resolveViewerEye(), which clamps it.
 */
export function nominalTokenEye(scene: Pick<SceneLike, "levels" | "grid" | "objects">, token: Pick<Token, "levelId" | "position" | "eyeHeight">): Vec3 {
  return { x: token.position.x, y: tokenGroundY(scene, token) + token.eyeHeight, z: token.position.z }
}

/** Footprint rect of a token on the ground plane (tiny = half a cell). */
export function tokenRect(scene: Pick<SceneLike, "grid">, token: Pick<Token, "position" | "size">): Rect {
  const side = SIZE_FOOTPRINT[token.size] * scene.grid.cellSize
  return { x: token.position.x - side / 2, z: token.position.z - side / 2, w: side, d: side }
}

/** Level a light currently belongs to (attached lights follow their token's level). */
export function lightLevelId(scene: Pick<SceneLike, "tokens">, light: LightObject): Id {
  if (light.attachedTokenId && Object.hasOwn(scene.tokens, light.attachedTokenId)) {
    return scene.tokens[light.attachedTokenId].levelId
  }
  return light.levelId
}

/** World-space position of a light (resolves attachment to a token). */
export function lightWorldPosition(scene: Pick<SceneLike, "levels" | "grid" | "objects" | "tokens">, light: LightObject): Vec3 {
  if (light.attachedTokenId && Object.hasOwn(scene.tokens, light.attachedTokenId)) {
    const t = scene.tokens[light.attachedTokenId]
    return { x: t.position.x + light.position.x, y: tokenGroundY(scene, t) + light.position.y, z: t.position.z + light.position.z }
  }
  const ground = groundHeightAt(scene, light.levelId, light.position)
  return { x: light.position.x, y: ground + light.position.y, z: light.position.z }
}

/** A light is effectively hidden if it or the token carrying it is hidden. */
export function lightEffectivelyHidden(scene: Pick<SceneLike, "tokens">, light: LightObject): boolean {
  if (light.hidden) return true
  if (light.attachedTokenId && Object.hasOwn(scene.tokens, light.attachedTokenId)) {
    return scene.tokens[light.attachedTokenId].hidden
  }
  return false
}
