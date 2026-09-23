/**
 * Measure tool (ruler): each click adds a waypoint, the pointer drags the live end. With snapping,
 * waypoints sit on cell centres and the distance follows the grid's diagonal rule over the whole
 * path; in free mode (Alt / snap "free") it is the euclidean length (both core/grid rulerDistance, the
 * rule of the play ruler too).
 * Right-click, Enter or a double-click freezes the ruler; the next click starts a new one; Escape
 * clears it.
 */
import { cellCenter, cellOf, rulerDistance } from "@/core/grid/grid"
import { groundIndex } from "@/core/scene/queries"
import type { Id, Vec2 } from "@/core/scene/types"
import type { RulerOverlay } from "@/render/contracts"

import { createClickTracker, defaultNow, isKeyAction, pointerSnapMode, samePoint, type ToolDeps } from "./shared"
import type { Tool, ToolPointerEvent } from "./types"

/**
 * "35 ft"; non-integer distances (euclidean diagonal rule, free measuring) keep one decimal. The same
 * rule as the play ruler (play/geometry formatFeet), so the DM and players read the same text.
 */
export function formatFeet(feet: number): string {
  if (!Number.isFinite(feet)) return "—"
  const rounded = Math.round(feet)
  if (Math.abs(feet - rounded) < 0.05) return `${rounded} ft`
  return `${(Math.round(feet * 10) / 10).toFixed(1)} ft`
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
      if (isKeyAction(e, "escape") && points.length > 0) {
        clear()
        return true
      }
      if (isKeyAction(e, "confirm") && points.length > 0 && !done) {
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

    distance: () => rulerDistance(store.getState().scene.grid, path(), free),

    ruler() {
      const s = store.getState()
      if (cached !== undefined && cached.scene === s.scene) return cached.value
      const pts = path()
      let value: RulerOverlay | null = null
      if (pts.length > 0 && levelId) {
        const lid = levelId
        const hasLevel = Object.hasOwn(s.scene.levels, lid)
        const g = hasLevel ? groundIndex(s.scene) : null
        value = {
          levelId: lid,
          points: pts.map((p) => ({ x: p.x, y: g ? g.groundHeightAt(lid, p) : 0, z: p.z })),
          label: formatFeet(rulerDistance(s.scene.grid, pts, free)),
        }
      }
      cached = { scene: s.scene, value }
      return value
    },
  }
  return tool
}
