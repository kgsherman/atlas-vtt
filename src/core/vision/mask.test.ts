import { describe, expect, it } from "vitest"

import {
  cellCoverage,
  createCellMask,
  createGradeMask,
  decodeGrades,
  decodeMask,
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
