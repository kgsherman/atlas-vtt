/**
 * Measure tool (ruler): each click adds a waypoint, the pointer drags the live end. With snapping,
 * waypoints sit on cell centres and the distance follows the grid's diagonal rule over the whole
 * path (core/grid pathDistance); in free mode (Alt / snap "free") it is the euclidean length.
 * Right-click, Enter or a double-click freezes the ruler; the next click starts a new one; Escape
 * clears it.
 */
import { cellCenter, cellOf, pathDistance } from "@/core/grid/grid"
import { groundHeightAt } from "@/core/scene/queries"
import type { Cell, GridSettings, Id, Vec2 } from "@/core/scene/types"
import type { RulerOverlay } from "@/render/contracts"

import { createClickTracker, defaultNow, pointerSnapMode, samePoint, type ToolDeps } from "./shared"
import type { Tool, ToolPointerEvent } from "./types"

/** Cells of a king-move path from a (excluded) to b (included): diagonal steps first, then straight. */
export function legCells(a: Cell, b: Cell): Cell[] {
  const out: Cell[] = []
  let i = a.i
  let j = a.j
  while (i !== b.i || j !== b.j) {
    i += Math.sign(b.i - i)
    j += Math.sign(b.j - j)
    out.push({ i, j })
  }
  return out
}

/**
 * Length in feet of a ruler through `points`: euclidean on XZ when `free`, else the grid distance of
 * the cell path through the points' cells (the diagonal rule counts diagonals across all legs).
 */
export function measureDistance(grid: GridSettings, points: readonly Vec2[], free: boolean): number {
  if (points.length < 2) return 0
  if (free) {
    let total = 0
    for (let k = 1; k < points.length; k++) total += Math.hypot(points[k].x - points[k - 1].x, points[k].z - points[k - 1].z)
    return total
  }
  const cells: Cell[] = [cellOf(grid, points[0])]
  for (let k = 1; k < points.length; k++) cells.push(...legCells(cells[cells.length - 1], cellOf(grid, points[k])))
  return pathDistance(grid, cells)
}

export function formatFeet(feet: number, free: boolean): string {
  const v = free ? Math.round(feet * 10) / 10 : Math.round(feet)
  return `${v} ft`
}

export interface MeasureTool extends Tool {
  ruler(): RulerOverlay | null
  /** Current length in feet (0 without a ruler). */
  distance(): number
}

export function createMeasureTool(deps: ToolDeps): MeasureTool {
  const { store } = deps
  let points: Vec2[] = []
  let live: Vec2 | null = null
  let done = false
  let free = false
  let levelId: Id | null = null
  /** Memoised overlay (same object until the ruler or the scene changes, so the renderer does not rebuild it). */
  let cached: { scene: unknown; value: RulerOverlay | null } | undefined
  const clicks = createClickTracker(deps.now ?? defaultNow)

  const changed = () => {
    cached = undefined
    deps.invalidate?.()
  }

  const pointOf = (e: Pick<ToolPointerEvent, "alt" | "ground">, isFree: boolean): Vec2 | null => {
    if (!e.ground) return null
    if (isFree) return { x: e.ground.x, z: e.ground.z }
    const grid = store.getState().scene.grid
    return cellCenter(grid, cellOf(grid, e.ground))
  }

  /** Placed waypoints plus the live end (unless it sits on the last waypoint). */
  const path = (): Vec2[] => {
    const last = points[points.length - 1]
    return live && !done && !(last && samePoint(live, last)) ? [...points, live] : points
  }

  const clear = () => {
    points = []
    live = null
    done = false
    levelId = null
    clicks.reset()
    changed()
  }

  const tool: MeasureTool = {
    id: "measure",
    capturesPointer: true,

    onPointerDown(e) {
      if (e.button === 2) {
        if (points.length > 0 && !done) {
          done = true
          changed()
        }
        return
      }
      if (e.button !== 0) return
      if (done) clear()
      if (points.length === 0) {
        free = pointerSnapMode(store, e) === "free"
        levelId = store.getState().activeLevelId
      }
      const p = pointOf(e, free)
      if (!p) return
      const double = clicks.click(e)
      const last = points[points.length - 1]
      if (last && (double || samePoint(p, last))) {
        done = true
        changed()
        return
      }
      points = [...points, p]
      live = p
      changed()
    },

    onPointerMove(e) {
      if (points.length === 0 || done) return
      const p = pointOf(e, free)
      if (!p || (live && samePoint(p, live, 1e-9))) return
      live = p
      changed()
    },

    onKeyDown(e) {
      if (e.key === "Escape" && points.length > 0) {
        clear()
        return true
      }
      if (e.key === "Enter" && points.length > 0 && !done) {
        done = true
        changed()
        return true
      }
      return false
    },

    cancel() {
      clear()
    },

    preview: () => null,

    distance: () => measureDistance(store.getState().scene.grid, path(), free),

    ruler() {
      const s = store.getState()
      if (cached !== undefined && cached.scene === s.scene) return cached.value
      const pts = path()
      let value: RulerOverlay | null = null
      if (pts.length > 0 && levelId) {
        const lid = levelId
        const hasLevel = Object.hasOwn(s.scene.levels, lid)
        value = {
          levelId: lid,
          points: pts.map((p) => ({ x: p.x, y: hasLevel ? groundHeightAt(s.scene, lid, p) : 0, z: p.z })),
          label: formatFeet(measureDistance(s.scene.grid, pts, free), free),
        }
      }
      cached = { scene: s.scene, value }
      return value
    },
  }
  return tool
}
