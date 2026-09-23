/**
 * Referential integrity for the scene document (docs/ARCHITECTURE.md §7). All mutators operate on
 * an immer draft or a plain mutable Scene; nothing here keeps references into the document.
 */
import { PROP_LIBRARY } from "./defaults"
import { newId } from "./factory"
import {
  groundHeightAt,
  lightLevelId,
  lightWorldPosition,
  openingSegment,
  sortedLevels,
  tokenRect,
  wallDirection,
  wallLength,
  wallOpenings,
} from "./queries"
import type { Id, LightObject, Rect, Scene, SceneObject, Token, Vec2, WallObject } from "./types"

export interface AtlasClipboard {
  kind: "atlas-clipboard"
  schemaVersion: number
  /** Level the selection was copied from (pasted objects are remapped to the target level). */
  sourceLevelId: Id
  /** Anchor point (centre of the selection bounds) used to place the paste at the pointer. */
  origin: Vec2
  objects: SceneObject[]
  tokens: Token[]
  /**
   * Relative order (in the source scene's sortedLevels) of every level the clipboard references,
   * with sourceLevelId = 0. Lets a paste into another scene keep multi-level selections stacked.
   * When absent, the target scene's own level order is used.
   */
  levelOffsets?: Record<Id, number>
  /** World XZ centre of every copied door/window at copy time (lets a paste re-host openings copied without their wall). */
  openingCenters?: Record<Id, Vec2>
}

/** Openings must satisfy width/2 − ε ≤ offset ≤ length − width/2 + ε on their wall. */
export const OPENING_FIT_EPS = 1e-3

/** Endpoint coincidence tolerance (feet), matching the wall-joint rule of ARCHITECTURE §2. */
const POINT_EPS = 1e-3

const hasOwn = (o: object, k: string) => Object.hasOwn(o, k)
/** Deep copy that also works on immer drafts (structuredClone rejects Proxies). The scene is JSON. */
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const samePoint = (p: Vec2, q: Vec2) => Math.abs(p.x - q.x) <= POINT_EPS && Math.abs(p.z - q.z) <= POINT_EPS

export function openingFits(wallLen: number, offset: number, width: number): boolean {
  return offset >= width / 2 - OPENING_FIT_EPS && offset <= wallLen - width / 2 + OPENING_FIT_EPS
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete ids (levels, objects or tokens) and everything that depends on them:
 *  - wall → its openings;
 *  - level → its objects, its tokens, and connectors leading to it (toLevelId);
 *  - token → lights attached to it are detached and kept at their current world position (on the
 *    token's level, y relative to that level's ground) — unless the token's level is deleted too,
 *    in which case they go with it.
 * Lights attached to a surviving token are never deleted as part of a level (they follow the token);
 * if their stored levelId is deleted they are re-homed to the token's level.
 * Deleting every level leaves an invalid document; the editor must prevent that.
 */
export function deleteWithDependents(draft: Scene, ids: Id[]): void {
  const explicit = new Set(ids)
  const levelIds = new Set<Id>()
  const objectIds = new Set<Id>()
  const tokenIds = new Set<Id>()
  for (const id of ids) {
    if (hasOwn(draft.levels, id)) levelIds.add(id)
    else if (hasOwn(draft.objects, id)) objectIds.add(id)
    else if (hasOwn(draft.tokens, id)) tokenIds.add(id)
  }

  const objects = Object.values(draft.objects)
  for (const o of objects) {
    if (levelIds.has(o.levelId)) objectIds.add(o.id)
    if (o.type === "connector" && levelIds.has(o.toLevelId)) objectIds.add(o.id)
  }
  for (const t of Object.values(draft.tokens)) {
    if (levelIds.has(t.levelId)) tokenIds.add(t.id)
  }
  // Openings of deleted walls (walls deleted directly or with their level).
  for (const o of objects) {
    if ((o.type === "door" || o.type === "window") && objectIds.has(o.wallId)) objectIds.add(o.id)
  }

  // Attached lights depend on their carrier, not on their stored levelId.
  const detach: { id: Id; levelId: Id; world: { x: number; y: number; z: number } }[] = []
  const rehome: { id: Id; levelId: Id }[] = []
  for (const o of objects) {
    if (o.type !== "light" || !o.attachedTokenId || !hasOwn(draft.tokens, o.attachedTokenId)) continue
    if (explicit.has(o.id)) continue
    const carrier = draft.tokens[o.attachedTokenId]
    if (tokenIds.has(carrier.id)) {
      if (levelIds.has(carrier.levelId)) {
        objectIds.add(o.id)
      } else {
        objectIds.delete(o.id)
        // Resolve against the scene BEFORE anything is removed.
        detach.push({ id: o.id, levelId: carrier.levelId, world: lightWorldPosition(draft, o) })
      }
    } else {
      objectIds.delete(o.id)
      if (levelIds.has(o.levelId)) rehome.push({ id: o.id, levelId: carrier.levelId })
    }
  }

  for (const id of objectIds) delete draft.objects[id]
  for (const id of tokenIds) delete draft.tokens[id]
  for (const id of levelIds) delete draft.levels[id]

  for (const { id, levelId } of rehome) {
    const light = draft.objects[id] as LightObject
    light.levelId = levelId
  }
  // Ground is evaluated on the final document so lightWorldPosition() reproduces the old world point.
  for (const { id, levelId, world } of detach) {
    const light = draft.objects[id] as LightObject
    light.attachedTokenId = null
    light.levelId = levelId
    light.position = { x: world.x, y: world.y - groundHeightAt(draft, levelId, world), z: world.z }
  }
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

function rectFromPoints(points: Vec2[], pad = 0): Rect {
  let x0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let z1 = -Infinity
  for (const p of points) {
    x0 = Math.min(x0, p.x)
    z0 = Math.min(z0, p.z)
    x1 = Math.max(x1, p.x)
    z1 = Math.max(z1, p.z)
  }
  return { x: x0 - pad, z: z0 - pad, w: x1 - x0 + 2 * pad, d: z1 - z0 + 2 * pad }
}

function unionRects(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b
  if (!b) return a
  const x0 = Math.min(a.x, b.x)
  const z0 = Math.min(a.z, b.z)
  return { x: x0, z: z0, w: Math.max(a.x + a.w, b.x + b.w) - x0, d: Math.max(a.z + a.d, b.z + b.d) - z0 }
}

/** XZ bounding rect of an object's footprint (lights: their resolved point). null if unresolvable. */
export function objectBounds(scene: Scene, o: SceneObject): Rect | null {
  switch (o.type) {
    case "floor":
    case "connector":
      return { ...o.rect }
    case "wall":
      return rectFromPoints([o.a, o.b], o.thickness / 2)
    case "door":
    case "window": {
      const host = hasOwn(scene.objects, o.wallId) ? scene.objects[o.wallId] : undefined
      if (!host || host.type !== "wall") return null
      const seg = openingSegment(host, o)
      return rectFromPoints([seg.a, seg.b], host.thickness / 2)
    }
    case "pillar":
      return rectFromPoints([o.position], o.size / 2)
    case "prop": {
      const def = PROP_LIBRARY[o.kind]
      const hx = (def.size.x * o.scale.x) / 2
      const hz = (def.size.z * o.scale.z) / 2
      const c = Math.abs(Math.cos(o.rotationY))
      const s = Math.abs(Math.sin(o.rotationY))
      const ex = c * hx + s * hz
      const ez = s * hx + c * hz
      return { x: o.position.x - ex, z: o.position.z - ez, w: 2 * ex, d: 2 * ez }
    }
    case "light": {
      const p = lightWorldPosition(scene, o)
      return { x: p.x, z: p.z, w: 0, d: 0 }
    }
  }
}

/** Union of the footprints of the given objects/tokens (unknown ids ignored); null if none. */
export function selectionBounds(scene: Scene, ids: Id[]): Rect | null {
  let out: Rect | null = null
  for (const id of ids) {
    if (hasOwn(scene.objects, id)) out = unionRects(out, objectBounds(scene, scene.objects[id]))
    else if (hasOwn(scene.tokens, id)) out = unionRects(out, tokenRect(scene, scene.tokens[id]))
  }
  return out
}

// ---------------------------------------------------------------------------
// Copy / paste
// ---------------------------------------------------------------------------

/**
 * Copy exactly the selected objects and tokens, plus the openings of selected walls. Lights attached
 * to a token that is not copied are detached in the clipboard at their current world position.
 * `sourceLevelId` defaults to the lowest level (by elevation) among the copied items.
 */
export function copySelection(scene: Scene, ids: Id[], opts: { sourceLevelId?: Id } = {}): AtlasClipboard {
  const objects: SceneObject[] = []
  const tokens: Token[] = []
  const taken = new Set<Id>()
  const addObject = (o: SceneObject) => {
    if (taken.has(o.id)) return
    taken.add(o.id)
    objects.push(clone(o))
  }
  for (const id of ids) {
    if (hasOwn(scene.objects, id)) {
      const o = scene.objects[id]
      addObject(o)
      if (o.type === "wall") for (const opening of wallOpenings(scene, o.id)) addObject(opening)
    } else if (hasOwn(scene.tokens, id) && !taken.has(id)) {
      taken.add(id)
      tokens.push(clone(scene.tokens[id]))
    }
  }

  const copiedTokens = new Map(tokens.map((t) => [t.id, t]))
  for (const o of objects) {
    if (o.type !== "light" || !o.attachedTokenId) continue
    const carrier = copiedTokens.get(o.attachedTokenId)
    if (carrier) {
      // Travels with its carrier: keep the offset, align the stored level with the carrier's.
      o.levelId = carrier.levelId
      continue
    }
    const src = scene.objects[o.id] as LightObject
    if (hasOwn(scene.tokens, o.attachedTokenId)) {
      const levelId = lightLevelId(scene, src)
      const w = lightWorldPosition(scene, src)
      o.levelId = levelId
      o.position = { x: w.x, y: w.y - groundHeightAt(scene, levelId, w), z: w.z }
    }
    o.attachedTokenId = null
  }

  const levels = sortedLevels(scene)
  const indexOf = (id: Id) => levels.findIndex((l) => l.id === id)
  const referenced = new Set<Id>()
  for (const o of objects) {
    referenced.add(o.levelId)
    if (o.type === "connector") referenced.add(o.toLevelId)
  }
  for (const t of tokens) referenced.add(t.levelId)

  let sourceLevelId = opts.sourceLevelId !== undefined && hasOwn(scene.levels, opts.sourceLevelId) ? opts.sourceLevelId : undefined
  if (sourceLevelId === undefined) {
    let best = Infinity
    for (const o of objects) {
      const k = indexOf(o.levelId)
      if (k >= 0 && k < best) best = k
    }
    for (const t of tokens) {
      const k = indexOf(t.levelId)
      if (k >= 0 && k < best) best = k
    }
    sourceLevelId = Number.isFinite(best) ? levels[best].id : (levels[0]?.id ?? "")
  }
  const srcIdx = indexOf(sourceLevelId)
  const levelOffsets: Record<Id, number> = {}
  for (const id of referenced) {
    const k = indexOf(id)
    if (k >= 0 && srcIdx >= 0) levelOffsets[id] = k - srcIdx
  }

  const openingCenters: Record<Id, Vec2> = {}
  for (const o of objects) {
    if (o.type !== "door" && o.type !== "window") continue
    const host = hasOwn(scene.objects, o.wallId) ? scene.objects[o.wallId] : undefined
    if (!host || host.type !== "wall") continue
    const seg = openingSegment(host, o)
    openingCenters[o.id] = { x: (seg.a.x + seg.b.x) / 2, z: (seg.a.z + seg.b.z) / 2 }
  }

  const bounds = selectionBounds(scene, [...objects.map((o) => o.id), ...tokens.map((t) => t.id)])
  const origin = bounds ? { x: bounds.x + bounds.w / 2, z: bounds.z + bounds.d / 2 } : { x: 0, z: 0 }
  return { kind: "atlas-clipboard", schemaVersion: scene.schemaVersion, sourceLevelId, origin, objects, tokens, levelOffsets, openingCenters }
}

/**
 * Paste with fresh ids so the clipboard's origin lands at `at` on `targetLevelId`. Returns the new
 * ids (objects, then tokens).
 *  - Levels: sourceLevelId → targetLevelId; other levels keep their relative order offset. Items
 *    whose mapped level does not exist are dropped.
 *  - Openings whose wall was not pasted are dropped — except openings copied WITHOUT their wall when
 *    `hostWallId` names a wall (e.g. the wall under the pointer): they are re-hosted on it, centred on
 *    the projection of their translated centre, if they fit.
 *  - Connectors lead to the level directly above their (mapped) level, or are dropped.
 *  - Lights attached to a token that was not pasted are detached.
 *  - When the clipboard holds a connector, the translation is rounded to whole cells so connector
 *    rects stay cell-aligned.
 */
export function pasteClipboard(draft: Scene, clip: AtlasClipboard, opts: { targetLevelId: Id; at: Vec2; hostWallId?: Id }): Id[] {
  const levels = sortedLevels(draft)
  const targetIdx = levels.findIndex((l) => l.id === opts.targetLevelId)
  if (targetIdx < 0) return []
  const draftSrcIdx = levels.findIndex((l) => l.id === clip.sourceLevelId)
  const offsetOf = (levelId: Id): number | undefined => {
    if (clip.levelOffsets && hasOwn(clip.levelOffsets, levelId)) return clip.levelOffsets[levelId]
    if (levelId === clip.sourceLevelId) return 0
    if (draftSrcIdx >= 0) {
      const k = levels.findIndex((l) => l.id === levelId)
      if (k >= 0) return k - draftSrcIdx
    }
    return undefined
  }
  const mapLevel = (levelId: Id): Id | undefined => {
    const off = offsetOf(levelId)
    return off === undefined ? undefined : levels[targetIdx + off]?.id
  }
  const levelAbove = (levelId: Id): Id | undefined => {
    const k = levels.findIndex((l) => l.id === levelId)
    return k >= 0 ? levels[k + 1]?.id : undefined
  }

  let dx = opts.at.x - clip.origin.x
  let dz = opts.at.z - clip.origin.z
  if (clip.objects.some((o) => o.type === "connector")) {
    const s = draft.grid.cellSize
    dx = Math.round(dx / s) * s
    dz = Math.round(dz / s) * s
  }
  const move = (p: Vec2): Vec2 => ({ x: p.x + dx, z: p.z + dz })

  const clipWallIds = new Set(clip.objects.filter((o) => o.type === "wall").map((o) => o.id))
  const hostCandidate = opts.hostWallId !== undefined && hasOwn(draft.objects, opts.hostWallId) ? draft.objects[opts.hostWallId] : undefined
  const hostWall = hostCandidate?.type === "wall" ? hostCandidate : undefined

  const idMap = new Map<Id, Id>()
  const newObjectIds: Id[] = []
  const newTokenIds: Id[] = []

  for (const src of clip.tokens) {
    const levelId = mapLevel(src.levelId)
    if (!levelId) continue
    const t = clone(src)
    t.id = newId()
    t.levelId = levelId
    t.position = move(t.position)
    idMap.set(src.id, t.id)
    draft.tokens[t.id] = t
    newTokenIds.push(t.id)
  }

  // Walls before openings so openings can find their host's new id.
  const rank = (o: SceneObject) => (o.type === "wall" ? 0 : o.type === "door" || o.type === "window" ? 2 : 1)
  const ordered = [...clip.objects].sort((a, b) => rank(a) - rank(b))
  for (const src of ordered) {
    const o = clone(src)
    if ((o.type === "door" || o.type === "window") && !clipWallIds.has(o.wallId)) {
      // Copied without its wall: re-host on the wall under the pointer, or drop.
      const centre = clip.openingCenters?.[src.id]
      if (!hostWall || !centre) continue
      const dir = wallDirection(hostWall)
      const c = move(centre)
      const offset = (c.x - hostWall.a.x) * dir.x + (c.z - hostWall.a.z) * dir.z
      if (!openingFits(wallLength(hostWall), offset, o.width)) continue
      o.wallId = hostWall.id
      o.levelId = hostWall.levelId
      o.offset = offset
      o.id = newId()
      idMap.set(src.id, o.id)
      draft.objects[o.id] = o
      newObjectIds.push(o.id)
      continue
    }
    const levelId = mapLevel(o.levelId)
    if (!levelId) continue
    o.levelId = levelId
    switch (o.type) {
      case "floor":
        o.rect = { ...o.rect, ...move(o.rect) }
        break
      case "wall":
        o.a = move(o.a)
        o.b = move(o.b)
        break
      case "door":
      case "window": {
        const wallId = idMap.get(o.wallId)
        if (!wallId) continue
        o.wallId = wallId
        o.levelId = (draft.objects[wallId] as WallObject).levelId
        break
      }
      case "connector": {
        const above = levelAbove(levelId)
        if (!above) continue
        o.toLevelId = above
        o.rect = { ...o.rect, ...move(o.rect) }
        break
      }
      case "pillar":
        o.position = move(o.position)
        break
      case "prop":
        o.position = { ...o.position, ...move(o.position) }
        break
      case "light": {
        const carrierId = o.attachedTokenId ? idMap.get(o.attachedTokenId) : undefined
        if (carrierId) {
          // Offset from the carrier: no translation; the level follows the carrier.
          o.attachedTokenId = carrierId
          o.levelId = draft.tokens[carrierId].levelId
          break
        }
        if (o.attachedTokenId) {
          // Foreign clipboard with an uncopied carrier: resolve against the draft when possible.
          if (hasOwn(draft.tokens, o.attachedTokenId)) {
            const t = draft.tokens[o.attachedTokenId]
            o.position = { ...o.position, x: t.position.x + o.position.x, z: t.position.z + o.position.z }
          }
          o.attachedTokenId = null
        }
        o.position = { ...o.position, ...move(o.position) }
        break
      }
    }
    o.id = newId()
    idMap.set(src.id, o.id)
    draft.objects[o.id] = o
    newObjectIds.push(o.id)
  }
  return [...newObjectIds, ...newTokenIds]
}

// ---------------------------------------------------------------------------
// Wall edits
// ---------------------------------------------------------------------------

/**
 * Keep a wall's openings valid after its geometry changed. Each opening keeps its distance from
 * the endpoint that stayed put (flip a↔b mirrors offsets; dragging b keeps offsets from a; dragging a
 * keeps distances from b; a free move/rotation keeps offsets from a). Openings that no longer fit
 * (width/2 ≤ offset ≤ length − width/2) are deleted. Openings of a deleted wall are deleted.
 * Openings also follow the wall's level.
 */
export function reprojectOpenings(draft: Scene, wallId: Id, before: Pick<WallObject, "a" | "b">): void {
  const wall = hasOwn(draft.objects, wallId) ? draft.objects[wallId] : undefined
  const openings = wallOpenings(draft, wallId)
  if (!wall || wall.type !== "wall") {
    for (const o of openings) delete draft.objects[o.id]
    return
  }
  const oldLen = wallLength(before)
  const newLen = wallLength(wall)
  const remap = (offset: number): number => {
    if (samePoint(wall.a, before.a)) return offset
    if (samePoint(wall.b, before.b)) return newLen - (oldLen - offset)
    if (samePoint(wall.a, before.b)) return oldLen - offset
    if (samePoint(wall.b, before.a)) return newLen - offset
    return offset
  }
  for (const o of openings) {
    const offset = remap(o.offset)
    if (!openingFits(newLen, offset, o.width)) {
      delete draft.objects[o.id]
      continue
    }
    const opening = draft.objects[o.id] as typeof o
    opening.offset = offset
    opening.levelId = wall.levelId
  }
}

/**
 * Split a wall at `distance` feet from a: the original keeps [a, p], a new wall (same properties)
 * gets [p, b]. Openings entirely past the split move to the new wall (offsets rebased); openings
 * straddling it are deleted. Returns the new wall's id, or null if the split point is not inside.
 */
export function splitWall(draft: Scene, wallId: Id, distance: number): Id | null {
  const wall = hasOwn(draft.objects, wallId) ? draft.objects[wallId] : undefined
  if (!wall || wall.type !== "wall") return null
  const len = wallLength(wall)
  if (!(distance > POINT_EPS && distance < len - POINT_EPS)) return null
  const dir = wallDirection(wall)
  const p = { x: wall.a.x + dir.x * distance, z: wall.a.z + dir.z * distance }
  const second: WallObject = { ...clone(wall), id: newId(), a: { ...p }, b: { ...wall.b } }
  draft.objects[second.id] = second
  for (const o of wallOpenings(draft, wallId)) {
    const lo = o.offset - o.width / 2
    const hi = o.offset + o.width / 2
    if (hi <= distance + OPENING_FIT_EPS) continue
    if (lo >= distance - OPENING_FIT_EPS) {
      const opening = draft.objects[o.id] as typeof o
      opening.wallId = second.id
      opening.offset = o.offset - distance
      continue
    }
    delete draft.objects[o.id]
  }
  wall.b = { ...p }
  return second.id
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Human-readable reference problems; empty = valid. Checks record keys against ids, id uniqueness
 * across levels/objects/tokens, levelId of every object and token, opening hosts (an existing wall on
 * the same level that the opening fits on), connector targets (an existing, different, higher level)
 * and attached-light carriers.
 */
export function validateReferences(scene: Scene): string[] {
  const issues: string[] = []
  const owner = new Map<Id, string>()
  const claim = (id: Id, what: string) => {
    const prev = owner.get(id)
    if (prev) issues.push(`duplicate id "${id}" (${prev} and ${what})`)
    else owner.set(id, what)
  }
  const levelExists = (id: Id) => hasOwn(scene.levels, id)

  for (const [key, level] of Object.entries(scene.levels)) {
    if (level.id !== key) issues.push(`levels["${key}"]: id "${level.id}" does not match its key`)
    claim(level.id, "level")
    if (level.backdrop && !(scene.assets && hasOwn(scene.assets, level.backdrop.assetId))) {
      issues.push(`level "${level.id}": backdrop asset "${level.backdrop.assetId}" does not exist`)
    }
  }
  for (const [key, asset] of Object.entries(scene.assets ?? {})) {
    if (asset.id !== key) issues.push(`assets["${key}"]: id "${asset.id}" does not match its key`)
  }

  for (const [key, o] of Object.entries(scene.objects)) {
    const label = `${o.type} "${o.id}"`
    if (o.id !== key) issues.push(`objects["${key}"]: id "${o.id}" does not match its key`)
    claim(o.id, o.type)
    if (!levelExists(o.levelId)) issues.push(`${label}: levelId "${o.levelId}" does not exist`)
    switch (o.type) {
      case "door":
      case "window": {
        const host = hasOwn(scene.objects, o.wallId) ? scene.objects[o.wallId] : undefined
        if (!host) issues.push(`${label}: wallId "${o.wallId}" does not exist`)
        else if (host.type !== "wall") issues.push(`${label}: wallId "${o.wallId}" is a ${host.type}, not a wall`)
        else if (host.levelId !== o.levelId) issues.push(`${label}: levelId "${o.levelId}" differs from its wall's level "${host.levelId}"`)
        else if (!openingFits(wallLength(host), o.offset, o.width)) issues.push(`${label}: does not fit on wall "${host.id}" (offset ${o.offset}, width ${o.width}, wall length ${wallLength(host).toFixed(3)})`)
        break
      }
      case "connector": {
        if (!levelExists(o.toLevelId)) issues.push(`${label}: toLevelId "${o.toLevelId}" does not exist`)
        else if (o.toLevelId === o.levelId) issues.push(`${label}: toLevelId equals its own level`)
        else if (levelExists(o.levelId) && scene.levels[o.toLevelId].elevation <= scene.levels[o.levelId].elevation) {
          issues.push(`${label}: toLevelId "${o.toLevelId}" must be higher than level "${o.levelId}"`)
        }
        break
      }
      case "light":
        if (o.attachedTokenId !== null && !hasOwn(scene.tokens, o.attachedTokenId)) {
          issues.push(`${label}: attachedTokenId "${o.attachedTokenId}" does not exist`)
        }
        break
      default:
        break
    }
  }

  for (const [key, t] of Object.entries(scene.tokens)) {
    if (t.id !== key) issues.push(`tokens["${key}"]: id "${t.id}" does not match its key`)
    claim(t.id, "token")
    if (!levelExists(t.levelId)) issues.push(`token "${t.id}": levelId "${t.levelId}" does not exist`)
  }
  return issues
}
