/**
 * The cursor readout (cell and world point under the cursor in Edit), kept outside React state so only
 * the status bar re-renders when it changes.
 */
import { createStore, type StoreApi } from "zustand/vanilla"

export interface CursorReadout {
  i: number
  j: number
  x: number
  /** Height above the active level's ground (feet). */
  y: number
  z: number
  inside: boolean
}

export type CursorStore = StoreApi<{ cursor: CursorReadout | null }>

export function createCursorStore(): CursorStore {
  return createStore<{ cursor: CursorReadout | null }>()(() => ({ cursor: null }))
}

export function sameCursor(a: CursorReadout | null, b: CursorReadout | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.i === b.i && a.j === b.j && Math.abs(a.x - b.x) < 0.05 && Math.abs(a.y - b.y) < 0.05 && Math.abs(a.z - b.z) < 0.05
}
