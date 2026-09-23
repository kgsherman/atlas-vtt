import { describe, expect, it } from "vitest"

import type { Rect } from "@/core/scene/types"

import { PreviewThrottle } from "./previewThrottle"

describe("preview throttle", () => {
  it("runs the first update at once, then waits max(interval, factor × cost) after a run ends", () => {
    let clock = 0
    const throttle = new PreviewThrottle(100, 8, () => clock)
    const runs: { at: number; dirty: Rect | null }[] = []
    // Each run costs 30 ms of the clock.
    const work = (dirty: Rect | null) => {
      runs.push({ at: clock, dirty })
      clock += 30
    }
    throttle.push("a", { x: 0, z: 0, w: 1, d: 1 }, work)
    expect(runs).toEqual([{ at: 0, dirty: { x: 0, z: 0, w: 1, d: 1 } }])
    // Ended at 30: the next run may start at 30 + 8 × 30 = 270 (not 100 after the start).
    clock = 150
    throttle.push("a", { x: 10, z: 0, w: 1, d: 1 }, work)
    clock = 200
    throttle.push("a", { x: 0, z: 10, w: 1, d: 1 }, work)
    throttle.flush((_, d) => work(d))
    expect(runs).toHaveLength(1)
    // The trailing run gets the union of the dirty rects since the last run.
    clock = 270
    throttle.flush((levelId, d) => {
      expect(levelId).toBe("a")
      work(d)
    })
    expect(runs[1]).toEqual({ at: 270, dirty: { x: 0, z: 0, w: 11, d: 11 } })
    // Nothing due: flushing does nothing.
    clock = 10_000
    throttle.flush((_, d) => work(d))
    expect(runs).toHaveLength(2)
  })

  it("keeps the minimum interval for cheap runs, a null rect means everywhere, and levels are independent", () => {
    let clock = 0
    const throttle = new PreviewThrottle(100, 8, () => clock)
    const runs: [string, Rect | null][] = []
    throttle.push("a", { x: 0, z: 0, w: 1, d: 1 }, (d) => runs.push(["a", d]))
    throttle.push("b", null, (d) => runs.push(["b", d]))
    clock = 50
    throttle.push("a", null, (d) => runs.push(["a", d]))
    throttle.push("a", { x: 5, z: 5, w: 1, d: 1 }, (d) => runs.push(["a", d]))
    clock = 99
    throttle.flush((id, d) => runs.push([id, d]))
    expect(runs).toEqual([
      ["a", { x: 0, z: 0, w: 1, d: 1 }],
      ["b", null],
    ])
    clock = 100
    throttle.flush((id, d) => runs.push([id, d]))
    expect(runs[2]).toEqual(["a", null])
    expect(runs).toHaveLength(3)
  })

  it("forgets a level on delete (no trailing run) and restarts it fresh", () => {
    let clock = 0
    const throttle = new PreviewThrottle(100, 8, () => clock)
    let runs = 0
    throttle.push("a", null, () => runs++)
    clock = 10
    throttle.push("a", null, () => runs++)
    expect(throttle.has("a")).toBe(true)
    expect(throttle.delete("a")).toBe(true)
    expect(throttle.delete("a")).toBe(false)
    clock = 500
    throttle.flush(() => runs++)
    expect(runs).toBe(1)
    // A new gesture runs at once again.
    clock = 510
    throttle.push("a", null, () => runs++)
    expect(runs).toBe(2)
    throttle.clear()
    expect(throttle.has("a")).toBe(false)
  })
})
