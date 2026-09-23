import { describe, expect, it } from "vitest"

import {
  base64ToBytes,
  bytesToBase64,
  chunkKey,
  chunkSamples,
  createHeightmap,
  decodeChunk,
  denseHeights,
  encodeChunk,
  getSample,
  heightRange,
  parseChunkKey,
  sampleCounts,
  sampleHeight,
  writeHeights,
} from "./heightmap"
import type { Heightmap } from "./types"

const grid = { cellSize: 5, width: 20, depth: 12 }

/** Deterministic smooth-ish lattice for tests. */
function fillDense(res: Heightmap["resolution"], f: (sx: number, sz: number) => number): Float32Array {
  const { samplesX, samplesZ } = sampleCounts(grid, res)
  const out = new Float32Array(samplesX * samplesZ)
  for (let sz = 0; sz < samplesZ; sz++) for (let sx = 0; sx < samplesX; sx++) out[sz * samplesX + sx] = f(sx, sz)
  return out
}

describe("chunk encoding", () => {
  it("round-trips bytes through base64", () => {
    const bytes = new Uint8Array(70000)
    for (let k = 0; k < bytes.length; k++) bytes[k] = (k * 31) & 255
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
  })

  it("round-trips a Float32 chunk", () => {
    const n = chunkSamples(2)
    const arr = new Float32Array(n * n)
    for (let k = 0; k < arr.length; k++) arr[k] = Math.sin(k) * 7.25
    const b64 = encodeChunk(arr)
    expect(base64ToBytes(b64).byteLength).toBe(n * n * 4)
    expect(Array.from(decodeChunk(b64, 2))).toEqual(Array.from(arr))
  })

  it("decodes wrong-length chunks as zeros", () => {
    const arr = decodeChunk(bytesToBase64(new Uint8Array(12)), 1)
    expect(arr.length).toBe(64)
    expect(arr.every((v) => v === 0)).toBe(true)
  })

  it("formats and parses chunk keys", () => {
    expect(chunkKey(3, 11)).toBe("3,11")
    expect(parseChunkKey("3,11")).toEqual({ ci: 3, cj: 11 })
  })
})

describe("dense lattice round trip", () => {
  it("writeHeights → denseHeights reproduces the lattice (every resolution)", () => {
    for (const res of [1, 2, 4] as const) {
      const dense = fillDense(res, (sx, sz) => Math.round(Math.sin(sx * 0.3) * Math.cos(sz * 0.2) * 100) / 10)
      const hm = writeHeights(createHeightmap(res), grid, dense)
      const back = denseHeights(hm, grid)
      expect(back.samplesX).toBe(grid.width * res + 1)
      expect(back.samplesZ).toBe(grid.depth * res + 1)
      expect(Array.from(back.heights)).toEqual(Array.from(dense))
      // getSample agrees with the dense copy.
      expect(getSample(hm, 5, 7)).toBe(dense[7 * back.samplesX + 5])
    }
  })

  it("owns the last lattice row/column in the next chunk index", () => {
    // 20×12 cells at res 1: samples 0..20 × 0..12, chunk size 8 → chunks 0..2 × 0..1.
    const dense = fillDense(1, (sx, sz) => (sx === 20 && sz === 12 ? 4 : 0))
    const hm = writeHeights(createHeightmap(1), grid, dense)
    expect(Object.keys(hm.chunks)).toEqual(["2,1"])
    expect(getSample(hm, 20, 12)).toBe(4)
  })
})

describe("writeHeights dirty chunks", () => {
  it("re-encodes only chunks overlapping the dirty rect", () => {
    const res = 2
    const s = grid.cellSize / res
    const n = chunkSamples(res) // 16 samples = 40 ft per chunk
    const base = fillDense(res, () => 1)
    const hm = writeHeights(createHeightmap(res), grid, base)
    const before = { ...hm.chunks }

    // Change a sample in chunk (0,0) AND one in chunk (2,1), but only declare chunk (0,0) dirty.
    const { samplesX } = sampleCounts(grid, res)
    const edited = base.slice()
    edited[3 * samplesX + 3] = 9
    edited[(n + 2) * samplesX + (2 * n + 2)] = 9
    const dirty = { x: 3 * s, z: 3 * s, w: 0.1, d: 0.1 }
    const next = writeHeights(hm, grid, edited, dirty)

    expect(next.chunks["0,0"]).not.toBe(before["0,0"])
    expect(next.chunks["2,1"]).toBe(before["2,1"])
    for (const key of Object.keys(before)) if (key !== "0,0") expect(next.chunks[key]).toBe(before[key])
    expect(getSample(next, 3, 3)).toBe(9)
    expect(getSample(next, 2 * n + 2, n + 2)).toBe(1)
    // The input heightmap is not mutated.
    expect(hm.chunks).toEqual(before)
  })

  it("a dirty rect on a chunk border touches both chunks", () => {
    const res = 1
    const s = grid.cellSize / res
    const n = chunkSamples(res)
    const { samplesX } = sampleCounts(grid, res)
    const dense = fillDense(res, () => 0)
    dense[2 * samplesX + (n - 1)] = 1
    dense[2 * samplesX + n] = 2
    const hm = writeHeights(createHeightmap(res), grid, dense, { x: (n - 1) * s, z: 2 * s, w: s, d: 0 })
    expect(Object.keys(hm.chunks).sort()).toEqual(["0,0", "1,0"])
  })

  it("drops chunks that become all zero", () => {
    const res = 1
    const dense = fillDense(res, (sx, sz) => (sx < 8 && sz < 8 ? 2 : 0))
    const hm = writeHeights(createHeightmap(res), grid, dense)
    expect(Object.keys(hm.chunks)).toEqual(["0,0"])
    const cleared = writeHeights(hm, grid, new Float32Array(dense.length), { x: 0, z: 0, w: 10, d: 10 })
    expect(cleared.chunks).toEqual({})
  })
})

describe("sampleHeight", () => {
  const res = 2
  const s = grid.cellSize / res
  const f = (sx: number, sz: number) => ((sx * 7 + sz * 13) % 11) * 0.5
  const hm = writeHeights(createHeightmap(res), grid, fillDense(res, f))

  it("returns lattice samples exactly at lattice points", () => {
    for (const [sx, sz] of [[0, 0], [5, 3], [15, 16], [16, 16], [17, 15]]) {
      expect(sampleHeight(hm, grid.cellSize, sx * s, sz * s)).toBeCloseTo(f(sx, sz), 5)
    }
  })

  it("interpolates on the (sx,sz)→(sx+1,sz+1) triangle split", () => {
    const [sx, sz] = [4, 6]
    const h00 = f(sx, sz)
    const h10 = f(sx + 1, sz)
    const h01 = f(sx, sz + 1)
    const h11 = f(sx + 1, sz + 1)
    // Lower-right triangle (tx ≥ tz): h00, h10, h11.
    expect(sampleHeight(hm, grid.cellSize, (sx + 0.75) * s, (sz + 0.25) * s)).toBeCloseTo(h00 + 0.75 * (h10 - h00) + 0.25 * (h11 - h10), 5)
    // Upper-left triangle (tx < tz): h00, h01, h11.
    expect(sampleHeight(hm, grid.cellSize, (sx + 0.25) * s, (sz + 0.75) * s)).toBeCloseTo(h00 + 0.75 * (h01 - h00) + 0.25 * (h11 - h01), 5)
    // Along the diagonal both triangles agree.
    expect(sampleHeight(hm, grid.cellSize, (sx + 0.5) * s, (sz + 0.5) * s)).toBeCloseTo((h00 + h11) / 2, 5)
  })

  it("is continuous across chunk borders", () => {
    const n = chunkSamples(res)
    const border = n * s // x = 40 ft is the first sample column of chunk 1
    for (const z of [3.3, 17.9, 39.99, 40, 41.2]) {
      const left = sampleHeight(hm, grid.cellSize, border - 1e-7, z)
      const right = sampleHeight(hm, grid.cellSize, border + 1e-7, z)
      expect(Math.abs(left - right)).toBeLessThan(1e-4)
      const below = sampleHeight(hm, grid.cellSize, z, border - 1e-7)
      const above = sampleHeight(hm, grid.cellSize, z, border + 1e-7)
      expect(Math.abs(below - above)).toBeLessThan(1e-4)
    }
  })

  it("is 0 without a heightmap or before the lattice origin", () => {
    expect(sampleHeight(null, 5, 10, 10)).toBe(0)
    expect(sampleHeight(hm, 5, -1, 10)).toBe(0)
  })

  it("reports the height range", () => {
    expect(heightRange(null)).toEqual({ min: 0, max: 0 })
    expect(heightRange(hm)).toEqual({ min: 0, max: 5 })
  })
})
