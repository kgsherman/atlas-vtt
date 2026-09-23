import { describe, expect, it } from "vitest"

import { AdaptiveQuality, computePixelRatio, FrameTimeWindow, intervalFrameCost, MAX_PIXEL_RATIO, MIN_PIXEL_RATIO, PIXEL_BUDGET, qualityDown, qualityUp } from "./quality"

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
    run(a, 4016, 11000, 8) // → high after 5 s
    expect(a.current).toBe("high")
    run(a, 11016, 15000, 30) // → medium again soon after
    expect(a.current).toBe("medium")
    // The next step up now needs 10 s of fast frames.
    expect(run(a, 15016, 22000, 8)).toEqual([])
    expect(run(a, 22016, 28000, 8)).toEqual(["high"])
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
