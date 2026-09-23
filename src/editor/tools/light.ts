/**
 * Light tool: click to place a light of the preset chosen in the tool settings.
 *  - on a token: the light is attached to it (carried torch), offset (0, preset height, 0);
 *  - on a wall of the active level (or a door/window in one): wall-mounted at the hit point pushed
 *    0.3 ft off the face the pointer ray hit (the camera's side), at the preset height above the wall's
 *    base line there (terrain or level elevation, core/scene/wallProfile) and inside the wall's height
 *    (ARCHITECTURE §2: light origins must sit outside solid blockers);
 *  - elsewhere: at the snapped ground point, at the preset height.
 */
import { TerrainSampler } from "@/core/occlusion"
import { LIGHT_PRESETS } from "@/core/scene/defaults"
import { createLight } from "@/core/scene/factory"
import { groundHeightAt, wallDirection, wallLength, wallNormal } from "@/core/scene/queries"
import type { Id, Scene, Vec2, Vec3, WallObject } from "@/core/scene/types"
import { wallProfile } from "@/core/scene/wallProfile"
import type { ToolPreview } from "@/render/contracts"

import { insideExtent } from "../snapping"
import { createPreviewCache, INVALID_COLOR, snappedGround, type ToolDeps } from "./shared"
import type { Tool, ToolPointerEvent } from "./types"

/** Distance (feet) a wall-mounted light sits off the wall face. */
export const WALL_MOUNT_OFFSET = 0.3

export type LightPlacement =
  | { kind: "attach"; tokenId: Id; levelId: Id; world: Vec2 }
  | { kind: "wall"; wallId: Id; levelId: Id; position: Vec3 }
  | { kind: "ground"; levelId: Id; position: Vec3 }

/**
 * Wall-mount position for a pick on a wall: the hit point projected onto the wall line, pushed to
 * thickness/2 + 0.3 ft on the side of the face that was hit (for a hit on the top cap, the side of the
 * raw ground point; +normal as a last resort).
 */
export function wallMountPoint(scene: Scene, wallId: Id, hit: Vec2, ground: Vec2 | null): Vec2 {
  const wall = scene.objects[wallId]
  if (wall.type !== "wall") return { ...hit }
  const dir = wallDirection(wall)
  const n = wallNormal(wall)
  const len = wallLength(wall)
  const t = Math.min(Math.max((hit.x - wall.a.x) * dir.x + (hit.z - wall.a.z) * dir.z, 0), len)
  const sideOf = (p: Vec2) => (p.x - wall.a.x) * n.x + (p.z - wall.a.z) * n.z
  let side = sideOf(hit)
  // A hit on the cap (well inside the thickness) says nothing about the side: use the ground point.
  if (Math.abs(side) < wall.thickness / 2 - 1e-3 && ground) side = sideOf(ground)
  const sign = side < 0 ? -1 : 1
  const off = wall.thickness / 2 + WALL_MOUNT_OFFSET
  return { x: wall.a.x + dir.x * t + n.x * off * sign, z: wall.a.z + dir.z * t + n.z * off * sign }
}

/** A wall-mounted light keeps at least this far (feet) inside its wall's base (and the ground) and top. */
const WALL_MOUNT_INSET = 0.5

/**
 * LightObject.position.y (relative to the level ground at `p`) of a light mounted on `wall` at `p`:
 * `presetHeight` above the wall's base line at the mount point, clamped to WALL_MOUNT_INSET above that
 * base and the ground at `p` and below the wall's top there. On flat ground: min(presetHeight, height − 0.5), ≥ 0.5.
 */
export function wallMountHeight(scene: Scene, wall: WallObject, p: Vec2, presetHeight: number): number {
  const level = Object.hasOwn(scene.levels, wall.levelId) ? scene.levels[wall.levelId] : undefined
  let above = 0 // wall base − ground at p (negative: the base is buried there)
  if (level) {
    const profile = wallProfile(wall, level.heightmap ? new TerrainSampler(level, scene.grid) : null, level.elevation, { a: 0, b: 0 })
    const u = (p.x - wall.a.x) * profile.dir.x + (p.z - wall.a.z) * profile.dir.z
    above = profile.baseAt(Math.min(Math.max(u, 0), profile.len)) - groundHeightAt(scene, wall.levelId, p)
  }
  // Relative to the base (exact on flat ground), then back to the ground at p.
  return above + Math.max(Math.max(0, -above) + WALL_MOUNT_INSET, Math.min(presetHeight, wall.height - WALL_MOUNT_INSET))
}

export function createLightTool(deps: ToolDeps): Tool {
  const { store } = deps
  let hover: LightPlacement | null = null

  const changed = () => {
    preview.bump()
    deps.invalidate?.()
  }

  const compute = (e: ToolPointerEvent): LightPlacement | null => {
    const s = store.getState()
    const def = LIGHT_PRESETS[s.toolSettings.light.preset]
    const tokenId = e.pick.tokenId
    if (tokenId && Object.hasOwn(s.scene.tokens, tokenId)) {
      const t = s.scene.tokens[tokenId]
      return { kind: "attach", tokenId, levelId: t.levelId, world: { ...t.position } }
    }
    const objectId = e.pick.objectId
    const hitPoint = e.pick.hitPoint
    if (objectId && hitPoint && Object.hasOwn(s.scene.objects, objectId)) {
      // A click on a door or window mounts on its host wall.
      const hit = s.scene.objects[objectId]
      const wallId = hit.type === "door" || hit.type === "window" ? hit.wallId : hit.id
      const wall = Object.hasOwn(s.scene.objects, wallId) ? s.scene.objects[wallId] : hit
      if (wall.type === "wall" && wall.levelId === s.activeLevelId) {
        const p = wallMountPoint(s.scene, wall.id, hitPoint, e.ground)
        const y = wallMountHeight(s.scene, wall, p, def.height)
        return { kind: "wall", wallId: wall.id, levelId: wall.levelId, position: { x: p.x, y, z: p.z } }
      }
    }
    const p = snappedGround(store, e)
    if (!p) return null
    return { kind: "ground", levelId: s.activeLevelId, position: { x: p.x, y: def.height, z: p.z } }
  }

  const valid = (p: LightPlacement) => {
    const grid = store.getState().scene.grid
    return p.kind === "attach" || insideExtent(grid, { x: p.position.x, z: p.position.z })
  }

  const preview = createPreviewCache(store, (): ToolPreview | null => {
    if (!hover) return null
    const def = LIGHT_PRESETS[store.getState().toolSettings.light.preset]
    const position = hover.kind === "attach" ? { x: hover.world.x, y: def.height, z: hover.world.z } : hover.position
    return { kind: "point", levelId: hover.levelId, position, radius: def.dimRadius, color: valid(hover) ? def.color : INVALID_COLOR }
  })

  return {
    id: "light",

    onPointerMove(e) {
      hover = compute(e)
      changed()
    },

    onPointerDown(e) {
      if (e.button !== 0) return
      const p = compute(e)
      if (!p || !valid(p)) return
      const s = store.getState()
      const preset = s.toolSettings.light.preset
      const def = LIGHT_PRESETS[preset]
      if (p.kind === "attach") {
        s.addObject(createLight(p.levelId, preset, { x: 0, z: 0 }, { attachedTokenId: p.tokenId, position: { x: 0, y: def.height, z: 0 } }), "Attach light")
      } else {
        s.addObject(createLight(p.levelId, preset, p.position, { position: { ...p.position } }), "Add light")
      }
    },

    cancel() {
      hover = null
      changed()
    },

    preview: () => preview.get(),
  }
}
