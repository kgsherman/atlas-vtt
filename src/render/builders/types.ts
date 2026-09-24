/**
 * Output of the level builders: material-agnostic mesh descriptions that the engine turns into
 * three.js meshes (world material per level, token material, glass/flame overlay materials). Keeping
 * builders free of materials lets the same code produce the paste preview ("ghost-objects") and
 * makes them unit-testable in Node.
 */
import type * as THREE from "three"

import type { FlickerSettings, Id } from "@/core/scene/types"

import type { DoorLeaf } from "./doors"

/** Independently rebuilt parts of a level (see engine/levels.ts for the invalidation rules). */
export type BucketKind = "floors" | "walls" | "doors" | "connectors" | "pillars" | "props" | "fixtures"

export const BUCKETS: readonly BucketKind[] = ["floors", "walls", "doors", "connectors", "pillars", "props", "fixtures"]

/** Engine material a mesh is drawn with. */
export type MaterialSlot =
  /** lighting.createWorldMaterial for the mesh's level (opaque / ghost variants). */
  | "world"
  /** lighting.createTokenMaterial (tokens and light-fixture holders; level independent). */
  | "token"
  /** Faint translucent window glass (unlit overlay material). */
  | "glass"
  /** Emissive light-fixture flames (unlit, light colour). */
  | "flame"

/**
 * The vertices of a terrain mesh by lattice sample row (floors.ts updateTerrainGeometry): the vertices on
 * sample row sz are order[rowStart[sz − sz0] .. rowStart[sz − sz0 + 1]), in ascending x.
 */
export interface TerrainRows {
  sz0: number
  rowStart: Int32Array
  order: Uint32Array
}

/**
 * A merged geometry (position, normal, color, aSurf; userData.ranges → object ids, by triangle).
 * Non-indexed, except terrain meshes, whose tops share vertices.
 */
export interface MergedBuild {
  kind: "merged"
  name: string
  slot: MaterialSlot
  geometry: THREE.BufferGeometry
  /** Terrain floors only: per-vertex Y offset from the ground, for in-place terrain previews. */
  terrainOffsets?: Float32Array
  /** Terrain floors only: the vertices by lattice row, for in-place terrain previews. */
  terrainRows?: TerrainRows
}

/** Per-instance flicker of a fixture flame (visual only; radii never flicker). */
export interface FlameAnimation {
  flicker: FlickerSettings
  /** Deterministic phase so neighbouring flames do not pulse in sync. */
  phase: number
  on: boolean
}

/** Instances of a shared unit geometry (geometry.userData.shared = true: owned by the builder cache). */
export interface InstancedBuild {
  kind: "instanced"
  name: string
  slot: MaterialSlot
  geometry: THREE.BufferGeometry
  /** 16 floats per instance (column-major matrix). */
  matrices: Float32Array
  /** 3 floats per instance, linear RGB. */
  colors: Float32Array
  ids: Id[]
  flames?: FlameAnimation[]
}

/** One door leaf: geometry in the leaf's pivot frame + how it moves. */
export interface DoorLeafBuild {
  kind: "door"
  name: string
  slot: "world"
  leaf: DoorLeaf
  geometry: THREE.BufferGeometry
  /** Top-down marker in the same pivot frame (builders/doors.ts doorMarkerGeometry), null if degenerate. */
  marker: THREE.BufferGeometry | null
}

export type MeshBuild = MergedBuild | InstancedBuild | DoorLeafBuild

export interface BucketBuild {
  meshes: MeshBuild[]
}

export const emptyBucket = (): BucketBuild => ({ meshes: [] })
