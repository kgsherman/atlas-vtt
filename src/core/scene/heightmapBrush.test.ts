import { describe, expect, it } from "vitest"

import { createHeightmap, getSample, sampleHeight, writeHeights } from "./heightmap"
import {
  applyDab,
  beginStroke,
  brushWeight,
  commitLattice,
  dabPositions,
  latticeFromHeightmap,
  MAX_TERRAIN_HEIGHT,
  sampleLattice,
  unionRect,
  type HeightLattice,
} from "./heightmapBrush"

const grid = { cellSize: 5, width: 16, depth: 16 }

function lattice(fill = 0): HeightLattice {
  const lat = latticeFromHeightmap(createHeightmap(2), grid)
  lat.heights.fill(fill)
  return lat
}

const at = (lat: HeightLattice, sx: number, sz: number) => lat.heights[sz * lat.samplesX + sx]

describe("brushWeight", () => {
  it("falls from 1 at the centre to 0 at the rim", () => {
    for (const f of ["smooth", "linear"] as const) {
      expect(brushWeight(0, 10, f)).toBe(1)
      expect(brushWeight(10, 10, f)).toBe(0)
      expect(brushWeight(12, 10, f)).toBe(0)
      expect(brushWeight(5, 10, f)).toBeCloseTo(0.5)
      expect(brushWeight(3, 10, f)).toBeGreaterThan(brushWeight(6, 10, f))
    }
    expect(brushWeight(9.9, 10, "constant")).toBe(1)
    expect(brushWeight(0, 0)).toBe(0)
  })
})

describe("applyDab", () => {
  it("raises inside the radius only, most at the centre", () => {
    const lat = lattice()
    const dirty = applyDab(lat, { x: 20, z: 20 }, { mode: "raise", radius: 10, strength: 2 })
    expect(at(lat, 8, 8)).toBeCloseTo(2) // centre sample (20, 20)
    expect(at(lat, 10, 8)).toBeGreaterThan(0) // 5 ft away
    expect(at(lat, 10, 8)).toBeLessThan(2)
    expect(at(lat, 12, 8)).toBe(0) // exactly on the rim
    expect(at(lat, 0, 0)).toBe(0)
    // Dirty = changed samples (x 12.5..27.5) grown by one spacing, as a world rect.
    expect(dirty).toEqual({ x: 10, z: 10, w: 20, d: 20 })
  })

  it("lowers symmetrically", () => {
    const lat = lattice(5)
    applyDab(lat, { x: 20, z: 20 }, { mode: "lower", radius: 10, strength: 2 })
    expect(at(lat, 8, 8)).toBeCloseTo(3)
    expect(at(lat, 6, 8)).toBeCloseTo(at(lat, 10, 8))
    expect(at(lat, 8, 6)).toBeCloseTo(at(lat, 8, 10))
  })

  it("flattens towards the target", () => {
    const lat = lattice()
    for (let k = 0; k < lat.heights.length; k++) lat.heights[k] = (k % 7) - 3
    applyDab(lat, { x: 20, z: 20 }, { mode: "flatten", radius: 6, strength: 1, target: 1.5, falloff: "constant" })
    expect(at(lat, 8, 8)).toBe(1.5)
    expect(at(lat, 9, 8)).toBe(1.5)
    // Default target: the height under the dab.
    const lat2 = lattice()
    lat2.heights[8 * lat2.samplesX + 8] = 4
    applyDab(lat2, { x: 20, z: 20 }, { mode: "flatten", radius: 6, strength: 1, falloff: "constant" })
    expect(at(lat2, 9, 8)).toBe(4)
  })

  it("smooths spikes independently of iteration order", () => {
    const lat = lattice()
    lat.heights[8 * lat.samplesX + 8] = 9
    applyDab(lat, { x: 20, z: 20 }, { mode: "smooth", radius: 6, strength: 1, falloff: "constant" })
    // 3×3 average around the spike = 1; its neighbours also average to 1 from the snapshot.
    expect(at(lat, 8, 8)).toBeCloseTo(1)
    expect(at(lat, 9, 8)).toBeCloseTo(1)
    expect(at(lat, 9, 9)).toBeCloseTo(1)
  })

  it("returns null when nothing changes and clamps to the lattice", () => {
    const lat = lattice()
    expect(applyDab(lat, { x: -100, z: -100 }, { mode: "raise", radius: 5, strength: 1 })).toBeNull()
    expect(applyDab(lat, { x: 20, z: 20 }, { mode: "smooth", radius: 5, strength: 1 })).toBeNull()
    const corner = applyDab(lat, { x: 0, z: 0 }, { mode: "raise", radius: 4, strength: 1 })!
    expect(corner.x).toBe(0)
    expect(corner.z).toBe(0)
  })

  it("clamps heights to ±MAX_TERRAIN_HEIGHT", () => {
    const lat = lattice()
    applyDab(lat, { x: 20, z: 20 }, { mode: "raise", radius: 5, strength: 1e6, falloff: "constant" })
    expect(at(lat, 8, 8)).toBe(MAX_TERRAIN_HEIGHT)
  })
})

describe("strokes", () => {
  it("places dabs every `spacing` feet across pointer moves", () => {
    const first = dabPositions({ x: 0, z: 0 }, { x: 3, z: 0 }, 2)
    expect(first.points).toEqual([{ x: 2, z: 0 }])
    expect(first.carry).toBeCloseTo(1)
    const second = dabPositions({ x: 3, z: 0 }, { x: 6, z: 0 }, 2, first.carry)
    expect(second.points.map((p) => p.x)).toEqual([4, 6])
    expect(second.carry).toBeCloseTo(0)
    const none = dabPositions({ x: 0, z: 0 }, { x: 0.5, z: 0 }, 2, 0.5)
    expect(none.points).toEqual([])
    expect(none.carry).toBeCloseTo(1)
  })

  it("accumulates the dirty rect and commits only touched chunks", () => {
    const base = createHeightmap(2)
    const lat = latticeFromHeightmap(base, grid)
    const stroke = beginStroke(lat, { mode: "raise", radius: 5, strength: 1 }, { x: 10, z: 10 })
    stroke.moveTo({ x: 30, z: 10 })
    expect(stroke.dabCount).toBeGreaterThan(5)
    expect(stroke.dirty).not.toBeNull()
    const d = stroke.dirty!
    expect(d.x).toBeLessThanOrEqual(5)
    expect(d.x + d.w).toBeGreaterThanOrEqual(35)
    const hm = commitLattice(base, grid, lat, stroke.dirty)
    // Chunk size 16 samples = 40 ft: the stroke (x 5..35, z 5..15) stays in chunk (0,0).
    expect(Object.keys(hm.chunks)).toEqual(["0,0"])
    expect(sampleHeight(hm, grid.cellSize, 20, 10)).toBeGreaterThan(0.9)
    expect(getSample(hm, 30, 30)).toBe(0)
  })

  it("flatten strokes keep the start height as target", () => {
    const dense = new Float32Array(33 * 33)
    for (let sz = 0; sz < 33; sz++) for (let sx = 0; sx < 33; sx++) dense[sz * 33 + sx] = sx * 0.25
    const lat = latticeFromHeightmap(writeHeights(createHeightmap(2), grid, dense), grid)
    const startHeight = sampleLattice(lat, { x: 20, z: 20 })
    const stroke = beginStroke(lat, { mode: "flatten", radius: 4, strength: 1, falloff: "constant" }, { x: 20, z: 20 })
    stroke.moveTo({ x: 40, z: 20 })
    expect(stroke.brush.target).toBeCloseTo(startHeight)
    expect(sampleLattice(lat, { x: 35, z: 20 })).toBeCloseTo(startHeight)
  })

  it("unions rects", () => {
    expect(unionRect(null, null)).toBeNull()
    expect(unionRect({ x: 0, z: 0, w: 1, d: 1 }, null)).toEqual({ x: 0, z: 0, w: 1, d: 1 })
    expect(unionRect({ x: 0, z: 0, w: 1, d: 1 }, { x: 2, z: -1, w: 1, d: 1 })).toEqual({ x: 0, z: -1, w: 3, d: 2 })
  })
})
