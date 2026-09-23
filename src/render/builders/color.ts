/**
 * Colour helpers for the builders. Scene colours are sRGB hex strings; world meshes carry LINEAR
 * albedo in their `color` attribute (see render/internal.ts WORLD_ATTRIBUTES), so every colour is
 * converted here once. Per-face variation is deterministic (hash of a string key) so rebuilds and
 * different clients produce identical meshes.
 */
import { MATERIAL_COLORS } from "@/core/scene/defaults"
import type { MaterialId } from "@/core/scene/types"

/** Linear RGB triple. */
export type RGB = [number, number, number]

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** "#rrggbb" (or "#rgb") → linear RGB. Malformed input yields mid grey rather than throwing. */
export function hexToLinear(hex: string): RGB {
  let h = hex.startsWith("#") ? hex.slice(1) : hex
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const v = h.length === 6 ? Number.parseInt(h, 16) : Number.NaN
  if (!Number.isFinite(v)) return [0.21, 0.21, 0.21]
  return [srgbToLinear(((v >> 16) & 255) / 255), srgbToLinear(((v >> 8) & 255) / 255), srgbToLinear((v & 255) / 255)]
}

const materialCache = new Map<MaterialId, RGB>()

export function materialColor(id: MaterialId): RGB {
  let c = materialCache.get(id)
  if (!c) {
    c = hexToLinear(MATERIAL_COLORS[id] ?? "#808080")
    materialCache.set(id, c)
  }
  return c
}

/** FNV-1a 32-bit hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let k = 0; k < s.length; k++) {
    h ^= s.charCodeAt(k)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Integer mix hash (for lattice/cell coordinates without building strings). */
export function hashInts(a: number, b: number, c = 0): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1)
  h ^= h >>> 15
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** Hash → [0, 1). */
export function unitFromHash(h: number): number {
  return (h >>> 8) / 16777216
}

/** Multiply a colour by 1 ± amount, deterministically from `h`. */
export function tintByHash(c: RGB, h: number, amount = 0.05): RGB {
  const f = 1 + (unitFromHash(h) * 2 - 1) * amount
  return [c[0] * f, c[1] * f, c[2] * f]
}

export function tint(c: RGB, key: string, amount = 0.05): RGB {
  return tintByHash(c, hashString(key), amount)
}

export function scaleRgb(c: RGB, f: number): RGB {
  return [c[0] * f, c[1] * f, c[2] * f]
}

export function mixRgb(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

export const WHITE: RGB = [1, 1, 1]
