/**
 * Explored-mask helpers for core/session: cached decoding, grid-change remapping (ARCHITECTURE §6.2
 * "Grid resizes remap explored masks") and cheap emptiness tests on the wire form.
 */
import type { GridSettings } from "../scene/types"
import {
  cellTouched,
  createCellMask,
  createGradeMask,
  decodeMask,
  encodeGrades,
  encodeMask,
  getCell,
  isEmptyMask,
  resizeCellMask,
  setCell,
} from "../vision/mask"
import type { CellMask, EncodedGrades, EncodedMask, GradeMask } from "../vision/types"

const decoded = new WeakMap<EncodedMask, CellMask>()

/** Decoded explored mask, cached by the encoded object's identity. Treat the result as read-only. */
export function decodeMaskCached(enc: EncodedMask): CellMask {
  let m = decoded.get(enc)
  if (!m) {
    m = decodeMask(enc)
    decoded.set(enc, m)
  }
  return m
}

/** Encode a mask and remember the decoded form for the new encoded object. */
export function encodeMaskCached(m: CellMask): EncodedMask {
  const enc = encodeMask(m)
  decoded.set(enc, m)
  return enc
}

/** True when no cell (or sub-cell) is set. Works on the base64 form without decoding. */
export function encodedMaskIsEmpty(enc: EncodedMask): boolean {
  if (enc.partial) return false
  return /^[A=]*$/.test(enc.b64)
}

export function maskMatchesGrid(m: { width: number; depth: number }, grid: Pick<GridSettings, "width" | "depth">): boolean {
  return m.width === grid.width && m.depth === grid.depth
}

/**
 * Remap an explored mask after a grid change. Same cell size: the overlapping region is kept (origin
 * fixed at 0,0). Different cell size: a new cell is explored only if every old cell it overlaps was
 * fully explored, so a remap never reveals area the player had not explored. null = nothing left.
 */
export function remapExplored(enc: EncodedMask, from: GridSettings, to: GridSettings): EncodedMask | null {
  const old = decodeMaskCached(enc)
  let out: CellMask
  if (from.cellSize === to.cellSize) {
    out = resizeCellMask(old, to.width, to.depth)
  } else {
    out = createCellMask(to.width, to.depth)
    const r = to.cellSize / from.cellSize
    const eps = 1e-9
    for (let j = 0; j < to.depth; j++) {
      const oj0 = Math.floor(j * r + eps)
      const oj1 = Math.ceil((j + 1) * r - eps) - 1
      for (let i = 0; i < to.width; i++) {
        const oi0 = Math.floor(i * r + eps)
        const oi1 = Math.ceil((i + 1) * r - eps) - 1
        let all = oi1 < old.width && oj1 < old.depth
        for (let oj = oj0; all && oj <= oj1; oj++) {
          for (let oi = oi0; all && oi <= oi1; oi++) all = getCell(old, oj * old.width + oi)
        }
        if (all) setCell(out, j * to.width + i, true)
      }
    }
  }
  return isEmptyMask(out) ? null : encodeMaskCached(out)
}

const gradeViews = new WeakMap<CellMask, GradeMask>()

/**
 * The explored mask seen as a GradeMask (grade 1 wherever anything is explored, partial sub-cells
 * carried over), so the observation footprint tests (core/vision maskTouchesShape) apply to it.
 */
export function exploredAsGrades(m: CellMask): GradeMask {
  let g = gradeViews.get(m)
  if (g) return g
  g = createGradeMask(m.width, m.depth)
  const n = m.width * m.depth
  for (let c = 0; c < n; c++) {
    if (getCell(m, c)) g.grades[c] = 1
  }
  for (const [c, sub] of m.partial) {
    if (c < n && sub !== 0 && !getCell(m, c)) {
      g.grades[c] = 1
      g.partial.set(c, sub)
    }
  }
  gradeViews.set(m, g)
  return g
}

/** Whether any part of cell (i, j) is explored (out of range = no). */
export function exploredTouched(m: CellMask, i: number, j: number): boolean {
  if (i < 0 || j < 0 || i >= m.width || j >= m.depth) return false
  return cellTouched(m, j * m.width + i)
}

const emptyGradesCache = new Map<string, EncodedGrades>()
const emptyMaskCache = new Map<string, EncodedMask>()

export function emptyEncodedGrades(width: number, depth: number): EncodedGrades {
  const key = `${width}x${depth}`
  let e = emptyGradesCache.get(key)
  if (!e) {
    e = encodeGrades(createGradeMask(width, depth))
    emptyGradesCache.set(key, e)
  }
  return { width: e.width, depth: e.depth, b64: e.b64 }
}

export function emptyEncodedCellMask(width: number, depth: number): EncodedMask {
  const key = `${width}x${depth}`
  let e = emptyMaskCache.get(key)
  if (!e) {
    e = encodeMask(createCellMask(width, depth))
    emptyMaskCache.set(key, e)
  }
  return { width: e.width, depth: e.depth, b64: e.b64 }
}
