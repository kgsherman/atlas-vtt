import { describe, expect, it } from "vitest"

import {
  circleOverlapsAABB2,
  orientedRectBounds,
  orientedRectCorners,
  orientedRectOverlapsAABB2,
  orientedRectOverlapsCircle,
  rotateLocalXZ,
  unrotateXZ,
  yawFromDirection,
} from "./box"
import {
  clipPolygonToRect,
  convexHull,
  convexPolygonsOverlap,
  pointInConvexPolygon,
  pointInPolygon,
  polygonArea,
  rectPolygon,
} from "./polygon"
import {
  classifyEntry,
  createInterval,
  ENTRY_CONTAINS_START,
  ENTRY_MISS,
  lineAABB3,
  lineConvex,
  lineOrientedBox,
  lineVerticalCylinder,
} from "./ray"
import { clipSegmentToBox2, closestParamOnSegment2, distancePointSegment2, segmentIntersection2 } from "./segment"
import { cross2, distance3, normalize2, perp2 } from "./vec"

describe("vec", () => {
  it("perp2 is the +90° (left) normal used by walls", () => {
    expect(perp2({ x: 1, z: 0 })).toEqual({ x: -0, z: 1 })
    expect(cross2({ x: 1, z: 0 }, { x: 0, z: 1 })).toBe(1)
    expect(normalize2({ x: 3, z: 4 })).toEqual({ x: 0.6, z: 0.8 })
    expect(distance3({ x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 2 })).toBe(3)
  })
})

describe("yaw frames", () => {
  it("follows three.js rotation.y: local +X maps to (cos, −sin)", () => {
    const yaw = 0.7
    const p = rotateLocalXZ(1, 0, yaw)
    expect(p.x).toBeCloseTo(Math.cos(yaw))
    expect(p.z).toBeCloseTo(-Math.sin(yaw))
    const back = unrotateXZ(p.x, p.z, yaw)
    expect(back.x).toBeCloseTo(1)
    expect(back.z).toBeCloseTo(0)
  })

  it("yawFromDirection aligns local +X with a direction", () => {
    for (const [dx, dz] of [
      [1, 0],
      [0, 1],
      [-1, 0],
      [0.6, -0.8],
    ]) {
      const p = rotateLocalXZ(1, 0, yawFromDirection(dx, dz))
      expect(p.x).toBeCloseTo(dx)
      expect(p.z).toBeCloseTo(dz)
    }
  })

  it("oriented rect corners and bounds agree", () => {
    const corners = orientedRectCorners({ x: 5, z: 5 }, 2, 1, Math.PI / 4)
    const b = orientedRectBounds({ x: 5, z: 5 }, 2, 1, Math.PI / 4)
    for (const c of corners) {
      expect(c.x).toBeGreaterThanOrEqual(b.minX - 1e-9)
      expect(c.x).toBeLessThanOrEqual(b.maxX + 1e-9)
    }
    expect(Math.max(...corners.map((c) => c.x))).toBeCloseTo(b.maxX)
  })

  it("SAT overlap of an oriented rect with boxes and circles is strict", () => {
    const box = { minX: 0, minZ: 0, maxX: 1, maxZ: 1 }
    expect(orientedRectOverlapsAABB2({ x: 2, z: 0.5 }, 1, 0.5, 0, box)).toBe(false) // touching
    expect(orientedRectOverlapsAABB2({ x: 1.9, z: 0.5 }, 1, 0.5, 0, box)).toBe(true)
    // A 45° diamond whose corner points at the box but falls short on the diagonal.
    expect(orientedRectOverlapsAABB2({ x: 2, z: 2 }, 1, 1, Math.PI / 4, box)).toBe(false)
    expect(orientedRectOverlapsAABB2({ x: 1.6, z: 1.6 }, 1, 1, Math.PI / 4, box)).toBe(true)
    expect(orientedRectOverlapsCircle({ x: 0, z: 0 }, 1, 1, 0.3, { x: 3, z: 0 }, 1)).toBe(false)
    expect(orientedRectOverlapsCircle({ x: 0, z: 0 }, 1, 1, 0, { x: 1.5, z: 0 }, 1)).toBe(true)
    expect(circleOverlapsAABB2({ x: 2, z: 0.5 }, 1, box)).toBe(false)
    expect(circleOverlapsAABB2({ x: 1.9, z: 0.5 }, 1, box)).toBe(true)
  })
})

describe("segments", () => {
  it("closest point and distance", () => {
    expect(closestParamOnSegment2({ x: 5, z: 3 }, { x: 0, z: 0 }, { x: 10, z: 0 })).toBe(0.5)
    expect(distancePointSegment2({ x: -3, z: 4 }, { x: 0, z: 0 }, { x: 10, z: 0 })).toBe(5)
  })

  it("intersections", () => {
    const hit = segmentIntersection2({ x: 0, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }, { x: 10, z: 0 })
    expect(hit?.t).toBeCloseTo(0.5)
    expect(hit?.u).toBeCloseTo(0.5)
    expect(segmentIntersection2({ x: 0, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 10 }, { x: 10, z: 0 })).toBeNull()
  })

  it("Liang–Barsky clip", () => {
    expect(clipSegmentToBox2(-5, 5, 15, 5, 0, 0, 10, 10)).toEqual([0.25, 0.75])
    expect(clipSegmentToBox2(-5, 15, 15, 15, 0, 0, 10, 10)).toBeNull()
    expect(clipSegmentToBox2(5, 5, 5, 5, 0, 0, 10, 10)).toEqual([0, 1])
  })
})

describe("line vs solids", () => {
  const out = createInterval()

  it("AABB slab test incl. parallel rays", () => {
    expect(lineAABB3(-1, 0.5, 0.5, 1, 0, 0, 0, 0, 0, 1, 1, 1, out)).toBe(true)
    expect(out.t0).toBeCloseTo(1)
    expect(out.t1).toBeCloseTo(2)
    expect(lineAABB3(-1, 1.5, 0.5, 1, 0, 0, 0, 0, 0, 1, 1, 1, out)).toBe(false)
    // Parallel on the face plane counts as inside (closed box).
    expect(lineAABB3(-1, 1, 0.5, 1, 0, 0, 0, 0, 0, 1, 1, 1, out)).toBe(true)
  })

  it("oriented box: rotated 45° box is hit on its corner", () => {
    const c = Math.cos(Math.PI / 4)
    const s = Math.sin(Math.PI / 4)
    // Unit half-extent box rotated 45°: its corner reaches x = √2.
    expect(lineOrientedBox(5, 0, 0, -1, 0, 0, 0, 0, 0, 1, 1, 1, c, s, out)).toBe(true)
    expect(out.t0).toBeCloseTo(5 - Math.SQRT2)
    expect(lineOrientedBox(5, 0, 1.5, -1, 0, 0, 0, 0, 0, 1, 1, 1, c, s, out)).toBe(false)
  })

  it("vertical cylinder: side, caps and vertical lines", () => {
    expect(lineVerticalCylinder(-5, 1, 0, 1, 0, 0, 0, 0, 0, 1, 2, out)).toBe(true)
    expect(out.t0).toBeCloseTo(4)
    expect(out.t1).toBeCloseTo(6)
    expect(lineVerticalCylinder(-5, 3, 0, 1, 0, 0, 0, 0, 0, 1, 2, out)).toBe(false)
    expect(lineVerticalCylinder(0.5, 10, 0, 0, -1, 0, 0, 0, 0, 1, 2, out)).toBe(true)
    expect(out.t0).toBeCloseTo(8)
    expect(out.t1).toBeCloseTo(10)
    expect(lineVerticalCylinder(1.5, 10, 0, 0, -1, 0, 0, 0, 0, 1, 2, out)).toBe(false)
    // Slanted through the top cap.
    expect(lineVerticalCylinder(0, 4, 0, 0.1, -1, 0, 0, 0, 0, 1, 2, out)).toBe(true)
    expect(out.t0).toBeCloseTo(2)
  })

  it("convex half-spaces (unit cube)", () => {
    const planes = [1, 0, 0, 1, -1, 0, 0, 0, 0, 1, 0, 1, 0, -1, 0, 0, 0, 0, 1, 1, 0, 0, -1, 0]
    expect(lineConvex(-1, 0.5, 0.5, 1, 0, 0, planes, 6, out)).toBe(true)
    expect(out.t0).toBeCloseTo(1)
    expect(out.t1).toBeCloseTo(2)
    expect(lineConvex(-1, 2, 0.5, 1, 0, 0, planes, 6, out)).toBe(false)
  })

  it("entry classification", () => {
    expect(classifyEntry(0.2, 0.4, 10)).toBe(0.2)
    expect(classifyEntry(-0.1, 0.4, 10)).toBe(ENTRY_CONTAINS_START)
    expect(classifyEntry(0, 0.4, 10)).toBe(ENTRY_CONTAINS_START)
    expect(classifyEntry(-0.5, -0.1, 10)).toBe(ENTRY_MISS)
    expect(classifyEntry(1, 2, 10)).toBe(ENTRY_MISS)
    // Grazing contact (zero-length overlap) does not block.
    expect(classifyEntry(0.5, 0.5, 10)).toBe(ENTRY_MISS)
    // Ending inside the solid after entering it blocks.
    expect(classifyEntry(0.9, 3, 10)).toBe(0.9)
  })
})

describe("polygons", () => {
  const square = rectPolygon({ x: 0, z: 0, w: 2, d: 2 })

  it("area, containment, hull", () => {
    expect(polygonArea(square)).toBe(4)
    expect(pointInConvexPolygon({ x: 1, z: 1 }, square)).toBe(true)
    expect(pointInConvexPolygon({ x: 2, z: 1 }, square)).toBe(true)
    expect(pointInConvexPolygon({ x: 2.1, z: 1 }, square)).toBe(false)
    expect(pointInConvexPolygon({ x: 1, z: 1 }, [...square].reverse())).toBe(true)
    expect(pointInPolygon({ x: 1, z: 1 }, square)).toBe(true)
    expect(pointInPolygon({ x: 3, z: 1 }, square)).toBe(false)
    const hull = convexHull([...square, { x: 1, z: 1 }, { x: 1, z: 0 }])
    expect(hull).toHaveLength(4)
    expect(polygonArea(hull)).toBe(4)
  })

  it("SAT overlap is strict", () => {
    const b = rectPolygon({ x: 2, z: 0, w: 2, d: 2 })
    expect(convexPolygonsOverlap(square, b)).toBe(false)
    const c = rectPolygon({ x: 1.5, z: 1.5, w: 2, d: 2 })
    expect(convexPolygonsOverlap(square, c)).toBe(true)
    const diamond = [
      { x: 3, z: 2 },
      { x: 4, z: 3 },
      { x: 3, z: 4 },
      { x: 2, z: 3 },
    ]
    expect(convexPolygonsOverlap(square, diamond)).toBe(false)
  })

  it("clips to a rect", () => {
    const tri = [
      { x: -1, z: -1 },
      { x: 3, z: -1 },
      { x: -1, z: 3 },
    ]
    const clipped = clipPolygonToRect(tri, { x: 0, z: 0, w: 2, d: 2 })
    // The square minus the corner beyond the hypotenuse x + z = 2 → a triangle of area 2.
    expect(polygonArea(clipped)).toBeCloseTo(2)
  })
})
