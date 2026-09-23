/**
 * World material factory (ARCHITECTURE §4.1). Every material shares the global uniform objects (lights,
 * atlases, masks) by reference, so the lighting system updates them once per frame for all levels; the
 * per-level uniforms (`uLevelLayer`, the backdrop image) are themselves shared between all materials of
 * that level.
 *
 * Variants are separate materials created up front (no recompiles at runtime):
 *  - "opaque": the normal pass;
 *  - "ghost": translucent editor ghost (transparent, depthWrite off, LessEqual, opacity 0.25);
 *  - "ghost-depth": its depth-only pre-pass (colorWrite off, trivial fragment shader path).
 * Instanced meshes are handled by three's USE_INSTANCING / USE_INSTANCING_COLOR defines; `instanced`
 * only names the material (the program is chosen per object). The quality tier is the AT_TIER define,
 * kept current by the context's TierRegistry (a tier change recompiles once).
 */
import * as THREE from "three"

import type { Id } from "@/core/scene/types"
import type { WorldMaterialOptions } from "../internal"
import type { SharedUniforms } from "../lighting/uniforms"
import { createBackdropUniforms, type BackdropUniforms } from "./backdrop"
import { noiseTexture, surfaceTableUniform } from "./surface"
import { WORLD_FRAGMENT_SHADER, WORLD_VERTEX_SHADER } from "./glsl/world"
import { keepSharedOnClone, setDefaultAttributes, type TierRegistry } from "./util"

export const GHOST_OPACITY = 0.25

export interface WorldMaterialContext {
  shared: SharedUniforms
  /** Shared `{ value: layer }` uniform of a level (the fog manager keeps it current). */
  levelUniform(levelId: Id): THREE.IUniform<number>
  /** Shared backdrop uniforms of a level (default: private placeholders). */
  levelBackdrop?(levelId: Id): BackdropUniforms
  tiers?: TierRegistry
}

export function createWorldMaterial(ctx: WorldMaterialContext, opts: WorldMaterialOptions): THREE.ShaderMaterial {
  const defines: Record<string, string> = {}
  if (opts.variant === "ghost") defines.AT_GHOST = ""
  if (opts.variant === "ghost-depth") defines.AT_DEPTH_ONLY = ""
  const material = new THREE.ShaderMaterial({
    name: `atlas-world:${opts.variant}${opts.instanced ? ":instanced" : ""}`,
    glslVersion: THREE.GLSL3,
    vertexShader: WORLD_VERTEX_SHADER,
    fragmentShader: WORLD_FRAGMENT_SHADER,
    defines,
    uniforms: {
      ...ctx.shared,
      ...(ctx.levelBackdrop?.(opts.levelId) ?? createBackdropUniforms()),
      uLevelLayer: ctx.levelUniform(opts.levelId),
      uOpacity: { value: GHOST_OPACITY },
      uMatTable: surfaceTableUniform(),
      uNoise: { value: noiseTexture() },
    },
    transparent: opts.variant === "ghost",
    depthWrite: opts.variant !== "ghost",
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    colorWrite: opts.variant !== "ghost-depth",
    side: THREE.FrontSide,
  })
  // Missing vertex attributes: white albedo, WALKABLE surface class, no procedural surface material.
  setDefaultAttributes(material, { color: [1, 1, 1], aSurf: [0], aMat: [0] })
  material.userData.atlas = { kind: "world", levelId: opts.levelId, variant: opts.variant, instanced: opts.instanced }
  ctx.tiers?.track(material)
  keepSharedOnClone(material, () => createWorldMaterial(ctx, opts))
  return material
}
