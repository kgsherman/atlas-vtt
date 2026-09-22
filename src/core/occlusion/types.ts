import type { Id, Scene, SceneObjectType, Vec2, Vec3 } from "../scene/types"

/** What a primitive blocks. See the table in docs/ARCHITECTURE.md §2. */
export interface BlockFlags {
  movement: boolean
  sight: boolean
  light: boolean
}

export type BlockChannel = keyof BlockFlags

interface PrimitiveBase {
  /** Unique within the world (e.g. `${sourceId}` or `${sourceId}#2` for split walls). */
  key: string
  sourceId: Id
  sourceType: SceneObjectType | "terrain"
  levelId: Id
  blocks: BlockFlags
}

/** Box rotated about the Y axis. World coordinates. */
export interface OrientedBox extends PrimitiveBase {
  shape: "box"
  center: Vec3
  halfExtents: Vec3
  /** Rotation about +Y, radians. */
  yaw: number
}

/** Upright cylinder. `base.y` is the bottom. */
export interface VerticalCylinder extends PrimitiveBase {
  shape: "cylinder"
  base: Vec3
  radius: number
  height: number
}

/**
 * Terrain for one level. Heights are world Y. Only cells covered by floor objects are solid;
 * `solid` is a bitset over heightfield cells (samplesX-1 × samplesZ-1).
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
  solid: Uint8Array
}

export type OccluderPrimitive = OrientedBox | VerticalCylinder | Heightfield

export interface RayHit {
  /** Parametric distance along the segment in [0, 1]. */
  t: number
  primitive: OccluderPrimitive
}

export interface SegmentQueryOptions {
  channel: BlockChannel
  /** Source ids to ignore (e.g. the light's own fixture or the viewer's token). */
  ignoreSourceIds?: ReadonlySet<Id>
}

export interface OcclusionWorld {
  /** Increments on every rebuild/update; used as a cache key by vision. */
  readonly version: number
  readonly primitives: ReadonlyArray<OccluderPrimitive>
  /** True if anything blocking `channel` intersects the open segment from→to. */
  segmentBlocked(from: Vec3, to: Vec3, opts: SegmentQueryOptions): boolean
  /** Nearest hit along from→to, or null. */
  raycast(from: Vec3, to: Vec3, opts: SegmentQueryOptions): RayHit | null
  /** Primitives whose XZ footprint overlaps the circle (for cache invalidation and movement). */
  queryCircle(levelId: Id | null, center: Vec2, radius: number): OccluderPrimitive[]
  /** Ground height (world Y) at x,z on a level: level elevation + heightmap. */
  groundHeight(levelId: Id, x: number, z: number): number
  /** Rebuild the primitives for these source ids (added, changed or removed); bumps version. */
  update(scene: Scene, changedSourceIds: Iterable<Id>): void
}
