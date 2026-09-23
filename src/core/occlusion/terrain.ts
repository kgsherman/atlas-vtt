/**
 * Dense terrain sampling for the occlusion builder. Heights follow core/scene/heightmap exactly
 * (same lattice, same triangle split along (sx, sz)→(sx+1, sz+1), 0 outside the lattice), but read
 * from a decoded dense lattice so the Terrain rule (min/max ground over footprints) is cheap.
 */
import { pointInConvexPolygon } from "../geometry/polygon"
import { chunkSamples, decodeChunk, denseHeights, parseChunkKey, sampleSpacing } from "../scene/heightmap"
import type { GridSettings, Heightmap, Level, Vec2 } from "../scene/types"

interface DenseEntry {
  width: number
  depth: number
  resolution: number
  chunks: Record<string, string>
  /** Chunk strings at decode time, to detect in-place mutation of `chunks`. */
  snapshot: Map<string, string>
  samplesX: number
  samplesZ: number
  heights: Float32Array
}

// Keyed by the heightmap object; validated against grid size and the chunk strings.
const denseCache = new WeakMap<Heightmap, DenseEntry>()
// Last lattice decoded per level id: a new heightmap for the same level (a terrain edit) only
// re-decodes the chunks whose strings changed. Correct whatever scene the entry came from, since
// every chunk that differs from its snapshot is rewritten.
const lastByLevel = new Map<string, DenseEntry>()
const LAST_BY_LEVEL_LIMIT = 16

function snapshotMatches(entry: DenseEntry, hm: Heightmap): boolean {
  if (entry.chunks !== hm.chunks) return false
  const keys = Object.keys(hm.chunks)
  if (keys.length !== entry.snapshot.size) return false
  for (const k of keys) if (entry.snapshot.get(k) !== hm.chunks[k]) return false
  return true
}

/** Rewrite the samples owned by one chunk (zeros when the chunk is absent), like denseHeights. */
function writeChunk(heights: Float32Array, samplesX: number, samplesZ: number, key: string, b64: string | undefined, resolution: number): void {
  const n = chunkSamples(resolution)
  const { ci, cj } = parseChunkKey(key)
  if (!Number.isInteger(ci) || !Number.isInteger(cj) || ci < 0 || cj < 0) return
  const arr = b64 === undefined ? null : decodeChunk(b64, resolution)
  for (let lz = 0; lz < n; lz++) {
    const sz = cj * n + lz
    if (sz >= samplesZ) break
    for (let lx = 0; lx < n; lx++) {
      const sx = ci * n + lx
      if (sx >= samplesX) break
      heights[sz * samplesX + sx] = arr ? arr[lz * n + lx] : 0
    }
  }
}

function denseFor(hm: Heightmap, grid: Pick<GridSettings, "width" | "depth">, levelId: string | undefined): DenseEntry {
  const hit = denseCache.get(hm)
  if (hit && hit.width === grid.width && hit.depth === grid.depth && snapshotMatches(hit, hm)) return hit
  const prev = levelId === undefined ? undefined : lastByLevel.get(levelId)
  let entry: DenseEntry
  if (prev && prev.width === grid.width && prev.depth === grid.depth && prev.resolution === hm.resolution) {
    const heights = prev.heights.slice()
    const keys = new Set([...prev.snapshot.keys(), ...Object.keys(hm.chunks)])
    for (const key of keys) {
      const after = Object.hasOwn(hm.chunks, key) ? hm.chunks[key] : undefined
      if (prev.snapshot.get(key) !== after) writeChunk(heights, prev.samplesX, prev.samplesZ, key, after, hm.resolution)
    }
    entry = { ...prev, chunks: hm.chunks, snapshot: new Map(Object.entries(hm.chunks)), heights }
  } else {
    const { samplesX, samplesZ, heights } = denseHeights(hm, grid)
    entry = {
      width: grid.width,
      depth: grid.depth,
      resolution: hm.resolution,
      chunks: hm.chunks,
      snapshot: new Map(Object.entries(hm.chunks)),
      samplesX,
      samplesZ,
      heights,
    }
  }
  denseCache.set(hm, entry)
  if (levelId !== undefined) {
    lastByLevel.delete(levelId)
    lastByLevel.set(levelId, entry)
    if (lastByLevel.size > LAST_BY_LEVEL_LIMIT) {
      const oldest = lastByLevel.keys().next().value
      if (oldest !== undefined) lastByLevel.delete(oldest)
    }
  }
  return entry
}

export interface HeightRange {
  min: number
  max: number
}

/** World-space terrain of one level: Y = elevation + heightmap. */
export class TerrainSampler {
  readonly elevation: number
  /** No heightmap: the ground is the flat plane Y = elevation. */
  readonly flat: boolean
  /** Feet between lattice samples. */
  readonly spacing: number
  readonly samplesX: number
  readonly samplesZ: number
  private readonly heights: Float32Array | null

  /** `level.id`, when given, enables incremental decoding of successive heightmaps of that level. */
  constructor(level: Pick<Level, "elevation" | "heightmap"> & { id?: string }, grid: Pick<GridSettings, "width" | "depth" | "cellSize">) {
    this.elevation = level.elevation
    const hm = level.heightmap
    if (!hm) {
      this.flat = true
      this.spacing = grid.cellSize
      this.samplesX = grid.width + 1
      this.samplesZ = grid.depth + 1
      this.heights = null
      return
    }
    const dense = denseFor(hm, grid, level.id)
    this.flat = false
    this.spacing = sampleSpacing(grid.cellSize, hm.resolution)
    this.samplesX = dense.samplesX
    this.samplesZ = dense.samplesZ
    this.heights = dense.heights
  }

  /** Height of lattice sample (sx, sz) relative to the elevation; 0 outside the lattice. */
  sample(sx: number, sz: number): number {
    const h = this.heights
    if (!h || sx < 0 || sz < 0 || sx >= this.samplesX || sz >= this.samplesZ) return 0
    return h[sz * this.samplesX + sx]
  }

  /** World Y of the terrain at (x, z); equals core/scene levelGround(). */
  heightAt(x: number, z: number): number {
    if (!this.heights) return this.elevation
    const s = this.spacing
    const fx = x / s
    const fz = z / s
    if (fx < 0 || fz < 0) return this.elevation + 0
    const sx = Math.floor(fx)
    const sz = Math.floor(fz)
    const tx = fx - sx
    const tz = fz - sz
    const h00 = this.sample(sx, sz)
    const h11 = this.sample(sx + 1, sz + 1)
    if (tx >= tz) {
      const h10 = this.sample(sx + 1, sz)
      return this.elevation + (h00 + tx * (h10 - h00) + tz * (h11 - h10))
    }
    const h01 = this.sample(sx, sz + 1)
    return this.elevation + (h00 + tz * (h01 - h00) + tx * (h11 - h01))
  }

  /**
   * Exact min/max of the (piecewise-linear) terrain over a convex footprint polygon: extremes of a
   * PL surface over a convex region lie at the polygon's vertices, lattice vertices inside it, or
   * where its edges cross lattice lines (x, z and the triangle diagonals).
   */
  rangeOverPolygon(poly: readonly Vec2[]): HeightRange {
    if (!this.heights) return { min: this.elevation, max: this.elevation }
    let min = Infinity
    let max = -Infinity
    const take = (v: number) => {
      if (v < min) min = v
      if (v > max) max = v
    }
    const s = this.spacing
    let minFx = Infinity
    let minFz = Infinity
    let maxFx = -Infinity
    let maxFz = -Infinity
    const n = poly.length
    for (let k = 0; k < n; k++) {
      const a = poly[k]
      const b = poly[(k + 1) % n]
      take(this.heightAt(a.x, a.z))
      const fax = a.x / s
      const faz = a.z / s
      const fbx = b.x / s
      const fbz = b.z / s
      minFx = Math.min(minFx, fax)
      maxFx = Math.max(maxFx, fax)
      minFz = Math.min(minFz, faz)
      maxFz = Math.max(maxFz, faz)
      // Edge crossings with x = k·s, z = k·s and diagonal fx − fz = k lattice lines.
      const crossings = (va: number, vb: number) => {
        if (va === vb) return
        const lo = Math.ceil(Math.min(va, vb))
        const hi = Math.floor(Math.max(va, vb))
        for (let line = lo; line <= hi; line++) {
          const t = (line - va) / (vb - va)
          take(this.heightAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t))
        }
      }
      crossings(fax, fbx)
      crossings(faz, fbz)
      crossings(fax - faz, fbx - fbz)
    }
    // Outside the lattice (negative coordinates) the terrain is 0.
    if (minFx < 0 || minFz < 0) take(this.elevation)
    const sx0 = Math.max(0, Math.ceil(minFx))
    const sz0 = Math.max(0, Math.ceil(minFz))
    const sx1 = Math.floor(maxFx)
    const sz1 = Math.floor(maxFz)
    for (let sz = sz0; sz <= sz1; sz++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        if (pointInConvexPolygon({ x: sx * s, z: sz * s }, poly, 1e-9)) take(this.elevation + this.sample(sx, sz))
      }
    }
    if (min === Infinity) return { min: this.elevation, max: this.elevation }
    return { min, max }
  }
}
