/**
 * Shared plumbing for editor tools: dependencies, pointer snapping and memoised previews.
 */
import { snapPoint, type SnapMode } from "@/core/grid/grid"
import type { Id, Rect, Vec2, Vec3 } from "@/core/scene/types"
import type { ToolPreview } from "@/render/contracts"

import type { ShortcutAction } from "../shortcuts"
import type { EditorStore } from "../store"
import { effectiveSnapMode } from "../snapping"
import type { ToolKeyEvent, ToolPointerEvent } from "./types"

export interface ToolDeps {
  store: EditorStore
  /** Called whenever a tool's preview/overlay changed, so the canvas can redraw. */
  invalidate?(): void
  /** Engine.previewTerrain for the terrain brush (null heights clear the preview). */
  previewTerrain?(levelId: Id, heights: Float32Array | null, dirty: Rect | null): void
  /** Clock in ms (double-click detection; injectable for tests). */
  now?(): number
  /**
   * Engine.project: world point → canvas-relative CSS px (same frame as ToolPointerEvent.canvasX/Y).
   * The controller always provides it as a live indirection to what the viewport installed with
   * controller.setProjector (null while there is none, e.g. before the engine exists); absent in tests
   * that build tools directly unless injected.
   */
  project?(p: Vec3): { x: number; y: number; visible: boolean } | null
}

/** Snap mode for this event (store mode; Alt held on the event or in the store → free). */
export function pointerSnapMode(store: EditorStore, e: Pick<ToolPointerEvent, "alt">): SnapMode {
  const s = store.getState()
  return effectiveSnapMode(s.snapMode, e.alt || s.altHeld)
}

/** Ground point snapped with the store's snap mode (null when off the level plane). */
export function snappedGround(store: EditorStore, e: Pick<ToolPointerEvent, "alt" | "ground">): Vec2 | null {
  if (!e.ground) return null
  return snapPoint(store.getState().scene.grid, e.ground, pointerSnapMode(store, e))
}

/**
 * The key event means the keymap action `type`: by the action the controller bound to the key (so
 * remapped keys work), or by its default key for events without one (tools driven directly, tests).
 */
export function isKeyAction(e: ToolKeyEvent, type: ShortcutAction["type"]): boolean {
  if (e.action) return e.action.type === type
  const plain = !e.ctrl && !e.alt
  switch (type) {
    case "escape":
      return e.key === "Escape"
    case "confirm":
      return e.key === "Enter"
    case "rotate":
      return plain && e.key.toLowerCase() === "r"
    default:
      return false
  }
}

/** Quarter turns of a "rotate" key event (R = +1, Shift+R = −1), 0 for any other key. */
export function rotateTurns(e: ToolKeyEvent): 1 | -1 | 0 {
  if (!isKeyAction(e, "rotate")) return 0
  if (e.action?.type === "rotate") return e.action.turns
  return e.shift ? -1 : 1
}

export const PREVIEW_COLOR = "#34d399"
export const INVALID_COLOR = "#f87171"
export const MARQUEE_COLOR = "#60a5fa"

/**
 * A tool preview recomputed only when the tool's own state changed (bump()) or the document,
 * settings, active level, snap mode, terrain selection or read-only flag did, so repeated preview()
 * calls return the SAME object and the renderer does not rebuild it every frame.
 */
export function createPreviewCache(store: EditorStore, compute: () => ToolPreview | null) {
  let version = 0
  let cache: { key: unknown[]; value: ToolPreview | null } | null = null
  return {
    get(): ToolPreview | null {
      const s = store.getState()
      const key = [version, s.scene, s.toolSettings, s.activeLevelId, s.snapMode, s.altHeld, s.terrainSelection, s.readOnly]
      if (cache && cache.key.every((v, k) => v === key[k])) return cache.value
      const value = compute()
      cache = { key, value }
      return value
    },
    bump() {
      version++
    },
  }
}

/** Double-click detector over tool pointer-downs (ToolPointerEvent carries no click count). */
export function createClickTracker(now: () => number, maxMs = 400, maxPx = 6) {
  let last: { t: number; x: number; y: number } | null = null
  return {
    /** Register a click; true if it completes a double click. */
    click(e: Pick<ToolPointerEvent, "clientX" | "clientY">): boolean {
      const t = now()
      const double = last !== null && t - last.t <= maxMs && Math.hypot(e.clientX - last.x, e.clientY - last.y) <= maxPx
      last = double ? null : { t, x: e.clientX, y: e.clientY }
      return double
    },
    reset() {
      last = null
    },
  }
}

export const defaultNow = () => (typeof performance !== "undefined" ? performance.now() : Date.now())

export const samePoint = (a: Vec2, b: Vec2, eps = 1e-3) => Math.abs(a.x - b.x) <= eps && Math.abs(a.z - b.z) <= eps

/** Normalised rect spanning two corner points. */
export function rectFromCorners(a: Vec2, b: Vec2): Rect {
  const x = Math.min(a.x, b.x)
  const z = Math.min(a.z, b.z)
  return { x, z, w: Math.abs(b.x - a.x), d: Math.abs(b.z - a.z) }
}
