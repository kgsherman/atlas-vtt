/**
 * Floor tool: drag a rect (corners on grid lines by default; Alt = free) to add a floor slab on the
 * active level. A click without a drag adds the cell under the pointer.
 */
import { cellOf, cellRect, snapPoint } from "@/core/grid/grid"
import { createFloor } from "@/core/scene/factory"
import { rectIntersection } from "@/core/scene/queries"
import type { Rect, Vec2 } from "@/core/scene/types"
import type { ToolPreview } from "@/render/contracts"

import { edgeSnapMode, extentRect } from "../snapping"
import { createPreviewCache, INVALID_COLOR, PREVIEW_COLOR, pointerSnapMode, rectFromCorners, type ToolDeps } from "./shared"
import type { Tool, ToolPointerEvent } from "./types"

/** Rects thinner than this (feet) count as a click. */
const MIN_SIZE = 0.1

export function createFloorTool(deps: ToolDeps): Tool {
  const { store } = deps
  let drag: { start: Vec2; startRaw: Vec2; end: Vec2; free: boolean } | null = null
  let hover: Vec2 | null = null

  const changed = () => {
    preview.bump()
    deps.invalidate?.()
  }

  const snap = (e: Pick<ToolPointerEvent, "alt">, p: Vec2): Vec2 => {
    const mode = pointerSnapMode(store, e)
    return mode === "free" ? { ...p } : snapPoint(store.getState().scene.grid, p, edgeSnapMode(mode))
  }

  /** The rect the current gesture would create (clipped to the scene extent), or null. */
  const targetRect = (): Rect | null => {
    const grid = store.getState().scene.grid
    let rect: Rect | null = null
    if (drag) {
      rect = rectFromCorners(drag.start, drag.end)
      if (rect.w < MIN_SIZE || rect.d < MIN_SIZE) rect = drag.free ? null : cellRect(grid, cellOf(grid, drag.startRaw))
    } else if (hover) {
      rect = cellRect(grid, cellOf(grid, hover))
    }
    return rect ? rectIntersection(rect, extentRect(grid)) : null
  }

  const preview = createPreviewCache(store, (): ToolPreview | null => {
    const levelId = store.getState().activeLevelId
    const rect = targetRect()
    if (rect) return { kind: "rect", levelId, rect, color: PREVIEW_COLOR }
    if (drag) return { kind: "rect", levelId, rect: rectFromCorners(drag.start, drag.end), color: INVALID_COLOR }
    return null
  })

  return {
    id: "floor",
    capturesPointer: true,

    onPointerDown(e) {
      if (e.button !== 0 || !e.ground) return
      const start = snap(e, e.ground)
      drag = { start, startRaw: { ...e.ground }, end: start, free: pointerSnapMode(store, e) === "free" }
      changed()
    },

    onPointerMove(e) {
      if (!e.ground) return
      hover = { ...e.ground }
      if (drag) drag.end = snap(e, e.ground)
      changed()
    },

    onPointerUp(e) {
      if (!drag) return
      if (e.ground) drag.end = snap(e, e.ground)
      const rect = targetRect()
      drag = null
      changed()
      if (!rect || rect.w < MIN_SIZE || rect.d < MIN_SIZE) return
      const s = store.getState()
      s.addObject(createFloor(s.activeLevelId, rect, s.toolSettings.floor.material), "Add floor")
    },

    onKeyDown(e) {
      if (e.key === "Escape" && drag) {
        drag = null
        changed()
        return true
      }
      return false
    },

    cancel() {
      drag = null
      changed()
    },

    preview: () => preview.get(),
  }
}
