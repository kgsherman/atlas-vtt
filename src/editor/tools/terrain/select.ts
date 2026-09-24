/**
 * Select sub-tool of the terrain mode (DESIGN §3.4).
 *
 * Object mode: click selects a shape (Shift / Ctrl toggles; repeated clicks at one spot cycle through
 * overlapping shapes), a click on nothing clears, a drag on nothing marquee-selects (screen space), a press
 * on a shape selects and drags it. A press keeps an already selected shape when it is the front candidate
 * under the cursor, a pit whose floor is under the cursor (the top of the shape it carves is hit first
 * there), level with the front one (coplanar tops) or the one the click cycle reached at that spot (so a
 * press-drag moves the selection, also a buried shape cycled to); only a click (released without dragging)
 * cycles on. Advanced (edit) mode — context editMode — does the same for the vertices / edges / faces of
 * the selected shapes; a click on another shape in front switches the edit session to it, Shift+click adds
 * it.
 *
 * Drags move on the horizontal plane through the grab point (never on the previewed terrain), snapped by
 * an anchor (the grabbed shape's / element's first vertex, edge snapping; a cylinder's centre with the snap
 * mode, as at creation; Alt = free); the gizmo arrows and the X / Y / Z keys constrain to an axis (Y moves
 * heights, snapped to the height step). A move that would make a shape invalid is refused (the drag keeps
 * its last valid state). A drag previews locally (overlay + re-baked terrain) and commits ONE
 * store.applyTerrainEdit on release.
 */
import { snapPoint } from "@/core/grid/grid"
import {
  axisVector,
  closestPointOnAxis,
  gizmoHandles,
  gizmoRing,
  GIZMO_HIT_RADIUS_PX,
  ringAngle,
  ringDistancePx,
  wrapAngle,
  heightFromPointer,
  hitGizmo,
  type GizmoAxis,
  type GizmoPart,
  type HeightFollowState,
  type ScreenPoint,
} from "@/core/geometry/gizmo"
import { elementVertexIndices, rotateShape, topVertices, translateShape, translateVertices, type TerrainElementRef } from "@/core/scene/terrainShapes"
import type { Id, Level, Rect, TerrainShape, Vec2, Vec3 } from "@/core/scene/types"

import type { TerrainSelection } from "../../store"
import { edgeSnapMode } from "../../snapping"
import {
  cycleCurrent,
  cyclePick,
  edgeHits,
  elementKey,
  elementsInScreenRect,
  elementVerticesByShape,
  faceHits,
  offsetLabel,
  rayParam,
  rayPlaneY,
  sameElement,
  screenRect,
  shapeHits,
  shapeInExtent,
  shapesBounds,
  shapesInScreenRect,
  snapHeight,
  vertexHits,
  verticesCentroid,
  type ClickCycle,
  type ElementHit,
  type Ray,
  type ShapeHit,
} from "../../terrainMath"
import type { ToolPointerEvent } from "../types"
import {
  activeLevel,
  activeSelection,
  buriedTolerance,
  cameraDragging,
  canvasOf,
  editMode,
  groundOf,
  heightStepOf,
  levelShapes,
  NO_PARTS,
  pointsCentre,
  pressTravel,
  rayOf,
  snapModeOf,
  type SubTool,
  type TerrainToolContext,
} from "./context"
import type { ShapeActions } from "./actions"
import { createShapePreview, type ShapePreview } from "./lattice"

/** Pointer travel (CSS px) before a press turns into a drag or a marquee. */
const DRAG_THRESHOLD_PX = 4
/** Snapping step of rotate-ring drags (radians; Alt or the free snap mode rotate freely). */
const ROTATE_STEP = Math.PI / 12

/** A rotation for the label: whole degrees when snapped, one decimal when free ("+45°", "−7.5°"). */
function angleLabel(angle: number): string {
  const deg = (angle * 180) / Math.PI
  const r = Math.round(deg * 10) / 10
  const text = Number.isInteger(r) ? String(Math.abs(r)) : Math.abs(r).toFixed(1)
  return `${r < 0 ? "−" : "+"}${text}°`
}

const UP: Vec3 = { x: 0, y: 1, z: 0 }
const ZERO: Vec3 = { x: 0, y: 0, z: 0 }

type Target =
  { kind: "shape"; shapeId: Id; point: Vec3 } | { kind: "element"; ref: TerrainElementRef; point: Vec3 } | { kind: "gizmo"; part: GizmoPart; point: Vec3 }

/** The candidates under a press on an already selected one (a click's release cycles through them). */
type Recycle = { kind: "shape"; at: ScreenPoint; hits: readonly ShapeHit[] } | { kind: "element"; at: ScreenPoint; hits: readonly ElementHit[] }

interface Pending {
  kind: "pending"
  levelId: Id
  target: Target
  down: ToolPointerEvent
  /**
   * The press kept an already selected shape / element (the target): released without a drag, the click
   * selects the next candidate of the click cycle (which also narrows a multi-selection). Null otherwise.
   */
  recycle: Recycle | null
}

interface Drag {
  kind: "drag"
  levelId: Id
  /** Element drag (advanced mode): only these top vertices move; null = whole shapes. */
  indices: Map<Id, number[]> | null
  /** Document versions of the shapes the drag may change. */
  originals: Map<Id, TerrainShape>
  /** World point grabbed (its height is the drag plane). */
  grab: Vec3
  /** Snap anchor (XZ): the grabbed shape's / element's first vertex, or a grabbed cylinder's centre. */
  anchor: Vec2
  /** Snap the anchor like floor edges (edgeSnapMode: corners); false for a cylinder's centre (the snap mode). */
  edgeSnap: boolean
  down: ToolPointerEvent
  last: ToolPointerEvent
  axis: GizmoAxis | null
  /** The axis is the gizmo handle the drag started on (not toggled by a key). */
  axisFromHandle: boolean
  /** Y drags: relative height-follow from the press. */
  follow: HeightFollowState | null
  /** Last valid (accepted) offset. */
  delta: Vec3
  /**
   * Drag on the rotate ring: the selection turns about the vertical axis through `pivot` by the pointer's
   * angle on the ring's plane (ringAngle) since the press, in `step` increments (0 = free). Null: a move.
   */
  rotate: { pivot: Vec2; center: Vec3; start: number; angle: number } | null
  /** Moved versions of the changed shapes (null while nothing moved). */
  current: Map<Id, TerrainShape> | null
  preview: ShapePreview
}

interface Marquee {
  kind: "marquee"
  levelId: Id
  down: ToolPointerEvent
  start: ScreenPoint | null
  end: ScreenPoint | null
  additive: boolean
  /** Advanced mode: select elements (else shapes). */
  elements: boolean
  /** Advanced mode: an unselected shape under the press (a click selects it). */
  hitShapeId: Id | null
}

type Gesture = Pending | Drag | Marquee

/** The marquee's box (canvas CSS px) once the pointer travelled far enough to make it a drag, else null. */
function marqueeBox(m: Pick<Marquee, "start" | "end">): { from: ScreenPoint; to: ScreenPoint } | null {
  const { start, end } = m
  if (!start || !end || Math.hypot(end.x - start.x, end.y - start.y) < DRAG_THRESHOLD_PX) return null
  return { from: { x: start.x, y: start.y }, to: { x: end.x, y: end.y } }
}

interface Hover {
  shapeId: Id | null
  element: TerrainElementRef | null
  gizmo: GizmoPart | null
}

const NO_HOVER: Hover = { shapeId: null, element: null, gizmo: null }

const sameHover = (a: Hover, b: Hover) => a.shapeId === b.shapeId && a.gizmo === b.gizmo && sameElement(a.element, b.element)

const isZero = (d: Vec3) => d.x === 0 && d.y === 0 && d.z === 0

/** An offset component without float noise (a cylinder's anchor is a mean of its rim points). */
const tidy = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v)

const shapeKey = (h: ShapeHit) => h.shapeId
const elementHitKey = (c: ElementHit) => elementKey(c.ref)

/**
 * The selected candidate a press keeps (`cands` best first), in this order: the front one; a pit whose
 * floor is under the cursor (`onGround`, shapes only: the top of the shape it carves is hit first there);
 * one level with the front one (`tied`: coplanar tops, coincident vertices / edges, whose order is
 * arbitrary); the one the click cycle reached at this spot. Never a selected one merely somewhere under the
 * cursor: a press on a visible unselected candidate takes that one.
 */
function heldCandidate<T>(
  cands: readonly T[],
  keyOf: (c: T) => string,
  at: ScreenPoint,
  cycle: ClickCycle | null,
  selected: (c: T) => boolean,
  tied: (c: T, front: T) => boolean,
  onGround?: (c: T) => boolean
): T | undefined {
  const front = cands[0]
  if (front === undefined) return undefined
  if (selected(front)) return front
  const pit = onGround ? cands.find((c) => selected(c) && onGround(c)) : undefined
  if (pit !== undefined) return pit
  const tie = cands.find((c) => selected(c) && tied(c, front))
  if (tie !== undefined) return tie
  const cur = cycleCurrent(cands, keyOf, at, cycle)
  return cur !== null && selected(cur) ? cur : undefined
}

/** Equal up to float noise (relative to `b`, at least 1e-6 absolute). */
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b))
/** Shape hits equally in front: on the same side of the terrain at the same ray parameter. */
const shapeTied = (h: ShapeHit, front: ShapeHit) => h.hidden === front.hidden && near(h.t, front.t)
/** Element hits equally near (screen distance, or ray parameter for faces). */
const elementTied = (c: ElementHit, front: ElementHit) => near(c.distance, front.distance)
const shapeOnGround = (h: ShapeHit) => h.onGround


export function createSelectSubTool(ctx: TerrainToolContext, actions: Pick<ShapeActions, "select">): SubTool {
  const { store, deps } = ctx
  let gesture: Gesture | null = null
  let hover: Hover = NO_HOVER
  let cycle: ClickCycle | null = null

  const setSelection = actions.select

  const selectedShapes = (
    sel: TerrainSelection | null,
    rec: Readonly<Record<Id, TerrainShape>>,
    subs: ReadonlyMap<Id, TerrainShape> | null = null
  ): TerrainShape[] => (sel ? sel.shapeIds.filter((id) => Object.hasOwn(rec, id)).map((id) => subs?.get(id) ?? rec[id]) : [])

  /**
   * Gizmo centre for the selection: the selected elements' centroid (advanced mode; none → no gizmo) or the
   * centre of the selected shapes' bounds at their mean top height. `subs` = moved shapes during a drag.
   */
  const gizmoAt = (subs: ReadonlyMap<Id, TerrainShape> | null): Vec3 | null => {
    const s = store.getState()
    const a = activeLevel(s)
    const sel = activeSelection(s)
    if (!a || !sel || s.readOnly) return null
    const rec = levelShapes(a.level)
    const shapes = selectedShapes(sel, rec, subs)
    if (shapes.length === 0) return null
    if (editMode(s)) {
      const byId = new Map(shapes.map((sh) => [sh.id, sh]))
      return verticesCentroid(byId, elementVerticesByShape(rec, sel.elements), a.level.elevation)
    }
    const b = shapesBounds(shapes)
    if (!b) return null
    let y = 0
    let n = 0
    for (const sh of shapes) {
      for (const p of topVertices(sh)) {
        y += p.y
        n++
      }
    }
    return { x: b.x + b.w / 2, y: a.level.elevation + y / n, z: b.z + b.d / 2 }
  }

  /**
   * The gizmo handle under the cursor (null without a projector, a selection or a hit). The rotate ring is a
   * long thin target running across the shapes: in the vertex and edge modes a vertex or edge nearer the
   * cursor than the ring takes the press instead.
   */
  const gizmoHit = (e: ToolPointerEvent): { part: GizmoPart; at: Vec3 } | null => {
    const cursor = canvasOf(e)
    if (!cursor || !deps.project) return null
    const at = gizmoAt(null)
    if (!at) return null
    const axis = hitGizmo(gizmoHandles(deps.project, at), cursor)
    if (axis) return { part: axis, at }
    const ring = ringDistancePx(gizmoRing(deps.project, at), cursor)
    if (!(ring <= GIZMO_HIT_RADIUS_PX)) return null
    const s = store.getState()
    const a = activeLevel(s)
    const ray = rayOf(e)
    if (a && ray && editMode(s) && s.toolSettings.terrain.element !== "face") {
      const [el] = elementCandidates(e, ray, selectedShapes(activeSelection(s), levelShapes(a.level)), a.level)
      if (el && el.distance < ring) return null
    }
    return { part: "rotate", at }
  }

  /** Candidates of the current element kind among the selected shapes, best first. */
  const elementCandidates = (e: ToolPointerEvent, ray: Ray, shapes: readonly TerrainShape[], level: Level): ElementHit[] => {
    const s = store.getState()
    const mode = s.toolSettings.terrain.element
    if (mode === "face") {
      const groundT = e.pick.ground ? rayParam(ray, e.pick.ground) : null
      return faceHits(shapes, level.elevation, ray, { groundT, tolerance: buriedTolerance(level, s.scene.grid.cellSize) })
    }
    const cursor = canvasOf(e)
    if (!cursor || !deps.project) return []
    return mode === "vertex" ? vertexHits(shapes, level.elevation, deps.project, cursor) : edgeHits(shapes, level.elevation, deps.project, cursor)
  }

  const shapeCandidates = (e: ToolPointerEvent, ray: Ray, shapes: readonly TerrainShape[], level: Level) => {
    const groundT = e.pick.ground ? rayParam(ray, e.pick.ground) : null
    return shapeHits(shapes, level.elevation, ray, { groundT, tolerance: buriedTolerance(level, store.getState().scene.grid.cellSize) })
  }

  /**
   * Advanced mode: the unselected shape a click there takes — only the front shape under the cursor (a pit
   * whose floor is under it counts as in front of the shape it carves), and none when a selected shape is
   * level with it or is such a pit (not one lying under the selected shapes, e.g. the plateau under an
   * edited block or around an edited pit).
   */
  const otherShapeInFront = (e: ToolPointerEvent, ray: Ray, all: readonly TerrainShape[], level: Level, sel: TerrainSelection): ShapeHit | undefined => {
    const hits = shapeCandidates(e, ray, all, level)
    const front = hits.find(shapeOnGround) ?? hits[0]
    if (front === undefined) return undefined
    const isSelected = (h: ShapeHit) => sel.shapeIds.includes(h.shapeId)
    return hits.some((h) => isSelected(h) && (h.onGround || shapeTied(h, front))) ? undefined : front
  }

  const computeHover = (e: ToolPointerEvent): Hover => {
    const ray = rayOf(e)
    const s = store.getState()
    const a = activeLevel(s)
    if (!ray || !a) return NO_HOVER
    const g = gizmoHit(e)
    if (g) return { shapeId: null, element: null, gizmo: g.part }
    const rec = levelShapes(a.level)
    const all = Object.values(rec)
    const at = canvasOf(e) ?? { x: e.clientX, y: e.clientY }
    // The candidate a press would take: the held one (heldCandidate), else the nearest.
    if (editMode(s)) {
      const sel = activeSelection(s)!
      const els = elementCandidates(e, ray, selectedShapes(sel, rec), a.level)
      const isSelected = (c: ElementHit) => sel.elements.some((x) => sameElement(x, c.ref))
      const el = heldCandidate(els, elementHitKey, at, cycle, isSelected, elementTied) ?? els[0]
      if (el) return { shapeId: null, element: el.ref, gizmo: null }
      const other = otherShapeInFront(e, ray, all, a.level, sel)
      return other ? { shapeId: other.shapeId, element: null, gizmo: null } : NO_HOVER
    }
    const sel = activeSelection(s)
    const hits = shapeCandidates(e, ray, all, a.level)
    const isSelected = (h: ShapeHit) => sel?.shapeIds.includes(h.shapeId) ?? false
    const hit = heldCandidate(hits, shapeKey, at, cycle, isSelected, shapeTied, shapeOnGround) ?? hits[0]
    return hit ? { shapeId: hit.shapeId, element: null, gizmo: null } : NO_HOVER
  }

  const updateHover = (e: ToolPointerEvent) => {
    const next = computeHover(e)
    if (sameHover(next, hover)) return
    hover = next
    ctx.changed()
  }

  // ---- drags ---------------------------------------------------------------

  /** A press on the rotate ring: the pivot (the gizmo centre) and the pointer's angle on the ring plane. */
  const rotateStart = (p: Pending): Drag["rotate"] => {
    if (p.target.kind !== "gizmo" || p.target.part !== "rotate") return null
    const ray = rayOf(p.down)
    const center = p.target.point
    const start = ray ? ringAngle(ray, center) : null
    return start === null ? null : { pivot: { x: center.x, z: center.z }, center, start, angle: 0 }
  }

  const startDrag = (p: Pending): Drag | null => {
    const s = store.getState()
    const a = activeLevel(s)
    const sel = activeSelection(s)
    if (!a || a.levelId !== p.levelId || !sel || s.readOnly) return null
    const rec = levelShapes(a.level)
    const originals = new Map<Id, TerrainShape>()
    for (const sh of selectedShapes(sel, rec)) originals.set(sh.id, sh)
    if (originals.size === 0) return null
    let indices: Map<Id, number[]> | null = null
    let anchor: Vec2
    let edgeSnap = true
    if (editMode(s)) {
      indices = elementVerticesByShape(rec, sel.elements)
      if (indices.size === 0) return null
      let first: Vec3 | undefined
      if (p.target.kind === "element") {
        const ref = p.target.ref
        const k = Object.hasOwn(rec, ref.shapeId) ? elementVertexIndices(rec[ref.shapeId], ref)[0] : undefined
        if (k !== undefined) first = topVertices(rec[ref.shapeId])[k]
      }
      if (!first) {
        const [id, ks] = [...indices][0]
        first = topVertices(rec[id])[ks[0]]
      }
      anchor = { x: first.x, z: first.z }
    } else {
      const grabbed = p.target.kind === "shape" && originals.has(p.target.shapeId) ? originals.get(p.target.shapeId)! : [...originals.values()][0]
      // A cylinder's first vertex is a rim point: its centre snaps instead, like at creation.
      if (grabbed.kind === "cylinder") {
        anchor = pointsCentre(grabbed)
        edgeSnap = false
      } else {
        anchor = { x: grabbed.points[0].x, z: grabbed.points[0].z }
      }
    }
    const rotate = rotateStart(p)
    // A ring press whose ray misses the ring's plane cannot turn anything (and must not become a move).
    if (!rotate && p.target.kind === "gizmo" && p.target.part === "rotate") return null
    // The next click starts a new cycle.
    cycle = null
    return {
      kind: "drag",
      levelId: a.levelId,
      indices,
      originals,
      grab: { ...p.target.point },
      anchor,
      edgeSnap,
      down: p.down,
      last: p.down,
      axis: p.target.kind === "gizmo" && p.target.part !== "rotate" ? p.target.part : null,
      axisFromHandle: p.target.kind === "gizmo" && p.target.part !== "rotate",
      follow: null,
      delta: ZERO,
      rotate,
      current: null,
      preview: createShapePreview(deps, s.scene, a.levelId),
    }
  }

  /** XZ point of an event on the drag plane (the terrain pick when the ray is parallel to it). */
  const planePoint = (e: ToolPointerEvent, y: number): Vec2 | null => {
    const ray = rayOf(e)
    const q = (ray && rayPlaneY(ray, y)) ?? groundOf(e)
    return q ? { x: q.x, z: q.z } : null
  }

  /** The (snapped) offset the pointer asks for; null when it cannot be computed. */
  const dragDelta = (d: Drag, e: ToolPointerEvent): Vec3 | null => {
    const ray = rayOf(e)
    if (!ray) return null
    const grid = store.getState().scene.grid
    const mode = snapModeOf(store, e)
    const free = mode === "free"
    const downRay = rayOf(d.down)
    if (d.axis === "y") {
      let dy: number | null = null
      const cursor = canvasOf(e)
      if (deps.project && cursor) {
        // Relative to the press (h = 0 at the press cursor), also when Y is toggled on mid-drag. On the drawn
        // Y handle "up" is the handle's direction; toggled by key it is screen up where the handle is short.
        const opts = { screenUpWhenFloored: !d.axisFromHandle }
        d.follow ??= heightFromPointer(null, d.grab, canvasOf(d.down) ?? cursor, deps.project, (downRay ?? ray).direction, opts)
        if (d.follow) {
          d.follow = heightFromPointer(d.follow, d.grab, cursor, deps.project, ray.direction, { ...opts, freeze: cameraDragging(e) }) ?? d.follow
          dy = d.follow.h
        }
      }
      if (dy === null && downRay) {
        const s1 = closestPointOnAxis(ray, d.grab, UP)
        const s0 = closestPointOnAxis(downRay, d.grab, UP)
        if (s1 && s0) dy = s1.s - s0.s
      }
      return dy === null ? null : { x: 0, y: snapHeight(dy, heightStepOf(store, e)), z: 0 }
    }
    let move: Vec2 | null = null
    if (d.axis) {
      const dir = axisVector(d.axis)
      const a1 = closestPointOnAxis(ray, d.grab, dir)
      const a0 = downRay ? closestPointOnAxis(downRay, d.grab, dir) : null
      if (a1 && a0) move = { x: dir.x * (a1.s - a0.s), z: dir.z * (a1.s - a0.s) }
    }
    if (!move) {
      const p1 = planePoint(e, d.grab.y)
      const p0 = planePoint(d.down, d.grab.y) ?? { x: d.grab.x, z: d.grab.z }
      if (!p1) return null
      move = { x: p1.x - p0.x, z: p1.z - p0.z }
      if (d.axis === "x") move.z = 0
      else if (d.axis === "z") move.x = 0
    }
    const target = { x: d.anchor.x + move.x, z: d.anchor.z + move.z }
    const snapped = free ? target : snapPoint(grid, target, d.edgeSnap ? edgeSnapMode(mode) : mode)
    // Tidied: a drag within the anchor's cell (or back to it) is exactly ZERO, so it commits nothing.
    return {
      x: d.axis === "z" ? 0 : tidy(snapped.x - d.anchor.x),
      y: 0,
      z: d.axis === "x" ? 0 : tidy(snapped.z - d.anchor.z),
    }
  }

  /** Shapes of the drag moved by `delta` (null: refused — some shape would be invalid or off the map). */
  const moved = (d: Drag, delta: Vec3, angle = 0): Map<Id, TerrainShape> | null => {
    const grid = store.getState().scene.grid
    const out = new Map<Id, TerrainShape>()
    for (const [id, orig] of d.originals) {
      let next: TerrainShape | null
      const ks = d.indices ? d.indices.get(id) : null
      if (d.indices && !ks) continue
      if (d.rotate) next = rotateShape(orig, d.rotate.pivot, angle, ks ?? null)
      else if (ks) next = translateVertices(orig, ks, delta)
      else next = translateShape(orig, delta)
      if (!next || !shapeInExtent(next, grid)) return null
      out.set(id, next)
    }
    return out
  }

  const previewDrag = (d: Drag) => {
    const level = store.getState().scene.levels[d.levelId]
    const cur = d.current
    if (!level) return
    const shapes = Object.values(levelShapes(level)).map((sh) => cur?.get(sh.id) ?? sh)
    let footprint: Rect | null = null
    if (cur) footprint = shapesBounds([...[...cur.keys()].map((id) => d.originals.get(id)!), ...cur.values()])
    d.preview.update(shapes, footprint, d.rotate ? `r${d.rotate.angle}` : `${d.delta.x},${d.delta.y},${d.delta.z}`)
  }

  /** Move the drag to `delta` unless that is refused (the drag then keeps its last valid state). */
  const applyDelta = (d: Drag, delta: Vec3): boolean => {
    if (delta.x === d.delta.x && delta.y === d.delta.y && delta.z === d.delta.z) return false
    if (isZero(delta)) {
      d.delta = ZERO
      d.current = null
    } else {
      const next = moved(d, delta)
      if (!next) return false
      d.delta = delta
      d.current = next
    }
    previewDrag(d)
    return true
  }

  /** Turn the drag to `angle` unless that is refused (the drag then keeps its last valid state). */
  const applyAngle = (d: Drag, r: NonNullable<Drag["rotate"]>, angle: number): boolean => {
    if (angle === r.angle) return false
    if (angle === 0) d.current = null
    else {
      const next = moved(d, ZERO, angle)
      if (!next) return false
      d.current = next
    }
    r.angle = angle
    previewDrag(d)
    return true
  }

  /** The rotate ring's angle for this event: since the press, snapped to ROTATE_STEP unless free (Alt / free snap). */
  const dragAngle = (r: NonNullable<Drag["rotate"]>, e: ToolPointerEvent): number | null => {
    const ray = rayOf(e)
    const now = ray ? ringAngle(ray, r.center) : null
    if (now === null) return null
    const raw = wrapAngle(now - r.start)
    if (snapModeOf(store, e) === "free") return raw
    const q = Math.round(raw / ROTATE_STEP) * ROTATE_STEP
    // Exact quarter turns (rotateShape rotates them without float noise); −0 → 0.
    return q === 0 ? 0 : q
  }

  const dragTo = (d: Drag, e: ToolPointerEvent) => {
    d.last = e
    if (d.rotate) {
      const angle = dragAngle(d.rotate, e)
      if (angle !== null && applyAngle(d, d.rotate, angle)) ctx.changed()
      return
    }
    const delta = dragDelta(d, e)
    if (delta && applyDelta(d, delta)) ctx.changed()
  }

  const endDrag = (d: Drag, commit: boolean) => {
    gesture = null
    const cur = d.current
    if (!commit || !cur || cur.size === 0) {
      d.preview.end(false)
      return
    }
    const upsert = [...cur.values()]
    const verb = d.rotate ? "Rotate" : "Move"
    const label = d.indices ? `${verb} terrain vertices` : upsert.length === 1 ? `${verb} terrain shape` : `${verb} terrain shapes`
    const before = store.getState().scene.levels[d.levelId]?.heightmap
    const ok = ctx.write(() => store.getState().applyTerrainEdit(d.levelId, { upsert }, label))
    const after = store.getState().scene.levels[d.levelId]?.heightmap
    d.preview.end(ok && after !== before)
    if (!ok) ctx.notify("The move was refused")
  }

  // ---- presses ---------------------------------------------------------------

  const pressElement = (e: ToolPointerEvent, ray: Ray, levelId: Id, level: Level, sel: TerrainSelection) => {
    const rec = levelShapes(level)
    const cands = elementCandidates(e, ray, selectedShapes(sel, rec), level)
    const at = canvasOf(e) ?? { x: e.clientX, y: e.clientY }
    const toggle = e.shift || e.ctrl
    const isSelected = (c: ElementHit) => sel.elements.some((x) => sameElement(x, c.ref))
    // A held selected element is kept: a drag moves the selection, a click cycles on release.
    const held = toggle ? undefined : heldCandidate(cands, elementHitKey, at, cycle, isSelected, elementTied)
    if (held) {
      gesture = {
        kind: "pending",
        levelId,
        target: { kind: "element", ref: held.ref, point: held.point },
        down: e,
        recycle: { kind: "element", at, hits: cands },
      }
      return
    }
    const pick = cyclePick(cands, elementHitKey, at, cycle)
    cycle = pick.cycle
    const choice = pick.choice
    if (choice) {
      if (toggle) {
        setSelection({ ...sel, elements: isSelected(choice) ? sel.elements.filter((x) => !sameElement(x, choice.ref)) : [...sel.elements, choice.ref] })
        return
      }
      setSelection({ ...sel, elements: [choice.ref] })
      gesture = { kind: "pending", levelId, target: { kind: "element", ref: choice.ref, point: choice.point }, down: e, recycle: null }
      return
    }
    const other = otherShapeInFront(e, ray, Object.values(rec), level, sel)
    const start = canvasOf(e)
    gesture = { kind: "marquee", levelId, down: e, start, end: start, additive: e.shift || e.ctrl, elements: true, hitShapeId: other?.shapeId ?? null }
  }

  const pressShape = (e: ToolPointerEvent, ray: Ray, levelId: Id, level: Level, sel: TerrainSelection | null) => {
    const hits = shapeCandidates(e, ray, Object.values(levelShapes(level)), level)
    const at = canvasOf(e) ?? { x: e.clientX, y: e.clientY }
    const toggle = e.shift || e.ctrl
    const ids = sel?.shapeIds ?? []
    // A held selected shape is kept: a drag moves the selection, a click cycles on release.
    const isSelected = (h: ShapeHit) => ids.includes(h.shapeId)
    const held = toggle ? undefined : heldCandidate(hits, shapeKey, at, cycle, isSelected, shapeTied, shapeOnGround)
    if (held) {
      gesture = { kind: "pending", levelId, target: { kind: "shape", shapeId: held.shapeId, point: held.point }, down: e, recycle: { kind: "shape", at, hits } }
      return
    }
    const pick = cyclePick(hits, shapeKey, at, cycle)
    cycle = pick.cycle
    const choice = pick.choice
    if (choice) {
      if (toggle) {
        setSelection({ levelId, shapeIds: ids.includes(choice.shapeId) ? ids.filter((id) => id !== choice.shapeId) : [...ids, choice.shapeId], elements: [] })
        return
      }
      setSelection({ levelId, shapeIds: [choice.shapeId], elements: [] })
      gesture = { kind: "pending", levelId, target: { kind: "shape", shapeId: choice.shapeId, point: choice.point }, down: e, recycle: null }
      return
    }
    const start = canvasOf(e)
    gesture = { kind: "marquee", levelId, down: e, start, end: start, additive: e.shift || e.ctrl, elements: false, hitShapeId: null }
  }

  /** A click (released without a drag) on a selected candidate: select the next one of the click cycle. */
  const clickCycle = (levelId: Id, r: Recycle) => {
    const sel = activeSelection(store.getState())
    if (!sel || sel.levelId !== levelId) return
    if (r.kind === "shape") {
      const pick = cyclePick(r.hits, shapeKey, r.at, cycle)
      cycle = pick.cycle
      const id = pick.choice?.shapeId
      if (id !== undefined && !(sel.shapeIds.length === 1 && sel.shapeIds[0] === id && sel.elements.length === 0)) {
        setSelection({ levelId, shapeIds: [id], elements: [] })
      }
      return
    }
    const pick = cyclePick(r.hits, elementHitKey, r.at, cycle)
    cycle = pick.cycle
    const ref = pick.choice?.ref
    if (ref && !(sel.elements.length === 1 && sameElement(sel.elements[0], ref))) setSelection({ ...sel, elements: [ref] })
  }

  const finishMarquee = (m: Marquee, e: ToolPointerEvent) => {
    const s = store.getState()
    const a = activeLevel(s)
    if (!a || a.levelId !== m.levelId) return
    const sel = activeSelection(s)
    const end = canvasOf(e) ?? m.end
    if (!marqueeBox({ start: m.start, end }) || !deps.project || !m.start || !end) {
      // A click on nothing.
      if (m.elements) {
        const hit = m.hitShapeId
        if (hit && m.additive && sel) {
          // Shift / Ctrl adds the shape to the edit session (the element selection stays).
          if (!sel.shapeIds.includes(hit)) setSelection({ ...sel, shapeIds: [...sel.shapeIds, hit] })
        } else if (hit) setSelection({ levelId: m.levelId, shapeIds: [hit], elements: [] })
        else if (sel && !m.additive && sel.elements.length > 0) setSelection({ ...sel, elements: [] })
      } else if (!m.additive) {
        setSelection(null)
      }
      cycle = null
      return
    }
    const rect = screenRect(m.start, end)
    const rec = levelShapes(a.level)
    if (m.elements) {
      if (!sel) return
      const inside = elementsInScreenRect(selectedShapes(sel, rec), a.level.elevation, deps.project, rect, s.toolSettings.terrain.element)
      const elements = m.additive ? [...sel.elements, ...inside.filter((x) => !sel.elements.some((y) => sameElement(x, y)))] : inside
      setSelection({ ...sel, elements })
      return
    }
    const inside = shapesInScreenRect(Object.values(rec), a.level.elevation, deps.project, rect)
    const ids = m.additive && sel ? [...sel.shapeIds, ...inside.filter((id) => !sel.shapeIds.includes(id))] : inside
    setSelection(ids.length > 0 ? { levelId: m.levelId, shapeIds: ids, elements: [] } : null)
  }

  const cancelGesture = () => {
    if (gesture?.kind === "drag") endDrag(gesture, false)
    gesture = null
  }

  return {
    gestureLevel: () => gesture?.levelId ?? null,
    captures: () => gesture !== null,

    pointerDown(e) {
      if (e.button !== 0) {
        if (e.button === 2) cancelGesture()
        return
      }
      if (gesture) cancelGesture()
      const ray = rayOf(e)
      const s = store.getState()
      const a = activeLevel(s)
      if (!ray || !a) return
      hover = NO_HOVER
      const sel = activeSelection(s)
      const g = gizmoHit(e)
      if (g) {
        gesture = { kind: "pending", levelId: a.levelId, target: { kind: "gizmo", part: g.part, point: g.at }, down: e, recycle: null }
      } else if (editMode(s)) {
        pressElement(e, ray, a.levelId, a.level, sel!)
      } else {
        pressShape(e, ray, a.levelId, a.level, sel)
      }
      ctx.changed()
    },

    pointerMove(e) {
      if (!gesture) {
        updateHover(e)
        return
      }
      if (!rayOf(e)) return
      if (gesture.kind === "marquee") {
        // Drawn (TerrainOverlay.marquee) once it is a drag; the release selects.
        const was = marqueeBox(gesture)
        gesture.end = canvasOf(e) ?? gesture.end
        const box = marqueeBox(gesture)
        if (box || was) ctx.changed()
        return
      }
      if (gesture.kind === "pending") {
        if (pressTravel(gesture.down, e) < DRAG_THRESHOLD_PX || store.getState().readOnly) return
        const d = startDrag(gesture)
        if (!d) {
          gesture = null
          return
        }
        gesture = d
      }
      dragTo(gesture, e)
    },

    pointerUp(e) {
      const g = gesture
      if (!g) return
      switch (g.kind) {
        case "pending":
          gesture = null
          if (g.recycle && !e.shift && !e.ctrl) clickCycle(g.levelId, g.recycle)
          break
        case "drag":
          if (rayOf(e)) dragTo(g, e)
          endDrag(g, true)
          break
        case "marquee":
          gesture = null
          finishMarquee(g, e)
          break
      }
      ctx.changed()
    },

    key(k) {
      if (k.type !== "axis" || !gesture || gesture.kind === "marquee") return false
      if (gesture.kind === "pending") {
        const d = startDrag(gesture)
        if (!d) return false
        gesture = d
      }
      const d = gesture
      if (d.rotate) return true
      d.axis = d.axis === k.axis ? null : k.axis
      d.axisFromHandle = false
      d.follow = null
      // Recompute right away from the last pointer event (no move comes with the key).
      const delta = dragDelta(d, d.last)
      if (delta) applyDelta(d, delta)
      ctx.changed()
      return true
    },

    cancel() {
      cancelGesture()
      hover = NO_HOVER
    },

    refresh() {
      // Alt from the store: the last event's flag is stale when Alt was pressed / released without a move.
      if (gesture?.kind === "drag") dragTo(gesture, { ...gesture.last, alt: store.getState().altHeld })
    },

    parts() {
      const drag = gesture?.kind === "drag" ? gesture : null
      const subs = drag?.current ?? null
      const at = gizmoAt(subs)
      const active: GizmoPart | null = drag?.rotate ? "rotate" : (drag?.axis ?? (gesture?.kind === "pending" && gesture.target.kind === "gizmo" ? gesture.target.part : null))
      const gizmo = at ? { at, active, hover: gesture ? null : hover.gizmo } : null
      const label = drag?.rotate
        ? drag.rotate.angle !== 0
          ? { at: at ?? drag.grab, text: angleLabel(drag.rotate.angle) }
          : null
        : drag && !isZero(drag.delta)
          ? { at: at ?? drag.grab, text: offsetLabel(drag.delta) }
          : null
      return {
        ...NO_PARTS,
        substitutes: subs,
        hoverShapeId: gesture ? null : hover.shapeId,
        hoverElement: gesture ? null : hover.element,
        gizmo,
        label,
        marquee: gesture?.kind === "marquee" ? marqueeBox(gesture) : null,
      }
    },

    cursor() {
      if (gesture?.kind === "drag") return "grabbing"
      if (gesture?.kind === "marquee") return "crosshair"
      if (store.getState().readOnly) return hover.shapeId || hover.element ? "pointer" : null
      if (hover.gizmo === "rotate") return "grab"
      if (hover.gizmo || hover.element) return "move"
      if (hover.shapeId) return activeSelection(store.getState())?.shapeIds.includes(hover.shapeId) ? "move" : "pointer"
      return null
    },

    hint() {
      const s = store.getState()
      if (gesture?.kind === "drag") {
        if (gesture.preview.offFloor()) return "No floor here: terrain is drawn only under floors"
        if (gesture.rotate) return "Drag around the ring to rotate (15° steps, Alt: free) · Esc cancels"
        return "X / Y / Z constrain the move · Esc cancels"
      }
      const sel = activeSelection(s)
      if (!sel) return "Click a shape to select it, drag to select several"
      if (editMode(s)) {
        const kind = s.toolSettings.terrain.element
        return `Editing ${kind === "vertex" ? "vertices" : kind === "edge" ? "edges" : "faces"}: click or drag a box to select, drag to move (1 / 2 / 3 switch, Tab: object mode)`
      }
      return "Drag to move, drag the green ring to rotate (R: 90°) · Tab: edit vertices/edges/faces"
    },
  }
}
