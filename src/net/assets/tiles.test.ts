import { describe, expect, it } from "vitest"

import { backdropCellRange } from "@/core/session/backdrop"
import { createCellMask, setCell, setSubcells } from "@/core/vision/mask"

import { exploredCellsInRect } from "../player/backdropCanvas"
import { tileSourceRect } from "./tiles"

describe("tile geometry", () => {
  const grid = { cellSize: 5, width: 27, depth: 47 }

  it("lists the grid cells a backdrop covers (core/session/backdrop)", () => {
    expect(backdropCellRange({ x: 0, z: 0, w: 135, d: 235 }, grid)).toEqual({ i0: 0, j0: 0, i1: 26, j1: 46 })
    // Offset by half a cell: overlaps one more column and row, clamped to the grid.
    expect(backdropCellRange({ x: 2.5, z: 2.5, w: 10, d: 5 }, grid)).toEqual({ i0: 0, j0: 0, i1: 2, j1: 1 })
    expect(backdropCellRange({ x: -20, z: -20, w: 10, d: 10 }, grid)).toBeNull()
  })

  it("treats a rect edge within float noise of a grid line as on it (host and player agree)", () => {
    // Calibration noise: edges at k·cellSize ± 1e-7 ft.
    for (const e of [1e-7, -1e-7]) {
      expect(backdropCellRange({ x: 10 + e, z: 20 + e, w: 25, d: 15 }, grid)).toEqual({ i0: 2, j0: 4, i1: 6, j1: 6 })
      expect(backdropCellRange({ x: 10, z: 20, w: 25 + e, d: 15 + e }, grid)).toEqual({ i0: 2, j0: 4, i1: 6, j1: 6 })
    }
    // Every cell around those edges explored: the player waits for exactly the cells the host tiles.
    const m = createCellMask(27, 47)
    for (let j = 3; j <= 7; j++) for (let i = 1; i <= 7; i++) setCell(m, j * 27 + i, true)
    setSubcells(m, 7 * 27 + 8, 0b1)
    for (const e of [1e-7, -1e-7, 0]) {
      for (const rect of [
        { x: 10 + e, z: 20 + e, w: 25, d: 15 },
        { x: 10, z: 20, w: 25 + e, d: 15 + e },
      ]) {
        const r = backdropCellRange(rect, grid)!
        const hostCells: number[] = []
        for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) if (i >= 1 && i <= 7 && j >= 3 && j <= 7) hostCells.push(j * 27 + i)
        expect([...exploredCellsInRect(m, 5, rect)].sort((a, b) => a - b)).toEqual(hostCells)
        expect(hostCells).toHaveLength(5 * 3)
      }
    }
  })

  it("maps a cell to its source pixels", () => {
    const rect = { x: 0, z: 0, w: 135, d: 235 }
    // 3780×6580 px image = 140 px per 5 ft cell.
    expect(tileSourceRect(rect, { width: 3780, height: 6580 }, 5, { i: 2, j: 3 })).toEqual({ sx: 280, sy: 420, sw: 140, sh: 140 })
    // A backdrop placed at an offset: cell (0, 0) starts before the image.
    const off = { x: 2.5, z: 0, w: 135, d: 235 }
    expect(tileSourceRect(off, { width: 3780, height: 6580 }, 5, { i: 0, j: 0 }).sx).toBe(-70)
  })
})
