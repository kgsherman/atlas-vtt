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
 * position, so the probe then holds every object and token.
 *
 * Terrain is checked where the patches touched it: a touched heightmap chunk (NaN / range guard; a
 * wholesale heightmap or level replacement checks every chunk), touched terrain shapes and base chunks
 * (with the level's shape / point counts), and every shape and base chunk of a level that was replaced
 * wholesale or when the root or the grid changed. Untouched chunks are trusted: the brush clamps
 * heights, the terrain bake skips non-finite values, and grid resizes crop terrain to the new lattice.
 */
import type { Patch } from "immer"

import { validateReferences } from "@/core/scene/integrity"
import { SCENE_LIMITS, sceneSchema, terrainSizeIssue } from "@/core/scene/schema"
import type { Id, Level, Scene, SceneObject, TerrainEdits, Token } from "@/core/scene/types"

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
  let allTerrain = false
  const objectIds = new Set<Id>()
  const tokenIds = new Set<Id>()
  const terrain = new Map<Id, TerrainTouch>()
  const touch = (id: Id) => {
    let t = terrain.get(id)
    if (!t) terrain.set(id, (t = { allChunks: false, chunks: new Set(), allEdits: false, edits: false, shapes: new Set(), baseChunks: new Set() }))
    return t
  }
  for (const p of patches) {
    const [root, id, field, sub, key] = p.path
    if (root === undefined || root === "grid") everything = allTerrain = true
    else if (root === "objects") {
      if (id === undefined) everything = true
      else objectIds.add(String(id))
    } else if (root === "tokens") {
      if (id === undefined) everything = true
      else tokenIds.add(String(id))
    } else if (root === "levels") {
      if (id === undefined) {
        allTerrain = true
        continue
      }
      const t = touch(String(id))
      if (field === undefined) {
        // The whole level (added, duplicated, replaced): all of its terrain.
        t.allChunks = t.allEdits = true
      } else if (field === "heightmap") {
        if (sub === "chunks" && key !== undefined) t.chunks.add(String(key))
        else t.allChunks = true
      } else if (field === "terrainEdits") {
        t.edits = true
        if (sub === "shapes" && key !== undefined) t.shapes.add(String(key))
        else if (sub === "baseChunks" && key !== undefined) t.baseChunks.add(String(key))
        else t.allEdits = true
      }
    }
  }
  if (allTerrain) for (const id of Object.keys(next.levels)) touch(id).allEdits = true

  // Terrain shape / point counts of touched levels (the probe may hold only some of their shapes).
  for (const id of terrain.keys()) {
    const issue = Object.hasOwn(next.levels, id) ? terrainSizeIssue(next.levels[id].terrainEdits) : null
    if (issue) issues.push(`levels.${id}.terrainEdits.shapes: ${issue}`)
  }
  if (issues.length > 0) return issues

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
  for (const [id, level] of Object.entries(next.levels)) levels[id] = probeLevel(level, terrain.get(id))
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

/** What an edit's patches touched of one level's terrain. */
interface TerrainTouch {
  /** The heightmap (or the level) was replaced wholesale: every chunk. */
  allChunks: boolean
  /** Touched heightmap chunk keys. */
  chunks: Set<string>
  /** The terrain edits (or the level, the level record, the root or the grid) were replaced wholesale: every shape and base chunk. */
  allEdits: boolean
  /** Something under levels/<id>/terrainEdits was touched. */
  edits: boolean
  shapes: Set<Id>
  baseChunks: Set<string>
}

/** Entries of `rec` whose keys are in `keys` (and exist). */
function pick<T>(rec: Readonly<Record<string, T>>, keys: Iterable<string>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const k of keys) if (Object.hasOwn(rec, k)) out[k] = rec[k]
  return out
}

/**
 * A level of the probe scene: without terrain when its terrain was not touched; otherwise the touched
 * heightmap chunks (all of them when the heightmap was replaced) and, when its terrain edits were touched,
 * the touched shapes and base chunks (all of them when replaced wholesale; every base chunk when the
 * heightmap was replaced, since base chunks are encoded at its resolution). A probe that carries terrain
 * edits keeps the heightmap (maybe without chunks) since terrain edits require one, and at least one shape
 * when the level has any (a record the schema requires to be non-empty).
 */
function probeLevel(level: Level, t: TerrainTouch | undefined): Level {
  const { heightmap: hm, terrainEdits: te, ...rest } = level
  const out: Level = { ...rest, heightmap: null }
  if (!t) return out
  if (hm) out.heightmap = t.allChunks ? hm : { resolution: hm.resolution, chunks: pick(hm.chunks, t.chunks) }
  // A replaced heightmap re-checks that terrain edits still have one.
  if (te && (t.allEdits || t.edits || t.allChunks)) out.terrainEdits = t.allEdits ? te : probeEdits(te, t)
  return out
}

function probeEdits(te: TerrainEdits, t: TerrainTouch): TerrainEdits {
  const shapes = pick(te.shapes, t.shapes)
  if (Object.keys(shapes).length === 0) Object.assign(shapes, pick(te.shapes, Object.keys(te.shapes).slice(0, 1)))
  return { shapes, baseChunks: t.allChunks ? te.baseChunks : pick(te.baseChunks, t.baseChunks) }
}
