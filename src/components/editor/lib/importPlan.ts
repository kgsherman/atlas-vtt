/**
 * Planning for the map image import dialog (pure): default grid calibration per image, the scene
 * extent the images need, px-per-cell readouts and a scene name from the file names.
 */
import { effectiveFloorRects, rectIntersection } from "@/core/scene/queries"
import { SCENE_LIMITS } from "@/core/scene/schema"
import type { FloorObject, GridSettings, Id, Rect, SceneLike } from "@/core/scene/types"

import { FILE_NOISE_WORDS, fileNameWords, nameFromWords } from "./fileNames"

/** Forgotten Adventures maps are drawn at 140 px per 5 ft cell. */
export const FA_PX_PER_CELL = 140

export type ImportTarget = { kind: "existing"; levelId: Id } | { kind: "new"; name: string; elevation: number }

export interface ImportEntrySettings {
  cellsX: number
  cellsZ: number
  /** World position of the image's top-left corner (feet). */
  offsetX: number
  offsetZ: number
  target: ImportTarget
  floor: boolean
  walls: boolean
}

export const clampCells = (v: number) => Math.min(SCENE_LIMITS.maxGridCells, Math.max(1, Math.round(v)))

/**
 * Grid size (cells) an image spans: from the file name ("…-27x47-…"), else assuming 140 px per cell
 * when that gives whole cells, else the scene grid.
 */
export function defaultCalibration(
  guess: { cellsX: number; cellsZ: number } | null,
  size: { width: number; height: number } | null,
  fallback: Pick<GridSettings, "width" | "depth">
): { cellsX: number; cellsZ: number } {
  if (guess) return { cellsX: clampCells(guess.cellsX), cellsZ: clampCells(guess.cellsZ) }
  if (size) {
    const fx = size.width / FA_PX_PER_CELL
    const fz = size.height / FA_PX_PER_CELL
    if (Math.abs(fx - Math.round(fx)) < 0.05 && Math.abs(fz - Math.round(fz)) < 0.05 && fx >= 1 && fz >= 1) return { cellsX: clampCells(fx), cellsZ: clampCells(fz) }
  }
  return { cellsX: clampCells(fallback.width), cellsZ: clampCells(fallback.depth) }
}

/** Source px per cell along each axis, and whether cells come out (nearly) square. */
export function pxPerCell(size: { width: number; height: number }, cellsX: number, cellsZ: number): { x: number; z: number; square: boolean } {
  const x = size.width / Math.max(1, cellsX)
  const z = size.height / Math.max(1, cellsZ)
  return { x, z, square: Math.abs(x - z) <= 0.05 * Math.max(x, z) }
}

/** Grid (cells) needed to hold every image at its offset, at least `min`. */
export function requiredGrid(entries: readonly Pick<ImportEntrySettings, "cellsX" | "cellsZ" | "offsetX" | "offsetZ">[], cellSize: number, min: { width: number; depth: number } = { width: 1, depth: 1 }): { width: number; depth: number } {
  let width = min.width
  let depth = min.depth
  for (const e of entries) {
    width = Math.max(width, Math.ceil(Math.max(0, e.offsetX) / cellSize + e.cellsX - 1e-9))
    depth = Math.max(depth, Math.ceil(Math.max(0, e.offsetZ) / cellSize + e.cellsZ - 1e-9))
  }
  return { width: clampCells(width), depth: clampCells(depth) }
}

/** Storey words (and the file-name noise words): a scene name leaves them out. */
const STOREY_WORD = new RegExp(
  `^(basement|cellar|crypt|undercroft|sewers?|caves?|caverns?|dungeon|ground|first|second|third|fourth|1st|2nd|3rd|4th|floor|floors|level|upper|lower|upstairs|attic|loft|roof(top)?|groundfloor|firstfloor|secondfloor|thirdfloor|fourthfloor|${FILE_NOISE_WORDS})$`,
  "i"
)

/** A scene name from battlemap file names ("181-FA-Vineyard-Interiors-27x47-NoGrid-FirstFloor-Night.jpg" → "Vineyard Interiors"). */
export function sceneNameFromFiles(names: readonly string[]): string {
  for (const name of names) {
    const text = nameFromWords(fileNameWords(name, STOREY_WORD))
    if (text) return text
  }
  return "Imported scene"
}

/** World rect an image covers once imported with these settings. */
export function importRect(s: Pick<ImportEntrySettings, "cellsX" | "cellsZ" | "offsetX" | "offsetZ">, cellSize: number): Rect {
  return { x: s.offsetX, z: s.offsetZ, w: s.cellsX * cellSize, d: s.cellsZ * cellSize }
}

/**
 * How "Floor from image" should treat a target level's existing floors: `coverage` = fraction of the
 * image rect already covered by floors (the image only shows on floors); `replace` = every existing
 * floor lies inside the image rect, so the traced floor can supersede them without losing ground
 * outside the image.
 */
export function floorPlanForLevel(scene: Pick<SceneLike, "levels" | "objects">, levelId: Id, rect: Rect): { hasFloors: boolean; coverage: number; replace: boolean } {
  const floors = Object.values(scene.objects).filter((o): o is FloorObject => o.type === "floor" && o.levelId === levelId)
  if (floors.length === 0) return { hasFloors: false, coverage: 0, replace: false }
  const area = rect.w * rect.d
  let covered = 0
  for (const f of effectiveFloorRects(scene, levelId)) {
    const r = rectIntersection(f.rect, rect)
    if (r) covered += r.w * r.d
  }
  const eps = 1e-6
  const inside = floors.every((f) => f.rect.x >= rect.x - eps && f.rect.z >= rect.z - eps && f.rect.x + f.rect.w <= rect.x + rect.w + eps && f.rect.z + f.rect.d <= rect.z + rect.d + eps)
  return { hasFloors: true, coverage: area > 0 ? Math.min(1, covered / area) : 1, replace: inside }
}
