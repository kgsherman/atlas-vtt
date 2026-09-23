/**
 * Deterministic smooth flicker (ARCHITECTURE §4.1: flicker modulates INTENSITY only; radii are static,
 * so flickering lights never re-render their shadow tiles). Every client computes the same value for a
 * light id and time, so DM and players see matching fires.
 */
import type { FlickerSettings } from "@/core/scene/types"

/** FNV-1a hash of a light id → 32-bit seed. */
export function flickerSeed(id: string): number {
  let h = 0x811c9dc5
  for (let k = 0; k < id.length; k++) {
    h ^= id.charCodeAt(k)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Lattice hash → [0, 1). */
function lattice(i: number, seed: number): number {
  let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(seed | 0, 0x165667b1)
  h ^= h >>> 15
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 8) / 16777216
}

/** 1D value noise in [0, 1) with C1-continuous smoothstep interpolation between lattice points. */
export function valueNoise(x: number, seed: number): number {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f)
  const a = lattice(i, seed)
  return a + (lattice(i + 1, seed) - a) * u
}

/**
 * Intensity multiplier in [1 − amount, 1]. Two octaves: the base rate `speed` (≈ oscillations per
 * second) plus a faster, weaker one for crackle.
 */
export function flickerFactor(seed: number, timeSec: number, flicker: FlickerSettings): number {
  if (!flicker.enabled) return 1
  const amount = Math.min(1, Math.max(0, flicker.amount))
  if (amount === 0) return 1
  const speed = Math.max(0, flicker.speed)
  const n = 0.65 * valueNoise(timeSec * speed, seed) + 0.35 * valueNoise(timeSec * speed * 2.3 + 17.1, seed ^ 0x9e3779b9)
  return 1 - amount * n
}
