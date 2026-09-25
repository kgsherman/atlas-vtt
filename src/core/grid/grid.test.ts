import { describe, expect, it } from "vitest"

import type { Cell, GridSettings } from "../scene/types"
import {
  cellCenter,
  cellFromIndex,
  cellIndex,
  cellOf,
  cellsInCircle,
  cellsInConvexPolygon,
  cellsInRect,
  distanceToCell,
  legCells,
  pathDistance,
  rulerDistance,
  segmentCellIntervals,
  snapPoint,
  stepCost,
  supercoverCells,
} from "./grid"

const grid: GridSettings = { cellSize: 5, width: 10, depth: 8, diagonalRule: "5-5-5", visionOrigin: "square" }

const key = (c: Cell) => `${c.i},${c.j}`
const keys = (cells: Cell[]) => cells.map(key).sort()

/** Brute-force reference: sample the segment densely and collect the (closed) cells of each sample. */
function bruteSupercover(g: GridSettings, a: { x: number; z: number }, b: { x: number; z: number }): string[] {
  const out = new Set<string>()
  const steps = 4000
  for (let k = 0; k <= steps; k++) {
    const t = k / steps
    const x = a.x + (b.x - a.x) * t
    const z = a.z + (b.z - a.z) * t
    const is = [Math.floor(x / g.cellSize)]
    const js = [Math.floor(z / g.cellSize)]
    if (Number.isInteger(x / g.cellSize)) is.push(x / g.cellSize - 1)
    if (Number.isInteger(z / g.cellSize)) js.push(z / g.cellSize - 1)
    for (const i of is) for (const j of js) if (i >= 0 && j >= 0 && i < g.width && j < g.depth) out.add(`${i},${j}`)
  }
  return [...out].sort()
}

describe("basic cell math", () => {
  it("maps points to half-open cells", () => {
    expect(cellOf(grid, { x: 0, z: 0 })).toEqual({ i: 0, j: 0 })
    expect(cellOf(grid, { x: 4.999, z: 5 })).toEqual({ i: 0, j: 1 })
    expect(cellOf(grid, { x: -0.1, z: 12 })).toEqual({ i: -1, j: 2 })
    expect(cellCenter(grid, { i: 2, j: 3 })).toEqual({ x: 12.5, z: 17.5 })
  })

  it("round-trips cell indices", () => {
    for (let k = 0; k < grid.width * grid.depth; k++) expect(cellIndex(grid, cellFromIndex(grid, k))).toBe(k)
  })

  it("snaps points", () => {
    expect(snapPoint(grid, { x: 6, z: 9 }, "center")).toEqual({ x: 7.5, z: 7.5 })
    expect(snapPoint(grid, { x: 6, z: 9 }, "vertex")).toEqual({ x: 5, z: 10 })
    expect(snapPoint(grid, { x: 6, z: 9 }, "half")).toEqual({ x: 5, z: 10 })
    expect(snapPoint(grid, { x: 6.2, z: 9.1 }, "free")).toEqual({ x: 6.2, z: 9.1 })
  })

  it("measures paths with each diagonal rule", () => {
    const diag = [
      { i: 0, j: 0 },
      { i: 1, j: 1 },
      { i: 2, j: 2 },
      { i: 3, j: 3 },
    ]
    expect(pathDistance(grid, diag, "5-5-5")).toBe(15)
    expect(pathDistance(grid, diag, "5-10-5")).toBe(20)
    expect(pathDistance(grid, diag, "euclidean")).toBeCloseTo(15 * Math.SQRT2)
    expect(stepCost(grid, { i: 0, j: 0 }, { i: 0, j: 1 }, 0)).toBe(5)
    // Level switches (same cell twice) are free.
    expect(pathDistance(grid, [{ i: 0, j: 0 }, { i: 0, j: 0 }, { i: 1, j: 0 }])).toBe(5)
  })

  it("rulers: king-move legs, the diagonal rule over the whole route, or euclidean when free", () => {
    expect(legCells({ i: 0, j: 0 }, { i: 3, j: 1 })).toEqual([
      { i: 1, j: 1 },
      { i: 2, j: 1 },
      { i: 3, j: 1 },
    ])
    expect(legCells({ i: 2, j: 2 }, { i: 2, j: 2 })).toEqual([])
    const g = (diagonalRule: GridSettings["diagonalRule"]): GridSettings => ({ ...grid, diagonalRule })
    // (0,0) → (5,2): 2 diagonals + 3 straight.
    const pts = [
      { x: 2.5, z: 2.5 },
      { x: 27.5, z: 12.5 },
    ]
    expect(rulerDistance(g("5-5-5"), pts)).toBe(25)
    expect(rulerDistance(g("5-10-5"), pts)).toBe(30)
    // The diagonal count carries across legs: one diagonal in each of two legs is 5 + 10 under 5-10-5.
    const legs = [
      { x: 2.5, z: 2.5 },
      { x: 7.5, z: 7.5 },
      { x: 12.5, z: 12.5 },
    ]
    expect(rulerDistance(g("5-10-5"), legs)).toBe(15)
    expect(rulerDistance(g("euclidean"), legs)).toBeCloseTo(10 * Math.SQRT2)
    expect(rulerDistance(grid, [{ x: 0, z: 0 }, { x: 3, z: 4 }, { x: 3, z: 10 }], true)).toBe(11)
    expect(rulerDistance(grid, [{ x: 0, z: 0 }])).toBe(0)
  })

  it("lists cells overlapped by a rect (positive area)", () => {
    expect(keys(cellsInRect(grid, { x: 0, z: 0, w: 5, d: 5 }))).toEqual(["0,0"])
    expect(keys(cellsInRect(grid, { x: 2, z: 2, w: 5, d: 1 }))).toEqual(["0,0", "1,0"])
  })
})

describe("supercoverCells", () => {
  it("covers an axis-aligned segment inside a row", () => {
    expect(keys(supercoverCells(grid, { x: 2.5, z: 2.5 }, { x: 17.5, z: 2.5 }))).toEqual(["0,0", "1,0", "2,0", "3,0"])
  })

  it("includes all four cells around a corner crossed exactly", () => {
    expect(keys(supercoverCells(grid, { x: 2.5, z: 2.5 }, { x: 7.5, z: 7.5 }))).toEqual(["0,0", "0,1", "1,0", "1,1"])
  })

  it("is robust to floating-point error near corners", () => {
    // 0.1 + 0.2 style noise: the segment passes (numerically) a hair beside the corner (5, 5).
    const a = { x: 0.1 + 0.2, z: 0.3 }
    const b = { x: 9.7, z: 9.7 + 1e-12 }
    expect(keys(supercoverCells(grid, a, b))).toEqual(["0,0", "0,1", "1,0", "1,1"])
  })

  it("covers both sides of a segment lying on a grid line", () => {
    expect(keys(supercoverCells(grid, { x: 5, z: 1 }, { x: 5, z: 4 }))).toEqual(["0,0", "1,0"])
  })

  it("handles degenerate (point) segments", () => {
    expect(keys(supercoverCells(grid, { x: 7, z: 7 }, { x: 7, z: 7 }))).toEqual(["1,1"])
    expect(keys(supercoverCells(grid, { x: 10, z: 10 }, { x: 10, z: 10 }))).toEqual(["1,1", "1,2", "2,1", "2,2"])
  })

  it("clips to the grid unless asked not to", () => {
    expect(keys(supercoverCells(grid, { x: -7, z: 2 }, { x: 3, z: 2 }))).toEqual(["0,0"])
    expect(keys(supercoverCells(grid, { x: -7, z: 2 }, { x: 3, z: 2 }, { clip: false }))).toEqual(["-1,0", "-2,0", "0,0"])
  })

  it("matches a brute-force sampler on random segments", () => {
    let seed = 7
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let n = 0; n < 200; n++) {
      // Mix of generic points and exact lattice points (the hard cases).
      const pt = () => (rand() < 0.3 ? { x: Math.round(rand() * 10) * 5, z: Math.round(rand() * 8) * 5 } : { x: rand() * 50, z: rand() * 40 })
      const a = pt()
      const b = pt()
      const got = keys(supercoverCells(grid, a, b))
      const want = bruteSupercover(grid, a, b)
      // Dense sampling can only miss cells touched in a sliver; it never finds extra ones.
      for (const c of want) expect(got).toContain(c)
      for (const c of got) {
        const [i, j] = c.split(",").map(Number)
        // Every reported cell really is within tolerance of the segment.
        const dx = b.x - a.x
        const dz = b.z - a.z
        const len2 = dx * dx + dz * dz
        let best = Infinity
        for (let k = 0; k <= 200; k++) {
          const t = len2 === 0 ? 0 : k / 200
          best = Math.min(best, distanceToCell(grid, { x: a.x + dx * t, z: a.z + dz * t }, { i, j }))
        }
        expect(best).toBeLessThan(0.3)
      }
    }
  })
})

describe("segmentCellIntervals", () => {
  it("returns ordered parametric ranges", () => {
    const iv = segmentCellIntervals(grid, { x: 2.5, z: 2.5 }, { x: 12.5, z: 2.5 })
    expect(iv.map((v) => key(v.cell))).toEqual(["0,0", "1,0", "2,0"])
    expect(iv[0].t0).toBeCloseTo(0)
    expect(iv[0].t1).toBeCloseTo(0.25)
    expect(iv[1].t0).toBeCloseTo(0.25)
    expect(iv[1].t1).toBeCloseTo(0.75)
    expect(iv[2].t1).toBeCloseTo(1)
  })

  it("reports corner touches as degenerate intervals", () => {
    const iv = segmentCellIntervals(grid, { x: 2.5, z: 2.5 }, { x: 7.5, z: 7.5 })
    const byCell = new Map(iv.map((v) => [key(v.cell), v]))
    expect(byCell.get("0,1")!.t1 - byCell.get("0,1")!.t0).toBeLessThan(1e-5)
    expect(byCell.get("1,0")!.t1 - byCell.get("1,0")!.t0).toBeLessThan(1e-5)
    expect(byCell.get("0,0")!.t1).toBeCloseTo(0.5)
    expect(byCell.get("1,1")!.t0).toBeCloseTo(0.5)
    // Positive-length cells only:
    expect(iv.filter((v) => v.t1 - v.t0 > 1e-4).map((v) => key(v.cell))).toEqual(["0,0", "1,1"])
  })

  it("covers the union [0, 1] for segments inside the grid", () => {
    const iv = segmentCellIntervals(grid, { x: 1, z: 3 }, { x: 44, z: 37 })
    let reach = 0
    for (const v of iv) {
      expect(v.t0).toBeLessThanOrEqual(reach + 1e-6)
      reach = Math.max(reach, v.t1)
    }
    expect(reach).toBeCloseTo(1)
  })

  it("inflates a wall-like strip by its half width", () => {
    // Wall along z = 9.6 (0.4 ft short of the grid line z = 10), thickness 1: its strip crosses into row 2.
    const thin = segmentCellIntervals(grid, { x: 2, z: 9.6 }, { x: 8, z: 9.6 })
    expect(keys(thin.map((v) => v.cell))).toEqual(["0,1", "1,1"])
    const thick = segmentCellIntervals(grid, { x: 2, z: 9.6 }, { x: 8, z: 9.6 }, { halfWidth: 0.5 })
    expect(keys(thick.map((v) => v.cell))).toEqual(["0,1", "0,2", "1,1", "1,2"])
    const c02 = thick.find((v) => key(v.cell) === "0,2")!
    expect(c02.t0).toBeCloseTo(0)
    expect(c02.t1).toBeCloseTo(0.5)
  })

  it("inflates diagonal strips perpendicular to the segment only (no end caps)", () => {
    const iv = segmentCellIntervals(grid, { x: 12.5, z: 12.5 }, { x: 22.5, z: 22.5 }, { halfWidth: 1 })
    for (const v of iv) {
      expect(v.t0).toBeGreaterThanOrEqual(0)
      expect(v.t1).toBeLessThanOrEqual(1)
    }
    // Cell (1,1) lies before the segment start (beyond the strip's end): not reported.
    expect(iv.some((v) => key(v.cell) === "1,1")).toBe(false)
    expect(iv.some((v) => key(v.cell) === "3,2")).toBe(true)
  })
})

describe("cellsInCircle / cellsInConvexPolygon", () => {
  it("returns cells whose square touches the disk", () => {
    // r = 2.5 around a cell centre reaches the 4 orthogonal neighbours' edges but not the diagonals.
    expect(keys(cellsInCircle(grid, { x: 12.5, z: 12.5 }, 2.5))).toEqual(["1,2", "2,1", "2,2", "2,3", "3,2"])
    expect(keys(cellsInCircle(grid, { x: 12.5, z: 12.5 }, 2))).toEqual(["2,2"])
    expect(cellsInCircle(grid, { x: 12.5, z: 12.5 }, -1)).toEqual([])
  })

  it("agrees with a brute-force distance test", () => {
    for (const [cx, cz, r] of [[13, 17, 7.3], [0, 0, 11], [49, 39, 6], [25, 20, 100]] as const) {
      const got = keys(cellsInCircle(grid, { x: cx, z: cz }, r))
      const want: string[] = []
      for (let j = 0; j < grid.depth; j++) {
        for (let i = 0; i < grid.width; i++) if (distanceToCell(grid, { x: cx, z: cz }, { i, j }) <= r) want.push(`${i},${j}`)
      }
      expect(got).toEqual(want.sort())
    }
  })

  it("rasterises rotated rectangles", () => {
    const diamond = [
      { x: 12.5, z: 8 },
      { x: 17, z: 12.5 },
      { x: 12.5, z: 17 },
      { x: 8, z: 12.5 },
    ]
    expect(keys(cellsInConvexPolygon(grid, diamond))).toEqual(["1,2", "2,1", "2,2", "2,3", "3,2"])
    // Grown so its edges pass exactly through the corners (10,10), (15,10)…: the diagonal cells touch.
    const touching = diamond.map((p) => ({ x: 12.5 + (p.x - 12.5) * (5 / 4.5), z: 12.5 + (p.z - 12.5) * (5 / 4.5) }))
    expect(cellsInConvexPolygon(grid, touching)).toHaveLength(9)
  })
})
