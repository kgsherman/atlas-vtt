/**
 * Public API of core/occlusion — the single source of blocking truth (docs/ARCHITECTURE.md §2, §5.1).
 * The GPU occluder proxies (render/occluders) are built from OcclusionWorld.primitives.
 */
import type { SceneLike } from "../scene/types"
import type { OcclusionWorld } from "./types"
import { GridOcclusionWorld } from "./world"

export type * from "./types"

/** Build the CPU occluder model for a scene (full scene for DM/host; viewToScene() output for players). */
export function buildOcclusionWorld(scene: SceneLike): OcclusionWorld {
  return new GridOcclusionWorld(scene)
}

export { GridOcclusionWorld, mergeRegions, primitivesEqual } from "./world"
export {
  buildAll,
  buildSource,
  BuildContext,
  connectorRows,
  JOINT_TOLERANCE,
  STAIR_TOP_GAP,
  WALL_BOTTOM_MARGIN,
  wallFrame,
  type WallFrame,
} from "./build"
export {
  ENTRY_CONTAINS_START,
  ENTRY_MISS,
  footprintOverlapsCapsule,
  footprintOverlapsCircle,
  footprintOverlapsPolygon,
  footprintOverlapsRect,
  footprintPolygon,
  heightfieldSurfaceAt,
  primitiveBounds,
  primitiveContains,
  primitiveTopAt,
  pushOutOfPrimitive,
  segmentEntry,
} from "./primitives"
export { TerrainSampler } from "./terrain"
