/**
 * Timer worker for the host (see timers.ts): dedicated-worker timers are not clamped like the
 * main-thread timers of a hidden tab, so a DM who switches tabs keeps a ≤ 100 ms flush cadence.
 * Protocol: {id, ms} → after ms, posts id back; {cancel: id} cancels.
 */
interface WorkerScope {
  onmessage: ((ev: MessageEvent<{ id: number; ms: number } | { cancel: number }>) => void) | null
  postMessage(message: number): void
}

const scope = self as unknown as WorkerScope
const pending = new Map<number, ReturnType<typeof setTimeout>>()

scope.onmessage = (ev) => {
  const msg = ev.data
  if ("cancel" in msg) {
    const t = pending.get(msg.cancel)
    if (t !== undefined) clearTimeout(t)
    pending.delete(msg.cancel)
    return
  }
  pending.set(
    msg.id,
    setTimeout(() => {
      pending.delete(msg.id)
      scope.postMessage(msg.id)
    }, msg.ms)
  )
}
