/**
 * Shadow / line-of-sight tile update scheduling (ARCHITECTURE §4.2, PERFORMANCE §3).
 *
 * Priority classes, highest first:
 *   0. forced: the locally controlled/selected viewer's tile — always updated, even over budget;
 *   1. sources that moved or changed radius, and sources that have never been captured (they are not
 *      drawn at all until captured), on-screen coverage descending;
 *   2. dirty viewer tiles;
 *   3. dirty on-screen lights by coverage;
 *   4. the rest (dirty off-screen lights).
 * The per-frame budget is SHADOW_UPDATES_PER_FRAME tiles AND ~2 ms of CPU submission time.
 */

export const SHADOW_UPDATES_PER_FRAME = 4
export const SHADOW_UPDATE_MS = 2

export interface TileUpdateRequest {
  /** Tile owner key ("light:<id>" / "viewer:<id>"). */
  key: string
  kind: "light" | "viewer"
  /** Updated even when the budget is exhausted (still only when moved / uncaptured / dirty). */
  forced: boolean
  /** Source moved / radius changed since the tile's capture. */
  moved: boolean
  /** No valid capture exists yet. */
  uncaptured: boolean
  /** Invalidated by an occluder change (dirty region ∩ capture sphere). */
  dirty: boolean
  /** Screen coverage estimate in [0, 1] (0 = off screen). */
  coverage: number
}

export function priorityClass(r: TileUpdateRequest): number {
  if (r.forced) return 0
  if (r.moved || r.uncaptured) return 1
  if (r.kind === "viewer") return 2
  if (r.coverage > 0) return 3
  return 4
}

/** Requests that need work, highest priority first (stable: ties broken by coverage then key). */
export function orderTileUpdates(requests: TileUpdateRequest[]): TileUpdateRequest[] {
  return requests
    .filter((r) => r.moved || r.uncaptured || r.dirty)
    .map((r) => ({ r, c: priorityClass(r) }))
    .sort((a, b) => a.c - b.c || b.r.coverage - a.r.coverage || (a.r.key < b.r.key ? -1 : a.r.key > b.r.key ? 1 : 0))
    .map((x) => x.r)
}

export interface UpdateBudget {
  maxTiles: number
  maxMs: number
}

export interface UpdateRunResult {
  updated: string[]
  deferred: string[]
  elapsedMs: number
}

/**
 * Run `update` for ordered requests until the budget is spent. Forced requests always run; the budget
 * check happens before each non-forced update, so one update may overshoot the time cap.
 */
export function runTileUpdates(
  ordered: TileUpdateRequest[],
  budget: UpdateBudget,
  update: (r: TileUpdateRequest) => void,
  now: () => number
): UpdateRunResult {
  const start = now()
  const updated: string[] = []
  const deferred: string[] = []
  let count = 0
  for (const r of ordered) {
    if (!r.forced && (count >= budget.maxTiles || now() - start >= budget.maxMs)) {
      deferred.push(r.key)
      continue
    }
    update(r)
    updated.push(r.key)
    count++
  }
  return { updated, deferred, elapsedMs: now() - start }
}
