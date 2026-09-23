/**
 * Host ↔ vision worker protocol (ARCHITECTURE §6.2 "vision worker"). The worker owns a VisionEngine
 * (light field + per-viewer LOS caches) for the host's live scene.
 *
 * Scene revisions travel as DIFFS built from the reducers' change lists (only changed objects /
 * tokens, and levels / grid / environment when they changed), so a token move posts a few hundred
 * bytes instead of structured-cloning the whole scene. The worker rebuilds the next revision
 * immutably ({...prev, objects: {...prev.objects, ...changed}}) so unchanged entries keep their
 * identity, which the engine's incremental caches rely on.
 *
 * Every scene revision carries a `tag` (the host's scene revision counter). A compute result reports
 * the tag of the scene it was computed on; the host never pairs it with another revision.
 *
 * `probe` evaluates a hypothetical revision without adopting it: the worker applies a diff to its
 * current revision (e.g. a moving token at an intermediate step of its path), computes visibility for
 * several viewer sets, and restores the engine to the current revision. It never changes the worker's
 * scene or tag, so a compute posted after a probe sees exactly what it would have seen without it.
 */
import type { Environment, GridSettings, Id, Level, SceneLike, SceneObject, Token } from "@/core/scene/types"
import { createVisionEngine } from "@/core/vision"
import type { VisibilityResult, VisionChange, VisionEngine } from "@/core/vision/types"

export interface SceneDiff {
  objects?: Array<[Id, SceneObject | null]>
  tokens?: Array<[Id, Token | null]>
  /** Full replacement of the levels record (structure or terrain changes). */
  levels?: Record<Id, Level>
  grid?: GridSettings
  environment?: Environment
}

export type VisionRequest =
  | { id: number; op: "setScene"; tag: number; scene: SceneLike }
  | { id: number; op: "update"; tag: number; change: VisionChange; scene?: SceneLike; diff?: SceneDiff }
  | { id: number; op: "compute"; viewers: Id[] }
  /**
   * Visibility of `viewerSets` (one result per set) on the current revision with `diff` applied, without
   * adopting it. `change` lists what the diff changes (the engine is told exactly that, both ways).
   */
  | { id: number; op: "probe"; tokenId: Id; change: VisionChange; diff: SceneDiff; viewerSets: Id[][] }

export type VisionResponse =
  | { id: number; ok: true; tag: number; ms: number; result?: VisibilityResult; results?: VisibilityResult[] }
  | { id: number; ok: false; error: string }

const own = <T>(rec: Record<Id, T>, id: Id): T | undefined => (Object.hasOwn(rec, id) ? rec[id] : undefined)

/** Only the fields vision reads (keeps worker messages free of names, notes, assets…). */
export function visionScene(scene: SceneLike): SceneLike {
  return { grid: scene.grid, environment: scene.environment, levels: scene.levels, objects: scene.objects, tokens: scene.tokens }
}

/** The diff from the previous revision to `scene`, given the ids that changed. */
export function diffForChange(scene: SceneLike, change: VisionChange): SceneDiff {
  const diff: SceneDiff = {}
  if (change.objects && change.objects.length > 0) diff.objects = [...new Set(change.objects)].map((id) => [id, own(scene.objects, id) ?? null])
  if (change.tokens && change.tokens.length > 0) diff.tokens = [...new Set(change.tokens)].map((id) => [id, own(scene.tokens, id) ?? null])
  if (change.structure || (change.terrain && change.terrain.length > 0)) diff.levels = scene.levels
  if (change.structure) {
    diff.grid = scene.grid
    diff.environment = scene.environment
  }
  return diff
}

/** Apply a diff immutably (unchanged entries keep their identity). */
export function applySceneDiff(prev: SceneLike, diff: SceneDiff): SceneLike {
  let objects = prev.objects
  if (diff.objects && diff.objects.length > 0) {
    objects = { ...prev.objects }
    for (const [id, o] of diff.objects) {
      if (id === "__proto__") continue
      if (o) objects[id] = o
      else delete objects[id]
    }
  }
  let tokens = prev.tokens
  if (diff.tokens && diff.tokens.length > 0) {
    tokens = { ...prev.tokens }
    for (const [id, t] of diff.tokens) {
      if (id === "__proto__") continue
      if (t) tokens[id] = t
      else delete tokens[id]
    }
  }
  let levels = prev.levels
  if (diff.levels) {
    // Keep the identity of levels that did not change (heightmap chunk identity drives terrain diffs).
    levels = {}
    for (const [id, l] of Object.entries(diff.levels)) {
      const old = own(prev.levels, id)
      levels[id] = old && sameLevel(old, l) ? old : l
    }
  }
  return { grid: diff.grid ?? prev.grid, environment: diff.environment ?? prev.environment, levels, objects, tokens }
}

function sameLevel(a: Level, b: Level): boolean {
  if (a.id !== b.id || a.name !== b.name || a.elevation !== b.elevation || a.height !== b.height || a.floorThickness !== b.floorThickness) return false
  if (JSON.stringify(a.backdrop ?? null) !== JSON.stringify(b.backdrop ?? null)) return false
  const ha = a.heightmap
  const hb = b.heightmap
  if (!ha || !hb) return ha === hb
  if (ha.resolution !== hb.resolution) return false
  const keys = Object.keys(ha.chunks)
  if (keys.length !== Object.keys(hb.chunks).length) return false
  return keys.every((k) => Object.hasOwn(hb.chunks, k) && ha.chunks[k] === hb.chunks[k])
}

/** Typed arrays of a result that can be transferred (fresh per compute, never retained by the engine). */
export function resultTransferables(result: VisibilityResult): ArrayBuffer[] {
  const out: ArrayBuffer[] = []
  for (const m of Object.values(result.perception)) if (m.grades.buffer instanceof ArrayBuffer) out.push(m.grades.buffer)
  for (const m of Object.values(result.sunlit)) if (m.bits.buffer instanceof ArrayBuffer) out.push(m.bits.buffer)
  return [...new Set(out)]
}

/** Transferables of a response (a compute's result or a probe's results). */
export function responseTransferables(res: VisionResponse): ArrayBuffer[] {
  if (!res.ok) return []
  const out: ArrayBuffer[] = []
  if (res.result) out.push(...resultTransferables(res.result))
  for (const r of res.results ?? []) out.push(...resultTransferables(r))
  return [...new Set(out)]
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now())

/** The worker's message handler, usable in-thread (tests, fallback) and inside the Worker. */
export class VisionWorkerCore {
  private engine: VisionEngine | null = null
  private scene: SceneLike | null = null
  private tag = -1

  get currentTag(): number {
    return this.tag
  }

  private computeOn(scene: SceneLike, viewerIds: readonly Id[]): VisibilityResult {
    const engine = this.engine!
    const viewers = [...new Set(viewerIds)].flatMap((id) => {
      const t = own(scene.tokens, id)
      return t && Object.hasOwn(scene.levels, t.levelId) ? [engine.viewerFor(t)] : []
    })
    return engine.compute(viewers)
  }

  handle(req: VisionRequest): VisionResponse {
    const t0 = now()
    try {
      switch (req.op) {
        case "setScene": {
          const scene = visionScene(req.scene)
          if (this.engine) this.engine.setScene(scene)
          else this.engine = createVisionEngine(scene)
          this.scene = scene
          this.tag = req.tag
          return { id: req.id, ok: true, tag: this.tag, ms: now() - t0 }
        }
        case "update": {
          if (!this.engine || !this.scene) throw new Error("update before setScene")
          const next = req.scene ? visionScene(req.scene) : applySceneDiff(this.scene, req.diff ?? {})
          this.engine.update(next, req.change)
          this.scene = next
          this.tag = req.tag
          return { id: req.id, ok: true, tag: this.tag, ms: now() - t0 }
        }
        case "compute": {
          if (!this.engine || !this.scene) throw new Error("compute before setScene")
          const result = this.computeOn(this.scene, req.viewers)
          return { id: req.id, ok: true, tag: this.tag, ms: now() - t0, result }
        }
        case "probe": {
          if (!this.engine || !this.scene) throw new Error("probe before setScene")
          const engine = this.engine
          const saved = this.scene
          const step = applySceneDiff(saved, req.diff)
          const change: VisionChange = { ...req.change }
          if (!change.tokens?.includes(req.tokenId)) change.tokens = [...(change.tokens ?? []), req.tokenId]
          engine.update(step, change)
          let results: VisibilityResult[]
          try {
            results = req.viewerSets.map((ids) => this.computeOn(step, ids))
          } finally {
            // Back to the current revision (this.scene / this.tag were never touched).
            engine.update(saved, change)
          }
          return { id: req.id, ok: true, tag: this.tag, ms: now() - t0, results }
        }
      }
    } catch (err) {
      return { id: req.id, ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) }
    }
  }
}
