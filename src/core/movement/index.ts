/**
 * Public API of core/movement. STUB bodies — implemented by the movement module (docs/ARCHITECTURE.md §5.3).
 */
import type { OcclusionWorld } from "../occlusion/types"
import type { Cell, SceneLike, Token, Vec2 } from "../scene/types"
import type { MoveOptions, MoveValidation, PathStep } from "./types"

export type * from "./types"

/** Footprint side in cells used for anchoring: max(1, SIZE_FOOTPRINT[size]). */
export function footprintCells(_size: Token["size"]): number {
  throw new Error("footprintCells: not implemented")
}

/** Anchor (min-corner cell of the footprint) for a token's current position. */
export function tokenAnchor(_scene: SceneLike, _token: Pick<Token, "position" | "size">): Cell {
  throw new Error("tokenAnchor: not implemented")
}

/** Token centre position for an anchor cell. */
export function anchorPosition(_scene: SceneLike, _size: Token["size"], _anchor: Cell): Vec2 {
  throw new Error("anchorPosition: not implemented")
}

/** Validate a path (path[0] must be the token's current anchor + level). Returns the legal prefix length. */
export function validateMove(
  _scene: SceneLike,
  _world: OcclusionWorld,
  _token: Token,
  _path: PathStep[],
  _opts: MoveOptions
): MoveValidation {
  throw new Error("validateMove: not implemented")
}

/** A* over legal steps (incl. connector transitions) from the token's anchor to `target`. null if unreachable. */
export function findPath(
  _scene: SceneLike,
  _world: OcclusionWorld,
  _token: Token,
  _target: PathStep,
  _opts?: { maxSteps?: number }
): PathStep[] | null {
  throw new Error("findPath: not implemented")
}

/** Feet travelled along a path using grid.diagonalRule (level switches cost 0; stairs runs cost their length). */
export function measurePath(_scene: SceneLike, _path: PathStep[]): number {
  throw new Error("measurePath: not implemented")
}
