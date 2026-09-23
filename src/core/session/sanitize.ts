/**
 * Allowlisted copies of scene objects for player memory (docs/ARCHITECTURE.md §5.4, §6.2). Every field
 * is copied explicitly — never by spread — so DM-only fields (name, dmNotes, editorLocked, hidden,
 * attachedTokenId, preset, prop movement flags…) can never reach a player.
 *
 * Memory convention for static lights: `position.y` is the light's WORLD Y at observation time (the
 * filter converts it to "relative to the ground the player's client computes"), so a remembered
 * light keeps its height even if terrain under it is edited out of sight.
 *
 * Memory convention for masked floors (ARCHITECTURE §9): the remembered floor keeps its `mask`
 * (host-side only — GameState.memory never leaves the DM), so the filter can clip the floor's real
 * shape (`floorRects`) to explored cells. The filter builds floor pieces field by field and never
 * copies a mask into a PlayerView.
 */
import type { DoorObject, FloorMask, Id, LightObject, SceneObject } from "../scene/types"
import type { PlayerDoor, PlayerFloor, PlayerLight, PlayerObject } from "./types"

/** A remembered floor: the wire fields plus its coverage mask (host memory only, never sent). */
export type MemoryFloor = PlayerFloor & { mask?: FloorMask }

/** Whether an object may be remembered by (and so ever sent to) a player right now. */
export function memorable(o: SceneObject, revealed: ReadonlySet<Id>): boolean {
  if (o.hidden) return false
  if (o.type === "light" && o.attachedTokenId !== null) return false
  if (o.type === "door" && o.style === "secret" && !revealed.has(o.id)) return false
  return true
}

export function sanitizeDoorState(state: DoorObject["state"]): PlayerDoor["state"] {
  return state === "locked" ? "closed" : state
}

export function sanitizeDoorStyle(style: DoorObject["style"]): PlayerDoor["style"] {
  return style === "secret" ? "wood" : style
}

/** Static light as remembered: resolved world position (see the file comment), not emitting. */
export function sanitizeLight(o: LightObject, worldY: number): PlayerLight {
  return {
    id: o.id,
    type: "light",
    levelId: o.levelId,
    position: { x: o.position.x, y: worldY, z: o.position.z },
    color: o.color,
    intensity: o.intensity,
    brightRadius: o.brightRadius,
    dimRadius: o.dimRadius,
    flicker: { enabled: o.flicker.enabled, speed: o.flicker.speed, amount: o.flicker.amount },
    on: o.on,
    castsShadows: o.castsShadows,
    emitting: false,
  }
}

// Non-light copies depend only on the (immutable) scene object, so they are shared by identity.
const cache = new WeakMap<SceneObject, PlayerObject>()

/**
 * Allowlisted copy of a scene object. Doors are sent "locked" → "closed" and "secret" → "wood" (callers
 * decide with `memorable` whether a secret door may be remembered at all). `lightWorldY` resolves a
 * static light's height; attached lights are never sanitised (they are resolved by the filter).
 */
export function sanitizeObject(o: SceneObject, lightWorldY: (light: LightObject) => number): PlayerObject {
  if (o.type === "light") return sanitizeLight(o, lightWorldY(o))
  const hit = cache.get(o)
  if (hit) return hit
  const out = sanitizeStatic(o)
  cache.set(o, out)
  return out
}

function sanitizeStatic(o: Exclude<SceneObject, LightObject>): PlayerObject {
  switch (o.type) {
    case "floor": {
      const out: MemoryFloor = { id: o.id, type: "floor", levelId: o.levelId, rect: { x: o.rect.x, z: o.rect.z, w: o.rect.w, d: o.rect.d }, material: o.material }
      if (o.thickness !== undefined) out.thickness = o.thickness
      if (o.mask) out.mask = { spacing: o.mask.spacing, cols: o.mask.cols, rows: o.mask.rows, b64: o.mask.b64 }
      return out
    }
    case "wall":
      return {
        id: o.id,
        type: "wall",
        levelId: o.levelId,
        a: { x: o.a.x, z: o.a.z },
        b: { x: o.b.x, z: o.b.z },
        height: o.height,
        thickness: o.thickness,
        material: o.material,
        // Never undefined (a remembered wall must deep-equal its re-sanitised source). The per-piece
        // terrainProfile is not remembered: the filter derives it from the current host terrain.
        followTerrain: o.followTerrain !== false,
      }
    case "door":
      return {
        id: o.id,
        type: "door",
        levelId: o.levelId,
        wallId: o.wallId,
        offset: o.offset,
        width: o.width,
        height: o.height,
        leaves: o.leaves,
        hinge: o.hinge,
        swing: o.swing,
        state: sanitizeDoorState(o.state),
        style: sanitizeDoorStyle(o.style),
      }
    case "window":
      return {
        id: o.id,
        type: "window",
        levelId: o.levelId,
        wallId: o.wallId,
        offset: o.offset,
        width: o.width,
        sillHeight: o.sillHeight,
        height: o.height,
      }
    case "connector":
      return {
        id: o.id,
        type: "connector",
        levelId: o.levelId,
        style: o.style,
        toLevelId: o.toLevelId,
        rect: { x: o.rect.x, z: o.rect.z, w: o.rect.w, d: o.rect.d },
        direction: o.direction,
        material: o.material,
      }
    case "pillar":
      return {
        id: o.id,
        type: "pillar",
        levelId: o.levelId,
        position: { x: o.position.x, z: o.position.z },
        shape: o.shape,
        size: o.size,
        height: o.height,
        material: o.material,
      }
    case "prop":
      return {
        id: o.id,
        type: "prop",
        levelId: o.levelId,
        kind: o.kind,
        position: { x: o.position.x, y: o.position.y, z: o.position.z },
        rotationY: o.rotationY,
        scale: { x: o.scale.x, y: o.scale.y, z: o.scale.z },
        color: o.color,
        blocksSight: o.blocksSight,
        castsShadows: o.castsShadows,
      }
  }
}
