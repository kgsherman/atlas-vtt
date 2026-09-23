/**
 * Legality of one path step (docs/ARCHITECTURE.md §2 "Connectors", §5.3). Shared by validateMove and
 * findPath so the pathfinder only ever proposes steps the host accepts.
 *
 * A step a → b is one of:
 *  - "move": an 8-neighbour anchor on the same level;
 *  - "ladder": a switch in place between a ladder's two levels, the footprint touching the ladder cell;
 *  - "stairs": an orthogonal step across a stairs/ramp TOP edge, between the footprint whose leading
 *    row is the run's last row (on the lower level) and the footprint one cell beyond (on the upper
 *    level), in either direction. The footprint must lie within the run's width.
 *
 * Checks, in order: out-of-bounds, adjacency (not-adjacent / no-connector / connector-edge for level
 * changes), connector-edge, corner-cutting, blocked, no-ground. (Speed is checked by validateMove.)
 */
import { levelGround } from "../scene/queries"
import type { Cell, Id } from "../scene/types"
import {
  footprintAlong,
  footprintOverlapsSpan,
  footprintWithinLateral,
  spanAlong,
  spanContains,
  STEP_UP_HEIGHT,
  topEdgePoint,
  type ConnectorSpan,
  type MoveContext,
} from "./context"
import type { MoveRejectReason, PathStep } from "./types"

export const NEIGHBOURS: readonly Cell[] = [
  { i: 1, j: 0 },
  { i: 0, j: 1 },
  { i: -1, j: 0 },
  { i: 0, j: -1 },
  { i: 1, j: 1 },
  { i: -1, j: 1 },
  { i: 1, j: -1 },
  { i: -1, j: -1 },
]

export const sameStep = (a: PathStep, b: PathStep): boolean =>
  a.levelId === b.levelId && a.cell.i === b.cell.i && a.cell.j === b.cell.j

/** The ladder (if any) letting a footprint at `anchor` switch in place between levels `from` and `to`. */
export function ladderFor(ctx: MoveContext, anchor: Cell, from: Id, to: Id): ConnectorSpan | null {
  for (const sp of ctx.spans) {
    if (sp.c.style !== "ladder") continue
    const links = (sp.c.levelId === from && sp.c.toLevelId === to) || (sp.c.levelId === to && sp.c.toLevelId === from)
    if (links && footprintOverlapsSpan(sp, anchor, ctx.k)) return sp
  }
  return null
}

/** The stairs/ramp whose top edge the step a → b crosses as a level change, or null. */
export function crossingFor(ctx: MoveContext, a: PathStep, b: PathStep): ConnectorSpan | null {
  for (const sp of ctx.spans) {
    if (sp.c.style === "ladder") continue
    let lower: Cell
    let upper: Cell
    if (a.levelId === sp.c.levelId && b.levelId === sp.c.toLevelId) {
      lower = a.cell
      upper = b.cell
    } else if (a.levelId === sp.c.toLevelId && b.levelId === sp.c.levelId) {
      lower = b.cell
      upper = a.cell
    } else continue
    if (upper.i !== lower.i + sp.fwd.i || upper.j !== lower.j + sp.fwd.j) continue
    if (!footprintWithinLateral(sp, lower, ctx.k)) continue
    if (footprintAlong(sp, lower, ctx.k).hi !== sp.top) continue
    return sp
  }
  return null
}

/** A stairs/ramp linking the two levels of a level-change step lies under either footprint. */
function stairsTouched(ctx: MoveContext, a: PathStep, b: PathStep): boolean {
  for (const sp of ctx.spans) {
    if (sp.c.style === "ladder") continue
    const links =
      (sp.c.levelId === a.levelId && sp.c.toLevelId === b.levelId) || (sp.c.levelId === b.levelId && sp.c.toLevelId === a.levelId)
    if (links && (footprintOverlapsSpan(sp, a.cell, ctx.k) || footprintOverlapsSpan(sp, b.cell, ctx.k))) return true
  }
  return false
}

/**
 * Connector-edge rule for a same-level step, per footprint cell: a cell that enters or leaves a
 * stairs/ramp rect crosses its TOP edge when the cell outside the rect is beyond the top row.
 *  - On the run's lower level, crossing the top edge is only possible as a level change.
 *  - On the upper level, a footprint may enter/leave the rect only across the top edge.
 */
export function crossesConnectorEdge(ctx: MoveContext, levelId: Id, a: Cell, di: number, dj: number): boolean {
  const k = ctx.k
  for (const sp of ctx.spans) {
    if (sp.c.style === "ladder") continue
    const lower = sp.c.levelId === levelId
    if (!lower && sp.c.toLevelId !== levelId) continue
    // Quick reject: the union of both footprints does not reach the rect.
    const minI = Math.min(a.i, a.i + di)
    const minJ = Math.min(a.j, a.j + dj)
    const maxI = Math.max(a.i, a.i + di) + k - 1
    const maxJ = Math.max(a.j, a.j + dj) + k - 1
    if (maxI < sp.i0 || minI > sp.i1 || maxJ < sp.j0 || minJ > sp.j1) continue
    for (let y = 0; y < k; y++) {
      for (let x = 0; x < k; x++) {
        const ci = a.i + x
        const cj = a.j + y
        const inA = spanContains(sp, ci, cj)
        const inB = spanContains(sp, ci + di, cj + dj)
        if (inA === inB) continue
        const beyond = inA ? spanAlong(sp, ci + di, cj + dj) > sp.top : spanAlong(sp, ci, cj) > sp.top
        if (lower ? beyond : !beyond) return true
      }
    }
  }
  return false
}

/**
 * Diagonal steps may not cut corners: both L-shaped routes through the orthogonal intermediate
 * positions must be free of blockers.
 */
export function cutsCorner(ctx: MoveContext, levelId: Id, a: Cell, di: number, dj: number): boolean {
  return (
    ctx.moveBlocked(levelId, a, di, 0) ||
    ctx.moveBlocked(levelId, a, 0, dj) ||
    ctx.moveBlocked(levelId, { i: a.i + di, j: a.j }, 0, dj) ||
    ctx.moveBlocked(levelId, { i: a.i, j: a.j + dj }, di, 0)
  )
}

/**
 * Stairs crossing sweep: blockers on both levels. The token passes over the top edge, where the run
 * meets the upper ground, so the vertical window is taken from the upper ground at the edge and at
 * the upper endpoint (walls of the lower level ending under the upper floor do not block).
 */
function crossingBlocked(ctx: MoveContext, sp: ConnectorSpan, a: PathStep, b: PathStep): boolean {
  const up = a.levelId === sp.c.toLevelId ? a : b
  const upCenter = ctx.center(up.cell)
  const gUp = ctx.groundAtAnchor(up.levelId, up.cell)
  const edge = topEdgePoint(sp, upCenter, ctx.grid.cellSize)
  const gEdge = levelGround(ctx.scene, sp.c.toLevelId, edge.x, edge.z)
  return ctx.sweepBlocked(
    [sp.c.levelId, sp.c.toLevelId],
    ctx.center(a.cell),
    ctx.center(b.cell),
    Math.min(gUp, gEdge) + STEP_UP_HEIGHT,
    Math.max(gUp, gEdge) + ctx.height,
    ctx.groundAtAnchor(a.levelId, a.cell)
  )
}

/** Ladder switch: the footprint must be free on the destination level. */
function ladderBlocked(ctx: MoveContext, a: PathStep, b: PathStep): boolean {
  const p = ctx.center(b.cell)
  const g = ctx.groundAtAnchor(b.levelId, b.cell)
  return ctx.sweepBlocked([b.levelId], p, p, g + STEP_UP_HEIGHT, g + ctx.height, ctx.groundAtAnchor(a.levelId, a.cell))
}

/** Why the step a → b is illegal, or null when it is legal. `a` is assumed to be a legal position. */
export function checkStep(ctx: MoveContext, a: PathStep, b: PathStep): MoveRejectReason | null {
  if (!ctx.inBounds(b.cell)) return "out-of-bounds"
  const di = b.cell.i - a.cell.i
  const dj = b.cell.j - a.cell.j
  const cheb = Math.max(Math.abs(di), Math.abs(dj))
  if (a.levelId === b.levelId) {
    if (cheb !== 1) return "not-adjacent"
    if (crossesConnectorEdge(ctx, a.levelId, a.cell, di, dj)) return "connector-edge"
    if (di !== 0 && dj !== 0 && cutsCorner(ctx, a.levelId, a.cell, di, dj)) return "corner-cutting"
    if (ctx.moveBlocked(a.levelId, a.cell, di, dj)) return "blocked"
  } else {
    if (cheb > 1) return "not-adjacent"
    if (!ctx.hasLevel(b.levelId)) return "no-connector"
    if (cheb === 0) {
      if (!ladderFor(ctx, a.cell, a.levelId, b.levelId)) return "no-connector"
      if (ladderBlocked(ctx, a, b)) return "blocked"
    } else {
      const sp = crossingFor(ctx, a, b)
      if (!sp) return stairsTouched(ctx, a, b) ? "connector-edge" : "no-connector"
      if (crossingBlocked(ctx, sp, a, b)) return "blocked"
    }
  }
  if (!ctx.footprintGrounded(b.levelId, b.cell)) return "no-ground"
  return null
}

/** Candidate steps from a position (8 neighbours, ladder switches, stairs crossings), not yet checked. */
export function candidateSteps(ctx: MoveContext, s: PathStep): PathStep[] {
  const out: PathStep[] = []
  for (const d of NEIGHBOURS) out.push({ cell: { i: s.cell.i + d.i, j: s.cell.j + d.j }, levelId: s.levelId })
  for (const sp of ctx.spans) {
    const { levelId, toLevelId } = sp.c
    if (sp.c.style === "ladder") {
      const other = levelId === s.levelId ? toLevelId : toLevelId === s.levelId ? levelId : null
      if (other !== null && footprintOverlapsSpan(sp, s.cell, ctx.k)) out.push({ cell: s.cell, levelId: other })
    } else if (levelId === s.levelId) {
      out.push({ cell: { i: s.cell.i + sp.fwd.i, j: s.cell.j + sp.fwd.j }, levelId: toLevelId })
    } else if (toLevelId === s.levelId) {
      out.push({ cell: { i: s.cell.i - sp.fwd.i, j: s.cell.j - sp.fwd.j }, levelId })
    }
  }
  return out
}
