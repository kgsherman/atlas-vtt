/**
 * Player requests on the authoritative GameState (docs/ARCHITECTURE.md §5.3, §6.2). The requester is the
 * {uid} of the request topic, passed in by the host — never a payload field.
 *
 * Moves: ownership is checked before anything is looked up (so players cannot probe for token ids),
 * then locks, then core/movement validates the path; the LEGAL PREFIX is applied ("bump into a wall").
 * Reasons that depend on the world (blocked, corner-cutting, connector rules, no-ground) are reported
 * as "blocked" unless every cell swept by the failing step is perceived by the player.
 *
 * Doors: the door must be in the player's current view and a controlled token on its level must be
 * within one cell of the door segment; movement must not be locked. Every failure is "cannot";
 * "locked" is only reported after those checks pass. Players can never unlock.
 */
import { distancePointSegment2, segmentIntersection2 } from "../geometry/segment"
import { anchorPosition, footprintCells, tokenAnchor, validateMove } from "../movement"
import type { MoveRejectReason, PathStep } from "../movement/types"
import type { OcclusionWorld } from "../occlusion/types"
import { levelById, openingSegment } from "../scene/queries"
import type { Id, Rect, Token, Vec2 } from "../scene/types"
import {
  attachedLightIds,
  controlledTokenIds,
  emptyDelta,
  movementLockedFor,
  own,
  ownsToken,
  tokenExistsForPlayers,
  type RequestOutcome,
} from "./state"
import type { ClientToHost, GameState, PlayerView, RejectReason, RequestResult } from "./types"

export interface RequestContext {
  /** Occlusion world of the CURRENT state.scene (e.g. the vision engine's world). */
  world: OcclusionWorld
  /** The view last sent to this player (null before the first snapshot). */
  currentView: PlayerView | null
  /** Whether a cell on a level is currently perceived by this player (see perceivedCellLookup). */
  perceivedByPlayer: (levelId: Id, i: number, j: number) => boolean
}

/** Movement reasons that reveal something about the world at the failing step. */
const WORLD_REASONS: ReadonlySet<MoveRejectReason> = new Set(["blocked", "corner-cutting", "connector-edge", "no-connector", "no-ground"])

function rejectOutcome(state: GameState, reqId: string, reason: RejectReason, tokenId: Id | null = null): RequestOutcome {
  return { state, delta: emptyDelta(), dirtyPlayers: [], result: { reqId, ok: false, reason }, visited: [], tokenId }
}

/**
 * The reported reason: world-dependent reasons become "blocked" unless the player perceives every cell
 * of the failing step's sweep (the bounding box of both footprints, on both levels).
 */
function maskReason(reason: MoveRejectReason, path: PathStep[], failedAt: number | undefined, token: Token, ctx: RequestContext): MoveRejectReason {
  if (!WORLD_REASONS.has(reason)) return reason
  if (failedAt === undefined || failedAt < 1 || failedAt >= path.length) return "blocked"
  const a = path[failedAt - 1]
  const b = path[failedAt]
  const k = footprintCells(token.size)
  const i0 = Math.min(a.cell.i, b.cell.i)
  const j0 = Math.min(a.cell.j, b.cell.j)
  const i1 = Math.max(a.cell.i, b.cell.i) + k - 1
  const j1 = Math.max(a.cell.j, b.cell.j) + k - 1
  for (const levelId of new Set([a.levelId, b.levelId])) {
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) if (!ctx.perceivedByPlayer(levelId, i, j)) return "blocked"
    }
  }
  return reason
}

function reduceMove(state: GameState, userId: string, msg: Extract<ClientToHost, { t: "move" }>, ctx: RequestContext): RequestOutcome {
  // Authorise before any lookup: a player learns nothing about tokens it does not own.
  if (!ownsToken(state, userId, msg.tokenId)) return rejectOutcome(state, msg.reqId, "not-owner")
  const token = tokenExistsForPlayers(state, msg.tokenId)
  if (!token) return rejectOutcome(state, msg.reqId, "unknown-token", msg.tokenId)
  if (movementLockedFor(state, userId)) return rejectOutcome(state, msg.reqId, "movement-locked", msg.tokenId)
  const scene = state.scene
  const v = validateMove(scene, ctx.world, token, msg.path, { enforceSpeed: state.enforceSpeed })
  const result: RequestResult = { reqId: msg.reqId, ok: v.ok, applied: v.legalSteps }
  if (!v.ok) result.reason = maskReason(v.reason ?? "blocked", msg.path, v.failedAt, token, ctx)
  if (v.legalSteps === 0) {
    return { state, delta: emptyDelta(), dirtyPlayers: [], result, visited: [], tokenId: token.id }
  }
  const visited = msg.path.slice(1, v.legalSteps + 1).map((s) => ({ cell: { i: s.cell.i, j: s.cell.j }, levelId: s.levelId }))
  const last = visited[visited.length - 1]
  const position = anchorPosition(scene, token.size, last.cell)
  const moved: Token = { ...token, levelId: last.levelId, position }
  const next: GameState = { ...state, scene: { ...scene, tokens: { ...scene.tokens, [token.id]: moved } }, seq: state.seq + 1 }
  return {
    state: next,
    delta: { objects: attachedLightIds(scene, token.id), tokens: [token.id], terrain: [], structure: false },
    dirtyPlayers: "all",
    result,
    visited,
    tokenId: token.id,
  }
}

/** Shortest distance between a segment and an axis-aligned rect (0 when they meet). */
export function segmentRectDistance(a: Vec2, b: Vec2, r: Rect): number {
  const inside = (p: Vec2) => p.x >= r.x && p.x <= r.x + r.w && p.z >= r.z && p.z <= r.z + r.d
  if (inside(a) || inside(b)) return 0
  const corners: Vec2[] = [
    { x: r.x, z: r.z },
    { x: r.x + r.w, z: r.z },
    { x: r.x + r.w, z: r.z + r.d },
    { x: r.x, z: r.z + r.d },
  ]
  for (let k = 0; k < 4; k++) if (segmentIntersection2(a, b, corners[k], corners[(k + 1) % 4])) return 0
  let best = Infinity
  for (const c of corners) best = Math.min(best, distancePointSegment2(c, a, b))
  for (const p of [a, b]) {
    const dx = Math.max(r.x - p.x, 0, p.x - (r.x + r.w))
    const dz = Math.max(r.z - p.z, 0, p.z - (r.z + r.d))
    best = Math.min(best, Math.hypot(dx, dz))
  }
  return best
}

/** The cells a token occupies (its anchored k×k footprint) as a rect. */
function footprintRect(state: GameState, token: Token): Rect {
  const s = state.scene.grid.cellSize
  const k = footprintCells(token.size)
  const anchor = tokenAnchor(state.scene, token)
  return { x: anchor.i * s, z: anchor.j * s, w: k * s, d: k * s }
}

function reduceDoor(state: GameState, userId: string, msg: Extract<ClientToHost, { t: "door" }>, ctx: RequestContext): RequestOutcome {
  const cannot = () => rejectOutcome(state, msg.reqId, "cannot")
  // 1. The door must be in the player's current view (as a door).
  const seen = ctx.currentView && Object.hasOwn(ctx.currentView.objects, msg.doorId) ? ctx.currentView.objects[msg.doorId] : undefined
  if (!seen || seen.type !== "door") return cannot()
  // 2. It must exist for players.
  const door = own(state.scene.objects, msg.doorId)
  if (!door || door.type !== "door" || door.hidden || !levelById(state.scene, door.levelId)) return cannot()
  if (door.style === "secret" && !(own(state.revealed, userId) ?? []).includes(door.id)) return cannot()
  const wall = own(state.scene.objects, door.wallId)
  if (!wall || wall.type !== "wall") return cannot()
  // 3. A controlled token on the door's level within one cell of the door segment.
  const seg = openingSegment(wall, door)
  const reach = state.scene.grid.cellSize + 1e-6
  const near = controlledTokenIds(state, userId).some((id) => {
    const t = state.scene.tokens[id]
    return t.levelId === door.levelId && segmentRectDistance(seg.a, seg.b, footprintRect(state, t)) <= reach
  })
  if (!near) return cannot()
  // 4. Movement must not be locked.
  if (movementLockedFor(state, userId)) return cannot()
  // 5. Locked doors stay locked; closing one is a no-op success.
  const target = msg.action === "open" ? "open" : "closed"
  if (door.state === "locked") {
    if (msg.action === "open") return rejectOutcome(state, msg.reqId, "locked")
    return { state, delta: emptyDelta(), dirtyPlayers: [], result: { reqId: msg.reqId, ok: true }, visited: [], tokenId: null }
  }
  if (door.state === target) {
    return { state, delta: emptyDelta(), dirtyPlayers: [], result: { reqId: msg.reqId, ok: true }, visited: [], tokenId: null }
  }
  const next: GameState = {
    ...state,
    scene: { ...state.scene, objects: { ...state.scene.objects, [door.id]: { ...door, state: target } } },
    seq: state.seq + 1,
  }
  return {
    state: next,
    delta: { ...emptyDelta(), objects: [door.id] },
    dirtyPlayers: "all",
    result: { reqId: msg.reqId, ok: true },
    visited: [],
    tokenId: null,
  }
}

/**
 * Apply an authorised player request. `perceivedByPlayer` reports whether a cell on a level is currently
 * perceived by that player (used to mask rejection reasons).
 */
export function reduceRequest(state: GameState, userId: string, msg: Exclude<ClientToHost, { t: "hello" }>, ctx: RequestContext): RequestOutcome {
  switch (msg.t) {
    case "move":
      return reduceMove(state, userId, msg, ctx)
    case "door":
      return reduceDoor(state, userId, msg, ctx)
  }
}
