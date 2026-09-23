/**
 * Level-level editor commands the store does not provide directly (duplicate a level, change the
 * terrain resolution) plus helpers for naming levels from map image file names. Framework-free.
 */
import { DEFAULT_LEVEL_HEIGHT } from "@/core/scene/defaults"
import { createLevel } from "@/core/scene/factory"
import { createHeightmap, sampleCounts, sampleHeight, sampleSpacing, writeHeights } from "@/core/scene/heightmap"
import { copySelection, pasteClipboard } from "@/core/scene/integrity"
import { sortedLevels } from "@/core/scene/queries"
import { SCENE_LIMITS } from "@/core/scene/schema"
import type { GridSettings, Heightmap, Id, Level, Scene } from "@/core/scene/types"
import type { EditorStore } from "@/editor/store"

import { fileNameWords, nameFromWords } from "./fileNames"

/** Levels from the top storey down (the order a layer list shows them in). */
export function levelsTopDown(scene: Pick<Scene, "levels">): Level[] {
  return sortedLevels(scene).reverse()
}

/** Elevation for a level added on top of the stack. */
export function nextLevelElevation(scene: Pick<Scene, "levels">): number {
  const levels = sortedLevels(scene)
  const top = levels[levels.length - 1]
  return top ? top.elevation + top.height : 0
}

/** Elevation for a level added under the lowest one. */
export function levelBelowElevation(scene: Pick<Scene, "levels">): number {
  const bottom = sortedLevels(scene)[0]
  return bottom ? bottom.elevation - DEFAULT_LEVEL_HEIGHT : 0
}

/**
 * Copy a level (settings, terrain, backdrop and every object on it; tokens are not copied) onto a new
 * level on top of the stack, in one undo step. Returns the new level id, or null when refused.
 */
export function duplicateLevel(store: EditorStore, levelId: Id): Id | null {
  const s = store.getState()
  if (s.readOnly || !Object.hasOwn(s.scene.levels, levelId)) return null
  if (Object.keys(s.scene.levels).length >= SCENE_LIMITS.maxLevels) return null
  const src = s.scene.levels[levelId]
  const copy = structuredClone(src) as Partial<Level>
  delete copy.id
  const level = createLevel({ ...copy, name: `${src.name} copy`, elevation: nextLevelElevation(s.scene) })
  const ids = Object.values(s.scene.objects)
    .filter((o) => o.levelId === levelId && !(o.type === "light" && o.attachedTokenId))
    .map((o) => o.id)
    .sort()
  const clip = ids.length > 0 ? copySelection(s.scene, ids, { sourceLevelId: levelId }) : null
  const patches = s.apply((d) => {
    d.levels[level.id] = level
    if (clip) pasteClipboard(d, clip, { targetLevelId: level.id, at: clip.origin })
  }, `Duplicate level "${src.name}"`)
  if (patches.length === 0) return null
  store.getState().setActiveLevel(level.id)
  return level.id
}

/** The same terrain on a lattice of another resolution (bilinear on the source triangles). */
export function resampleHeightmap(hm: Heightmap, grid: Pick<GridSettings, "width" | "depth" | "cellSize">, resolution: Heightmap["resolution"]): Heightmap {
  if (hm.resolution === resolution) return hm
  const { samplesX, samplesZ } = sampleCounts(grid, resolution)
  const step = sampleSpacing(grid.cellSize, resolution)
  const dense = new Float32Array(samplesX * samplesZ)
  for (let sz = 0; sz < samplesZ; sz++) {
    for (let sx = 0; sx < samplesX; sx++) dense[sz * samplesX + sx] = sampleHeight(hm, grid.cellSize, sx * step, sz * step)
  }
  return writeHeights(createHeightmap(resolution), grid, dense)
}

/** Change a level's terrain resolution (resampling existing heights) as one undo step. */
export function setTerrainResolution(store: EditorStore, levelId: Id, resolution: Heightmap["resolution"]): boolean {
  const s = store.getState()
  if (!Object.hasOwn(s.scene.levels, levelId)) return false
  const hm = s.scene.levels[levelId].heightmap
  if (!hm) return store.getState().updateLevel(levelId, { heightmap: createHeightmap(resolution) })
  if (hm.resolution === resolution) return true
  return store.getState().updateLevel(levelId, { heightmap: resampleHeightmap(hm, s.scene.grid, resolution) })
}

// ---------------------------------------------------------------------------
// Map image file names → storeys
// ---------------------------------------------------------------------------

export interface StoreyGuess {
  /** 0 = ground floor, −1 = basement, 1 = the floor above, … */
  storey: number
  name: string
}

const STOREY_PATTERNS: Array<{ re: RegExp; storey: number; name: string }> = [
  { re: /sub-?basement|lowerbasement/, storey: -2, name: "Sub-basement" },
  { re: /basement/, storey: -1, name: "Basement" },
  { re: /cellar/, storey: -1, name: "Cellar" },
  { re: /crypt/, storey: -1, name: "Crypt" },
  { re: /undercroft/, storey: -1, name: "Undercroft" },
  { re: /sewers?/, storey: -1, name: "Sewers" },
  { re: /caves?|caverns?/, storey: -1, name: "Caves" },
  { re: /dungeon/, storey: -1, name: "Dungeon" },
  { re: /groundfloor|groundlevel|firstfloor|1stfloor|floor1\b|level1\b|mainfloor/, storey: 0, name: "Ground Floor" },
  { re: /secondfloor|2ndfloor|floor2\b|level2\b|upperfloor|upstairs/, storey: 1, name: "Second Floor" },
  { re: /thirdfloor|3rdfloor|floor3\b|level3\b/, storey: 2, name: "Third Floor" },
  { re: /fourthfloor|4thfloor|floor4\b|level4\b/, storey: 3, name: "Fourth Floor" },
  { re: /attic|loft/, storey: 2, name: "Attic" },
  { re: /roof(top)?/, storey: 2, name: "Roof" },
]

/** Guess which storey a battlemap file shows from its name ("…-Basement-Night.png" → −1, "Basement"). */
export function guessStoreyFromName(fileName: string): StoreyGuess | null {
  const base = fileName.replace(/\.[a-z0-9]+$/i, "")
  // "SecondFloor", "second-floor", "second_floor" and "Second Floor" all become "secondfloor".
  const squashed = base.toLowerCase().replace(/[\s_\-.]+/g, "")
  const spaced = base.toLowerCase().replace(/[\s_.]+/g, "-")
  for (const p of STOREY_PATTERNS) {
    if (p.re.test(squashed) || p.re.test(spaced)) return { storey: p.storey, name: p.name }
  }
  return null
}

/** A readable level name from a file name when no storey keyword matches ("181-FA-Tavern-Night.png" → "Tavern Night"). */
export function levelNameFromFile(fileName: string): string {
  return nameFromWords(fileNameWords(fileName)) ?? "Map"
}

/**
 * Where an imported image should go: an existing level (same name, or same elevation, without a
 * backdrop yet), else a new level with the guessed name/elevation.
 */
export function suggestLevelForImage(
  scene: Pick<Scene, "levels">,
  fileName: string,
  taken: ReadonlySet<Id> = new Set()
): { levelId: Id | null; name: string; elevation: number } {
  const guess = guessStoreyFromName(fileName)
  const name = guess?.name ?? levelNameFromFile(fileName)
  const elevation = (guess?.storey ?? 0) * DEFAULT_LEVEL_HEIGHT
  const levels = sortedLevels(scene).filter((l) => !taken.has(l.id) && !l.backdrop)
  const byName = levels.find((l) => l.name.trim().toLowerCase() === name.toLowerCase())
  if (byName) return { levelId: byName.id, name: byName.name, elevation: byName.elevation }
  if (guess) {
    const byElevation = levels.find((l) => Math.abs(l.elevation - elevation) < 1e-6)
    if (byElevation) return { levelId: byElevation.id, name: byElevation.name, elevation: byElevation.elevation }
  }
  return { levelId: null, name, elevation }
}
