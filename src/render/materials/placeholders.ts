/**
 * 1×1 placeholder textures bound whenever a sampler has nothing real to read yet.
 *
 * three.js falls back to internal empty textures for null sampler uniforms, but those are never uploaded
 * (version 0), so the unit ends up with no texture. For `sampler2DShadow` that is a draw-time GL error
 * ("mismatch between texture format and sampler type") and the draw is dropped; for the other samplers
 * it relies on incomplete-texture behaviour. These placeholders are real, uploaded textures of the right
 * kind (depth + compare mode, float, RGBA array, unsigned integer), shared by every material. They outlive engines, so
 * they are registered with engine/sharedResources (released when an engine is disposed).
 */
import * as THREE from "three"

import { trackShared } from "../engine/sharedResources"

let shadow: THREE.DepthTexture | null = null
let float: THREE.DataTexture | null = null
let maskArray: THREE.DataArrayTexture | null = null
let white: THREE.DataTexture | null = null
let transparent: THREE.DataTexture | null = null
let allBits: THREE.DataTexture | null = null

/** Depth texture with compare mode, for sampler2DShadow uniforms (sun / sky before their first render). */
export function placeholderShadowTexture(): THREE.DepthTexture {
  if (!shadow) {
    shadow = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType)
    shadow.compareFunction = THREE.LessEqualCompare
    shadow.minFilter = THREE.NearestFilter
    shadow.magFilter = THREE.NearestFilter
    shadow.name = "atlas-placeholder-shadow"
    shadow.needsUpdate = true
    trackShared(shadow)
  }
  return shadow
}

/** R32F texel holding "no occluder", for distance-atlas samplers without an atlas (low tier). */
export function placeholderFloatTexture(): THREE.DataTexture {
  if (!float) {
    float = new THREE.DataTexture(new Float32Array([1e6]), 1, 1, THREE.RedFormat, THREE.FloatType)
    float.minFilter = THREE.NearestFilter
    float.magFilter = THREE.NearestFilter
    float.name = "atlas-placeholder-float"
    float.needsUpdate = true
    trackShared(float)
  }
  return float
}

/** One all-zero RGBA layer (nothing perceived / explored), for uMasks before any mask exists. */
export function placeholderMaskTexture(): THREE.DataArrayTexture {
  if (!maskArray) {
    maskArray = new THREE.DataArrayTexture(new Uint8Array(4), 1, 1, 1)
    maskArray.format = THREE.RGBAFormat
    maskArray.type = THREE.UnsignedByteType
    maskArray.minFilter = THREE.LinearFilter
    maskArray.magFilter = THREE.LinearFilter
    maskArray.name = "atlas-placeholder-masks"
    maskArray.needsUpdate = true
    trackShared(maskArray)
  }
  return maskArray
}

/** Opaque white, for optional colour maps. */
export function placeholderWhiteTexture(): THREE.DataTexture {
  if (!white) {
    white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat)
    white.name = "atlas-placeholder-white"
    white.needsUpdate = true
    trackShared(white)
  }
  return white
}

/** Fully transparent texel, for optional overlay images (level backdrops, token portraits). */
export function placeholderTransparentTexture(): THREE.DataTexture {
  if (!transparent) {
    transparent = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat)
    transparent.name = "atlas-placeholder-transparent"
    transparent.needsUpdate = true
    trackShared(transparent)
  }
  return transparent
}

/** R32UI texel with every bit set, for the point-light slot mask before one is built (no culling). */
export function placeholderLightMaskTexture(): THREE.DataTexture {
  if (!allBits) {
    allBits = lightMaskTexture(new Uint32Array([0xffffffff]), 1, 1)
    allBits.name = "atlas-placeholder-light-mask"
    trackShared(allBits)
  }
  return allBits
}

/** An R32UI DataTexture (usampler2D, nearest, no mipmaps) over `bits` (row-major, width × height). */
export function lightMaskTexture(bits: Uint32Array, width: number, height: number): THREE.DataTexture {
  const t = new THREE.DataTexture(bits, width, height, THREE.RedIntegerFormat, THREE.UnsignedIntType)
  t.internalFormat = "R32UI"
  t.minFilter = THREE.NearestFilter
  t.magFilter = THREE.NearestFilter
  t.generateMipmaps = false
  t.name = "atlas-light-mask"
  t.needsUpdate = true
  return t
}
