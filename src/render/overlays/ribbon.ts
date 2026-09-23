/**
 * Pure overlay geometry: flat ribbons along polylines (WebGL lines are 1 px wide, ribbons keep the
 * ruler and paths readable at any zoom), dashed polylines, circles and move-path points.
 */
import { SIZE_FOOTPRINT } from "@/core/scene/defaults"
import { groundIndex } from "@/core/scene/queries"
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
 * footprint)·cellSize (core/movement PathStep). Ground heights come from the scene's memoised
 * GroundIndex (one object scan per scene instead of one per step): scenes given here must never be
 * mutated in place (engine scenes are not).
 */
export function pathStepPoints(scene: Pick<SceneLike, "grid" | "levels" | "objects">, steps: readonly PathStep[], size: Token["size"] = "medium"): Vec3[] {
  const cs = scene.grid.cellSize
  const side = Math.max(1, SIZE_FOOTPRINT[size] ?? 1) * cs
  const g = groundIndex(scene)
  return steps.map((s) => {
    const x = s.cell.i * cs + side / 2
    const z = s.cell.j * cs + side / 2
    const y = Object.hasOwn(scene.levels, s.levelId) ? g.groundHeightAt(s.levelId, { x, z }) : 0
    return { x, y, z }
  })
}

/**
 * Flat overlay geometry with per-vertex edge coordinates for analytic anti-aliasing
 * (materials/edgeAAMaterial.ts). The canvas has no MSAA, so overlay meshes fade their own edges: a
 * coordinate reaches |v| = 1 exactly on an edge that fades, and the shader turns |v| into pixel
 * coverage with fwidth. Callers widen shapes by half a pixel per side so the fade is centred on the
 * nominal edge.
 */
export interface EdgeGeometryData {
  /** 3 floats per vertex (non-indexed triangles). */
  positions: Float32Array
  /** 2 floats per vertex: across, along. */
  edges: Float32Array
}

class EdgeWriter {
  readonly pos: number[] = []
  readonly edge: number[] = []
  v(x: number, y: number, z: number, across: number, along: number): void {
    this.pos.push(x, y, z)
    this.edge.push(across, along)
  }
  build(): EdgeGeometryData {
    return { positions: new Float32Array(this.pos), edges: new Float32Array(this.edge) }
  }
}

/** Triangle fan of a disc (centre edge coordinate 0, rim 1), counter-clockwise seen from above. */
function writeDisc(w: EdgeWriter, cx: number, y: number, cz: number, radius: number, segments: number, along: number): void {
  for (let k = 0; k < segments; k++) {
    const a0 = (2 * Math.PI * k) / segments
    const a1 = (2 * Math.PI * (k + 1)) / segments
    w.v(cx, y, cz, 0, along)
    w.v(cx + Math.cos(a1) * radius, y, cz + Math.sin(a1) * radius, 1, along)
    w.v(cx + Math.cos(a0) * radius, y, cz + Math.sin(a0) * radius, 1, along)
  }
}

/**
 * Ribbon along a polyline (as ribbonPositions) with edge coordinates: across = ±1 on the two sides,
 * along = −1 / +1 at the polyline's ends (0 throughout when it is closed), and round joints (discs of
 * the ribbon's half-width) at interior points so turns have no gaps and no aliased corners.
 */
export function ribbonEdgeGeometry(points: readonly Vec3[], width: number, lift = 0, jointSegments = 10): EdgeGeometryData {
  const w = new EdgeWriter()
  const h = width / 2
  const n = points.length
  if (n < 2 || !(h > 0)) return w.build()
  const first = points[0]
  const last = points[n - 1]
  const closed = n > 2 && Math.hypot(last.x - first.x, last.y - first.y, last.z - first.z) < 1e-6
  // Arc length at each point → along coordinate in [−1, 1].
  const s: number[] = [0]
  for (let k = 1; k < n; k++) s.push(s[k - 1] + Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y, points[k].z - points[k - 1].z))
  const total = s[n - 1]
  const along = (k: number) => (closed || !(total > 0) ? 0 : (2 * s[k]) / total - 1)
  for (let k = 0; k + 1 < n; k++) {
    const a = points[k]
    const b = points[k + 1]
    const dx = b.x - a.x
    const dz = b.z - a.z
    const l = Math.hypot(dx, dz)
    if (l < 1e-9) continue
    const nx = (-dz / l) * h
    const nz = (dx / l) * h
    const ya = a.y + lift
    const yb = b.y + lift
    const sa = along(k)
    const sb = along(k + 1)
    w.v(a.x - nx, ya, a.z - nz, -1, sa)
    w.v(b.x + nx, yb, b.z + nz, 1, sb)
    w.v(b.x - nx, yb, b.z - nz, -1, sb)
    w.v(a.x - nx, ya, a.z - nz, -1, sa)
    w.v(a.x + nx, ya, a.z + nz, 1, sa)
    w.v(b.x + nx, yb, b.z + nz, 1, sb)
  }
  for (let k = closed ? 0 : 1; k + 1 < n; k++) writeDisc(w, points[k].x, points[k].y + lift, points[k].z, h, jointSegments, along(k))
  return w.build()
}

/** Flat disc on the ground plane at height y (edge coordinate 0 at the centre, 1 on the rim). */
export function discEdgeGeometry(cx: number, y: number, cz: number, radius: number, segments = 24): EdgeGeometryData {
  const w = new EdgeWriter()
  if (radius > 0) writeDisc(w, cx, y, cz, radius, Math.max(3, segments), 0)
  return w.build()
}

/** Flat annulus at height y (across = −1 on the inner rim, +1 on the outer rim). */
export function ringEdgeGeometry(cx: number, y: number, cz: number, inner: number, outer: number, segments = 48): EdgeGeometryData {
  const w = new EdgeWriter()
  if (!(outer > inner && inner >= 0)) return w.build()
  const n = Math.max(3, segments)
  for (let k = 0; k < n; k++) {
    const a0 = (2 * Math.PI * k) / n
    const a1 = (2 * Math.PI * (k + 1)) / n
    const i0 = [cx + Math.cos(a0) * inner, cz + Math.sin(a0) * inner]
    const i1 = [cx + Math.cos(a1) * inner, cz + Math.sin(a1) * inner]
    const o0 = [cx + Math.cos(a0) * outer, cz + Math.sin(a0) * outer]
    const o1 = [cx + Math.cos(a1) * outer, cz + Math.sin(a1) * outer]
    w.v(i0[0], y, i0[1], -1, 0)
    w.v(o1[0], y, o1[1], 1, 0)
    w.v(o0[0], y, o0[1], 1, 0)
    w.v(i0[0], y, i0[1], -1, 0)
    w.v(i1[0], y, i1[1], -1, 0)
    w.v(o1[0], y, o1[1], 1, 0)
  }
  return w.build()
}

/** Concatenate edge geometries (one draw call). */
export function mergeEdgeGeometry(parts: readonly EdgeGeometryData[]): EdgeGeometryData {
  let np = 0
  let ne = 0
  for (const p of parts) {
    np += p.positions.length
    ne += p.edges.length
  }
  const positions = new Float32Array(np)
  const edges = new Float32Array(ne)
  np = 0
  ne = 0
  for (const p of parts) {
    positions.set(p.positions, np)
    edges.set(p.edges, ne)
    np += p.positions.length
    ne += p.edges.length
  }
  return { positions, edges }
}
