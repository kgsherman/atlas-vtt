/**
 * Routes moved tokens walk along (Engine.setTokenRouter, ARCHITECTURE §8 "Token moves"): the route this
 * client sent a move along when the host's answer lands the token on it (the whole route, or up to
 * where the host stopped it), else a route the client's planner reconstructs from what it knows. The
 * host never sends paths: another player's token, or a move the DM made, is animated along the
 * client's own guess.
 */
import type { MotionPoint } from "@/core/movement"
import type { Id } from "@/core/scene/types"
import type { TokenRouter } from "@/render/contracts"

import type { MovePlanner } from "./planner"

/** Sent routes older than this are forgotten (the host answers well within it). */
const SENT_ROUTE_TTL_MS = 15_000

const samePoint = (a: MotionPoint, b: MotionPoint) =>
  a.levelId === b.levelId &&
  Math.abs(a.position.x - b.position.x) < 1e-3 &&
  Math.abs(a.position.z - b.position.z) < 1e-3

/** The routes of this client's own moves, by token. */
export class SentRoutes {
  private readonly routes = new Map<Id, { points: MotionPoint[]; at: number }>()
  private readonly now: () => number

  constructor(now: () => number = () => Date.now()) {
    this.now = now
  }

  remember(tokenId: Id, points: readonly MotionPoint[]): void {
    this.routes.set(tokenId, { points: [...points], at: this.now() })
  }

  /** The sent route from `from` to its point `to` (used once), or null when `to` is not on it. */
  take(tokenId: Id, from: MotionPoint, to: MotionPoint): MotionPoint[] | null {
    const r = this.routes.get(tokenId)
    if (!r) return null
    if (this.now() - r.at > SENT_ROUTE_TTL_MS) {
      this.routes.delete(tokenId)
      return null
    }
    for (let k = r.points.length - 1; k >= 1; k--) {
      if (!samePoint(r.points[k], to)) continue
      this.routes.delete(tokenId)
      return [from, ...r.points.slice(1, k + 1)]
    }
    return null
  }
}

/** The page's token router: sent routes first, then the planner's reconstruction. */
export function tokenRouter(
  planner: MovePlanner,
  sent: SentRoutes | null = null
): TokenRouter {
  return (tokenId, from, to) =>
    sent?.take(tokenId, from, to) ?? planner.route(tokenId, from, to)
}
