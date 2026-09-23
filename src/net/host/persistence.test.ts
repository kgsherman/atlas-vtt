import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { NetError } from "../supabase"
import { fencingFailure, ThrottledTask } from "./persistence"

describe("ThrottledTask", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function task(run: () => Promise<void>, errors: unknown[] = []) {
    return new ThrottledTask({ run, intervalMs: 5000, urgentGapMs: 500, onError: (e) => errors.push(e), now: () => Date.now() })
  }

  it("runs at most once per interval, coalescing requests", async () => {
    let runs = 0
    const t = task(async () => {
      runs++
    })
    t.request()
    await vi.advanceTimersByTimeAsync(0)
    expect(runs).toBe(1)
    for (let k = 0; k < 10; k++) t.request()
    await vi.advanceTimersByTimeAsync(4000)
    expect(runs).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(runs).toBe(2)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(runs).toBe(2)
  })

  it("urgent requests only wait for the minimum gap", async () => {
    let runs = 0
    const t = task(async () => {
      runs++
    })
    t.request()
    await vi.advanceTimersByTimeAsync(0)
    t.request(true)
    await vi.advanceTimersByTimeAsync(499)
    expect(runs).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runs).toBe(2)
  })

  it("'soon' requests wait for the gameplay gap, between urgent and normal", async () => {
    let runs = 0
    const t = new ThrottledTask({
      run: async () => {
        runs++
      },
      intervalMs: 5000,
      urgentGapMs: 500,
      soonGapMs: 1000,
      onError: () => {},
      now: () => Date.now(),
    })
    t.request()
    await vi.advanceTimersByTimeAsync(0)
    t.request("soon")
    t.request()
    await vi.advanceTimersByTimeAsync(999)
    expect(runs).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(runs).toBe(2)
    // An urgent request raises a pending soon one.
    t.request("soon")
    t.request(true)
    await vi.advanceTimersByTimeAsync(500)
    expect(runs).toBe(3)
  })

  it("a request during a run schedules exactly one follow-up", async () => {
    let runs = 0
    let release!: () => void
    const t = task(
      () =>
        new Promise<void>((r) => {
          runs++
          release = r
        })
    )
    t.request()
    await vi.advanceTimersByTimeAsync(0)
    t.request()
    t.request()
    release()
    await vi.advanceTimersByTimeAsync(5000)
    expect(runs).toBe(2)
    release()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(runs).toBe(2)
  })

  it("flush runs now, rethrows, and failures are retried", async () => {
    const errors: unknown[] = []
    let fail = true
    let runs = 0
    const t = task(async () => {
      runs++
      if (fail) throw new Error("offline")
    }, errors)
    await expect(t.flush(true)).rejects.toThrow("offline")
    expect(errors).toHaveLength(1)
    fail = false
    await vi.advanceTimersByTimeAsync(5000)
    expect(runs).toBe(2)
    expect(t.pending).toBe(false)
    // Nothing pending: flush is a no-op unless forced.
    await t.flush()
    expect(runs).toBe(2)
  })

  it("cancel drops pending work", async () => {
    let runs = 0
    const t = task(async () => {
      runs++
    })
    t.request()
    t.cancel()
    await vi.advanceTimersByTimeAsync(10_000)
    t.request()
    await t.flush(true)
    expect(runs).toBe(0)
  })
})

describe("fencingFailure", () => {
  it("classifies stale epochs and ended sessions", () => {
    expect(fencingFailure(new NetError("stale_epoch"))).toBe("stale")
    expect(fencingFailure(new NetError("session_ended"))).toBe("ended")
    expect(fencingFailure(new NetError("network"))).toBeNull()
    expect(fencingFailure(new Error("stale_epoch"))).toBeNull()
  })
})
