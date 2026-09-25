/**
 * Area shapes as 3D volumes (docs/ARCHITECTURE.md §6.6): containment, bounds and the top-down outline.
 * The volume is anchored at the NOMINAL point of origin (ground + elevation); line of effect (effect.ts)
 * starts from that point pushed out of any blocker it lies in.
 *
 * Ground-hugging shapes (cylinder, cube) reach down to the ground wherever it is below their base (a
 * column of fire on a slope burns the downhill side too); floors between the origin and a lower storey
 * still stop them, because every covered point also needs a line of effect.
 */
import type { Vec2, Vec3 } from "../scene/types"
import { AREA_LIMITS, AREA_SHAPES, DEFAULT_CYLINDER_HEIGHT, DEFAULT_LINE_WIDTH, type AreaGeometry, type AreaShape } from "./types"

/** Containment tolerance (feet): points this close outside the boundary still count. */
export const AREA_EPS = 0.01

export interface AreaBounds {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

/** A placed volume: its origin (world), direction and containment test. */
export interface AreaVolume {
  readonly geometry: AreaGeometry
  /** Nominal point of origin (world). */
  readonly origin: Vec3
  /** Unit aim direction in XZ. */
  readonly dir: Vec2
  readonly bounds: AreaBounds
  contains(p: Vec3): boolean
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const finiteOr = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d)

/** Normalise an angle to (−π, π]. */
export function normalizeAngle(a: number): number {
  if (!Number.isFinite(a)) return 0
  let r = a % (2 * Math.PI)
  if (r <= -Math.PI) r += 2 * Math.PI
  else if (r > Math.PI) r -= 2 * Math.PI
  return r
}

/** Round to 1/1000 ft (keeps stored templates and wire values short and diff-stable). */
const q = (v: number) => Math.round(v * 1000) / 1000

/**
 * A geometry with every field in range: sizes clamped to AREA_LIMITS, the angle normalised, round
 * shapes' angle zeroed, and the fields a shape does not use reset to their defaults.
 */
export function normalizeArea(g: AreaGeometry): AreaGeometry {
  const shape: AreaShape = (AREA_SHAPES as readonly string[]).includes(g.shape) ? g.shape : "sphere"
  return {
    shape,
    levelId: g.levelId,
    x: q(finiteOr(g.x, 0)),
    z: q(finiteOr(g.z, 0)),
    elevation: q(clamp(finiteOr(g.elevation, 0), 0, AREA_LIMITS.maxElevation)),
    angle: shape === "sphere" || shape === "cylinder" ? 0 : q(normalizeAngle(finiteOr(g.angle, 0))),
    size: q(clamp(finiteOr(g.size, 20), AREA_LIMITS.minSize, AREA_LIMITS.maxSize)),
    width: shape === "line" ? q(clamp(finiteOr(g.width, DEFAULT_LINE_WIDTH), AREA_LIMITS.minWidth, AREA_LIMITS.maxWidth)) : DEFAULT_LINE_WIDTH,
    height:
      shape === "cylinder" ? q(clamp(finiteOr(g.height, DEFAULT_CYLINDER_HEIGHT), AREA_LIMITS.minHeight, AREA_LIMITS.maxHeight)) : DEFAULT_CYLINDER_HEIGHT,
  }
}

/**
 * The volume of `g` whose point of origin stands on ground `groundY` (world Y of the level's ground under
 * (x, z)). Pass a normalised geometry.
 */
export function areaVolume(g: AreaGeometry, groundY: number): AreaVolume {
  const origin: Vec3 = { x: g.x, y: groundY + g.elevation, z: g.z }
  const dir: Vec2 = { x: Math.cos(g.angle), z: Math.sin(g.angle) }
  const e = AREA_EPS
  const s = g.size
  const ox = origin.x
  const oy = origin.y
  const oz = origin.z
  const dx = dir.x
  const dz = dir.z
  // Local frame for aimed shapes: `along` the aim, `across` (left normal) and `up`.
  const along = (p: Vec3) => (p.x - ox) * dx + (p.z - oz) * dz
  const across = (p: Vec3) => -(p.x - ox) * dz + (p.z - oz) * dx
  switch (g.shape) {
    case "sphere": {
      const r2 = (s + e) * (s + e)
      return {
        geometry: g,
        origin,
        dir,
        bounds: { minX: ox - s, maxX: ox + s, minY: oy - s, maxY: oy + s, minZ: oz - s, maxZ: oz + s },
        contains: (p) => (p.x - ox) ** 2 + (p.y - oy) ** 2 + (p.z - oz) ** 2 <= r2,
      }
    }
    case "cylinder": {
      const r2 = (s + e) * (s + e)
      const top = oy + g.height
      return {
        geometry: g,
        origin,
        dir,
        bounds: { minX: ox - s, maxX: ox + s, minY: -Infinity, maxY: top, minZ: oz - s, maxZ: oz + s },
        contains: (p) => p.y <= top + e && (p.x - ox) ** 2 + (p.z - oz) ** 2 <= r2,
      }
    }
    case "cone": {
      const outline = coneOutline(origin, dir, s)
      return {
        geometry: g,
        origin,
        dir,
        bounds: boundsOf(outline, oy - s / 2, oy + s / 2),
        contains: (p) => {
          const a = along(p)
          if (a < -e || a > s + e) return false
          // Radial distance from the axis ≤ along / 2 (5e: width at any distance equals that distance).
          const r2 = (p.x - ox) ** 2 + (p.y - oy) ** 2 + (p.z - oz) ** 2 - a * a
          const half = Math.max(0, a) / 2 + e
          return r2 <= half * half
        },
      }
    }
    case "line": {
      const w = g.width / 2
      const outline = boxOutline(origin, dir, s, w)
      return {
        geometry: g,
        origin,
        dir,
        bounds: boundsOf(outline, oy - w, oy + w),
        contains: (p) => {
          const a = along(p)
          return a >= -e && a <= s + e && Math.abs(across(p)) <= w + e && Math.abs(p.y - oy) <= w + e
        },
      }
    }
    case "cube": {
      const outline = boxOutline(origin, dir, s, s / 2)
      const top = oy + s
      return {
        geometry: g,
        origin,
        dir,
        bounds: boundsOf(outline, -Infinity, top),
        contains: (p) => {
          const a = along(p)
          return a >= -e && a <= s + e && Math.abs(across(p)) <= s / 2 + e && p.y <= top + e
        },
      }
    }
  }
}

function boundsOf(pts: readonly Vec2[], minY: number, maxY: number): AreaBounds {
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minZ = Math.min(minZ, p.z)
    maxZ = Math.max(maxZ, p.z)
  }
  return { minX, maxX, minY, maxY, minZ, maxZ }
}

function coneOutline(o: Vec2, d: Vec2, length: number): Vec2[] {
  const n = { x: -d.z, z: d.x }
  const fx = o.x + d.x * length
  const fz = o.z + d.z * length
  const h = length / 2
  return [
    { x: o.x, z: o.z },
    { x: fx + n.x * h, z: fz + n.z * h },
    { x: fx - n.x * h, z: fz - n.z * h },
  ]
}

/** Rectangle from the origin along `d`, `length` long, `half` to each side. */
function boxOutline(o: Vec2, d: Vec2, length: number, half: number): Vec2[] {
  const n = { x: -d.z, z: d.x }
  const fx = o.x + d.x * length
  const fz = o.z + d.z * length
  return [
    { x: o.x - n.x * half, z: o.z - n.z * half },
    { x: o.x + n.x * half, z: o.z + n.z * half },
    { x: fx + n.x * half, z: fz + n.z * half },
    { x: fx - n.x * half, z: fz - n.z * half },
  ]
}

/**
 * The area's top-down outline (a closed XZ polygon, counter-clockwise or clockwise): circles for spheres
 * and cylinders (`segments` points), the triangle of a cone (seen from above, its round end is a
 * straight edge), the rectangle of a line and the square of a cube.
 */
export function areaOutline(g: AreaGeometry, segments = 64): Vec2[] {
  const o = { x: g.x, z: g.z }
  const d = { x: Math.cos(g.angle), z: Math.sin(g.angle) }
  switch (g.shape) {
    case "sphere":
    case "cylinder": {
      const out: Vec2[] = []
      for (let k = 0; k < segments; k++) {
        const t = (k / segments) * Math.PI * 2
        out.push({ x: g.x + Math.cos(t) * g.size, z: g.z + Math.sin(t) * g.size })
      }
      return out
    }
    case "cone":
      return coneOutline(o, d, g.size)
    case "line":
      return boxOutline(o, d, g.size, g.width / 2)
    case "cube":
      return boxOutline(o, d, g.size, g.size / 2)
  }
}

/** Short description, e.g. "20 ft sphere", "60 × 5 ft line", "10 ft cylinder, 40 ft high". */
export function describeArea(g: Pick<AreaGeometry, "shape" | "size" | "width" | "height">): string {
  const f = (v: number) => `${Math.round(v * 10) / 10}`
  switch (g.shape) {
    case "sphere":
      return `${f(g.size)} ft sphere`
    case "cylinder":
      return `${f(g.size)} ft cylinder, ${f(g.height)} ft high`
    case "cone":
      return `${f(g.size)} ft cone`
    case "line":
      return `${f(g.size)} × ${f(g.width)} ft line`
    case "cube":
      return `${f(g.size)} ft cube`
  }
}
