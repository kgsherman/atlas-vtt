/**
 * Backdrop placement as a player sees it (docs/ARCHITECTURE.md §9). Kept apart from filter.ts so the
 * tile source (net/assets) can use it without pulling in the filter, the session state and movement:
 * this module imports types and ./util only.
 *
 * It is also the one home of the backdrop geometry every party must agree on: the tile edge length
 * (the filter announces it to players, the host tiler cuts chunks with it, the tile source crops with
 * it) and the cells a backdrop covers (the host tiler draws and announces them, the player compositor
 * expects them).
 */
import type { GridSettings, Id, Rect, Scene } from "../scene/types"
import type { PlayerBackdrop } from "./types"
import { own } from "./util"

/** Largest tile edge a backdrop may announce (px per grid cell). */
export const MAX_BACKDROP_TILE_PX = 1024

/**
 * Snap tolerance (in cells) of backdropCellRange: a calibrated rect edge within this of a grid line
 * counts as on it, so float noise from offset or px-per-cell calibration never adds a sliver cell.
 */
export const BACKDROP_CELL_EPS = 1e-6

/**
 * Tile edge length (stored px per grid cell) of an image `imageWidth` px wide stretched over a rect
 * `rectWidth` ft wide, capped at MAX_BACKDROP_TILE_PX; null when it is not a positive finite size.
 */
export function backdropTilePx(imageWidth: number, rectWidth: number, cellSize: number): number | null {
  const px = Math.round((imageWidth * cellSize) / rectWidth)
  return px >= 1 && Number.isFinite(px) ? Math.min(MAX_BACKDROP_TILE_PX, px) : null
}

/** Inclusive cell range. */
export interface BackdropCellRange {
  i0: number
  j0: number
  i1: number
  j1: number
}

/**
 * Grid cells a backdrop rect overlaps with positive area (edges within BACKDROP_CELL_EPS cells of a
 * grid line snap to it), clamped to the grid; null when there are none.
 */
export function backdropCellRange(rect: Rect, grid: Pick<GridSettings, "cellSize" | "width" | "depth">): BackdropCellRange | null {
  if (!(rect.w > 0) || !(rect.d > 0)) return null
  const s = grid.cellSize
  const i0 = Math.max(0, Math.floor(rect.x / s + BACKDROP_CELL_EPS))
  const j0 = Math.max(0, Math.floor(rect.z / s + BACKDROP_CELL_EPS))
  const i1 = Math.min(grid.width - 1, Math.ceil((rect.x + rect.w) / s - BACKDROP_CELL_EPS) - 1)
  const j1 = Math.min(grid.depth - 1, Math.ceil((rect.z + rect.d) / s - BACKDROP_CELL_EPS) - 1)
  return i1 < i0 || j1 < j0 ? null : { i0, j0, i1, j1 }
}

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
  const tilePx = backdropTilePx(asset.width, b.rect.w, scene.grid.cellSize)
  if (tilePx === null) return null
  return {
    rect: { x: b.rect.x, z: b.rect.z, w: b.rect.w, d: b.rect.d },
    opacity: b.opacity,
    tintWalls: b.tintWalls,
    tilePx,
  }
}
