/**
 * Chunked terrain heights (see Heightmap in ./types). One terrain surface definition is used
 * everywhere (sampling, occlusion heightfields, render meshes): each lattice quad is split into
 * two triangles along the diagonal from sample (sx, sz) to (sx+1, sz+1).
 */
import { HEIGHTMAP_CHUNK_CELLS, type GridSettings, type Heightmap, type Rect } from "./types"

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

/** Samples per chunk edge. */
export function chunkSamples(resolution: number): number {
  return HEIGHTMAP_CHUNK_CELLS * resolution
}

/** Feet between samples. */
export function sampleSpacing(cellSize: number, resolution: number): number {
  return cellSize / resolution
}

/** Sample counts covering the grid extent (inclusive of the far edge). */
export function sampleCounts(grid: Pick<GridSettings, "width" | "depth">, resolution: number): { samplesX: number; samplesZ: number } {
  return { samplesX: grid.width * resolution + 1, samplesZ: grid.depth * resolution + 1 }
}

// Decoded chunks are cached by their base64 string: identical strings decode identically, and
// history keeps many heightmap objects alive, so keying by object identity would not help.
const CHUNK_CACHE_LIMIT = 512
const chunkCache = new Map<string, Float32Array>()

export function decodeChunk(b64: string, resolution: number): Float32Array {
  const hit = chunkCache.get(b64)
  if (hit) {
    chunkCache.delete(b64)
    chunkCache.set(b64, hit)
    return hit
  }
  const n = chunkSamples(resolution)
  const bytes = base64ToBytes(b64)
  const arr = bytes.byteLength === n * n * 4 ? new Float32Array(bytes.buffer, bytes.byteOffset, n * n) : new Float32Array(n * n)
  chunkCache.set(b64, arr)
  if (chunkCache.size > CHUNK_CACHE_LIMIT) {
    const oldest = chunkCache.keys().next().value
    if (oldest !== undefined) chunkCache.delete(oldest)
  }
  return arr
}

export function encodeChunk(samples: Float32Array): string {
  return bytesToBase64(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength))
}

export function chunkKey(ci: number, cj: number): string {
  return `${ci},${cj}`
}

export function parseChunkKey(key: string): { ci: number; cj: number } {
  const [ci, cj] = key.split(",").map(Number)
  return { ci, cj }
}

export function createHeightmap(resolution: Heightmap["resolution"] = 2): Heightmap {
  return { resolution, chunks: {} }
}

/** Height (feet, relative to level elevation) of lattice sample (sx, sz). 0 for missing chunks. */
export function getSample(hm: Heightmap, sx: number, sz: number): number {
  const n = chunkSamples(hm.resolution)
  const ci = Math.floor(sx / n)
  const cj = Math.floor(sz / n)
  const b64 = hm.chunks[chunkKey(ci, cj)]
  if (!b64) return 0
  const arr = decodeChunk(b64, hm.resolution)
  return arr[(sz - cj * n) * n + (sx - ci * n)]
}

/**
 * Terrain height at world x,z (relative to level elevation), interpolated on the triangle
 * split described at the top of this file. 0 outside the lattice or with no heightmap.
 * With `grid`, samples beyond the grid's lattice read 0 even where a boundary chunk still holds
 * padding values (e.g. after the grid shrank), exactly like occlusion's TerrainSampler; every
 * scene-level caller (levelGround) passes it.
 */
export function sampleHeight(hm: Heightmap | null, cellSize: number, x: number, z: number, grid?: Pick<GridSettings, "width" | "depth">): number {
  if (!hm) return 0
  const s = sampleSpacing(cellSize, hm.resolution)
  const fx = x / s
  const fz = z / s
  if (fx < 0 || fz < 0) return 0
  const sx = Math.floor(fx)
  const sz = Math.floor(fz)
  const tx = fx - sx
  const tz = fz - sz
  const maxSx = grid ? grid.width * hm.resolution : Infinity
  const maxSz = grid ? grid.depth * hm.resolution : Infinity
  const at = (i: number, j: number) => (i > maxSx || j > maxSz ? 0 : getSample(hm, i, j))
  const h00 = at(sx, sz)
  const h11 = at(sx + 1, sz + 1)
  if (tx >= tz) {
    const h10 = at(sx + 1, sz)
    return h00 + tx * (h10 - h00) + tz * (h11 - h10)
  }
  const h01 = at(sx, sz + 1)
  return h00 + tz * (h01 - h00) + tx * (h11 - h01)
}

/**
 * The heightmap restricted to a grid's lattice: chunks starting beyond it are dropped and the samples
 * of boundary chunks beyond it (padding) are zeroed; chunks left all-zero are dropped. Returns `hm`
 * itself when nothing changes. Use it whenever the grid shrinks, so stale padding can neither be read
 * nor come back when the grid grows again.
 */
export function cropHeightmapToGrid(hm: Heightmap, grid: Pick<GridSettings, "width" | "depth">): Heightmap {
  const n = chunkSamples(hm.resolution)
  const { samplesX, samplesZ } = sampleCounts(grid, hm.resolution)
  let chunks: Record<string, string> | null = null
  for (const key of Object.keys(hm.chunks)) {
    const { ci, cj } = parseChunkKey(key)
    const x0 = ci * n
    const z0 = cj * n
    if (x0 + n <= samplesX && z0 + n <= samplesZ) continue
    const src = decodeChunk(hm.chunks[key], hm.resolution)
    let changed = x0 >= samplesX || z0 >= samplesZ
    let nonZero = false
    const out = new Float32Array(n * n)
    if (!changed) {
      for (let lz = 0; lz < n; lz++) {
        for (let lx = 0; lx < n; lx++) {
          const v = src[lz * n + lx]
          if (x0 + lx >= samplesX || z0 + lz >= samplesZ) {
            if (v !== 0) changed = true
            continue
          }
          out[lz * n + lx] = v
          if (v !== 0) nonZero = true
        }
      }
    }
    if (!changed) continue
    chunks ??= { ...hm.chunks }
    if (nonZero) chunks[key] = encodeChunk(out)
    else delete chunks[key]
  }
  return chunks ? { resolution: hm.resolution, chunks } : hm
}

/** Dense copy of the whole lattice (samplesX × samplesZ, row-major by z). */
export function denseHeights(hm: Heightmap, grid: Pick<GridSettings, "width" | "depth">): { samplesX: number; samplesZ: number; heights: Float32Array } {
  const { samplesX, samplesZ } = sampleCounts(grid, hm.resolution)
  const heights = new Float32Array(samplesX * samplesZ)
  const n = chunkSamples(hm.resolution)
  for (const [key, b64] of Object.entries(hm.chunks)) {
    const { ci, cj } = parseChunkKey(key)
    const arr = decodeChunk(b64, hm.resolution)
    for (let lz = 0; lz < n; lz++) {
      const sz = cj * n + lz
      if (sz >= samplesZ) break
      for (let lx = 0; lx < n; lx++) {
        const sx = ci * n + lx
        if (sx >= samplesX) break
        heights[sz * samplesX + sx] = arr[lz * n + lx]
      }
    }
  }
  return { samplesX, samplesZ, heights }
}

/**
 * Write a dense lattice back into chunks, re-encoding only the chunks overlapping `dirty`
 * (a world-space rect; omit to rewrite everything). All-zero chunks are dropped.
 */
export function writeHeights(
  hm: Heightmap,
  grid: Pick<GridSettings, "width" | "depth" | "cellSize">,
  dense: Float32Array,
  dirty?: Rect
): Heightmap {
  const res = hm.resolution
  const { samplesX, samplesZ } = sampleCounts(grid, res)
  const n = chunkSamples(res)
  const s = sampleSpacing(grid.cellSize, res)
  const chunksX = Math.ceil(samplesX / n)
  const chunksZ = Math.ceil(samplesZ / n)
  let ci0 = 0
  let cj0 = 0
  let ci1 = chunksX - 1
  let cj1 = chunksZ - 1
  if (dirty) {
    ci0 = Math.max(0, Math.floor(Math.floor(dirty.x / s) / n))
    cj0 = Math.max(0, Math.floor(Math.floor(dirty.z / s) / n))
    ci1 = Math.min(chunksX - 1, Math.floor(Math.ceil((dirty.x + dirty.w) / s) / n))
    cj1 = Math.min(chunksZ - 1, Math.floor(Math.ceil((dirty.z + dirty.d) / s) / n))
  }
  const chunks = { ...hm.chunks }
  for (let cj = cj0; cj <= cj1; cj++) {
    for (let ci = ci0; ci <= ci1; ci++) {
      const arr = new Float32Array(n * n)
      let nonZero = false
      for (let lz = 0; lz < n; lz++) {
        const sz = cj * n + lz
        if (sz >= samplesZ) break
        for (let lx = 0; lx < n; lx++) {
          const sx = ci * n + lx
          if (sx >= samplesX) break
          const v = dense[sz * samplesX + sx]
          arr[lz * n + lx] = v
          if (v !== 0) nonZero = true
        }
      }
      const key = chunkKey(ci, cj)
      if (nonZero) chunks[key] = encodeChunk(arr)
      else delete chunks[key]
    }
  }
  return { resolution: res, chunks }
}

export function heightRange(hm: Heightmap | null): { min: number; max: number } {
  if (!hm) return { min: 0, max: 0 }
  let min = 0
  let max = 0
  for (const b64 of Object.values(hm.chunks)) {
    const arr = decodeChunk(b64, hm.resolution)
    for (let k = 0; k < arr.length; k++) {
      if (arr[k] < min) min = arr[k]
      if (arr[k] > max) max = arr[k]
    }
  }
  return { min, max }
}
