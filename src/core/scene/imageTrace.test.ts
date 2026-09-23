import { describe, expect, it } from "vitest"

import { createScene } from "./factory"
import {
  alphaContours,
  floorMaskFromAlpha,
  floorObjectFromTrace,
  ringArea,
  simplifyRing,
  traceAlphaOutlines,
  wallObjectsFromAlpha,
  wallsFromAlpha,
  type TraceImage,
} from "./imageTrace"
import { decodeFloorMask, floorRects } from "./queries"
import { parseScene } from "./schema"
import type { Rect, Vec2 } from "./types"

/** Point-in-polygon (even-odd) in image pixel space. */
function inPolygons(polys: Vec2[][], x: number, z: number): boolean {
  let inside = false
  for (const poly of polys) {
    for (let k = 0, n = poly.length, m = n - 1; k < n; m = k++) {
      const a = poly[k]
      const b = poly[m]
      if (a.z > z !== b.z > z && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside
    }
  }
  return inside
}

/** Anti-aliased RGBA image of polygons given in PIXEL coordinates (4×4 supersampling). */
function raster(width: number, height: number, polys: Vec2[][]): TraceImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let hits = 0
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inPolygons(polys, px + (sx + 0.5) / 4, py + (sy + 0.5) / 4)) hits++
      const k = (py * width + px) * 4
      data[k] = 200
      data[k + 1] = 180
      data[k + 2] = 150
      data[k + 3] = Math.round((hits / 16) * 255)
    }
  }
  return { width, height, data }
}

const rectPoly = (x0: number, z0: number, x1: number, z1: number): Vec2[] => [
  { x: x0, z: z0 },
  { x: x1, z: z0 },
  { x: x1, z: z1 },
  { x: x0, z: z1 },
]

function rotated(cx: number, cz: number, pts: Vec2[], angle: number): Vec2[] {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return pts.map((p) => ({ x: cx + (p.x - cx) * c - (p.z - cz) * s, z: cz + (p.x - cx) * s + (p.z - cz) * c }))
}

/** 100×100 px image over a 50×50 ft rect (0.5 ft per pixel, 10 px per 5 ft cell). */
const RECT: Rect = { x: 0, z: 0, w: 50, d: 50 }
const calib = { rect: RECT, cellSize: 5 }

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dz = b.z - a.z
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz)))
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t)
}

function distToPolygon(p: Vec2, poly: Vec2[]): number {
  let best = Infinity
  for (let k = 0; k < poly.length; k++) best = Math.min(best, distToSegment(p, poly[k], poly[(k + 1) % poly.length]))
  return best
}

describe("floorMaskFromAlpha", () => {
  it("returns null for a fully transparent image", () => {
    expect(floorMaskFromAlpha(raster(20, 20, []), calib)).toBeNull()
  })

  it("trims to an axis-aligned opaque block and snaps to the lattice", () => {
    // Opaque pixels 20..60 × 10..50 → x 10..30 ft, z 5..25 ft.
    const img = raster(100, 100, [rectPoly(20, 10, 60, 50)])
    const traced = floorMaskFromAlpha(img, calib)!
    expect(traced.rect).toEqual({ x: 10, z: 5, w: 20, d: 20 })
    expect(traced.mask.spacing).toBe(1.25)
    expect(traced.mask.cols).toBe(16)
    expect(traced.mask.rows).toBe(16)
    expect(traced.fill).toBe(1)
    // A full mask becomes a plain rect floor.
    expect(floorObjectFromTrace("L", traced).mask).toBeUndefined()
  })

  it("anchors the lattice at the world origin even when the image rect is offset", () => {
    const img = raster(100, 100, [rectPoly(0, 0, 100, 100)])
    const traced = floorMaskFromAlpha(img, { rect: { x: 3.1, z: 0.4, w: 50, d: 50 }, cellSize: 5 })!
    const s = traced.mask.spacing
    expect(traced.rect.x / s).toBeCloseTo(Math.round(traced.rect.x / s), 9)
    expect(traced.rect.z / s).toBeCloseTo(Math.round(traced.rect.z / s), 9)
    // Every covered cell is at least half covered by the image.
    expect(traced.rect.x).toBeGreaterThanOrEqual(3.1 - s / 2)
    expect(traced.rect.x + traced.rect.w).toBeLessThanOrEqual(53.1 + s / 2)
  })

  it("covers a rotated square with a mask whose rects lie inside the opaque area (± one mask cell)", () => {
    // 60 px square rotated 30° about the image centre.
    const square = rotated(50, 50, rectPoly(20, 20, 80, 80), Math.PI / 6)
    const img = raster(100, 100, [square])
    const traced = floorMaskFromAlpha(img, calib)!
    expect(traced.fill).toBeGreaterThan(0.5)
    expect(traced.fill).toBeLessThan(0.9)
    const floor = floorObjectFromTrace("L", traced)
    expect(floor.mask).toBeDefined()
    const worldSquare = square.map((p) => ({ x: p.x / 2, z: p.z / 2 }))
    const cells = decodeFloorMask(floor.mask!)
    let area = 0
    for (let v = 0; v < traced.mask.rows; v++) {
      for (let u = 0; u < traced.mask.cols; u++) {
        if (!cells[v * traced.mask.cols + u]) continue
        area += traced.mask.spacing ** 2
        const c = { x: traced.rect.x + (u + 0.5) * traced.mask.spacing, z: traced.rect.z + (v + 0.5) * traced.mask.spacing }
        // Covered cell centres are inside the square, or within one cell of its edge.
        if (!inPolygons([worldSquare], c.x, c.z)) expect(distToPolygon(c, worldSquare)).toBeLessThan(traced.mask.spacing)
      }
    }
    expect(area).toBeCloseTo(30 * 30, -1.5)
    // floorRects (what every consumer uses) cover the same area.
    const rectArea = floorRects(floor).reduce((sum, r) => sum + r.w * r.d, 0)
    expect(rectArea).toBeCloseTo(area, 6)
  })

  it("produces a floor the strict scene schema accepts", () => {
    const scene = createScene({ width: 10, depth: 10, groundFloor: false })
    const levelId = Object.keys(scene.levels)[0]
    const img = raster(100, 100, [rotated(50, 50, rectPoly(25, 15, 75, 85), 0.4)])
    const floor = floorObjectFromTrace(levelId, floorMaskFromAlpha(img, calib)!)
    scene.objects[floor.id] = floor
    const parsed = parseScene(JSON.parse(JSON.stringify(scene)))
    expect(parsed.ok).toBe(true)
  })

  it("point-samples when the image is coarser than the lattice", () => {
    // 10×10 px over 50 ft = 5 ft per pixel, spacing 1.25 → 4×4 mask cells per pixel.
    const img = raster(10, 10, [rectPoly(2, 3, 5, 6)])
    const traced = floorMaskFromAlpha(img, calib)!
    expect(traced.rect).toEqual({ x: 10, z: 15, w: 15, d: 15 })
    expect(traced.fill).toBe(1)
  })

  it("respects minCoverage and threshold", () => {
    const img = raster(100, 100, [rectPoly(21, 21, 29, 29)])
    // 4×4 ft opaque block: at spacing 5 the single cell is 64% covered.
    expect(floorMaskFromAlpha(img, calib, { spacing: 5, minCoverage: 0.5 })).not.toBeNull()
    expect(floorMaskFromAlpha(img, calib, { spacing: 5, minCoverage: 0.7 })).toBeNull()
    expect(floorMaskFromAlpha(img, calib, { threshold: 256 })).toBeNull()
  })
})

describe("wallsFromAlpha", () => {
  it("finds nothing in empty or tiny images", () => {
    expect(wallsFromAlpha(raster(40, 40, []), calib)).toEqual([])
    // A 2×2 px speck (1×1 ft) is below the default minimum loop area.
    expect(wallsFromAlpha(raster(40, 40, [rectPoly(10, 10, 12, 12)]), calib)).toEqual([])
  })

  it("outlines an axis-aligned rectangle with 4 walls on its edges", () => {
    const img = raster(100, 100, [rectPoly(20, 10, 60, 50)])
    const segs = wallsFromAlpha(img, calib)
    expect(segs).toHaveLength(4)
    const outline = rectPoly(10, 5, 30, 25)
    for (const s of segs) {
      // Corners are snapped (line fit + intersection), not rounded off by the contour.
      for (const p of [s.a, s.b]) expect(Math.min(...outline.map((c) => Math.hypot(c.x - p.x, c.z - p.z)))).toBeLessThan(0.1)
    }
    // Closed ring: every endpoint is shared by exactly two walls (joints).
    const key = (p: Vec2) => `${p.x},${p.z}`
    const counts = new Map<string, number>()
    for (const s of segs) for (const p of [s.a, s.b]) counts.set(key(p), (counts.get(key(p)) ?? 0) + 1)
    expect([...counts.values()].every((n) => n === 2)).toBe(true)
  })

  it("outlines a rotated L-shaped storey with 6 walls within tolerance", () => {
    const L = rotated(
      50,
      50,
      [
        { x: 20, z: 15 },
        { x: 55, z: 15 },
        { x: 55, z: 50 },
        { x: 80, z: 50 },
        { x: 80, z: 85 },
        { x: 20, z: 85 },
      ],
      0.35
    )
    const img = raster(100, 100, [L])
    const segs = wallsFromAlpha(img, calib)
    expect(segs).toHaveLength(6)
    const worldL = L.map((p) => ({ x: p.x / 2, z: p.z / 2 }))
    for (const s of segs) {
      for (const p of [s.a, s.b]) expect(distToPolygon(p, worldL)).toBeLessThan(0.75)
    }
    const walls = wallObjectsFromAlpha("L1", img, calib, { height: 9, thickness: 0.5 })
    expect(walls).toHaveLength(6)
    expect(walls.every((w) => w.height === 9 && w.thickness === 0.5 && w.levelId === "L1")).toBe(true)
  })

  it("orients outer boundaries counter-clockwise and holes clockwise", () => {
    // A ring: 80 px square with a 30 px square hole (even-odd raster).
    const img = raster(100, 100, [rectPoly(10, 10, 90, 90), rectPoly(35, 35, 65, 65)])
    const rings = traceAlphaOutlines(img, calib)
    expect(rings).toHaveLength(2)
    const areas = rings.map(ringArea).sort((a, b) => a - b)
    expect(Math.abs(areas[0] + 15 * 15)).toBeLessThan(1)
    expect(Math.abs(areas[1] - 40 * 40)).toBeLessThan(2)
  })

  it("approximates a disc within the tolerance", () => {
    const disc: Vec2[] = []
    for (let k = 0; k < 64; k++) disc.push({ x: 50 + 35 * Math.cos((k / 64) * 2 * Math.PI), z: 50 + 35 * Math.sin((k / 64) * 2 * Math.PI) })
    const img = raster(100, 100, [disc])
    const rings = traceAlphaOutlines(img, calib, { tolerance: 0.5 })
    expect(rings).toHaveLength(1)
    for (const p of rings[0]) expect(Math.abs(Math.hypot(p.x - 25, p.z - 25) - 17.5)).toBeLessThan(0.6)
    // Coarser tolerance → fewer walls.
    expect(traceAlphaOutlines(img, calib, { tolerance: 2 })[0].length).toBeLessThan(rings[0].length)
  })

  it("closes contours along the image border (opaque up to the edge)", () => {
    const img = raster(40, 40, [rectPoly(0, 0, 40, 40)])
    const rings = traceAlphaOutlines(img, { rect: { x: 0, z: 0, w: 20, d: 20 }, cellSize: 5 })
    expect(rings).toHaveLength(1)
    expect(Math.abs(ringArea(rings[0]) - 400)).toBeLessThan(0.5)
  })

  it("keeps separate islands apart and drops walls shorter than minLength", () => {
    const img = raster(100, 100, [rectPoly(5, 5, 30, 30), rectPoly(60, 60, 95, 95)])
    expect(alphaContours(img, calib)).toHaveLength(2)
    for (const s of wallsFromAlpha(img, calib, { minLength: 2 })) expect(Math.hypot(s.b.x - s.a.x, s.b.z - s.a.z)).toBeGreaterThanOrEqual(2)
  })
})

describe("simplifyRing", () => {
  it("reduces a dense square outline to its corners", () => {
    const pts: Vec2[] = []
    for (let k = 0; k < 10; k++) pts.push({ x: k, z: 0 })
    for (let k = 0; k < 10; k++) pts.push({ x: 10, z: k })
    for (let k = 10; k > 0; k--) pts.push({ x: k, z: 10 })
    for (let k = 10; k > 0; k--) pts.push({ x: 0, z: k })
    const out = simplifyRing(pts, 0.1)
    expect(out).toHaveLength(4)
    expect(Math.abs(ringArea(out))).toBeCloseTo(100, 6)
  })
})
