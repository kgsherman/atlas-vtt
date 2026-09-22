/**
 * Cell masks shared by vision (producer), session (explored/memory/filter) and render (textures).
 * Layout is documented on CellMask / GradeMask in ./types.
 */
import { base64ToBytes, bytesToBase64 } from "../scene/heightmap"
import { SUBCELLS, type CellMask, type EncodedGrades, type EncodedMask, type GradeMask, type Perception } from "./types"

export const FULL_SUBMASK = (1 << (SUBCELLS * SUBCELLS)) - 1

// ---------------------------------------------------------------------------
// CellMask
// ---------------------------------------------------------------------------

export function createCellMask(width: number, depth: number): CellMask {
  return { width, depth, bits: new Uint8Array(Math.ceil((width * depth) / 8)), partial: new Map() }
}

export function cloneCellMask(m: CellMask): CellMask {
  return { width: m.width, depth: m.depth, bits: m.bits.slice(), partial: new Map(m.partial) }
}

export function getCell(m: CellMask, index: number): boolean {
  return (m.bits[index >> 3] & (1 << (index & 7))) !== 0
}

export function setCell(m: CellMask, index: number, value = true): void {
  if (value) {
    m.bits[index >> 3] |= 1 << (index & 7)
    m.partial.delete(index)
  } else {
    m.bits[index >> 3] &= ~(1 << (index & 7))
  }
}

/** Set sub-cells of a cell (OR). A full sub-mask promotes to the coarse bit. */
export function setSubcells(m: CellMask, index: number, submask: number): void {
  if (getCell(m, index)) return
  const merged = (m.partial.get(index) ?? 0) | submask
  if (merged === FULL_SUBMASK) setCell(m, index, true)
  else if (merged !== 0) m.partial.set(index, merged)
}

/** Coverage of a cell: 1 = full, 0 = none, otherwise fraction of sub-cells set. */
export function cellCoverage(m: CellMask, index: number): number {
  if (getCell(m, index)) return 1
  const p = m.partial.get(index)
  if (!p) return 0
  let n = 0
  for (let v = p; v; v &= v - 1) n++
  return n / (SUBCELLS * SUBCELLS)
}

/** True if any part of the cell is set. */
export function cellTouched(m: CellMask, index: number): boolean {
  return getCell(m, index) || (m.partial.get(index) ?? 0) !== 0
}

/** Sub-cell test: sx, sz in [0, SUBCELLS). */
export function getSubcell(m: CellMask, index: number, sx: number, sz: number): boolean {
  if (getCell(m, index)) return true
  const p = m.partial.get(index)
  return p !== undefined && (p & (1 << (sz * SUBCELLS + sx))) !== 0
}

/** a |= b (same dimensions). Returns true if a changed. */
export function orInto(a: CellMask, b: CellMask): boolean {
  let changed = false
  for (let k = 0; k < a.bits.length; k++) {
    const v = a.bits[k] | b.bits[k]
    if (v !== a.bits[k]) {
      a.bits[k] = v
      changed = true
    }
  }
  for (const idx of [...a.partial.keys()]) if (getCell(a, idx)) a.partial.delete(idx)
  for (const [idx, sub] of b.partial) {
    if (getCell(a, idx)) continue
    const before = a.partial.get(idx) ?? 0
    setSubcells(a, idx, sub)
    if ((a.partial.get(idx) ?? (getCell(a, idx) ? FULL_SUBMASK : 0)) !== before) changed = true
  }
  return changed
}

export function isEmptyMask(m: CellMask): boolean {
  if (m.partial.size > 0) return false
  for (let k = 0; k < m.bits.length; k++) if (m.bits[k] !== 0) return false
  return true
}

/** Copy the overlapping region into a mask of new dimensions (grid resize; origin fixed at 0,0). */
export function resizeCellMask(m: CellMask, width: number, depth: number): CellMask {
  const out = createCellMask(width, depth)
  const w = Math.min(width, m.width)
  const d = Math.min(depth, m.depth)
  for (let j = 0; j < d; j++) {
    for (let i = 0; i < w; i++) {
      const src = j * m.width + i
      const dst = j * width + i
      if (getCell(m, src)) setCell(out, dst, true)
      else {
        const p = m.partial.get(src)
        if (p) out.partial.set(dst, p)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// GradeMask
// ---------------------------------------------------------------------------

export function createGradeMask(width: number, depth: number): GradeMask {
  return { width, depth, grades: new Uint8Array(width * depth), partial: new Map() }
}

/** Raise a cell's grade (max). Sub-cell refinement is managed by the producer. */
export function raiseGrade(m: GradeMask, index: number, grade: Perception): void {
  if (grade > m.grades[index]) m.grades[index] = grade
}

/** Cells with grade > 0 as a CellMask (partial entries carried over). */
export function perceivedCells(m: GradeMask): CellMask {
  const out = createCellMask(m.width, m.depth)
  for (let k = 0; k < m.grades.length; k++) {
    if (m.grades[k] === 0) continue
    const p = m.partial.get(k)
    if (p === undefined) setCell(out, k, true)
    else if (p !== 0) out.partial.set(k, p)
  }
  return out
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function encodePartial(partial: Map<number, number>): string | undefined {
  if (partial.size === 0) return undefined
  const buf = new Uint8Array(partial.size * 6)
  const view = new DataView(buf.buffer)
  let o = 0
  for (const idx of [...partial.keys()].sort((a, b) => a - b)) {
    view.setUint32(o, idx, true)
    view.setUint16(o + 4, partial.get(idx)!, true)
    o += 6
  }
  return bytesToBase64(buf)
}

function decodePartial(b64: string | undefined): Map<number, number> {
  const out = new Map<number, number>()
  if (!b64) return out
  const buf = base64ToBytes(b64)
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  for (let o = 0; o + 6 <= buf.byteLength; o += 6) out.set(view.getUint32(o, true), view.getUint16(o + 4, true))
  return out
}

export function encodeMask(m: CellMask): EncodedMask {
  const out: EncodedMask = { width: m.width, depth: m.depth, b64: bytesToBase64(m.bits) }
  const partial = encodePartial(m.partial)
  if (partial) out.partial = partial
  return out
}

export function decodeMask(e: EncodedMask): CellMask {
  const expected = Math.ceil((e.width * e.depth) / 8)
  const raw = base64ToBytes(e.b64)
  const bits = new Uint8Array(expected)
  bits.set(raw.subarray(0, expected))
  return { width: e.width, depth: e.depth, bits, partial: decodePartial(e.partial) }
}

export function encodeGrades(m: GradeMask): EncodedGrades {
  const bytes = new Uint8Array(Math.ceil(m.grades.length / 4))
  for (let k = 0; k < m.grades.length; k++) bytes[k >> 2] |= (m.grades[k] & 3) << ((k & 3) * 2)
  const out: EncodedGrades = { width: m.width, depth: m.depth, b64: bytesToBase64(bytes) }
  const partial = encodePartial(m.partial)
  if (partial) out.partial = partial
  return out
}

export function decodeGrades(e: EncodedGrades): GradeMask {
  const bytes = base64ToBytes(e.b64)
  const n = e.width * e.depth
  const grades = new Uint8Array(n)
  for (let k = 0; k < n; k++) grades[k] = ((bytes[k >> 2] ?? 0) >> ((k & 3) * 2)) & 3
  return { width: e.width, depth: e.depth, grades, partial: decodePartial(e.partial) }
}

export function emptyEncodedMask(width: number, depth: number): EncodedMask {
  return encodeMask(createCellMask(width, depth))
}
