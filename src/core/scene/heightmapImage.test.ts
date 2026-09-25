import { describe, expect, it } from "vitest"

import { MAX_TERRAIN_HEIGHT } from "./heightmapBrush"
import { heightsFromGrey, heightsToGrey, type RgbaPixels } from "./heightmapImage"

function greyImage(width: number, height: number, values: number[], alpha = 255): RgbaPixels {
  const data = new Uint8ClampedArray(width * height * 4)
  values.forEach((v, i) => data.set([v, v, v, alpha], i * 4))
  return { width, height, data }
}

describe("heightsToGrey", () => {
  it("maps min to black and max to white, one opaque pixel per sample", () => {
    const img = heightsToGrey(new Float32Array([0, 5, 10, 2.5]), 2, 2, 0, 10)
    expect(img.width).toBe(2)
    expect(img.height).toBe(2)
    expect([img.data[0], img.data[4], img.data[8], img.data[12]]).toEqual([0, 128, 255, 64])
    expect(img.data[3]).toBe(255)
    expect(img.data[5]).toBe(img.data[4])
  })

  it("draws a flat lattice black", () => {
    const img = heightsToGrey(new Float32Array([3, 3, 3]), 3, 1, 3, 3)
    expect(Array.from(img.data.filter((_, i) => i % 4 === 0))).toEqual([0, 0, 0])
  })
})

describe("heightsFromGrey", () => {
  it("maps black to low and white to high on a same-size lattice", () => {
    const h = heightsFromGrey(greyImage(2, 1, [0, 255]), 2, 1, -2, 8)
    expect(Array.from(h)).toEqual([-2, 8])
  })

  it("interpolates bilinearly when the lattice is finer than the image", () => {
    const h = heightsFromGrey(greyImage(2, 1, [0, 255]), 3, 2, 0, 10)
    expect(Array.from(h)).toEqual([0, 5, 10, 0, 5, 10])
  })

  it("treats transparent pixels as black", () => {
    const h = heightsFromGrey(greyImage(1, 1, [255], 0), 2, 2, 1, 9)
    expect(Array.from(h)).toEqual([1, 1, 1, 1])
  })

  it("clamps to the terrain height limit", () => {
    const h = heightsFromGrey(greyImage(1, 1, [255]), 1, 1, 0, MAX_TERRAIN_HEIGHT * 2)
    expect(h[0]).toBe(MAX_TERRAIN_HEIGHT)
  })

  it("round-trips a lattice through the preview image within one grey step", () => {
    const heights = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7, 8])
    const back = heightsFromGrey(heightsToGrey(heights, 3, 3, 0, 8), 3, 3, 0, 8)
    back.forEach((v, i) => expect(Math.abs(v - heights[i])).toBeLessThanOrEqual(8 / 255))
  })
})
