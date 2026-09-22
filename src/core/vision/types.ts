import type { Id, Vec3, VisionSettings } from "../scene/types"

/** 0 = dark, 1 = dim, 2 = bright. */
export type LightLevel = 0 | 1 | 2

/**
 * Bitset over the scene grid (grid.width × grid.depth cells), one per level.
 * Bit index = j * width + i.
 */
export interface CellMaskData {
  width: number
  depth: number
  bits: Uint8Array
}

/** Per-level masks keyed by level id. */
export type LevelMasks = Record<Id, CellMaskData>

export interface Viewer {
  tokenId: Id
  levelId: Id
  eye: Vec3
  vision: VisionSettings
}

export interface VisibilityResult {
  /** Cells currently seen by the union of the viewers. */
  visible: LevelMasks
  /** Tokens (other than the viewers themselves) currently seen. */
  visibleTokenIds: Set<Id>
  /** Lights that currently illuminate at least one visible cell. */
  illuminatingLightIds: Set<Id>
}

/** Serialised mask on the wire / in the DB. */
export interface EncodedMask {
  width: number
  depth: number
  /** base64 of the bitset bytes. */
  b64: string
}
