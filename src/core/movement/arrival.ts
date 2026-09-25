/**
 * Where tokens arriving together land (a map change that brings the party along, docs/ARCHITECTURE.md
 * §6.7): each token gets an anchor it could jump to (grounded, clear of movement blockers: checkJump's
 * rule) whose footprint no earlier arrival and no visible token already holds. The search starts from the
 * standable anchor nearest the arrival point and spreads over legal steps, so the party stays together on
 * the arrival's side of walls; only when that region is full does it take the nearest free anchor anywhere
 * on the level. Deterministic: the same scene, tokens and point always give the same anchors.
 */
import type { OcclusionWorld } from "../occlusion/types"
import { groundIndex, levelById, tokenRect, type GroundIndex } from "../scene/queries"
import type { Cell, Id, SceneLike, Token } from "../scene/types"
import { MoveContext } from "./context"
import { anchorCenter, anchorOf, footprintCells } from "./footprint"
import { jumpReason } from "./free"
import { checkStep, NEIGHBOURS } from "./rules"

export interface Arrival {
  levelId: Id
  x: number
  z: number
}

/** Anchors visited by the step search per token (a whole 200 × 200 level is 40 000). */
export const ARRIVAL_NODE_LIMIT = 6000

export interface ArrivalOptions {
  /** Tokens already standing on the map whose squares arrivals avoid (hidden ones are ignored: nothing reveals them). */
  standing?: readonly Pick<Token, "levelId" | "position" | "size" | "hidden">[]
  nodeLimit?: number
}

type Arriving = Pick<Token, "id" | "size" | "height" | "hidden">

const cellKey = (i: number, j: number) => `${i},${j}`

/** Order of placement: visible tokens first (a hidden one never pushes a visible one aside), larger first, then by id. */
export function arrivalOrder<T extends Arriving>(tokens: readonly T[]): T[] {
  return [...tokens].sort(
    (a, b) =>
      Number(a.hidden === true) - Number(b.hidden === true) || footprintCells(b.size) - footprintCells(a.size) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

/**
 * Anchors for `tokens` arriving at `arrival` in `scene` (tested in `world`, its occlusion world), in
 * arrivalOrder. A token with no room anywhere on the level is missing from the result.
 */
export function arrivalAnchors(
  scene: SceneLike,
  world: OcclusionWorld,
  tokens: readonly Arriving[],
  arrival: Arrival,
  opts: ArrivalOptions = {}
): Map<Id, Cell> {
  const out = new Map<Id, Cell>()
  if (!levelById(scene, arrival.levelId) || !Number.isFinite(arrival.x) || !Number.isFinite(arrival.z)) return out
  const grid = scene.grid
  const cs = grid.cellSize
  const levelId = arrival.levelId
  const ground = groundIndex(scene)
  const limit = opts.nodeLimit ?? ARRIVAL_NODE_LIMIT
  // Squares taken: visible standing tokens on the arrival level (off-grid ones by the squares they overlap).
  const occupied = new Set<string>()
  const eps = 1e-6
  for (const t of opts.standing ?? []) {
    if (t.hidden || t.levelId !== levelId) continue
    const r = tokenRect(scene, t)
    for (let j = Math.floor((r.z + eps) / cs); j <= Math.ceil((r.z + r.d - eps) / cs) - 1; j++)
      for (let i = Math.floor((r.x + eps) / cs); i <= Math.ceil((r.x + r.w - eps) / cs) - 1; i++) occupied.add(cellKey(i, j))
  }
  const contexts = new Map<string, MoveContext>()
  for (const t of arrivalOrder(tokens)) {
    const profile = `${t.size}|${t.height}`
    let ctx = contexts.get(profile)
    if (!ctx) contexts.set(profile, (ctx = new MoveContext(scene, world, t)))
    const anchor = placeOne(ctx, ground, levelId, arrival, occupied, limit)
    if (!anchor) continue
    out.set(t.id, anchor)
    for (let dj = 0; dj < ctx.k; dj++) for (let di = 0; di < ctx.k; di++) occupied.add(cellKey(anchor.i + di, anchor.j + dj))
  }
  return out
}

function placeOne(ctx: MoveContext, ground: GroundIndex, levelId: Id, arrival: Arrival, occupied: ReadonlySet<string>, limit: number): Cell | null {
  const grid = ctx.grid
  const k = ctx.k
  const stands = new Map<string, boolean>()
  const standable = (a: Cell): boolean => {
    const key = cellKey(a.i, a.j)
    let v = stands.get(key)
    if (v === undefined) stands.set(key, (v = ctx.inBounds(a) && jumpReason(ctx, ground, levelId, anchorCenter(grid, ctx.size, a)) === null))
    return v
  }
  const free = (a: Cell): boolean => {
    for (let dj = 0; dj < k; dj++) for (let di = 0; di < k; di++) if (occupied.has(cellKey(a.i + di, a.j + dj))) return false
    return true
  }
  const seed = nearest(ctx, arrival, standable)
  if (!seed) return null
  // Breadth-first over legal steps from the seed: the first free, standable anchor.
  const seen = new Set<string>([cellKey(seed.i, seed.j)])
  const queue: Cell[] = [seed]
  for (let head = 0; head < queue.length && head < limit; head++) {
    const a = queue[head]
    if (standable(a) && free(a)) return a
    for (const d of NEIGHBOURS) {
      const b = { i: a.i + d.i, j: a.j + d.j }
      const key = cellKey(b.i, b.j)
      if (seen.has(key) || !ctx.inBounds(b)) continue
      seen.add(key)
      if (checkStep(ctx, { cell: a, levelId }, { cell: b, levelId }) === null) queue.push(b)
    }
  }
  // The region is full (or too large to search): the nearest free, standable anchor anywhere on the level.
  return nearest(ctx, arrival, (a) => free(a) && standable(a))
}

/** The anchor nearest the arrival point passing `accept`: ring by ring outward, the closest centre of the first ring with one (ties: j, then i). */
function nearest(ctx: MoveContext, arrival: Arrival, accept: (a: Cell) => boolean): Cell | null {
  const grid = ctx.grid
  const start = anchorOf(grid, ctx.size, { x: arrival.x, z: arrival.z })
  const maxI = grid.width - ctx.k
  const maxJ = grid.depth - ctx.k
  if (maxI < 0 || maxJ < 0) return null
  const c = { i: Math.min(maxI, Math.max(0, start.i)), j: Math.min(maxJ, Math.max(0, start.j)) }
  const rings = Math.max(c.i, maxI - c.i, c.j, maxJ - c.j)
  for (let r = 0; r <= rings; r++) {
    let best: Cell | null = null
    let bestD = Infinity
    for (let j = c.j - r; j <= c.j + r; j++) {
      if (j < 0 || j > maxJ) continue
      const edge = j === c.j - r || j === c.j + r
      for (let i = c.i - r; i <= c.i + r; i += edge ? 1 : 2 * r) {
        if (i < 0 || i > maxI) continue
        const a = { i, j }
        if (!accept(a)) continue
        const p = anchorCenter(grid, ctx.size, a)
        const d = (p.x - arrival.x) ** 2 + (p.z - arrival.z) ** 2
        if (d < bestD - 1e-9) {
          best = a
          bestD = d
        }
      }
    }
    if (best) return best
  }
  return null
}
