/**
 * Materials for the occluder proxy passes (ARCHITECTURE §4.2): the linear-distance material of the
 * cube captures and the depth-only material of the sun / sky maps. Both render BackSide (closed
 * volumes, second depth) and never blend (R32F targets are not blendable without EXT_float_blend).
 */
import * as THREE from "three"

import { OCCLUDER_DEPTH_FRAGMENT_SHADER, OCCLUDER_DISTANCE_FRAGMENT_SHADER, OCCLUDER_VERTEX_SHADER } from "./glsl/occluder"
import { REENCODE_FRAGMENT_SHADER, REENCODE_VERTEX_SHADER } from "./glsl/reencode"
import { setDefaultAttributes } from "./util"

/** Unused exclusion slot. Real keys are ≥ 0; the attribute default (no aKey) is −3, matching nothing. */
export const EXCLUDE_NONE = -1
const DEFAULT_KEY = -3

export function createOccluderDistanceMaterial(): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    name: "atlas-occluder-distance",
    glslVersion: THREE.GLSL3,
    vertexShader: OCCLUDER_VERTEX_SHADER,
    fragmentShader: OCCLUDER_DISTANCE_FRAGMENT_SHADER,
    uniforms: {
      uSource: { value: new THREE.Vector3() },
      uExclude: { value: new THREE.Vector4(EXCLUDE_NONE, EXCLUDE_NONE, EXCLUDE_NONE, EXCLUDE_NONE) },
    },
    side: THREE.BackSide,
    blending: THREE.NoBlending,
    depthTest: true,
    depthWrite: true,
  })
  setDefaultAttributes(m, { aKey: [DEFAULT_KEY] })
  return m
}

export function createOccluderDepthMaterial(): THREE.ShaderMaterial {
  const m = new THREE.ShaderMaterial({
    name: "atlas-occluder-depth",
    glslVersion: THREE.GLSL3,
    vertexShader: OCCLUDER_VERTEX_SHADER,
    fragmentShader: OCCLUDER_DEPTH_FRAGMENT_SHADER,
    uniforms: {
      uExclude: { value: new THREE.Vector4(EXCLUDE_NONE, EXCLUDE_NONE, EXCLUDE_NONE, EXCLUDE_NONE) },
    },
    side: THREE.BackSide,
    blending: THREE.NoBlending,
    colorWrite: false,
    depthTest: true,
    depthWrite: true,
  })
  setDefaultAttributes(m, { aKey: [DEFAULT_KEY] })
  return m
}

export function createReencodeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "atlas-octahedral-reencode",
    glslVersion: THREE.GLSL3,
    vertexShader: REENCODE_VERTEX_SHADER,
    fragmentShader: REENCODE_FRAGMENT_SHADER,
    uniforms: {
      uCube: { value: null as THREE.Texture | null },
      uTileOrigin: { value: new THREE.Vector2() },
      uTileSize: { value: 512 },
    },
    side: THREE.DoubleSide,
    blending: THREE.NoBlending,
    depthTest: false,
    depthWrite: false,
  })
}

/** Full-screen triangle in clip space (the re-encode vertex shader passes xy through). */
export function createFullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
  return g
}
