import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createWorkerTimers } from "./timers"

/** In-process stand-in for timerWorker.ts. */
class FakeTimerPort {
  private readonly listeners = new Map<string, Array<(ev: Event) => void>>()
  private readonly pending = new Map<number, ReturnType<typeof setTimeout>>()
  terminated = false

  postMessage(msg: { id: number; ms: number } | { cancel: number }): void {
    if ("cancel" in msg) {
      clearTimeout(this.pending.get(msg.cancel))
      this.pending.delete(msg.cancel)
      return
    }
    this.pending.set(
      msg.id,
      setTimeout(() => {
        this.pending.delete(msg.id)
        if (!this.terminated) this.emit("message", { data: msg.id } as unknown as Event)
      }, msg.ms)
    )
  }

  addEventListener(type: string, l: (ev: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l])
  }

  emit(type: string, ev: Event): void {
    for (const l of this.listeners.get(type) ?? []) l(ev)
  }

  terminate(): void {
    this.terminated = true
  }
}

describe("worker timers", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("fire timeouts and intervals, and cancel them", async () => {
    const port = new FakeTimerPort()
    const t = createWorkerTimers(port)
    const fired: string[] = []
    t.setTimeout(() => fired.push("a"), 100)
    const b = t.setTimeout(() => fired.push("b"), 100)
    t.clearTimeout(b)
    const i = t.setInterval(() => fired.push("i"), 40)
    await vi.advanceTimersByTimeAsync(130)
    expect(fired).toEqual(["i", "i", "a", "i"])
    t.clearInterval(i)
    await vi.advanceTimersByTimeAsync(200)
    expect(fired).toEqual(["i", "i", "a", "i"])
    t.dispose()
    expect(port.terminated).toBe(true)
  })

  it("move pending timers to the global timers when the worker dies", async () => {
    const port = new FakeTimerPort()
    const t = createWorkerTimers(port)
    const fired: string[] = []
    t.setTimeout(() => fired.push("pending"), 1000)
    const i = t.setInterval(() => fired.push("tick"), 50)
    port.terminated = true
    port.emit("error", new Event("error"))
    await vi.advanceTimersByTimeAsync(0)
    expect(fired).toEqual(["pending"])
    await vi.advanceTimersByTimeAsync(120)
    expect(fired.filter((f) => f === "tick")).toHaveLength(2)
    t.clearInterval(i)
    t.setTimeout(() => fired.push("later"), 10)
    await vi.advanceTimersByTimeAsync(200)
    expect(fired.filter((f) => f === "tick")).toHaveLength(2)
    expect(fired.at(-1)).toBe("later")
  })
})
