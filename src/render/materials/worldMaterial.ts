/**
 * World material factory (ARCHITECTURE §4.1). Every material shares the global uniform objects (lights,
 * atlases, masks) by reference, so the lighting system updates them once per frame for all levels; the
 * only per-level uniform (`uLevelLayer`) is itself shared between all materials of that level.
 *
 * Variants are separate materials created up front (no recompiles at runtime):
 *  - "opaque": the normal pass;
 *  - "ghost": translucent editor ghost (transparent, depthWrite off, LessEqual, opacity 0.25);
 *  - "ghost-depth": its depth-only pre-pass (colorWrite off, trivial fragment shader path).
 * Instanced meshes are handled by three's USE_INSTANCING / USE_INSTANCING_COLOR defines; `instanced`
 * only names the material (the program is chosen per object).
 */
import * as THREE from "three"

import type { Id } from "@/core/scene/types"
import type { WorldMaterialOptions } from "../internal"
import type { SharedUniforms } from "../lighting/uniforms"
import { WORLD_FRAGMENT_SHADER, WORLD_VERTEX_SHADER } from "./glsl/world"
import { keepSharedOnClone, setDefaultAttributes } from "./util"

export const GHOST_OPACITY = 0.25

export interface WorldMaterialContext {
  shared: SharedUniforms
  /** Shared `{ value: layer }` uniform of a level (the fog manager keeps it current). */
  levelUniform(levelId: Id): THREE.IUniform<number>
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
      uLevelLayer: ctx.levelUniform(opts.levelId),
      uOpacity: { value: GHOST_OPACITY },
    },
    transparent: opts.variant === "ghost",
    depthWrite: opts.variant !== "ghost",
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    colorWrite: opts.variant !== "ghost-depth",
    side: THREE.FrontSide,
  })
  // Missing vertex attributes: white albedo, WALKABLE surface class.
  setDefaultAttributes(material, { color: [1, 1, 1], aSurf: [0] })
  material.userData.atlas = { kind: "world", levelId: opts.levelId, variant: opts.variant, instanced: opts.instanced }
  keepSharedOnClone(material, () => createWorldMaterial(ctx, opts))
  return material
}
