/**
 * Global uniforms shared (by reference) between every world and token material, and the packed
 * layouts of the light / viewer uniform arrays. The GLSL side is render/materials/glsl/common.ts.
 *
 * Light slot i occupies uLights[4i .. 4i+3]:
 *   [0] xyz = current world position, w = dim radius
 *   [1] rgb = linear colour × intensity × flicker, w = bright radius
 *   [2] xy = atlas texel of the tile (guard included), z = tile size (0 = unshadowed), w = flags
 *       (LIGHT_FLAG_*: wide PCF, tile in the hi-res atlas, soft shadows)
 *   [3] xyz = capture origin of the tile (shadows are measured from it), w = source radius (ft)
 * Eye slot v occupies uViewers[3v .. 3v+2] (a viewer has one slot per eye, core/vision viewerEyesAtGround;
 * every slot carries its viewer's senses, perception is the union over slots):
 *   [0] xyz = current resolved eye, w = darkvision range
 *   [1] xy = atlas texel of the LOS tile, z = tile size (0 = no tile: cannot refine), w = blindsight range
 *   [2] xyz = capture origin of the LOS tile, w = unused
 * Viewer t occupies uTouch[t]: xy = its footprint cells' centre (x, z), z = half-extent. The viewer perceives
 * those cells by touch whatever its senses (core/vision), inside the square max(|dx|, |dz|) ≤ z around it.
 */
import * as THREE from "three"

import type { Vec3 } from "@/core/scene/types"
import { placeholderFloatTexture, placeholderLightMaskTexture, placeholderMaskTexture, placeholderShadowTexture } from "../materials/placeholders"

export const MAX_LIGHTS = 32
/** Viewers (tokens) the shaders know about: touch squares, and at most MAX_EYE_SLOTS eyes between them. */
export const MAX_VIEWERS = 8
/** Line-of-sight eye slots: one per eye, up to 5 per viewer ("square" vision). */
export const MAX_EYE_SLOTS = 40
export const LIGHT_VEC4S = 4
export const VIEWER_VEC4S = 3

/** Light flag bits (uLights[4i+2].w). */
export const LIGHT_FLAG_WIDE_PCF = 1
/** The tile lives in the hi-res light atlas (uLightAtlasHi, ultra tier). */
export const LIGHT_FLAG_HI_ATLAS = 2
/** PCSS-style soft shadows (ultra tier). */
export const LIGHT_FLAG_SOFT = 4

/** Rules light level as the shaders' numeric level (uEnvLevels). */
export const LIGHT_LEVEL_NUMBER = { dark: 0, dim: 1, bright: 2 } as const

/** uEnvLevels.w flag bits. */
export const ENV_FLAG_SKY_MAP = 1
export const ENV_FLAG_SUN_MAP = 2

/** Period of the DM dark vision stripes, CSS pixels (scaled by the pixel ratio each frame). */
export const DARK_VISION_STRIPE_PX = 10

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
  /** Tile in the hi-res atlas (ultra). */
  hiAtlas?: boolean
  /** Soft (PCSS) shadows with this light source radius in feet (ultra); 0 / undefined = hard. */
  softRadius?: number
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
  const soft = (l.softRadius ?? 0) > 0
  out[o + 11] = (l.widePcf ? LIGHT_FLAG_WIDE_PCF : 0) + (l.hiAtlas ? LIGHT_FLAG_HI_ATLAS : 0) + (soft ? LIGHT_FLAG_SOFT : 0)
  const c = l.capture ?? l.position
  out[o + 12] = c.x
  out[o + 13] = c.y
  out[o + 14] = c.z
  out[o + 15] = soft ? (l.softRadius ?? 0) : 0
}

export interface PackedEye {
  eye: Vec3
  darkvision: number
  blindsight: number
  tile: PackedTile | null
  capture: Vec3 | null
}

export function packEye(out: Float32Array, slot: number, v: PackedEye): void {
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
  out[o + 11] = 0
}

/** A viewer's touch square: centre (x, z) and half-extent (ft). */
export function packTouch(out: Float32Array, slot: number, x: number, z: number, half: number): void {
  const o = slot * 4
  out[o] = x
  out[o + 1] = z
  out[o + 2] = half
  out[o + 3] = 0
}

export interface SharedUniforms {
  [name: string]: THREE.IUniform
  uLights: THREE.IUniform<Float32Array>
  uLightCount: THREE.IUniform<number>
  uLightAtlas: THREE.IUniform<THREE.Texture | null>
  /** Hi-res light atlas (ultra: 1024² tiles), a placeholder on the other tiers. */
  uLightAtlasHi: THREE.IUniform<THREE.Texture | null>
  /**
   * Per-cell point-light slot mask (R32UI, lighting/lightMask.ts): bit i = slot i's dim disc reaches the
   * cell. Grid: x, y = world XZ of its corner, z = 1 / cell size, w = 1 when a mask is bound (0 = every
   * slot is tested, the placeholder).
   */
  uLightMask: THREE.IUniform<THREE.Texture>
  uLightMaskGrid: THREE.IUniform<THREE.Vector4>
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
  /** Eye slots (MAX_EYE_SLOTS × 3 vec4) and how many are set. */
  uViewers: THREE.IUniform<Float32Array>
  uViewerCount: THREE.IUniform<number>
  /** Touch squares, one per viewer (MAX_VIEWERS vec4), and how many are set. */
  uTouch: THREE.IUniform<Float32Array>
  uTouchCount: THREE.IUniform<number>
  /**
   * 1 when uViewers holds every eye of every viewer (at most MAX_VIEWERS viewers, MAX_EYE_SLOTS eyes).
   * Per-pixel tests that remove perception (GPU line of sight, the senses' ranges) need all of them: with
   * more they are skipped.
   */
  uViewersAll: THREE.IUniform<number>
  uViewerAtlas: THREE.IUniform<THREE.Texture | null>
  uVisionMode: THREE.IUniform<number>
  /** 1 = per-pixel LOS refinement against the viewer atlas. */
  uGpuRefine: THREE.IUniform<number>
  /** 1 = grid fog (whole cells, no per-pixel perception refinement), 0 = smooth (render/fog/maskExpand). */
  uFogGrid: THREE.IUniform<number>
  uMasks: THREE.IUniform<THREE.Texture | null>
  /** x = 1/(width·cellSize), y = 1/(depth·cellSize), z = texture width, w = texture height (texels). */
  uMaskGrid: THREE.IUniform<THREE.Vector4>
  /** Seconds, wrapped (animated surfaces). */
  uTime: THREE.IUniform<number>
  /** x = emissive scale (flames, glows), y = glow sprite strength, z = HDR post target (0/1). */
  uRenderParams: THREE.IUniform<THREE.Vector4>
  /** World Y of the cutaway plane (underside of the slab above the active level); 1e9 = no cutaway. */
  uCutawayY: THREE.IUniform<number>
  /** DM dark vision: x = on (0/1), y = stripe period in drawing-buffer pixels. */
  uDarkVision: THREE.IUniform<THREE.Vector2>
}

/** Sampler uniforms start on real placeholder textures (see materials/placeholders), never null. */
export function createSharedUniforms(): SharedUniforms {
  return {
    uLights: { value: new Float32Array(MAX_LIGHTS * LIGHT_VEC4S * 4) },
    uLightCount: { value: 0 },
    uLightAtlas: { value: placeholderFloatTexture() },
    uLightAtlasHi: { value: placeholderFloatTexture() },
    uLightMask: { value: placeholderLightMaskTexture() },
    uLightMaskGrid: { value: new THREE.Vector4(0, 0, 0, 0) },
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
    uViewers: { value: new Float32Array(MAX_EYE_SLOTS * VIEWER_VEC4S * 4) },
    uViewerCount: { value: 0 },
    uTouch: { value: new Float32Array(MAX_VIEWERS * 4) },
    uTouchCount: { value: 0 },
    uViewersAll: { value: 1 },
    uViewerAtlas: { value: placeholderFloatTexture() },
    uVisionMode: { value: VISION_MODE.off },
    uGpuRefine: { value: 0 },
    uFogGrid: { value: 0 },
    uMasks: { value: placeholderMaskTexture() },
    uMaskGrid: { value: new THREE.Vector4(0, 0, 1, 1) },
    uTime: { value: 0 },
    uRenderParams: { value: new THREE.Vector4(1, 0.5, 0, 0) },
    uCutawayY: { value: 1e9 },
    uDarkVision: { value: new THREE.Vector2(0, DARK_VISION_STRIPE_PX) },
  }
}
