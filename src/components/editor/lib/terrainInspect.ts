/**
 * Pure helpers behind the Inspector's terrain bits: terrain shape fields (average top, bake order moves,
 * "too small" check, what "Apply to terrain" also applies), its terrain edits, and the follow-terrain
 * warnings of walls (DESIGN §3.4, §3.6). Framework-free.
 */
import { TerrainSampler } from "@/core/occlusion"
import { sampleSpacing } from "@/core/scene/heightmap"
import { adjacentLevels } from "@/core/scene/queries"
import { applyShapesClosure, compareShapeOrder, countShapeSamples, isValidTerrainShape, type TerrainEdit, type TerrainLevel } from "@/core/scene/terrainShapes"
import type { GridSettings, Id, Level, TerrainShape, TerrainShapeKind, WallObject } from "@/core/scene/types"
import { wallProfile } from "@/core/scene/wallProfile"
import type { EditorState } from "@/editor/store"

export const SHAPE_KIND_LABELS: Record<TerrainShapeKind, string> = { block: "Block", ramp: "Ramp", cylinder: "Cylinder", polygon: "Polygon" }

/** Fewer lattice samples than this inside a shape: it bakes to a spike or to nothing. */
export const MIN_SHAPE_SAMPLES = 4

/** Mean top height of a shape (feet relative to the level's elevation) and its range. */
export function shapeTopStats(shape: Pick<TerrainShape, "points">): { mean: number; min: number; max: number } {
  let sum = 0
  let min = Infinity
  let max = -Infinity
  for (const p of shape.points) {
    sum += p.y
    min = Math.min(min, p.y)
    max = Math.max(max, p.y)
  }
  const n = shape.points.length
  return n > 0 ? { mean: sum / n, min, max } : { mean: 0, min: 0, max: 0 }
}

/** The shape with every top vertex moved by `dy` (the Inspector's "Top" field sets the mean). */
export function offsetShapeTop(shape: TerrainShape, dy: number): TerrainShape {
  return { ...shape, points: shape.points.map((p) => ({ ...p, y: p.y + dy })) }
}

/** Lattice samples the bake covers at the level's resolution (capped at MIN_SHAPE_SAMPLES), or null without terrain. */
export function shapeSampleCount(shape: TerrainShape, level: Pick<Level, "heightmap">, grid: Pick<GridSettings, "cellSize">): number | null {
  if (!level.heightmap) return null
  return countShapeSamples(shape, sampleSpacing(grid.cellSize, level.heightmap.resolution), MIN_SHAPE_SAMPLES)
}

/**
 * Move a shape one step later (dir 1: "bring forward", applied after the next shape) or earlier (−1) in
 * the bake order (ascending order, id). Returns the shapes to upsert, or null when it is already last /
 * first. Two shapes with distinct, unshared orders swap them; otherwise the level is renumbered 0…n−1.
 */
export function reorderShapes(shapes: readonly TerrainShape[], id: Id, dir: 1 | -1): TerrainShape[] | null {
  const sorted = [...shapes].sort(compareShapeOrder)
  const k = sorted.findIndex((s) => s.id === id)
  const j = k + dir
  if (k < 0 || j < 0 || j >= sorted.length) return null
  const a = sorted[k]
  const b = sorted[j]
  const shared = (order: number) => sorted.filter((s) => s.order === order).length > 1
  if (a.order !== b.order && !shared(a.order) && !shared(b.order)) {
    return [
      { ...a, order: b.order },
      { ...b, order: a.order },
    ]
  }
  sorted[k] = b
  sorted[j] = a
  return sorted.flatMap((s, i) => (s.order === i ? [] : [{ ...s, order: i }]))
}

/**
 * The shapes "Apply to terrain" on `ids` applies besides them: the older shapes under them
 * (`applyShapesClosure`, which keeps the terrain unchanged), in bake order. [] without a level.
 */
export function alsoAppliedShapes(level: TerrainLevel | undefined, ids: readonly Id[]): TerrainShape[] {
  if (!level) return []
  const named = new Set(ids)
  return applyShapesClosure(level, ids).filter((s) => !named.has(s.id))
}

/**
 * One terrain edit from the Inspector (store.applyTerrainEdit). `refused`: the terrain writer turned it
 * down because an upserted shape is not valid, which only the Inspector reports (its own toast). An edit
 * that changes nothing (e.g. a rename to the same name after trimming) or that validateEdit refused (the
 * store reports that one through lastRejected) is not `refused`.
 */
export function applyInspectorTerrainEdit(
  store: { getState(): Pick<EditorState, "readOnly" | "lastRejected" | "applyTerrainEdit"> },
  levelId: Id,
  edit: TerrainEdit,
  label: string,
  coalesceKey?: string
): { ok: boolean; refused: boolean } {
  const s = store.getState()
  if (s.readOnly) return { ok: false, refused: false }
  const rejected = s.lastRejected
  const ok = s.applyTerrainEdit(levelId, edit, label, coalesceKey ? { coalesceKey } : undefined)
  const refused = !ok && store.getState().lastRejected === rejected && (edit.upsert ?? []).some((shape) => !isValidTerrainShape(shape))
  return { ok, refused }
}

/** Ignore terrain a hair above a follow-off wall's base, or a top a hair above the floor above (feet). */
const BURIED_MIN = 0.1
const POKE_MIN = 0.05

export type WallTerrainWarning =
  /** Follow terrain off: the terrain along the wall rises `depth` ft above its base (the level elevation). */
  | { kind: "buried"; depth: number; whole: boolean }
  /**
   * Follow terrain on: the terrain lifts the top `by` ft past both the top of the floor of the level above
   * and where the same wall would stand on flat ground (so a storey-high wall on flat ground never warns).
   * For a wall no taller than the storey, lowering it by `by` clears the warning.
   */
  | { kind: "pokes"; by: number; above: string }

/**
 * What the Inspector warns about a wall on terrain: off and the ground under it rises above its base
 * (the lower part of the wall is buried); on and the terrain lifts its top through the floor of the level
 * above. null on levels without terrain and when neither happens.
 */
export function wallTerrainWarning(scene: { levels: Record<Id, Level>; grid: GridSettings }, wall: WallObject): WallTerrainWarning | null {
  const level = Object.hasOwn(scene.levels, wall.levelId) ? scene.levels[wall.levelId] : undefined
  if (!level?.heightmap) return null
  const ground = new TerrainSampler(level, scene.grid)
  if (!wall.followTerrain) {
    // The base line the wall would have if it followed the terrain: the ground along its centreline.
    const along = wallProfile({ ...wall, followTerrain: true }, ground, level.elevation, { a: 0, b: 0 })
    let highest = -Infinity
    for (const y of along.base) highest = Math.max(highest, y)
    const depth = highest - level.elevation
    return depth >= BURIED_MIN ? { kind: "buried", depth, whole: depth >= wall.height } : null
  }
  const { above } = adjacentLevels(scene, wall.levelId)
  if (!above) return null
  const profile = wallProfile(wall, ground, level.elevation, { a: 0, b: 0 })
  // A top inside the slab of the level above does not show there, so the reference is the top of its floor
  // (where a default, storey-high wall's top is on flat ground). A wall taller than that already passes
  // through on flat ground, on purpose: then only what the terrain adds counts.
  const flatTop = level.elevation + wall.height
  const by = profile.maxTop(0, profile.len) - Math.max(above.elevation, flatTop)
  return by >= POKE_MIN ? { kind: "pokes", by, above: above.name } : null
}
