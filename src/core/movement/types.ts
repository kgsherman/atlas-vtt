import type { Cell, Id } from "../scene/types"

/**
 * One step of a move. `cell` is the token's ANCHOR: the min-corner cell of its footprint
 * (footprint = max(1, SIZE_FOOTPRINT[size]) cells square). The token's position after the step is
 * anchor·cellSize + side/2 with side = max(1, footprint)·cellSize.
 */
export interface PathStep {
  cell: Cell
  levelId: Id
}

export type MoveRejectReason =
  | "not-owner"
  | "movement-locked"
  | "unknown-token"
  | "empty-path"
  | "path-too-long"
  | "path-start-mismatch"
  | "not-adjacent"
  | "out-of-bounds"
  | "blocked"
  | "corner-cutting"
  | "connector-edge"
  | "no-connector"
  | "no-ground"
  | "too-far"

export interface MoveValidation {
  ok: boolean
  /** Number of steps (after the start) that are legal. Equals path.length − 1 when ok. */
  legalSteps: number
  /** Feet travelled over the legal prefix. */
  distance: number
  reason?: MoveRejectReason
  /** Index into path of the first illegal step, when !ok. */
  failedAt?: number
}

export interface MoveOptions {
  /** Enforce token.speed as a per-move maximum. */
  enforceSpeed: boolean
  /** Maximum number of steps accepted (default 256). */
  maxSteps?: number
}
