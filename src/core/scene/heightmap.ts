import type { GridSettings, Heightmap } from "./types"

// Decoded arrays are cached per heightmap object (heightmaps are immutable once in the doc).
const decodeCache = new WeakMap<Heightmap, Float32Array>()

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let k = 0; k < bytes.length; k += chunk) {
    binary += String.fromCharCode(...bytes.subarray(k, k + chunk))
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let k = 0; k < binary.length; k++) out[k] = binary.charCodeAt(k)
  return out
}

export function encodeHeights(heights: Float32Array): string {
  // Float32Array is little-endian on every platform browsers run on.
  return bytesToBase64(new Uint8Array(heights.buffer, heights.byteOffset, heights.byteLength))
}

export function decodeHeights(hm: Heightmap): Float32Array {
  let arr = decodeCache.get(hm)
  if (!arr) {
    const bytes = base64ToBytes(hm.data)
    arr = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
    decodeCache.set(hm, arr)
  }
  return arr
}

export function createHeightmap(grid: GridSettings, resolution = 2): Heightmap {
  const samplesX = grid.width * resolution + 1
  const samplesZ = grid.depth * resolution + 1
  return {
    resolution,
    samplesX,
    samplesZ,
    data: encodeHeights(new Float32Array(samplesX * samplesZ)),
  }
}

export function makeHeightmap(resolution: number, samplesX: number, samplesZ: number, heights: Float32Array): Heightmap {
  return { resolution, samplesX, samplesZ, data: encodeHeights(heights) }
}

/** Bilinear sample of the heightmap at world x,z (feet, relative to level elevation). 0 outside. */
export function sampleHeight(hm: Heightmap | null, cellSize: number, x: number, z: number): number {
  if (!hm) return 0
  const h = decodeHeights(hm)
  const spacing = cellSize / hm.resolution
  const fx = x / spacing
  const fz = z / spacing
  if (fx < 0 || fz < 0 || fx > hm.samplesX - 1 || fz > hm.samplesZ - 1) return 0
  const x0 = Math.min(Math.floor(fx), hm.samplesX - 2)
  const z0 = Math.min(Math.floor(fz), hm.samplesZ - 2)
  const tx = fx - x0
  const tz = fz - z0
  const i00 = z0 * hm.samplesX + x0
  const h00 = h[i00]
  const h10 = h[i00 + 1]
  const h01 = h[i00 + hm.samplesX]
  const h11 = h[i00 + hm.samplesX + 1]
  return (h00 * (1 - tx) + h10 * tx) * (1 - tz) + (h01 * (1 - tx) + h11 * tx) * tz
}

export function heightRange(hm: Heightmap | null): { min: number; max: number } {
  if (!hm) return { min: 0, max: 0 }
  const h = decodeHeights(hm)
  let min = Infinity
  let max = -Infinity
  for (let k = 0; k < h.length; k++) {
    if (h[k] < min) min = h[k]
    if (h[k] > max) max = h[k]
  }
  return { min, max }
}
