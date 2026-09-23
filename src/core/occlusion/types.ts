import type { Id, Rect, SceneLike, SceneObjectType, Vec2, Vec3 } from "../scene/types"

/** What a primitive blocks. See the blocking table in docs/ARCHITECTURE.md §2. */
export interface BlockFlags {
  movement: boolean
  sight: boolean
  light: boolean
}

export type BlockChannel = keyof BlockFlags

interface PrimitiveBase {
  /** Unique within the world and stable across rebuilds: `${sourceId}` or `${sourceId}#${part}`. */
  key: string
  sourceId: Id
  sourceType: SceneObjectType | "terrain"
  levelId: Id
  blocks: BlockFlags
}

/** Closed box rotated about the Y axis. World coordinates. */
export interface OrientedBox extends PrimitiveBase {
  shape: "box"
  center: Vec3
  halfExtents: Vec3
  /**
   * Rotation about +Y, radians, in the three.js convention (`Object3D.rotation.y`,
   * `Matrix4.makeRotationY`): local +X maps to world (cos yaw, 0, −sin yaw), local +Z to
   * (sin yaw, 0, cos yaw). render/occluders builds its instance matrices the same way.
   */
  yaw: number
}

/** Closed upright cylinder. `base.y` is the bottom. */
export interface VerticalCylinder extends PrimitiveBase {
  shape: "cylinder"
  base: Vec3
  radius: number
  height: number
}

/**
 * A floor slab with terrain on top, for one floor object (sourceId = floor id, sourceType "terrain";
 * floors on levels without a heightmap are boxes with sourceType "floor"). Heights are world Y of the
 * top surface on the lattice (same triangle split as core/scene/heightmap). The solid is
 * [surface − thickness, surface] over the lattice cells flagged in `solid` (cells whose centre lies
 * inside the floor's effective rects), i.e. a closed volume.
 * Arrays are row-major by z then x: heights[sz·samplesX + sx], solid[cz·(samplesX − 1) + cx].
 */
export interface Heightfield extends PrimitiveBase {
  shape: "heightfield"
  originX: number
  originZ: number
  /** Distance between samples (feet). */
  spacing: number
  samplesX: number
  samplesZ: number
  heights: Float32Array
  /** 1 byte per lattice cell ((samplesX−1) × (samplesZ−1)), non-zero = solid. */
  solid: Uint8Array
  thickness: number
}

export type OccluderPrimitive = OrientedBox | VerticalCylinder | Heightfield

export interface RayHit {
  /** Parametric distance along the segment in [0, 1] where the segment ENTERS the primitive. */
  t: number
  primitive: OccluderPrimitive
}

export interface SegmentQueryOptions {
  channel: BlockChannel
  /** Source ids to ignore (e.g. the light's own fixture). */
  ignoreSourceIds?: ReadonlySet<Id>
}

/** World-space regions touched by an update (old and new bounds), for cache invalidation. */
export interface DirtyRegion {
  levelId: Id
  min: Vec3
  max: Vec3
}

/**
 * CPU occluder model. Semantics shared with the GPU (docs/ARCHITECTURE.md §5.1):
 *  - A primitive blocks a segment only if the segment ENTERS it at some t in (0, 1).
 *    A primitive that contains the segment's start point is ignored for that query.
 *  - Segments ending inside a primitive are blocked only if they entered it (i.e. start outside).
 */
export interface OcclusionWorld {
  /** Increments on every change. */
  readonly version: number
  readonly primitives: ReadonlyArray<OccluderPrimitive>
  segmentBlocked(from: Vec3, to: Vec3, opts: SegmentQueryOptions): boolean
  /** Nearest entry hit along from→to, or null. */
  raycast(from: Vec3, to: Vec3, opts: SegmentQueryOptions): RayHit | null
  /** Primitives containing p (optionally filtered by channel). */
  containing(p: Vec3, channel?: BlockChannel): OccluderPrimitive[]
  /** Primitives whose XZ footprint overlaps the circle, optionally restricted to one level. */
  queryCircle(levelId: Id | null, center: Vec2, radius: number): OccluderPrimitive[]
  /** Primitives whose XZ footprint overlaps the rect, optionally restricted to one level. */
  queryRect(levelId: Id | null, rect: Rect): OccluderPrimitive[]
  /** Rebuild primitives for these source ids (added, changed or removed). Returns dirty regions. */
  update(scene: SceneLike, changedSourceIds: Iterable<Id>): DirtyRegion[]
  /** Rebuild terrain-dependent primitives over a rect of one level (heightmap edits). */
  updateTerrain(scene: SceneLike, levelId: Id, rect: Rect): DirtyRegion[]
}
