import { describe, expect, it } from "vitest"

import {
  footprintOverlapsCapsule,
  footprintOverlapsCircle,
  footprintOverlapsPolygon,
  footprintOverlapsRect,
  footprintPolygon,
  heightfieldSurfaceAt,
  primitiveBounds,
  primitiveContains,
  primitiveTopAt,
  pushOutOfPrimitive,
  segmentEntry,
} from "./primitives"
import { rng } from "./test-utils"
import type { Heightfield, OrientedBox, VerticalCylinder } from "./types"

const flags = { movement: true, sight: true, light: true }

const box = (partial: Partial<OrientedBox> = {}): OrientedBox => ({
  key: "b",
  sourceId: "b",
  sourceType: "prop",
  levelId: "L",
  blocks: flags,
  shape: "box",
  center: { x: 0, y: 1, z: 0 },
  halfExtents: { x: 2, y: 1, z: 0.5 },
  yaw: 0,
  ...partial,
})

const cyl = (partial: Partial<VerticalCylinder> = {}): VerticalCylinder => ({
  key: "c",
  sourceId: "c",
  sourceType: "prop",
  levelId: "L",
  blocks: flags,
  shape: "cylinder",
  base: { x: 0, y: 0, z: 0 },
  radius: 1,
  height: 3,
  ...partial,
})

/** Heightfield over [0, n·s]² with heights f(i, j) at samples and every cell solid unless listed. */
function field(n: number, s: number, f: (i: number, j: number) => number, holes: [number, number][] = [], thickness = 1): Heightfield {
  const heights = new Float32Array((n + 1) * (n + 1))
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) heights[j * (n + 1) + i] = f(i, j)
  const solid = new Uint8Array(n * n).fill(1)
  for (const [i, j] of holes) solid[j * n + i] = 0
  return {
    key: "h",
    sourceId: "h",
    sourceType: "terrain",
    levelId: "L",
    blocks: { movement: false, sight: true, light: true },
    shape: "heightfield",
    originX: 0,
    originZ: 0,
    spacing: s,
    samplesX: n + 1,
    samplesZ: n + 1,
    heights,
    solid,
    thickness,
  }
}

describe("segmentEntry (ENTRY semantics)", () => {
  it("boxes: entry t, start-inside ignored, ending inside blocked", () => {
    const b = box()
    expect(segmentEntry(b, { x: -10, y: 1, z: 0 }, { x: 10, y: 1, z: 0 })).toBeCloseTo(0.4)
    expect(segmentEntry(b, { x: 0, y: 1, z: 0 }, { x: 10, y: 1, z: 0 })).toBeNull()
    expect(segmentEntry(b, { x: -10, y: 1, z: 0 }, { x: 0, y: 1, z: 0 })).toBeCloseTo(0.8)
    expect(segmentEntry(b, { x: -10, y: 2.5, z: 0 }, { x: 10, y: 2.5, z: 0 })).toBeNull()
    // Ending exactly on the face does not enter.
    expect(segmentEntry(b, { x: -10, y: 1, z: 0 }, { x: -2, y: 1, z: 0 })).toBeNull()
  })

  it("rotated boxes", () => {
    const b = box({ yaw: Math.PI / 2 }) // long axis now along Z
    expect(segmentEntry(b, { x: -10, y: 1, z: 1.5 }, { x: 10, y: 1, z: 1.5 })).toBeCloseTo(0.475)
    expect(segmentEntry(b, { x: -10, y: 1, z: 2.5 }, { x: 10, y: 1, z: 2.5 })).toBeNull()
  })

  it("cylinders: side, caps, inside", () => {
    const c = cyl()
    expect(segmentEntry(c, { x: -5, y: 1, z: 0 }, { x: 5, y: 1, z: 0 })).toBeCloseTo(0.4)
    expect(segmentEntry(c, { x: 0, y: 10, z: 0 }, { x: 0, y: 0, z: 0 })).toBeCloseTo(0.7)
    expect(segmentEntry(c, { x: 0, y: 1, z: 0 }, { x: 5, y: 1, z: 0 })).toBeNull()
    expect(segmentEntry(c, { x: -5, y: 1, z: 1.01 }, { x: 5, y: 1, z: 1.01 })).toBeNull()
  })

  it("zero-length segments never block", () => {
    expect(segmentEntry(box(), { x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 })).toBeNull()
  })
})

describe("heightfields", () => {
  it("surface follows the triangle split", () => {
    // Only sample (1,1) is raised: triangle A (tx ≥ tz) of cell (0,0) uses h00, h10, h11.
    const hf = field(2, 1, (i, j) => (i === 1 && j === 1 ? 4 : 0))
    expect(heightfieldSurfaceAt(hf, 0.75, 0.25)).toBeCloseTo(0.25 * 4)
    expect(heightfieldSurfaceAt(hf, 0.25, 0.75)).toBeCloseTo(0.25 * 4)
    expect(heightfieldSurfaceAt(hf, 1, 1)).toBeCloseTo(4)
    expect(heightfieldSurfaceAt(hf, 3, 1)).toBeNull()
  })

  it("contains points within [surface − thickness, surface] over solid cells only", () => {
    const hf = field(4, 1, () => 2, [[1, 1]], 1)
    expect(primitiveContains(hf, { x: 0.5, y: 1.5, z: 0.5 })).toBe(true)
    expect(primitiveContains(hf, { x: 0.5, y: 2.5, z: 0.5 })).toBe(false)
    expect(primitiveContains(hf, { x: 0.5, y: 0.5, z: 0.5 })).toBe(false)
    expect(primitiveContains(hf, { x: 1.5, y: 1.5, z: 1.5 })).toBe(false)
  })

  it("a hill blocks a grazing ray; the flat part and holes do not", () => {
    // 20×20 lattice at 1 ft, a 4 ft pyramid centred at (10, 10).
    const hf = field(20, 1, (i, j) => Math.max(0, 4 - Math.max(Math.abs(i - 10), Math.abs(j - 10))))
    expect(segmentEntry(hf, { x: 0.5, y: 1, z: 10 }, { x: 19.5, y: 1, z: 10 })).toBeCloseTo((7 - 0.5) / 19, 5)
    expect(segmentEntry(hf, { x: 0.5, y: 5, z: 10 }, { x: 19.5, y: 5, z: 10 })).toBeNull()
    expect(segmentEntry(hf, { x: 0.5, y: 0.25, z: 2 }, { x: 19.5, y: 0.25, z: 2 })).toBeNull()
    // Vertical segment from below the slab up through it is blocked at its underside.
    expect(segmentEntry(hf, { x: 2.5, y: -5, z: 2.5 }, { x: 2.5, y: 5, z: 2.5 })).toBeCloseTo(0.4)
    const holed = field(4, 1, () => 0, [[2, 2]])
    expect(segmentEntry(holed, { x: 2.5, y: -5, z: 2.5 }, { x: 2.5, y: 5, z: 2.5 })).toBeNull()
  })

  it("rays along cell diagonals and shared faces do not leak", () => {
    const hf = field(6, 1, () => 1, [], 2)
    // Horizontal ray exactly along the lattice diagonal x = z inside the slab (y ∈ [−1, 1]).
    expect(segmentEntry(hf, { x: -1, y: 0, z: -1 }, { x: 5.5, y: 0, z: 5.5 })).toBeCloseTo(1 / 6.5, 6)
    // Along a shared vertical face x = 3.
    expect(segmentEntry(hf, { x: 3, y: 0, z: -1 }, { x: 3, y: 0, z: 5 })).toBeCloseTo(1 / 6, 6)
  })

  it("start inside the heightfield ignores it; entries match a brute-force march", () => {
    const rand = rng(9)
    const hf = field(12, 1.25, () => rand() * 3, [], 1)
    expect(segmentEntry(hf, { x: 5, y: heightfieldSurfaceAt(hf, 5, 5)! - 0.5, z: 5 }, { x: 5, y: 20, z: 5 })).toBeNull()
    const r = rng(10)
    for (let k = 0; k < 300; k++) {
      const a = { x: r() * 15, y: 3.2 + r(), z: r() * 15 }
      const b = { x: r() * 15, y: r() * 4 - 1, z: r() * 15 }
      const t = segmentEntry(hf, a, b)
      // March the segment: first sample inside the solid.
      let first: number | null = null
      for (let m = 1; m <= 4000; m++) {
        const u = m / 4000
        const p = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u }
        if (primitiveContains(hf, p, 0)) {
          first = u
          break
        }
      }
      if (first === null) expect(t).toBeNull()
      else {
        expect(t).not.toBeNull()
        expect(Math.abs(t! - first)).toBeLessThan(2 / 4000)
      }
    }
  })
})

describe("bounds, tops, footprints, push-out", () => {
  it("bounds", () => {
    const rotated = primitiveBounds(box({ yaw: Math.PI / 2 }))
    expect(rotated.minX).toBeCloseTo(-0.5)
    expect(rotated.maxX).toBeCloseTo(0.5)
    expect(rotated.maxZ).toBeCloseTo(2)
    expect(rotated.maxY).toBe(2)
    expect(primitiveBounds(cyl())).toEqual({ minX: -1, minY: 0, minZ: -1, maxX: 1, maxY: 3, maxZ: 1 })
    const hf = field(4, 1, () => 2, [
      [0, 0],
      [3, 3],
    ])
    expect(primitiveBounds(hf)).toEqual({ minX: 0, minY: 1, minZ: 0, maxX: 4, maxY: 2, maxZ: 4 })
  })

  it("tops", () => {
    expect(primitiveTopAt(box(), 1, 0.2)).toBe(2)
    expect(primitiveTopAt(box(), 1, 0.6)).toBeNull()
    expect(primitiveTopAt(cyl(), 0.5, 0.5)).toBe(3)
  })

  it("footprint overlap is strict", () => {
    const b = box()
    expect(footprintOverlapsRect(b, { x: 2, z: -1, w: 1, d: 2 })).toBe(false)
    expect(footprintOverlapsRect(b, { x: 1.9, z: -1, w: 1, d: 2 })).toBe(true)
    expect(footprintOverlapsCircle(cyl(), { x: 2, z: 0 }, 1)).toBe(false)
    expect(footprintOverlapsCircle(cyl(), { x: 1.9, z: 0 }, 1)).toBe(true)
    const square = [
      { x: 1.2, z: -0.2 },
      { x: 2.2, z: -0.2 },
      { x: 2.2, z: 0.2 },
      { x: 1.2, z: 0.2 },
    ]
    expect(footprintOverlapsPolygon(cyl(), square)).toBe(false)
    expect(footprintOverlapsPolygon(box(), square)).toBe(true)
    expect(footprintPolygon(cyl())).toHaveLength(16)
    const hf = field(4, 1, () => 0, [[2, 2]])
    expect(footprintOverlapsRect(hf, { x: 2.1, z: 2.1, w: 0.5, d: 0.5 })).toBe(false)
    expect(footprintOverlapsRect(hf, { x: 1.5, z: 2.1, w: 1, d: 0.5 })).toBe(true)
    // Capsules (a token's disc swept along a step): box, rotated box, cylinder, heightfield cells.
    expect(footprintOverlapsCapsule(box(), { x: -5, z: 1.5 }, { x: 5, z: 1.5 }, 1)).toBe(false)
    expect(footprintOverlapsCapsule(box(), { x: -5, z: 1.4 }, { x: 5, z: 1.4 }, 1)).toBe(true)
    expect(footprintOverlapsCapsule(box({ yaw: Math.PI / 2 }), { x: -5, z: 1.5 }, { x: 5, z: 1.5 }, 1)).toBe(true)
    expect(footprintOverlapsCapsule(cyl(), { x: -5, z: 2 }, { x: 5, z: 2 }, 1)).toBe(false)
    expect(footprintOverlapsCapsule(cyl(), { x: -5, z: 1.9 }, { x: 5, z: 1.9 }, 1)).toBe(true)
    expect(footprintOverlapsCapsule(hf, { x: 2.5, z: 2.5 }, { x: 2.5, z: 2.5 }, 0.4)).toBe(false)
    expect(footprintOverlapsCapsule(hf, { x: 2.5, z: 2.5 }, { x: 2.5, z: 2.5 }, 0.6)).toBe(true)
  })

  it("pushes contained points out past the nearest face", () => {
    const b = box()
    const p = pushOutOfPrimitive(b, { x: 1.9, y: 1, z: 0 }, 0.3)
    expect(p.x).toBeCloseTo(2.3)
    expect(primitiveContains(b, p)).toBe(false)
    const q = pushOutOfPrimitive(box({ yaw: 0.6 }), { x: 0.1, y: 1, z: 0.2 }, 0.3)
    expect(primitiveContains(box({ yaw: 0.6 }), q)).toBe(false)
    const c = pushOutOfPrimitive(cyl(), { x: 0, y: 2.9, z: 0 }, 0.3)
    expect(c.y).toBeCloseTo(3.3)
    const s = pushOutOfPrimitive(cyl(), { x: 0.9, y: 1.5, z: 0 }, 0.3)
    expect(s.x).toBeCloseTo(1.3)
    const hf = field(4, 1, () => 2)
    expect(pushOutOfPrimitive(hf, { x: 1.5, y: 1.8, z: 1.5 }, 0.3).y).toBeCloseTo(2.3)
    expect(pushOutOfPrimitive(b, { x: 5, y: 5, z: 5 }, 0.3)).toEqual({ x: 5, y: 5, z: 5 })
  })
})
