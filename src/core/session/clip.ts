/**
 * Clipping of remembered objects to a player's explored cells (docs/ARCHITECTURE.md §6.2), with NO
 * dilation: only positive-area overlap with an explored cell (or explored sub-cell) counts.
 *  - walls → parametric runs along a→b whose thickness strip overlaps explored area;
 *  - floors → per-row runs of explored cells inside the floor rect, merged into rects (cell granularity);
 *    masked floors are clipped by their covered rects (`floorRects`), never sent with their mask;
 *  - connectors / pillars / props / openings → whole or nothing (footprint overlap test);
 *  - terrain → chunks overlapping explored cells, samples touching no explored cell zeroed.
 */
import { clipPolygonHalfPlane, polygonArea } from "../geometry/polygon"
import { segmentCellIntervals } from "../grid/grid"
import { chunkSamples, decodeChunk, encodeChunk, parseChunkKey } from "../scene/heightmap"
import { decodeFloorMask, effectiveFloorRects, floorRects } from "../scene/queries"
import type { FloorMask, GridSettings, Id, Rect, SceneLike, TerrainResolution, Vec2 } from "../scene/types"
import { artExtent, cellTouched, createCellMask, getCell, setCell } from "../vision/mask"
import { maskTouchesShape, type ObjectFootprint } from "../vision/observe"
import { SUBCELLS, type CellMask, type EncodedMask, type GradeMask } from "../vision/types"
import { decodeMaskCached, encodeMaskCached, exploredAsGrades, exploredTouched } from "./masks"

/** Minimum overlap area (ft²) for a strip/cell overlap to count (filters touching-only contacts). */
const AREA_EPS = 1e-6
/** Runs closer than this (feet) are merged. */
const RUN_JOIN_EPS = 1e-6

/** A level's explored mask in the forms clipping needs. */
export interface ExploredLevel {
  mask: CellMask
  grades: GradeMask
  /** Floors, terrain and map art are sent over this (core/vision artExtent): explored cells + one sub-cell. */
  extent: CellMask
}

const levelCache = new WeakMap<EncodedMask, ExploredLevel>()

interface FlooredMemo {
  levels: SceneLike["levels"]
  grid: SceneLike["grid"]
  byLevel: Map<Id, CellMask>
}
const flooredCache = new WeakMap<object, FlooredMemo>()

/**
 * Cells a level's effective floors (floors minus stairwell cutouts, core/scene effectiveFloorRects) cover
 * wholly, from the live scene. Cached per scene revision (objects, levels and grid identity).
 */
export function flooredCells(scene: Pick<SceneLike, "levels" | "objects" | "grid">, levelId: Id): CellMask {
  let memo = flooredCache.get(scene.objects)
  if (!memo || memo.levels !== scene.levels || memo.grid !== scene.grid) {
    memo = { levels: scene.levels, grid: scene.grid, byLevel: new Map() }
    flooredCache.set(scene.objects, memo)
  }
  let out = memo.byLevel.get(levelId)
  if (!out) {
    const { width, depth, cellSize: s } = scene.grid
    out = createCellMask(width, depth)
    for (const { rect: r } of effectiveFloorRects(scene, levelId)) {
      const i0 = Math.max(0, Math.ceil(r.x / s - 1e-9))
      const j0 = Math.max(0, Math.ceil(r.z / s - 1e-9))
      const i1 = Math.min(width, Math.floor((r.x + r.w) / s + 1e-9))
      const j1 = Math.min(depth, Math.floor((r.z + r.d) / s + 1e-9))
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) setCell(out, j * width + i, true)
    }
    memo.byLevel.set(levelId, out)
  }
  return out
}

const extentEncCache = new WeakMap<EncodedMask, EncodedMask>()

/**
 * A player's explored masks as the sub-cells of map art to ship them (core/vision artExtent), per level.
 * The same explored object always maps to the same extent object, so consumers can compare by identity.
 */
export function artExtents(explored: Readonly<Record<Id, EncodedMask>>): Record<Id, EncodedMask> {
  const out: Record<Id, EncodedMask> = {}
  for (const [levelId, enc] of Object.entries(explored)) {
    let ext = extentEncCache.get(enc)
    if (!ext) extentEncCache.set(enc, (ext = encodeMaskCached(exploredLevel(enc).extent)))
    out[levelId] = ext
  }
  return out
}

const groundCache = new WeakMap<ExploredLevel, WeakMap<CellMask, CellMask>>()

/**
 * What a player is sent floors and terrain over: the art extent, except that beyond the explored cells
 * only cells the level wholly floors (`floored`, flooredCells) are kept. A ring cell over a stairwell the
 * player has not seen yet must not get a floor piece that would cover the hole on their client.
 */
export function groundExtent(ex: ExploredLevel, floored: CellMask): CellMask {
  let byFloored = groundCache.get(ex)
  if (!byFloored) groundCache.set(ex, (byFloored = new WeakMap()))
  let out = byFloored.get(floored)
  if (!out) {
    out = createCellMask(ex.extent.width, ex.extent.depth)
    const n = ex.extent.width * ex.extent.depth
    for (let c = 0; c < n; c++) {
      if (!cellTouched(ex.extent, c)) continue
      if (cellTouched(ex.mask, c) || getCell(floored, c)) setCell(out, c, true)
    }
    byFloored.set(floored, out)
  }
  return out
}

export function exploredLevel(enc: EncodedMask): ExploredLevel {
  let ex = levelCache.get(enc)
  if (!ex) {
    const mask = decodeMaskCached(enc)
    ex = { mask, grades: exploredAsGrades(mask), extent: artExtent(mask) }
    levelCache.set(enc, ex)
  }
  return ex
}

export type Run = [number, number]

/** Sort and merge overlapping or touching runs. */
export function mergeRuns(runs: Run[]): Run[] {
  const sorted = runs.filter((r) => r[1] > r[0]).sort((p, q) => p[0] - q[0] || p[1] - q[1])
  const out: Run[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r[0] <= last[1] + RUN_JOIN_EPS) last[1] = Math.max(last[1], r[1])
    else out.push([r[0], r[1]])
  }
  return out
}

/**
 * Runs [t0, t1] (feet along a→b, within [0, length]) of a wall's footprint strip (the segment swept
 * ±thickness/2, no end caps) that overlap explored cells or sub-cells with positive area.
 */
export function wallExploredRuns(grid: GridSettings, wall: { a: Vec2; b: Vec2; thickness: number }, mask: CellMask): Run[] {
  const { a, b } = wall
  const len = Math.hypot(b.x - a.x, b.z - a.z)
  if (!(len > 0)) return []
  const ux = (b.x - a.x) / len
  const uz = (b.z - a.z) / len
  const nx = -uz
  const nz = ux
  const hw = wall.thickness / 2
  const na = nx * a.x + nz * a.z
  const ua = ux * a.x + uz * a.z
  const s = grid.cellSize
  const q = s / SUBCELLS
  const runs: Run[] = []
  const addBox = (x0: number, z0: number, size: number) => {
    let poly: Vec2[] = [
      { x: x0, z: z0 },
      { x: x0 + size, z: z0 },
      { x: x0 + size, z: z0 + size },
      { x: x0, z: z0 + size },
    ]
    poly = clipPolygonHalfPlane(poly, nx, nz, na + hw)
    poly = clipPolygonHalfPlane(poly, -nx, -nz, hw - na)
    poly = clipPolygonHalfPlane(poly, -ux, -uz, -ua)
    poly = clipPolygonHalfPlane(poly, ux, uz, ua + len)
    if (poly.length < 3 || polygonArea(poly) <= AREA_EPS) return
    let t0 = Infinity
    let t1 = -Infinity
    for (const p of poly) {
      const t = ux * p.x + uz * p.z - ua
      if (t < t0) t0 = t
      if (t > t1) t1 = t
    }
    runs.push([Math.max(0, t0), Math.min(len, t1)])
  }
  // Candidate cells: the conservative (closed, eps-widened) supercover of the strip.
  for (const { cell } of segmentCellIntervals(grid, a, b, { halfWidth: hw })) {
    const c = cell.j * mask.width + cell.i
    if (getCell(mask, c)) {
      addBox(cell.i * s, cell.j * s, s)
      continue
    }
    const sub = mask.partial.get(c)
    if (!sub) continue
    for (let k = 0; k < SUBCELLS * SUBCELLS; k++) {
      if (sub & (1 << k)) addBox(cell.i * s + (k % SUBCELLS) * q, cell.j * s + Math.floor(k / SUBCELLS) * q, q)
    }
  }
  const merged = mergeRuns(runs)
  // Snap ends that are within float noise of the wall ends (keeps joints exact).
  for (const r of merged) {
    if (r[0] < RUN_JOIN_EPS) r[0] = 0
    if (r[1] > len - RUN_JOIN_EPS) r[1] = len
  }
  return merged
}

/** Merge rects that share an edge and the same extent across it (a, b in any order). */
function mergeAdjacent(rects: Rect[], alongX: boolean): Rect[] {
  const key = (r: Rect) => (alongX ? `${r.z}|${r.d}` : `${r.x}|${r.w}`)
  const lo = (r: Rect) => (alongX ? r.x : r.z)
  const groups = new Map<string, Rect[]>()
  for (const r of rects) {
    const k = key(r)
    const g = groups.get(k)
    if (g) g.push(r)
    else groups.set(k, [r])
  }
  const out: Rect[] = []
  for (const g of groups.values()) {
    g.sort((a, b) => lo(a) - lo(b))
    let cur: Rect | null = null
    for (const r of g) {
      if (cur && Math.abs(lo(cur) + (alongX ? cur.w : cur.d) - lo(r)) < 1e-9) {
        if (alongX) cur.w = r.x + r.w - cur.x
        else cur.d = r.z + r.d - cur.z
      } else {
        cur = { x: r.x, z: r.z, w: r.w, d: r.d }
        out.push(cur)
      }
    }
  }
  return out
}

/**
 * Explored parts of a floor rect: per-row runs of explored cells (ARCHITECTURE §6.2) clipped to the
 * floor rect, merged down rows with identical x extents, then across columns with identical z extents.
 * Floors are clipped at CELL granularity — a partially explored cell counts as explored — because
 * exact sub-cell pieces would multiply the piece count (a quarter of explored cells are partial in
 * the stress scene) for no visible gain: the player's renderer still shows only the explored sub-cells
 * (explored mask), and the extra floor never extends beyond an explored cell. Sorted by (z, x).
 */
export function floorExploredRects(grid: GridSettings, r: Rect, mask: CellMask): Rect[] {
  const s = grid.cellSize
  const rx1 = r.x + r.w
  const rz1 = r.z + r.d
  const i0 = Math.max(0, Math.floor(r.x / s))
  const i1 = Math.min(mask.width - 1, Math.ceil(rx1 / s) - 1)
  const j0 = Math.max(0, Math.floor(r.z / s))
  const j1 = Math.min(mask.depth - 1, Math.ceil(rz1 / s) - 1)
  if (i0 > i1 || j0 > j1) return []
  let open = new Map<number, Rect>()
  const cells: Rect[] = []
  for (let j = j0; j <= j1; j++) {
    const nextOpen = new Map<number, Rect>()
    let start = -1
    for (let i = i0; i <= i1 + 1; i++) {
      const on = i <= i1 && cellTouched(mask, j * mask.width + i)
      if (on && start < 0) start = i
      else if (!on && start >= 0) {
        const k = start * 65536 + i
        const cur = open.get(k)
        if (cur) {
          cur.d += 1
          nextOpen.set(k, cur)
        } else {
          // In cell units while merging (exact integers), converted to feet below.
          const rect = { x: start, z: j, w: i - start, d: 1 }
          cells.push(rect)
          nextOpen.set(k, rect)
        }
        start = -1
      }
    }
    open = nextOpen
  }
  const out: Rect[] = []
  for (const c of mergeAdjacent(cells, true)) {
    const x0 = Math.max(r.x, c.x * s)
    const x1 = Math.min(rx1, (c.x + c.w) * s)
    const z0 = Math.max(r.z, c.z * s)
    const z1 = Math.min(rz1, (c.z + c.d) * s)
    if (x1 > x0 && z1 > z0) out.push({ x: x0, z: z0, w: x1 - x0, d: z1 - z0 })
  }
  return out.sort((a, b) => a.z - b.z || a.x - b.x)
}

/**
 * Explored parts of a floor given by its covered rects (`floorRects(floor)`: the rect, or a mask's
 * merged cells). Every piece lies inside a covered rect AND inside explored cells (cell granularity,
 * like floorExploredRects). Masks on the grid-aligned lattice (spacing divides the cell size, rect on
 * the lattice — what core/scene/imageTrace produces) are clipped per mask cell and re-merged greedily,
 * which keeps the piece count close to the mask's own rect count; other masks are clipped rect by rect.
 * Pieces never carry the mask itself. Sorted by (z, x).
 */
export function maskedFloorExploredRects(grid: GridSettings, floor: { rect: Rect; mask?: FloorMask }, mask: CellMask): Rect[] {
  const fm = floor.mask
  if (!fm) return floorExploredRects(grid, floor.rect, mask)
  const s = grid.cellSize
  const q = fm.spacing
  const per = s / q
  const u0 = floor.rect.x / q
  const v0 = floor.rect.z / q
  const aligned = Math.abs(per - Math.round(per)) < 1e-9 && Math.abs(u0 - Math.round(u0)) < 1e-9 && Math.abs(v0 - Math.round(v0)) < 1e-9
  if (!aligned) {
    const out: Rect[] = []
    for (const r of floorRects(floor)) out.push(...floorExploredRects(grid, r, mask))
    return mergeAdjacent(mergeAdjacent(out, true), false).sort((a, b) => a.z - b.z || a.x - b.x)
  }
  const n = Math.round(per)
  const U0 = Math.round(u0)
  const V0 = Math.round(v0)
  const cells = decodeFloorMask(fm)
  // Greedy merge of kept mask cells: row runs, stacked while the run is identical.
  const out: Rect[] = []
  let open = new Map<number, Rect>()
  for (let v = 0; v < fm.rows; v++) {
    const j = Math.floor((V0 + v) / n)
    const next = new Map<number, Rect>()
    const rowOk = j >= 0 && j < mask.depth
    let u = 0
    while (u < fm.cols) {
      const keep = (uu: number) => {
        if (!rowOk || !cells[v * fm.cols + uu]) return false
        const i = Math.floor((U0 + uu) / n)
        return i >= 0 && i < mask.width && cellTouched(mask, j * mask.width + i)
      }
      if (!keep(u)) {
        u++
        continue
      }
      const start = u
      while (u < fm.cols && keep(u)) u++
      const key = start * 65536 + u
      const prev = open.get(key)
      if (prev) {
        prev.d += 1
        next.set(key, prev)
        open.delete(key)
      } else {
        // In lattice units while merging (exact integers), converted to feet below.
        const r = { x: start, z: v, w: u - start, d: 1 }
        out.push(r)
        next.set(key, r)
      }
    }
    open = next
  }
  return out.map((r) => ({ x: (U0 + r.x) * q, z: (V0 + r.z) * q, w: r.w * q, d: r.d * q })).sort((a, b) => a.z - b.z || a.x - b.x)
}

/** Whether a footprint overlaps (positive area) explored cells on any of its levels. */
export function footprintTouchesExplored(fp: ObjectFootprint | null, levelOf: (levelId: Id) => ExploredLevel | null, cellSize: number): boolean {
  if (!fp) return false
  for (const levelId of fp.levelIds) {
    const ex = levelOf(levelId)
    if (!ex) continue
    for (const shape of fp.shapes) if (maskTouchesShape(ex.grades, cellSize, shape)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

/** chunk b64 → (explored signature → clipped b64 | null). Bounded; entries die with the scene strings. */
const terrainCache = new Map<string, Map<string, string | null>>()
const TERRAIN_CACHE_LIMIT = 4096

/**
 * A heightmap chunk as a player may receive it: samples touching no explored cell are zeroed
 * (lattice samples on cell edges/corners touch every adjacent cell). null = nothing to send.
 */
export function clipTerrainChunk(
  b64: string,
  key: string,
  resolution: TerrainResolution,
  grid: Pick<GridSettings, "width" | "depth">,
  mask: CellMask
): string | null {
  const { ci, cj } = parseChunkKey(key)
  if (!Number.isInteger(ci) || !Number.isInteger(cj) || ci < 0 || cj < 0) return null
  const n = chunkSamples(resolution)
  // Cells touched by this chunk's samples: [8ci − 1, 8ci + 7] × [8cj − 1, 8cj + 7] (in cells).
  const span = n / resolution + 1
  const ci0 = (ci * n) / resolution - 1
  const cj0 = (cj * n) / resolution - 1
  const touched = new Uint8Array(span * span)
  let sig = `${grid.width},${grid.depth},${ci},${cj}:`
  let any = false
  for (let dj = 0; dj < span; dj++) {
    let bits = 0
    for (let di = 0; di < span; di++) {
      if (exploredTouched(mask, ci0 + di, cj0 + dj)) {
        touched[dj * span + di] = 1
        bits |= 1 << di
        any = true
      }
    }
    sig += bits.toString(36) + "."
  }
  if (!any) return null
  let bySig = terrainCache.get(b64)
  const hit = bySig?.get(sig)
  if (hit !== undefined) return hit
  const src = decodeChunk(b64, resolution)
  const out = new Float32Array(n * n)
  const maxSx = grid.width * resolution
  const maxSz = grid.depth * resolution
  let nonZero = false
  for (let lz = 0; lz < n; lz++) {
    const sz = cj * n + lz
    if (sz > maxSz) break
    // Rows of cells the sample touches (two when it lies on a cell edge).
    const jb = Math.floor(sz / resolution) - cj0
    const ja = sz % resolution === 0 ? jb - 1 : jb
    for (let lx = 0; lx < n; lx++) {
      const sx = ci * n + lx
      if (sx > maxSx) break
      const v = src[lz * n + lx]
      if (v === 0) continue
      const ib = Math.floor(sx / resolution) - ci0
      const ia = sx % resolution === 0 ? ib - 1 : ib
      let keep = false
      for (let jj = ja; jj <= jb && !keep; jj++) {
        if (jj < 0 || jj >= span) continue
        for (let ii = ia; ii <= ib; ii++) {
          if (ii >= 0 && ii < span && touched[jj * span + ii]) {
            keep = true
            break
          }
        }
      }
      if (keep) {
        out[lz * n + lx] = v
        nonZero = true
      }
    }
  }
  const result = nonZero ? encodeChunk(out) : null
  if (!bySig) {
    if (terrainCache.size >= TERRAIN_CACHE_LIMIT) terrainCache.clear()
    bySig = new Map()
    terrainCache.set(b64, bySig)
  }
  if (bySig.size >= 8) bySig.clear()
  bySig.set(sig, result)
  return result
}
