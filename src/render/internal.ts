/**
 * Internal contract between the two halves of the renderer:
 *  - render/lighting (+ shadows, materials, fog, occluders): the LightingSystem below
 *  - render/engine (+ builders, cameras, overlays, picking): createEngine() in render/index.ts
 * See docs/ARCHITECTURE.md §4 for the rules both halves implement.
 */
import type * as THREE from "three"

import type { DirtyRegion, OcclusionWorld } from "@/core/occlusion/types"
import type { Id, SceneLike } from "@/core/scene/types"
import type { Quality, SceneChange, ViewState } from "./contracts"

/** three.js layers. Visual meshes stay on VISUAL; occluder proxies (never drawn to screen) use LIGHT/SIGHT. */
export const LAYER = { VISUAL: 0, LIGHT: 1, SIGHT: 2 } as const

/**
 * Surface class baked into every world-mesh vertex as the float attribute `aSurf` (ARCHITECTURE §4.1 step 3):
 * WALKABLE = floors/terrain/connector tops, FACE = vertical-ish faces, CAP = tops (n.y > 0.7) of walls,
 * doors, pillars and props.
 */
export const SURF = { WALKABLE: 0, FACE: 1, CAP: 2 } as const

/**
 * Vertex attributes every world mesh must provide:
 *  - position, normal (geometric/flat normals for boxes)
 *  - color: vec3 linear-space albedo
 *  - aSurf: float (SURF value)
 * InstancedMesh: instanceMatrix + instanceColor (albedo, multiplied with vertex color); aSurf on the base geometry.
 */
export const WORLD_ATTRIBUTES = ["position", "normal", "color", "aSurf"] as const

export interface WorldMaterialOptions {
  /** Level the mesh belongs to (selects the host-mask texture layer and level uniforms). */
  levelId: Id
  /** "ghost" = translucent editor ghost colour pass; "ghost-depth" = its depth-only pre-pass (colorWrite off). */
  variant: "opaque" | "ghost" | "ghost-depth"
  instanced: boolean
}

export interface LightingFrameStats {
  activeLights: number
  tilesUpdated: number
  tilesTotal: number
  updateMs: number
}

export interface LightingSystem {
  /** A world material for a level. All instances share the global uniforms (lights, atlases, masks). */
  createWorldMaterial(opts: WorldMaterialOptions): THREE.ShaderMaterial
  /** Token material: lit by the same lights (no shadows needed), perception-aware tint, never discards. */
  createTokenMaterial(opts: { instanced: boolean }): THREE.ShaderMaterial
  /**
   * Unlit overlay material for window glass / fixture flames: never lit, but masked by perception like
   * the world (the host-mask layer comes from `object.userData.levelId`).
   */
  createOverlayMaterial(opts: { kind: "glass" | "flame" }): THREE.ShaderMaterial
  /** Full rebuild: occluder proxies from world.primitives, light list, sun map, mask layers, level uniforms. */
  setScene(scene: SceneLike, world: OcclusionWorld): void
  /** Incremental update after the engine called world.update()/updateTerrain(). */
  applyChange(scene: SceneLike, world: OcclusionWorld, change: SceneChange, dirty: DirtyRegion[]): void
  /** View state: vision mode, viewer tokens, host masks, active level (culling), dimmed tokens. */
  setView(view: ViewState): void
  setQuality(q: Quality): void
  /** Per frame, before the main render: cull/assign lights, flicker, schedule + render tiles, upload uniforms. */
  beforeRender(renderer: THREE.WebGLRenderer, camera: THREE.Camera, timeSec: number): LightingFrameStats
  dispose(): void
}

export type CreateLightingSystem = (renderer: THREE.WebGLRenderer, opts: { quality: Quality }) => LightingSystem
