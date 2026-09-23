/**
 * Public API of core/vision — authoritative visibility (docs/ARCHITECTURE.md §5.2, §5.4): light
 * field, per-viewer line of sight, perception masks, token visibility and observation.
 */
import type { OcclusionWorld } from "../occlusion/types"
import { groundHeightAt } from "../scene/queries"
import type { SceneLike, Token, Vec3 } from "../scene/types"
import { VisionEngineImpl } from "./engine"
import { eyeAtGround, tokenPointsAtGround } from "./eye"
import type { VisionEngine } from "./types"

export type * from "./types"
export * from "./mask"
export { VisionEngineImpl, type SampleInspection } from "./engine"
export { CEILING_MARGIN, EYE_PUSH_MARGIN, FEET_OFFSET, TOKEN_POINT_INSET, ceilingAbove, eyeAtGround, tokenPointColumns, tokenPointsAtGround } from "./eye"
export { LIGHT_LEVEL } from "./lightField"
export {
  FootprintCache,
  maskHasPoint,
  maskTouchesShape,
  objectFootprint,
  observedObjectIds,
  type FootprintShape,
  type ObjectFootprint,
  type ObserveOptions,
} from "./observe"

/** Clamped eye: ground + eyeHeight, below the ceiling (−0.25 ft), pushed out of containing sight blockers. */
export function resolveViewerEye(
  world: OcclusionWorld,
  scene: SceneLike,
  token: Pick<Token, "levelId" | "position" | "eyeHeight" | "height">
): Vec3 {
  return eyeAtGround(world, groundHeightAt(scene, token.levelId, token.position), token)
}

/** Token visibility test points (footprint centre/corners × feet/mid/head, capped below the ceiling). */
export function tokenTestPoints(world: OcclusionWorld, scene: SceneLike, token: Token): Vec3[] {
  return tokenPointsAtGround(world, scene.grid.cellSize, groundHeightAt(scene, token.levelId, token.position), token)
}

/** Stateful, incremental vision engine (light field + per-viewer LOS caches). */
export function createVisionEngine(scene: SceneLike): VisionEngine {
  return new VisionEngineImpl(scene)
}
