/**
 * Per-level throttle for the costly work terrain previews trigger (wall / door rebuilds, the lighting
 * system's terrain occluders). The first update of a level runs at once. Later ones mark the level due,
 * and their dirty rects accumulate. The work runs again only after the previous run ENDED plus
 * max(interval, costFactor × its cost), so however slow a run is it takes at most about
 * 1 / (costFactor + 1) of the main thread. The engine's frame loop runs what is still due (flush), so the
 * last update of a gesture is always applied.
 */
import { unionRect } from "@/core/scene/heightmapBrush"
import type { Id, Rect } from "@/core/scene/types"

interface LevelState {
  /** Earliest start of the next run (clock ms). */
  next: number
  /** Updates arrived since the last run. */
  due: boolean
  /** Union of their dirty rects (null: everywhere). Meaningful only while due. */
  dirty: Rect | null
}

export class PreviewThrottle {
  readonly interval: number
  readonly costFactor: number
  private readonly clock: () => number
  private readonly levels = new Map<Id, LevelState>()

  /** `clock`: milliseconds (default performance.now). */
  constructor(interval: number, costFactor: number, clock: () => number = () => performance.now()) {
    this.interval = interval
    this.costFactor = costFactor
    this.clock = clock
  }

  /** A preview update of a level over `dirty` (null: everywhere): runs `work` now if the level is ready, else marks it due. */
  push(levelId: Id, dirty: Rect | null, work: (dirty: Rect | null) => void): void {
    let st = this.levels.get(levelId)
    if (!st) this.levels.set(levelId, (st = { next: -Infinity, due: false, dirty: null }))
    st.dirty = st.due ? st.dirty && dirty && unionRect(st.dirty, dirty) : dirty
    st.due = true
    if (this.clock() >= st.next) this.run(levelId, st, work)
  }

  /** Run the due levels whose wait is over (per frame). */
  flush(work: (levelId: Id, dirty: Rect | null) => void): void {
    if (this.levels.size === 0) return
    const now = this.clock()
    for (const [levelId, st] of this.levels) if (st.due && now >= st.next) this.run(levelId, st, (d) => work(levelId, d))
  }

  private run(levelId: Id, st: LevelState, work: (dirty: Rect | null) => void): void {
    const dirty = st.dirty
    st.due = false
    st.dirty = null
    const t0 = this.clock()
    work(dirty)
    const t1 = this.clock()
    // The work may have dropped the level (then there is nothing to wait for).
    if (this.levels.get(levelId) === st) st.next = t1 + Math.max(this.interval, this.costFactor * (t1 - t0))
  }

  /** The level ran or is waiting to run (since the last delete / clear). */
  has(levelId: Id): boolean {
    return this.levels.has(levelId)
  }

  /** Forget a level (its preview ended or was committed); true if it was known. */
  delete(levelId: Id): boolean {
    return this.levels.delete(levelId)
  }

  clear(): void {
    this.levels.clear()
  }
}
