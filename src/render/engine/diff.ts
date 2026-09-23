/**
 * Scene revision diffing for incremental rebuilds:
 *  - diffScenes: a SceneChange computed from two revisions (used when updateScene gets no change);
 *  - classifyStructure: whether a structural change needs a geometry rebuild or is environment-only;
 *  - invalidation: which level buckets must be rebuilt for changed objects/tokens/terrain
 *    (invalidateTerrain: the marks of one level's terrain change, for the engine's in-place commits);
 *  - occlusionClosure: changed ids plus the sources whose occluders depend on them;
 *  - heightmapDiffRect: world rect covering the heightmap chunks that differ.
 */
import { floorCutouts, lightLevelId } from "@/core/scene/queries"
import type { GridSettings, Id, Level, Rect, SceneLike, SceneObject } from "@/core/scene/types"

import type { BucketKind } from "../builders/types"
import type { SceneChange } from "../contracts"

/** Structural equality for JSON-like values (plain objects, arrays, primitives, typed arrays). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return Number.isNaN(a) && Number.isNaN(b)
  if (Array.isArray(a) || ArrayBuffer.isView(a)) {
    if (!(Array.isArray(b) || ArrayBuffer.isView(b))) return false
    const x = a as ArrayLike<unknown>
    const y = b as ArrayLike<unknown>
    if (x.length !== y.length) return false
    for (let k = 0; k < x.length; k++) if (!deepEqual(x[k], y[k])) return false
    return true
  }
  if (Array.isArray(b) || ArrayBuffer.isView(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.hasOwn(b, k) || !deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  }
  return true
}

function changedKeys<T>(prev: Record<string, T>, next: Record<string, T>): string[] {
  const out: string[] = []
  for (const id of Object.keys(prev)) {
    if (!Object.hasOwn(next, id) || (prev[id] !== next[id] && !deepEqual(prev[id], next[id]))) out.push(id)
  }
  for (const id of Object.keys(next)) if (!Object.hasOwn(prev, id)) out.push(id)
  return out.sort()
}

const levelShapeEqual = (a: Level, b: Level) =>
  a.id === b.id && a.name === b.name && a.elevation === b.elevation && a.height === b.height && a.floorThickness === b.floorThickness

/** Change between two revisions (reference checks first, structural comparison on mismatch). */
export function diffScenes(prev: SceneLike, next: SceneLike): SceneChange {
  const change: SceneChange = {}
  const objects = prev.objects === next.objects ? [] : changedKeys(prev.objects, next.objects)
  const tokens = prev.tokens === next.tokens ? [] : changedKeys(prev.tokens, next.tokens)
  if (objects.length) change.objects = objects
  if (tokens.length) change.tokens = tokens
  const s = classifyStructure(prev, next)
  if (s.geometry || s.environment) change.structure = true
  if (!s.geometry && prev.levels !== next.levels) {
    const terrain = Object.keys(next.levels).filter((id) => {
      const a = prev.levels[id].heightmap
      const b = next.levels[id].heightmap
      return a !== b && !deepEqual(a, b)
    })
    if (terrain.length) change.terrain = terrain.sort()
  }
  return change
}

/** What a structural change touches: level/grid geometry (full rebuild) and/or the environment. */
export function classifyStructure(prev: SceneLike, next: SceneLike): { geometry: boolean; environment: boolean } {
  let geometry = prev.grid !== next.grid && !deepEqual(prev.grid, next.grid)
  if (!geometry && prev.levels !== next.levels) {
    const a = Object.keys(prev.levels)
    const b = Object.keys(next.levels)
    geometry = a.length !== b.length || a.some((id) => !Object.hasOwn(next.levels, id) || !levelShapeEqual(prev.levels[id], next.levels[id]))
  }
  const environment = prev.environment !== next.environment && !deepEqual(prev.environment, next.environment)
  return { geometry, environment }
}

// ---------------------------------------------------------------------------
// Visual invalidation
// ---------------------------------------------------------------------------

/** Fields that never change geometry (door state only drives the leaf animation). */
function visualShape(o: SceneObject): unknown {
  const { name: _n, dmNotes: _d, editorLocked: _e, hidden: _h, ...rest } = o
  if (rest.type === "door") {
    const { state: _s, ...door } = rest
    return door
  }
  return rest
}

export class Invalidation {
  readonly buckets = new Map<Id, Set<BucketKind>>()
  tokens = false

  mark(levelId: Id, ...kinds: BucketKind[]): void {
    let set = this.buckets.get(levelId)
    if (!set) this.buckets.set(levelId, (set = new Set()))
    for (const k of kinds) set.add(k)
  }

  has(levelId: Id, kind: BucketKind): boolean {
    return this.buckets.get(levelId)?.has(kind) ?? false
  }
}

export const ALL_BUCKETS: readonly BucketKind[] = ["floors", "walls", "doors", "connectors", "pillars", "props", "fixtures"]

function cutoutsChanged(prev: SceneLike, next: SceneLike, levelId: Id): boolean {
  return !deepEqual(floorCutouts(prev, levelId), floorCutouts(next, levelId))
}

/** Buckets to rebuild for a change. */
export function invalidation(prev: SceneLike, next: SceneLike, change: SceneChange): Invalidation {
  const inv = new Invalidation()
  let connectorsChanged = false
  for (const id of change.objects ?? []) {
    const po = Object.hasOwn(prev.objects, id) ? prev.objects[id] : undefined
    const no = Object.hasOwn(next.objects, id) ? next.objects[id] : undefined
    if (po && no && deepEqual(visualShape(po), visualShape(no))) continue
    for (const [o, scene] of [
      [po, prev],
      [no, next],
    ] as const) {
      if (!o) continue
      switch (o.type) {
        case "floor":
          inv.mark(o.levelId, "floors")
          break
        case "wall":
        case "door":
          inv.mark(o.levelId, "walls", "doors")
          break
        case "window":
          inv.mark(o.levelId, "walls")
          break
        case "connector":
          inv.mark(o.levelId, "connectors")
          connectorsChanged = true
          break
        case "pillar":
          inv.mark(o.levelId, "pillars")
          break
        case "prop":
          inv.mark(o.levelId, "props")
          break
        case "light":
          inv.mark(lightLevelId(scene, o), "fixtures")
          break
      }
    }
  }
  if (connectorsChanged) {
    for (const levelId of Object.keys(next.levels)) if (cutoutsChanged(prev, next, levelId)) inv.mark(levelId, "floors")
  }
  const tokens = new Set(change.tokens ?? [])
  if (tokens.size > 0) {
    inv.tokens = true
    // Lights carried by a changed token move with it.
    for (const scene of [prev, next]) {
      for (const o of Object.values(scene.objects)) {
        if (o.type === "light" && o.attachedTokenId && tokens.has(o.attachedTokenId)) inv.mark(lightLevelId(scene, o), "fixtures")
      }
    }
  }
  for (const levelId of change.terrain ?? []) invalidateTerrain(inv, next, levelId)
  return inv
}

/**
 * Marks of a terrain change of a level: its buckets `kinds` (everything stands on the ground; the engine
 * passes fewer when it moved the terrain mesh in place and only some objects stand on the changed area),
 * the connectors of other levels climbing to it, and the tokens.
 */
export function invalidateTerrain(inv: Invalidation, next: SceneLike, levelId: Id, kinds: readonly BucketKind[] = ALL_BUCKETS): void {
  if (!Object.hasOwn(next.levels, levelId)) return
  inv.mark(levelId, ...kinds)
  // Stairs/ramps/ladders climbing to this level end on its ground.
  for (const o of Object.values(next.objects)) if (o.type === "connector" && o.toLevelId === levelId) inv.mark(o.levelId, "connectors")
  inv.tokens = true
}

// ---------------------------------------------------------------------------
// Occlusion
// ---------------------------------------------------------------------------

const JOINT = 1e-3

/**
 * Changed object ids plus the sources whose occluders depend on them: openings of changed walls,
 * host walls of changed openings, walls joined at a changed wall's endpoints, and floors whose
 * connector cutouts changed. core/occlusion computes its own closure as well; the extra ids only
 * cost CPU (unchanged primitives produce no dirty regions).
 */
export function occlusionClosure(prev: SceneLike, next: SceneLike, objectIds: readonly Id[]): Id[] {
  const out = new Set<Id>(objectIds)
  let connectors = false
  for (const id of objectIds) {
    for (const scene of [prev, next]) {
      if (!Object.hasOwn(scene.objects, id)) continue
      const o = scene.objects[id]
      if (o.type === "door" || o.type === "window") out.add(o.wallId)
      else if (o.type === "connector") connectors = true
      else if (o.type === "wall") {
        for (const q of Object.values(scene.objects)) {
          if ((q.type === "door" || q.type === "window") && q.wallId === id) out.add(q.id)
          if (q.type === "wall" && q.id !== id && q.levelId === o.levelId) {
            for (const p of [o.a, o.b]) {
              if (Math.hypot(q.a.x - p.x, q.a.z - p.z) <= JOINT || Math.hypot(q.b.x - p.x, q.b.z - p.z) <= JOINT) out.add(q.id)
            }
          }
        }
      }
    }
  }
  if (connectors) {
    for (const levelId of Object.keys(next.levels)) {
      if (!cutoutsChanged(prev, next, levelId)) continue
      for (const o of Object.values(next.objects)) if (o.type === "floor" && o.levelId === levelId) out.add(o.id)
    }
  }
  return [...out].sort()
}

/** Full extent of the grid (feet). */
export function gridRect(grid: Pick<GridSettings, "width" | "depth" | "cellSize">): Rect {
  return { x: 0, z: 0, w: grid.width * grid.cellSize, d: grid.depth * grid.cellSize }
}

/** World rect covering the heightmap chunks that differ between two revisions (shared with core/occlusion). */
export { heightmapDiffRect } from "@/core/occlusion"
