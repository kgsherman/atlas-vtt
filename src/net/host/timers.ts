/**
 * Timers for the host's scheduling (flush throttle, saves, idle syncs). In a browser the callbacks are
 * driven by a tiny dedicated worker (timerWorker.ts): Chrome clamps main-thread timers of a hidden tab
 * to ≥ 1 s, and chained ones to once a minute after 5 minutes, which would stall players whenever the
 * DM looks at another tab. Worker timers keep their cadence; their callbacks arrive as message events.
 * Elsewhere (Node, tests, no Worker) the global timers are used.
 */

export interface HostTimers {
  setTimeout(fn: () => void, ms: number): number
  clearTimeout(handle: number): void
  setInterval(fn: () => void, ms: number): number
  clearInterval(handle: number): void
  dispose(): void
}

/** Global timers (handles mapped to numbers so both implementations share one handle type). */
export function createGlobalTimers(): HostTimers {
  const timeouts = new Map<number, ReturnType<typeof setTimeout>>()
  const intervals = new Map<number, ReturnType<typeof setInterval>>()
  let next = 1
  return {
    setTimeout(fn, ms) {
      const id = next++
      timeouts.set(
        id,
        setTimeout(() => {
          timeouts.delete(id)
          fn()
        }, ms)
      )
      return id
    },
    clearTimeout(id) {
      const t = timeouts.get(id)
      if (t !== undefined) clearTimeout(t)
      timeouts.delete(id)
    },
    setInterval(fn, ms) {
      const id = next++
      intervals.set(id, setInterval(fn, ms))
      return id
    },
    clearInterval(id) {
      const t = intervals.get(id)
      if (t !== undefined) clearInterval(t)
      intervals.delete(id)
    },
    dispose() {
      for (const t of timeouts.values()) clearTimeout(t)
      for (const t of intervals.values()) clearInterval(t)
      timeouts.clear()
      intervals.clear()
    },
  }
}

interface TimerPort {
  postMessage(message: unknown): void
  addEventListener(type: "message" | "error", listener: (ev: Event) => void): void
  terminate(): void
}

/** Worker-driven timers over any port speaking the timerWorker protocol (injectable for tests). */
export function createWorkerTimers(port: TimerPort, fallback: HostTimers = createGlobalTimers()): HostTimers {
  const callbacks = new Map<number, { fn: () => void; every: number | null }>()
  /** Timers moved to the fallback after the worker died: our id → fallback handle. */
  const moved = new Map<number, { handle: number; every: boolean }>()
  let next = 1
  let broken = false
  const arm = (id: number, ms: number) => port.postMessage({ id, ms })
  port.addEventListener("message", (ev) => {
    const id = (ev as MessageEvent<number>).data
    const cb = callbacks.get(id)
    if (!cb) return
    if (cb.every === null) callbacks.delete(id)
    else arm(id, cb.every)
    try {
      cb.fn()
    } catch (err) {
      console.error("[atlas host] timer callback failed", err)
    }
  })
  // A dead worker must not freeze the host: move every pending timer to the global timers.
  port.addEventListener("error", () => {
    if (broken) return
    broken = true
    for (const [id, cb] of callbacks) {
      if (cb.every === null) {
        moved.set(id, {
          handle: fallback.setTimeout(() => {
            moved.delete(id)
            cb.fn()
          }, 0),
          every: false,
        })
      } else {
        moved.set(id, { handle: fallback.setInterval(cb.fn, cb.every), every: true })
      }
    }
    callbacks.clear()
  })
  const clear = (id: number) => {
    const m = moved.get(id)
    if (m) {
      moved.delete(id)
      if (m.every) fallback.clearInterval(m.handle)
      else fallback.clearTimeout(m.handle)
    } else if (callbacks.delete(id) && !broken) {
      port.postMessage({ cancel: id })
    }
  }
  const schedule = (fn: () => void, ms: number, every: boolean): number => {
    const id = next++
    if (broken) {
      const handle = every
        ? fallback.setInterval(fn, ms)
        : fallback.setTimeout(() => {
            moved.delete(id)
            fn()
          }, ms)
      moved.set(id, { handle, every })
      return id
    }
    callbacks.set(id, { fn, every: every ? Math.max(1, ms) : null })
    arm(id, every ? Math.max(1, ms) : Math.max(0, ms))
    return id
  }
  return {
    setTimeout: (fn, ms) => schedule(fn, ms, false),
    clearTimeout: clear,
    setInterval: (fn, ms) => schedule(fn, ms, true),
    clearInterval: clear,
    dispose() {
      callbacks.clear()
      moved.clear()
      port.terminate()
      fallback.dispose()
    },
  }
}

/** Worker timers in a browser page, global timers elsewhere. */
export function createHostTimers(): HostTimers {
  if (typeof Worker !== "function" || typeof document === "undefined") return createGlobalTimers()
  try {
    const worker = new Worker(new URL("./timerWorker.ts", import.meta.url), { type: "module", name: "atlas-host-timers" })
    return createWorkerTimers(worker as unknown as TimerPort)
  } catch {
    return createGlobalTimers()
  }
}
