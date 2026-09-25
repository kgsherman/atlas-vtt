/**
 * The viewer's fog edge style (render/contracts FogStyle), remembered per device and shared by every view
 * on the page (the player page, the DM's token preview): "smooth" = per-pixel edges, "grid" = whole cells.
 * The low render tier always draws the grid, whatever is chosen here.
 */
import * as React from "react"

import type { FogStyle } from "@/render/contracts"

export const FOG_STYLE_KEY = "atlas:fog-style"

export const FOG_STYLE_ITEMS: readonly { value: FogStyle; label: string }[] = [
  { value: "smooth", label: "Smooth" },
  { value: "grid", label: "Grid" },
]

type StorageLike = Pick<Storage, "getItem" | "setItem">

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

export function readFogStyle(storage: StorageLike | null = defaultStorage()): FogStyle {
  try {
    const v = storage?.getItem(FOG_STYLE_KEY)
    if (v === "smooth" || v === "grid") return v
  } catch {
    // Storage unavailable: default.
  }
  return "smooth"
}

let current: FogStyle | null = null
const listeners = new Set<() => void>()

function snapshot(): FogStyle {
  current ??= readFogStyle()
  return current
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setFogStyle(style: FogStyle, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(FOG_STYLE_KEY, style)
  } catch {
    // Storage full / blocked: the choice lasts for this page only.
  }
  if (current === style) return
  current = style
  for (const l of listeners) l()
}

export function useFogStyle(): [FogStyle, (style: FogStyle) => void] {
  const style = React.useSyncExternalStore(subscribe, snapshot, snapshot)
  return [style, React.useCallback((s: FogStyle) => setFogStyle(s), [])]
}
