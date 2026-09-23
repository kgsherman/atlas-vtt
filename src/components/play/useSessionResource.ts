import * as React from "react"

/**
 * Create a session-scoped resource (host runner, player client) once per `key` and dispose it on
 * unmount. Creation is deferred by a task so React StrictMode's mount → unmount → mount never builds
 * two live instances (which would fight over the host Web Lock or the same realtime topics).
 */
export function useSessionResource<T>(
  key: string | null,
  create: () => T,
  dispose: (value: T) => void
): T | null {
  const [value, setValue] = React.useState<{ key: string; value: T } | null>(
    null
  )
  const createRef = React.useRef(create)
  const disposeRef = React.useRef(dispose)
  React.useEffect(() => {
    createRef.current = create
    disposeRef.current = dispose
  })

  React.useEffect(() => {
    if (key === null) return
    let created: T | null = null
    let cancelled = false
    const timer = setTimeout(() => {
      if (cancelled) return
      created = createRef.current()
      setValue({ key, value: created })
    }, 0)
    return () => {
      cancelled = true
      clearTimeout(timer)
      if (created !== null) disposeRef.current(created)
      setValue(null)
    }
  }, [key])

  return value && value.key === key ? value.value : null
}

/** Persisted UI preference (localStorage), with a safe fallback when storage is unavailable. */
export function usePreference<T>(
  storageKey: string,
  initial: T,
  valid: (v: unknown) => v is T
): [T, (v: T) => void] {
  const [value, setValue] = React.useState<T>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw !== null) {
        const parsed: unknown = JSON.parse(raw)
        if (valid(parsed)) return parsed
      }
    } catch {
      // unavailable or corrupt: default
    }
    return initial
  })
  const set = React.useCallback(
    (v: T) => {
      setValue(v)
      try {
        localStorage.setItem(storageKey, JSON.stringify(v))
      } catch {
        // ignore
      }
    },
    [storageKey]
  )
  return [value, set]
}

export const isBool = (v: unknown): v is boolean => typeof v === "boolean"
export const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v)

/**
 * A mutable box for the latest render values, read by long-lived controllers' callbacks (event time,
 * never during render). Update it from an effect with set().
 */
export class LiveBox<T> {
  private value: T
  constructor(initial: T) {
    this.value = initial
  }
  get(): T {
    return this.value
  }
  set(next: T): void {
    this.value = next
  }
}
