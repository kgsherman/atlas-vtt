/**
 * Host persistence scheduling (ARCHITECTURE §6.3): `save_session_state` throttled to ~5 s (plus
 * "urgent" saves right after DM commands that reduce what players may see, and "soon" saves ~1 s after
 * token moves so a reloaded host tab resumes where the tokens were), and `upsert_player_view`
 * throttled to ≤ 5 s per player for ordinary changes, but "soon" (~1 s) when the player's own tokens
 * were assigned or moved or their exploration grew (a reload while the DM is away shows that row), and
 * awaited before `snapshot_ready`.
 *
 * `ThrottledTask` coalesces requests: at most one run in flight, never two runs closer than the
 * interval (urgent requests: the minimum gap), and a request during a run schedules exactly one
 * follow-up run. Each run reads the CURRENT data when it starts, so coalescing never loses the latest
 * revision. Failures of scheduled runs go to `onError` (the host decides: stand down on a fencing
 * error, retry otherwise); `flush()` rethrows so callers can report them.
 */
import { isNetError } from "../supabase"

export interface ThrottledTaskOptions {
  run: () => Promise<void>
  intervalMs: number
  /** Minimum gap between runs for urgent requests (default: intervalMs). */
  urgentGapMs?: number
  /** Gap for "soon" requests, between urgent and normal (default: urgentGapMs). */
  soonGapMs?: number
  onError: (err: unknown) => void
  now?: () => number
  /** Retry delay after a failed scheduled run (default: intervalMs). */
  retryMs?: number
  /** Timer source (default: the global timers). */
  timers?: { setTimeout(fn: () => void, ms: number): number; clearTimeout(handle: number): void }
}

const globalTimers = {
  setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (h: number) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
}

export class ThrottledTask {
  private readonly o: Required<ThrottledTaskOptions>
  private dirty = false
  /** 0 normal, 1 soon, 2 urgent (the most pressing request since the last run). */
  private urgency = 0
  private running: Promise<void> | null = null
  private timer: number | null = null
  private timerDue = Infinity
  private lastRunAt = -Infinity
  private cancelled = false

  constructor(opts: ThrottledTaskOptions) {
    this.o = {
      run: opts.run,
      intervalMs: opts.intervalMs,
      urgentGapMs: opts.urgentGapMs ?? opts.intervalMs,
      soonGapMs: opts.soonGapMs ?? opts.urgentGapMs ?? opts.intervalMs,
      onError: opts.onError,
      now: opts.now ?? (() => Date.now()),
      retryMs: opts.retryMs ?? opts.intervalMs,
      timers: opts.timers ?? globalTimers,
    }
  }

  get pending(): boolean {
    return this.dirty
  }

  get busy(): boolean {
    return this.running !== null
  }

  /**
   * Ask for a run (throttled). `urgent` (true) shortens the wait to the minimum gap; "soon" to the
   * gameplay gap (e.g. token moves: a reload of the host tab loses at most that much).
   */
  request(urgent: boolean | "soon" = false): void {
    if (this.cancelled) return
    this.dirty = true
    this.urgency = Math.max(this.urgency, urgent === true ? 2 : urgent === "soon" ? 1 : 0)
    this.schedule()
  }

  /** Run now if anything is pending (or `force`), after any run in flight. Rethrows the run's error. */
  async flush(force = false): Promise<void> {
    if (this.cancelled) return
    this.clearTimer()
    if (this.running) {
      try {
        await this.running
      } catch {
        // reported through onError already
      }
    }
    if (this.cancelled || (!this.dirty && !force)) return
    await this.start(true)
  }

  /** Drop pending work and timers (a run in flight completes on its own). */
  cancel(): void {
    this.cancelled = true
    this.dirty = false
    this.clearTimer()
  }

  private clearTimer(): void {
    if (this.timer !== null) this.o.timers.clearTimeout(this.timer)
    this.timer = null
    this.timerDue = Infinity
  }

  private schedule(delayOverride?: number): void {
    if (this.cancelled || !this.dirty || this.running) return
    const now = this.o.now()
    const gap = this.urgency === 2 ? this.o.urgentGapMs : this.urgency === 1 ? this.o.soonGapMs : this.o.intervalMs
    const due = delayOverride !== undefined ? now + delayOverride : Math.max(now, this.lastRunAt + gap)
    if (this.timer !== null && this.timerDue <= due) return
    this.clearTimer()
    this.timerDue = due
    this.timer = this.o.timers.setTimeout(
      () => {
        this.timer = null
        this.timerDue = Infinity
        void this.start(false).catch(() => {})
      },
      Math.max(0, due - now)
    )
  }

  private start(rethrow: boolean): Promise<void> {
    this.dirty = false
    this.urgency = 0
    this.lastRunAt = this.o.now()
    let failed = false
    const p = (async () => {
      try {
        await this.o.run()
      } catch (err) {
        failed = true
        this.o.onError(err)
        // Retry later unless the owner cancelled us in onError (fencing failure).
        if (!this.cancelled) this.dirty = true
        if (rethrow) throw err
      }
    })()
    this.running = p
    const done = () => {
      if (this.running === p) this.running = null
      if (failed) this.schedule(this.o.retryMs)
      else this.schedule()
    }
    p.then(done, done)
    return p
  }
}

/** Errors after which this tab must stop hosting (another host claimed the session, or it ended). */
export function fencingFailure(err: unknown): "stale" | "ended" | null {
  if (isNetError(err, "stale_epoch")) return "stale"
  if (isNetError(err, "session_ended")) return "ended"
  return null
}
