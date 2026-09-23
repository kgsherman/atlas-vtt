import { describe, expect, it } from "vitest"

import { createCellMask, createGradeMask, encodeGrades, encodeMask, setCell, setSubcells } from "@/core/vision/mask"

import { expandLevelMasks, maskLayerBytes, maskSignature, MASK_TEXELS_PER_CELL } from "./maskExpand"

const W = 3
const D = 2
const texW = W * MASK_TEXELS_PER_CELL

function texel(out: Uint8Array, x: number, y: number): [number, number, number, number] {
  const o = (y * texW + x) * 4
  return [out[o], out[o + 1], out[o + 2], out[o + 3]]
}

describe("expandLevelMasks", () => {
  it("fills 4×4 texel blocks for whole cells with grade, perceived, explored and sunlit", () => {
    const grades = createGradeMask(W, D)
    grades.grades[0] = 3 // cell (0,0)
    grades.grades[1 * W + 2] = 2 // cell (2,1)
    const explored = createCellMask(W, D)
    setCell(explored, 0)
    setCell(explored, 1)
    setCell(explored, 1 * W + 2)
    const sunlit = createCellMask(W, D)
    setCell(sunlit, 0)
    const out = new Uint8Array(maskLayerBytes(W, D))
    expandLevelMasks({ perception: encodeGrades(grades), explored: encodeMask(explored), sunlit: encodeMask(sunlit) }, W, D, out)
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(texel(out, x, y)).toEqual([255, 255, 255, 255]) // cell (0,0): grade 3
        expect(texel(out, 4 + x, y)).toEqual([0, 255, 0, 0]) // cell (1,0): explored only
        expect(texel(out, 8 + x, 4 + y)).toEqual([255, 255, 0, 170]) // cell (2,1): grade 2
        expect(texel(out, x, 4 + y)).toEqual([0, 0, 0, 0]) // cell (0,1): nothing
      }
    }
  })

  it("expands partial sub-cells exactly (bit = sz·4 + sx)", () => {
    const grades = createGradeMask(W, D)
    grades.grades[1] = 3
    grades.partial.set(1, 0b0000_0000_0000_0011) // sub-cells (0,0) and (1,0) of cell (1,0)
    const explored = createCellMask(W, D)
    setSubcells(explored, 1, 0b0001_0000_0000_0011) // + sub-cell (0,3)
    const out = new Uint8Array(maskLayerBytes(W, D))
    expandLevelMasks({ perception: encodeGrades(grades), explored: encodeMask(explored) }, W, D, out)
    expect(texel(out, 4, 0)).toEqual([255, 255, 255, 255])
    expect(texel(out, 5, 0)).toEqual([255, 255, 255, 255])
    expect(texel(out, 6, 0)).toEqual([0, 0, 255, 0])
    expect(texel(out, 4, 3)).toEqual([0, 255, 255, 0])
    expect(texel(out, 5, 3)).toEqual([0, 0, 255, 0])
  })

  it("treats a missing sunlit mask as fully sunlit and a missing level as all zero", () => {
    const grades = createGradeMask(W, D)
    const explored = createCellMask(W, D)
    setCell(explored, 0)
    const out = new Uint8Array(maskLayerBytes(W, D))
    expandLevelMasks({ perception: encodeGrades(grades), explored: encodeMask(explored) }, W, D, out)
    expect(texel(out, 0, 0)).toEqual([0, 255, 255, 0])
    expect(texel(out, 11, 7)).toEqual([0, 0, 255, 0])
    out.fill(7)
    expandLevelMasks(undefined, W, D, out)
    expect(out.every((b) => b === 0)).toBe(true)
  })

  it("clips masks whose dimensions differ from the grid", () => {
    const grades = createGradeMask(2, 1)
    grades.grades[1] = 1
    const explored = createCellMask(5, 5)
    setCell(explored, 4 * 5 + 4) // outside the 3×2 grid
    setCell(explored, 1 * 5 + 2) // cell (2,1)
    const out = new Uint8Array(maskLayerBytes(W, D))
    expandLevelMasks({ perception: encodeGrades(grades), explored: encodeMask(explored) }, W, D, out)
    expect(texel(out, 4, 0)).toEqual([255, 0, 255, 85])
    expect(texel(out, 8, 4)).toEqual([0, 255, 255, 0])
  })
})

describe("maskSignature", () => {
  it("changes with content and is stable for equal content", () => {
    const g = createGradeMask(W, D)
    const e = createCellMask(W, D)
    const a = maskSignature({ perception: encodeGrades(g), explored: encodeMask(e) })
    const b = maskSignature({ perception: encodeGrades(g), explored: encodeMask(e) })
    expect(a).toBe(b)
    setCell(e, 2)
    expect(maskSignature({ perception: encodeGrades(g), explored: encodeMask(e) })).not.toBe(a)
    expect(maskSignature(undefined)).toBe("")
  })
})
