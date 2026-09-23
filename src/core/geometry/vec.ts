/**
 * Small vector helpers on the scene's Vec2 (x, z ground plane) and Vec3 types.
 * All functions are pure and allocate a new result; hot loops in core/occlusion use the
 * scalar-argument variants in ./ray instead.
 */
import type { Vec2, Vec3 } from "../scene/types"

/** Default geometric tolerance in feet (world coordinates stay within ~1000 ft). */
export const EPS = 1e-6

export const vec2 = (x: number, z: number): Vec2 => ({ x, z })
export const vec3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z })

export const add2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, z: a.z + b.z })
export const sub2 = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, z: a.z - b.z })
export const scale2 = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, z: a.z * s })
export const dot2 = (a: Vec2, b: Vec2): number => a.x * b.x + a.z * b.z
/** 2D cross product on the ground plane, a.x·b.z − a.z·b.x (> 0 when b is counter-clockwise from a in (x, z)). */
export const cross2 = (a: Vec2, b: Vec2): number => a.x * b.z - a.z * b.x
export const length2 = (a: Vec2): number => Math.hypot(a.x, a.z)
export const distance2 = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z)
export const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t })
/** a rotated +90° about Y in the scene's convention (the "left" normal of a direction, see wallNormal). */
export const perp2 = (a: Vec2): Vec2 => ({ x: -a.z, z: a.x })

export function normalize2(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.z)
  return l > 0 ? { x: a.x / l, z: a.z / l } : { x: 0, z: 0 }
}

export const add3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z })
export const sub3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
export const scale3 = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s })
export const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z
export const length3 = (a: Vec3): number => Math.hypot(a.x, a.y, a.z)
export const distance3 = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
export const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  z: a.z + (b.z - a.z) * t,
})

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}

export function normalize3(a: Vec3): Vec3 {
  const l = Math.hypot(a.x, a.y, a.z)
  return l > 0 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 0, z: 0 }
}

/** Point at parameter t on the segment from→to. */
export const pointAt3 = (from: Vec3, to: Vec3, t: number): Vec3 => lerp3(from, to, t)

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)
