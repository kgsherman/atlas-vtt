/**
 * Frame pacing and quality control (ARCHITECTURE §4.5, §10, PERFORMANCE §7):
 *  - pixel budget: cap physical pixels (~2.1 MP medium, ~1.3 MP low) instead of raw DPR; high / ultra
 *    render at native resolution up to 2× DPR (the budget only guards absurd displays);
 *  - MSAA: never a context attribute (the canvas has none); low renders straight to the canvas without
 *    MSAA, medium / high / ultra render the world into the post pipeline's MSAA half-float target
 *    (render/post/pipeline.ts POST_SETTINGS, samples from MSAA_SAMPLES), so MSAA follows the tier at runtime;
 *  - frame-time window: fps and p95 over the last ~2 s;
 *  - adaptive quality: step down when p95 > 18 ms for 2 s; step up when p95 < 12 ms AND the next tier's
 *    predicted cost (p95 × UP_COST_RATIO) fits a 14 ms budget for 5 s; never above the quality the user
 *    asked for, and never back into a tier that just failed (until the ceiling or the canvas size changes).
 */
import type { Quality } from "../contracts"

export const PIXEL_BUDGET: Record<Quality, number> = {
  low: 1.3e6,
  medium: 2.1e6,
  // Native resolution up to 2× DPR; the budget only guards absurd displays (4K / 5K at 2×).
  high: 8.3e6,
  ultra: 14.8e6,
}

/** Highest render scale per tier (high / ultra: native up to 2× DPR). */
export const MAX_PIXEL_RATIO: Record<Quality, number> = {
  low: 2,
  medium: 2,
  high: 2,
  ultra: 2,
}

/**
 * MSAA samples of the world per tier (the post pipeline's scene target; low has no post and no MSAA).
 * Medium uses 2×: on the AMD iGPU at 1080p (Crooked Lantern dm-play) the lite post path measured
 * 13.8–14.0 ms at 4× and 13.5–13.7 ms at 2×, against 12.8–12.9 ms for the former context-MSAA medium.
 */
export const MSAA_SAMPLES: Record<Quality, number> = {
  low: 0,
  medium: 2,
  high: 4,
  ultra: 4,
}

/** Lowest render scale (fraction of CSS pixels) the budget may impose. */
export const MIN_PIXEL_RATIO = 0.5

/**
 * Device pixel ratio to render at so that cssW·cssH·ratio² ≤ budget, never above the device's own
 * ratio (nor `maxRatio`) and never below MIN_PIXEL_RATIO.
 */
export function computePixelRatio(cssWidth: number, cssHeight: number, devicePixelRatio: number, budget: number, maxRatio = Infinity): number {
  const dpr = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1
  const area = Math.max(1, cssWidth) * Math.max(1, cssHeight)
  const cap = Math.sqrt(budget / area)
  return Math.max(MIN_PIXEL_RATIO, Math.min(dpr, maxRatio, cap))
}

/**
 * Predicted cost of the next tier up relative to the current one (frame cost × ratio), per current tier.
 * From measured GPU times on an AMD iGPU (7.2 → 10.6 → 19.0 → 34.5 ms) and the autoQuality calibration
 * (6.4 → 12.8 → 23.7 → 41.7 ms). Ultra has no tier above.
 */
export const UP_COST_RATIO: Record<Quality, number> = { low: 1.5, medium: 1.9, high: 1.85, ultra: 1 }

/** Frame budget the next tier's predicted cost must fit before stepping up (autoQuality's PREDICTED_BUDGET_MS). */
export const UP_BUDGET_MS = 14

/**
 * Cost reported for a steady vsync-bound interval when no GPU timer exists: low enough to pass every
 * tier's step-up gate (UP_BUDGET_MS / max UP_COST_RATIO). The frame interval cannot tell how much of the
 * frame is free, so this only means "try": a failed step up is remembered and not retried.
 */
export const VSYNC_HEADROOM_COST_MS = 7

/**
 * Frame interval (ms) above which a frame missed vsync (the engine also requires 1.25× the median
 * interval, for displays slower than 60 Hz). A GPU timer excludes present / resolve time and contention,
 * so such a frame does not count as headroom even when its timer reads low.
 */
export const MISSED_VSYNC_MS = 20

/**
 * Frame cost fed to AdaptiveQuality when GPU time is not measurable (no timer queries: Firefox,
 * Safari): the frame interval — except that a steady interval at display rate (median ≤ 17.5 ms and
 * p95 within 20 % of it, what vsync-bound rendering looks like) counts as headroom
 * (VSYNC_HEADROOM_COST_MS). At 60 Hz the interval itself never drops under the step-up threshold, so
 * quality could never recover after a step down. If a step up then misses vsync, p95 rises, the
 * hysteresis steps back down and that tier is not tried again (AdaptiveQuality's failed-step memory).
 */
export function intervalFrameCost(dtMs: number, medianMs: number, p95Ms: number, headroomMs = VSYNC_HEADROOM_COST_MS): number {
  const steady = medianMs > 0 && medianMs <= 17.5 && p95Ms <= medianMs * 1.2 + 0.5
  return steady ? Math.min(dtMs, headroomMs) : dtMs
}

const ORDER: readonly Quality[] = ["low", "medium", "high", "ultra"]

export const qualityRank = (q: Quality): number => ORDER.indexOf(q)
export const qualityDown = (q: Quality): Quality => ORDER[Math.max(0, qualityRank(q) - 1)]
export const qualityUp = (q: Quality): Quality => ORDER[Math.min(ORDER.length - 1, qualityRank(q) + 1)]

/** Sliding window of frame times (ms) with timestamps (ms). */
export class FrameTimeWindow {
  private times: number[] = []
  private values: number[] = []
  readonly spanMs: number

  constructor(spanMs = 2000) {
    this.spanMs = spanMs
  }

  push(now: number, frameMs: number): void {
    this.times.push(now)
    this.values.push(frameMs)
    const cutoff = now - this.spanMs
    let drop = 0
    while (drop < this.times.length && this.times[drop] < cutoff) drop++
    if (drop > 0) {
      this.times.splice(0, drop)
      this.values.splice(0, drop)
    }
  }

  clear(): void {
    this.times = []
    this.values = []
  }

  get size(): number {
    return this.values.length
  }

  /** Time covered by the samples (ms). */
  coverage(): number {
    return this.times.length < 2 ? 0 : this.times[this.times.length - 1] - this.times[0]
  }

  /** Nearest-rank percentile (0..1) of the frame times; 0 when empty. */
  percentile(p: number): number {
    const n = this.values.length
    if (n === 0) return 0
    const sorted = this.values.slice().sort((a, b) => a - b)
    const rank = Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))
    return sorted[rank]
  }

  p95(): number {
    return this.percentile(0.95)
  }

  /** Frames per second over the window (frames / covered seconds). */
  fps(): number {
    const c = this.coverage()
    return c > 0 ? ((this.times.length - 1) * 1000) / c : 0
  }
}

export interface AdaptiveQualityOptions {
  downThresholdMs?: number
  upThresholdMs?: number
  /** Budget for the next tier's predicted cost (p95 × UP_COST_RATIO[current]) before stepping up. */
  upBudgetMs?: number
  downHoldMs?: number
  upHoldMs?: number
  windowMs?: number
}

/**
 * Hysteresis state machine over a p95 frame-time window. `push` returns the new quality when a
 * step happens. After any step the window restarts, so each decision uses fresh samples.
 *
 * Stepping up needs p95 < upThresholdMs and the next tier's predicted cost (p95 × UP_COST_RATIO) within
 * upBudgetMs for upHold: a GPU that runs medium in 10.6 ms would run high in ~20 ms, so it stays at
 * medium instead of trying high every few seconds. If the quality had to step down shortly after a step
 * up, that tier is remembered as failed and not tried again until setCeiling() or clearFailedSteps() (the
 * engine calls it when the canvas size changes); the next step up also waits twice as long (up to 60 s).
 */
export class AdaptiveQuality {
  private window: FrameTimeWindow
  private overSince: number | null = null
  private underSince: number | null = null
  private upHold: number
  private lastUpAt = -Infinity
  private _current: Quality
  private _ceiling: Quality
  private readonly failed = new Set<Quality>()
  private readonly opts: Required<AdaptiveQualityOptions>

  constructor(ceiling: Quality, opts: AdaptiveQualityOptions = {}) {
    this.opts = {
      downThresholdMs: opts.downThresholdMs ?? 18,
      upThresholdMs: opts.upThresholdMs ?? 12,
      upBudgetMs: opts.upBudgetMs ?? UP_BUDGET_MS,
      downHoldMs: opts.downHoldMs ?? 2000,
      upHoldMs: opts.upHoldMs ?? 5000,
      windowMs: opts.windowMs ?? 2000,
    }
    this.window = new FrameTimeWindow(this.opts.windowMs)
    this.upHold = this.opts.upHoldMs
    this._current = ceiling
    this._ceiling = ceiling
  }

  get current(): Quality {
    return this._current
  }

  get ceiling(): Quality {
    return this._ceiling
  }

  /** Frame cost under which a frame can count as headroom for a step up. */
  get upThresholdMs(): number {
    return this.opts.upThresholdMs
  }

  /** Tiers a step up failed at (not tried again until setCeiling / clearFailedSteps). */
  get failedTiers(): readonly Quality[] {
    return [...this.failed]
  }

  /** User-selected quality: the ceiling, applied immediately. Forgets failed steps. */
  setCeiling(q: Quality): void {
    this._ceiling = q
    this._current = q
    this.upHold = this.opts.upHoldMs
    this.lastUpAt = -Infinity
    this.failed.clear()
    this.reset()
  }

  /**
   * Conditions changed (e.g. the canvas was resized): tiers that failed before may fit now. The samples
   * are dropped too (they measured the old conditions).
   */
  clearFailedSteps(): void {
    this.failed.clear()
    this.reset()
  }

  /** Forget samples (e.g. after the tab was hidden or a heavy one-off rebuild). */
  reset(): void {
    this.window.clear()
    this.overSince = null
    this.underSince = null
  }

  p95(): number {
    return this.window.p95()
  }

  push(now: number, frameMs: number): Quality | null {
    this.window.push(now, frameMs)
    // Decisions need a reasonably full window.
    if (this.window.coverage() < this.opts.windowMs * 0.5) return null
    const p95 = this.window.p95()
    const headroom = p95 < this.opts.upThresholdMs && p95 * UP_COST_RATIO[this._current] <= this.opts.upBudgetMs
    this.overSince = p95 > this.opts.downThresholdMs ? (this.overSince ?? now) : null
    this.underSince = headroom ? (this.underSince ?? now) : null
    if (this.overSince !== null && now - this.overSince >= this.opts.downHoldMs && qualityRank(this._current) > 0) {
      if (now - this.lastUpAt < this.upHold * 2) {
        // The last step up did not hold: remember the tier, and back off as a fallback.
        this.failed.add(this._current)
        this.upHold = Math.min(60000, this.upHold * 2)
      }
      this._current = qualityDown(this._current)
      this.reset()
      return this._current
    }
    const next = qualityUp(this._current)
    if (this.underSince !== null && now - this.underSince >= this.upHold && qualityRank(this._current) < qualityRank(this._ceiling) && !this.failed.has(next)) {
      this._current = qualityUp(this._current)
      this.lastUpAt = now
      this.reset()
      return this._current
    }
    return null
  }
}
