/**
 * Fog-aware unlit overlay materials: faint window glass and emissive fixture flames (see
 * glsl/overlay.ts for the perception rules). Both are transparent (flames fade out where they are not
 * perceived) and share the global uniforms; the host-mask layer comes from `object.userData.levelId`
 * (set by the engine on every level mesh), like the token material.
 */
import * as THREE from "three"

import type { Id } from "@/core/scene/types"
import type { SharedUniforms } from "../lighting/uniforms"
import { OVERLAY_FRAGMENT_SHADER, OVERLAY_VERTEX_SHADER } from "./glsl/overlay"
import { keepSharedOnClone, setDefaultAttributes } from "./util"

export type OverlayKind = "glass" | "flame"

export const GLASS_OPACITY = 0.16

export interface OverlayMaterialContext {
  shared: SharedUniforms
  /** Host-mask layer of a level, -1 when none. */
  layerOf(levelId: Id): number
}

export function createOverlayMaterial(ctx: OverlayMaterialContext, opts: { kind: OverlayKind }): THREE.ShaderMaterial {
  const glass = opts.kind === "glass"
  const own = {
    uLevelLayer: { value: -1 },
    uOpacity: { value: glass ? GLASS_OPACITY : 1 },
  }
  const material = new THREE.ShaderMaterial({
    name: `atlas-overlay:${opts.kind}`,
    glslVersion: THREE.GLSL3,
    vertexShader: OVERLAY_VERTEX_SHADER,
    fragmentShader: OVERLAY_FRAGMENT_SHADER,
    defines: glass ? {} : { AT_FLAME: "" },
    uniforms: { ...ctx.shared, ...own },
    transparent: true,
    depthWrite: !glass,
    side: glass ? THREE.DoubleSide : THREE.FrontSide,
    // Emissive / glint colours are final: no tone mapping (as the unlit materials they replace).
    toneMapped: false,
  })
  setDefaultAttributes(material, { color: [1, 1, 1] })
  material.userData.atlas = { kind: "overlay", overlay: opts.kind }
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
