/**
 * Pure overlay geometry: flat ribbons along polylines (WebGL lines are 1 px wide, ribbons keep the
 * ruler and paths readable at any zoom), dashed polylines, circles and move-path points.
 */
import { SIZE_FOOTPRINT } from "@/core/scene/defaults"
import { groundHeightAt } from "@/core/scene/queries"
import type { PathStep } from "@/core/movement/types"
import type { SceneLike, Token, Vec3 } from "@/core/scene/types"

/**
 * Triangles (non-indexed positions, 3 floats per vertex) of a flat ribbon of `width` along the
 * polyline, lifted by `lift`. Each segment is a quad in the XZ plane following the points' Y; interior
 * joints get a small square cap so turns have no gaps.
 */
export function ribbonPositions(points: readonly Vec3[], width: number, lift = 0): Float32Array {
  const out: number[] = []
  const h = width / 2
  const quad = (a: Vec3, b: Vec3) => {
    const dx = b.x - a.x
    const dz = b.z - a.z
    const l = Math.hypot(dx, dz)
    if (l < 1e-9) return
    const nx = (-dz / l) * h
    const nz = (dx / l) * h
    const ya = a.y + lift
    const yb = b.y + lift
    // Two triangles, counter-clockwise seen from above (+Y).
    out.push(a.x - nx, ya, a.z - nz, b.x + nx, yb, b.z + nz, b.x - nx, yb, b.z - nz)
    out.push(a.x - nx, ya, a.z - nz, a.x + nx, ya, a.z + nz, b.x + nx, yb, b.z + nz)
  }
  for (let k = 0; k + 1 < points.length; k++) quad(points[k], points[k + 1])
  for (let k = 1; k + 1 < points.length; k++) {
    const p = points[k]
    const y = p.y + lift
    out.push(p.x - h, y, p.z - h, p.x + h, y, p.z + h, p.x + h, y, p.z - h)
    out.push(p.x - h, y, p.z - h, p.x - h, y, p.z + h, p.x + h, y, p.z + h)
  }
  return new Float32Array(out)
}

/** Split a polyline into dashes of length `dash` separated by `gap` (measured along the path in 3D). */
export function dashPolyline(points: readonly Vec3[], dash: number, gap: number): Vec3[][] {
  const out: Vec3[][] = []
  if (points.length < 2 || !(dash > 0)) return out
  const period = dash + Math.max(0, gap)
  let phase = 0 // distance into the current period
  let current: Vec3[] | null = [{ ...points[0] }]
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k]
    const b = points[k + 1]
    const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
    let t = 0
    while (t < len - 1e-9) {
      const boundary = phase < dash ? dash : period
      const step = Math.min(boundary - phase, len - t)
      t += step
      phase += step
      const f = t / len
      const p = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f }
      if (current) current.push(p)
      if (phase >= dash - 1e-9 && current) {
        if (current.length >= 2) out.push(current)
        current = null
      }
      if (phase >= period - 1e-9) {
        phase = 0
        current = [p]
      }
    }
  }
  if (current && current.length >= 2) out.push(current)
  return out
}

/** Points of a circle on the ground, Y from `y(x, z)`. */
export function circlePoints(cx: number, cz: number, radius: number, segments: number, y: (x: number, z: number) => number): Vec3[] {
  const out: Vec3[] = []
  for (let k = 0; k <= segments; k++) {
    const a = (2 * Math.PI * k) / segments
    const x = cx + Math.cos(a) * radius
    const z = cz + Math.sin(a) * radius
    out.push({ x, y: y(x, z), z })
  }
  return out
}

/**
 * World points (token centres on the ground) of a move path. A step's cell is the token's anchor
 * (min-corner cell of its footprint); the centre is anchor·cellSize + side/2 with side = max(1,
 * footprint)·cellSize (core/movement PathStep).
 */
export function pathStepPoints(scene: Pick<SceneLike, "grid" | "levels" | "objects">, steps: readonly PathStep[], size: Token["size"] = "medium"): Vec3[] {
  const cs = scene.grid.cellSize
  const side = Math.max(1, SIZE_FOOTPRINT[size] ?? 1) * cs
  return steps.map((s) => {
    const x = s.cell.i * cs + side / 2
    const z = s.cell.j * cs + side / 2
    const y = Object.hasOwn(scene.levels, s.levelId) ? groundHeightAt(scene, s.levelId, { x, z }) : 0
    return { x, y, z }
  })
}
