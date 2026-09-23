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
 * just beyond a stairs/ramp top edge (on the run's lower level) means going up: the run's upper level
 * is tried first there, even when the lower level also has floor at that cell (the usual layout: stairs
 * inside a room). If the landing is blocked, the lower-level path is still found.
 */
import {
  anchorPosition,
  findPath,
  footprintCells,
  MAX_PATH_STEPS,
  tokenAnchor,
  validateMove,
} from "@/core/movement"
import {
  connectorSpan,
  footprintAlong,
  footprintWithinLateral,
} from "@/core/movement/context"
import type { MoveRejectReason, PathStep } from "@/core/movement/types"
import { buildOcclusionWorld } from "@/core/occlusion"
import type { OcclusionWorld } from "@/core/occlusion/types"
import { groundIndex, levelById, sortedLevels } from "@/core/scene/queries"
import type { Cell, Id, SceneLike, Token } from "@/core/scene/types"
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
}

const DEFAULT_NODE_LIMIT = 12_000

export class MovePlanner {
  private scene: SceneLike | null = null
  private world: OcclusionWorld | null = null
  private cache: { key: string; scene: SceneLike; result: PlannedMove } | null =
    null
  private readonly nodeLimit: number
  private readonly maxSteps: number

  constructor(opts: PlannerOptions = {}) {
    this.nodeLimit = opts.nodeLimit ?? DEFAULT_NODE_LIMIT
    this.maxSteps = opts.maxSteps ?? MAX_PATH_STEPS
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
    const levels = this.candidateLevels(
      scene,
      preferred,
      centre,
      cell,
      footprintCells(token.size)
    )
    if (levels.length === 0)
      return {
        ...base,
        target: { cell, levelId: preferred },
        path: null,
        reason: "no-ground",
      }
    for (const levelId of levels) {
      const target: PathStep = { cell: { i: cell.i, j: cell.j }, levelId }
      if (
        levelId === start.levelId &&
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
      target: { cell, levelId: levels[0] },
      path: null,
      reason: "unreachable",
    }
  }

  /**
   * Upper levels of stairs/ramps whose top edge `cell` lies just beyond (from `preferred`, their lower
   * level) first, then the preferred level (if it has ground there), then other levels with ground,
   * nearest elevation first.
   */
  private candidateLevels(
    scene: SceneLike,
    preferred: Id,
    p: { x: number; z: number },
    cell: Cell,
    k: number
  ): Id[] {
    const pref = levelById(scene, preferred)
    const g = groundIndex(scene)
    const out: Id[] = []
    const add = (id: Id) => {
      if (!out.includes(id)) out.push(id)
    }
    for (const id of upLevelsBeyondTop(scene, preferred, cell, k)) {
      if (g.hasGroundAt(id, p)) add(id)
    }
    if (pref && g.hasGroundAt(preferred, p)) add(preferred)
    const others = sortedLevels(scene)
      .filter((l) => l.id !== preferred && g.hasGroundAt(l.id, p))
      .sort(
        (a, b) =>
          Math.abs(a.elevation - (pref?.elevation ?? 0)) -
          Math.abs(b.elevation - (pref?.elevation ?? 0))
      )
    for (const l of others) add(l.id)
    return out
  }

  /** The token's current step (anchor + level). */
  startStep(token: Token): PathStep {
    return {
      cell: tokenAnchor(
        this.scene ?? {
          grid: { cellSize: 5, width: 1, depth: 1, diagonalRule: "5-5-5" },
        },
        token
      ),
      levelId: token.levelId,
    }
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

/**
 * `toLevelId`s of the stairs/ramps on `levelId` whose top edge a k × k footprint anchored at `cell`
 * sits just beyond (the cell an orthogonal step across the top edge lands on: core crossingFor's
 * test), in object-id order.
 */
export function upLevelsBeyondTop(
  scene: SceneLike,
  levelId: Id,
  cell: Cell,
  k: number
): Id[] {
  const out: Id[] = []
  for (const id of Object.keys(scene.objects).sort()) {
    const o = scene.objects[id]
    if (o.type !== "connector" || o.style === "ladder") continue
    if (o.levelId !== levelId || !levelById(scene, o.toLevelId)) continue
    const sp = connectorSpan(o, scene.grid.cellSize)
    if (!sp) continue
    const lower = { i: cell.i - sp.fwd.i, j: cell.j - sp.fwd.j }
    if (
      footprintWithinLateral(sp, lower, k) &&
      footprintAlong(sp, lower, k).hi === sp.top &&
      !out.includes(o.toLevelId)
    )
      out.push(o.toLevelId)
  }
  return out
}
