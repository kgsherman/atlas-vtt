/**
 * Frame pacing and quality control (ARCHITECTURE §4.5, PERFORMANCE §7):
 *  - pixel budget: cap physical pixels (~2.1 MP medium/high, ~1.3 MP low) instead of raw DPR;
 *  - frame-time window: fps and p95 over the last ~2 s;
 *  - adaptive quality: step down when p95 > 18 ms for 2 s, up when p95 < 12 ms for 5 s, never above
 *    the quality the user asked for.
 */
import type { Quality } from "../contracts"

export const PIXEL_BUDGET: Record<Quality, number> = {
  low: 1.3e6,
  medium: 2.1e6,
  high: 2.1e6,
}

/** Lowest render scale (fraction of CSS pixels) the budget may impose. */
export const MIN_PIXEL_RATIO = 0.5

/**
 * Device pixel ratio to render at so that cssW·cssH·ratio² ≤ budget, never above the device's own
 * ratio and never below MIN_PIXEL_RATIO.
 */
export function computePixelRatio(cssWidth: number, cssHeight: number, devicePixelRatio: number, budget: number): number {
  const dpr = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1
  const area = Math.max(1, cssWidth) * Math.max(1, cssHeight)
  const cap = Math.sqrt(budget / area)
  return Math.max(MIN_PIXEL_RATIO, Math.min(dpr, cap))
}

/**
 * Frame cost fed to AdaptiveQuality when GPU time is not measurable (no timer queries: Firefox,
 * Safari): the frame interval — except that a steady interval at display rate (median ≤ 17.5 ms and
 * p95 within 20 % of it, what vsync-bound rendering looks like) counts as headroom. At 60 Hz the
 * interval itself never drops under the step-up threshold, so quality could never recover after a step
 * down. If a step up then misses vsync, p95 rises, the hysteresis steps back down and the next attempt
 * waits longer (AdaptiveQuality's back-off).
 */
export function intervalFrameCost(dtMs: number, medianMs: number, p95Ms: number, upThresholdMs = 12): number {
  const steady = medianMs > 0 && medianMs <= 17.5 && p95Ms <= medianMs * 1.2 + 0.5
  return steady ? Math.min(dtMs, upThresholdMs - 1) : dtMs
}

const ORDER: readonly Quality[] = ["low", "medium", "high"]

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
  downHoldMs?: number
  upHoldMs?: number
  windowMs?: number
}

/**
 * Hysteresis state machine over a p95 frame-time window. `push` returns the new quality when a
 * step happens. After any step the window restarts, so each decision uses fresh samples. If the
 * quality had to step down again shortly after stepping up, the next step up waits twice as long
 * (up to 60 s) so a scene on the edge does not oscillate.
 */
export class AdaptiveQuality {
  private window: FrameTimeWindow
  private overSince: number | null = null
  private underSince: number | null = null
  private upHold: number
  private lastUpAt = -Infinity
  private _current: Quality
  private _ceiling: Quality
  private readonly opts: Required<AdaptiveQualityOptions>

  constructor(ceiling: Quality, opts: AdaptiveQualityOptions = {}) {
    this.opts = {
      downThresholdMs: opts.downThresholdMs ?? 18,
      upThresholdMs: opts.upThresholdMs ?? 12,
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

  /** User-selected quality: the ceiling, applied immediately. */
  setCeiling(q: Quality): void {
    this._ceiling = q
    this._current = q
    this.upHold = this.opts.upHoldMs
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
    this.overSince = p95 > this.opts.downThresholdMs ? (this.overSince ?? now) : null
    this.underSince = p95 < this.opts.upThresholdMs ? (this.underSince ?? now) : null
    if (this.overSince !== null && now - this.overSince >= this.opts.downHoldMs && qualityRank(this._current) > 0) {
      if (now - this.lastUpAt < this.upHold * 2) this.upHold = Math.min(60000, this.upHold * 2)
      this._current = qualityDown(this._current)
      this.reset()
      return this._current
    }
    if (this.underSince !== null && now - this.underSince >= this.upHold && qualityRank(this._current) < qualityRank(this._ceiling)) {
      this._current = qualityUp(this._current)
      this.lastUpAt = now
      this.reset()
      return this._current
    }
    return null
  }
}
