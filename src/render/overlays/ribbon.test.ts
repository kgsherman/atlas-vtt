import { describe, expect, it } from "vitest"

import { createScene } from "@/core/scene/factory"

import { createEdgeAAMaterial, edgeGeometry } from "../materials/edgeAAMaterial"
import { circlePoints, dashPolyline, discEdgeGeometry, mergeEdgeGeometry, pathStepPoints, ribbonEdgeGeometry, ribbonPositions, ringEdgeGeometry, type EdgeGeometryData } from "./ribbon"

describe("overlay geometry", () => {
  it("builds upward-facing ribbons of the requested width", () => {
    const p = ribbonPositions(
      [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 0 },
        { x: 10, y: 0, z: 10 },
      ],
      1,
      0.5
    )
    // 2 segments × 2 triangles + 1 joint cap × 2 triangles.
    expect(p.length).toBe(6 * 9)
    for (let t = 0; t < p.length / 9; t++) {
      const k = t * 9
      const ux = p[k + 3] - p[k]
      const uz = p[k + 5] - p[k + 2]
      const vx = p[k + 6] - p[k]
      const vz = p[k + 8] - p[k + 2]
      expect(uz * vx - ux * vz).toBeGreaterThan(0)
      expect(p[k + 1]).toBe(0.5)
    }
    let minZ = Infinity
    let maxZ = -Infinity
    for (let t = 0; t < 2 * 9; t += 3) {
      minZ = Math.min(minZ, p[t + 2])
      maxZ = Math.max(maxZ, p[t + 2])
    }
    expect(maxZ - minZ).toBeCloseTo(1)
  })

  it("dashes a polyline across corners", () => {
    const dashes = dashPolyline(
      [
        { x: 0, y: 0, z: 0 },
        { x: 3, y: 0, z: 0 },
        { x: 3, y: 0, z: 3 },
      ],
      1.5,
      0.5
    )
    const len = (d: { x: number; y: number; z: number }[]) => d.slice(1).reduce((s, p, k) => s + Math.hypot(p.x - d[k].x, p.z - d[k].z), 0)
    // Dashes over [0, 1.5], [2, 3.5], [4, 5.5] of the 6 ft path.
    expect(dashes).toHaveLength(3)
    for (const d of dashes) expect(len(d)).toBeCloseTo(1.5)
    // The second dash bends around the corner at x = 3.
    expect(dashes[1]).toHaveLength(3)
    expect(dashes[1][1]).toEqual({ x: 3, y: 0, z: 0 })
    expect(dashPolyline([{ x: 0, y: 0, z: 0 }], 1, 1)).toEqual([])
  })

  it("maps path anchors to footprint centres on the ground", () => {
    const scene = createScene({ width: 10, depth: 10 })
    const lv = Object.keys(scene.levels)[0]
    const steps = [
      { cell: { i: 0, j: 0 }, levelId: lv },
      { cell: { i: 1, j: 1 }, levelId: lv },
    ]
    expect(pathStepPoints(scene, steps)).toEqual([
      { x: 2.5, y: 0, z: 2.5 },
      { x: 7.5, y: 0, z: 7.5 },
    ])
    expect(pathStepPoints(scene, steps, "large")[0]).toEqual({ x: 5, y: 0, z: 5 })
  })

  it("draws closed circles", () => {
    const pts = circlePoints(5, 5, 2, 8, () => 1)
    expect(pts).toHaveLength(9)
    expect(pts[0].x).toBeCloseTo(pts[8].x)
    for (const p of pts) expect(Math.hypot(p.x - 5, p.z - 5)).toBeCloseTo(2)
  })
})

/** Every triangle counter-clockwise seen from above (the ribbonPositions convention). */
function expectUpward(g: EdgeGeometryData): void {
  const p = g.positions
  for (let k = 0; k < p.length; k += 9) {
    const ux = p[k + 3] - p[k]
    const uz = p[k + 5] - p[k + 2]
    const vx = p[k + 6] - p[k]
    const vz = p[k + 8] - p[k + 2]
    expect(uz * vx - ux * vz).toBeGreaterThan(0)
  }
}

describe("anti-aliased overlay geometry", () => {
  const path = [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 10, y: 0, z: 10 },
  ]

  it("marks ribbon sides with across = ±1 and the polyline ends with along = ∓1", () => {
    const g = ribbonEdgeGeometry(path, 1, 0.5)
    expect(g.edges.length / 2).toBe(g.positions.length / 3)
    expectUpward(g)
    // Segment quads: vertices on the sides lie half a width from the centreline.
    for (let v = 0; v < 12; v++) {
      const across = g.edges[v * 2]
      expect(Math.abs(across)).toBe(1)
      expect(g.positions[v * 3 + 1]).toBe(0.5)
    }
    const along = Array.from({ length: g.edges.length / 2 }, (_, v) => g.edges[v * 2 + 1])
    expect(Math.min(...along)).toBe(-1)
    expect(Math.max(...along)).toBe(1)
    // The corner joint (a disc at the middle point, arc length 10 of 20) is not faded along.
    const joint = along.slice(12)
    expect(joint.length).toBeGreaterThan(0)
    for (const a of joint) expect(a).toBeCloseTo(0)
  })

  it("does not fade the seam of closed polylines", () => {
    const g = ribbonEdgeGeometry(circlePoints(0, 0, 5, 24, () => 0), 0.5)
    for (let v = 0; v < g.edges.length / 2; v++) expect(g.edges[v * 2 + 1]).toBe(0)
  })

  it("builds discs and rings with rim coordinates", () => {
    const d = discEdgeGeometry(5, 1, 5, 2, 12)
    expectUpward(d)
    for (let v = 0; v < d.positions.length / 3; v++) {
      const r = Math.hypot(d.positions[v * 3] - 5, d.positions[v * 3 + 2] - 5)
      expect(d.edges[v * 2]).toBeCloseTo(r / 2)
    }
    const r = ringEdgeGeometry(0, 0, 0, 1, 2, 16)
    expectUpward(r)
    for (let v = 0; v < r.positions.length / 3; v++) {
      const rad = Math.hypot(r.positions[v * 3], r.positions[v * 3 + 2])
      expect(r.edges[v * 2]).toBe(rad < 1.5 ? -1 : 1)
    }
    const m = mergeEdgeGeometry([d, r])
    expect(m.positions.length).toBe(d.positions.length + r.positions.length)
    expect(m.edges.length).toBe(d.edges.length + r.edges.length)
  })

  it("feeds the edge coordinates to an fwidth coverage shader", () => {
    const g = edgeGeometry(ribbonEdgeGeometry(path, 1))
    expect(g.getAttribute("aEdge").itemSize).toBe(2)
    const m = createEdgeAAMaterial("#fbbf24", { opacity: 0.9 })
    expect(m.vertexShader).toMatch(/attribute vec2 aEdge/)
    expect(m.fragmentShader).toMatch(/fwidth/)
    expect(m.transparent).toBe(true)
    expect(m.depthTest).toBe(false)
    expect(m.uniforms.uOpacity.value).toBe(0.9)
  })
})
