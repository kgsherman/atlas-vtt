/**
 * Public API of core/occlusion. STUB — implemented by the occlusion module (see docs/ARCHITECTURE.md §5.1).
 */
import type { SceneLike } from "../scene/types"
import type { OcclusionWorld } from "./types"

export type * from "./types"

/** Build the CPU occluder model for a scene (full scene for DM/host; viewToScene() output for players). */
export function buildOcclusionWorld(_scene: SceneLike): OcclusionWorld {
  throw new Error("buildOcclusionWorld: not implemented")
}
