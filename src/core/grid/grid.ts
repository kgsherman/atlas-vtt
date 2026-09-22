import type { Cell, DiagonalRule, GridSettings, Rect, Vec2 } from "../scene/types"

export function cellOf(grid: GridSettings, p: Vec2): Cell {
  return { i: Math.floor(p.x / grid.cellSize), j: Math.floor(p.z / grid.cellSize) }
}

export function cellCenter(grid: GridSettings, c: Cell): Vec2 {
  return { x: (c.i + 0.5) * grid.cellSize, z: (c.j + 0.5) * grid.cellSize }
}

export function cellRect(grid: GridSettings, c: Cell): Rect {
  return { x: c.i * grid.cellSize, z: c.j * grid.cellSize, w: grid.cellSize, d: grid.cellSize }
}

export function inBounds(grid: GridSettings, c: Cell): boolean {
  return c.i >= 0 && c.j >= 0 && c.i < grid.width && c.j < grid.depth
}

export function cellIndex(grid: GridSettings, c: Cell): number {
  return c.j * grid.width + c.i
}

export function cellFromIndex(grid: GridSettings, index: number): Cell {
  return { i: index % grid.width, j: Math.floor(index / grid.width) }
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.i === b.i && a.j === b.j
}

export type SnapMode = "center" | "vertex" | "half" | "free"

/** Snap a ground point. "center" = cell centres, "vertex" = cell corners, "half" = every half cell. */
export function snapPoint(grid: GridSettings, p: Vec2, mode: SnapMode): Vec2 {
  const s = grid.cellSize
  switch (mode) {
    case "center":
      return { x: (Math.floor(p.x / s) + 0.5) * s, z: (Math.floor(p.z / s) + 0.5) * s }
    case "vertex":
      return { x: Math.round(p.x / s) * s, z: Math.round(p.z / s) * s }
    case "half":
      return { x: Math.round((p.x * 2) / s) * (s / 2), z: Math.round((p.z * 2) / s) * (s / 2) }
    case "free":
      return { x: p.x, z: p.z }
  }
}

/**
 * Distance in feet of a single step between cells, given how many diagonal steps were
 * taken before it (for the alternating 5-10-5 rule).
 */
export function stepCost(
  grid: GridSettings,
  from: Cell,
  to: Cell,
  diagonalsSoFar: number,
  rule: DiagonalRule = grid.diagonalRule
): number {
  const di = Math.abs(to.i - from.i)
  const dj = Math.abs(to.j - from.j)
  const diagonal = di > 0 && dj > 0
  if (!diagonal) return (di + dj) * grid.cellSize
  switch (rule) {
    case "5-5-5":
      return grid.cellSize
    case "5-10-5":
      return diagonalsSoFar % 2 === 0 ? grid.cellSize : grid.cellSize * 2
    case "euclidean":
      return Math.SQRT2 * grid.cellSize
  }
}

/** Total distance of a cell path (feet). Consecutive duplicates (level changes) cost nothing. */
export function pathDistance(grid: GridSettings, cells: Cell[], rule: DiagonalRule = grid.diagonalRule): number {
  let total = 0
  let diagonals = 0
  for (let k = 1; k < cells.length; k++) {
    const a = cells[k - 1]
    const b = cells[k]
    if (sameCell(a, b)) continue
    total += stepCost(grid, a, b, diagonals, rule)
    if (a.i !== b.i && a.j !== b.j) diagonals++
  }
  return total
}

/** Cells overlapped by a rect (inclusive of partially covered cells). */
export function cellsInRect(grid: GridSettings, r: Rect): Cell[] {
  const s = grid.cellSize
  const i0 = Math.max(0, Math.floor(r.x / s))
  const j0 = Math.max(0, Math.floor(r.z / s))
  const i1 = Math.min(grid.width - 1, Math.ceil((r.x + r.w) / s) - 1)
  const j1 = Math.min(grid.depth - 1, Math.ceil((r.z + r.d) / s) - 1)
  const out: Cell[] = []
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out.push({ i, j })
  return out
}
