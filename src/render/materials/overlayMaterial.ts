/**
 * Fog-aware unlit overlay materials: faint window glass, emissive fixture flames and their additive glow
 * sprites (see glsl/overlay.ts for the perception rules). All are transparent (flames fade out where
 * they are not perceived) and share the global uniforms; the host-mask layer comes from
 * `object.userData.levelId` (set by the engine on every level mesh), like the token material.
 */
import * as THREE from "three"

import type { Id } from "@/core/scene/types"
import type { SharedUniforms } from "../lighting/uniforms"
import { OVERLAY_FRAGMENT_SHADER, OVERLAY_VERTEX_SHADER } from "./glsl/overlay"
import { keepSharedOnClone, setDefaultAttributes, type TierRegistry } from "./util"

export type OverlayKind = "glass" | "flame" | "glow"

export const GLASS_OPACITY = 0.16

export interface OverlayMaterialContext {
  shared: SharedUniforms
  /** Host-mask layer of a level, -1 when none. */
  layerOf(levelId: Id): number
  tiers?: TierRegistry
}

export function createOverlayMaterial(ctx: OverlayMaterialContext, opts: { kind: OverlayKind }): THREE.ShaderMaterial {
  const glass = opts.kind === "glass"
  const glow = opts.kind === "glow"
  const own = {
    uLevelLayer: { value: -1 },
    uOpacity: { value: glass ? GLASS_OPACITY : 1 },
  }
  const material = new THREE.ShaderMaterial({
    name: `atlas-overlay:${opts.kind}`,
    glslVersion: THREE.GLSL3,
    vertexShader: OVERLAY_VERTEX_SHADER,
    fragmentShader: OVERLAY_FRAGMENT_SHADER,
    defines: glass ? {} : glow ? { AT_FLAME: "", AT_GLOW: "" } : { AT_FLAME: "" },
    uniforms: { ...ctx.shared, ...own },
    transparent: true,
    depthWrite: !glass && !glow,
    blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending,
    side: glass || glow ? THREE.DoubleSide : THREE.FrontSide,
    // Emissive / glint colours are final: no tone mapping (as the unlit materials they replace).
    toneMapped: false,
  })
  setDefaultAttributes(material, { color: [1, 1, 1] })
  material.userData.atlas = { kind: "overlay", overlay: opts.kind }
  ctx.tiers?.track(material)
  material.onBeforeRender = (_renderer, _scene, _camera, _geometry, object) => {
    const levelId = (object.userData as { levelId?: unknown }).levelId
    const layer = typeof levelId === "string" ? ctx.layerOf(levelId) : -1
    if (own.uLevelLayer.value !== layer) {
      own.uLevelLayer.value = layer
      // Shared between the levels' meshes: upload the per-object value.
      material.uniformsNeedUpdate = true
    }
  }
  keepSharedOnClone(material, () => createOverlayMaterial(ctx, opts))
  return material
}
