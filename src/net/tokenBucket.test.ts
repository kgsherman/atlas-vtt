import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { REALTIME_SEND_RATE, TokenBucket } from "./tokenBucket"

describe("TokenBucket", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const make = (ratePerSecond: number, burst: number) => new TokenBucket({ ratePerSecond, burst, now: () => Date.now() })

  it("grants the burst immediately", async () => {
    const bucket = make(10, 3)
    const results = await Promise.all([bucket.take(), bucket.take(), bucket.take()])
    expect(results).toEqual([true, true, true])
    expect(bucket.tryTake()).toBe(false)
  })

  it("delays (never drops) beyond the burst, at the configured rate", async () => {
    const bucket = make(10, 2) // one token every 100 ms
    const granted: number[] = []
    const start = Date.now()
    const all = Array.from({ length: 6 }, (_, i) => bucket.take().then((ok) => ok && granted.push(i)))
    await vi.advanceTimersByTimeAsync(0)
    expect(granted).toEqual([0, 1])
    expect(bucket.pending).toBe(4)
    await vi.advanceTimersByTimeAsync(100)
    expect(granted).toEqual([0, 1, 2])
    await vi.advanceTimersByTimeAsync(300)
    await Promise.all(all)
    expect(granted).toEqual([0, 1, 2, 3, 4, 5])
    expect(Date.now() - start).toBe(400)
    expect(bucket.pending).toBe(0)
  })

  it("serves waiters in FIFO order even when tokens refill between calls", async () => {
    const bucket = make(100, 1)
    const order: string[] = []
    const a = bucket.take().then(() => order.push("a"))
    const b = bucket.take().then(() => order.push("b"))
    const c = bucket.take().then(() => order.push("c"))
    await vi.advanceTimersByTimeAsync(5) // half a token: nobody new yet
    // a late tryTake must not jump the queue even if a token appeared
    await vi.advanceTimersByTimeAsync(5)
    expect(bucket.tryTake()).toBe(false)
    await vi.advanceTimersByTimeAsync(50)
    await Promise.all([a, b, c])
    expect(order).toEqual(["a", "b", "c"])
  })

  it("refills up to the burst only", async () => {
    const bucket = make(10, 2)
    await bucket.take()
    await bucket.take()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(true)
    expect(bucket.tryTake()).toBe(false)
  })

  it("dispose releases waiters with false and refuses new takes", async () => {
    const bucket = make(1, 1)
    await bucket.take()
    const waiting = bucket.take()
    bucket.dispose()
    await expect(waiting).resolves.toBe(false)
    await expect(bucket.take()).resolves.toBe(false)
  })

  it("rejects nonsensical configurations", () => {
    expect(() => new TokenBucket({ ratePerSecond: 0, burst: 1 })).toThrow()
    expect(() => new TokenBucket({ ratePerSecond: 5, burst: 0 })).toThrow()
  })

  it("defaults to ~25 msg/s for Realtime", () => {
    expect(REALTIME_SEND_RATE.ratePerSecond).toBe(25)
  })
})
