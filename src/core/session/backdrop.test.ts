import { describe, expect, it } from "vitest"

import { backdropCellRange, backdropTilePx, MAX_BACKDROP_TILE_PX } from "./backdrop"

const GRID = { cellSize: 5, width: 27, depth: 47 }

describe("backdropTilePx", () => {
  it("is the stored px per cell, rounded and capped", () => {
    expect(backdropTilePx(3780, 135, 5)).toBe(140)
    expect(backdropTilePx(1890, 135, 5)).toBe(70)
    expect(backdropTilePx(3781, 135, 5)).toBe(140)
    expect(backdropTilePx(100_000, 10, 5)).toBe(MAX_BACKDROP_TILE_PX)
  })

  it("is null for sizes that are not a positive finite pixel count", () => {
    expect(backdropTilePx(1, 1000, 5)).toBeNull()
    expect(backdropTilePx(100, 0, 5)).toBeNull()
    expect(backdropTilePx(Number.NaN, 10, 5)).toBeNull()
  })
})

describe("backdropCellRange", () => {
  it("covers the cells a rect overlaps with positive area, clamped to the grid", () => {
    expect(backdropCellRange({ x: 0, z: 0, w: 135, d: 235 }, GRID)).toEqual({ i0: 0, j0: 0, i1: 26, j1: 46 })
    expect(backdropCellRange({ x: 2.5, z: 5, w: 10, d: 5 }, GRID)).toEqual({ i0: 0, j0: 1, i1: 2, j1: 1 })
    expect(backdropCellRange({ x: -50, z: -50, w: 1000, d: 1000 }, GRID)).toEqual({ i0: 0, j0: 0, i1: 26, j1: 46 })
  })

  it("is null for empty rects and rects off the grid", () => {
    expect(backdropCellRange({ x: 200, z: 0, w: 10, d: 10 }, GRID)).toBeNull()
    expect(backdropCellRange({ x: 0, z: 0, w: 0, d: 10 }, GRID)).toBeNull()
    expect(backdropCellRange({ x: -20, z: -20, w: 10, d: 10 }, GRID)).toBeNull()
  })

  it("snaps calibration noise at grid lines instead of adding a sliver cell", () => {
    for (const noise of [-1e-7, 0, 1e-7]) {
      // Edges at k·cellSize ± noise: the same cells whichever side the float lands on.
      expect(backdropCellRange({ x: 10 + noise, z: 20 + noise, w: 30, d: 15 }, GRID), `noise ${noise}`).toEqual({ i0: 2, j0: 4, i1: 7, j1: 6 })
      expect(backdropCellRange({ x: 10, z: 20, w: 30 + noise, d: 15 + noise }, GRID), `noise ${noise}`).toEqual({ i0: 2, j0: 4, i1: 7, j1: 6 })
    }
    // A real overlap of a thousandth of a foot still counts.
    expect(backdropCellRange({ x: 10, z: 20, w: 30.001, d: 15 }, GRID)).toEqual({ i0: 2, j0: 4, i1: 8, j1: 6 })
  })
})
