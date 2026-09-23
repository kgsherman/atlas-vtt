/**
 * Backdrop placement as a player sees it (docs/ARCHITECTURE.md §9). Kept apart from filter.ts so the
 * tile source (net/assets) can use it without pulling in the filter, the session state and movement:
 * this module imports types and ./util only.
 */
import type { Id, Scene } from "../scene/types"
import type { PlayerBackdrop } from "./types"
import { own } from "./util"

/** Largest tile edge a backdrop may announce (px per grid cell). */
export const MAX_BACKDROP_TILE_PX = 1024

/**
 * A level's map image as a player sees it: placement + tile size (stored px per grid cell, from the
 * asset metadata). null when the level has no backdrop or its asset metadata is missing.
 */
export function playerBackdrop(scene: Pick<Scene, "levels" | "assets" | "grid">, levelId: Id): PlayerBackdrop | null {
  const level = own(scene.levels, levelId)
  const b = level?.backdrop
  if (!b || !(b.rect.w > 0 && b.rect.d > 0)) return null
  const asset = own(scene.assets, b.assetId)
  if (!asset) return null
  const tilePx = Math.round((asset.width * scene.grid.cellSize) / b.rect.w)
  if (!(tilePx >= 1)) return null
  return {
    rect: { x: b.rect.x, z: b.rect.z, w: b.rect.w, d: b.rect.d },
    opacity: b.opacity,
    tintWalls: b.tintWalls,
    tilePx: Math.min(MAX_BACKDROP_TILE_PX, tilePx),
  }
}
