/**
 * Pure heightmap brush operations on a dense lattice (see denseHeights / writeHeights in
 * ./heightmap). The editor decodes the level's heights once on pointerdown, paints dabs into the
 * lattice while dragging (previewing through Engine.previewTerrain with the returned dirty rects),
 * and commits once on pointerup with writeHeights(…, dirty) so only touched chunks are re-encoded.
 */
import { denseHeights, sampleSpacing, writeHeights } from "./heightmap"
import type { GridSettings, Heightmap, Rect, Vec2 } from "./types"

/** Terrain heights are clamped to ±this many feet (relative to the level elevation). The schema enforces it too. */
export const MAX_TERRAIN_HEIGHT = 500

export type BrushMode = "raise" | "lower" | "smooth" | "flatten"
export type BrushFalloff = "smooth" | "linear" | "constant"

/** A dense, mutable height lattice (samples at (sx·spacing, sz·spacing)). */
export interface HeightLattice {
  samplesX: number
  samplesZ: number
  /** Row-major by z: index = sz·samplesX + sx. Feet relative to the level elevation. Mutated in place. */
  heights: Float32Array
  /** Feet between samples (cellSize / resolution). */
  spacing: number
}

export interface BrushSettings {
  mode: BrushMode
  /** Radius in feet (samples strictly inside are affected). */
  radius: number
  /**
   * raise / lower: feet added / removed at the brush centre per dab.
   * smooth / flatten: blend factor towards the local average / target at the centre per dab (0..1).
   */
  strength: number
  /** flatten: target height (feet, relative to level elevation). Default: the height under the dab (or the stroke start). */
  target?: number
  /** Weight profile from the centre (1) to the rim (0). Default "smooth". */
  falloff?: BrushFalloff
}

/** Decode a level heightmap into a lattice the brush can paint into. */
export function latticeFromHeightmap(hm: Heightmap, grid: Pick<GridSettings, "width" | "depth" | "cellSize">): HeightLattice {
  const { samplesX, samplesZ, heights } = denseHeights(hm, grid)
  return { samplesX, samplesZ, heights, spacing: sampleSpacing(grid.cellSize, hm.resolution) }
}

/** Write a painted lattice back, re-encoding only the chunks overlapping `dirty` (omit to rewrite all). */
export function commitLattice(hm: Heightmap, grid: Pick<GridSettings, "width" | "depth" | "cellSize">, lattice: HeightLattice, dirty?: Rect | null): Heightmap {
  return writeHeights(hm, grid, lattice.heights, dirty ?? undefined)
}

/** Brush weight at `distance` from the centre: 1 at the centre, 0 at and beyond the radius. */
export function brushWeight(distance: number, radius: number, falloff: BrushFalloff = "smooth"): number {
  if (!(radius > 0) || distance >= radius) return 0
  const t = Math.max(0, distance / radius)
  switch (falloff) {
    case "constant":
      return 1
    case "linear":
      return 1 - t
    case "smooth":
      // 1 − smoothstep(t): zero slope at the centre and at the rim, so repeated dabs stay round.
      return 1 - t * t * (3 - 2 * t)
  }
}

/** Height of the lattice surface at world x,z, using the same triangle split as heightmap.sampleHeight. */
export function sampleLattice(lattice: HeightLattice, p: Vec2): number {
  const { samplesX, samplesZ, heights, spacing } = lattice
  const fx = Math.min(Math.max(p.x / spacing, 0), samplesX - 1)
  const fz = Math.min(Math.max(p.z / spacing, 0), samplesZ - 1)
  const sx = Math.min(Math.floor(fx), samplesX - 2)
  const sz = Math.min(Math.floor(fz), samplesZ - 2)
  if (sx < 0 || sz < 0) return heights[0] ?? 0
  const tx = fx - sx
  const tz = fz - sz
  const at = (x: number, z: number) => heights[z * samplesX + x]
  const h00 = at(sx, sz)
  const h11 = at(sx + 1, sz + 1)
  if (tx >= tz) {
    const h10 = at(sx + 1, sz)
    return h00 + tx * (h10 - h00) + tz * (h11 - h10)
  }
  const h01 = at(sx, sz + 1)
  return h00 + tz * (h01 - h00) + tx * (h11 - h01)
}

export function unionRect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b
  if (!b) return a
  const x0 = Math.min(a.x, b.x)
  const z0 = Math.min(a.z, b.z)
  const x1 = Math.max(a.x + a.w, b.x + b.w)
  const z1 = Math.max(a.z + a.d, b.z + b.d)
  return { x: x0, z: z0, w: x1 - x0, d: z1 - z0 }
}

const clampHeight = (h: number) => Math.max(-MAX_TERRAIN_HEIGHT, Math.min(MAX_TERRAIN_HEIGHT, h))

/**
 * Apply one dab at `center` (world feet). Mutates `lattice.heights` and returns the world rect whose
 * SURFACE changed (bounding box of the modified samples grown by one sample spacing, because every
 * lattice triangle touching a modified sample moves), clamped to the lattice; null if nothing changed.
 * Non-finite centres, radii or strengths change nothing (null); a non-finite flatten target means
 * "the height under the centre", like an absent one.
 */
export function applyDab(lattice: HeightLattice, center: Vec2, brush: BrushSettings): Rect | null {
  const { samplesX, samplesZ, heights, spacing } = lattice
  const r = brush.radius
  if (!Number.isFinite(center.x) || !Number.isFinite(center.z) || !Number.isFinite(r) || !Number.isFinite(brush.strength)) return null
  if (!(r > 0) || !(brush.strength > 0) || samplesX < 1 || samplesZ < 1) return null
  const falloff = brush.falloff ?? "smooth"
  const sx0 = Math.max(0, Math.ceil((center.x - r) / spacing))
  const sx1 = Math.min(samplesX - 1, Math.floor((center.x + r) / spacing))
  const sz0 = Math.max(0, Math.ceil((center.z - r) / spacing))
  const sz1 = Math.min(samplesZ - 1, Math.floor((center.z + r) / spacing))
  if (sx0 > sx1 || sz0 > sz1) return null

  // Smoothing reads neighbours: take a snapshot (with a one-sample ring) so the result does not
  // depend on iteration order.
  let snapshot: Float32Array | null = null
  let snapX0 = 0
  let snapZ0 = 0
  let snapW = 0
  if (brush.mode === "smooth") {
    snapX0 = Math.max(0, sx0 - 1)
    snapZ0 = Math.max(0, sz0 - 1)
    const snapX1 = Math.min(samplesX - 1, sx1 + 1)
    const snapZ1 = Math.min(samplesZ - 1, sz1 + 1)
    snapW = snapX1 - snapX0 + 1
    snapshot = new Float32Array(snapW * (snapZ1 - snapZ0 + 1))
    for (let z = snapZ0; z <= snapZ1; z++) {
      snapshot.set(heights.subarray(z * samplesX + snapX0, z * samplesX + snapX1 + 1), (z - snapZ0) * snapW)
    }
  }
  const snapAt = (x: number, z: number) => snapshot![(z - snapZ0) * snapW + (x - snapX0)]
  const target = brush.mode === "flatten" ? clampHeight(brush.target !== undefined && Number.isFinite(brush.target) ? brush.target : sampleLattice(lattice, center)) : 0

  let dx0 = Infinity
  let dz0 = Infinity
  let dx1 = -Infinity
  let dz1 = -Infinity
  for (let sz = sz0; sz <= sz1; sz++) {
    for (let sx = sx0; sx <= sx1; sx++) {
      const w = brushWeight(Math.hypot(sx * spacing - center.x, sz * spacing - center.z), r, falloff)
      if (w <= 0) continue
      const k = sz * samplesX + sx
      const h = heights[k]
      let next = h
      switch (brush.mode) {
        case "raise":
          next = h + brush.strength * w
          break
        case "lower":
          next = h - brush.strength * w
          break
        case "flatten":
          next = h + (target - h) * Math.min(1, brush.strength * w)
          break
        case "smooth": {
          // 3×3 box average over the samples that exist (edges average fewer neighbours).
          let sum = 0
          let count = 0
          for (let z = Math.max(0, sz - 1); z <= Math.min(samplesZ - 1, sz + 1); z++) {
            for (let x = Math.max(0, sx - 1); x <= Math.min(samplesX - 1, sx + 1); x++) {
              sum += snapAt(x, z)
              count++
            }
          }
          next = h + (sum / count - h) * Math.min(1, brush.strength * w)
          break
        }
      }
      next = Math.fround(clampHeight(next))
      if (next === h) continue
      heights[k] = next
      if (sx < dx0) dx0 = sx
      if (sx > dx1) dx1 = sx
      if (sz < dz0) dz0 = sz
      if (sz > dz1) dz1 = sz
    }
  }
  if (dx0 > dx1) return null
  const x0 = Math.max(0, dx0 - 1) * spacing
  const z0 = Math.max(0, dz0 - 1) * spacing
  const x1 = Math.min(samplesX - 1, dx1 + 1) * spacing
  const z1 = Math.min(samplesZ - 1, dz1 + 1) * spacing
  return { x: x0, z: z0, w: x1 - x0, d: z1 - z0 }
}

/** Default distance between dabs along a stroke: a quarter of the radius (at least 0.25 ft). */
export function defaultDabSpacing(radius: number): number {
  return Math.max(0.25, radius * 0.25)
}

/**
 * Evenly spaced dab positions along from→to. `carry` is the distance already travelled since the
 * last dab (returned for the next segment), so a stroke made of many short pointer moves still
 * places dabs every `spacing` feet. `from` itself is never a dab (the previous call placed it).
 */
export function dabPositions(from: Vec2, to: Vec2, spacing: number, carry = 0): { points: Vec2[]; carry: number } {
  const len = Math.hypot(to.x - from.x, to.z - from.z)
  const step = Math.max(spacing, 1e-3)
  const points: Vec2[] = []
  let d = step - carry
  while (d <= len + 1e-9) {
    const t = len > 0 ? d / len : 0
    points.push({ x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t })
    d += step
  }
  const lastDab = points.length > 0 ? d - step : -carry
  return { points, carry: len - lastDab }
}

export interface BrushStroke {
  readonly brush: BrushSettings
  /** Union of every dab's dirty rect so far (commit with this). */
  readonly dirty: Rect | null
  readonly dabCount: number
  /** Continue the stroke to p; returns the rect dirtied by this move (null if none). */
  moveTo(p: Vec2): Rect | null
}

/**
 * Start a stroke: applies a dab at `start` immediately, then one every `spacing` feet on moveTo().
 * A flatten stroke without an explicit target flattens to the height under the start point.
 */
export function beginStroke(lattice: HeightLattice, brush: BrushSettings, start: Vec2, opts: { spacing?: number } = {}): BrushStroke {
  const settings: BrushSettings =
    brush.mode === "flatten" && !(brush.target !== undefined && Number.isFinite(brush.target)) ? { ...brush, target: sampleLattice(lattice, start) } : { ...brush }
  const spacing = opts.spacing ?? defaultDabSpacing(settings.radius)
  let last = { x: start.x, z: start.z }
  let carry = 0
  let dirty = applyDab(lattice, start, settings)
  let dabCount = 1
  return {
    brush: settings,
    get dirty() {
      return dirty
    },
    get dabCount() {
      return dabCount
    },
    moveTo(p: Vec2): Rect | null {
      const { points, carry: rest } = dabPositions(last, p, spacing, carry)
      carry = rest
      last = { x: p.x, z: p.z }
      let moved: Rect | null = null
      for (const q of points) {
        moved = unionRect(moved, applyDab(lattice, q, settings))
        dabCount++
      }
      dirty = unionRect(dirty, moved)
      return moved
    },
  }
}
