/**
 * Heightmap ⇄ greyscale image. A lattice of heights maps to one pixel per sample (black = lowest,
 * white = highest), and an image maps back onto a lattice by bilinear sampling of its luminance
 * (transparent pixels count as black). Pure: pixels are plain RGBA arrays (ImageData-shaped).
 */

import { MAX_TERRAIN_HEIGHT } from "./heightmapBrush"

/** RGBA pixels, row-major, 4 bytes per pixel (the shape of DOM ImageData). */
export interface RgbaPixels {
  width: number
  height: number
  data: Uint8ClampedArray
}

/**
 * One grey pixel per sample, `min` → black and `max` → white (a flat lattice is all black). Row sz of
 * the lattice is image row sz, so the image reads like the top-down view (+x right, +z down).
 */
export function heightsToGrey(
  heights: Float32Array,
  samplesX: number,
  samplesZ: number,
  min: number,
  max: number
): RgbaPixels & { data: Uint8ClampedArray<ArrayBuffer> } {
  const data = new Uint8ClampedArray(samplesX * samplesZ * 4)
  const span = max - min
  for (let i = 0; i < samplesX * samplesZ; i++) {
    const g = span > 1e-9 ? Math.round(((heights[i] - min) / span) * 255) : 0
    data[i * 4] = g
    data[i * 4 + 1] = g
    data[i * 4 + 2] = g
    data[i * 4 + 3] = 255
  }
  return { width: samplesX, height: samplesZ, data }
}

/** Luminance of pixel (x, y) in [0, 1] (Rec. 709), scaled by its alpha. */
function grey(img: RgbaPixels, x: number, y: number): number {
  const i = (y * img.width + x) * 4
  const d = img.data
  return ((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255) * (d[i + 3] / 255)
}

/**
 * Heights for a samplesX × samplesZ lattice from an image stretched over it (corner samples on corner
 * pixel centres): black → `low`, white → `high`, clamped to ±MAX_TERRAIN_HEIGHT.
 */
export function heightsFromGrey(img: RgbaPixels, samplesX: number, samplesZ: number, low: number, high: number): Float32Array {
  const out = new Float32Array(samplesX * samplesZ)
  if (img.width < 1 || img.height < 1) return out.fill(Math.max(-MAX_TERRAIN_HEIGHT, Math.min(MAX_TERRAIN_HEIGHT, low)))
  const fx = samplesX > 1 ? (img.width - 1) / (samplesX - 1) : 0
  const fy = samplesZ > 1 ? (img.height - 1) / (samplesZ - 1) : 0
  for (let sz = 0; sz < samplesZ; sz++) {
    const v = sz * fy
    const y0 = Math.floor(v)
    const y1 = Math.min(img.height - 1, y0 + 1)
    const ty = v - y0
    for (let sx = 0; sx < samplesX; sx++) {
      const u = sx * fx
      const x0 = Math.floor(u)
      const x1 = Math.min(img.width - 1, x0 + 1)
      const tx = u - x0
      const top = grey(img, x0, y0) * (1 - tx) + grey(img, x1, y0) * tx
      const bottom = grey(img, x0, y1) * (1 - tx) + grey(img, x1, y1) * tx
      const g = top * (1 - ty) + bottom * ty
      const h = low + g * (high - low)
      out[sz * samplesX + sx] = Math.max(-MAX_TERRAIN_HEIGHT, Math.min(MAX_TERRAIN_HEIGHT, h))
    }
  }
  return out
}
