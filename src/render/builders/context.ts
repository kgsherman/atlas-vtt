/**
 * Per-build caches shared by the level builders (one context per rebuild pass): ground samplers
 * (optionally overridden by a terrain preview), objects by level and type, openings by host wall,
 * wall joints and effective floors.
 */
import { effectiveFloorRects, type EffectiveFloor, type Opening } from "@/core/scene/queries"
import type { Id, Level, SceneLike, SceneObject, SceneObjectType, Vec2, WallObject } from "@/core/scene/types"

import { GroundSampler } from "./ground"

/** Wall endpoints closer than this (feet) form a joint (ARCHITECTURE §2). */
export const JOINT_TOLERANCE = 1e-3

export type BuildScene = Pick<SceneLike, "grid" | "levels" | "objects" | "tokens">

interface JointEndpoint {
  x: number
  z: number
  wallId: Id
}

const byId = (a: { id: Id }, b: { id: Id }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export class BuildContext {
  readonly scene: BuildScene
  private readonly samplers = new Map<Id, GroundSampler>()
  private readonly previews: ReadonlyMap<Id, Float32Array>
  private readonly previewSamplers: ReadonlyMap<Id, GroundSampler>
  private byLevel: Map<Id, SceneObject[]> | null = null
  private openings: Map<Id, Opening[]> | null = null
  private readonly joints = new Map<Id, Map<string, JointEndpoint[]>>()
  private readonly floors = new Map<Id, EffectiveFloor[]>()

  /**
   * `previews`: terrain preview lattices by level; `previewSamplers`: samplers already built over them
   * (the engine's, with incrementally tracked ranges), used when their lattice is the preview's.
   */
  constructor(scene: BuildScene, previews: ReadonlyMap<Id, Float32Array> = new Map(), previewSamplers: ReadonlyMap<Id, GroundSampler> = new Map()) {
    this.scene = scene
    this.previews = previews
    this.previewSamplers = previewSamplers
  }

  level(id: Id): Level | undefined {
    return Object.hasOwn(this.scene.levels, id) ? this.scene.levels[id] : undefined
  }

  object(id: Id): SceneObject | undefined {
    return Object.hasOwn(this.scene.objects, id) ? this.scene.objects[id] : undefined
  }

  /** True if the level's terrain is currently a terrain preview. */
  hasPreview(levelId: Id): boolean {
    return this.previews.has(levelId)
  }

  /** Ground sampler of a level (the preview lattice while a terrain preview is active). */
  sampler(levelId: Id): GroundSampler {
    let s = this.samplers.get(levelId)
    if (!s) {
      const level = this.level(levelId)
      const grid = this.scene.grid
      if (!level) s = new GroundSampler(0, grid.cellSize, grid.width + 1, grid.depth + 1, null)
      else {
        const preview = this.previews.get(levelId)
        const built = this.previewSamplers.get(levelId)
        if (preview && built && built.heights === preview && built.elevation === level.elevation) s = built
        else s = (preview && GroundSampler.fromDense(level, grid, preview)) || GroundSampler.forLevel(level, grid)
      }
      this.samplers.set(levelId, s)
    }
    return s
  }

  /** Objects on a level, sorted by id (deterministic output). */
  objectsOn(levelId: Id): SceneObject[] {
    if (!this.byLevel) {
      this.byLevel = new Map()
      for (const o of Object.values(this.scene.objects)) {
        let list = this.byLevel.get(o.levelId)
        if (!list) this.byLevel.set(o.levelId, (list = []))
        list.push(o)
      }
      for (const list of this.byLevel.values()) list.sort(byId)
    }
    return this.byLevel.get(levelId) ?? []
  }

  ofType<T extends SceneObjectType>(levelId: Id, type: T): Extract<SceneObject, { type: T }>[] {
    return this.objectsOn(levelId).filter((o): o is Extract<SceneObject, { type: T }> => o.type === type)
  }

  /** Openings hosted by a wall, sorted by offset. */
  openingsOf(wallId: Id): Opening[] {
    if (!this.openings) {
      this.openings = new Map()
      for (const o of Object.values(this.scene.objects)) {
        if (o.type !== "door" && o.type !== "window") continue
        let list = this.openings.get(o.wallId)
        if (!list) this.openings.set(o.wallId, (list = []))
        list.push(o)
      }
      for (const list of this.openings.values()) list.sort((a, b) => a.offset - b.offset || byId(a, b))
    }
    return this.openings.get(wallId) ?? []
  }

  /** True if another wall on the same level has an endpoint within JOINT_TOLERANCE of p. */
  isJoint(wall: WallObject, p: Vec2): boolean {
    let idx = this.joints.get(wall.levelId)
    if (!idx) {
      idx = new Map()
      for (const o of this.objectsOn(wall.levelId)) {
        // Degenerate walls produce no geometry and never form joints (same rule as core/occlusion).
        if (o.type !== "wall" || Math.hypot(o.b.x - o.a.x, o.b.z - o.a.z) < 1e-6) continue
        for (const e of [o.a, o.b]) {
          const key = `${Math.floor(e.x)},${Math.floor(e.z)}`
          let list = idx.get(key)
          if (!list) idx.set(key, (list = []))
          list.push({ x: e.x, z: e.z, wallId: o.id })
        }
      }
      this.joints.set(wall.levelId, idx)
    }
    const bx = Math.floor(p.x)
    const bz = Math.floor(p.z)
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const e of idx.get(`${bx + dx},${bz + dz}`) ?? []) {
          // A wall never joins itself (e.g. a zero-length or closed wall).
          if (e.wallId === wall.id) continue
          if (Math.hypot(e.x - p.x, e.z - p.z) <= JOINT_TOLERANCE) return true
        }
      }
    }
    return false
  }

  effectiveFloors(levelId: Id): EffectiveFloor[] {
    let f = this.floors.get(levelId)
    if (!f) {
      f = effectiveFloorRects(this.scene, levelId)
      this.floors.set(levelId, f)
    }
    return f
  }
}
