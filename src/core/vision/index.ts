/**
 * Public API of core/vision — authoritative visibility (docs/ARCHITECTURE.md §5.2, §5.4): light
 * field, per-viewer line of sight, perception masks, token visibility and observation.
 */
import type { OcclusionWorld } from "../occlusion/types"
import { groundHeightAt, lightGroundY, lightWorldPosition, type GroundIndex } from "../scene/queries"
import type { LightObject, SceneLike, Token, Vec3 } from "../scene/types"
import { VisionEngineImpl } from "./engine"
import { eyeAtGround, resolveLightOrigin, tokenPointsAtGround, viewerEyesAtGround } from "./eye"
import type { VisionEngine } from "./types"

export type * from "./types"
export * from "./mask"
export { VisionEngineImpl, type SampleInspection } from "./engine"
export {
  CEILING_MARGIN,
  CORNER_EYE_INSET,
  EYE_PUSH_MARGIN,
  FEET_OFFSET,
  TOKEN_POINT_INSET,
  ceilingAbove,
  eyeAtGround,
  resolveLightOrigin,
  tokenPointColumns,
  tokenPointsAtGround,
  viewerEyesAtGround,
} from "./eye"
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

/** Every eye a token sees from (viewerEyesAtGround on its ground, by the scene's grid.visionOrigin). */
export function resolveViewerEyes(
  world: OcclusionWorld,
  scene: SceneLike,
  token: Pick<Token, "levelId" | "position" | "eyeHeight" | "height" | "size">
): Vec3[] {
  return viewerEyesAtGround(world, scene.grid.cellSize, groundHeightAt(scene, token.levelId, token.position), token, scene.grid.visionOrigin)
}

/**
 * World-space light origin as vision uses it: lightWorldPosition (attached lights follow their
 * carrier) pushed out of containing light blockers, toward the light's own level for floor slabs
 * (resolveLightOrigin). Renderers should shadow from the same point. A caller resolving every light
 * of an unchanging scene passes its `groundIndex(scene)` as `ground` (no O(objects) scan per light).
 */
export function resolveLightWorldOrigin(
  world: OcclusionWorld,
  scene: Pick<SceneLike, "levels" | "grid" | "objects" | "tokens">,
  light: LightObject,
  ground?: GroundIndex
): Vec3 {
  return resolveLightOrigin(world, lightWorldPosition(scene, light, ground), lightGroundY(scene, light, ground))
}

/** Token visibility test points (footprint centre/corners × feet/mid/head, capped below the ceiling). */
export function tokenTestPoints(world: OcclusionWorld, scene: SceneLike, token: Token): Vec3[] {
  return tokenPointsAtGround(world, scene.grid.cellSize, groundHeightAt(scene, token.levelId, token.position), token)
}

/** Stateful, incremental vision engine (light field + per-viewer LOS caches). */
export function createVisionEngine(scene: SceneLike): VisionEngine {
  return new VisionEngineImpl(scene)
}
