/**
 * Wall tool: click-click polyline on the active level. Points snap to existing wall endpoints, then
 * wall centrelines, then the grid (Alt = free; Shift = 45° steps from the previous point). Each
 * segment is its own undo step. Escape / Enter / right-click / double-click (or clicking the last
 * point again) ends the chain; clicking the chain's first point closes it.
 */
import { createWall } from "@/core/scene/factory"
import { objectsOfType } from "@/core/scene/queries"
import type { Vec2 } from "@/core/scene/types"
import type { ToolPreview } from "@/render/contracts"

import { constrainAngle, insideExtent, snapWallPoint } from "../snapping"
import { createClickTracker, createPreviewCache, defaultNow, pointerSnapMode, samePoint, type ToolDeps } from "./shared"
import type { Tool, ToolPointerEvent } from "./types"

/** Walls shorter than this (feet) are not created. */
export const MIN_WALL_LENGTH = 0.5
/** Walls may extend this far outside the scene extent (the schema allows ±50 ft). */
const EXTENT_MARGIN = 0

export interface WallTool extends Tool {
  /** Points of the chain being drawn (first = start). */
  chain(): Vec2[]
}

export function createWallTool(deps: ToolDeps): WallTool {
  const { store } = deps
  let chain: Vec2[] = []
  let hover: Vec2 | null = null
  const clicks = createClickTracker(deps.now ?? defaultNow)

  const changed = () => {
    preview.bump()
    deps.invalidate?.()
  }

  const pointOf = (e: Pick<ToolPointerEvent, "alt" | "shift" | "ground">): Vec2 | null => {
    if (!e.ground) return null
    const s = store.getState()
    const mode = pointerSnapMode(store, e)
    const last = chain[chain.length - 1]
    if (e.shift && last) return constrainAngle(s.scene.grid, last, e.ground, mode)
    return snapWallPoint(s.scene, s.activeLevelId, e.ground, { mode, extraPoints: chain.length > 0 ? [chain[0]] : [] }).point
  }

  /** Why a segment a→b cannot be created, or null if it can. */
  const segmentProblem = (a: Vec2, b: Vec2): string | null => {
    const s = store.getState()
    if (Math.hypot(b.x - a.x, b.z - a.z) < MIN_WALL_LENGTH) return "too short"
    if (!insideExtent(s.scene.grid, a, EXTENT_MARGIN) || !insideExtent(s.scene.grid, b, EXTENT_MARGIN)) return "outside the scene"
    for (const w of objectsOfType(s.scene, "wall", s.activeLevelId)) {
      if ((samePoint(w.a, a) && samePoint(w.b, b)) || (samePoint(w.a, b) && samePoint(w.b, a))) return "duplicate wall"
    }
    return null
  }

  const finish = () => {
    chain = []
    clicks.reset()
    changed()
  }

  const preview = createPreviewCache(store, (): ToolPreview | null => {
    const s = store.getState()
    const { height, thickness } = s.toolSettings.wall
    const levelId = s.activeLevelId
    const last = chain[chain.length - 1]
    if (last && hover) return { kind: "segment", levelId, a: last, b: hover, height, thickness, valid: segmentProblem(last, hover) === null }
    if (hover) return { kind: "point", levelId, position: { x: hover.x, y: 0, z: hover.z }, radius: Math.max(thickness, 0.25) }
    return null
  })

  const tool: WallTool = {
    id: "wall",
    capturesPointer: true,

    onPointerDown(e) {
      if (e.button === 2) {
        if (chain.length > 0) finish()
        return
      }
      if (e.button !== 0) return
      const p = pointOf(e)
      if (!p) return
      const double = clicks.click(e)
      if (chain.length === 0) {
        chain = [p]
        hover = p
        changed()
        return
      }
      const last = chain[chain.length - 1]
      if (double || samePoint(p, last)) {
        finish()
        return
      }
      if (segmentProblem(last, p) !== null) return
      const s = store.getState()
      const settings = s.toolSettings.wall
      s.addObject(createWall(s.activeLevelId, last, p, { height: settings.height, thickness: settings.thickness, material: settings.material }), "Add wall")
      if (chain.length > 1 && samePoint(p, chain[0])) {
        finish()
        return
      }
      chain = [...chain, p]
      changed()
    },

    onPointerMove(e) {
      const p = pointOf(e)
      if (p && hover && samePoint(p, hover, 1e-9)) return
      hover = p
      changed()
    },

    onKeyDown(e) {
      if ((e.key === "Escape" || e.key === "Enter") && chain.length > 0) {
        finish()
        return true
      }
      return false
    },

    cancel() {
      hover = null
      finish()
    },

    preview: () => preview.get(),

    chain: () => chain,
  }
  return tool
}
