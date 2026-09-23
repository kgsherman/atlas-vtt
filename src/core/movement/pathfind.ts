/**
 * A* over legal steps (8 neighbours, ladder switches, stairs top-edge crossings), with step costs per
 * grid.diagonalRule. For "5-10-5" the parity of diagonals taken so far is part of the search state,
 * so the alternating cost is exact. Every edge is validated by the same checkStep as validateMove.
 */
import { stepCost } from "../grid/grid"
import type { Cell, DiagonalRule, GridSettings, Id } from "../scene/types"
import type { MoveContext } from "./context"
import { candidateSteps, checkStep, sameStep } from "./rules"
import type { PathStep } from "./types"

/** Default cap on expanded nodes; searches beyond it return null. */
export const PATH_NODE_LIMIT = 20000

/**
 * Admissible lower bound (feet) of the remaining cost to the target, ignoring obstacles and levels.
 * For 5-10-5 with p = parity of diagonals so far: at least max(dx, dz) steps of one cell, plus one
 * extra cell for every second diagonal among the min(dx, dz) diagonals needed.
 */
export function heuristic(grid: GridSettings, from: Cell, to: Cell, parity: number, rule: DiagonalRule = grid.diagonalRule): number {
  const dx = Math.abs(to.i - from.i)
  const dz = Math.abs(to.j - from.j)
  const hi = Math.max(dx, dz)
  const lo = Math.min(dx, dz)
  const s = grid.cellSize
  switch (rule) {
    case "5-5-5":
      return hi * s
    case "5-10-5":
      return (hi + (parity ? Math.ceil(lo / 2) : Math.floor(lo / 2))) * s
    case "euclidean":
      return (hi - lo + Math.SQRT2 * lo) * s
  }
}

/** Minimal binary heap of node indices ordered by (f, h, insertion). */
class NodeHeap {
  private readonly items: number[] = []
  private readonly f: number[]
  private readonly h: number[]

  constructor(f: number[], h: number[]) {
    this.f = f
    this.h = h
  }

  get size(): number {
    return this.items.length
  }

  private less(a: number, b: number): boolean {
    const fa = this.f[a]
    const fb = this.f[b]
    if (fa !== fb) return fa < fb
    if (this.h[a] !== this.h[b]) return this.h[a] < this.h[b]
    return a < b
  }

  push(n: number): void {
    const items = this.items
    items.push(n)
    let k = items.length - 1
    while (k > 0) {
      const parent = (k - 1) >> 1
      if (!this.less(items[k], items[parent])) break
      ;[items[k], items[parent]] = [items[parent], items[k]]
      k = parent
    }
  }

  pop(): number {
    const items = this.items
    const top = items[0]
    const last = items.pop()!
    if (items.length > 0) {
      items[0] = last
      let k = 0
      for (;;) {
        const l = 2 * k + 1
        const r = l + 1
        let m = k
        if (l < items.length && this.less(items[l], items[m])) m = l
        if (r < items.length && this.less(items[r], items[m])) m = r
        if (m === k) break
        ;[items[k], items[m]] = [items[m], items[k]]
        k = m
      }
    }
    return top
  }
}

export interface SearchOptions {
  maxSteps: number
  nodeLimit: number
}

/**
 * Cheapest legal path from `start` to `target` (both included), or null when the target is
 * unreachable within `maxSteps` steps or `nodeLimit` expansions.
 */
export function searchPath(ctx: MoveContext, start: PathStep, target: PathStep, opts: SearchOptions): PathStep[] | null {
  if (sameStep(start, target)) return [{ cell: { ...start.cell }, levelId: start.levelId }]
  if (!ctx.inBounds(target.cell) || !ctx.footprintGrounded(target.levelId, target.cell)) return null
  const grid = ctx.grid
  const rule = grid.diagonalRule
  const trackParity = rule === "5-10-5"

  // State keys: (level, anchor, parity) with one cell of padding so an out-of-bounds start still has a key.
  const W = grid.width + 2
  const D = grid.depth + 2
  if (start.cell.i < -1 || start.cell.j < -1 || start.cell.i > grid.width || start.cell.j > grid.depth) return null
  const levelIdx = new Map<Id, number>()
  const keyOf = (s: PathStep, parity: number): number => {
    let li = levelIdx.get(s.levelId)
    if (li === undefined) levelIdx.set(s.levelId, (li = levelIdx.size))
    return ((li * D + s.cell.j + 1) * W + s.cell.i + 1) * 2 + parity
  }

  // Node storage (parallel arrays).
  const steps: PathStep[] = []
  const parities: number[] = []
  const g: number[] = []
  const f: number[] = []
  const h: number[] = []
  const depth: number[] = []
  const parent: number[] = []
  const keys: number[] = []
  const best = new Map<number, number>()
  const heap = new NodeHeap(f, h)

  const add = (s: PathStep, parity: number, cost: number, d: number, from: number, key: number) => {
    const n = steps.length
    const hv = heuristic(grid, s.cell, target.cell, parity, rule)
    steps.push(s)
    parities.push(parity)
    g.push(cost)
    h.push(hv)
    f.push(cost + hv)
    depth.push(d)
    parent.push(from)
    keys.push(key)
    best.set(key, cost)
    heap.push(n)
  }

  add(start, 0, 0, 0, -1, keyOf(start, 0))
  let expanded = 0
  while (heap.size > 0) {
    const n = heap.pop()
    if (g[n] > (best.get(keys[n]) ?? Infinity)) continue // stale entry
    const s = steps[n]
    if (sameStep(s, target)) {
      const out: PathStep[] = []
      for (let m = n; m >= 0; m = parent[m]) out.push(steps[m])
      return out.reverse()
    }
    if (++expanded > opts.nodeLimit) return null
    if (depth[n] >= opts.maxSteps) continue
    for (const next of candidateSteps(ctx, s)) {
      const diagonal = next.cell.i !== s.cell.i && next.cell.j !== s.cell.j
      const moved = next.cell.i !== s.cell.i || next.cell.j !== s.cell.j
      const parity = trackParity && diagonal ? parities[n] ^ 1 : parities[n]
      const cost = g[n] + (moved ? stepCost(grid, s.cell, next.cell, parities[n], rule) : 0)
      const key = keyOf(next, parity)
      if ((best.get(key) ?? Infinity) <= cost) continue
      if (checkStep(ctx, s, next) !== null) continue
      add(next, parity, cost, depth[n] + 1, n, key)
    }
  }
  return null
}
