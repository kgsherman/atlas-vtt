/**
 * Pure geometry edits on scene drafts used by editor commands and tools: translating and rotating
 * selections, the reference point a drag snaps with, and where a paste at the pointer snaps to.
 */
import { snapPoint, type SnapMode } from "@/core/grid/grid"
import { openingFits, selectionBounds, type AtlasClipboard } from "@/core/scene/integrity"
import { openingSegment, wallDirection, wallLength } from "@/core/scene/queries"
import type { Id, Rect, Scene, SceneObject, Token, Vec2 } from "@/core/scene/types"

import { edgeSnapMode, placeOpening, snapTokenPosition } from "./snapping"

const hasOwn = (o: object, k: string) => Object.hasOwn(o, k)
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Deep copies of the items a selection move/rotation acts on (lets a drag re-apply from the originals). */
export interface MovePlan {
  objects: SceneObject[]
  tokens: Token[]
  /** Moves must be whole cells (the plan contains a connector, whose rect must stay cell-aligned). */
  cellAligned: boolean
}

/**
 * Items that actually move when `ids` move: openings whose wall moves and lights attached to a
 * moving token are skipped (they follow their host); unknown ids are ignored.
 */
export function planMove(scene: Scene, ids: readonly Id[]): MovePlan {
  const set = new Set(ids)
  const objects: SceneObject[] = []
  const tokens: Token[] = []
  for (const id of set) {
    if (hasOwn(scene.objects, id)) {
      const o = scene.objects[id]
      if ((o.type === "door" || o.type === "window") && set.has(o.wallId)) continue
      if (o.type === "light" && o.attachedTokenId && set.has(o.attachedTokenId) && hasOwn(scene.tokens, o.attachedTokenId)) continue
      objects.push(clone(o))
    } else if (hasOwn(scene.tokens, id)) {
      tokens.push(clone(scene.tokens[id]))
    }
  }
  return { objects, tokens, cellAligned: objects.some((o) => o.type === "connector") }
}

/** Round a delta to whole cells when the plan requires it. */
export function alignDelta(plan: MovePlan, cellSize: number, dx: number, dz: number): Vec2 {
  if (!plan.cellAligned) return { x: dx, z: dz }
  return { x: Math.round(dx / cellSize) * cellSize, z: Math.round(dz / cellSize) * cellSize }
}

const add = (p: Vec2, dx: number, dz: number): Vec2 => ({ x: p.x + dx, z: p.z + dz })

/**
 * Write the plan's ORIGINAL geometry translated by (dx, dz) into the draft (absolute, so repeated
 * calls during a drag never accumulate error). Openings moved without their wall slide along it to
 * the nearest offset where they fit without overlapping the wall's other openings. Items deleted
 * from the draft meanwhile are skipped.
 */
export function applyMove(draft: Scene, plan: MovePlan, dx: number, dz: number): void {
  for (const src of plan.objects) {
    if (!hasOwn(draft.objects, src.id)) continue
    const o = draft.objects[src.id]
    if (o.type !== src.type) continue
    switch (o.type) {
      case "floor":
      case "connector": {
        const s = src as typeof o
        o.rect = { ...s.rect, ...add(s.rect, dx, dz) }
        break
      }
      case "wall": {
        const s = src as typeof o
        o.a = add(s.a, dx, dz)
        o.b = add(s.b, dx, dz)
        break
      }
      case "door":
      case "window": {
        const s = src as typeof o
        const host = hasOwn(draft.objects, s.wallId) ? draft.objects[s.wallId] : undefined
        if (!host || host.type !== "wall") break
        const dir = wallDirection(host)
        // Nearest spot to the dragged offset that is inside the wall and clear of its other openings.
        const placed = placeOpening(draft, host, s.offset + dx * dir.x + dz * dir.z, s.width, { mode: "free", excludeId: s.id })
        if (placed.valid && openingFits(wallLength(host), placed.offset, s.width)) o.offset = placed.offset
        break
      }
      case "pillar": {
        const s = src as typeof o
        o.position = add(s.position, dx, dz)
        break
      }
      case "prop":
      case "light": {
        const s = src as typeof o
        o.position = { ...s.position, ...add(s.position, dx, dz) }
        break
      }
    }
  }
  for (const src of plan.tokens) {
    if (!hasOwn(draft.tokens, src.id)) continue
    draft.tokens[src.id].position = add(src.position, dx, dz)
  }
}

/** Rotate p about pivot by quarter turns of +90° about +Y ((x, z) → (z, −x) relative to the pivot). */
export function rotateQuarter(p: Vec2, pivot: Vec2, quarterTurns: number): Vec2 {
  const q = ((quarterTurns % 4) + 4) % 4
  let x = p.x - pivot.x
  let z = p.z - pivot.z
  for (let k = 0; k < q; k++) {
    const nx = z
    const nz = -x
    x = nx
    z = nz
  }
  // Snap away float noise so grid-aligned inputs stay exactly grid-aligned.
  const clean = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v)
  return { x: clean(x) + pivot.x, z: clean(z) + pivot.z }
}

function rotateRect(r: Rect, pivot: Vec2, q: number): Rect {
  const p0 = rotateQuarter({ x: r.x, z: r.z }, pivot, q)
  const p1 = rotateQuarter({ x: r.x + r.w, z: r.z + r.d }, pivot, q)
  const x = Math.min(p0.x, p1.x)
  const z = Math.min(p0.z, p1.z)
  return { x, z, w: Math.abs(p1.x - p0.x), d: Math.abs(p1.z - p0.z) }
}

/** Normalise an angle to (−π, π]. */
export function normalizeAngle(a: number): number {
  const t = Math.PI * 2
  let r = ((a % t) + t) % t
  if (r > Math.PI) r -= t
  return Math.abs(r) < 1e-12 ? 0 : r
}

/**
 * Rotate the planned items about `pivot` by quarter turns (+90° about +Y each). Rects swap extents,
 * connector directions and prop rotations turn with them; openings (hosted) and attached lights
 * (offsets from their token) are left alone.
 */
export function applyRotation(draft: Scene, plan: MovePlan, pivot: Vec2, quarterTurns: number): void {
  const q = ((Math.round(quarterTurns) % 4) + 4) % 4
  if (q === 0) return
  for (const src of plan.objects) {
    if (!hasOwn(draft.objects, src.id)) continue
    const o = draft.objects[src.id]
    switch (o.type) {
      case "floor":
        o.rect = rotateRect(o.rect, pivot, q)
        break
      case "connector":
        o.rect = rotateRect(o.rect, pivot, q)
        o.direction = ((o.direction + q) % 4) as typeof o.direction
        break
      case "wall":
        o.a = rotateQuarter(o.a, pivot, q)
        o.b = rotateQuarter(o.b, pivot, q)
        break
      case "pillar":
        o.position = rotateQuarter(o.position, pivot, q)
        break
      case "prop":
        o.position = { ...o.position, ...rotateQuarter(o.position, pivot, q) }
        o.rotationY = normalizeAngle(o.rotationY + (q * Math.PI) / 2)
        break
      case "light":
        if (o.attachedTokenId) break
        o.position = { ...o.position, ...rotateQuarter(o.position, pivot, q) }
        break
      default:
        break
    }
  }
  for (const src of plan.tokens) {
    if (!hasOwn(draft.tokens, src.id)) continue
    const t = draft.tokens[src.id]
    t.position = rotateQuarter(t.position, pivot, q)
  }
}

/**
 * Pivot for rotating a selection: a lone point-like item (prop, pillar, light, token) turns in place;
 * anything else turns about the centre of its bounds snapped to the nearest cell vertex (so
 * grid-aligned geometry stays grid-aligned) unless snapping is off.
 */
export function rotationPivot(scene: Scene, plan: MovePlan, mode: SnapMode): Vec2 | null {
  const items = plan.objects.length + plan.tokens.length
  if (items === 0) return null
  if (items === 1) {
    const o = plan.objects[0]
    if (o && (o.type === "prop" || o.type === "pillar" || o.type === "light")) return { x: o.position.x, z: o.position.z }
    if (plan.tokens[0]) return { ...plan.tokens[0].position }
  }
  const bounds = selectionBounds(scene, [...plan.objects.map((o) => o.id), ...plan.tokens.map((t) => t.id)])
  if (!bounds) return null
  const centre = { x: bounds.x + bounds.w / 2, z: bounds.z + bounds.d / 2 }
  return mode === "free" ? centre : snapPoint(scene.grid, centre, "vertex")
}

/**
 * The point of an item a drag snaps with: rect min corner (floors, connectors), endpoint a (walls),
 * opening centre, or the item's position. null for attached lights (their position is an offset).
 */
export function dragAnchor(scene: Scene, id: Id): Vec2 | null {
  if (hasOwn(scene.tokens, id)) return { ...scene.tokens[id].position }
  if (!hasOwn(scene.objects, id)) return null
  const o = scene.objects[id]
  switch (o.type) {
    case "floor":
    case "connector":
      return { x: o.rect.x, z: o.rect.z }
    case "wall":
      return { ...o.a }
    case "door":
    case "window": {
      const host = hasOwn(scene.objects, o.wallId) ? scene.objects[o.wallId] : undefined
      if (!host || host.type !== "wall") return null
      const seg = openingSegment(host, o)
      return { x: (seg.a.x + seg.b.x) / 2, z: (seg.a.z + seg.b.z) / 2 }
    }
    case "pillar":
      return { ...o.position }
    case "prop":
      return { x: o.position.x, z: o.position.z }
    case "light":
      return o.attachedTokenId ? null : { x: o.position.x, z: o.position.z }
  }
}

/**
 * Snap a raw drag delta so the grabbed item's anchor lands where placing it would (grid lines for
 * floors/walls/connectors, footprint anchoring for tokens, the snap mode for the rest).
 */
export function snapDragDelta(scene: Scene, grabbedId: Id, raw: Vec2, mode: SnapMode): Vec2 {
  if (mode === "free") return { x: raw.x, z: raw.z }
  const anchor = dragAnchor(scene, grabbedId)
  if (!anchor) return { x: raw.x, z: raw.z }
  const target = { x: anchor.x + raw.x, z: anchor.z + raw.z }
  let snapped: Vec2
  if (hasOwn(scene.tokens, grabbedId)) {
    snapped = snapTokenPosition(scene.grid, target, scene.tokens[grabbedId].size, mode)
  } else {
    const o = scene.objects[grabbedId]
    const edge = o.type === "floor" || o.type === "connector" || o.type === "wall"
    snapped = snapPoint(scene.grid, target, edge ? edgeSnapMode(mode) : mode)
  }
  return { x: snapped.x - anchor.x, z: snapped.z - anchor.z }
}

/**
 * Where a clipboard's origin should land for a paste at the pointer `at` under snap `mode`: the paste
 * translation is snapped with the drag rules (snapDragDelta) on a reference item — the first token
 * (footprint anchoring), else the first floor/connector/wall (edge snapping), else the first other
 * item with a drag anchor — so the relative layout is kept and that item lands on the grid. "free"
 * (or nothing to snap by) returns `at` unchanged.
 */
export function snapPasteAt(scene: Scene, clip: AtlasClipboard, at: Vec2, mode: SnapMode): Vec2 {
  if (mode === "free") return { x: at.x, z: at.z }
  const probe: Scene = {
    ...scene,
    objects: Object.fromEntries(clip.objects.map((o) => [o.id, o])),
    tokens: Object.fromEntries(clip.tokens.map((t) => [t.id, t])),
  }
  const edge = clip.objects.find((o) => o.type === "floor" || o.type === "connector" || o.type === "wall")
  const refId = clip.tokens[0]?.id ?? edge?.id ?? clip.objects.find((o) => dragAnchor(probe, o.id) !== null)?.id
  if (refId === undefined || dragAnchor(probe, refId) === null) return { x: at.x, z: at.z }
  const d = snapDragDelta(probe, refId, { x: at.x - clip.origin.x, z: at.z - clip.origin.z }, mode)
  return { x: clip.origin.x + d.x, z: clip.origin.z + d.z }
}
