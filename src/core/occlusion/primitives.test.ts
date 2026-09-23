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
  stripMaxTop,
  stripTopAt,
} from "./primitives"
import { rng } from "./test-utils"
import type { Heightfield, OrientedBox, VerticalCylinder, WallStrip } from "./types"

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

/** Wall strip (default: 10 ft long along X, 0.5 ft thick, bottom 0, top rising 4 → 6 → 5 → 8). */
const strip = (partial: Partial<WallStrip> = {}): WallStrip => ({
  key: "s",
  sourceId: "s",
  sourceType: "wall",
  levelId: "L",
  blocks: flags,
  shape: "strip",
  center: { x: 0, z: 0 },
  halfExtents: { x: 5, z: 0.25 },
  yaw: 0,
  knots: [-5, -2, 1, 5],
  top: [4, 6, 5, 8],
  bottom: 0,
  ...partial,
})

/** The strip equal to a box: constant top over one knot interval. */
const boxStrip = (b: OrientedBox): WallStrip =>
  strip({
    center: { x: b.center.x, z: b.center.z },
    halfExtents: { x: b.halfExtents.x, z: b.halfExtents.z },
    yaw: b.yaw,
    knots: [-b.halfExtents.x, b.halfExtents.x],
    top: [b.center.y + b.halfExtents.y, b.center.y + b.halfExtents.y],
    bottom: b.center.y - b.halfExtents.y,
  })

/** First sample along a→b inside the primitive (no tolerance), or null. */
function march(p: Parameters<typeof primitiveContains>[0], a: { x: number; y: number; z: number }, b: typeof a, n = 4000): number | null {
  for (let m = 1; m <= n; m++) {
    const u = m / n
    if (primitiveContains(p, { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u }, 0)) return u
  }
  return null
}

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

  it("pushes points on a face or within EPS of it (segments from there ignore the primitive)", () => {
    // Box top at y = 2; a point on the top face and one 1e-7 above it both count as contained.
    const b = box()
    for (const y of [2, 2 + 1e-7]) {
      expect(primitiveContains(b, { x: 0, y, z: 0 })).toBe(true)
      expect(pushOutOfPrimitive(b, { x: 0, y, z: 0 }, 0.3).y).toBeCloseTo(2.3, 9)
    }
    // Heightfield with top 2: same rule, vertically.
    const hf = field(4, 1, () => 2)
    for (const y of [2, 2 + 1e-7]) expect(pushOutOfPrimitive(hf, { x: 1.5, y, z: 1.5 }, 0.3).y).toBeCloseTo(2.3, 6)
    // Cylinder side: a point on the curved face goes radially out.
    expect(pushOutOfPrimitive(cyl(), { x: 1 + 1e-7, y: 1.5, z: 0 }, 0.3).x).toBeCloseTo(1.3, 9)
    // Points clearly outside are untouched.
    expect(pushOutOfPrimitive(b, { x: 0, y: 2.001, z: 0 }, 0.3)).toEqual({ x: 0, y: 2.001, z: 0 })
  })
})

describe("wall strips", () => {
  it("top line, bounds, footprints and the box-like footprint polygon", () => {
    const st = strip()
    expect(stripTopAt(st, -5)).toBe(4)
    expect(stripTopAt(st, -3.5)).toBeCloseTo(5)
    expect(stripTopAt(st, -2)).toBe(6)
    expect(stripTopAt(st, 3)).toBeCloseTo(6.5)
    expect(stripTopAt(st, 9)).toBe(8)
    expect(stripMaxTop(st, -5, 0)).toBe(6)
    expect(stripMaxTop(st, 0, -5)).toBe(6)
    expect(stripMaxTop(st, 0, 2)).toBeCloseTo(5 + 0.75)
    expect(stripMaxTop(st, 1, 1)).toBe(5)
    expect(primitiveBounds(st)).toEqual({ minX: -5, minY: 0, minZ: -0.25, maxX: 5, maxY: 8, maxZ: 0.25 })
    // Rotated a quarter turn: local +X is world −Z (three.js yaw), so the high end is at z = −5.
    const r = strip({ yaw: Math.PI / 2, center: { x: 10, z: 20 } })
    const rb = primitiveBounds(r)
    expect(rb.minX).toBeCloseTo(9.75)
    expect(rb.maxZ).toBeCloseTo(25)
    expect(primitiveTopAt(r, 10, 15.5)).toBeCloseTo(8 - 0.5 * (3 / 4))
    expect(primitiveTopAt(r, 10, 24.9)).toBeCloseTo(4 + 0.1 * (2 / 3))
    expect(primitiveTopAt(r, 10.3, 20)).toBeNull()
    expect(footprintPolygon(r)).toEqual(footprintPolygon({ ...box(), center: { x: 10, y: 0, z: 20 }, halfExtents: { x: 5, y: 1, z: 0.25 }, yaw: Math.PI / 2 }))
    expect(footprintOverlapsRect(st, { x: 4.9, z: 0.2, w: 1, d: 1 })).toBe(true)
    expect(footprintOverlapsRect(st, { x: 5, z: 0, w: 1, d: 1 })).toBe(false)
    expect(footprintOverlapsCircle(st, { x: 0, z: 1.2 }, 1)).toBe(true)
    expect(footprintOverlapsCircle(st, { x: 0, z: 1.25 }, 1)).toBe(false)
    expect(footprintOverlapsCapsule(r, { x: 0, z: 17 }, { x: 20, z: 17 }, 0.1)).toBe(true)
    const tri = [
      { x: 4, z: -1 },
      { x: 6, z: -1 },
      { x: 6, z: 1 },
    ]
    expect(footprintOverlapsPolygon(st, tri)).toBe(true)
  })

  it("containment under the sloped top, above the bottom, inside the footprint", () => {
    const st = strip()
    expect(primitiveContains(st, { x: -3.5, y: 4.9, z: 0 })).toBe(true)
    expect(primitiveContains(st, { x: -3.5, y: 5.1, z: 0 })).toBe(false)
    expect(primitiveContains(st, { x: -2, y: 6, z: 0.25 })).toBe(true) // knot, on the top and a face
    expect(primitiveContains(st, { x: -2, y: 6 + 2e-6, z: 0 })).toBe(false)
    expect(primitiveContains(st, { x: 0, y: -0.1, z: 0 })).toBe(false)
    expect(primitiveContains(st, { x: 5.1, y: 1, z: 0 })).toBe(false)
    expect(primitiveContains(st, { x: 0, y: 1, z: 0.3 })).toBe(false)
  })

  it("entry semantics are the box's on a constant profile", () => {
    const r = rng(31)
    for (let k = 0; k < 2000; k++) {
      const b = box({
        yaw: k % 3 === 0 ? 0 : r() * 6,
        center: { x: r() * 2, y: 1 + r(), z: r() * 2 },
        halfExtents: { x: 0.5 + r() * 3, y: 0.5 + r() * 2, z: 0.2 + r() },
      })
      const st = boxStrip(b)
      const a = { x: (r() - 0.5) * 12, y: r() * 5 - 0.5, z: (r() - 0.5) * 12 }
      // Some segments start inside, on a face or end inside.
      const c = k % 5 === 0 ? { ...b.center } : { x: (r() - 0.5) * 12, y: r() * 5 - 0.5, z: (r() - 0.5) * 12 }
      const tb = segmentEntry(b, a, c)
      const ts = segmentEntry(st, a, c)
      if (tb === null) expect(ts).toBeNull()
      else expect(ts).toBeCloseTo(tb, 9)
      const tc = segmentEntry(b, c, a)
      if (tc === null) expect(segmentEntry(st, c, a)).toBeNull()
      else expect(segmentEntry(st, c, a)).toBeCloseTo(tc, 9)
    }
  })

  it("EPS: grazing the top or a face does not block; a start within EPS is contained; ending on a face does not enter", () => {
    const st = strip()
    // Across the wall just above / below the ridge at the knot x = −2 (top 6).
    expect(segmentEntry(st, { x: -2, y: 6 + 1e-7, z: -3 }, { x: -2, y: 6 + 1e-7, z: 3 })).toBeNull()
    expect(segmentEntry(st, { x: -2, y: 5.99, z: -3 }, { x: -2, y: 5.99, z: 3 })).toBeCloseTo((3 - 0.25) / 6, 9)
    // Touching the ridge line from above at a single point does not penetrate.
    expect(segmentEntry(st, { x: -4, y: 6, z: 0 }, { x: 0, y: 6, z: 0 })).toBeNull()
    expect(segmentEntry(st, { x: -4, y: 5.99, z: 0 }, { x: 0, y: 5.99, z: 0 })).not.toBeNull()
    // Start 1e-7 outside the side face → contained (ignored); a real entry from farther out.
    expect(segmentEntry(st, { x: 0, y: 1, z: 0.25 + 1e-7 }, { x: 0, y: 1, z: -3 })).toBeNull()
    expect(segmentEntry(st, { x: 0, y: 1, z: 1.25 }, { x: 0, y: 1, z: -3 })).toBeCloseTo(1 / 4.25, 9)
    // Ending exactly on the face.
    expect(segmentEntry(st, { x: 0, y: 1, z: 3 }, { x: 0, y: 1, z: 0.25 })).toBeNull()
    // Rays along the wall inside it cross internal knot faces without new entries.
    expect(segmentEntry(st, { x: -4.9, y: 1, z: 0 }, { x: 4.9, y: 1, z: 0 })).toBeNull()
    expect(segmentEntry(st, { x: -9, y: 1, z: 0 }, { x: 9, y: 1, z: 0 })).toBeCloseTo(4 / 18, 9)
    expect(segmentEntry(st, { x: 9, y: 1, z: 0 }, { x: -9, y: 1, z: 0 })).toBeCloseTo(4 / 18, 9)
    // Over the dip (top 5 at x = 1) at y = 5.5: enters the rising part at x = 1 + 0.5 / 0.75; the other
    // way through the end face at x = 5.
    expect(segmentEntry(st, { x: 0.5, y: 5.5, z: 0 }, { x: 9, y: 5.5, z: 0 })).toBeCloseTo((1 + 0.5 / 0.75 - 0.5) / 8.5, 9)
    expect(segmentEntry(st, { x: 9, y: 5.5, z: 0 }, { x: 0.5, y: 5.5, z: 0 })).toBeCloseTo(4 / 8.5, 9)
    expect(segmentEntry(st, { x: -1, y: 5.5, z: 0 }, { x: 9, y: 5.5, z: 0 })).toBeNull() // starts inside (top 5.67)
    // Vertical rays: from above onto the top line, from below into the bottom.
    expect(segmentEntry(st, { x: 3, y: 10, z: 0 }, { x: 3, y: 0, z: 0 })).toBeCloseTo(0.35, 9)
    expect(segmentEntry(st, { x: 3, y: -2, z: 0 }, { x: 3, y: 1, z: 0 })).toBeCloseTo(2 / 3, 9)
  })

  it("entries match a brute-force march (rotated strips, many knots)", () => {
    const r = rng(17)
    for (let n = 0; n < 8; n++) {
      const count = 3 + Math.floor(r() * 40)
      const hx = 3 + r() * 10
      const knots = [-hx]
      for (let k = 1; k < count - 1; k++) knots.push(-hx + (2 * hx * k) / (count - 1) + (r() - 0.5) * 0.01)
      knots.push(hx)
      const st = strip({
        yaw: r() * 6,
        center: { x: r() * 3, z: r() * 3 },
        halfExtents: { x: hx, z: 0.25 + r() },
        knots,
        top: knots.map(() => 2 + r() * 4),
        bottom: r() - 0.5,
      })
      for (let k = 0; k < 150; k++) {
        const a = { x: (r() - 0.5) * 30, y: r() * 7 - 1, z: (r() - 0.5) * 30 }
        const b = { x: (r() - 0.5) * 30, y: r() * 7 - 1, z: (r() - 0.5) * 30 }
        const t = segmentEntry(st, a, b)
        const first = march(st, a, b)
        if (primitiveContains(st, a)) {
          expect(t).toBeNull()
          continue
        }
        if (first === null) expect(t).toBeNull()
        else {
          expect(t).not.toBeNull()
          expect(Math.abs(t! - first)).toBeLessThan(2 / 4000)
        }
      }
    }
  })

  it("push-out: nearest side, the top line above the point, or below the bottom", () => {
    const st = strip()
    const side = pushOutOfPrimitive(st, { x: 0, y: 2, z: 0.2 }, 0.3)
    expect(side).toEqual({ x: 0, y: 2, z: 0.55 })
    const up = pushOutOfPrimitive(st, { x: 3, y: 6.4, z: 0 }, 0.3)
    expect(up.x).toBe(3)
    expect(up.y).toBeCloseTo(6.8)
    expect(primitiveContains(st, up)).toBe(false)
    expect(pushOutOfPrimitive(st, { x: 0, y: 0.1, z: 0 }, 0.3).y).toBeCloseTo(-0.3)
    const end = pushOutOfPrimitive(strip({ yaw: 0.7 }), { x: 4.9 * Math.cos(0.7), y: 3, z: -4.9 * Math.sin(0.7) }, 0.3)
    expect(primitiveContains(strip({ yaw: 0.7 }), end)).toBe(false)
    expect(pushOutOfPrimitive(st, { x: 0, y: 7, z: 0 }, 0.3)).toEqual({ x: 0, y: 7, z: 0 })
  })
})
