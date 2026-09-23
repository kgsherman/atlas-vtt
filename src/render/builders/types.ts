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

/** A merged, non-indexed geometry (position, normal, color, aSurf; userData.ranges → object ids). */
export interface MergedBuild {
  kind: "merged"
  name: string
  slot: MaterialSlot
  geometry: THREE.BufferGeometry
  /** Terrain floors only: per-vertex Y offset from the ground, for in-place brush previews. */
  terrainOffsets?: Float32Array
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
}

export type MeshBuild = MergedBuild | InstancedBuild | DoorLeafBuild

export interface BucketBuild {
  meshes: MeshBuild[]
}

export const emptyBucket = (): BucketBuild => ({ meshes: [] })
