/**
 * Map immer patches on a Scene to the engine's incremental SceneChange (render/contracts.ts), so the
 * canvas can call engine.updateScene(scene, change) without the engine diffing whole revisions.
 */
import type { Patch } from "immer"

import type { Id } from "@/core/scene/types"
import type { SceneChange } from "@/render/contracts"

export function sceneChangeFromPatches(patches: readonly Patch[]): SceneChange {
  const objects = new Set<Id>()
  const tokens = new Set<Id>()
  const terrain = new Set<Id>()
  let structure = false
  for (const p of patches) {
    const [root, id, field] = p.path
    if (root === undefined) {
      structure = true
      continue
    }
    switch (root) {
      case "objects":
        if (id === undefined) structure = true
        else objects.add(String(id))
        break
      case "tokens":
        if (id === undefined) structure = true
        else tokens.add(String(id))
        break
      case "levels":
        // Terrain edits touch only levels/<id>/heightmap/...; levels/<id>/terrainEdits/... is DM-only
        // editing data with no visual effect (its baked result arrives as heightmap patches); anything
        // else about a level is structural.
        if (id === undefined) structure = true
        else if (field === "heightmap") terrain.add(String(id))
        else if (field !== "terrainEdits") structure = true
        break
      case "grid":
      case "environment":
        structure = true
        break
      default:
        // name, meta, timestamps, id: no visual effect.
        break
    }
  }
  const change: SceneChange = {}
  if (objects.size > 0) change.objects = [...objects].sort()
  if (tokens.size > 0) change.tokens = [...tokens].sort()
  if (terrain.size > 0) change.terrain = [...terrain].sort()
  if (structure) change.structure = true
  return change
}
