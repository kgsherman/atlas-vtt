/**
 * What a right-click on the DM's map refers to: a token, a door (leaf or near its segment) or a light
 * (fixture hit or within a small radius of a static light).
 */
import type { Id, Scene } from "@/core/scene/types"
import { doorAt } from "@/play"
import type { Engine } from "@/render/contracts"

export type MenuTarget =
  | { kind: "token"; id: Id }
  | { kind: "door"; id: Id }
  | { kind: "light"; id: Id }

/** Light fixtures are small: a right-click within this radius (feet) of one counts. */
const LIGHT_PICK_RADIUS = 1.5

/** What a right-click at (x, y) refers to, or null (no menu). */
export function resolveMenuTarget(
  engine: Engine,
  scene: Scene,
  levelId: Id,
  clientX: number,
  clientY: number
): MenuTarget | null {
  const pick = engine.pick(clientX, clientY, {
    levelId,
    objects: true,
    tokens: true,
  })
  if (pick.tokenId && Object.hasOwn(scene.tokens, pick.tokenId))
    return { kind: "token", id: pick.tokenId }
  const ground = pick.ground ? { x: pick.ground.x, z: pick.ground.z } : null
  if (pick.objectId && Object.hasOwn(scene.objects, pick.objectId)) {
    const o = scene.objects[pick.objectId]
    if (o.type === "light") return { kind: "light", id: o.id }
  }
  const door = doorAt(scene, levelId, pick.objectId, ground)
  if (door) return { kind: "door", id: door.door.id }
  if (ground) {
    let best: Id | null = null
    let bestD = LIGHT_PICK_RADIUS
    for (const o of Object.values(scene.objects)) {
      if (o.type !== "light" || o.attachedTokenId || o.levelId !== levelId)
        continue
      const d = Math.hypot(o.position.x - ground.x, o.position.z - ground.z)
      if (d <= bestD) {
        bestD = d
        best = o.id
      }
    }
    if (best) return { kind: "light", id: best }
  }
  return null
}
