/**
 * Shared plumbing for editor tools: dependencies, pointer snapping and memoised previews.
 */
import { snapPoint, type SnapMode } from "@/core/grid/grid"
import type { Id, Rect, Vec2 } from "@/core/scene/types"
import type { ToolPreview } from "@/render/contracts"

import type { EditorStore } from "../store"
import { effectiveSnapMode } from "../snapping"
import type { ToolPointerEvent } from "./types"

export interface ToolDeps {
  store: EditorStore
  /** Called whenever a tool's preview/overlay changed, so the canvas can redraw. */
  invalidate?(): void
  /** Engine.previewTerrain for the terrain brush (null heights clear the preview). */
  previewTerrain?(levelId: Id, heights: Float32Array | null, dirty: Rect | null): void
  /** Clock in ms (double-click detection; injectable for tests). */
  now?(): number
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

export const PREVIEW_COLOR = "#34d399"
export const INVALID_COLOR = "#f87171"
export const MARQUEE_COLOR = "#60a5fa"

/**
 * A tool preview recomputed only when the tool's own state changed (bump()) or the document,
 * settings, active level or snap mode did, so repeated preview() calls return the SAME object and
 * the renderer does not rebuild it every frame.
 */
export function createPreviewCache(store: EditorStore, compute: () => ToolPreview | null) {
  let version = 0
  let cache: { key: unknown[]; value: ToolPreview | null } | null = null
  return {
    get(): ToolPreview | null {
      const s = store.getState()
      const key = [version, s.scene, s.toolSettings, s.activeLevelId, s.snapMode, s.altHeld]
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
