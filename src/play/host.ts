/**
 * DM live-view helpers (ARCHITECTURE §6.2, §8): scene revision diffs for incremental engine updates,
 * host masks for "preview token vision", and immer patches for the scene edits the DM makes from the
 * play view (hide/reveal tokens, sun/moon on/off) — sent through HostRunner.applyScenePatches so they
 * reach the authoritative GameState like any editor edit.
 */
import { produceWithPatches, type Draft, type Patch } from "immer"

import { sortedLevels } from "@/core/scene/queries"
import type { Id, Level, Scene, SceneLike } from "@/core/scene/types"
import {
  createCellMask,
  createGradeMask,
  encodeGrades,
  encodeMask,
  perceivedCells,
} from "@/core/vision"
import type { VisibilityResult } from "@/core/vision/types"
import type { HostLevelMasks, SceneChange } from "@/render/contracts"

/** Keys of two records whose values differ by identity (added, removed or replaced). */
function changedKeys<T>(
  prev: Readonly<Record<string, T>>,
  next: Readonly<Record<string, T>>
): Id[] {
  if (prev === next) return []
  const out: Id[] = []
  for (const k of Object.keys(next))
    if (!Object.hasOwn(prev, k) || prev[k] !== next[k]) out.push(k)
  for (const k of Object.keys(prev)) if (!Object.hasOwn(next, k)) out.push(k)
  return out.sort()
}

/**
 * How a level changed between two revisions: "structure" when any field other than its heightmap and
 * terrain edits did, else "terrain" when the heightmap did, else "none". terrainEdits is DM-only editing
 * data without a visual effect of its own (its baked result is the heightmap).
 */
function levelChange(a: Level, b: Level): "structure" | "terrain" | "none" {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (k === "heightmap" || k === "terrainEdits") continue
    if (
      (a as unknown as Record<string, unknown>)[k] !==
      (b as unknown as Record<string, unknown>)[k]
    )
      return "structure"
  }
  return a.heightmap !== b.heightmap ? "terrain" : "none"
}

/**
 * What changed between two revisions of the same scene, relying on structural sharing (immer): unchanged
 * objects/tokens/levels keep their identity. Returns null when the revisions are unrelated (another
 * document) — the caller should then call Engine.setScene.
 */
export function sceneChangeBetween(
  prev: SceneLike | null,
  next: SceneLike
): SceneChange | null {
  if (!prev) return null
  if (prev === next) return {}
  // Another document (load-scene): rebuild.
  const pid = (prev as Partial<Scene>).id
  const nid = (next as Partial<Scene>).id
  if (pid !== undefined && nid !== undefined && pid !== nid) return null
  const change: SceneChange = {}
  const objects = changedKeys(prev.objects, next.objects)
  const tokens = changedKeys(prev.tokens, next.tokens)
  if (objects.length) change.objects = objects
  if (tokens.length) change.tokens = tokens
  let structure =
    prev.grid !== next.grid || prev.environment !== next.environment
  if (prev.levels !== next.levels) {
    const terrain: Id[] = []
    for (const id of changedKeys(prev.levels, next.levels)) {
      const a = Object.hasOwn(prev.levels, id) ? prev.levels[id] : undefined
      const b = Object.hasOwn(next.levels, id) ? next.levels[id] : undefined
      const kind = a && b ? levelChange(a, b) : "structure"
      if (kind === "terrain") terrain.push(id)
      else if (kind === "structure") structure = true
    }
    if (terrain.length) change.terrain = terrain
  }
  if (structure) change.structure = true
  return change
}

/** True when a SceneChange carries nothing. */
export function isEmptyChange(c: SceneChange): boolean {
  return (
    !c.structure &&
    !c.objects?.length &&
    !c.tokens?.length &&
    !c.terrain?.length
  )
}

/**
 * Host masks for a DM vision preview: perception as computed, explored = perceived right now (a preview
 * has no memory), sunlit as computed. Every level of the scene gets an entry (a missing level would read
 * as entirely unperceived anyway, but explicit empty masks keep uploads predictable).
 */
export function previewHostMasks(
  scene: Pick<SceneLike, "grid" | "levels">,
  result: VisibilityResult
): Record<Id, HostLevelMasks> {
  const { width, depth } = scene.grid
  const out: Record<Id, HostLevelMasks> = {}
  for (const level of sortedLevels(scene)) {
    const grades = Object.hasOwn(result.perception, level.id)
      ? result.perception[level.id]
      : createGradeMask(width, depth)
    out[level.id] = {
      perception: encodeGrades(grades),
      explored: encodeMask(perceivedCells(grades)),
      sunlit: encodeMask(
        Object.hasOwn(result.sunlit, level.id)
          ? result.sunlit[level.id]
          : createCellMask(width, depth)
      ),
    }
  }
  return out
}

/**
 * Tokens drawn dimmed (DM-only markers) in a vision preview: those the viewers cannot see, and hidden
 * tokens, which players never receive even in plain sight. Viewers themselves are never dimmed.
 */
export function previewDimmedTokens(
  scene: Pick<SceneLike, "tokens">,
  viewerIds: readonly Id[],
  result: Pick<VisibilityResult, "visibleTokenIds">
): Id[] {
  const keep = new Set<Id>(viewerIds)
  return Object.keys(scene.tokens)
    .filter(
      (id) =>
        !keep.has(id) &&
        (!result.visibleTokenIds.has(id) || scene.tokens[id].hidden)
    )
    .sort()
}

/** Tokens the previewed viewers' player would actually see: visible, not a viewer, not hidden. */
export function previewSeenTokens(
  scene: Pick<SceneLike, "tokens">,
  viewerIds: readonly Id[],
  result: Pick<VisibilityResult, "visibleTokenIds">
): Id[] {
  const viewers = new Set<Id>(viewerIds)
  return [...result.visibleTokenIds]
    .filter(
      (id) =>
        !viewers.has(id) &&
        Object.hasOwn(scene.tokens, id) &&
        !scene.tokens[id].hidden
    )
    .sort()
}

/** Immer patches for a scene edit (empty when the recipe changes nothing). */
export function scenePatches(
  scene: Scene,
  recipe: (draft: Draft<Scene>) => void
): Patch[] {
  const [, patches] = produceWithPatches(scene, recipe)
  return patches
}

/** Patches that hide or reveal tokens. */
export function setTokensHiddenPatches(
  scene: Scene,
  tokenIds: readonly Id[],
  hidden: boolean
): Patch[] {
  return scenePatches(scene, (d) => {
    for (const id of tokenIds)
      if (Object.hasOwn(d.tokens, id)) d.tokens[id].hidden = hidden
  })
}

/** Patches that give tokens a 3D model (`free:<id>`, Token.model) or, with null, the default body. */
export function setTokenModelPatches(
  scene: Scene,
  tokenIds: readonly Id[],
  model: string | null
): Patch[] {
  return scenePatches(scene, (d) => {
    for (const id of tokenIds) {
      if (!Object.hasOwn(d.tokens, id)) continue
      if (model === null) delete d.tokens[id].model
      else d.tokens[id].model = model
    }
  })
}

/** Patches that give tokens a portrait image (Token.imageUrl, e.g. from the Token Maker), or none. */
export function setTokenImagePatches(
  scene: Scene,
  tokenIds: readonly Id[],
  imageUrl: string | null
): Patch[] {
  return scenePatches(scene, (d) => {
    for (const id of tokenIds)
      if (Object.hasOwn(d.tokens, id)) d.tokens[id].imageUrl = imageUrl
  })
}

/** Patches that turn the sun/moon on or off. */
export function setDirectionalPatches(scene: Scene, enabled: boolean): Patch[] {
  return scenePatches(scene, (d) => {
    d.environment.directional.enabled = enabled
  })
}

/** Patches that hide or reveal objects (e.g. a light, a secret passage prop). */
export function setObjectsHiddenPatches(
  scene: Scene,
  objectIds: readonly Id[],
  hidden: boolean
): Patch[] {
  return scenePatches(scene, (d) => {
    for (const id of objectIds) {
      if (!Object.hasOwn(d.objects, id)) continue
      if (hidden) d.objects[id].hidden = true
      else delete d.objects[id].hidden
    }
  })
}
