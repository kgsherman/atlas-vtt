import { describe, expect, it } from "vitest"

import type { Quality } from "../contracts"
import { AdaptiveQuality, computePixelRatio, FrameTimeWindow, intervalFrameCost, MAX_PIXEL_RATIO, MIN_PIXEL_RATIO, PIXEL_BUDGET, qualityDown, qualityUp, UP_BUDGET_MS, UP_COST_RATIO } from "./quality"

describe("pixel budget", () => {
  it("keeps the device ratio when the canvas fits the budget", () => {
    expect(computePixelRatio(800, 600, 2, PIXEL_BUDGET.medium)).toBeCloseTo(Math.min(2, Math.sqrt(2.1e6 / (800 * 600))))
    expect(computePixelRatio(640, 480, 1, PIXEL_BUDGET.medium)).toBe(1)
  })

  it("caps physical pixels on high-DPI screens", () => {
    const pr = computePixelRatio(1920, 1080, 2, PIXEL_BUDGET.medium)
    expect(1920 * 1080 * pr * pr).toBeLessThanOrEqual(2.1e6 + 1)
    expect(pr).toBeLessThan(2)
    const low = computePixelRatio(1920, 1080, 2, PIXEL_BUDGET.low)
    expect(1920 * 1080 * low * low).toBeLessThanOrEqual(1.3e6 + 1)
    expect(low).toBeLessThan(pr)
  })

  it("renders high / ultra at native resolution up to 2× DPR", () => {
    expect(computePixelRatio(1920, 1080, 2, PIXEL_BUDGET.high, MAX_PIXEL_RATIO.high)).toBe(2)
    expect(computePixelRatio(1920, 1080, 3, PIXEL_BUDGET.ultra, MAX_PIXEL_RATIO.ultra)).toBe(2)
    // 5K at 2×: the budget guards absurd pixel counts.
    const pr = computePixelRatio(2560, 1440, 2, PIXEL_BUDGET.high, MAX_PIXEL_RATIO.high)
    expect(2560 * 1440 * pr * pr).toBeLessThanOrEqual(PIXEL_BUDGET.high + 1)
  })

  it("never goes below the minimum ratio and survives bad input", () => {
    expect(computePixelRatio(7680, 4320, 1, PIXEL_BUDGET.low)).toBe(MIN_PIXEL_RATIO)
    expect(computePixelRatio(0, 0, Number.NaN, PIXEL_BUDGET.low)).toBe(1)
  })
})

describe("frame window", () => {
  it("computes the p95 and fps over the last 2 s", () => {
    const w = new FrameTimeWindow(2000)
    for (let k = 0; k < 100; k++) w.push(k * 10, k < 95 ? 10 : 40)
    expect(w.p95()).toBe(10)
    w.push(1000, 40)
    expect(w.p95()).toBe(40)
    expect(w.fps()).toBeCloseTo(100, 0)
    w.push(5000, 5)
    expect(w.size).toBe(1)
  })
})

describe("adaptive quality", () => {
  const run = (a: AdaptiveQuality, from: number, to: number, ms: number) => {
    const steps: string[] = []
    for (let t = from; t <= to; t += 16) {
      const s = a.push(t, ms)
      if (s) steps.push(s)
    }
    return steps
  }

  it("steps down after 2 s of slow frames and not before", () => {
    const a = new AdaptiveQuality("high")
    expect(run(a, 0, 2800, 25)).toEqual([])
    expect(run(a, 2816, 3400, 25)).toEqual(["medium"])
    expect(a.current).toBe("medium")
  })

  it("steps up after 5 s of fast frames, never above the ceiling", () => {
    const a = new AdaptiveQuality("medium")
    run(a, 0, 4000, 30)
    expect(a.current).toBe("low")
    const up = run(a, 4016, 12000, 8)
    expect(up).toEqual(["medium"])
    expect(run(a, 12016, 30000, 8)).toEqual([])
    expect(a.current).toBe("medium")
  })

  it("holds steady between the thresholds", () => {
    const a = new AdaptiveQuality("high")
    expect(run(a, 0, 20000, 15)).toEqual([])
  })

  it("backs off stepping up after oscillating", () => {
    const a = new AdaptiveQuality("high")
    run(a, 0, 4000, 30) // → medium
    run(a, 4016, 11000, 7) // → high after 5 s
    expect(a.current).toBe("high")
    run(a, 11016, 15000, 30) // → medium again soon after
    expect(a.current).toBe("medium")
    // High failed: not tried again, however fast medium runs…
    expect(a.failedTiers).toEqual(["high"])
    expect(run(a, 15016, 40000, 7)).toEqual([])
    // …until conditions change (a resize); then the doubled back-off still applies (10 s).
    a.clearFailedSteps()
    expect(run(a, 40016, 50000, 7)).toEqual([])
    expect(run(a, 50016, 53000, 7)).toEqual(["high"])
  })

  it("steps up only when the next tier's predicted cost fits the budget", () => {
    // Medium at 10 ms: under the 12 ms threshold, but high would cost ~19 ms.
    const a = new AdaptiveQuality("high")
    run(a, 0, 4000, 30)
    expect(a.current).toBe("medium")
    expect(10 * UP_COST_RATIO.medium).toBeGreaterThan(UP_BUDGET_MS)
    expect(run(a, 4016, 60000, 10)).toEqual([])
    // A budget override lets it through.
    const b = new AdaptiveQuality("high", { upBudgetMs: 20 })
    run(b, 0, 4000, 30)
    expect(run(b, 4016, 12000, 10)).toEqual(["high"])
  })

  /** Vsync-bound simulation: per-tier GPU cost, frame interval max(16.7, cost). */
  const simulate = (a: AdaptiveQuality, cost: Record<Quality, number>, seconds: number) => {
    const changes: string[] = []
    let q: Quality = a.current
    for (let t = 0; t < seconds * 1000; ) {
      t += Math.max(16.7, cost[q])
      const step = a.push(t, cost[q])
      if (step) {
        changes.push(`${q}→${step}`)
        q = step
      }
    }
    return changes
  }

  it("settles on medium for an iGPU with medium 10.6 / high 19 ms (no oscillation)", () => {
    const a = new AdaptiveQuality("high")
    expect(simulate(a, { low: 7.2, medium: 10.6, high: 19, ultra: 34.5 }, 600)).toEqual(["high→medium"])
    expect(a.current).toBe("medium")
  })

  it("still climbs from low to ultra on a fast GPU", () => {
    const a = new AdaptiveQuality("ultra")
    // Reach low without any failed step up (no step up happened yet).
    run(a, 0, 12000, 40)
    expect(a.current).toBe("low")
    expect(a.failedTiers).toEqual([])
    expect(simulate(a, { low: 3, medium: 4, high: 6, ultra: 11 }, 60)).toEqual(["low→medium", "medium→high", "high→ultra"])
  })

  it("setCeiling clears the failed-step memory", () => {
    const a = new AdaptiveQuality("high")
    run(a, 0, 4000, 30) // → medium
    run(a, 4016, 11000, 7) // → high
    run(a, 11016, 15000, 30) // → medium: high failed
    expect(a.failedTiers).toEqual(["high"])
    a.setCeiling("high")
    expect(a.failedTiers).toEqual([])
    run(a, 15016, 19000, 30) // → medium (no step up before it: nothing recorded)
    expect(a.failedTiers).toEqual([])
    expect(run(a, 19016, 26000, 7)).toEqual(["high"])
  })

  it("setCeiling applies the user's choice immediately", () => {
    const a = new AdaptiveQuality("high")
    a.setCeiling("low")
    expect(a.current).toBe("low")
    expect(qualityUp("high")).toBe("ultra")
    expect(qualityUp("ultra")).toBe("ultra")
    expect(qualityDown("ultra")).toBe("high")
    expect(qualityDown("low")).toBe("low")
  })
})

describe("frame cost without GPU timers", () => {
  it("treats a steady display-rate interval as headroom and anything else as its interval", () => {
    // 60 Hz, steady: counts under the step-up threshold.
    expect(intervalFrameCost(16.7, 16.7, 17.2)).toBeLessThan(12)
    // 144 Hz: already under.
    expect(intervalFrameCost(6.9, 6.9, 7.1)).toBeLessThan(12)
    // Jittery (missed frames) or steadily slow (30 fps): the interval as is.
    expect(intervalFrameCost(16.7, 16.7, 33.4)).toBe(16.7)
    expect(intervalFrameCost(33.4, 33.4, 33.6)).toBe(33.4)
    expect(intervalFrameCost(20, 0, 0)).toBe(20)
  })

  it("lets a vsync-bound engine step back up after a step down", () => {
    const q = new AdaptiveQuality("high")
    const w = new FrameTimeWindow(2000)
    let t = 0
    let now: string = q.current
    // 4 s of dropped frames step down…
    for (; t < 4000; t += 33) {
      w.push(t, 33)
      now = q.push(t, intervalFrameCost(33, w.percentile(0.5), w.p95())) ?? now
    }
    expect(now).toBe("medium")
    // …then steady 60 Hz steps back up (once both 2 s windows hold only steady frames, after the 5 s hold).
    for (const end = t + 12000; t < end; t += 16.7) {
      w.push(t, 16.7)
      now = q.push(t, intervalFrameCost(16.7, w.percentile(0.5), w.p95())) ?? now
    }
    expect(now).toBe("high")
  })
})
