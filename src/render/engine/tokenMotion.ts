/**
 * Token move animation (engine/tokens.ts): when a token's position changes, it walks from where it is
 * drawn to its new position along a route (Engine.setTokenRouter: the path it was sent along, or one
 * the page reconstructs), or glides straight over short distances on one level. Constant speed with
 * short eased starts and stops; long routes are sped up so no walk takes more than MAX_DURATION.
 */
import type { MotionPoint } from "@/core/movement"
import type { Id } from "@/core/scene/types"

/** Walking speed of an animated token (feet per second). */
export const MOTION_SPEED = 30
/** Shortest and longest walk (seconds). */
export const MIN_DURATION = 0.16
export const MAX_DURATION = 2.4
/** Time spent accelerating and decelerating (seconds, each). */
const RAMP = 0.12
/** Without a route, straight glides only up to this distance (feet); farther moves jump. */
export const MAX_GLIDE = 40
/** Routes longer than this (feet) are not animated. */
const MAX_ROUTE = 600

export interface TokenMotion {
  points: MotionPoint[]
  /** Cumulative length at each point. */
  cum: number[]
  length: number
  start: number
  /** Milliseconds. */
  duration: number
}

const dist = (a: MotionPoint, b: MotionPoint) => Math.hypot(b.position.x - a.position.x, b.position.z - a.position.z)
const samePoint = (a: MotionPoint, b: MotionPoint) => a.levelId === b.levelId && dist(a, b) < 1e-3

/**
 * The walk from `from` to `to` starting at `now` (ms), along `route` when given (its first point is
 * replaced by `from`, its last must be `to`), else a straight glide; null = jump (no animation).
 */
export function planMotion(from: MotionPoint, to: MotionPoint, route: readonly MotionPoint[] | null, now: number): TokenMotion | null {
  if (samePoint(from, to)) return null
  let points: MotionPoint[]
  if (route && route.length >= 2 && samePoint(route[route.length - 1], to)) {
    points = [from, ...route.slice(1)]
  } else if (from.levelId === to.levelId && dist(from, to) <= MAX_GLIDE) {
    points = [from, to]
  } else return null
  const cum = [0]
  for (let k = 1; k < points.length; k++) cum.push(cum[k - 1] + dist(points[k - 1], points[k]))
  const length = cum[cum.length - 1]
  if (length > MAX_ROUTE || (length < 1e-3 && points.every((p) => p.levelId === from.levelId))) return null
  const duration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, length / MOTION_SPEED)) * 1000
  return { points, cum, length, start: now, duration }
}

/**
 * Fraction of the way travelled at time fraction u ∈ [0, 1]: a trapezoidal speed profile ramping up
 * over the first `a` and down over the last `a` of the time.
 */
export function travel(u: number, a: number): number {
  const t = Math.min(1, Math.max(0, u))
  const r = Math.min(0.5, Math.max(1e-6, a))
  const vmax = 1 / (1 - r)
  if (t < r) return (0.5 * vmax * t * t) / r
  if (t > 1 - r) return 1 - (0.5 * vmax * (1 - t) * (1 - t)) / r
  return vmax * (t - r / 2)
}

/**
 * Where a walking token is drawn at `now` (ms). A level change happens halfway along its segment
 * (at once for a ladder, whose segment has no length). `done` once the walk is over.
 */
export function motionAt(m: TokenMotion, now: number): { levelId: Id; x: number; z: number; done: boolean } {
  const u = (now - m.start) / m.duration
  const last = m.points[m.points.length - 1]
  if (u >= 1) return { levelId: last.levelId, x: last.position.x, z: last.position.z, done: true }
  const s = travel(u, (RAMP * 1000) / m.duration) * m.length
  let k = 1
  while (k < m.points.length - 1 && m.cum[k] < s) k++
  const a = m.points[k - 1]
  const b = m.points[k]
  const seg = m.cum[k] - m.cum[k - 1]
  const f = seg > 1e-9 ? Math.min(1, Math.max(0, (s - m.cum[k - 1]) / seg)) : 1
  return {
    levelId: f >= 0.5 ? b.levelId : a.levelId,
    x: a.position.x + (b.position.x - a.position.x) * f,
    z: a.position.z + (b.position.z - a.position.z) * f,
    done: false,
  }
}
