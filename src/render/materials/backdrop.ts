/**
 * Per-level backdrop uniforms of the world material (ARCHITECTURE §9): one object per level, shared by
 * every world-material variant of that level, so setting or removing a level image is a uniform update
 * (never a recompile: a transparent 1×1 placeholder stays bound while a level has no image).
 */
import * as THREE from "three"

import type { Rect } from "@/core/scene/types"
import { placeholderTransparentTexture } from "./placeholders"

export interface BackdropUniforms {
  [name: string]: THREE.IUniform
  uBackdrop: THREE.IUniform<THREE.Texture>
  /** x0, z0 (feet), 1 / width, 1 / depth. */
  uBackdropRect: THREE.IUniform<THREE.Vector4>
  /** x = opacity (0 = none), y = tint walls (0/1). */
  uBackdropParams: THREE.IUniform<THREE.Vector4>
}

export function createBackdropUniforms(): BackdropUniforms {
  return {
    uBackdrop: { value: placeholderTransparentTexture() },
    uBackdropRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    uBackdropParams: { value: new THREE.Vector4(0, 0, 0, 0) },
  }
}

/** Point the uniforms at an image (null texture or rect: none). */
export function setBackdropUniforms(u: BackdropUniforms, texture: THREE.Texture | null, rect: Rect | null, opacity: number, tintWalls: boolean): void {
  if (!texture || !rect || !(rect.w > 0) || !(rect.d > 0)) {
    u.uBackdrop.value = placeholderTransparentTexture()
    u.uBackdropParams.value.set(0, 0, 0, 0)
    return
  }
  u.uBackdrop.value = texture
  u.uBackdropRect.value.set(rect.x, rect.z, 1 / rect.w, 1 / rect.d)
  u.uBackdropParams.value.set(Math.min(1, Math.max(0, opacity)), tintWalls ? 1 : 0, 0, 0)
}
