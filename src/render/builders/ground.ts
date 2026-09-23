/**
 * Terrain sampling for the visual builders. Same lattice and triangle split as core/scene/heightmap
 * (each lattice quad is split along (sx, sz)→(sx+1, sz+1); 0 outside the lattice), read from a
 * decoded dense lattice. A sampler can also be built from a dense preview lattice (heightmap brush).
 */
import { denseHeights, sampleSpacing } from "@/core/scene/heightmap"
import type { GridSettings, Heightmap, Level, Vec2 } from "@/core/scene/types"

export interface HeightRange {
  min: number
  max: number
}

interface Dense {
  width: number
  depth: number
  chunks: Record<string, string>
  samplesX: number
  samplesZ: number
  heights: Float32Array
  min: number
  max: number
}

// Heightmaps are immutable in practice (immer); the cache is still validated against the chunk
// record identity and the grid size so a mutated or resized document never reads stale data.
const denseCache = new WeakMap<Heightmap, Dense>()

function denseFor(hm: Heightmap, grid: Pick<GridSettings, "width" | "depth">): Dense {
  const hit = denseCache.get(hm)
  if (hit && hit.chunks === hm.chunks && hit.width === grid.width && hit.depth === grid.depth) return hit
  const { samplesX, samplesZ, heights } = denseHeights(hm, grid)
  const { min, max } = arrayRange(heights)
  const d: Dense = { width: grid.width, depth: grid.depth, chunks: hm.chunks, samplesX, samplesZ, heights, min, max }
  denseCache.set(hm, d)
  return d
}

function arrayRange(a: Float32Array): HeightRange {
  let min = 0
  let max = 0
  for (let k = 0; k < a.length; k++) {
    const v = a[k]
    if (v < min) min = v
    if (v > max) max = v
  }
  return { min, max }
}

/** Heightmap resolution implied by a dense lattice length for this grid, or null if none matches. */
export function resolutionForDense(grid: Pick<GridSettings, "width" | "depth">, length: number): 1 | 2 | 4 | null {
  for (const r of [1, 2, 4] as const) {
    if ((grid.width * r + 1) * (grid.depth * r + 1) === length) return r
  }
  return null
}

/** World-space ground of one level: Y = elevation + terrain. */
export class GroundSampler {
  readonly elevation: number
  readonly spacing: number
  readonly samplesX: number
  readonly samplesZ: number
  /** Heights relative to the elevation, row-major by z; null = flat level (no heightmap). */
  readonly heights: Float32Array | null
  /** Range of the relative heights (always includes 0: samples outside the lattice are 0). */
  readonly relMin: number
  readonly relMax: number

  constructor(elevation: number, spacing: number, samplesX: number, samplesZ: number, heights: Float32Array | null, range?: HeightRange) {
    this.elevation = elevation
    this.spacing = spacing
    this.samplesX = samplesX
    this.samplesZ = samplesZ
    this.heights = heights
    const r = range ?? (heights ? arrayRange(heights) : { min: 0, max: 0 })
    this.relMin = r.min
    this.relMax = r.max
  }

  /** Sampler of a level's document terrain (flat when it has no heightmap). */
  static forLevel(level: Pick<Level, "elevation" | "heightmap">, grid: Pick<GridSettings, "width" | "depth" | "cellSize">): GroundSampler {
    const hm = level.heightmap
    if (!hm) return new GroundSampler(level.elevation, grid.cellSize, grid.width + 1, grid.depth + 1, null)
    const d = denseFor(hm, grid)
    return new GroundSampler(level.elevation, sampleSpacing(grid.cellSize, hm.resolution), d.samplesX, d.samplesZ, d.heights, d)
  }

  /** Sampler over a dense preview lattice (see core/scene/heightmap denseHeights); null if the length fits no resolution. */
  static fromDense(level: Pick<Level, "elevation">, grid: Pick<GridSettings, "width" | "depth" | "cellSize">, heights: Float32Array): GroundSampler | null {
    const res = resolutionForDense(grid, heights.length)
    if (res === null) return null
    return new GroundSampler(level.elevation, sampleSpacing(grid.cellSize, res), grid.width * res + 1, grid.depth * res + 1, heights)
  }

  get flat(): boolean {
    return this.heights === null
  }

  /** World Y range of the terrain over the whole lattice. */
  get worldRange(): HeightRange {
    return { min: this.elevation + this.relMin, max: this.elevation + this.relMax }
  }

  /** Relative height of lattice sample (sx, sz); 0 outside the lattice. */
  sample(sx: number, sz: number): number {
    const h = this.heights
    if (!h || sx < 0 || sz < 0 || sx >= this.samplesX || sz >= this.samplesZ) return 0
    return h[sz * this.samplesX + sx]
  }

  /** World Y at (x, z); equals core/scene levelGround(). */
  heightAt(x: number, z: number): number {
    if (!this.heights) return this.elevation
    const s = this.spacing
    const fx = x / s
    const fz = z / s
    if (fx < 0 || fz < 0) return this.elevation
    const sx = Math.floor(fx)
    const sz = Math.floor(fz)
    const tx = fx - sx
    const tz = fz - sz
    const h00 = this.sample(sx, sz)
    const h11 = this.sample(sx + 1, sz + 1)
    if (tx >= tz) {
      const h10 = this.sample(sx + 1, sz)
      return this.elevation + h00 + tx * (h10 - h00) + tz * (h11 - h10)
    }
    const h01 = this.sample(sx, sz + 1)
    return this.elevation + h00 + tz * (h01 - h00) + tx * (h11 - h01)
  }

  /**
   * Exact world-Y range of the piecewise-linear terrain over a convex polygon: the extremes lie at the
   * polygon's vertices, lattice vertices inside it, or where its edges cross lattice lines (x, z and
   * the triangle diagonals). Matches core/occlusion's Terrain rule computation.
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
    if (minFx < 0 || minFz < 0) take(this.elevation)
    const sx0 = Math.max(0, Math.ceil(minFx))
    const sz0 = Math.max(0, Math.ceil(minFz))
    const sx1 = Math.floor(maxFx)
    const sz1 = Math.floor(maxFz)
    for (let sz = sz0; sz <= sz1; sz++) {
      for (let sx = sx0; sx <= sx1; sx++) {
        if (pointInConvex(sx * s, sz * s, poly)) take(this.elevation + this.sample(sx, sz))
      }
    }
    if (min === Infinity) return { min: this.elevation, max: this.elevation }
    return { min, max }
  }
}

/** Point in a convex polygon of either winding (boundary counts as inside). */
function pointInConvex(x: number, z: number, poly: readonly Vec2[]): boolean {
  let sign = 0
  const n = poly.length
  for (let k = 0; k < n; k++) {
    const a = poly[k]
    const b = poly[(k + 1) % n]
    const c = (b.x - a.x) * (z - a.z) - (b.z - a.z) * (x - a.x)
    if (Math.abs(c) < 1e-9) continue
    const s = c > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/** Corners of a rectangle centred on `c` with half extents (hx along `dir`, hz along its left normal). */
export function orientedCorners(c: Vec2, hx: number, hz: number, dir: Vec2 = { x: 1, z: 0 }): Vec2[] {
  const nx = -dir.z
  const nz = dir.x
  return [
    { x: c.x - dir.x * hx - nx * hz, z: c.z - dir.z * hx - nz * hz },
    { x: c.x + dir.x * hx - nx * hz, z: c.z + dir.z * hx - nz * hz },
    { x: c.x + dir.x * hx + nx * hz, z: c.z + dir.z * hx + nz * hz },
    { x: c.x - dir.x * hx + nx * hz, z: c.z - dir.z * hx + nz * hz },
  ]
}
