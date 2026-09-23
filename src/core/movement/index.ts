/**
 * Public API of core/movement (docs/ARCHITECTURE.md §2 "Connectors", §5.3): token anchors, move
 * validation against core/occlusion's movement blockers and the connector rules, A* pathfinding over
 * the same legality, and ruler measurement.
 */
import { pathDistance, sameCell, stepCost } from "../grid/grid"
import type { OcclusionWorld } from "../occlusion/types"
import type { Cell, SceneLike, Token, Vec2 } from "../scene/types"
import { MoveContext } from "./context"
import { anchorCenter, tokenAnchor } from "./footprint"
import { PATH_NODE_LIMIT, searchPath } from "./pathfind"
import { checkStep, sameStep } from "./rules"
import type { MoveOptions, MoveRejectReason, MoveValidation, PathStep } from "./types"

export type * from "./types"

export { footprintCells, tokenAnchor } from "./footprint"
export { DOORWAY_MARGIN, MOVE_CLEARANCE, MoveContext, STEP_UP_HEIGHT, sweepRadius, walkableDoorOffset } from "./context"
export { PATH_NODE_LIMIT } from "./pathfind"
export { candidateSteps, checkStep } from "./rules"

/** Paths with more steps than this are rejected (MoveOptions.maxSteps default). */
export const MAX_PATH_STEPS = 256

/** Token centre position for an anchor cell. */
export function anchorPosition(scene: Pick<SceneLike, "grid">, size: Token["size"], anchor: Cell): Vec2 {
  return anchorCenter(scene.grid, size, anchor)
}

function rejected(reason: MoveRejectReason, legalSteps: number, distance: number, failedAt?: number): MoveValidation {
  const out: MoveValidation = { ok: false, legalSteps, distance, reason }
  if (failedAt !== undefined) out.failedAt = failedAt
  return out
}

/**
 * Validate a path (path[0] must be the token's current anchor + level). Returns the legal prefix:
 * `legalSteps` steps after the start are legal, `failedAt` is the index of the first illegal step.
 * Whole-path failures (empty, too long, wrong start) report legalSteps 0.
 */
export function validateMove(
  scene: SceneLike,
  world: OcclusionWorld,
  token: Token,
  path: PathStep[],
  opts: MoveOptions
): MoveValidation {
  if (path.length === 0) return rejected("empty-path", 0, 0)
  if (path.length - 1 > (opts.maxSteps ?? MAX_PATH_STEPS)) return rejected("path-too-long", 0, 0, 0)
  if (!sameStep(path[0], { cell: tokenAnchor(scene, token), levelId: token.levelId })) {
    return rejected("path-start-mismatch", 0, 0, 0)
  }
  const ctx = new MoveContext(scene, world, token)
  let distance = 0
  let diagonals = 0
  for (let n = 1; n < path.length; n++) {
    const a = path[n - 1]
    const b = path[n]
    const reason = checkStep(ctx, a, b)
    if (reason) return rejected(reason, n - 1, distance, n)
    const cost = sameCell(a.cell, b.cell) ? 0 : stepCost(scene.grid, a.cell, b.cell, diagonals)
    if (opts.enforceSpeed && distance + cost > token.speed) return rejected("too-far", n - 1, distance, n)
    distance += cost
    if (a.cell.i !== b.cell.i && a.cell.j !== b.cell.j) diagonals++
  }
  return { ok: true, legalSteps: path.length - 1, distance }
}

/**
 * A* over legal steps (incl. connector transitions) from the token's anchor to `target`. Returns the
 * path including the start, or null if unreachable within `maxSteps` (default 256) steps or
 * `nodeLimit` (default 20k) expanded nodes. Every returned path passes validateMove.
 */
export function findPath(
  scene: SceneLike,
  world: OcclusionWorld,
  token: Token,
  target: PathStep,
  opts?: { maxSteps?: number; nodeLimit?: number }
): PathStep[] | null {
  const ctx = new MoveContext(scene, world, token)
  const start: PathStep = { cell: tokenAnchor(scene, token), levelId: token.levelId }
  return searchPath(ctx, start, target, {
    maxSteps: opts?.maxSteps ?? MAX_PATH_STEPS,
    nodeLimit: opts?.nodeLimit ?? PATH_NODE_LIMIT,
  })
}

/** Feet travelled along a path using grid.diagonalRule (level switches cost 0; stairs runs cost their length). */
export function measurePath(scene: Pick<SceneLike, "grid">, path: PathStep[]): number {
  return pathDistance(
    scene.grid,
    path.map((s) => s.cell)
  )
}
