/**
 * Connector tool (stairs / ladder / ramp): drag a cell-aligned rect on the active level; the
 * connector leads to the level directly above. Style and ascending direction come from the tool
 * settings (direction "auto" = the drag direction, bottom of the run → top). Ladders are one cell.
 */
import { cellOf, inBounds } from "@/core/grid/grid"
import { createConnector } from "@/core/scene/factory"
import { adjacentLevels } from "@/core/scene/queries"
import type { Cell, ConnectorObject, Id, Rect } from "@/core/scene/types"
import type { ToolPreview } from "@/render/contracts"

import { createPreviewCache, INVALID_COLOR, PREVIEW_COLOR, type ToolDeps } from "./shared"
import type { Tool } from "./types"

/** Ascending direction implied by a drag from `a` to `b` (dominant axis; +Z when there was no drag). */
export function dragDirection(a: Cell, b: Cell): ConnectorObject["direction"] {
  const di = b.i - a.i
  const dj = b.j - a.j
  if (di === 0 && dj === 0) return 0
  if (Math.abs(di) > Math.abs(dj)) return di > 0 ? 1 : 3
  return dj > 0 ? 0 : 2
}

export interface ConnectorPlacement {
  rect: Rect
  direction: ConnectorObject["direction"]
  toLevelId: Id | null
  valid: boolean
}

export function createConnectorTool(deps: ToolDeps): Tool {
  const { store } = deps
  let drag: { start: Cell; end: Cell } | null = null
  let hover: Cell | null = null

  const changed = () => {
    preview.bump()
    deps.invalidate?.()
  }

  const placement = (): ConnectorPlacement | null => {
    const s = store.getState()
    const grid = s.scene.grid
    const start = drag?.start ?? hover
    const end = drag?.end ?? hover
    if (!start || !end) return null
    const settings = s.toolSettings.connector
    const c = grid.cellSize
    let rect: Rect
    if (settings.style === "ladder") {
      rect = { x: start.i * c, z: start.j * c, w: c, d: c }
    } else {
      const i0 = Math.min(start.i, end.i)
      const j0 = Math.min(start.j, end.j)
      rect = { x: i0 * c, z: j0 * c, w: (Math.abs(end.i - start.i) + 1) * c, d: (Math.abs(end.j - start.j) + 1) * c }
    }
    const direction = settings.direction === "auto" ? dragDirection(start, end) : settings.direction
    const toLevelId = adjacentLevels(s.scene, s.activeLevelId).above?.id ?? null
    const inside = inBounds(grid, start) && inBounds(grid, end)
    return { rect, direction, toLevelId, valid: toLevelId !== null && inside }
  }

  const preview = createPreviewCache(store, (): ToolPreview | null => {
    const p = placement()
    if (!p) return null
    return { kind: "rect", levelId: store.getState().activeLevelId, rect: p.rect, color: p.valid ? PREVIEW_COLOR : INVALID_COLOR }
  })

  return {
    id: "connector",
    capturesPointer: true,

    onPointerDown(e) {
      if (e.button !== 0 || !e.ground) return
      const cell = cellOf(store.getState().scene.grid, e.ground)
      drag = { start: cell, end: cell }
      changed()
    },

    onPointerMove(e) {
      if (!e.ground) return
      const cell = cellOf(store.getState().scene.grid, e.ground)
      if (drag) {
        if (drag.end.i === cell.i && drag.end.j === cell.j) return
        drag.end = cell
      } else {
        if (hover && hover.i === cell.i && hover.j === cell.j) return
        hover = cell
      }
      changed()
    },

    onPointerUp(e) {
      if (!drag) return
      if (e.ground) drag.end = cellOf(store.getState().scene.grid, e.ground)
      const p = placement()
      drag = null
      changed()
      if (!p || !p.valid || !p.toLevelId) return
      const s = store.getState()
      const settings = s.toolSettings.connector
      const connector = createConnector(s.activeLevelId, p.toLevelId, p.rect, p.direction, settings.style)
      connector.material = settings.material
      s.addObject(connector, `Add ${settings.style}`)
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
