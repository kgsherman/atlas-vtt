/**
 * Shading terms shared by the CPU (tests, culling heuristics) and the GLSL in
 * render/materials/glsl/common.ts. Keep both sides identical.
 */
import type { AmbientLevel, DirectionalLightSettings } from "@/core/scene/types"

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

/** GLSL smoothstep with a guarded (non-empty) edge interval. */
export function smoothstepSafe(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / Math.max(e1 - e0, 1e-4))
  return t * t * (3 - 2 * t)
}

/**
 * Point-light falloff by 3D distance with the D&D radii: 1 at the source easing to 0.5 at the bright
 * radius, then 0.5 → 0 across the dim band, exactly 0 at (and beyond) the dim radius.
 */
export function lightFalloff(d: number, bright: number, dim: number): number {
  if (d >= dim) return 0
  if (d <= bright && bright > 0) {
    const r = d / bright
    return 1 - 0.5 * r * r
  }
  return 0.5 * (1 - smoothstepSafe(bright, dim, d))
}

/**
 * Softened Lambert: faces turned away get nothing (N·L ≤ 0 is gated before any shadow sample), grazing
 * faces fade in over N·L ∈ [0, 0.2], and the top-down floors (N·L ≈ 0.25 for a torch 20 ft away) stay
 * readable instead of falling to cos θ.
 */
export function softLambert(ndl: number): number {
  if (ndl <= 0) return 0
  return smoothstepSafe(0, 0.2, ndl) * (0.6 + 0.4 * Math.min(ndl, 1))
}

/** Visual fill added for a rules light level (ambient under cover / sky). */
export function levelFill(level: AmbientLevel): number {
  switch (level) {
    case "bright":
      return 0.55
    case "dim":
      return 0.18
    case "dark":
      return 0
  }
}

/** Unit vector pointing TOWARD the sun/moon (azimuth: 0 = +Z, π/2 = +X; elevation clamped to [0.1, π/2]). */
export function directionToSun(d: Pick<DirectionalLightSettings, "azimuth" | "elevation">): [number, number, number] {
  const el = Math.min(Math.PI / 2, Math.max(0.1, d.elevation))
  const c = Math.cos(el)
  return [Math.sin(d.azimuth) * c, Math.sin(el), Math.cos(d.azimuth) * c]
}

/** Rec. 709 luma (linear), as `atLuma` in the shaders. */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Largest gain darkvision applies to a lit colour before adding grey (AT_DV_MAX_GAIN). */
export const DARKVISION_MAX_GAIN = 3

/**
 * Darkvision's raise of a lit colour `c` toward the luma `target` of the same surface's darkvision grey
 * (atGradeColour, glsl/common.ts), weighted by `dv` (1 in range, fading out over the range's last feet):
 * the colour is scaled (hue kept) by at most DARKVISION_MAX_GAIN and only the rest is added as grey, so
 * at dv = 1 it is never darker than the grey.
 */
export function darkvisionRaise(c: [number, number, number], target: number, dv: number): [number, number, number] {
  const l = luma(c[0], c[1], c[2])
  if (!(dv > 0) || l >= target) return c
  const gain = Math.min(target / Math.max(l, 1e-4), DARKVISION_MAX_GAIN)
  const raised = c.map((v) => v * gain) as [number, number, number]
  const grey = Math.max(target - luma(raised[0], raised[1], raised[2]), 0)
  return c.map((v, k) => v + (raised[k] + grey - v) * dv) as [number, number, number]
}
