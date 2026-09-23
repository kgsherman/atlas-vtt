/**
 * Stale-delete guard for WebGL context restores. three.js re-creates its GL state when a lost context is
 * restored, but the "dispose" listeners it registered on geometries, textures and render targets before
 * the loss still hold its old internals, and they call gl.delete* on handles of the lost context whenever
 * such an object is disposed later (a post target re-allocated on resize, a replaced map image, a rebuilt
 * level). WebGL answers each with "INVALID_OPERATION: delete: object does not belong to this context"
 * until it stops reporting errors altogether, which hides real ones later in the session.
 *
 * The guard records which context generation created each GL object (the generation grows on every
 * "webglcontextrestored") and turns deletes of objects from an earlier generation into no-ops: their
 * storage went with the lost context. It patches the context instance only (not the prototype), is
 * reference counted (StrictMode / HMR engines share one canvas and context) and is removed with the last
 * engine using it.
 */

type GlObject = object

const PAIRS = [
  ["createTexture", "deleteTexture"],
  ["createBuffer", "deleteBuffer"],
  ["createFramebuffer", "deleteFramebuffer"],
  ["createRenderbuffer", "deleteRenderbuffer"],
  ["createVertexArray", "deleteVertexArray"],
  ["createProgram", "deleteProgram"],
  ["createShader", "deleteShader"],
  ["createQuery", "deleteQuery"],
  ["createSampler", "deleteSampler"],
  ["createTransformFeedback", "deleteTransformFeedback"],
] as const

interface GuardState {
  generation: number
  refs: number
  readonly created: WeakMap<GlObject, number>
  readonly restore: () => void
}

const guards = new WeakMap<object, GuardState>()

/** Generation of the context (0 = never restored); for tests and diagnostics. */
export function contextGeneration(gl: object): number {
  return guards.get(gl)?.generation ?? 0
}

/**
 * Install the guard on `gl` (restored through `events`, the canvas). Returns the release function; the
 * patch is removed when the last holder releases it.
 */
export function guardStaleDeletes(gl: object, events: Pick<EventTarget, "addEventListener" | "removeEventListener">): () => void {
  let state = guards.get(gl)
  if (!state) {
    const target = gl as Record<string, unknown>
    const created = new WeakMap<GlObject, number>()
    const own: [string, unknown][] = []
    const onRestored = () => {
      s.generation++
    }
    const s: GuardState = {
      generation: 0,
      refs: 0,
      created,
      restore: () => {
        events.removeEventListener("webglcontextrestored", onRestored, { capture: true } as EventListenerOptions)
        for (const [name, prev] of own) {
          if (prev === undefined) delete target[name]
          else target[name] = prev
        }
      },
    }
    for (const [createName, deleteName] of PAIRS) {
      const create = target[createName]
      const del = target[deleteName]
      if (typeof create !== "function" || typeof del !== "function") continue
      own.push([createName, Object.hasOwn(target, createName) ? create : undefined], [deleteName, Object.hasOwn(target, deleteName) ? del : undefined])
      target[createName] = function (this: unknown, ...args: unknown[]) {
        const o = (create as (...a: unknown[]) => unknown).apply(gl, args)
        if (o !== null && typeof o === "object") created.set(o, s.generation)
        return o
      }
      target[deleteName] = function (this: unknown, o: unknown, ...args: unknown[]) {
        // Objects created before the guard was installed count as generation 0.
        if (o !== null && typeof o === "object" && (created.get(o) ?? 0) < s.generation) return
        return (del as (...a: unknown[]) => unknown).call(gl, o, ...args)
      }
    }
    // Capture phase: the generation must advance before three's own restore handler re-creates state.
    events.addEventListener("webglcontextrestored", onRestored, { capture: true } as AddEventListenerOptions)
    state = s
    guards.set(gl, state)
  }
  state.refs++
  let released = false
  return () => {
    if (released) return
    released = true
    const st = guards.get(gl)
    if (!st) return
    if (--st.refs > 0) return
    st.restore()
    guards.delete(gl)
  }
}
