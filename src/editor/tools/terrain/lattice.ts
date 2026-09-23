/**
 * Live terrain previews of the terrain tool (DESIGN §3.1): a gesture works on local copies of the level's
 * painted base and of its baked terrain, re-bakes only the region it changed and hands the baked lattice to
 * Engine.previewTerrain, without touching the document until the gesture commits.
 */
import { latticeFromHeightmap, unionRect, type HeightLattice } from "@/core/scene/heightmapBrush"
import { effectiveFloorRects, rectsOverlap } from "@/core/scene/queries"
import { bakeRegion, baseLattice, latticeWindow } from "@/core/scene/terrainShapes"
import type { GridSettings, Id, Level, Rect, SceneLike, TerrainShape } from "@/core/scene/types"

import type { ToolDeps } from "../shared"

type Grid = Pick<GridSettings, "width" | "depth" | "cellSize">

/** `rect` grown by `by` feet on every side. */
export const growRect = (r: Rect, by: number): Rect => ({ x: r.x - by, z: r.z - by, w: r.w + 2 * by, d: r.d + 2 * by })

/**
 * A level's painted base and its displayed (baked) terrain as dense lattices. `base` is a private copy the
 * brush may paint into; the display starts as the document's baked heightmap and is recomputed per region.
 */
export interface LatticePreview {
  readonly levelId: Id
  readonly base: HeightLattice
  /** Recompute the display inside `rect` as bake(base, shapes) and push it to the engine. */
  push(rect: Rect, shapes: readonly TerrainShape[]): void
  /** Something was pushed since creation / the last clear. */
  pushed(): boolean
  /** Drop the engine preview (no-op when nothing was pushed). */
  clear(): void
  /** Forget the preview without clearing it (a commit changed the heightmap: updateScene drops it). */
  release(): void
}

export function createLatticePreview(
  deps: Pick<ToolDeps, "previewTerrain">,
  levelId: Id,
  level: Pick<Level, "heightmap" | "terrainEdits">,
  grid: Grid
): LatticePreview {
  const base = baseLattice(level, grid)
  // The displayed terrain differs from the base only on levels with shapes (or while a shape is drafted).
  let display: HeightLattice | null = null
  let dirty = false
  const displayLattice = (): HeightLattice => {
    if (!display) {
      display = level.heightmap
        ? latticeFromHeightmap(level.heightmap, grid)
        : { samplesX: base.samplesX, samplesZ: base.samplesZ, heights: new Float32Array(base.heights.length), spacing: base.spacing }
    }
    return display
  }
  return {
    levelId,
    base,
    push(rect, shapes) {
      let shown: HeightLattice = base
      if (shapes.length > 0 || display) {
        shown = displayLattice()
        const win = latticeWindow(shown, rect)
        if (win) {
          const { samplesX } = shown
          for (let sz = win.sz0; sz <= win.sz1; sz++) {
            const row = sz * samplesX
            shown.heights.set(base.heights.subarray(row + win.sx0, row + win.sx1 + 1), row + win.sx0)
          }
        }
        bakeRegion(shown, shapes, rect)
      }
      dirty = true
      deps.previewTerrain?.(levelId, shown.heights, rect)
    },
    pushed: () => dirty,
    clear() {
      if (!dirty) return
      dirty = false
      deps.previewTerrain?.(levelId, null, null)
    },
    release() {
      dirty = false
    },
  }
}

/**
 * The preview of a shape gesture (creation draft, drags of shapes or elements): `update` re-bakes the region
 * the gesture changed — the previous footprint ∪ the current one, grown by one sample spacing — only when
 * the gesture's quantised state (`key`) changes, and not at all while no footprint touched a floor (the
 * terrain is drawn only under floors; `offFloor()` then drives the hint). A null footprint means "nothing
 * changed" (a drag back at its start, a zero height): it only restores what was shown and is not off-floor.
 */
export interface ShapePreview {
  readonly levelId: Id
  update(shapes: readonly TerrainShape[], footprint: Rect | null, key: string): void
  /** The current footprint touches no floor of the level (false without a footprint). */
  offFloor(): boolean
  /** End the gesture: clear the engine preview unless `heightmapChanged` (a commit replaced the terrain). */
  end(heightmapChanged: boolean): void
}

export function createShapePreview(deps: Pick<ToolDeps, "previewTerrain">, scene: Pick<SceneLike, "levels" | "objects" | "grid">, levelId: Id): ShapePreview {
  const level = scene.levels[levelId]
  let lattice: LatticePreview | null = null
  let floors: Rect[] | null = null
  let shown: Rect | null = null
  let lastKey: string | null = null
  let off = false
  const touchesFloor = (r: Rect) => {
    floors ??= effectiveFloorRects(scene, levelId).map((f) => f.rect)
    return floors.some((f) => rectsOverlap(f, r))
  }
  return {
    levelId,
    update(shapes, footprint, key) {
      if (key === lastKey) return
      lastKey = key
      off = footprint !== null && !touchesFloor(footprint)
      if ((off || footprint === null) && shown === null) return
      lattice ??= createLatticePreview(deps, levelId, level, scene.grid)
      const region = unionRect(shown, footprint)
      shown = footprint
      if (region) lattice.push(growRect(region, lattice.base.spacing), shapes)
    },
    offFloor: () => off,
    end(heightmapChanged) {
      if (heightmapChanged) lattice?.release()
      else lattice?.clear()
      lattice = null
      shown = null
      lastKey = null
      off = false
    },
  }
}
