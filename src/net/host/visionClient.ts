/**
 * VisionClient implementations (src/net/host/types.ts):
 *  - createWorkerVisionClient(worker): posts scene DIFFS to the vision Worker (visionWorker.ts);
 *  - createInThreadVisionClient(): the same VisionWorkerCore on the calling thread (tests, and the
 *    fallback when module workers are unavailable or the worker crashed);
 *  - createDefaultVisionClient(): a worker when possible, in-thread otherwise.
 *
 * All calls are processed strictly in call order (the worker's message queue / a promise chain), so a
 * compute always sees the revision of the last update posted before it. `compute` resolves with the
 * tag (`stateSeq`) of the revision it ran on; the host discards results whose tag is not current.
 *
 * Probes (a move's intermediate steps) go through a low-priority lane: they are queued here and posted
 * one at a time, only while no setScene/update/compute is outstanding, so foreground work (the move's
 * result, other players' flushes) waits for at most one probe instead of the whole backlog.
 */
import type { Id, SceneLike } from "@/core/scene/types"
import type { VisibilityResult, VisionChange } from "@/core/vision/types"

import type { VisionClient } from "./types"
import { diffForChange, visionScene, VisionWorkerCore, type VisionRequest, type VisionResponse } from "./visionProtocol"

export interface VisionClientExt extends VisionClient {
  readonly kind: "worker" | "in-thread"
  /** Engine time of the last compute (ms, measured where it ran). */
  readonly lastComputeMs: number
  /** Called once when the client breaks (worker crash); every pending and later call rejects. */
  onFailure(cb: (err: Error) => void): () => void
}

type Change = { objects?: Id[]; tokens?: Id[]; structure?: boolean; terrain?: Id[] }

type Ok = VisionResponse & { ok: true }

/**
 * Foreground calls vs low-priority probes: a probe starts only while no foreground call is outstanding
 * and no other probe runs; every settled call drains the queue.
 */
class ProbeLane {
  private foreground = 0
  private running = false
  private queue: Array<{ start: () => Promise<Ok>; resolve: (res: Ok) => void; reject: (err: Error) => void }> = []

  get pending(): number {
    return this.queue.length + (this.running ? 1 : 0)
  }

  fg(call: () => Promise<Ok>): Promise<Ok> {
    this.foreground++
    let p: Promise<Ok>
    try {
      p = call()
    } catch (err) {
      p = Promise.reject(err)
    }
    const done = () => {
      this.foreground--
      this.drain()
    }
    p.then(done, done)
    return p
  }

  probe(start: () => Promise<Ok>): Promise<Ok> {
    return new Promise((resolve, reject) => {
      this.queue.push({ start, resolve, reject })
      this.drain()
    })
  }

  rejectAll(err: Error): void {
    const queued = this.queue
    this.queue = []
    for (const job of queued) job.reject(err)
  }

  private drain(): void {
    if (this.foreground > 0 || this.running) return
    const job = this.queue.shift()
    if (!job) return
    this.running = true
    let p: Promise<Ok>
    try {
      p = job.start()
    } catch (err) {
      p = Promise.reject(err)
    }
    p.then(job.resolve, job.reject).finally(() => {
      this.running = false
      this.drain()
    })
  }
}

function probeResult(res: Ok): { stateSeq: number; results: VisibilityResult[] } {
  return { stateSeq: res.tag, results: (res.results ?? []) as VisibilityResult[] }
}

/** Omit over each member of a union. */
type RequestBody = VisionRequest extends infer R ? (R extends unknown ? Omit<R, "id"> : never) : never

function toVisionChange(change: Change): VisionChange {
  const out: VisionChange = {}
  if (change.objects && change.objects.length > 0) out.objects = [...change.objects]
  if (change.tokens && change.tokens.length > 0) out.tokens = [...change.tokens]
  if (change.terrain && change.terrain.length > 0) out.terrain = [...change.terrain]
  if (change.structure) out.structure = true
  return out
}

class Failures {
  private readonly listeners = new Set<(err: Error) => void>()
  error: Error | null = null

  add(cb: (err: Error) => void): () => void {
    if (this.error) {
      const err = this.error
      queueMicrotask(() => cb(err))
      return () => {}
    }
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  fail(err: Error): void {
    if (this.error) return
    this.error = err
    for (const cb of [...this.listeners]) {
      try {
        cb(err)
      } catch (e) {
        console.error("[atlas host] vision failure listener failed", e)
      }
    }
    this.listeners.clear()
  }
}

// ---------------------------------------------------------------------------
// In-thread
// ---------------------------------------------------------------------------

export function createInThreadVisionClient(): VisionClientExt {
  const core = new VisionWorkerCore()
  const failures = new Failures()
  const lane = new ProbeLane()
  let chain: Promise<unknown> = Promise.resolve()
  let lastComputeMs = 0
  let disposed = false
  let nextId = 1

  const run = (req: VisionRequest): Promise<Ok> => {
    const p = chain.then(() => {
      if (disposed) throw new Error("vision client disposed")
      const res = core.handle(req)
      if (!res.ok) throw new Error(`vision: ${res.error}`)
      return res
    })
    chain = p.catch(() => {})
    return p
  }

  return {
    kind: "in-thread",
    get lastComputeMs() {
      return lastComputeMs
    },
    get pendingProbes() {
      return lane.pending
    },
    onFailure: (cb) => failures.add(cb),
    async setScene(scene, stateSeq) {
      await lane.fg(() => run({ id: nextId++, op: "setScene", tag: stateSeq, scene }))
    },
    async update(scene, change, stateSeq) {
      // Same thread: hand over the immutable revision itself (no diff, no copy).
      await lane.fg(() => run({ id: nextId++, op: "update", tag: stateSeq, change: toVisionChange(change), scene }))
    },
    async compute(viewerTokenIds, _stateSeq) {
      const res = await lane.fg(() => run({ id: nextId++, op: "compute", viewers: [...viewerTokenIds] }))
      lastComputeMs = res.ms
      return { stateSeq: res.tag, result: res.result as VisibilityResult }
    },
    async probe(scene, change, viewerSets) {
      if (disposed) throw new Error("vision client disposed")
      const vc = toVisionChange(change)
      const tokenId = vc.tokens?.[0] ?? ""
      // A diff, like the worker: applied to whatever revision is current when the probe runs, so the
      // probe scene differs from it only in what `change` names (the engine restores exactly those).
      // Handing over `scene` itself would also roll back everything else changed since the move
      // (other tokens, a DM edit) without telling the engine.
      const diff = diffForChange(scene as SceneLike, vc)
      const sets = viewerSets.map((ids) => [...ids])
      return probeResult(await lane.probe(() => run({ id: nextId++, op: "probe", tokenId, change: vc, diff, viewerSets: sets })))
    },
    dispose() {
      disposed = true
      lane.rejectAll(new Error("vision client disposed"))
    },
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/** The subset of `Worker` used here (injectable for tests). */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(type: "message" | "error" | "messageerror", listener: (ev: Event) => void): void
  removeEventListener(type: "message" | "error" | "messageerror", listener: (ev: Event) => void): void
  terminate(): void
}

export function createWorkerVisionClient(worker: WorkerLike): VisionClientExt {
  const failures = new Failures()
  const pending = new Map<number, { resolve: (res: VisionResponse & { ok: true }) => void; reject: (err: Error) => void }>()
  let nextId = 1
  let lastComputeMs = 0
  let disposed = false
  /** The worker's current revision (diffs are computed against the last posted one). */
  let hasScene = false

  const onMessage = (ev: Event) => {
    const res = (ev as MessageEvent<VisionResponse>).data
    const p = pending.get(res?.id)
    if (!p) return
    pending.delete(res.id)
    if (res.ok) p.resolve(res)
    else p.reject(new Error(`vision worker: ${res.error}`))
  }
  const onError = (ev: Event) => {
    const msg = (ev as ErrorEvent).message || ev.type
    breakDown(new Error(`vision worker crashed: ${msg}`))
  }
  const lane = new ProbeLane()
  const breakDown = (err: Error) => {
    for (const p of pending.values()) p.reject(err)
    pending.clear()
    lane.rejectAll(err)
    failures.fail(err)
    teardown()
  }
  const teardown = () => {
    worker.removeEventListener("message", onMessage)
    worker.removeEventListener("error", onError)
    worker.removeEventListener("messageerror", onError)
    worker.terminate()
  }
  worker.addEventListener("message", onMessage)
  worker.addEventListener("error", onError)
  worker.addEventListener("messageerror", onError)

  const call = (req: RequestBody): Promise<Ok> => {
    if (disposed) return Promise.reject(new Error("vision client disposed"))
    if (failures.error) return Promise.reject(failures.error)
    const id = nextId++
    const full = { ...req, id } as VisionRequest
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      try {
        worker.postMessage(full)
      } catch (err) {
        pending.delete(id)
        const e = err instanceof Error ? err : new Error(String(err))
        reject(e)
        // A message that cannot be cloned is a bug in the caller, but the worker's revision is now
        // out of step with the host: treat it as a failure so the host rebuilds.
        breakDown(new Error(`vision worker: postMessage failed: ${e.message}`))
      }
    })
  }

  return {
    kind: "worker",
    get lastComputeMs() {
      return lastComputeMs
    },
    get pendingProbes() {
      return lane.pending
    },
    onFailure: (cb) => failures.add(cb),
    async setScene(scene, stateSeq) {
      hasScene = true
      await lane.fg(() => call({ op: "setScene", tag: stateSeq, scene: visionScene(scene as SceneLike) }))
    },
    async update(scene, change, stateSeq) {
      const vc = toVisionChange(change)
      if (!hasScene) {
        hasScene = true
        await lane.fg(() => call({ op: "setScene", tag: stateSeq, scene: visionScene(scene as SceneLike) }))
        return
      }
      await lane.fg(() => call({ op: "update", tag: stateSeq, change: vc, diff: diffForChange(scene as SceneLike, vc) }))
    },
    async compute(viewerTokenIds, _stateSeq) {
      const res = await lane.fg(() => call({ op: "compute", viewers: [...viewerTokenIds] }))
      lastComputeMs = res.ms
      return { stateSeq: res.tag, result: res.result as VisibilityResult }
    },
    async probe(scene, change, viewerSets) {
      if (disposed) throw new Error("vision client disposed")
      if (failures.error) throw failures.error
      const vc = toVisionChange(change)
      const tokenId = vc.tokens?.[0] ?? ""
      // Built now (pure: the client's revision bookkeeping is untouched); applied by the worker to
      // whatever revision is current when the probe runs.
      const diff = diffForChange(scene as SceneLike, vc)
      const sets = viewerSets.map((ids) => [...ids])
      return probeResult(await lane.probe(() => call({ op: "probe", tokenId, change: vc, diff, viewerSets: sets })))
    },
    dispose() {
      if (disposed) return
      disposed = true
      const err = new Error("vision client disposed")
      for (const p of pending.values()) p.reject(err)
      pending.clear()
      lane.rejectAll(err)
      teardown()
    },
  }
}

/** Spawn the vision module worker, or null where module workers are unavailable (Node, old browsers). */
export function spawnVisionWorker(): WorkerLike | null {
  if (typeof Worker !== "function") return null
  try {
    return new Worker(new URL("./visionWorker.ts", import.meta.url), { type: "module", name: "atlas-vision" }) as unknown as WorkerLike
  } catch (err) {
    console.warn("[atlas host] vision worker unavailable, computing vision on the main thread", err)
    return null
  }
}

/** Worker-backed client when possible, in-thread otherwise. */
export function createDefaultVisionClient(): VisionClientExt {
  const worker = spawnVisionWorker()
  return worker ? createWorkerVisionClient(worker) : createInThreadVisionClient()
}
