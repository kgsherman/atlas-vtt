import type { Cell, Id } from "../scene/types"

export interface PathStep {
  cell: Cell
  levelId: Id
}

export type MoveRejectReason =
  | "not-owner"
  | "movement-locked"
  | "unknown-token"
  | "empty-path"
  | "path-start-mismatch"
  | "not-adjacent"
  | "out-of-bounds"
  | "blocked"
  | "corner-cutting"
  | "no-connector"
  | "no-ground"
  | "too-far"

export interface MoveValidation {
  ok: boolean
  /** Number of steps (after the start) that are legal. Equals path.length - 1 when ok. */
  legalSteps: number
  /** Feet travelled over the legal prefix. */
  distance: number
  reason?: MoveRejectReason
  /** Index of the first illegal step, when !ok. */
  failedAt?: number
}

export interface MoveOptions {
  /** Enforce token.speed as a per-move maximum. */
  enforceSpeed: boolean
}
