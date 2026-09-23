/**
 * Token material factory. Lit by the shared light uniforms (point lights with shadows, sun, fill),
 * never discards. Per-object state is read from `object.userData` in onBeforeRender:
 *  - `tokenId: Id`     → dimmed when in ViewState.dimmedTokenIds (uniform uDim)
 *  - `levelId: Id`     → host-mask layer for perception styling / sunlit gating (uniform uLevelLayer)
 *  - `opacity: number` → appear/disappear fade (uniform uOpacity; set material.transparent for fading)
 *  - `tokenIds: Id[]`  → InstancedMesh: per-instance dim flags written to the `aDim` instanced attribute
 *                        (one frame of latency: attributes upload before onBeforeRender runs)
 * Optional texture: material.uniforms.uMap.value = texture and uUseMap.value = 1 (uses the `uv` attribute).
 * Portraits: material.uniforms.uPortraits.value = the portrait atlas; per instance `aPortrait`
 * (u, v, scale, 1) selects a slot (engine/portraits.ts).
 */
import * as THREE from "three"

import type { Id } from "@/core/scene/types"
import type { SharedUniforms } from "../lighting/uniforms"
import { TOKEN_FRAGMENT_SHADER, TOKEN_VERTEX_SHADER } from "./glsl/token"
import { placeholderTransparentTexture, placeholderWhiteTexture } from "./placeholders"
import { keepSharedOnClone, setDefaultAttributes, type TierRegistry } from "./util"

export interface TokenMaterialContext {
  shared: SharedUniforms
  isDimmed(tokenId: Id): boolean
  /** Host-mask layer of a level, -1 when none. */
  layerOf(levelId: Id): number
  tiers?: TierRegistry
}

/** Rim light strength / exponent and the colour ring's self-lit lift (uTokenParams). */
export const TOKEN_RIM = { strength: 0.55, exponent: 2.6, lift: 0.035 }

export function createTokenMaterial(ctx: TokenMaterialContext, opts: { instanced: boolean }): THREE.ShaderMaterial {
  const own = {
    uLevelLayer: { value: -1 },
    uDim: { value: 0 },
    uOpacity: { value: 1 },
    uMap: { value: placeholderWhiteTexture() as THREE.Texture },
    uUseMap: { value: 0 },
    uPortraits: { value: placeholderTransparentTexture() as THREE.Texture },
    uTokenParams: { value: new THREE.Vector4(TOKEN_RIM.strength, TOKEN_RIM.exponent, TOKEN_RIM.lift, 0) },
  }
  const material = new THREE.ShaderMaterial({
    name: `atlas-token${opts.instanced ? ":instanced" : ""}`,
    glslVersion: THREE.GLSL3,
    vertexShader: TOKEN_VERTEX_SHADER,
    fragmentShader: TOKEN_FRAGMENT_SHADER,
    uniforms: { ...ctx.shared, ...own },
    depthTest: true,
    depthWrite: true,
  })
  setDefaultAttributes(material, { color: [1, 1, 1], aDim: [0], aFade: [1], aPortrait: [0, 0, 0, 0] })
  material.userData.atlas = { kind: "token", instanced: opts.instanced }
  ctx.tiers?.track(material)

  material.onBeforeRender = (_renderer, _scene, _camera, geometry, object) => {
    const ud = object.userData as { tokenId?: unknown; levelId?: unknown; opacity?: unknown; tokenIds?: unknown }
    let changed = false
    const dim = typeof ud.tokenId === "string" && ctx.isDimmed(ud.tokenId) ? 1 : 0
    if (own.uDim.value !== dim) {
      own.uDim.value = dim
      changed = true
    }
    const layer = typeof ud.levelId === "string" ? ctx.layerOf(ud.levelId) : -1
    if (own.uLevelLayer.value !== layer) {
      own.uLevelLayer.value = layer
      changed = true
    }
    const opacity = typeof ud.opacity === "number" ? Math.min(1, Math.max(0, ud.opacity)) : 1
    if (own.uOpacity.value !== opacity) {
      own.uOpacity.value = opacity
      changed = true
    }
    if (Array.isArray(ud.tokenIds) && (object as THREE.InstancedMesh).isInstancedMesh) {
      syncInstanceDim(geometry, ud.tokenIds as unknown[], ctx)
    }
    // Several objects share this material: force a uniform upload when the per-object values change.
    if (changed) material.uniformsNeedUpdate = true
  }
  keepSharedOnClone(material, () => createTokenMaterial(ctx, opts))
  return material
}

/** Keep the per-instance `aDim` attribute in step with the dimmed set. */
export function syncInstanceDim(geometry: THREE.BufferGeometry, tokenIds: unknown[], ctx: Pick<TokenMaterialContext, "isDimmed">): void {
  let attr = geometry.getAttribute("aDim") as THREE.InstancedBufferAttribute | undefined
  if (!attr || !(attr as THREE.InstancedBufferAttribute).isInstancedBufferAttribute || attr.count < tokenIds.length) {
    attr = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(tokenIds.length, 1)), 1)
    attr.setUsage(THREE.DynamicDrawUsage)
    geometry.setAttribute("aDim", attr)
  }
  const arr = attr.array as Float32Array
  let dirty = false
  for (let k = 0; k < tokenIds.length; k++) {
    const id = tokenIds[k]
    const v = typeof id === "string" && ctx.isDimmed(id) ? 1 : 0
    if (arr[k] !== v) {
      arr[k] = v
      dirty = true
    }
  }
  if (dirty) attr.needsUpdate = true
}
