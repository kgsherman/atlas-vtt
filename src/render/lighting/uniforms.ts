/**
 * Global uniforms shared (by reference) between every world and token material, and the packed
 * layouts of the light / viewer uniform arrays. The GLSL side is render/materials/glsl/common.ts.
 *
 * Light slot i occupies uLights[4i .. 4i+3]:
 *   [0] xyz = current world position, w = dim radius
 *   [1] rgb = linear colour × intensity × flicker, w = bright radius
 *   [2] xy = atlas texel of the tile (guard included), z = tile size (0 = unshadowed), w = flags
 *   [3] xyz = capture origin of the tile (shadows are measured from it), w = 0
 * Viewer slot v occupies uViewers[3v .. 3v+2]:
 *   [0] xyz = current resolved eye, w = darkvision range
 *   [1] xy = atlas texel of the LOS tile, z = tile size (0 = no tile: cannot refine), w = blindsight range
 *   [2] xyz = capture origin of the LOS tile, w = capture range (far plane)
 */
import * as THREE from "three"

import type { Vec3 } from "@/core/scene/types"
import { placeholderFloatTexture, placeholderMaskTexture, placeholderShadowTexture } from "../materials/placeholders"

export const MAX_LIGHTS = 32
export const MAX_VIEWERS = 8
export const LIGHT_VEC4S = 4
export const VIEWER_VEC4S = 3

/** Light flag bits (uLights[4i+2].w). */
export const LIGHT_FLAG_WIDE_PCF = 1

/** Rules light level as the shaders' numeric level (uEnvLevels). */
export const LIGHT_LEVEL_NUMBER = { dark: 0, dim: 1, bright: 2 } as const

/** uEnvLevels.w flag bits. */
export const ENV_FLAG_SKY_MAP = 1
export const ENV_FLAG_SUN_MAP = 2

/** Vision modes as the shader's uVisionMode int. */
export const VISION_MODE = { off: 0, fog: 1, preview: 2 } as const

export interface PackedTile {
  x: number
  y: number
  size: number
}

export interface PackedLight {
  position: Vec3
  dim: number
  bright: number
  /** Linear colour already multiplied by intensity × flicker. */
  radiance: [number, number, number]
  /** null = unshadowed (castsShadows false). */
  tile: PackedTile | null
  capture: Vec3 | null
  widePcf: boolean
}

export function packLight(out: Float32Array, slot: number, l: PackedLight): void {
  const o = slot * LIGHT_VEC4S * 4
  out[o] = l.position.x
  out[o + 1] = l.position.y
  out[o + 2] = l.position.z
  out[o + 3] = l.dim
  out[o + 4] = l.radiance[0]
  out[o + 5] = l.radiance[1]
  out[o + 6] = l.radiance[2]
  out[o + 7] = l.bright
  out[o + 8] = l.tile ? l.tile.x : 0
  out[o + 9] = l.tile ? l.tile.y : 0
  out[o + 10] = l.tile ? l.tile.size : 0
  out[o + 11] = l.widePcf ? LIGHT_FLAG_WIDE_PCF : 0
  const c = l.capture ?? l.position
  out[o + 12] = c.x
  out[o + 13] = c.y
  out[o + 14] = c.z
  out[o + 15] = 0
}

export interface PackedViewer {
  eye: Vec3
  darkvision: number
  blindsight: number
  tile: PackedTile | null
  capture: Vec3 | null
  far: number
}

export function packViewer(out: Float32Array, slot: number, v: PackedViewer): void {
  const o = slot * VIEWER_VEC4S * 4
  out[o] = v.eye.x
  out[o + 1] = v.eye.y
  out[o + 2] = v.eye.z
  out[o + 3] = v.darkvision
  out[o + 4] = v.tile ? v.tile.x : 0
  out[o + 5] = v.tile ? v.tile.y : 0
  out[o + 6] = v.tile ? v.tile.size : 0
  out[o + 7] = v.blindsight
  const c = v.capture ?? v.eye
  out[o + 8] = c.x
  out[o + 9] = c.y
  out[o + 10] = c.z
  out[o + 11] = v.far
}

export interface SharedUniforms {
  [name: string]: THREE.IUniform
  uLights: THREE.IUniform<Float32Array>
  uLightCount: THREE.IUniform<number>
  uLightAtlas: THREE.IUniform<THREE.Texture | null>
  /** Fill under cover: ambientColor × (ambientIntensity + levelFill(ambientLevel)). */
  uAmbient: THREE.IUniform<THREE.Color>
  /** Fill where the sky is exposed: ambientColor × (ambientIntensity + levelFill(skyLevel)). */
  uSkyAmbient: THREE.IUniform<THREE.Color>
  uSkyMatrix: THREE.IUniform<THREE.Matrix4>
  uSkyShadow: THREE.IUniform<THREE.Texture | null>
  /** x = texel size (uv), y = depth bias (0..1 depth units), z = normal offset (ft), w = enabled (0/1). */
  uSkyParams: THREE.IUniform<THREE.Vector4>
  /** Unit vector toward the sun/moon. */
  uSunDir: THREE.IUniform<THREE.Vector3>
  /** Linear colour × intensity; black when disabled. */
  uSunColor: THREE.IUniform<THREE.Color>
  uSunMatrix: THREE.IUniform<THREE.Matrix4>
  uSunShadow: THREE.IUniform<THREE.Texture | null>
  /** x = texel size (uv), y = depth bias, z = reversed depth buffer (0/1), w = normal offset (ft). */
  uSunParams: THREE.IUniform<THREE.Vector4>
  /**
   * Rules light levels (0 dark, 1 dim, 2 bright) for the per-pixel perception refinement: x = ambient
   * (under cover), y = sky, z = sun/moon grants (0 when off), w = flags: +1 sky-exposure map rendered,
   * +2 sun map rendered (without a map the shader assumes the level is reached).
   */
  uEnvLevels: THREE.IUniform<THREE.Vector4>
  uViewers: THREE.IUniform<Float32Array>
  uViewerCount: THREE.IUniform<number>
  uViewerAtlas: THREE.IUniform<THREE.Texture | null>
  uVisionMode: THREE.IUniform<number>
  /** 1 = per-pixel LOS refinement against the viewer atlas. */
  uGpuRefine: THREE.IUniform<number>
  uMasks: THREE.IUniform<THREE.Texture | null>
  /** x = 1/(width·cellSize), y = 1/(depth·cellSize), z = texture width, w = texture height (texels). */
  uMaskGrid: THREE.IUniform<THREE.Vector4>
}

/** Sampler uniforms start on real placeholder textures (see materials/placeholders), never null. */
export function createSharedUniforms(): SharedUniforms {
  return {
    uLights: { value: new Float32Array(MAX_LIGHTS * LIGHT_VEC4S * 4) },
    uLightCount: { value: 0 },
    uLightAtlas: { value: placeholderFloatTexture() },
    uAmbient: { value: new THREE.Color(0, 0, 0) },
    uSkyAmbient: { value: new THREE.Color(0, 0, 0) },
    uSkyMatrix: { value: new THREE.Matrix4() },
    uSkyShadow: { value: placeholderShadowTexture() },
    uSkyParams: { value: new THREE.Vector4(0, 0, 0, 0) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(0, 0, 0) },
    uSunMatrix: { value: new THREE.Matrix4() },
    uSunShadow: { value: placeholderShadowTexture() },
    uSunParams: { value: new THREE.Vector4(0, 0, 0, 0) },
    uEnvLevels: { value: new THREE.Vector4(0, 0, 0, 0) },
    uViewers: { value: new Float32Array(MAX_VIEWERS * VIEWER_VEC4S * 4) },
    uViewerCount: { value: 0 },
    uViewerAtlas: { value: placeholderFloatTexture() },
    uVisionMode: { value: VISION_MODE.off },
    uGpuRefine: { value: 0 },
    uMasks: { value: placeholderMaskTexture() },
    uMaskGrid: { value: new THREE.Vector4(0, 0, 1, 1) },
  }
}
