import { describe, expect, it } from "vitest"

import {
  artExtent,
  cellCoverage,
  createCellMask,
  createGradeMask,
  decodeGrades,
  decodeMask,
  dilateSubcells,
  encodeGrades,
  encodeMask,
  FULL_SUBMASK,
  getCell,
  getSubcell,
  orInto,
  perceivedCells,
  resizeCellMask,
  setCell,
  setSubcells,
} from "./mask"
import { SUBCELLS, type CellMask } from "./types"

describe("CellMask", () => {
  it("round-trips bits and partial sub-cells through base64", () => {
    const m = createCellMask(13, 7)
    setCell(m, 0)
    setCell(m, 12)
    setCell(m, 13 * 7 - 1)
    setSubcells(m, 20, 0b1010)
    const back = decodeMask(encodeMask(m))
    expect(getCell(back, 0)).toBe(true)
    expect(getCell(back, 12)).toBe(true)
    expect(getCell(back, 90)).toBe(true)
    expect(getCell(back, 1)).toBe(false)
    expect(back.partial.get(20)).toBe(0b1010)
    expect(getSubcell(back, 20, 1, 0)).toBe(true)
    expect(getSubcell(back, 20, 0, 0)).toBe(false)
  })

  it("uses LSB-first bit order", () => {
    const m = createCellMask(8, 1)
    setCell(m, 0)
    setCell(m, 3)
    expect(m.bits[0]).toBe(0b1001)
  })

  it("promotes full sub-masks and ORs masks", () => {
    const a = createCellMask(4, 4)
    const b = createCellMask(4, 4)
    setSubcells(a, 5, 0x00ff)
    setSubcells(b, 5, 0xff00)
    setCell(b, 2)
    expect(orInto(a, b)).toBe(true)
    expect(getCell(a, 5)).toBe(true)
    expect(a.partial.has(5)).toBe(false)
    expect(getCell(a, 2)).toBe(true)
    expect(orInto(a, b)).toBe(false)
    expect(cellCoverage(a, 5)).toBe(1)
    setSubcells(a, 6, FULL_SUBMASK >> 12)
    expect(cellCoverage(a, 6)).toBe(0.25)
  })

  it("resizes keeping the overlap", () => {
    const m = createCellMask(4, 3)
    setCell(m, 1 * 4 + 2)
    const r = resizeCellMask(m, 6, 2)
    expect(getCell(r, 1 * 6 + 2)).toBe(true)
    expect(r.width).toBe(6)
  })
})

describe("GradeMask", () => {
  it("round-trips 2-bit grades and partials", () => {
    const g = createGradeMask(5, 5)
    g.grades[0] = 3
    g.grades[7] = 1
    g.grades[24] = 2
    g.partial.set(7, 0x0f0f)
    const back = decodeGrades(encodeGrades(g))
    expect(Array.from(back.grades)).toEqual(Array.from(g.grades))
    expect(back.partial.get(7)).toBe(0x0f0f)
    const cells = perceivedCells(back)
    expect(getCell(cells, 0)).toBe(true)
    expect(getCell(cells, 7)).toBe(false)
    expect(cells.partial.get(7)).toBe(0x0f0f)
  })
})

describe("dilateSubcells / artExtent", () => {
  /** Brute force: sub-cell (x, z) on the 4× lattice is set in the dilation iff some 8-neighbour (or itself) is set. */
  function lattice(m: CellMask): boolean[][] {
    const n = SUBCELLS
    return Array.from({ length: m.depth * n }, (_, z) =>
      Array.from({ length: m.width * n }, (_, x) => getSubcell(m, Math.floor(z / n) * m.width + Math.floor(x / n), x % n, z % n))
    )
  }

  it("matches a brute-force 8-neighbour dilation on random masks", () => {
    let seed = 7
    const r = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32
    for (let trial = 0; trial < 40; trial++) {
      const m = createCellMask(5, 4)
      for (let c = 0; c < 20; c++) {
        const v = r()
        if (v < 0.15) setCell(m, c, true)
        else if (v < 0.45) setSubcells(m, c, Math.floor(r() * 0xffff) & (Math.floor(r() * 0xffff) | 1))
      }
      const src = lattice(m)
      const got = lattice(dilateSubcells(m))
      for (let z = 0; z < src.length; z++) {
        for (let x = 0; x < src[0].length; x++) {
          let want = false
          for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) want ||= src[z + dz]?.[x + dx] ?? false
          expect(got[z][x], `trial ${trial} (${x}, ${z})`).toBe(want)
        }
      }
    }
  })

  it("artExtent: explored cells whole, plus a one sub-cell ring beyond", () => {
    const m = createCellMask(4, 3)
    // Cell (1, 1): only its top-left sub-cell explored.
    setSubcells(m, 1 * 4 + 1, 1)
    const e = artExtent(m)
    expect(getCell(e, 5)).toBe(true)
    // The ring reaches the neighbours' touching sub-cells only.
    expect(e.partial.get(0)).toBe(1 << 15) // cell (0, 0): its bottom-right sub-cell
    expect(e.partial.get(1)).toBe((1 << 12) | (1 << 13)) // cell (1, 0): bottom row, columns 0..1
    expect(e.partial.get(4)).toBe((1 << 3) | (1 << 7)) // cell (0, 1): right column, rows 0..1
    expect(getCell(e, 6) || e.partial.has(6)).toBe(false)
    expect(getCell(e, 9) || e.partial.has(9)).toBe(false)
  })
})
