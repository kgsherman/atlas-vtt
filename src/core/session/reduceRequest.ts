/**
 * Player requests on the authoritative GameState (docs/ARCHITECTURE.md §5.3, §6.2). The requester is the
 * {uid} of the request topic, passed in by the host — never a payload field.
 *
 * Moves: ownership is checked before anything is looked up (so players cannot probe for token ids),
 * then locks, then core/movement validates the path; the LEGAL PREFIX is applied ("bump into a wall").
 * Reasons that depend on the world (blocked, corner-cutting, connector rules, no-ground) are reported
 * as "blocked" unless every cell swept by the failing step is perceived by the player. A gridless move
 * (`end`, only while GameState.freeMovement) ends at its exact point once the whole path is legal and the
 * last step's centre reaches it (core/movement checkEnd); otherwise the token stops on the path's legal
 * prefix as usual. Speed limits count the grid path (the end is within half a cell of its last centre).
 *
 * Jumps: the same ownership and lock checks, then core/movement checkJump at the target (snapped to an
 * anchor unless freeMovement); an enforced speed limit counts the straight grid distance.
 *
 * Doors: the door must be in the player's current view and a controlled token on its level must be
 * within one cell of the door segment; movement must not be locked. Every failure is "cannot";
 * "locked" is only reported after those checks pass. Players can never unlock.
 *
 * Table requests (say, roll, initiative, end-turn) go to core/session/table.ts, token-status (a player's
 * own hit points and conditions) to core/session/tokenStatus.ts.
 */
import { distancePointSegment2, segmentIntersection2 } from "../geometry/segment"
import { rulerDistance } from "../grid/grid"
import { anchorPosition, checkEnd, checkJump, footprintCells, tokenAnchor, validateMove } from "../movement"
import { anchorOf } from "../movement/footprint"
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
import { defaultTableContext, reduceTableRequest, type TableContext } from "./table"
import { reduceTokenStatus } from "./tokenStatus"
import type { ClientToHost, GameState, PlayerView, RejectReason, RequestResult } from "./types"

export interface RequestContext {
  /** Occlusion world of the CURRENT state.scene (e.g. the vision engine's world). */
  world: OcclusionWorld
  /** The view last sent to this player (null before the first snapshot). */
  currentView: PlayerView | null
  /** Whether a cell on a level is currently perceived by this player (see perceivedCellLookup). */
  perceivedByPlayer: (levelId: Id, i: number, j: number) => boolean
  /** Time, ids and dice for table requests (default: now, random ids, crypto dice). */
  table?: TableContext
}

/** Requests reduced on the GameState (hellos and pings are handled by the host itself). */
export type StateRequest = Exclude<ClientToHost, { t: "hello" | "ping" }>

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
  if (msg.end && !state.freeMovement) return rejectOutcome(state, msg.reqId, "invalid", msg.tokenId)
  const scene = state.scene
  const v = validateMove(scene, ctx.world, token, msg.path, { enforceSpeed: state.enforceSpeed })
  const result: RequestResult = { reqId: msg.reqId, ok: v.ok, applied: v.legalSteps }
  if (!v.ok) result.reason = maskReason(v.reason ?? "blocked", msg.path, v.failedAt, token, ctx)
  // Gridless end point: only after the whole path.
  let end: Vec2 | null = null
  if (v.ok && msg.end) {
    const last = msg.path[msg.path.length - 1]
    const from = msg.path.length > 1 ? anchorPosition(scene, token.size, last.cell) : token.position
    const reason = checkEnd(scene, ctx.world, token, last, from, msg.end)
    if (reason) {
      result.ok = false
      result.reason = maskReason(reason, [last, last], 1, token, ctx)
    } else end = { x: msg.end.x, z: msg.end.z }
  }
  if (v.legalSteps === 0 && !end) {
    return { state, delta: emptyDelta(), dirtyPlayers: [], result, visited: [], tokenId: token.id }
  }
  const visited = (v.legalSteps > 0 ? msg.path.slice(1, v.legalSteps + 1) : msg.path.slice(0, 1)).map((s) => ({
    cell: { i: s.cell.i, j: s.cell.j },
    levelId: s.levelId,
  }))
  const last = visited[visited.length - 1]
  const position = end ?? anchorPosition(scene, token.size, last.cell)
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

function reduceJump(state: GameState, userId: string, msg: Extract<ClientToHost, { t: "jump" }>, ctx: RequestContext): RequestOutcome {
  if (!ownsToken(state, userId, msg.tokenId)) return rejectOutcome(state, msg.reqId, "not-owner")
  const token = tokenExistsForPlayers(state, msg.tokenId)
  if (!token) return rejectOutcome(state, msg.reqId, "unknown-token", msg.tokenId)
  if (movementLockedFor(state, userId)) return rejectOutcome(state, msg.reqId, "movement-locked", msg.tokenId)
  const scene = state.scene
  const target = state.freeMovement ? { x: msg.x, z: msg.z } : anchorPosition(scene, token.size, anchorOf(scene.grid, token.size, { x: msg.x, z: msg.z }))
  const step: PathStep = { cell: anchorOf(scene.grid, token.size, target), levelId: msg.levelId }
  const fail = (reason: MoveRejectReason) => rejectOutcome(state, msg.reqId, maskReason(reason, [step, step], 1, token, ctx), token.id)
  if (state.enforceSpeed && rulerDistance(scene.grid, [token.position, target]) > token.speed + 1e-6) return fail("too-far")
  const reason = checkJump(scene, ctx.world, token, msg.levelId, target)
  if (reason) return fail(reason)
  const moved: Token = { ...token, levelId: msg.levelId, position: target }
  return {
    state: { ...state, scene: { ...scene, tokens: { ...scene.tokens, [token.id]: moved } }, seq: state.seq + 1 },
    delta: { objects: attachedLightIds(scene, token.id), tokens: [token.id], terrain: [], structure: false },
    dirtyPlayers: "all",
    result: { reqId: msg.reqId, ok: true, applied: 1 },
    visited: [step],
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
export function reduceRequest(state: GameState, userId: string, msg: StateRequest, ctx: RequestContext): RequestOutcome {
  switch (msg.t) {
    case "move":
      return reduceMove(state, userId, msg, ctx)
    case "jump":
      return reduceJump(state, userId, msg, ctx)
    case "door":
      return reduceDoor(state, userId, msg, ctx)
    case "say":
    case "roll":
    case "initiative":
    case "end-turn":
      return reduceTableRequest(state, userId, msg, ctx.table ?? defaultTableContext())
    case "token-status":
      return reduceTokenStatus(state, userId, msg)
  }
}
