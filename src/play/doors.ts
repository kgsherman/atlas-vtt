/**
 * Door interaction helpers (ARCHITECTURE §6.2 "Door requests", §8). Doors are thin, so a click counts
 * for a door when the pick hit its leaf OR the ground point lies within a small radius of its segment
 * on the active level. The reach test mirrors the host's rule (a controlled token on the door's level
 * within one cell of the door segment) so the UI can explain a refusal before asking the host.
 */
import { footprintCells, tokenAnchor } from "@/core/movement"
import { openingSegment } from "@/core/scene/queries"
import type {
  DoorObject,
  Id,
  Rect,
  SceneLike,
  Token,
  Vec2,
  WallObject,
} from "@/core/scene/types"
import { segmentRectDistance } from "@/core/session"

/** How far (feet) from a door segment a ground click still selects the door. */
export const DOOR_PICK_RADIUS = 1.75

export interface DoorHit {
  door: DoorObject
  wall: WallObject
  segment: { a: Vec2; b: Vec2 }
}

function doorHit(scene: Pick<SceneLike, "objects">, id: Id): DoorHit | null {
  const door = Object.hasOwn(scene.objects, id) ? scene.objects[id] : undefined
  if (!door || door.type !== "door") return null
  const wall = Object.hasOwn(scene.objects, door.wallId)
    ? scene.objects[door.wallId]
    : undefined
  if (!wall || wall.type !== "wall") return null
  return { door, wall, segment: openingSegment(wall, door) }
}

function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const len2 = dx * dx + dz * dz
  const t =
    len2 > 0
      ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2))
      : 0
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t))
}

/**
 * The door a click refers to: the picked object when it is a door, else the nearest door segment on
 * `levelId` within DOOR_PICK_RADIUS of the ground point.
 */
export function doorAt(
  scene: Pick<SceneLike, "objects">,
  levelId: Id | null,
  pickedId: Id | null,
  ground: Vec2 | null
): DoorHit | null {
  if (pickedId) {
    const hit = doorHit(scene, pickedId)
    if (hit) return hit
  }
  if (!ground || !levelId) return null
  let best: DoorHit | null = null
  let bestD = DOOR_PICK_RADIUS
  for (const id of Object.keys(scene.objects)) {
    const o = scene.objects[id]
    if (o.type !== "door" || o.levelId !== levelId) continue
    const hit = doorHit(scene, id)
    if (!hit) continue
    const d = pointSegmentDistance(ground, hit.segment.a, hit.segment.b)
    if (d <= bestD) {
      bestD = d
      best = hit
    }
  }
  return best
}

/** The rect of a token's anchored footprint (as the host measures reach). */
export function footprintRect(
  scene: Pick<SceneLike, "grid">,
  token: Pick<Token, "position" | "size">
): Rect {
  const s = scene.grid.cellSize
  const k = footprintCells(token.size)
  const a = tokenAnchor(scene, token)
  return { x: a.i * s, z: a.j * s, w: k * s, d: k * s }
}

/** Tokens (of `tokenIds`) close enough to operate the door: same level, within one cell of its segment. */
export function tokensInReach(
  scene: Pick<SceneLike, "grid" | "tokens">,
  hit: DoorHit,
  tokenIds: readonly Id[]
): Id[] {
  const reach = scene.grid.cellSize + 1e-6
  return tokenIds.filter((id) => {
    const t = Object.hasOwn(scene.tokens, id) ? scene.tokens[id] : undefined
    return (
      !!t &&
      t.levelId === hit.door.levelId &&
      segmentRectDistance(
        hit.segment.a,
        hit.segment.b,
        footprintRect(scene, t)
      ) <= reach
    )
  })
}

/** Door centre (for labels / camera). */
export function doorCenter(hit: DoorHit): Vec2 {
  return {
    x: (hit.segment.a.x + hit.segment.b.x) / 2,
    z: (hit.segment.a.z + hit.segment.b.z) / 2,
  }
}
