/**
 * Document guard for editor edits: every revision the editor commits must still load through
 * core/scene/schema parseScene, or the next save could never be opened again (scenesRepo.load
 * rejects it). Typical offenders are geometric: objects dragged, nudged or pasted beyond the scene
 * extent (± SCENE_LIMITS.coordMargin), a grid shrunk under existing content, out-of-range numbers.
 *
 * Validating the whole document on every edit would cost O(objects + terrain samples), so only what
 * the edit's immer patches touched is checked, with the strict scene schema and the reference rules,
 * on a probe scene: the touched objects/tokens plus what they reference (host walls, openings of
 * touched walls, carrier tokens) and every level without its terrain. A grid change touches every
 * position, so the probe then holds every object and token. Heightmaps are not re-validated: the
 * brush clamps heights and grid resizes drop out-of-range chunks.
 */
import type { Patch } from "immer"

import { validateReferences } from "@/core/scene/integrity"
import { SCENE_LIMITS, sceneSchema } from "@/core/scene/schema"
import type { Id, Level, Scene, SceneObject, Token } from "@/core/scene/types"

/** Issues reported at most (the first ones are enough to explain a refusal). */
const MAX_ISSUES = 20

/** Problems that would make `next` fail parseScene, considering what `patches` changed. Empty = valid. */
export function validateEdit(next: Scene, patches: readonly Patch[]): string[] {
  const issues: string[] = []
  const counts: [string, number, number, number][] = [
    ["levels", Object.keys(next.levels).length, 1, SCENE_LIMITS.maxLevels],
    ["objects", Object.keys(next.objects).length, 0, SCENE_LIMITS.maxObjects],
    ["tokens", Object.keys(next.tokens).length, 0, SCENE_LIMITS.maxTokens],
  ]
  for (const [key, n, min, max] of counts) {
    if (n < min || n > max) issues.push(`${key}: expected ${min}..${max} entries, got ${n}`)
  }
  if (issues.length > 0) return issues

  let everything = false
  const objectIds = new Set<Id>()
  const tokenIds = new Set<Id>()
  for (const p of patches) {
    const [root, id] = p.path
    if (root === undefined || root === "grid") everything = true
    else if (root === "objects") {
      if (id === undefined) everything = true
      else objectIds.add(String(id))
    } else if (root === "tokens") {
      if (id === undefined) everything = true
      else tokenIds.add(String(id))
    }
  }

  const objects: Record<Id, SceneObject> = {}
  const tokens: Record<Id, Token> = {}
  if (everything) {
    Object.assign(objects, next.objects)
    Object.assign(tokens, next.tokens)
  } else {
    const includeObject = (id: Id) => {
      if (Object.hasOwn(next.objects, id)) objects[id] = next.objects[id]
    }
    const includeToken = (id: Id) => {
      if (Object.hasOwn(next.tokens, id)) tokens[id] = next.tokens[id]
    }
    for (const id of objectIds) includeObject(id)
    for (const id of tokenIds) includeToken(id)
    const walls = new Set<Id>()
    for (const o of Object.values(objects)) {
      if (o.type === "wall") walls.add(o.id)
      else if (o.type === "door" || o.type === "window") includeObject(o.wallId)
      else if (o.type === "light" && o.attachedTokenId) includeToken(o.attachedTokenId)
    }
    // Openings must still fit a touched wall (one pass over the objects, only when walls changed).
    if (walls.size > 0) {
      for (const o of Object.values(next.objects)) {
        if ((o.type === "door" || o.type === "window") && walls.has(o.wallId)) objects[o.id] = o
      }
    }
  }

  const levels: Record<Id, Level> = {}
  for (const [id, level] of Object.entries(next.levels)) levels[id] = level.heightmap ? { ...level, heightmap: null } : level
  const probe: Scene = { ...next, levels, objects, tokens }
  const parsed = sceneSchema.safeParse(probe)
  if (!parsed.success) {
    return parsed.error.issues.slice(0, MAX_ISSUES).map((i) => {
      const path = i.path.map(String).join(".")
      return path ? `${path}: ${i.message}` : i.message
    })
  }
  return validateReferences(probe).slice(0, MAX_ISSUES)
}
