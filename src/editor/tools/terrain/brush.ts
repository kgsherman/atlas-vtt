/**
 * Terrain brush sub-tool (DESIGN §3.2): paints the level's BASE (the ground under the shapes). On
 * pointerdown the painted base is decoded into a scratch lattice; dabs (core/scene/heightmapBrush) paint
 * into it while dragging and the engine previews the BAKED result of each dirty rect (base re-baked with the
 * level's shapes; the bake is skipped on levels without shapes) through previewTerrain; pointerup commits
 * ONE writeTerrain edit (store.applyTerrainEdit) authoritative inside the stroke's dirty rect.
 */
import { beginStroke, type BrushSettings, type BrushStroke } from "@/core/scene/heightmapBrush"
import { sampleHeight } from "@/core/scene/heightmap"
import type { Id, TerrainShape, Vec2 } from "@/core/scene/types"

import { activeLevel, levelShapes, NO_PARTS, type SubTool, type TerrainToolContext } from "./context"
import { createLatticePreview, type LatticePreview } from "./lattice"

interface Stroke {
  levelId: Id
  lattice: LatticePreview
  /** The level's shapes (baked over the painted base in the preview). */
  shapes: readonly TerrainShape[]
  stroke: BrushStroke
}

export interface BrushSubTool extends SubTool {
  /** Whether a stroke is in progress. */
  painting(): boolean
}

export const BRUSH_UNDER_SHAPES_HINT = "The brush paints the ground under shapes; use Apply to terrain to sculpt a shape"

export function createBrushSubTool(ctx: TerrainToolContext): BrushSubTool {
  const { store, deps } = ctx
  let active: Stroke | null = null
  let hover: Vec2 | null = null

  const settings = (): BrushSettings => {
    const b = store.getState().toolSettings.brush
    return { mode: b.mode, radius: b.radius, strength: b.strength, falloff: b.falloff }
  }

  const commit = () => {
    if (!active) return
    const { levelId, lattice, stroke } = active
    active = null
    const dirty = stroke.dirty
    if (!dirty) {
      lattice.clear()
      return
    }
    const before = store.getState().scene.levels[levelId]?.heightmap
    const ok = ctx.write(() => store.getState().applyTerrainEdit(levelId, { base: { lattice: lattice.base, rects: [dirty] } }, "Paint terrain"))
    const after = store.getState().scene.levels[levelId]?.heightmap
    // A commit that changed the heightmap makes the engine drop the preview with the new terrain in place;
    // clearing it first would flash the old terrain.
    if (ok && after !== before) lattice.release()
    else lattice.clear()
  }

  const discard = () => {
    active?.lattice.clear()
    active = null
  }

  return {
    gestureLevel: () => active?.levelId ?? null,
    captures: () => active !== null,

    pointerDown(e) {
      if (e.button !== 0 || !e.ground) return
      if (active) commit()
      hover = { x: e.ground.x, z: e.ground.z }
      const s = store.getState()
      const a = activeLevel(s)
      if (!a || s.readOnly) {
        ctx.changed()
        return
      }
      const { levelId, level } = a
      const grid = s.scene.grid
      const brush = settings()
      // Flatten levels to the terrain the DM sees: the baked height under the stroke start.
      if (brush.mode === "flatten") brush.target = sampleHeight(level.heightmap, grid.cellSize, hover.x, hover.z, grid)
      const lattice = createLatticePreview(deps, levelId, level, grid)
      const shapes = Object.values(levelShapes(level))
      const stroke = beginStroke(lattice.base, brush, hover)
      active = { levelId, lattice, shapes, stroke }
      if (stroke.dirty) lattice.push(stroke.dirty, shapes)
      ctx.changed()
    },

    pointerMove(e) {
      if (!e.ground) {
        // Pointer left the canvas: hide the ring (a stroke keeps going when it comes back).
        if (!active && hover) {
          hover = null
          ctx.changed()
        }
        return
      }
      hover = { x: e.ground.x, z: e.ground.z }
      if (active) {
        const dirty = active.stroke.moveTo(hover)
        if (dirty) active.lattice.push(dirty, active.shapes)
      }
      ctx.changed()
    },

    pointerUp() {
      if (!active) return
      commit()
      ctx.changed()
    },

    key() {
      return false
    },

    cancel() {
      discard()
      hover = null
    },

    refresh() {},

    parts() {
      if (!hover) return NO_PARTS
      const { radius, mode } = store.getState().toolSettings.brush
      return { ...NO_PARTS, brush: { center: hover, radius, mode } }
    },

    cursor: () => (store.getState().readOnly ? null : "crosshair"),

    hint() {
      const a = activeLevel(store.getState())
      return a?.level.terrainEdits ? BRUSH_UNDER_SHAPES_HINT : null
    },

    painting: () => active !== null,
  }
}
