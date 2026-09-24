/**
 * Small geometry helpers shared by the play controllers (ARCHITECTURE §8): token anchors under the
 * cursor, grid distances (diagonal rule) and ruler overlays for paths and measurements.
 */
import { cellCenter, cellOf, rulerDistance } from "@/core/grid/grid"
import {
  anchorPosition,
  measurePath,
  tokenAnchor,
  type MotionPoint,
} from "@/core/movement"
import type { PathStep } from "@/core/movement/types"
import { groundIndex, levelById } from "@/core/scene/queries"
import type {
  Cell,
  GridSettings,
  Id,
  SceneLike,
  Token,
  Vec2,
  Vec3,
} from "@/core/scene/types"
import type { RulerOverlay } from "@/render/contracts"

/** Height above the ground the ruler line floats at (feet). */
export const RULER_LIFT = 0.15
/** Draped lines sample the ground about this often (feet). */
const DRAPE_STEP = 0.5
/** At most this many draped points per line (long lines sample more coarsely). */
const MAX_DRAPE_POINTS = 1500

/**
 * World points along a route that follow the ground (heightmaps, slopes, stairs): each segment is
 * sampled every DRAPE_STEP feet at its level's ground + RULER_LIFT. A level change (stairs top edge)
 * switches level halfway along its segment.
 */
export function drapeRoute(
  scene: Pick<SceneLike, "levels" | "grid" | "objects">,
  route: readonly MotionPoint[]
): Vec3[] {
  const out: Vec3[] = []
  if (route.length === 0) return out
  let total = 0
  for (let k = 1; k < route.length; k++)
    total += Math.hypot(
      route[k].position.x - route[k - 1].position.x,
      route[k].position.z - route[k - 1].position.z
    )
  const step = Math.max(DRAPE_STEP, total / MAX_DRAPE_POINTS)
  const at = (levelId: Id, x: number, z: number): Vec3 => ({
    x,
    y: groundY(scene, levelId, { x, z }) + RULER_LIFT,
    z,
  })
  out.push(at(route[0].levelId, route[0].position.x, route[0].position.z))
  for (let k = 1; k < route.length; k++) {
    const a = route[k - 1]
    const b = route[k]
    const dx = b.position.x - a.position.x
    const dz = b.position.z - a.position.z
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / step))
    for (let s = 1; s <= n; s++) {
      const t = s / n
      out.push(
        at(
          t < 0.5 ? a.levelId : b.levelId,
          a.position.x + dx * t,
          a.position.z + dz * t
        )
      )
    }
  }
  return out
}

/** A token path as route points (footprint centres). */
export function pathRoute(
  scene: Pick<SceneLike, "grid">,
  size: Token["size"],
  path: readonly PathStep[]
): MotionPoint[] {
  return path.map((s) => ({
    levelId: s.levelId,
    position: anchorPosition(scene, size, s.cell),
  }))
}

/** The anchor (min-corner footprint cell) that puts a token of `size` closest to `p`. */
export function anchorForPoint(
  grid: Pick<GridSettings, "cellSize">,
  size: Token["size"],
  p: Vec2
): Cell {
  return tokenAnchor({ grid: grid as GridSettings }, { size, position: p })
}

/** "35 ft"; non-integer distances (euclidean rule, free measuring) keep one decimal. */
export function formatFeet(feet: number): string {
  if (!Number.isFinite(feet)) return "—"
  const rounded = Math.round(feet)
  if (Math.abs(feet - rounded) < 0.05) return `${rounded} ft`
  return `${(Math.round(feet * 10) / 10).toFixed(1)} ft`
}

/** Cell centre under a ground point. */
export function snapToCellCenter(grid: GridSettings, p: Vec2): Vec2 {
  return cellCenter(grid, cellOf(grid, p))
}

/**
 * Ground height at p on a level (0 when the level is unknown). Through the scene's memoised
 * GroundIndex: this runs per path step on every drag update, and the free groundHeightAt scans every
 * object per call. Scenes here are committed (never mutated in place).
 */
export function groundY(
  scene: Pick<SceneLike, "levels" | "grid" | "objects">,
  levelId: Id,
  p: Vec2
): number {
  if (!levelById(scene, levelId)) return 0
  return groundIndex(scene).groundHeightAt(levelId, p)
}

/** World points of a token path (footprint centres at ground level + a small lift). */
export function pathPoints(
  scene: Pick<SceneLike, "levels" | "grid" | "objects">,
  size: Token["size"],
  path: readonly PathStep[]
): Vec3[] {
  const out: Vec3[] = []
  for (const step of path) {
    const p = anchorPosition(scene, size, step.cell)
    const y = groundY(scene, step.levelId, p) + RULER_LIFT
    const last = out[out.length - 1]
    // Level switches in place (ladders) add no distance: keep one point per position.
    if (
      last &&
      Math.abs(last.x - p.x) < 1e-6 &&
      Math.abs(last.z - p.z) < 1e-6
    ) {
      out[out.length - 1] = { x: p.x, y, z: p.z }
      continue
    }
    out.push({ x: p.x, y, z: p.z })
  }
  return out
}

/** Ruler overlay along a token path (a "path" line over the ground, dots at the steps); null for paths without movement. */
export function pathRuler(
  scene: Pick<SceneLike, "levels" | "grid" | "objects">,
  size: Token["size"],
  path: readonly PathStep[],
  suffix?: string
): RulerOverlay | null {
  if (path.length < 2) return null
  const stops = pathPoints(scene, size, path)
  const feet = measurePath(scene, [...path])
  const label = suffix ? `${formatFeet(feet)} · ${suffix}` : formatFeet(feet)
  const points = drapeRoute(scene, pathRoute(scene, size, path))
  return {
    levelId: path[path.length - 1].levelId,
    points: points.length >= 2 ? points : [...points, ...points],
    label,
    kind: "path",
    stops,
  }
}

/** Ruler overlay along a free route (gridless moves): a "path" line over the ground, `feet` in its label. */
export function routeRuler(
  scene: Pick<SceneLike, "levels" | "grid" | "objects">,
  route: readonly MotionPoint[],
  feet: number,
  suffix?: string
): RulerOverlay | null {
  if (route.length < 2) return null
  return {
    levelId: route[route.length - 1].levelId,
    points: drapeRoute(scene, route),
    label: suffix ? `${formatFeet(feet)} · ${suffix}` : formatFeet(feet),
    kind: "path",
  }
}

/**
 * Straight ruler between two ground points on one level (grid distance), draped over the ground. `kind`:
 * a DM's placement ("path"), a move that cannot be made ("blocked").
 */
export function straightRuler(
  scene: Pick<SceneLike, "levels" | "grid" | "objects">,
  levelId: Id,
  from: Vec2,
  to: Vec2,
  suffix?: string,
  kind: RulerOverlay["kind"] = "path"
): RulerOverlay {
  const feet = rulerDistance(scene.grid, [from, to])
  return {
    levelId,
    points: drapeRoute(scene, [
      { levelId, position: from },
      { levelId, position: to },
    ]),
    label: suffix ? `${formatFeet(feet)} · ${suffix}` : formatFeet(feet),
    kind,
  }
}

export function samePoint(
  a: Vec2 | null | undefined,
  b: Vec2 | null | undefined
): boolean {
  return !!a && !!b && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6
}
