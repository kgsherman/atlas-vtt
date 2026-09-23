import { describe, expect, it } from "vitest"

import { createScene } from "@/core/scene/factory"

import { circlePoints, dashPolyline, pathStepPoints, ribbonPositions } from "./ribbon"

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
