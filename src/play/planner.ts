/**
 * Client-side move planning (ARCHITECTURE §8): A* over the same legality the host validates with
 * (core/movement findPath / validateMove), on the scene the client has — the player's scene rebuilt
 * from its PlayerView, or the DM's full scene. The occlusion world is built lazily and kept up to date
 * incrementally from engine-style SceneChange hints (token-only changes never touch it: tokens are not
 * occluders).
 *
 * A drag target is a ground point on the active level; when that level has no ground there (a stair
 * landing upstairs, the room under a ladder), the other levels with ground at that cell are tried in
 * order of elevation distance, so dragging onto the top of a staircase paths up it. A drop on the cell
 * just beyond a stairs/ramp top edge (on the run's lower level, or the upper one when the token's view
 * has already switched to it) means going up: the run's upper level is tried first there, even when
 * the lower level also has floor at that cell (the usual layout: stairs inside a room). If the landing
 * is blocked, the lower-level path is still found.
 *
 * Blind landings (players, `PlannerOptions.unexplored`): a player's scene has floor only where the
 * player explored, so an upper storey never seen (a stub level) or an unseen landing has no ground on
 * the client. Such a drop is planned up the run to its top row plus the step across the top edge; the
 * client validates everything it knows (walls, doors, the run itself) and the host, which knows the
 * floor, validates the landing (a missing or blocked one stops the token on the top step).
 */
import {
  anchorPosition,
  findPath,
  footprintCells,
  MAX_PATH_STEPS,
  smoothPath,
  tokenAnchor,
  validateMove,
  type MotionPoint,
} from "@/core/movement"
import { anchorOf } from "@/core/movement/footprint"
import {
  connectorSpan,
  footprintAlong,
  footprintWithinLateral,
} from "@/core/movement/context"
import type {
  MoveRejectReason,
  MoveValidation,
  PathStep,
} from "@/core/movement/types"
import { buildOcclusionWorld } from "@/core/occlusion"
import type { OcclusionWorld } from "@/core/occlusion/types"
import { groundIndex, levelById, sortedLevels } from "@/core/scene/queries"
import type {
  Cell,
  ConnectorObject,
  Id,
  SceneLike,
  Token,
} from "@/core/scene/types"
import { decodeMaskCached, exploredTouched } from "@/core/session/masks"
import type { PlayerView } from "@/core/session/types"
import type { SceneChange } from "@/render/contracts"

export interface PlannedMove {
  tokenId: Id
  /** Where the drop was aimed (the level that was reachable, or the preferred one). */
  target: PathStep
  /** Full path including the start step; null when unreachable. */
  path: PathStep[] | null
  /** Feet along the path (diagonal rule). */
  distance: number
  /** Why no path exists (best guess for the UI), when path is null. */
  reason: "unreachable" | "no-ground" | "same-cell" | null
}

export interface PlannerOptions {
  /** Node budget for interactive previews (default 12k: a few ms on big maps). */
  nodeLimit?: number
  maxSteps?: number
  /**
   * Players: whether this client knows nothing of a level's cell (never explored). Enables blind
   * landings (see the file header). Omitted for the DM, whose scene is complete.
   */
  unexplored?: (levelId: Id, cell: Cell) => boolean
}

const DEFAULT_NODE_LIMIT = 12_000
/** Node budget for reconstructing routes of moves seen (animation only). */
const ROUTE_NODE_LIMIT = 6_000

export class MovePlanner {
  private scene: SceneLike | null = null
  private world: OcclusionWorld | null = null
  private cache: { key: string; scene: SceneLike; result: PlannedMove } | null =
    null
  private readonly nodeLimit: number
  private readonly maxSteps: number
  private readonly unexplored: PlannerOptions["unexplored"]

  constructor(opts: PlannerOptions = {}) {
    this.nodeLimit = opts.nodeLimit ?? DEFAULT_NODE_LIMIT
    this.maxSteps = opts.maxSteps ?? MAX_PATH_STEPS
    this.unexplored = opts.unexplored
  }

  /**
   * Adopt a new scene revision. `change` describes what changed since the previous one (null /
   * undefined = unknown: the world is rebuilt on the next query).
   */
  setScene(scene: SceneLike | null, change?: SceneChange | null): void {
    if (scene === this.scene) return
    const prev = this.scene
    this.scene = scene
    this.cache = null
    if (!scene || !prev || !this.world || !change || change.structure) {
      this.world = null
      return
    }
    try {
      if (change.objects?.length) this.world.update(scene, change.objects)
      for (const levelId of change.terrain ?? []) {
        if (!levelById(scene, levelId)) continue
        const g = scene.grid
        this.world.updateTerrain(scene, levelId, {
          x: 0,
          z: 0,
          w: g.width * g.cellSize,
          d: g.depth * g.cellSize,
        })
      }
    } catch {
      // Any inconsistency: rebuild from scratch on the next query.
      this.world = null
    }
  }

  getScene(): SceneLike | null {
    return this.scene
  }

  /** The occlusion world of the current scene (built on demand). */
  occlusion(): OcclusionWorld | null {
    if (!this.scene) return null
    this.world ??= buildOcclusionWorld(this.scene)
    return this.world
  }

  token(tokenId: Id): Token | null {
    const s = this.scene
    return s && Object.hasOwn(s.tokens, tokenId) ? s.tokens[tokenId] : null
  }

  /**
   * Plan a move of `tokenId` so that its anchor lands on `cell`, preferring `levelId`. Results are
   * cached per (token position, target) until the scene changes.
   */
  plan(tokenId: Id, cell: Cell, levelId: Id): PlannedMove | null {
    const scene = this.scene
    const token = this.token(tokenId)
    if (!scene || !token) return null
    const key = `${tokenId}|${token.levelId}|${token.position.x},${token.position.z}|${cell.i},${cell.j}|${levelId}`
    if (this.cache && this.cache.key === key && this.cache.scene === scene)
      return this.cache.result
    const result = this.compute(scene, token, cell, levelId)
    this.cache = { key, scene, result }
    return result
  }

  private compute(
    scene: SceneLike,
    token: Token,
    cell: Cell,
    preferred: Id
  ): PlannedMove {
    const start = this.startStep(token)
    const base = { tokenId: token.id, distance: 0 }
    if (
      start.cell.i === cell.i &&
      start.cell.j === cell.j &&
      start.levelId === preferred
    ) {
      return { ...base, target: start, path: null, reason: "same-cell" }
    }
    const world = this.occlusion()
    if (!world)
      return {
        ...base,
        target: { cell, levelId: preferred },
        path: null,
        reason: "unreachable",
      }
    const centre = anchorPosition(scene, token.size, cell)
    const k = footprintCells(token.size)
    const g = groundIndex(scene)
    // Runs whose top edge the drop lies just beyond: from the preferred level, and from the token's
    // own level (its view may already be upstairs while it stands on the top rows).
    const runs = runsBelowTop(scene, [preferred, token.levelId], cell, k)
    // Levels to path to, in order; `run`: a blind crossing of that run onto an unexplored landing.
    const attempts: Array<{ levelId: Id; run: RunBelowTop | null }> = []
    const seen = new Set<Id>()
    const tryLevel = (levelId: Id) => {
      if (seen.has(levelId) || !g.hasGroundAt(levelId, centre)) return
      seen.add(levelId)
      attempts.push({ levelId, run: null })
    }
    for (const r of runs) tryLevel(r.connector.toLevelId)
    for (const r of runs) {
      const up = r.connector.toLevelId
      if (seen.has(up) || !this.landingUnexplored(up, cell, k)) continue
      attempts.push({ levelId: up, run: r })
    }
    for (const id of this.candidateLevels(scene, preferred, centre))
      tryLevel(id)
    if (attempts.length === 0)
      return {
        ...base,
        target: { cell, levelId: preferred },
        path: null,
        reason: "no-ground",
      }
    for (const a of attempts) {
      const target: PathStep = {
        cell: { i: cell.i, j: cell.j },
        levelId: a.levelId,
      }
      if (a.run) {
        const blind = this.blindCrossing(
          scene,
          world,
          token,
          start,
          a.run,
          target
        )
        if (blind) return { ...base, target, ...blind, reason: null }
        continue
      }
      if (
        a.levelId === start.levelId &&
        cell.i === start.cell.i &&
        cell.j === start.cell.j
      )
        continue
      const path = findPath(scene, world, token, target, {
        maxSteps: this.maxSteps,
        nodeLimit: this.nodeLimit,
      })
      if (path && path.length > 1) {
        const v = validateMove(scene, world, token, path, {
          enforceSpeed: false,
          maxSteps: this.maxSteps,
        })
        return { ...base, target, path, distance: v.distance, reason: null }
      }
    }
    return {
      ...base,
      target: { cell, levelId: attempts[0].levelId },
      path: null,
      reason: "unreachable",
    }
  }

  /** Some footprint cell of a landing is unexplored by this client (blind landings enabled). */
  private landingUnexplored(levelId: Id, cell: Cell, k: number): boolean {
    const unexplored = this.unexplored
    if (!unexplored) return false
    for (let dj = 0; dj < k; dj++)
      for (let di = 0; di < k; di++)
        if (unexplored(levelId, { i: cell.i + di, j: cell.j + dj })) return true
    return false
  }

  /**
   * A path up `run` to its top row, plus the step across the top edge onto the unexplored landing
   * `target`. Everything the client knows must be legal; the landing's ground is left to the host.
   */
  private blindCrossing(
    scene: SceneLike,
    world: OcclusionWorld,
    token: Token,
    start: PathStep,
    run: RunBelowTop,
    target: PathStep
  ): { path: PathStep[]; distance: number } | null {
    const top: PathStep = { cell: run.lower, levelId: run.connector.levelId }
    const prefix =
      top.levelId === start.levelId &&
      top.cell.i === start.cell.i &&
      top.cell.j === start.cell.j
        ? [start]
        : findPath(scene, world, token, top, {
            maxSteps: this.maxSteps - 1,
            nodeLimit: this.nodeLimit,
          })
    if (!prefix) return null
    const path = [...prefix, target]
    const v = validateMove(scene, world, token, path, {
      enforceSpeed: false,
      maxSteps: this.maxSteps,
    })
    if (!blindLandingOk(v, path, footprintCells(token.size), this.unexplored))
      return null
    // The crossing is one orthogonal step.
    return {
      path,
      distance: v.ok ? v.distance : v.distance + scene.grid.cellSize,
    }
  }

  /**
   * The preferred level (if it has ground at `p`), then other levels with ground there, nearest
   * elevation first.
   */
  private candidateLevels(
    scene: SceneLike,
    preferred: Id,
    p: { x: number; z: number }
  ): Id[] {
    const pref = levelById(scene, preferred)
    const g = groundIndex(scene)
    const out: Id[] = []
    if (pref && g.hasGroundAt(preferred, p)) out.push(preferred)
    const others = sortedLevels(scene)
      .filter((l) => l.id !== preferred && g.hasGroundAt(l.id, p))
      .sort(
        (a, b) =>
          Math.abs(a.elevation - (pref?.elevation ?? 0)) -
          Math.abs(b.elevation - (pref?.elevation ?? 0))
      )
    for (const l of others) out.push(l.id)
    return out
  }

  /** The token's current step (anchor + level). */
  startStep(token: Token): PathStep {
    return {
      cell: tokenAnchor(
        this.scene ?? {
          grid: {
            cellSize: 5,
            width: 1,
            depth: 1,
            diagonalRule: "5-5-5",
            visionOrigin: "square",
          },
        },
        token
      ),
      levelId: token.levelId,
    }
  }

  /**
   * A plausible route for a token seen moving from `from` to `to` (Engine.setTokenRouter: animating a
   * move whose path this client did not send): A* over this client's scene, through footprint centres,
   * or string-pulled (core smoothPath) when `to` is off the grid. null when no route is found.
   */
  route(tokenId: Id, from: MotionPoint, to: MotionPoint): MotionPoint[] | null {
    const scene = this.scene
    const token = this.token(tokenId)
    const world = this.occlusion()
    if (
      !scene ||
      !token ||
      !world ||
      !levelById(scene, from.levelId) ||
      !levelById(scene, to.levelId)
    )
      return null
    const walker: Token = {
      ...token,
      levelId: from.levelId,
      position: { ...from.position },
    }
    const cell = anchorOf(scene.grid, token.size, to.position)
    const path = findPath(
      scene,
      world,
      walker,
      { cell, levelId: to.levelId },
      { maxSteps: this.maxSteps, nodeLimit: ROUTE_NODE_LIMIT }
    )
    if (!path) return null
    const centre = anchorPosition(scene, token.size, cell)
    const onGrid =
      Math.abs(centre.x - to.position.x) < 1e-3 &&
      Math.abs(centre.z - to.position.z) < 1e-3
    if (!onGrid) return smoothPath(scene, world, walker, path, to.position)
    const out: MotionPoint[] = path.map((s) => ({
      levelId: s.levelId,
      position: anchorPosition(scene, token.size, s.cell),
    }))
    out[0] = { levelId: from.levelId, position: { ...from.position } }
    return out
  }

  /** Validate an explicit path (ladder climbs, re-sends). */
  validate(
    tokenId: Id,
    path: PathStep[]
  ): { ok: boolean; reason?: MoveRejectReason; legalSteps: number } {
    const scene = this.scene
    const token = this.token(tokenId)
    const world = this.occlusion()
    if (!scene || !token || !world)
      return { ok: false, reason: "unknown-token", legalSteps: 0 }
    const v = validateMove(scene, world, token, path, {
      enforceSpeed: false,
      maxSteps: this.maxSteps,
    })
    return { ok: v.ok, reason: v.reason, legalSteps: v.legalSteps }
  }
}

/** A stairs/ramp run whose top edge a drop lies just beyond, and the top-row anchor below it. */
export interface RunBelowTop {
  connector: ConnectorObject
  /** Anchor of the footprint on the run's top row (on the run's lower level). */
  lower: Cell
}

/**
 * Stairs/ramps on any of `levelIds` whose top edge a k × k footprint anchored at `cell` sits just
 * beyond (the cell an orthogonal step across the top edge lands on: core crossingFor's test), in
 * object-id order, one per upper level.
 */
export function runsBelowTop(
  scene: SceneLike,
  levelIds: readonly Id[],
  cell: Cell,
  k: number
): RunBelowTop[] {
  const out: RunBelowTop[] = []
  for (const id of Object.keys(scene.objects).sort()) {
    const o = scene.objects[id]
    if (o.type !== "connector" || o.style === "ladder") continue
    if (!levelIds.includes(o.levelId) || !levelById(scene, o.toLevelId))
      continue
    if (out.some((r) => r.connector.toLevelId === o.toLevelId)) continue
    const sp = connectorSpan(o, scene.grid.cellSize)
    if (!sp) continue
    const lower = { i: cell.i - sp.fwd.i, j: cell.j - sp.fwd.j }
    if (
      footprintWithinLateral(sp, lower, k) &&
      footprintAlong(sp, lower, k).hi === sp.top
    )
      out.push({ connector: o, lower })
  }
  return out
}

/**
 * `toLevelId`s of the stairs/ramps on `levelId` whose top edge a k × k footprint anchored at `cell`
 * sits just beyond, in object-id order.
 */
export function upLevelsBeyondTop(
  scene: SceneLike,
  levelId: Id,
  cell: Cell,
  k: number
): Id[] {
  return runsBelowTop(scene, [levelId], cell, k).map(
    (r) => r.connector.toLevelId
  )
}

/**
 * Whether a path may be sent although the client could not validate all of it: it is fully legal, or
 * its only fault is missing ground at its final step, a level change onto a landing with a footprint
 * cell this client has not explored (`unexplored`; without it, only legal paths pass). The host knows
 * the floor there and validates the move.
 */
export function blindLandingOk(
  v: MoveValidation,
  path: readonly PathStep[],
  k: number,
  unexplored?: (levelId: Id, cell: Cell) => boolean
): boolean {
  if (v.ok) return true
  if (!unexplored || v.reason !== "no-ground") return false
  if (path.length < 2 || v.failedAt !== path.length - 1) return false
  const a = path[path.length - 2]
  const b = path[path.length - 1]
  if (a.levelId === b.levelId) return false
  for (let dj = 0; dj < k; dj++)
    for (let di = 0; di < k; di++)
      if (unexplored(b.levelId, { i: b.cell.i + di, j: b.cell.j + dj }))
        return true
  return false
}

/**
 * Whether a player has never explored any part of a cell of a level, i.e. its floor is unknown to
 * the client (the `PlannerOptions.unexplored` / `blindLandingOk` test for players). No mask = nothing
 * explored.
 */
export function unexploredIn(
  view: Pick<PlayerView, "masks"> | null,
  levelId: Id,
  cell: Cell
): boolean {
  const m =
    view && Object.hasOwn(view.masks, levelId) ? view.masks[levelId] : null
  return !m || !exploredTouched(decodeMaskCached(m.explored), cell.i, cell.j)
}
