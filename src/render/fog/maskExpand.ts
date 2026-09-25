/**
 * Host masks → texture texels (ARCHITECTURE §4.4). Every grid cell becomes a 4×4 block of texels, one
 * per SUBCELLS×SUBCELLS sub-cell, so partial (sub-cell refined) cells are exact. One RGBA8 layer per
 * level carries all masks, so the world shader needs a single filtered fetch:
 *   R = perceived — LINEAR-filtered: 255 perceived, 128 the band (below), 0 not perceived
 *   G = explored (LINEAR, feathered inward like R)
 *   B = sunlit (255 when the host sent no sunlit mask: the local sun shadow map decides alone)
 *   A = perception grade × 85  — read with texelFetch (nearest): grades must not be interpolated
 * Texel (x, y) of a layer covers world x ∈ [x·s, (x+1)·s), z ∈ [y·s, (y+1)·s) with s = cellSize / 4.
 *
 * Fog styles (render/contracts FogStyle):
 *  - "smooth": the band is every unperceived sub-cell next to a perceived one (8-neighbourhood), with the
 *    best neighbouring grade and sunlit value. The world shader treats it as perceived only where the GPU
 *    line of sight (and light and sense ranges) confirm it per pixel, and as fog otherwise; so the edge
 *    follows the real shadow line instead of the host's sub-cell staircase. The player is sent floors and
 *    art for it (core/vision artExtent).
 *  - "grid": whole cells: a cell with any perceived sub-cell is perceived whole at its grade, a cell with any
 *    explored sub-cell explored whole. No band.
 */
import { decodeGrades, decodeMask, getCell } from "@/core/vision/mask"
import { SUBCELLS, type CellMask, type GradeMask } from "@/core/vision/types"
import type { FogStyle, HostLevelMasks } from "../contracts"

export const MASK_TEXELS_PER_CELL = SUBCELLS

/** Bytes of one RGBA layer for a grid. */
export function maskLayerBytes(width: number, depth: number): number {
  return width * MASK_TEXELS_PER_CELL * depth * MASK_TEXELS_PER_CELL * 4
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

/** Pack RGBA bytes into the Uint32 that has that byte order in memory. */
function packRgba(r: number, g: number, b: number, a: number): number {
  return LITTLE_ENDIAN ? ((a << 24) | (b << 16) | (g << 8) | r) >>> 0 : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0
}

/** 16-bit sub-cell coverage of a cell: 0xffff = whole cell. */
function cellSubmask(m: CellMask, index: number): number {
  if (getCell(m, index)) return 0xffff
  return m.partial.get(index) ?? 0
}

function gradeSubmask(m: GradeMask, index: number): number {
  if (m.grades[index] === 0) return 0
  return m.partial.get(index) ?? 0xffff
}

/** R value of a band texel (smooth style). */
export const MASK_BAND = 128

/**
 * Expand one level's masks into `out` (RGBA8, (width·4) × (depth·4) texels, row-major by z). `out`
 * is fully overwritten. `width`/`depth` are the scene grid's; masks of other dimensions are clipped.
 * Absent masks → everything unperceived and unexplored (ARCHITECTURE: a level missing from the
 * record is entirely unperceived/unexplored).
 */
export function expandLevelMasks(masks: HostLevelMasks | undefined, width: number, depth: number, out: Uint8Array, style: FogStyle = "smooth"): void {
  const texW = width * MASK_TEXELS_PER_CELL
  const words = new Uint32Array(out.buffer, out.byteOffset, out.byteLength >> 2)
  words.fill(0)
  if (!masks) return
  const grades = decodeGrades(masks.perception)
  const explored = decodeMask(masks.explored)
  const sunlit = masks.sunlit ? decodeMask(masks.sunlit) : null
  const n = SUBCELLS
  const grid = style === "grid"
  // Smooth style: per texel perceived grade (0 = not) and sunlit, for the band pass.
  const texH = depth * n
  // Per texel: the grade of texels with r > 0 (perceived; smooth: then the band too) and their sunlit value.
  const pg = new Uint8Array(texW * texH)
  const ps = new Uint8Array(texW * texH)
  const anyPerceived = new Uint8Array(width * depth)
  for (let j = 0; j < depth; j++) {
    for (let i = 0; i < width; i++) {
      const g = i < grades.width && j < grades.depth ? grades.grades[j * grades.width + i] : 0
      let pSub = i < grades.width && j < grades.depth ? gradeSubmask(grades, j * grades.width + i) : 0
      let eSub = i < explored.width && j < explored.depth ? cellSubmask(explored, j * explored.width + i) : 0
      const sSub = sunlit ? (i < sunlit.width && j < sunlit.depth ? cellSubmask(sunlit, j * sunlit.width + i) : 0) : 0xffff
      if (grid) {
        if (pSub !== 0) pSub = 0xffff
        if (eSub !== 0) eSub = 0xffff
      }
      if (pSub === 0 && eSub === 0 && sSub === 0) continue
      if (pSub !== 0) anyPerceived[j * width + i] = 1
      const base = j * n * texW + i * n
      if (pSub !== 0) {
        for (let sz = 0; sz < n; sz++) {
          for (let sx = 0; sx < n; sx++) {
            const bit = 1 << (sz * n + sx)
            if (pSub & bit) {
              pg[base + sz * texW + sx] = g
              ps[base + sz * texW + sx] = sSub & bit ? 1 : 0
            }
          }
        }
      }
      if ((pSub === 0 || pSub === 0xffff) && (eSub === 0 || eSub === 0xffff) && (sSub === 0 || sSub === 0xffff)) {
        // Uniform cell: one value for the whole 4×4 block.
        const v = packRgba(pSub ? 255 : 0, eSub ? 255 : 0, sSub ? 255 : 0, pSub ? g * 85 : 0)
        for (let sz = 0; sz < n; sz++) words.fill(v, base + sz * texW, base + sz * texW + n)
        continue
      }
      for (let sz = 0; sz < n; sz++) {
        for (let sx = 0; sx < n; sx++) {
          const bit = 1 << (sz * n + sx)
          const p = (pSub & bit) !== 0
          words[base + sz * texW + sx] = packRgba(p ? 255 : 0, eSub & bit ? 255 : 0, sSub & bit ? 255 : 0, p ? g * 85 : 0)
        }
      }
    }
  }
  const extra = { grade: new Uint8Array(texW * texH), sun: new Uint8Array(texW * texH) }
  const exploredByte = (t: number) => (LITTLE_ENDIAN ? (words[t] >>> 8) & 0xff : (words[t] >>> 16) & 0xff)
  if (!grid) {
    // The band: unperceived texels next to perceived ones.
    const band = ring(pg, ps, anyPerceived, width, depth, texW, extra)
    for (const t of band) {
      words[t] = packRgba(MASK_BAND, exploredByte(t), sunlit ? (extra.sun[t] ? 255 : 0) : 255, extra.grade[t] * 85)
      pg[t] = extra.grade[t]
      ps[t] = extra.sun[t]
    }
  }
  // The grade ring: texels next to any with r > 0 take their grade with r = 0. The shader reads the grade
  // from the nearest texel and the r edge filtered: without the ring, a texel whose filtered r is still
  // high (a notch between band or perceived texels) would be cut off by its grade 0 as a hard square.
  for (const t of ring(pg, ps, anyPerceived, width, depth, texW, extra)) {
    words[t] = packRgba(0, exploredByte(t), sunlit ? (extra.sun[t] ? 255 : 0) : 255, extra.grade[t] * 85)
  }
}

/**
 * Texels with grade 0 next to one with a grade (8-neighbourhood) in cells around `near` cells: their best
 * neighbouring grade and whether a neighbour with a grade is sunlit go to `out`; returns their indices.
 */
function ring(
  grades: Uint8Array,
  sun: Uint8Array,
  near: Uint8Array,
  width: number,
  depth: number,
  texW: number,
  out: { grade: Uint8Array; sun: Uint8Array }
): number[] {
  const n = SUBCELLS
  const texH = depth * n
  const found: number[] = []
  for (let j = 0; j < depth; j++) {
    for (let i = 0; i < width; i++) {
      let close = false
      for (let dj = -1; dj <= 1 && !close; dj++) {
        for (let di = -1; di <= 1; di++) {
          const ii = i + di
          const jj = j + dj
          if (ii >= 0 && jj >= 0 && ii < width && jj < depth && near[jj * width + ii]) {
            close = true
            break
          }
        }
      }
      if (!close) continue
      for (let y = j * n; y < (j + 1) * n; y++) {
        for (let x = i * n; x < (i + 1) * n; x++) {
          const t = y * texW + x
          if (grades[t] !== 0) continue
          let grade = 0
          let lit = 0
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy
            if (yy < 0 || yy >= texH) continue
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx
              if (xx < 0 || xx >= texW) continue
              const k = yy * texW + xx
              if (grades[k] > grade) grade = grades[k]
              if (grades[k] !== 0 && sun[k] !== 0) lit = 1
            }
          }
          if (grade === 0) continue
          out.grade[t] = grade
          out.sun[t] = lit
          found.push(t)
        }
      }
    }
  }
  return found
}

/** Cheap change signature of a level's encoded masks (strings compare by value). */
export function maskSignature(m: HostLevelMasks | undefined): string {
  if (!m) return ""
  const s = m.sunlit ? `${m.sunlit.width}x${m.sunlit.depth}:${m.sunlit.b64}:${m.sunlit.partial ?? ""}` : "-"
  return [
    `${m.perception.width}x${m.perception.depth}:${m.perception.b64}:${m.perception.partial ?? ""}`,
    `${m.explored.width}x${m.explored.depth}:${m.explored.b64}:${m.explored.partial ?? ""}`,
    s,
  ].join("|")
}
