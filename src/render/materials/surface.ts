/**
 * Procedural surface materials: the ids world meshes carry in their `aMat` vertex attribute (see
 * builders/writer.ts) and the world shader's detail functions switch on (glsl/detail.ts). Values are
 * mirrored by the AT_MAT_* defines; keep both in sync (glsl.test.ts checks it).
 */
import * as THREE from "three"

import type { DoorStyle, MaterialId } from "@/core/scene/types"

export const MAT = {
  NONE: 0,
  STONE: 1,
  BRICK: 2,
  WOOD: 3,
  PLASTER: 4,
  DIRT: 5,
  GRASS: 6,
  SAND: 7,
  WATER: 8,
  METAL: 9,
  MARBLE: 10,
  TILE: 11,
  COBBLE: 12,
  /** Leaves (tree canopies, bushes). */
  FOLIAGE: 13,
  /** Linen, cloth. */
  FABRIC: 14,
  /** Rough natural rock (boulders, cave walls). */
  ROCK: 15,
} as const

export type SurfaceMaterial = (typeof MAT)[keyof typeof MAT]

const BY_ID: Record<MaterialId, SurfaceMaterial> = {
  stone: MAT.STONE,
  brick: MAT.BRICK,
  wood: MAT.WOOD,
  plaster: MAT.PLASTER,
  dirt: MAT.DIRT,
  grass: MAT.GRASS,
  sand: MAT.SAND,
  water: MAT.WATER,
  metal: MAT.METAL,
  marble: MAT.MARBLE,
  tile: MAT.TILE,
  cobble: MAT.COBBLE,
}

/** Surface material of a scene material id (unknown ids: plain albedo). */
export function surfaceOf(id: MaterialId | string | undefined): SurfaceMaterial {
  return (id !== undefined && Object.hasOwn(BY_ID, id) ? BY_ID[id as MaterialId] : MAT.NONE) as SurfaceMaterial
}

/** Door leaves: wooden styles are planks, iron-bound styles are metal; secret doors match their wall. */
export function doorSurface(style: DoorStyle, wallMaterial: MaterialId): SurfaceMaterial {
  if (style === "secret") return surfaceOf(wallMaterial)
  return style === "wood" ? MAT.WOOD : MAT.METAL
}

type Row = [number, number, number, number]

/**
 * Procedural detail parameters per surface material (MAT id order), uploaded once as the world shader's
 * `uMatTable` (glsl/detail.ts documents the six rows):
 *   pattern up, pattern face, cell (tint, grout colour, grout depth, gloss), low band (macro, scale,
 *   amount, relief), fine band (scale u, scale v, amount, feature size), misc (hue swing, flow speed).
 */
export const SURFACE_TABLE: readonly (readonly [Row, Row, Row, Row, Row, Row])[] = [
  // none
  [[0, 1, 1, 0], [0, 1, 1, 0], [0, 1, 0, 0], [0, 1, 0, 0], [1, 1, 0, 1], [0, 0, 0, 0]],
  // stone
  [[1, 2.5, 2.5, 0.14], [1, 2, 1, 0.12], [0.26, 0.5, 0.03, 0.06], [0.08, 1.1, 0.2, 0.015], [3, 3, 0.06, 0.3], [0.06, 0, 0, 0]],
  // brick
  [[1, 1, 0.5, 0.05], [1, 0.75, 0.25, 0.04], [0.3, 0.66, 0.02, 0.04], [0.06, 0.8, 0.1, 0], [3, 3, 0.16, 0.3], [0.1, 0, 0, 0]],
  // wood
  [[3, 5, 0.6, 0.035], [3, 5, 0.6, 0.035], [0.28, 0.55, 0.012, 0.08], [0.06, 0.5, 0.08, 0], [0.8, 11, 0.22, 0.12], [0.1, 0, 0, 0]],
  // plaster
  [[0, 1, 1, 0], [0, 1, 1, 0], [0, 1, 0, 0], [0.05, 0.45, 0.14, 0.02], [5, 5, 0.05, 0.25], [0.02, 0, 0, 0]],
  // dirt
  [[0, 1, 1, 0], [0, 1, 1, 0], [0, 1, 0, 0], [0.14, 0.35, 0.34, 0.04], [5, 5, 0.1, 0.25], [0.08, 0, 0, 0]],
  // grass
  [[0, 1, 1, 0], [0, 1, 1, 0], [0, 1, 0, 0], [0.3, 0.7, 0.34, 0.04], [7, 7, 0.22, 0.14], [0.35, 0, 0, 0]],
  // sand
  [[0, 1, 1, 0], [0, 1, 1, 0], [0, 1, 0, 0], [0.1, 0.3, 0.1, 0.02], [4, 4, 0.06, 0.3], [0.04, 0, 0, 0]],
  // water
  [[0, 1, 1, 0], [0, 1, 1, 0], [0, 1, 0, 0.85], [0, 0.32, 0.45, 0.16], [0.85, 0.85, 0.3, 1], [0, 0.06, 0, 0]],
  // metal
  [[0, 1, 1, 0], [0, 1, 1, 0], [0, 1, 0, 0.5], [0, 0.8, 0.2, 0], [0.6, 24, 0.14, 0.05], [0, 0, 0, 0]],
  // marble
  [[2, 5, 5, 0.04], [2, 5, 5, 0.04], [0.04, 0.8, 0.002, 0.6], [0.05, 0.5, 0.05, 0], [2, 2, 0.03, 0.3], [0, 0, 0, 0]],
  // tile
  [[2, 2.5, 2.5, 0.09], [2, 2.5, 2.5, 0.09], [0.2, 0.5, 0.008, 0.22], [0.04, 1.1, 0.1, 0], [3, 3, 0.05, 0.3], [0.04, 0, 0, 0]],
  // cobble
  [[1, 1.1, 0.9, 0.14], [1, 1.1, 0.9, 0.14], [0.34, 0.45, 0.05, 0.05], [0.08, 3.1, 0.12, 0], [3.1, 3.1, 0.12, 0.3], [0.06, 0, 0, 0]],
  // foliage
  [[0, 1, 1, 0], [0, 1, 1, 0], [0, 1, 0, 0], [0.2, 0.9, 0.4, 0.1], [2.2, 2.2, 0.3, 0.4], [0.25, 0, 0, 0]],
  // fabric
  [[0, 1, 1, 0], [0, 1, 1, 0], [0, 1, 0, 0], [0, 1.5, 0.08, 0], [38, 38, 0.05, 0.08], [0, 0, 0, 0]],
  // rock
  [[0, 1, 1, 0], [0, 1, 1, 0], [0, 1, 0, 0], [0.1, 0.7, 0.4, 0.1], [4, 4, 0.1, 0.3], [0.04, 0, 0, 0]],
]

export const SURFACE_TABLE_ROWS = 6

let tableUniform: THREE.IUniform<Float32Array> | null = null

/** The shared `uMatTable` uniform (vec4 × 6 per material). */
export function surfaceTableUniform(): THREE.IUniform<Float32Array> {
  if (!tableUniform) {
    const data = new Float32Array(SURFACE_TABLE.length * SURFACE_TABLE_ROWS * 4)
    SURFACE_TABLE.forEach((rows, m) => rows.forEach((row, k) => data.set(row, (m * SURFACE_TABLE_ROWS + k) * 4)))
    tableUniform = { value: data }
  }
  return tableUniform
}

let noise: THREE.DataTexture | null = null

/**
 * The detail shader's noise source: 256² RGBA of independent uniform random bytes (deterministic),
 * repeat-wrapped with bilinear filtering and no mipmaps (the shader fades sub-pixel detail itself).
 */
export function noiseTexture(): THREE.DataTexture {
  if (!noise) {
    const size = 256
    const data = new Uint8Array(size * size * 4)
    // xorshift32: the same texture on every client.
    let x = 0x9e3779b9
    for (let k = 0; k < data.length; k++) {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      data[k] = (x >>> 0) & 255
    }
    noise = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType)
    noise.wrapS = THREE.RepeatWrapping
    noise.wrapT = THREE.RepeatWrapping
    noise.minFilter = THREE.LinearFilter
    noise.magFilter = THREE.LinearFilter
    noise.generateMipmaps = false
    noise.colorSpace = THREE.NoColorSpace
    noise.name = "atlas-detail-noise"
    noise.needsUpdate = true
  }
  return noise
}
