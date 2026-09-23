/**
 * Player-side scene reconstruction (docs/ARCHITECTURE.md §4.3 "Player mode"): the renderer and the
 * client's local simulation (ruler, path previews, GPU line of sight) run on a SceneLike rebuilt from
 * the PlayerView. Unknown levels become stubs without heightmaps; player objects map back to scene
 * object shapes with neutral defaults for the fields players never receive.
 */
import { PROP_LIBRARY, SIZE_BODY } from "../scene/defaults"
import type { FloorObject, Id, Level, LevelBackdrop, SceneLike, SceneObject, Token } from "../scene/types"
import type { PlayerBackdrop, PlayerLevel, PlayerObject, PlayerToken, PlayerView } from "./types"

/**
 * Synthetic asset id of a level's backdrop in a player's scene. Players never learn the real asset id:
 * the image is the canvas the player client composites explored-cell tiles into (net/assets tiles).
 */
export function playerBackdropAssetId(levelId: Id): Id {
  return `tiles-${levelId}`
}

/** A PlayerBackdrop as a Level.backdrop (synthetic asset id). */
export function backdropFromPlayer(levelId: Id, b: PlayerBackdrop): LevelBackdrop {
  return { assetId: playerBackdropAssetId(levelId), rect: { x: b.rect.x, z: b.rect.z, w: b.rect.w, d: b.rect.d }, opacity: b.opacity, tintWalls: b.tintWalls }
}

/** A PlayerLevel as a scene Level; its heightmap holds exactly the chunks the player received. */
export function levelFromPlayer(l: PlayerLevel, chunks: Readonly<Record<string, string>> | undefined): Level {
  return {
    id: l.id,
    name: l.name ?? "",
    elevation: l.elevation,
    height: l.height,
    floorThickness: l.floorThickness,
    heightmap: l.known && l.terrainResolution !== null ? { resolution: l.terrainResolution, chunks: { ...(chunks ?? {}) } } : null,
  }
}

/** A PlayerObject as a scene object. Lights emit only when `emitting` (non-emitting = fixture only). */
export function objectFromPlayer(o: PlayerObject): SceneObject {
  switch (o.type) {
    case "floor": {
      const out: FloorObject = { id: o.id, type: "floor", levelId: o.levelId, rect: { ...o.rect }, material: o.material }
      if (o.thickness !== undefined) out.thickness = o.thickness
      return out
    }
    case "wall":
      return { id: o.id, type: "wall", levelId: o.levelId, a: { ...o.a }, b: { ...o.b }, height: o.height, thickness: o.thickness, material: o.material }
    case "door":
      return {
        id: o.id,
        type: "door",
        levelId: o.levelId,
        wallId: o.wallId,
        offset: o.offset,
        width: o.width,
        height: o.height,
        state: o.state,
        style: o.style,
        leaves: o.leaves,
        hinge: o.hinge,
        swing: o.swing,
      }
    case "window":
      return { id: o.id, type: "window", levelId: o.levelId, wallId: o.wallId, offset: o.offset, width: o.width, sillHeight: o.sillHeight, height: o.height }
    case "connector":
      return { id: o.id, type: "connector", levelId: o.levelId, style: o.style, toLevelId: o.toLevelId, rect: { ...o.rect }, direction: o.direction, material: o.material }
    case "pillar":
      return { id: o.id, type: "pillar", levelId: o.levelId, position: { ...o.position }, shape: o.shape, size: o.size, height: o.height, material: o.material }
    case "prop":
      return {
        id: o.id,
        type: "prop",
        levelId: o.levelId,
        kind: o.kind,
        position: { ...o.position },
        rotationY: o.rotationY,
        scale: { ...o.scale },
        color: o.color,
        // Not sent; the library default is the neutral assumption for local path previews.
        blocksMovement: PROP_LIBRARY[o.kind]?.blocksMovement ?? true,
        blocksSight: o.blocksSight,
        castsShadows: o.castsShadows,
      }
    case "light":
      return {
        id: o.id,
        type: "light",
        levelId: o.levelId,
        preset: "custom",
        position: { ...o.position },
        color: o.color,
        intensity: o.intensity,
        brightRadius: o.brightRadius,
        dimRadius: o.dimRadius,
        flicker: { ...o.flicker },
        on: o.emitting,
        castsShadows: o.castsShadows,
        attachedTokenId: null,
      }
  }
}

export function tokenFromPlayer(t: PlayerToken, controlled: boolean): Token {
  return {
    id: t.id,
    name: t.name ?? t.label ?? "",
    label: t.label,
    kind: controlled ? "pc" : "npc",
    levelId: t.levelId,
    position: { ...t.position },
    size: t.size,
    eyeHeight: t.eyeHeight ?? SIZE_BODY[t.size]?.eyeHeight ?? t.height * 0.9,
    height: t.height,
    vision: t.vision ? { ...t.vision } : { darkvision: 0, blindsight: 0, blind: false },
    speed: t.speed ?? 0,
    color: t.color,
    imageUrl: t.imageUrl,
    hidden: false,
  }
}

/** Rebuild a renderable/simulatable scene from a player's view (stubs for unknown levels, terrain from chunks). */
export function viewToScene(view: PlayerView): SceneLike {
  const levels: Record<Id, Level> = {}
  for (const id of Object.keys(view.scene.levels)) {
    levels[id] = levelFromPlayer(view.scene.levels[id], Object.hasOwn(view.terrain, id) ? view.terrain[id] : undefined)
    if (view.backdrops && Object.hasOwn(view.backdrops, id)) levels[id].backdrop = backdropFromPlayer(id, view.backdrops[id])
  }
  const objects: Record<Id, SceneObject> = {}
  for (const id of Object.keys(view.objects)) {
    const o = view.objects[id]
    // Objects on levels the view does not describe cannot be placed.
    if (!Object.hasOwn(levels, o.levelId)) continue
    if (o.type === "connector" && !Object.hasOwn(levels, o.toLevelId)) continue
    objects[id] = objectFromPlayer(o)
  }
  const controlled = new Set([...view.controlledTokenIds, ...view.visionTokenIds])
  const tokens: Record<Id, Token> = {}
  for (const id of Object.keys(view.tokens)) {
    const t = view.tokens[id]
    if (!Object.hasOwn(levels, t.levelId)) continue
    tokens[id] = tokenFromPlayer(t, controlled.has(id))
  }
  return {
    grid: { ...view.scene.grid },
    environment: { ...view.scene.environment, directional: { ...view.scene.environment.directional } },
    levels,
    objects,
    tokens,
  }
}
