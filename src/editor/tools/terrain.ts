/**
 * Terrain brush (ARCHITECTURE §7): on pointerdown the active level's heightmap is decoded into a
 * dense scratch lattice; dabs (core/scene/heightmapBrush) paint into it while dragging and the
 * engine previews it through `previewTerrain(levelId, heights, dirty)` without touching the document;
 * pointerup commits ONE apply that writes only the chunks the stroke changed (one undo step, patches
 * per chunk).
 */
import { commitLattice, latticeFromHeightmap, beginStroke, type BrushStroke, type HeightLattice } from "@/core/scene/heightmapBrush"
import { createHeightmap } from "@/core/scene/heightmap"
import type { Heightmap, Id, Vec2 } from "@/core/scene/types"
import type { ToolPreview } from "@/render/contracts"

import { createPreviewCache, type ToolDeps } from "./shared"
import type { Tool } from "./types"

/** Heightmap resolution given to levels painted for the first time (samples per cell). */
export const DEFAULT_TERRAIN_RESOLUTION: Heightmap["resolution"] = 2

interface Stroke {
  levelId: Id
  /** Heightmap the stroke started from (the lattice was decoded from it). */
  base: Heightmap
  lattice: HeightLattice
  stroke: BrushStroke
}

export interface TerrainTool extends Tool {
  /** Whether a stroke is in progress. */
  painting(): boolean
}

export function createTerrainTool(deps: ToolDeps): TerrainTool {
  const { store } = deps
  let active: Stroke | null = null
  let hover: Vec2 | null = null

  const changed = () => {
    preview.bump()
    deps.invalidate?.()
  }

  const preview = createPreviewCache(store, (): ToolPreview | null => {
    if (!hover) return null
    const s = store.getState()
    const { mode, radius } = s.toolSettings.brush
    return { kind: "brush", levelId: active?.levelId ?? s.activeLevelId, center: hover, radius, mode }
  })

  const clearPreview = (levelId: Id) => deps.previewTerrain?.(levelId, null, null)

  const commit = () => {
    if (!active) return
    const { levelId, base, lattice, stroke } = active
    active = null
    const dirty = stroke.dirty
    if (dirty) {
      const s = store.getState()
      const next = commitLattice(base, s.scene.grid, lattice, dirty)
      s.apply((d) => {
        if (!Object.hasOwn(d.levels, levelId)) return
        const level = d.levels[levelId]
        if (!level.heightmap) {
          // First paint: the new heightmap holds only the (non-zero) chunks this stroke touched.
          level.heightmap = next
          return
        }
        if (level.heightmap.resolution !== base.resolution) return
        // Write chunk by chunk so the undo step and the network diff carry only the changed chunks.
        const chunks = level.heightmap.chunks
        for (const [key, b64] of Object.entries(next.chunks)) {
          if (chunks[key] !== b64) chunks[key] = b64
        }
        for (const key of Object.keys(chunks)) {
          if (!Object.hasOwn(next.chunks, key)) delete chunks[key]
        }
      }, "Paint terrain")
    }
    clearPreview(levelId)
  }

  const brushSettings = () => {
    const b = store.getState().toolSettings.brush
    return { mode: b.mode, radius: b.radius, strength: b.strength, falloff: b.falloff }
  }

  return {
    id: "terrain",
    capturesPointer: true,

    onPointerDown(e) {
      if (e.button !== 0 || !e.ground) return
      if (active) commit()
      const s = store.getState()
      const levelId = s.activeLevelId
      if (!Object.hasOwn(s.scene.levels, levelId)) return
      const base = s.scene.levels[levelId].heightmap ?? createHeightmap(DEFAULT_TERRAIN_RESOLUTION)
      const lattice = latticeFromHeightmap(base, s.scene.grid)
      const stroke = beginStroke(lattice, brushSettings(), { x: e.ground.x, z: e.ground.z })
      active = { levelId, base, lattice, stroke }
      hover = { ...e.ground }
      if (stroke.dirty) deps.previewTerrain?.(levelId, lattice.heights, stroke.dirty)
      changed()
    },

    onPointerMove(e) {
      if (!e.ground) return
      hover = { ...e.ground }
      if (active) {
        const dirty = active.stroke.moveTo(hover)
        if (dirty) deps.previewTerrain?.(active.levelId, active.lattice.heights, dirty)
      }
      changed()
    },

    onPointerUp() {
      if (!active) return
      commit()
      changed()
    },

    onKeyDown(e) {
      if (e.key === "Escape" && active) {
        const levelId = active.levelId
        active = null
        clearPreview(levelId)
        changed()
        return true
      }
      return false
    },

    cancel() {
      if (active) {
        const levelId = active.levelId
        active = null
        clearPreview(levelId)
      }
      hover = null
      changed()
    },

    preview: () => preview.get(),

    painting: () => active !== null,
  }
}
