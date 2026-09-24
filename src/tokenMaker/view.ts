/**
 * The Token Maker stage's view: how the token square sits in the stage viewport. `zoom` 1 fits the
 * token in the viewport with room around it (for the floating toolbar and for layers that reach past
 * the token's edge); the pan offset is in fit units, so resizing the window keeps what is centred.
 * Screen coordinates are viewport-local CSS pixels.
 */
import type { CanvasPoint } from "@/core/tokenMaker/types"

export interface StageView {
  zoom: number
  /** Offset of the token's centre from the viewport's centre, in fit sizes. */
  x: number
  y: number
}

export const DEFAULT_VIEW: Readonly<StageView> = Object.freeze({ zoom: 1, x: 0, y: 0 })
export const MIN_ZOOM = 0.25
export const MAX_ZOOM = 8
/** Button / key zoom step. */
export const ZOOM_STEP = 1.25

/** Room kept free around the fitted token: sides, and top + bottom (toolbar above, zoom controls below). */
const SIDE_MARGIN = 48
const VERTICAL_MARGIN = 120

export interface Viewport {
  width: number
  height: number
}

/** Side of the token square at zoom 1, CSS pixels. */
export function fitSize(vp: Viewport): number {
  return Math.max(64, Math.min(vp.width - SIDE_MARGIN, vp.height - VERTICAL_MARGIN))
}

/** The token square on screen. */
export function tokenRect(view: StageView, vp: Viewport): { left: number; top: number; side: number } {
  const fit = fitSize(vp)
  const side = fit * view.zoom
  return { left: vp.width / 2 + view.x * fit - side / 2, top: vp.height / 2 + view.y * fit - side / 2, side }
}

/** A screen point in canvas units. */
export function screenToCanvas(view: StageView, vp: Viewport, sx: number, sy: number): CanvasPoint {
  const r = tokenRect(view, vp)
  return { x: (sx - r.left) / r.side, y: (sy - r.top) / r.side }
}

export function clampView(view: StageView): StageView {
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom))
  // Keep some of the token on screen: its centre within half a token (plus a fit) of the middle.
  const reach = zoom / 2 + 0.5
  const clamp = (v: number) => Math.min(reach, Math.max(-reach, v))
  return { zoom, x: clamp(view.x), y: clamp(view.y) }
}

/** Zoom by `factor` about a screen point (the canvas point under it stays put). */
export function zoomViewAt(view: StageView, vp: Viewport, sx: number, sy: number, factor: number): StageView {
  const q = screenToCanvas(view, vp, sx, sy)
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor))
  const fit = fitSize(vp)
  const side = fit * zoom
  // New top-left keeps q under the pointer; the centre follows.
  const left = sx - q.x * side
  const top = sy - q.y * side
  return clampView({ zoom, x: (left + side / 2 - vp.width / 2) / fit, y: (top + side / 2 - vp.height / 2) / fit })
}

/** Zoom by `factor` about the viewport's centre. */
export function zoomViewCentre(view: StageView, vp: Viewport, factor: number): StageView {
  return zoomViewAt(view, vp, vp.width / 2, vp.height / 2, factor)
}

/** Pan by a screen-pixel delta. */
export function panView(view: StageView, vp: Viewport, dx: number, dy: number): StageView {
  const fit = fitSize(vp)
  return clampView({ ...view, x: view.x + dx / fit, y: view.y + dy / fit })
}
