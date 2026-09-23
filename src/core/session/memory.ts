/**
 * Per-player knowledge (docs/ARCHITECTURE.md §5.4, §6.2 "updateKnowledge"):
 *  - explored |= perceived (sub-cell partials included);
 *  - memory: every observed object overwrites `memory[uid][id]` with its sanitised current state;
 *    remembered entries whose remembered footprint lies in a perceived cell but whose object no longer
 *    exists, became hidden/unmemorable, or changed (i.e. it is not where the player remembers it) are
 *    deleted. Everything else is untouched, so DM edits out of sight stay invisible;
 *  - secret doors observed open are revealed to the player.
 * Hidden objects, attached lights and unrevealed secret doors are never remembered.
 */
import { floorRects, groundHeightAt } from "../scene/queries"
import type { ConnectorObject, Id, LightObject, Scene, SceneLike, SceneObject } from "../scene/types"
import { cloneCellMask, isEmptyMask, orInto, perceivedCells } from "../vision/mask"
import { maskHasPoint, maskTouchesShape, objectFootprint, type ObjectFootprint } from "../vision/observe"
import type { EncodedMask, GradeMask, VisibilityResult } from "../vision/types"
import { decodeMaskCached, encodeMaskCached, maskMatchesGrid } from "./masks"
import { memorable, sanitizeObject, type MemoryFloor } from "./sanitize"
import { own } from "./state"
import type { GameState, PlayerObject } from "./types"
import { deepEqual } from "./util"

/**
 * The scene object a memory entry was last produced from (or verified against). While an entry's
 * source is the current scene object (scene objects are immutable revisions), it is unchanged.
 */
const memorySource = new WeakMap<PlayerObject, SceneObject>()

const connectorCache = new WeakMap<object, Record<Id, ConnectorObject>>()

/** The scene's connectors only (all groundHeightAt needs besides levels and grid). */
export function connectorsOnly(scene: Pick<SceneLike, "objects">): Record<Id, ConnectorObject> {
  let out = connectorCache.get(scene.objects)
  if (!out) {
    out = {}
    for (const o of Object.values(scene.objects)) if (o.type === "connector") out[o.id] = o
    connectorCache.set(scene.objects, out)
  }
  return out
}

/** World Y of a static light (ground under it, stairs included, + its height). */
export function staticLightWorldY(scene: Pick<SceneLike, "levels" | "grid" | "objects">): (l: LightObject) => number {
  const lite = { levels: scene.levels, grid: scene.grid, objects: connectorsOnly(scene) }
  return (l) => groundHeightAt(lite, l.levelId, l.position) + l.position.y
}

/** Footprint of a remembered object (openings use the remembered host wall, else the current one). */
export function rememberedFootprint(entry: PlayerObject, memory: Readonly<Record<Id, PlayerObject>>, scene: Pick<Scene, "objects">): ObjectFootprint | null {
  switch (entry.type) {
    case "light":
      return null
    case "floor": {
      // Masked floors: the remembered coverage (a perceived cell outside the mask does not see the floor).
      const shapes = floorRects(entry as MemoryFloor).map((r) => ({ x0: r.x, z0: r.z, x1: r.x + r.w, z1: r.z + r.d, pts: null }))
      return { levelIds: [entry.levelId], shapes }
    }
    case "door":
    case "window": {
      const host = own(memory, entry.wallId)?.type === "wall" ? { objects: memory as unknown as Record<Id, SceneObject> } : scene
      return objectFootprint(host, entry as unknown as SceneObject, () => [])
    }
    default:
      return objectFootprint({ objects: {} }, entry as unknown as SceneObject, () => [])
  }
}

function footprintPerceived(fp: ObjectFootprint, perception: Readonly<Record<Id, GradeMask>>, cellSize: number): boolean {
  for (const levelId of fp.levelIds) {
    const m = own(perception, levelId)
    if (!m) continue
    for (const shape of fp.shapes) if (maskTouchesShape(m, cellSize, shape)) return true
  }
  return false
}

function rememberedPerceived(entry: PlayerObject, memory: Readonly<Record<Id, PlayerObject>>, scene: Scene, perception: Readonly<Record<Id, GradeMask>>): boolean {
  const cellSize = scene.grid.cellSize
  if (entry.type === "light") {
    const m = own(perception, entry.levelId)
    return m !== undefined && maskHasPoint(m, cellSize, entry.position.x, entry.position.z)
  }
  const fp = rememberedFootprint(entry, memory, scene)
  return fp !== null && footprintPerceived(fp, perception, cellSize)
}

/** explored |= perceived for one player. Returns the same record when nothing changed. */
function mergeExplored(prev: Readonly<Record<Id, EncodedMask>>, scene: Scene, vis: VisibilityResult): Record<Id, EncodedMask> {
  let out: Record<Id, EncodedMask> | null = null
  for (const levelId of Object.keys(vis.perception)) {
    if (!Object.hasOwn(scene.levels, levelId)) continue
    const gm = vis.perception[levelId]
    // A result computed for another grid revision is stale: ignore it.
    if (!maskMatchesGrid(gm, scene.grid)) continue
    const perceived = perceivedCells(gm)
    const cur = own(prev, levelId)
    let next: EncodedMask | null = null
    if (!cur || !maskMatchesGrid(cur, scene.grid)) {
      if (!isEmptyMask(perceived)) next = encodeMaskCached(perceived)
    } else {
      const m = cloneCellMask(decodeMaskCached(cur))
      if (orInto(m, perceived)) next = encodeMaskCached(m)
    }
    if (next) {
      out ??= { ...prev }
      out[levelId] = next
    }
  }
  return out ?? (prev as Record<Id, EncodedMask>)
}

/** OR perceived cells into explored, refresh memory from observation (§5.4), auto-reveal secret doors. */
export function updateKnowledge(state: GameState, userId: string, vis: VisibilityResult): GameState {
  const scene = state.scene
  const prevExplored = own(state.explored, userId) ?? {}
  const explored = mergeExplored(prevExplored, scene, vis)

  // Secret doors observed open are revealed (before memory, so they are remembered right away).
  const prevRevealed = own(state.revealed, userId) ?? []
  const revealedSet = new Set(prevRevealed)
  for (const id of vis.observedObjectIds) {
    const o = own(scene.objects, id)
    if (o && o.type === "door" && o.style === "secret" && o.state === "open" && !o.hidden) revealedSet.add(id)
  }
  const revealed = revealedSet.size === prevRevealed.length ? prevRevealed : [...revealedSet].sort()

  const mem = own(state.memory, userId) ?? {}
  // Copy-on-write of the player's memory record.
  const edits: { next: Record<Id, PlayerObject> | null } = { next: null }
  const write = (id: Id, v: PlayerObject | null) => {
    const rec = (edits.next ??= { ...mem })
    if (v) rec[id] = v
    else delete rec[id]
  }
  const lightY = staticLightWorldY(scene)

  for (const id of vis.observedObjectIds) {
    const o = own(scene.objects, id)
    if (!o) continue
    const prev = own(mem, id)
    if (!memorable(o, revealedSet)) {
      if (prev) write(id, null)
      continue
    }
    if (prev && memorySource.get(prev) === o) continue
    const s = sanitizeObject(o, lightY)
    if (prev && deepEqual(prev, s)) {
      memorySource.set(prev, o)
      continue
    }
    memorySource.set(s, o)
    write(id, s)
  }

  // Deletion rule: a remembered thing the player is looking at right now but does not observe is gone.
  for (const id of Object.keys(mem)) {
    if (vis.observedObjectIds.has(id)) continue
    const entry = mem[id]
    const o = own(scene.objects, id)
    if (o && memorable(o, revealedSet)) {
      if (memorySource.get(entry) === o) continue
      if (deepEqual(entry, sanitizeObject(o, lightY))) {
        memorySource.set(entry, o)
        continue
      }
    }
    if (rememberedPerceived(entry, mem, scene, vis.perception)) write(id, null)
  }

  const nextMemory = edits.next
  if (explored === prevExplored && revealed === prevRevealed && nextMemory === null) return state
  const out: GameState = { ...state }
  if (explored !== prevExplored) out.explored = { ...state.explored, [userId]: explored }
  if (revealed !== prevRevealed) out.revealed = { ...state.revealed, [userId]: revealed }
  if (nextMemory !== null) out.memory = { ...state.memory, [userId]: nextMemory }
  return out
}
