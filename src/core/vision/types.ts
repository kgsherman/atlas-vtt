import type { Id, SceneLike, Token, Vec3, VisionSettings } from "../scene/types"

/** 0 = dark, 1 = dim, 2 = bright. */
export type LightLevel = 0 | 1 | 2

/**
 * How a cell is perceived by the best viewer (max over viewers):
 * 0 = not perceived, 1 = blindsight only (desaturated + outline tint),
 * 2 = darkvision in darkness (greyscale), 3 = full colour (light ≥ dim, not blind).
 */
export type Perception = 0 | 1 | 2 | 3

/** Sample layout per cell: centre + 4 inset points. */
export const SAMPLES_PER_CELL = 5
/** Distance of the 4 outer samples from the cell edges (feet) → offsets ±(cellSize/2 − inset). */
export const VISION_SAMPLE_INSET = 0.75
/** Height of samples above the walkable surface (feet). */
export const VISION_SAMPLE_HEIGHT = 0.25
/** Sub-cell refinement: cells whose samples disagree are resolved on a SUBCELLS×SUBCELLS lattice. */
export const SUBCELLS = 4

/**
 * 1 bit per cell over grid.width × grid.depth. Bit index k = j·width + i, stored LSB-first:
 * byte k >> 3, bit k & 7. Length ceil(width·depth / 8).
 * `partial` refines cells whose coarse bit is 0 but that are partly set: cell index → 16-bit
 * mask over 4×4 sub-cells (bit = sz·4 + sx, sx/sz along +x/+z). A set coarse bit means the whole cell.
 */
export interface CellMask {
  width: number
  depth: number
  bits: Uint8Array
  partial: Map<number, number>
}

/**
 * One Perception grade per cell (1 byte per cell in memory) plus sub-cell refinement for cells whose
 * samples disagree: `partial` maps cell index → 16-bit mask of the sub-cells that are perceived at
 * the cell's grade (sub-cells not in the mask are unperceived). Cells without a partial entry are uniform.
 */
export interface GradeMask {
  width: number
  depth: number
  grades: Uint8Array
  partial: Map<number, number>
}

/** Wire/DB form of a CellMask. `b64` = the bits bytes; `partial` = base64 of (u32 LE cell, u16 LE mask) pairs. */
export interface EncodedMask {
  width: number
  depth: number
  b64: string
  partial?: string
}

/** Wire/DB form of a GradeMask: 2 bits per cell, LSB-first (4 cells per byte). */
export interface EncodedGrades {
  width: number
  depth: number
  b64: string
  partial?: string
}

/** A vision source. `eye` is the CLAMPED eye from resolveViewerEye (below ceilings, outside blockers). */
export interface Viewer {
  tokenId: Id
  levelId: Id
  eye: Vec3
  /**
   * Every point the viewer sees from, `eye` first (viewerEyesAtGround: with "square" vision also its
   * footprint's corners). A point is perceived if some eye perceives it. Absent = [eye].
   */
  eyes?: Vec3[]
  vision: VisionSettings
}

export interface VisibilityResult {
  /** Per level: best perception over all viewers. Levels with nothing perceived may be absent. */
  perception: Record<Id, GradeMask>
  /** Per level: perceived cells where at least one perceived sample is reached by the directional light. */
  sunlit: Record<Id, CellMask>
  /** Tokens (excluding the viewers themselves) with at least one test point perceived. */
  visibleTokenIds: Set<Id>
  /** Objects observed right now (see ARCHITECTURE §5.4). Drives per-player memory. */
  observedObjectIds: Set<Id>
  /** Non-hidden lights that contribute bright/dim light to at least one perceived sample. */
  illuminatingLightIds: Set<Id>
}

export interface VisionChange {
  objects?: Id[]
  tokens?: Id[]
  /** Levels/grid/environment changed. */
  structure?: boolean
  /** Level ids whose terrain changed. */
  terrain?: Id[]
}

/**
 * Stateful, cache-holding vision engine for one scene (lives in the host's vision Worker, or on
 * the main thread for editor previews and tests). Pure TS, no DOM.
 */
export interface VisionEngine {
  /** Replace the scene entirely. */
  setScene(scene: SceneLike): void
  /** Incrementally apply a new scene revision. */
  update(scene: SceneLike, change: VisionChange): void
  /** Resolve a token into a viewer (clamped eye). */
  viewerFor(token: Token): Viewer
  /** Visibility for the union of viewers. Uses and refreshes the internal caches. */
  compute(viewers: Viewer[]): VisibilityResult
}
