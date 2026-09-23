/**
 * Host masks → texture texels (ARCHITECTURE §4.4). Every grid cell becomes a 4×4 block of texels, one
 * per SUBCELLS×SUBCELLS sub-cell, so partial (sub-cell refined) cells are exact. One RGBA8 layer per
 * level carries all masks, so the world shader needs a single filtered fetch:
 *   R = perceived (grade > 0)  — LINEAR-filtered, smoothstep(0.5, 1) → edges feather inward only
 *   G = explored               — same
 *   B = sunlit (255 when the host sent no sunlit mask: the local sun shadow map decides alone)
 *   A = perception grade × 85  — read with texelFetch (nearest): grades must not be interpolated
 * Texel (x, y) of a layer covers world x ∈ [x·s, (x+1)·s), z ∈ [y·s, (y+1)·s) with s = cellSize / 4.
 */
import { decodeGrades, decodeMask, getCell } from "@/core/vision/mask"
import { SUBCELLS, type CellMask, type GradeMask } from "@/core/vision/types"
import type { HostLevelMasks } from "../contracts"

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

/**
 * Expand one level's masks into `out` (RGBA8, (width·4) × (depth·4) texels, row-major by z). `out`
 * is fully overwritten. `width`/`depth` are the scene grid's; masks of other dimensions are clipped.
 * Absent masks → everything unperceived and unexplored (ARCHITECTURE: a level missing from the
 * record is entirely unperceived/unexplored).
 */
export function expandLevelMasks(masks: HostLevelMasks | undefined, width: number, depth: number, out: Uint8Array): void {
  const texW = width * MASK_TEXELS_PER_CELL
  const words = new Uint32Array(out.buffer, out.byteOffset, out.byteLength >> 2)
  words.fill(0)
  if (!masks) return
  const grades = decodeGrades(masks.perception)
  const explored = decodeMask(masks.explored)
  const sunlit = masks.sunlit ? decodeMask(masks.sunlit) : null
  const n = SUBCELLS
  for (let j = 0; j < depth; j++) {
    for (let i = 0; i < width; i++) {
      const g = i < grades.width && j < grades.depth ? grades.grades[j * grades.width + i] : 0
      const pSub = i < grades.width && j < grades.depth ? gradeSubmask(grades, j * grades.width + i) : 0
      const eSub = i < explored.width && j < explored.depth ? cellSubmask(explored, j * explored.width + i) : 0
      const sSub = sunlit ? (i < sunlit.width && j < sunlit.depth ? cellSubmask(sunlit, j * sunlit.width + i) : 0) : 0xffff
      if (pSub === 0 && eSub === 0 && sSub === 0) continue
      const base = j * n * texW + i * n
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
