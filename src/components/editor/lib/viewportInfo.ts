/**
 * High-frequency viewport readouts (cursor position, frame stats) kept outside React state so only
 * the status bar re-renders when they change.
 */
import { createStore, type StoreApi } from "zustand/vanilla"

import type { FrameStats } from "@/render/contracts"

export interface CursorReadout {
  i: number
  j: number
  x: number
  /** Height above the active level's ground (feet). */
  y: number
  z: number
  inside: boolean
}

export interface ViewportInfo {
  cursor: CursorReadout | null
  stats: FrameStats | null
}

export type ViewportInfoStore = StoreApi<ViewportInfo>

export function createViewportInfoStore(): ViewportInfoStore {
  return createStore<ViewportInfo>()(() => ({ cursor: null, stats: null }))
}

export function sameCursor(a: CursorReadout | null, b: CursorReadout | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.i === b.i && a.j === b.j && Math.abs(a.x - b.x) < 0.05 && Math.abs(a.y - b.y) < 0.05 && Math.abs(a.z - b.z) < 0.05
}
