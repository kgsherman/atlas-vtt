/**
 * "Preview player view" (ARCHITECTURE §7): host masks computed locally by core/vision for the chosen
 * tokens, with explored = currently perceived (no memory), and the scene the engine should draw in
 * player mode (what a player could be sent: no hidden objects, only viewers and the tokens they see).
 */
import { sortedLevels } from "@/core/scene/queries"
import type { Id, Scene, SceneLike } from "@/core/scene/types"
import { createCellMask, createGradeMask, createVisionEngine, encodeGrades, encodeMask, perceivedCells, type VisionEngine } from "@/core/vision"
import type { HostLevelMasks, SceneChange } from "@/render/contracts"

export interface PreviewResult {
  masks: Record<Id, HostLevelMasks>
  /** Tokens other than the viewers that the viewers can see. */
  visibleTokenIds: Id[]
  /** Scene to hand the engine in player mode. */
  scene: SceneLike
  /** Time spent in core/vision (ms). */
  ms: number
}

/** Tokens a preview can use as viewers: every token, PCs first, then by name. */
export function previewCandidates(scene: Pick<Scene, "tokens">): Id[] {
  const rank = { pc: 0, npc: 1, monster: 2 } as const
  return Object.values(scene.tokens)
    .sort((a, b) => rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((t) => t.id)
}

/** The default viewer: the first selected token, else the first PC (else any token). */
export function defaultPreviewToken(scene: Pick<Scene, "tokens">, selection: readonly Id[]): Id | null {
  for (const id of selection) if (Object.hasOwn(scene.tokens, id)) return id
  return previewCandidates(scene)[0] ?? null
}

/**
 * What a player controlling `keep` would roughly be sent: hidden objects/tokens removed, tokens
 * limited to `keep`, lights attached to removed tokens removed.
 */
export function playerPreviewScene(scene: Scene, keep: ReadonlySet<Id>): SceneLike {
  const tokens: Scene["tokens"] = {}
  for (const [id, t] of Object.entries(scene.tokens)) if (!t.hidden && keep.has(id)) tokens[id] = t
  const objects: Scene["objects"] = {}
  for (const [id, o] of Object.entries(scene.objects)) {
    if (o.hidden) continue
    if (o.type === "light" && o.attachedTokenId && !Object.hasOwn(tokens, o.attachedTokenId)) continue
    objects[id] = o
  }
  return { grid: scene.grid, environment: scene.environment, levels: scene.levels, objects, tokens }
}

export interface PreviewVision {
  /**
   * Visibility of `viewerIds` in `scene`. Pass the document change since the previous call (the
   * editor store's lastChange) so the vision caches update incrementally; null/undefined rebuilds.
   */
  compute(scene: Scene, viewerIds: readonly Id[], change?: SceneChange | null): PreviewResult
  dispose(): void
}

export function createPreviewVision(): PreviewVision {
  let engine: VisionEngine | null = null
  let last: Scene | null = null

  return {
    compute(scene, viewerIds, change) {
      const t0 = performance.now()
      if (!engine) engine = createVisionEngine(scene)
      else if (last !== scene) {
        if (change) engine.update(scene, change)
        else engine.setScene(scene)
      }
      last = scene
      const viewers = viewerIds.filter((id) => Object.hasOwn(scene.tokens, id)).map((id) => engine!.viewerFor(scene.tokens[id]))
      const result = engine.compute(viewers)
      const { width, depth } = scene.grid
      const masks: Record<Id, HostLevelMasks> = {}
      for (const level of sortedLevels(scene)) {
        const grades = result.perception[level.id] ?? createGradeMask(width, depth)
        masks[level.id] = {
          perception: encodeGrades(grades),
          // Preview has no memory: explored = what is perceived right now.
          explored: encodeMask(perceivedCells(grades)),
          sunlit: encodeMask(result.sunlit[level.id] ?? createCellMask(width, depth)),
        }
      }
      const visibleTokenIds = [...result.visibleTokenIds].filter((id) => !viewerIds.includes(id)).sort()
      const keep = new Set<Id>([...viewerIds, ...visibleTokenIds])
      return { masks, visibleTokenIds, scene: playerPreviewScene(scene, keep), ms: performance.now() - t0 }
    },
    dispose() {
      engine = null
      last = null
    },
  }
}
