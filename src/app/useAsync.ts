/**
 * Small data-loading hooks for pages.
 *
 * useAsync(key, fn): runs `fn` whenever `key` changes (null = idle) or reload() is called. Data from
 * the same key stays visible while reloading (stale-while-revalidate), so refreshes never flash a
 * skeleton; data from a previous key is never shown for a new one.
 */
import * as React from "react"

export interface AsyncState<T> {
  data: T | undefined
  error: unknown
  /** No settled result for the current key/reload yet. */
  loading: boolean
  /** Loading with data from a previous run of the same key on screen. */
  refreshing: boolean
  reload(): void
  /** Optimistic local update of the current data. */
  mutate(update: (prev: T | undefined) => T | undefined): void
}

interface Settled<T> {
  key: string | null
  run: number
  data: T | undefined
  error: unknown
  settled: boolean
}

export function useAsync<T>(key: string | null, fn: () => Promise<T>): AsyncState<T> {
  const fnRef = React.useRef(fn)
  React.useLayoutEffect(() => {
    fnRef.current = fn
  })
  const [run, setRun] = React.useState(0)
  const [state, setState] = React.useState<Settled<T>>({ key, run: 0, data: undefined, error: undefined, settled: false })

  React.useEffect(() => {
    if (key === null) return
    let alive = true
    fnRef.current().then(
      (data) => {
        if (alive) setState({ key, run, data, error: undefined, settled: true })
      },
      (error: unknown) => {
        if (alive) setState((s) => ({ key, run, data: s.key === key ? s.data : undefined, error, settled: true }))
      }
    )
    return () => {
      alive = false
    }
  }, [key, run])

  const reload = React.useCallback(() => setRun((n) => n + 1), [])
  const mutate = React.useCallback((update: (prev: T | undefined) => T | undefined) => setState((s) => ({ ...s, data: update(s.data) })), [])

  const sameKey = state.key === key
  const loading = key !== null && !(state.settled && sameKey && state.run === run)
  const data = sameKey ? state.data : undefined
  return {
    data,
    error: sameKey && !loading ? state.error : undefined,
    loading,
    refreshing: loading && data !== undefined,
    reload,
    mutate,
  }
}

// ---------------------------------------------------------------------------
// A shared ticking clock for relative times ("5 min ago") without impure renders.
// ---------------------------------------------------------------------------

const clockListeners = new Set<() => void>()
let clockNow = Date.now()
let clockTimer: ReturnType<typeof setInterval> | null = null

function subscribeClock(cb: () => void): () => void {
  clockListeners.add(cb)
  if (!clockTimer) {
    clockNow = Date.now()
    clockTimer = setInterval(() => {
      clockNow = Date.now()
      for (const l of clockListeners) l()
    }, 30_000)
  }
  return () => {
    clockListeners.delete(cb)
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer)
      clockTimer = null
    }
  }
}

const getClock = () => clockNow

/** Current time, refreshed every 30 s. */
export function useNow(): number {
  return React.useSyncExternalStore(subscribeClock, getClock, getClock)
}

/** Re-run a callback when the window regains focus or becomes visible (throttled). */
export function useOnFocus(cb: () => void, minIntervalMs = 5000): void {
  const cbRef = React.useRef(cb)
  React.useLayoutEffect(() => {
    cbRef.current = cb
  })
  React.useEffect(() => {
    let last = Date.now()
    const fire = () => {
      if (document.visibilityState !== "visible") return
      const now = Date.now()
      if (now - last < minIntervalMs) return
      last = now
      cbRef.current()
    }
    window.addEventListener("focus", fire)
    document.addEventListener("visibilitychange", fire)
    return () => {
      window.removeEventListener("focus", fire)
      document.removeEventListener("visibilitychange", fire)
    }
  }, [minIntervalMs])
}

/** The value, or the last non-null one (keeps dialog content on screen while it animates out). */
export function useLastNonNull<T>(value: T | null): T | null {
  const [last, setLast] = React.useState(value)
  if (value !== null && value !== last) setLast(value)
  return value ?? last
}
