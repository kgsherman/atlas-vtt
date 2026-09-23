/**
 * Screen-space interaction math shared by the terrain tool (hit testing, drags) and the renderer (which
 * draws the same gizmo handles): the translate gizmo's handles, the relative "height follows the cursor"
 * mapping of shape creation (ARCHITECTURE §7 "Terrain tools"), closest points for axis-constrained drags
 * and screen-space picking distances. Pure: the camera comes in as a projection function (Engine.project:
 * world point → canvas-relative CSS px, y down).
 */
import type { Vec3 } from "../scene/types"

/** Translate-gizmo axis (world X / Y / Z); the same union as render/contracts GizmoAxis. */
export type GizmoAxis = "x" | "y" | "z"

/** Canvas-relative CSS pixels (y grows downward). */
export interface ScreenPoint {
  x: number
  y: number
}

/** World → canvas CSS px; null or `visible: false` when the point cannot be shown (behind the camera). */
export type Projector = (p: Vec3) => { x: number; y: number; visible: boolean } | null

/** A handle's shaft runs from this many px from the gizmo centre… */
export const GIZMO_SHAFT_START_PX = 14
/** …to this many px, along the axis' projected direction (constant screen size). */
export const GIZMO_SHAFT_END_PX = 70
/** Default pointer distance (px) from a shaft that grabs it. */
export const GIZMO_HIT_RADIUS_PX = 7
/** An axis whose projected 1-ft unit is below this many px is hidden… */
export const GIZMO_MIN_UNIT_PX = 2
/**
 * …unless it is at least this fraction of the longest projected axis unit (so zoomed-out views, where
 * every axis is below 2 px per foot, keep their gizmo; an axis seen end-on, e.g. Y at tilt 0, stays hidden).
 */
export const GIZMO_MIN_UNIT_RATIO = 0.1
/**
 * Two visible handles whose screen directions are within ~8° of each other would draw on top of each other
 * (e.g. Y and a horizontal axis pointing away from a turned top-down camera): the one with the shorter
 * projected unit is hidden, so the arrow drawn is the arrow hit. It stays reachable through the X / Y / Z keys.
 */
export const GIZMO_MIN_SEPARATION_COS = Math.cos((8 * Math.PI) / 180)

export interface GizmoHandle {
  axis: GizmoAxis
  /** false: not drawn and not hit (axis seen end-on or not projectable). */
  visible: boolean
  /** Screen position of the gizmo centre. */
  origin: ScreenPoint
  /** Unit screen direction of the axis (+ direction); (0, 0) when not projectable. */
  dir: ScreenPoint
  /** Shaft start / end: origin + dir·GIZMO_SHAFT_START_PX / GIZMO_SHAFT_END_PX. */
  from: ScreenPoint
  to: ScreenPoint
  /**
   * Projected length (px) of 1 ft along the axis at the centre. The renderer draws the shaft from
   * GIZMO_SHAFT_START_PX / unitPx to GIZMO_SHAFT_END_PX / unitPx feet along the world axis.
   */
  unitPx: number
}

export type GizmoHandles = Record<GizmoAxis, GizmoHandle>

const AXES: readonly GizmoAxis[] = ["x", "y", "z"]

/** Unit world vector of an axis. */
export function axisVector(axis: GizmoAxis): Vec3 {
  return { x: axis === "x" ? 1 : 0, y: axis === "y" ? 1 : 0, z: axis === "z" ? 1 : 0 }
}

const addScaled = (p: Vec3, v: Vec3, s: number): Vec3 => ({ x: p.x + v.x * s, y: p.y + v.y * s, z: p.z + v.z * s })

function projectVisible(project: Projector, p: Vec3): ScreenPoint | null {
  const q = project(p)
  if (!q || !q.visible || !Number.isFinite(q.x) || !Number.isFinite(q.y)) return null
  return { x: q.x, y: q.y }
}

/**
 * The translate gizmo's three handles at world point `at` (see GizmoHandle). Hidden: axes seen end-on
 * (GIZMO_MIN_UNIT_PX / GIZMO_MIN_UNIT_RATIO) and the shorter of two that point the same way on screen
 * (GIZMO_MIN_SEPARATION_COS).
 */
export function gizmoHandles(project: Projector, at: Vec3): GizmoHandles {
  const origin = projectVisible(project, at)
  const units: { axis: GizmoAxis; dir: ScreenPoint; unitPx: number }[] = AXES.map((axis) => {
    const tip = origin ? projectVisible(project, addScaled(at, axisVector(axis), 1)) : null
    if (!origin || !tip) return { axis, dir: { x: 0, y: 0 }, unitPx: 0 }
    const dx = tip.x - origin.x
    const dy = tip.y - origin.y
    const len = Math.sqrt(dx * dx + dy * dy)
    return { axis, dir: len > 0 ? { x: dx / len, y: dy / len } : { x: 0, y: 0 }, unitPx: len }
  })
  const maxUnit = Math.max(...units.map((u) => u.unitPx))
  const minUnit = Math.min(GIZMO_MIN_UNIT_PX, GIZMO_MIN_UNIT_RATIO * maxUnit)
  const o = origin ?? { x: 0, y: 0 }
  const out = {} as GizmoHandles
  for (const u of units) {
    out[u.axis] = {
      axis: u.axis,
      visible: origin !== null && u.unitPx > 0 && u.unitPx >= minUnit,
      origin: { ...o },
      dir: u.dir,
      from: { x: o.x + u.dir.x * GIZMO_SHAFT_START_PX, y: o.y + u.dir.y * GIZMO_SHAFT_START_PX },
      to: { x: o.x + u.dir.x * GIZMO_SHAFT_END_PX, y: o.y + u.dir.y * GIZMO_SHAFT_END_PX },
      unitPx: u.unitPx,
    }
  }
  for (let i = 0; i < AXES.length; i++) {
    for (let j = i + 1; j < AXES.length; j++) {
      const a = out[AXES[i]]
      const b = out[AXES[j]]
      if (!a.visible || !b.visible || a.dir.x * b.dir.x + a.dir.y * b.dir.y <= GIZMO_MIN_SEPARATION_COS) continue
      ;(a.unitPx < b.unitPx ? a : b).visible = false
    }
  }
  return out
}

/** Distance (px) from p to the segment a–b. */
export function pointToSegmentDistancePx(p: ScreenPoint, a: ScreenPoint, b: ScreenPoint): number {
  const ex = b.x - a.x
  const ey = b.y - a.y
  const len2 = ex * ex + ey * ey
  let t = len2 > 0 ? ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const dx = a.x + t * ex - p.x
  const dy = a.y + t * ey - p.y
  return Math.sqrt(dx * dx + dy * dy)
}

/** The visible handle whose shaft is nearest to `p` within `radiusPx` (ties: x, y, z), or null. */
export function hitGizmo(handles: GizmoHandles, p: ScreenPoint, radiusPx = GIZMO_HIT_RADIUS_PX): GizmoAxis | null {
  let best: GizmoAxis | null = null
  let bestD = Infinity
  for (const axis of AXES) {
    const h = handles[axis]
    if (!h.visible) continue
    const d = pointToSegmentDistancePx(p, h.from, h.to)
    if (d <= radiusPx && d < bestD) {
      best = axis
      bestD = d
    }
  }
  return best
}

/**
 * The point of the line origin + s·axisDir closest to the ray's line (for axis-constrained drags: the
 * drag delta is s(now) − s(at grab), in units of axisDir). Null when the ray is (nearly) parallel to the axis.
 */
export function closestPointOnAxis(ray: { origin: Vec3; direction: Vec3 }, origin: Vec3, axisDir: Vec3): { s: number; point: Vec3 } | null {
  const d = ray.direction
  const e = axisDir
  const wx = ray.origin.x - origin.x
  const wy = ray.origin.y - origin.y
  const wz = ray.origin.z - origin.z
  const a = d.x * d.x + d.y * d.y + d.z * d.z
  const b = d.x * e.x + d.y * e.y + d.z * e.z
  const c = e.x * e.x + e.y * e.y + e.z * e.z
  const dw = d.x * wx + d.y * wy + d.z * wz
  const ew = e.x * wx + e.y * wy + e.z * wz
  const denom = a * c - b * b
  // denom = |d|²|e|² sin²θ: parallel within ~0.06°.
  if (!(denom > 1e-6 * a * c)) return null
  const s = (a * ew - b * dw) / denom
  if (!Number.isFinite(s)) return null
  return { s, point: addScaled(origin, e, s) }
}

// ---------------------------------------------------------------------------
// Height follows the cursor (shape creation's height phase)
// ---------------------------------------------------------------------------

/**
 * State of the relative height mapping h = hRef + dot(c − cRef, u) / k (c = cursor px). Treat as
 * immutable; pass the previous value to `heightFromPointer`.
 */
export interface HeightFollowState {
  /** Height (ft) at the last cursor, relative to the anchor. */
  h: number
  hRef: number
  cRef: ScreenPoint
  /** Last cursor position seen. */
  last: ScreenPoint
  /** Projection parameters the current reference was taken with. */
  anchorPx: ScreenPoint
  /** Unit screen direction of world "up" at the anchor ((0, −1) = screen up when "up" projects to a point). */
  u: ScreenPoint
  /** Pixels per foot. */
  k: number
  /**
   * Projected length (px) of 1 ft of world up at the anchor. Below k while the gain floor is active: the
   * anchor's vertical then moves slower on screen than the cursor (so a label at anchor + h lags behind it).
   */
  upPx: number
}

/** Re-anchor when the anchor moves on screen by more than this (px)… */
const REANCHOR_PX = 0.5
/** …or k changes by more than this fraction… */
const REANCHOR_K = 0.01
/** …or the screen "up" direction turns (cos of ~0.8°). */
const REANCHOR_COS = 0.9999

/** Options of the height-follow mapping. */
export interface HeightFollowOptions {
  /**
   * Use screen up (0, −1) for u whenever the gain floor is active (|axis| < 0.25·ppfH), not only when "up"
   * projects to a point. For creation's height phase and key-toggled Y drags: in a straight-down
   * perspective view world up projects radially from the screen centre, so near the centre the radial
   * direction is tiny and arbitrary (moving the cursor up could carve). A drag on the drawn Y handle keeps
   * the projected axis, the direction the handle points.
   */
  screenUpWhenFloored?: boolean
}

/**
 * Projection parameters at world point `anchor`: axis = project(anchor + 1 ft up) − project(anchor);
 * ppfH = |project(anchor + 1 ft along the camera right) − project(anchor)|, the camera right being the
 * horizontal direction perpendicular to the ray's horizontal component (world X for a vertical ray);
 * k = max(|axis|, 0.25·ppfH) (the gain floor); u = axis/|axis|, or (0, −1) when |axis| < 1e-3 px (and, with
 * `screenUpWhenFloored`, whenever the floor is active); upPx = |axis|. Null when not projectable.
 */
export function heightFollowParams(
  project: Projector,
  anchor: Vec3,
  rayDir: Vec3,
  opts: HeightFollowOptions = {}
): Pick<HeightFollowState, "anchorPx" | "u" | "k" | "upPx"> | null {
  const p0 = projectVisible(project, anchor)
  const pUp = projectVisible(project, { x: anchor.x, y: anchor.y + 1, z: anchor.z })
  const hLen = Math.sqrt(rayDir.x * rayDir.x + rayDir.z * rayDir.z)
  const dLen = Math.sqrt(hLen * hLen + rayDir.y * rayDir.y)
  const right = hLen > 1e-6 * dLen ? { x: -rayDir.z / hLen, y: 0, z: rayDir.x / hLen } : { x: 1, y: 0, z: 0 }
  const pR = projectVisible(project, addScaled(anchor, right, 1))
  if (!p0 || !pUp || !pR) return null
  const ax = pUp.x - p0.x
  const ay = pUp.y - p0.y
  const axisLen = Math.sqrt(ax * ax + ay * ay)
  const ppfH = Math.sqrt((pR.x - p0.x) * (pR.x - p0.x) + (pR.y - p0.y) * (pR.y - p0.y))
  const floor = 0.25 * ppfH
  const u = axisLen < 1e-3 || (opts.screenUpWhenFloored && axisLen < floor) ? { x: 0, y: -1 } : { x: ax / axisLen, y: ay / axisLen }
  const k = Math.max(axisLen, floor)
  if (!(k > 0) || !Number.isFinite(k)) return null
  return { anchorPx: p0, u, k, upPx: axisLen }
}

/**
 * Relative height-follow (DESIGN §3.3): h = hRef + dot(cursor − cRef, u)/k, anchored at the release point
 * (state null → h = 0 at `cursor`). Whenever the projection of `anchor` moves > 0.5 px, k changes > 1% or
 * u turns (zoom, orbit, pan), the reference is re-taken at the previous cursor with the previous h, so h
 * stays continuous. `freeze` (camera being dragged) keeps h and re-anchors at the current cursor, so the
 * cursor's travel during the camera drag is ignored. Returns null only for a null state that cannot be
 * projected; a later unprojectable call returns the state re-anchored at the cursor with h unchanged.
 * `rayDir` is the pointer ray's direction (it fixes the camera right). Snapping is the caller's job.
 */
export function heightFromPointer(
  state: HeightFollowState | null,
  anchor: Vec3,
  cursor: ScreenPoint,
  project: Projector,
  rayDir: Vec3,
  opts: HeightFollowOptions & { freeze?: boolean } = {}
): HeightFollowState | null {
  const params = heightFollowParams(project, anchor, rayDir, opts)
  const c = { x: cursor.x, y: cursor.y }
  if (!state) return params ? { h: 0, hRef: 0, cRef: c, last: c, ...params } : null
  if (!params) return { ...state, hRef: state.h, cRef: c, last: c }
  if (opts.freeze) return { ...state, hRef: state.h, cRef: c, last: c, ...params }
  let ref = state
  const moved = Math.hypot(params.anchorPx.x - state.anchorPx.x, params.anchorPx.y - state.anchorPx.y)
  const turned = params.u.x * state.u.x + params.u.y * state.u.y
  if (moved > REANCHOR_PX || Math.abs(params.k - state.k) > REANCHOR_K * state.k || turned < REANCHOR_COS) {
    ref = { ...state, hRef: state.h, cRef: state.last, ...params }
  }
  const h = ref.hRef + ((c.x - ref.cRef.x) * ref.u.x + (c.y - ref.cRef.y) * ref.u.y) / ref.k
  return { ...ref, h, last: c }
}
