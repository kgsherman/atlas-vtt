/**
 * The play-mode Measure tool (ARCHITECTURE §8), shared by players and the DM: press and drag to
 * measure from a cell centre to another; Shift-press continues the last ruler with another leg. The
 * distance follows the grid's diagonal rule over the whole route. The ruler stays until the next
 * measurement or clear() (Escape / leaving the tool).
 */
import type { GridSettings, Id, SceneLike, Vec2 } from "@/core/scene/types"
import type { RulerOverlay } from "@/render/contracts"

import {
  formatFeet,
  groundY,
  measureDistance,
  RULER_LIFT,
  samePoint,
  snapToCellCenter,
} from "./geometry"

export class MeasureTool {
  private levelId: Id | null = null
  private points: Vec2[] = []
  private live: Vec2 | null = null
  private dragging = false
  private cached: { scene: unknown; value: RulerOverlay | null } | null = null

  /** Press: start a ruler (or, with `extend`, add a leg to the finished one). */
  press(grid: GridSettings, levelId: Id, ground: Vec2, extend = false): void {
    const p = snapToCellCenter(grid, ground)
    if (!extend || this.points.length === 0 || this.levelId !== levelId) {
      this.points = [p]
      this.levelId = levelId
    }
    this.live = p
    this.dragging = true
    this.cached = null
  }

  /** Drag: move the live end. Returns whether the ruler changed. */
  move(grid: GridSettings, ground: Vec2): boolean {
    if (!this.dragging) return false
    const p = snapToCellCenter(grid, ground)
    if (samePoint(p, this.live)) return false
    this.live = p
    this.cached = null
    return true
  }

  /** Release: the live end becomes a waypoint; the ruler stays visible. */
  release(): void {
    if (!this.dragging) return
    this.dragging = false
    const last = this.points[this.points.length - 1]
    if (this.live && !samePoint(this.live, last)) this.points.push(this.live)
    this.live = null
    this.cached = null
  }

  clear(): void {
    this.points = []
    this.live = null
    this.dragging = false
    this.levelId = null
    this.cached = null
  }

  get active(): boolean {
    return this.dragging
  }

  get empty(): boolean {
    return this.points.length === 0
  }

  /** Ruler route: waypoints plus the live end. */
  route(): Vec2[] {
    const last = this.points[this.points.length - 1]
    return this.live && !samePoint(this.live, last)
      ? [...this.points, this.live]
      : [...this.points]
  }

  distance(grid: GridSettings): number {
    return measureDistance(grid, this.route())
  }

  /** Ruler overlay (memoised per scene + ruler state). */
  ruler(
    scene: Pick<SceneLike, "levels" | "grid" | "objects"> | null
  ): RulerOverlay | null {
    if (!scene || !this.levelId) return null
    if (this.cached && this.cached.scene === scene) return this.cached.value
    const route = this.route()
    const levelId = this.levelId
    const value: RulerOverlay | null =
      route.length < 2
        ? null
        : {
            levelId,
            points: route.map((p) => ({
              x: p.x,
              y: groundY(scene, levelId, p) + RULER_LIFT,
              z: p.z,
            })),
            label: formatFeet(measureDistance(scene.grid, route)),
          }
    this.cached = { scene, value }
    return value
  }
}
