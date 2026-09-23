/**
 * Small geometry helpers shared by the play controllers (ARCHITECTURE §8): token anchors under the
 * cursor, grid distances (diagonal rule) and ruler overlays for paths and measurements.
 */
import { cellCenter, cellOf, pathDistance } from "@/core/grid/grid"
import { anchorPosition, measurePath, tokenAnchor } from "@/core/movement"
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

/** Cells of a king-move path from a (excluded) to b (included): diagonal steps first, then straight. */
export function legCells(a: Cell, b: Cell): Cell[] {
  const out: Cell[] = []
  let i = a.i
  let j = a.j
  // Bounded: every iteration moves one step closer on at least one axis.
  while (i !== b.i || j !== b.j) {
    i += Math.sign(b.i - i)
    j += Math.sign(b.j - j)
    out.push({ i, j })
  }
  return out
}

/** Grid distance (diagonal rule over the whole route) of a ruler through the cells of `points`. */
export function measureDistance(
  grid: GridSettings,
  points: readonly Vec2[]
): number {
  if (points.length < 2) return 0
  const cells: Cell[] = [cellOf(grid, points[0])]
  for (let k = 1; k < points.length; k++)
    cells.push(...legCells(cells[cells.length - 1], cellOf(grid, points[k])))
  return pathDistance(grid, cells)
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

/** Ruler overlay along a token path; null for paths without movement. */
export function pathRuler(
  scene: Pick<SceneLike, "levels" | "grid" | "objects">,
  size: Token["size"],
  path: readonly PathStep[],
  suffix?: string
): RulerOverlay | null {
  if (path.length < 2) return null
  const points = pathPoints(scene, size, path)
  const feet = measurePath(scene, [...path])
  const label = suffix ? `${formatFeet(feet)} · ${suffix}` : formatFeet(feet)
  return {
    levelId: path[path.length - 1].levelId,
    points: points.length >= 2 ? points : [...points, ...points],
    label,
  }
}

/** Straight ruler between two ground points on one level (cell-snapped, grid distance). */
export function straightRuler(
  scene: Pick<SceneLike, "levels" | "grid" | "objects">,
  levelId: Id,
  from: Vec2,
  to: Vec2,
  suffix?: string
): RulerOverlay {
  const feet = measureDistance(scene.grid, [from, to])
  const a = {
    x: from.x,
    y: groundY(scene, levelId, from) + RULER_LIFT,
    z: from.z,
  }
  const b = { x: to.x, y: groundY(scene, levelId, to) + RULER_LIFT, z: to.z }
  return {
    levelId,
    points: [a, b],
    label: suffix ? `${formatFeet(feet)} · ${suffix}` : formatFeet(feet),
  }
}

export function samePoint(
  a: Vec2 | null | undefined,
  b: Vec2 | null | undefined
): boolean {
  return !!a && !!b && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.z - b.z) < 1e-6
}
