/**
 * Off-grid movement (docs/ARCHITECTURE.md §5.3 "Gridless moves and jumps"):
 *
 *  - a gridless move is an ordinary grid path plus an exact END point: the token walks the path and then
 *    steps from the last anchor's centre to `end`, which must lie in that anchor's snapping region (it
 *    anchors to the same cell), have ground and be reachable by a clear sweep;
 *  - a jump puts a token at a point without walking there: the footprint must be on the grid, grounded,
 *    and the token's disc must not overlap a movement blocker;
 *  - smoothPath string-pulls a path into the polyline a gridless move is drawn and animated along
 *    (display only: the host validates the grid path).
 */
import type { OcclusionWorld } from "../occlusion/types"
import { groundIndex } from "../scene/queries"
import type { Id, SceneLike, Token, Vec2 } from "../scene/types"
import { footprintOverlapsSpan, MoveContext, STEP_UP_HEIGHT } from "./context"
import { anchorOf } from "./footprint"
import type { MoveRejectReason, PathStep } from "./types"

/** A point a token passes through, on a level. */
export interface MotionPoint {
  levelId: Id
  position: Vec2
}

const finite = (p: Vec2) => Number.isFinite(p.x) && Number.isFinite(p.z)

/**
 * Why the final step of a gridless move, from `from` (the centre of the path's last anchor, or the
 * token's own position for a move within its cell) to `end`, is illegal; null when it is legal. `last`
 * is the path's final (legal) step.
 */
export function checkEnd(scene: SceneLike, world: OcclusionWorld, token: Token, last: PathStep, from: Vec2, end: Vec2): MoveRejectReason | null {
  if (!finite(end)) return "out-of-bounds"
  const anchor = anchorOf(scene.grid, token.size, end)
  if (anchor.i !== last.cell.i || anchor.j !== last.cell.j) return "not-adjacent"
  const ctx = new MoveContext(scene, world, token)
  if (!ctx.inBounds(anchor)) return "out-of-bounds"
  if (!groundIndex(scene).hasGroundAt(last.levelId, end)) return "no-ground"
  const gA = ctx.groundAt(last.levelId, from)
  const gB = ctx.groundAt(last.levelId, end)
  const blocked = ctx.sweepBlocked([last.levelId], from, end, Math.min(gA, gB) + STEP_UP_HEIGHT, Math.max(gA, gB) + ctx.height, gA)
  return blocked ? "blocked" : null
}

/** Why a token cannot jump to `p` on `levelId` (not walking there), or null when it can. */
export function checkJump(scene: SceneLike, world: OcclusionWorld, token: Token, levelId: Id, p: Vec2): MoveRejectReason | null {
  if (!finite(p)) return "out-of-bounds"
  const ctx = new MoveContext(scene, world, token)
  const anchor = anchorOf(scene.grid, token.size, p)
  if (!ctx.inBounds(anchor)) return "out-of-bounds"
  if (!ctx.hasLevel(levelId)) return "no-ground"
  if (!groundIndex(scene).hasGroundAt(levelId, p) || !ctx.footprintGrounded(levelId, anchor)) return "no-ground"
  const g = ctx.groundAt(levelId, p)
  return ctx.discBlocked([levelId], p, g + STEP_UP_HEIGHT, g + ctx.height) ? "blocked" : null
}

/** Farthest a pulled segment reaches along the path (steps). */
const MAX_PULL = 24

/**
 * The polyline a token walking `path` (then to `end`, when given) is drawn and animated along, with
 * corners cut wherever the straight line is as legal as the steps it replaces: on one level, clear of
 * movement blockers (the steps' vertical window), grounded throughout and away from stairs, ramps and
 * ladders (whose edge rules the grid steps follow). Starts at the token's own position.
 */
export function smoothPath(scene: SceneLike, world: OcclusionWorld, token: Token, path: readonly PathStep[], end?: Vec2 | null): MotionPoint[] {
  if (path.length === 0) return []
  const ctx = new MoveContext(scene, world, token)
  const ground = groundIndex(scene)
  const pts: MotionPoint[] = path.map((s, k) => ({ levelId: s.levelId, position: k === 0 ? { ...token.position } : ctx.center(s.cell) }))
  const cells = path.map((s) => s.cell)
  if (end && finite(end)) {
    pts.push({ levelId: path[path.length - 1].levelId, position: { ...end } })
    cells.push(anchorOf(scene.grid, token.size, end))
  }
  const nearConnector = (k: number) => {
    const levelId = pts[k].levelId
    return ctx.spans.some((sp) => (sp.c.levelId === levelId || sp.c.toLevelId === levelId) && footprintOverlapsSpan(sp, cells[k], ctx.k))
  }
  const grounded = (levelId: Id, a: Vec2, b: Vec2) => {
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / (scene.grid.cellSize / 2))
    for (let s = 1; s < n; s++) {
      const t = s / n
      if (!ground.hasGroundAt(levelId, { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })) return false
    }
    return true
  }
  const canPull = (i: number, j: number) => {
    const levelId = pts[i].levelId
    let lo = Infinity
    let hi = -Infinity
    for (let k = i; k <= j; k++) {
      if (pts[k].levelId !== levelId || nearConnector(k)) return false
      const g = ctx.groundAt(levelId, pts[k].position)
      lo = Math.min(lo, g)
      hi = Math.max(hi, g)
    }
    const a = pts[i].position
    const b = pts[j].position
    if (!grounded(levelId, a, b)) return false
    return !ctx.sweepBlocked([levelId], a, b, lo + STEP_UP_HEIGHT, hi + ctx.height, ctx.groundAt(levelId, a))
  }
  const out: MotionPoint[] = [pts[0]]
  let i = 0
  while (i < pts.length - 1) {
    let j = i + 1
    while (j + 1 < pts.length && j + 1 - i <= MAX_PULL && canPull(i, j + 1)) j++
    out.push(pts[j])
    i = j
  }
  // Consecutive duplicates (a ladder switch keeps its position; an end on the centre) collapse unless
  // the level changes.
  return out.filter((p, k) => {
    const q = out[k - 1]
    return !q || q.levelId !== p.levelId || Math.abs(q.position.x - p.position.x) > 1e-6 || Math.abs(q.position.z - p.position.z) > 1e-6
  })
}
