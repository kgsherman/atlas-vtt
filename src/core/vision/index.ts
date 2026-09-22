/**
 * Public API of core/vision. STUB bodies — implemented by the vision module (docs/ARCHITECTURE.md §5.2, §5.4).
 */
import type { OcclusionWorld } from "../occlusion/types"
import type { SceneLike, Token, Vec3 } from "../scene/types"
import type { VisionEngine } from "./types"

export type * from "./types"
export * from "./mask"

/** Clamped eye: ground + eyeHeight, below the ceiling (−0.25 ft), pushed out of containing sight blockers. */
export function resolveViewerEye(
  _world: OcclusionWorld,
  _scene: SceneLike,
  _token: Pick<Token, "levelId" | "position" | "eyeHeight" | "height">
): Vec3 {
  throw new Error("resolveViewerEye: not implemented")
}

/** Token visibility test points (footprint centre/corners × feet/mid/head, capped below the ceiling). */
export function tokenTestPoints(_world: OcclusionWorld, _scene: SceneLike, _token: Token): Vec3[] {
  throw new Error("tokenTestPoints: not implemented")
}

/** Stateful, incremental vision engine (light field + per-viewer LOS caches). */
export function createVisionEngine(_scene: SceneLike): VisionEngine {
  throw new Error("createVisionEngine: not implemented")
}
