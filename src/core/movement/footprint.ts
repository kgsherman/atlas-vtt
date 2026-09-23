/**
 * Token footprints on the grid (docs/ARCHITECTURE.md §5.3, PathStep in ./types).
 *
 * A token's ANCHOR is the min-corner cell of its footprint, which is k × k cells with
 * k = max(1, SIZE_FOOTPRINT[size]). Its position (footprint centre) is anchor·cellSize + k·cellSize/2,
 * so medium tokens centre on cell centres and large (2×2) tokens on cell corners. Tiny creatures
 * reserve one cell but their body square (used for collision) is half a cell.
 */
import { SIZE_FOOTPRINT } from "../scene/defaults"
import type { Cell, GridSettings, SceneLike, Token, Vec2 } from "../scene/types"

/** Footprint side in cells used for anchoring: max(1, SIZE_FOOTPRINT[size]). */
export function footprintCells(size: Token["size"]): number {
  return Math.max(1, SIZE_FOOTPRINT[size] ?? 1)
}

/** Side (feet) of the token's body square: SIZE_FOOTPRINT[size]·cellSize (tiny = half a cell). */
export function bodySide(grid: Pick<GridSettings, "cellSize">, size: Token["size"]): number {
  return (SIZE_FOOTPRINT[size] ?? 1) * grid.cellSize
}

/**
 * Anchor for a token position: the nearest cell-aligned min corner. Exact for snapped tokens; a
 * freely placed token snaps to the closest anchor. (`+ 0` turns −0 into 0.)
 */
export function anchorOf(grid: Pick<GridSettings, "cellSize">, size: Token["size"], position: Vec2): Cell {
  const k = footprintCells(size)
  const s = grid.cellSize
  return { i: Math.round(position.x / s - k / 2) + 0, j: Math.round(position.z / s - k / 2) + 0 }
}

/** Anchor (min-corner cell of the footprint) for a token's current position. */
export function tokenAnchor(scene: Pick<SceneLike, "grid">, token: Pick<Token, "position" | "size">): Cell {
  return anchorOf(scene.grid, token.size, token.position)
}

/** Token centre position for an anchor cell. */
export function anchorCenter(grid: Pick<GridSettings, "cellSize">, size: Token["size"], anchor: Cell): Vec2 {
  const s = grid.cellSize
  const half = (footprintCells(size) * s) / 2
  return { x: anchor.i * s + half, z: anchor.j * s + half }
}

/** Whole footprint inside the grid (and integer anchor coordinates). */
export function footprintInBounds(grid: Pick<GridSettings, "width" | "depth">, k: number, anchor: Cell): boolean {
  return (
    Number.isInteger(anchor.i) &&
    Number.isInteger(anchor.j) &&
    anchor.i >= 0 &&
    anchor.j >= 0 &&
    anchor.i + k <= grid.width &&
    anchor.j + k <= grid.depth
  )
}
