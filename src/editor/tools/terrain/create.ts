/**
 * Shape creation sub-tools — block, ramp, cylinder (DESIGN §3.3), Blender style:
 *  1. base: press and drag on the level (block / ramp corners snap like floor edges, the cylinder's centre
 *     with the snap mode, its radius to half cells; Alt = free); the drag runs on the horizontal plane
 *     through the ground at the first corner, never on the (previewed) terrain. A click makes a one-cell base
 *     (block / ramp) or a half-cell radius (cylinder).
 *  2. height: after the release the height follows the cursor relatively (core/geometry/gizmo
 *     heightFromPointer, anchored at the release point, screen up where world up is foreshortened below
 *     the gain floor; frozen while the camera is dragged), snapped to the height step (Alt = free, also
 *     pressed / released without a move). The terrain preview bakes the draft over the level; the label
 *     reads "+7.5 ft · Add" / "−3 ft · Carve" (the sign of the height picks add or carve) and stays at the
 *     cursor (at the draft's corner, or on the pointer ray where the corner barely moves on screen).
 *  3. confirm with a click or Enter (one undo step through store.applyTerrainEdit; the new shape is
 *     selected); right-click or Escape cancel. R / Shift+R turn a ramp's slope during the height phase.
 */
import { cellOf, cellRect, snapPoint } from "@/core/grid/grid"
import { closestPointOnAxis, heightFromPointer, type HeightFollowState } from "@/core/geometry/gizmo"
import { newId } from "@/core/scene/factory"
import { MAX_TERRAIN_HEIGHT } from "@/core/scene/heightmapBrush"
import { levelGround, rectIntersection } from "@/core/scene/queries"
import { blockShape, cylinderShape, nextShapeOrder, rampShape, shapeBounds } from "@/core/scene/terrainShapes"
import type { Id, Rect, TerrainShape, Vec2, Vec3 } from "@/core/scene/types"

import type { TerrainSubTool } from "../../settings"
import { clampToExtent, edgeSnapMode, extentRect } from "../../snapping"
import {
  formatFeet,
  heightLabel,
  horizontalForward,
  maxRadiusInExtent,
  rampDirection,
  rayPlaneY,
  screenUpForward,
  shapeAcceptable,
  snapHeight,
  turnRampDir,
  type RampDir,
  type Ray,
} from "../../terrainMath"
import { rectFromCorners } from "../shared"
import type { ToolPointerEvent } from "../types"
import {
  activeLevel,
  cameraDragging,
  canvasOf,
  groundOf,
  heightStepOf,
  levelShapes,
  NO_PARTS,
  rayOf,
  snapModeOf,
  type SubTool,
  type TerrainToolContext,
} from "./context"
import { createShapePreview, type ShapePreview } from "./lattice"

export type CreateKind = Extract<TerrainSubTool, "block" | "ramp" | "cylinder">

/** Bases thinner than this (feet) count as a click. */
const MIN_SIZE = 0.1
/** Smallest cylinder radius (feet). */
const MIN_RADIUS = 0.25
/** Hysteresis of the ramp direction while dragging the base. */
const RAMP_HYSTERESIS = 1.25

export const NO_FLOOR_HINT = "No floor here: terrain is drawn only under floors"

type Footprint = { kind: "rect"; rect: Rect } | { kind: "circle"; center: Vec2; radius: number }

interface Common {
  levelId: Id
  shape: CreateKind
  elevation: number
  /** Ground (baked terrain) under the snapped first corner / centre, relative to the elevation. */
  y0: number
  /** Ramp rise direction. */
  dir: RampDir
  preview: ShapePreview
}

type Phase =
  | (Common & {
      kind: "base"
      p0: Vec2
      /** Raw (unsnapped) press point: its cell is the one-cell base of a click. */
      p0Raw: Vec2
      /** Current corner (block / ramp: snapped; cylinder: raw rim point). */
      p1: Vec2
      /** Direction set by the drag (null: none yet, a click rises away from the camera). */
      dragDir: RampDir | null
      forward: Vec2 | null
      last: ToolPointerEvent
    })
  | (Common & {
      kind: "height"
      footprint: Footprint
      /** Release point (world) the height is anchored at. */
      anchor: Vec3
      follow: HeightFollowState | null
      /** Last pointer ray (the label sits on it where the corner lags behind the cursor). */
      ray: Ray | null
      /** Without a projector: the ray's closest point on the vertical through the anchor at release, minus h. */
      axisRef: number | null
      /** Raw height (feet, relative to y0); snapped in draft(). */
      h: number
      alt: boolean
    })
  /** Confirmed with a press: swallow events until the button is released (no new base). */
  | { kind: "swallow" }

const UP: Vec3 = { x: 0, y: 1, z: 0 }

/** Height-follow of the height phase: screen up wherever the gain floor is active (DESIGN §3.3). */
const FOLLOW = { screenUpWhenFloored: true } as const

/**
 * The height label rides the pointer ray (not the draft's corner): the gain floor is active, so the corner
 * barely moves on screen while the cursor does.
 */
const labelOnRay = (p: Pick<Extract<Phase, { kind: "height" }>, "follow">): boolean => p.follow !== null && p.follow.upPx < p.follow.k

export function createShapeSubTool(ctx: TerrainToolContext, shape: CreateKind): SubTool {
  const { store, deps } = ctx
  let phase: Phase | null = null

  const grid = () => store.getState().scene.grid

  /** The base the base phase describes (clamped to the scene extent). */
  const footprintOf = (p: Extract<Phase, { kind: "base" }>, free: boolean): Footprint => {
    const g = grid()
    if (p.shape === "cylinder") {
      const half = g.cellSize / 2
      let r = Math.hypot(p.p1.x - p.p0.x, p.p1.z - p.p0.z)
      if (r < MIN_RADIUS) r = half
      else if (!free) r = Math.max(half, Math.round(r / half) * half)
      r = Math.max(MIN_RADIUS, Math.min(r, maxRadiusInExtent(p.p0, g)))
      return { kind: "circle", center: { ...p.p0 }, radius: r }
    }
    const extent = extentRect(g)
    let rect: Rect | null = rectFromCorners(p.p0, p.p1)
    if (rect.w < MIN_SIZE || rect.d < MIN_SIZE) {
      const c = cellOf(g, p.p0Raw)
      rect = cellRect(g, { i: Math.min(Math.max(c.i, 0), g.width - 1), j: Math.min(Math.max(c.j, 0), g.depth - 1) })
    }
    return { kind: "rect", rect: rectIntersection(rect, extent) ?? rect }
  }

  const makeShape = (id: Id, f: Footprint, p: Common, h: number, order: number): TerrainShape => {
    if (f.kind === "circle") return cylinderShape(id, f.center, f.radius, store.getState().toolSettings.terrain.cylinderSides, p.y0, h, order)
    return p.shape === "ramp" ? rampShape(id, f.rect, p.dir, p.y0, h, order) : blockShape(id, f.rect, p.y0, h, order)
  }

  /** The height phase's snapped height, kept inside ±MAX_TERRAIN_HEIGHT. */
  const snappedHeight = (p: Extract<Phase, { kind: "height" }>): number => {
    const h = snapHeight(p.h, heightStepOf(store, { alt: p.alt }))
    return Math.min(MAX_TERRAIN_HEIGHT - p.y0, Math.max(-MAX_TERRAIN_HEIGHT - p.y0, h))
  }

  /** The last draft handed out: an equal draft keeps its identity (the renderer rebuilds on a new object). */
  let lastDraft: TerrainShape | null = null
  const stable = (s: TerrainShape): TerrainShape => {
    const prev = lastDraft
    if (prev && prev.op === s.op && prev.base === s.base && prev.points.length === s.points.length) {
      if (prev.points.every((p, k) => p.x === s.points[k].x && p.y === s.points[k].y && p.z === s.points[k].z)) return prev
    }
    lastDraft = s
    return s
  }

  /** The draft of the current phase (zero-height prism during the base phase). */
  const draft = (): { shape: TerrainShape; h: number } | null => {
    if (!phase || phase.kind === "swallow") return null
    if (phase.kind === "base") return { shape: stable(makeShape("draft", footprintOf(phase, snapModeOf(store, phase.last) === "free"), phase, 0, 0)), h: 0 }
    const h = snappedHeight(phase)
    return { shape: stable(makeShape("draft", phase.footprint, phase, h, 0)), h }
  }

  /** Re-bake the terrain preview for the height phase (only when the snapped draft changed). */
  const updatePreview = () => {
    if (phase?.kind !== "height") return
    const level = store.getState().scene.levels[phase.levelId]
    const shapes = Object.values(levelShapes(level))
    const d = draft()
    if (!d || d.h === 0) {
      phase.preview.update(shapes, null, "none")
      return
    }
    // The draft bakes last (its order is above every shape's), like the committed shape will.
    const s = { ...d.shape, order: nextShapeOrder(level) }
    phase.preview.update([...shapes, s], shapeBounds(s), `${s.op}|${s.points.map((q) => `${q.x},${q.y},${q.z}`).join(";")}`)
  }

  const cancel = () => {
    if (phase && phase.kind !== "swallow") phase.preview.end(false)
    phase = null
  }

  const commit = (swallow: boolean) => {
    if (phase?.kind !== "height") return
    const p = phase
    const h = snappedHeight(p)
    phase = swallow ? { kind: "swallow" } : null
    if (h === 0) {
      p.preview.end(false)
      return
    }
    const s = store.getState()
    if (!Object.hasOwn(s.scene.levels, p.levelId)) {
      p.preview.end(false)
      return
    }
    const level = s.scene.levels[p.levelId]
    const created = makeShape(newId(), p.footprint, p, h, nextShapeOrder(level))
    if (!shapeAcceptable(created, s.scene.grid)) {
      p.preview.end(false)
      ctx.notify("This shape can't be created here")
      return
    }
    const before = level.heightmap
    const ok = ctx.write(() => s.applyTerrainEdit(p.levelId, { upsert: [created] }, `Add terrain ${shape}`))
    const after = store.getState().scene.levels[p.levelId]?.heightmap
    p.preview.end(ok && after !== before)
    if (ok) ctx.write(() => store.getState().setTerrainSelection({ levelId: p.levelId, shapeIds: [created.id], elements: [] }))
    else ctx.notify("This shape can't be created here")
  }

  /** Base phase: the rim / far corner under the pointer (ray ∩ the base plane; the terrain pick when parallel). */
  const moveBase = (p: Extract<Phase, { kind: "base" }>, e: ToolPointerEvent) => {
    const ray = rayOf(e)
    if (!ray) return
    const q = rayPlaneY(ray, p.elevation + p.y0) ?? groundOf(e)
    if (!q) return
    p.last = e
    const g = grid()
    const raw = { x: q.x, z: q.z }
    const mode = snapModeOf(store, e)
    if (p.shape === "cylinder") p.p1 = raw
    else p.p1 = clampToExtent(g, mode === "free" ? raw : snapPoint(g, raw, edgeSnapMode(mode)))
    if (p.shape === "ramp") {
      const dx = p.p1.x - p.p0.x
      const dz = p.p1.z - p.p0.z
      if (Math.abs(dx) >= MIN_SIZE || Math.abs(dz) >= MIN_SIZE) {
        p.dragDir = rampDirection(dx, dz, p.dragDir, p.forward, RAMP_HYSTERESIS)
        p.dir = p.dragDir
      }
    }
  }

  /** Height phase: the height under the pointer (relative, anchored at the release point). */
  const moveHeight = (p: Extract<Phase, { kind: "height" }>, e: ToolPointerEvent) => {
    const ray = rayOf(e)
    if (!ray) return
    p.alt = e.alt
    p.ray = ray
    const cursor = canvasOf(e)
    const next =
      deps.project && cursor ? heightFromPointer(p.follow, p.anchor, cursor, deps.project, ray.direction, { ...FOLLOW, freeze: cameraDragging(e) }) : null
    if (next) {
      p.follow = next
      p.h = next.h
    } else if (!p.follow && !cameraDragging(e)) {
      // No projection (tests, no engine yet): the ray's closest point on the vertical through the anchor.
      const s = closestPointOnAxis(ray, p.anchor, UP)?.s
      if (s !== undefined) {
        if (p.axisRef === null) p.axisRef = s - p.h
        p.h = s - p.axisRef
      }
    }
    updatePreview()
  }

  const startHeight = (p: Extract<Phase, { kind: "base" }>, e: ToolPointerEvent) => {
    const footprint = footprintOf(p, snapModeOf(store, p.last) === "free")
    const corner = footprint.kind === "rect" ? cornerNear(footprint.rect, p.p1) : p.p1
    const anchor = { x: corner.x, y: p.elevation + p.y0, z: corner.z }
    const ray: Ray | null = rayOf(e)
    const cursor = canvasOf(e)
    const follow = ray && cursor && deps.project ? heightFromPointer(null, anchor, cursor, deps.project, ray.direction, FOLLOW) : null
    const axisRef = !follow && ray ? (closestPointOnAxis(ray, anchor, UP)?.s ?? null) : null
    phase = {
      kind: "height",
      levelId: p.levelId,
      shape: p.shape,
      elevation: p.elevation,
      y0: p.y0,
      // A drag fixed it (dominant axis); a click keeps the initial one: rising away from the camera.
      dir: p.dir,
      preview: p.preview,
      footprint,
      anchor,
      follow,
      ray,
      axisRef,
      h: 0,
      alt: e.alt,
    }
    updatePreview()
  }

  return {
    gestureLevel: () => (phase && phase.kind !== "swallow" ? phase.levelId : null),
    captures: () => phase?.kind === "base",

    pointerDown(e) {
      if (e.button === 2) {
        cancel()
        ctx.changed()
        return
      }
      if (e.button !== 0) return
      if (phase?.kind === "height") {
        // The confirming press's Alt decides the snapping (as the label showed it).
        phase.alt = e.alt
        commit(true)
        ctx.changed()
        return
      }
      if (phase) return
      const s = store.getState()
      const a = activeLevel(s)
      if (!a || s.readOnly || !e.ground) return
      const g = s.scene.grid
      const mode = snapModeOf(store, e)
      const raw = clampToExtent(g, e.ground)
      let p0: Vec2
      if (mode === "free") p0 = { ...raw }
      else p0 = clampToExtent(g, snapPoint(g, raw, shape === "cylinder" ? mode : edgeSnapMode(mode)))
      const y0 = levelGround(s.scene, a.levelId, p0.x, p0.z) - a.level.elevation
      const ray = rayOf(e)
      const at = { x: p0.x, y: a.level.elevation + y0, z: p0.z }
      const forward = (ray && horizontalForward(ray.direction)) ?? (deps.project ? screenUpForward(deps.project, at) : null)
      phase = {
        kind: "base",
        levelId: a.levelId,
        shape,
        elevation: a.level.elevation,
        y0,
        dir: rampDirection(0, 0, null, forward),
        preview: createShapePreview(deps, s.scene, a.levelId),
        p0,
        p0Raw: raw,
        p1: { ...p0 },
        dragDir: null,
        forward,
        last: e,
      }
      ctx.changed()
    },

    pointerMove(e) {
      if (!phase || phase.kind === "swallow") return
      const before = draft()?.shape
      // The label on the pointer ray moves with every move (also sideways, within one height step).
      let onRay = phase.kind === "height" && labelOnRay(phase)
      if (phase.kind === "base") moveBase(phase, e)
      else {
        moveHeight(phase, e)
        onRay ||= labelOnRay(phase)
      }
      // Redraw when the (snapped) draft changed or the label follows the pointer ray.
      if (draft()?.shape !== before || onRay) ctx.changed()
    },

    pointerUp(e) {
      if (!phase) return
      if (phase.kind === "swallow") {
        phase = null
        // The hint was blank while swallowing.
        ctx.changed()
        return
      }
      if (phase.kind !== "base") return
      moveBase(phase, e)
      startHeight(phase, e)
      ctx.changed()
    },

    key(k) {
      if (k.type === "confirm") {
        if (phase?.kind !== "height") return false
        commit(false)
        ctx.changed()
        return true
      }
      if (k.type === "rotate" && phase) {
        if (phase.kind === "height" && phase.shape === "ramp") {
          phase.dir = turnRampDir(phase.dir, k.turns)
          updatePreview()
          ctx.changed()
        }
        return true
      }
      return false
    },

    cancel() {
      cancel()
      lastDraft = null
    },

    refresh() {
      // Alt from the store: the last event's flag is stale when Alt was pressed / released without a move.
      const alt = store.getState().altHeld
      if (phase?.kind === "base") moveBase(phase, { ...phase.last, alt })
      else if (phase?.kind === "height") {
        phase.alt = alt
        updatePreview()
      }
    },

    parts() {
      const d = draft()
      if (!d || !phase || phase.kind === "swallow") return NO_PARTS
      const valid = shapeAcceptable(d.shape, grid())
      if (phase.kind === "base") {
        const f = footprintOf(phase, snapModeOf(store, phase.last) === "free")
        const text = f.kind === "circle" ? `r ${formatFeet(f.radius)} ft` : `${formatFeet(f.rect.w)} × ${formatFeet(f.rect.d)} ft`
        return { ...NO_PARTS, draft: { shape: d.shape, valid }, label: { at: { x: phase.p1.x, y: phase.elevation + phase.y0, z: phase.p1.z }, text } }
      }
      // At the draft's corner, which follows the cursor while k is the projected up axis; where the gain floor
      // is active (steep views: the corner barely moves on screen) on the pointer ray at the draft's height.
      const onRay = labelOnRay(phase) && phase.ray ? rayPlaneY(phase.ray, phase.anchor.y + d.h) : null
      const at = onRay ?? { x: phase.anchor.x, y: phase.anchor.y + d.h, z: phase.anchor.z }
      return { ...NO_PARTS, draft: { shape: d.shape, valid }, label: { at, text: heightLabel(d.h) } }
    },

    cursor() {
      if (phase?.kind === "height") return "ns-resize"
      return store.getState().readOnly ? null : "crosshair"
    },

    hint() {
      if (!phase) {
        if (store.getState().readOnly) return null
        return shape === "cylinder" ? "Drag from the centre to set the radius (click: half-cell radius)" : "Drag to draw the base (click: one cell)"
      }
      if (phase.kind === "swallow") return null
      if (phase.kind === "height" && phase.preview.offFloor() && snappedHeight(phase) !== 0) return NO_FLOOR_HINT
      if (phase.kind === "base")
        return shape === "cylinder" ? "Drag to set the radius, release to set the height" : "Drag to draw the base, release to set the height"
      const ramp = phase.shape === "ramp" ? " · R turns the slope" : ""
      return `Move to set the height, click to confirm (Esc cancels)${ramp}`
    },
  }
}

/** The corner of `rect` nearest to `p` (the release corner of a base drag). */
function cornerNear(rect: Rect, p: Vec2): Vec2 {
  const x = Math.abs(p.x - rect.x) <= Math.abs(p.x - (rect.x + rect.w)) ? rect.x : rect.x + rect.w
  const z = Math.abs(p.z - rect.z) <= Math.abs(p.z - (rect.z + rect.d)) ? rect.z : rect.z + rect.d
  return { x, z }
}
