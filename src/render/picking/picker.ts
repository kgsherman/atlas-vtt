/**
 * Picking (contracts.ts pick/project):
 *  - ground: the active level's terrain (analytic ray march over the heightmap lattice) where a floor
 *    covers the hit, else the plane y = level.elevation; with PickOptions.terrain the terrain counts
 *    wherever it lies inside the grid extent (as the grid overlay drapes it), floors or not;
 *  - ray: the pointer ray itself (parallel rays with per-pixel origins for orthographic cameras);
 *  - objects: raycast against the visual meshes of solidly drawn levels (ids from userData: merged
 *    meshes map triangles → ids via `ranges`, instanced meshes via `instanceIds`, door leaves via
 *    `objectId`); floors are hit analytically (cheap even for big terrains);
 *  - tokens: raycast against the instanced token meshes (`tokenIds`).
 */
import * as THREE from "three"

import type { EffectiveFloor } from "@/core/scene/queries"
import type { Id, SceneLike, Vec3 } from "@/core/scene/types"

import type { GroundSampler } from "../builders/ground"
import { rangeIdAt, type TriRange } from "../builders/writer"
import type { PickOptions, PickResult } from "../contracts"

/** Object / token id of a raycast hit, from the hit object's userData. */
export function resolveHitIds(object: THREE.Object3D, faceIndex: number | null | undefined, instanceId: number | null | undefined): { objectId: Id | null; tokenId: Id | null } {
  const ud = object.userData
  if (Array.isArray(ud.tokenIds) && instanceId !== undefined && instanceId !== null) {
    return { objectId: null, tokenId: (ud.tokenIds as Id[])[instanceId] ?? null }
  }
  if (typeof ud.objectId === "string") return { objectId: ud.objectId, tokenId: null }
  if (Array.isArray(ud.instanceIds) && instanceId !== undefined && instanceId !== null) {
    return { objectId: (ud.instanceIds as Id[])[instanceId] ?? null, tokenId: null }
  }
  if (Array.isArray(ud.ranges) && faceIndex !== undefined && faceIndex !== null) {
    return { objectId: rangeIdAt(ud.ranges as TriRange[], faceIndex), tokenId: null }
  }
  return { objectId: null, tokenId: null }
}

/** Intersection with the horizontal plane y = h (t ≥ 0), or null. */
export function planeHit(ray: THREE.Ray, h: number): { t: number; point: Vec3 } | null {
  const dy = ray.direction.y
  if (Math.abs(dy) < 1e-12) return null
  const t = (h - ray.origin.y) / dy
  if (t < 0) return null
  return { t, point: { x: ray.origin.x + ray.direction.x * t, y: h, z: ray.origin.z + ray.direction.z * t } }
}

/**
 * First point where the ray crosses the terrain surface from above and `accept(x, z)` holds.
 * Marches in steps of half a lattice spacing (horizontally) within the terrain's Y range, then
 * bisects the crossing.
 */
export function marchTerrain(ray: THREE.Ray, ground: GroundSampler, accept: (x: number, z: number) => boolean, maxT = 1e5): { t: number; point: Vec3 } | null {
  const o = ray.origin
  const d = ray.direction
  const range = ground.worldRange
  const yMin = range.min - 0.01
  const yMax = range.max + 0.01
  let t0: number
  let t1: number
  if (Math.abs(d.y) < 1e-9) {
    if (o.y < yMin || o.y > yMax) return null
    t0 = 0
    t1 = maxT
  } else {
    const a = (yMax - o.y) / d.y
    const b = (yMin - o.y) / d.y
    t0 = Math.max(0, Math.min(a, b))
    t1 = Math.min(maxT, Math.max(a, b))
  }
  if (!(t1 > t0)) return null
  const f = (t: number) => o.y + d.y * t - ground.heightAt(o.x + d.x * t, o.z + d.z * t)
  const hs = Math.hypot(d.x, d.z)
  const n = Math.min(8000, Math.max(1, Math.ceil(hs > 1e-9 ? ((t1 - t0) * hs) / (ground.spacing / 2) : 1)))
  const dt = (t1 - t0) / n
  let tp = t0
  let fp = f(t0)
  for (let k = 1; k <= n; k++) {
    const t = t0 + dt * k
    const fc = f(t)
    if (fp >= 0 && fc <= 0) {
      let lo = tp
      let hi = t
      for (let i = 0; i < 30; i++) {
        const mid = (lo + hi) / 2
        if (f(mid) >= 0) lo = mid
        else hi = mid
      }
      const tt = (lo + hi) / 2
      const x = o.x + d.x * tt
      const z = o.z + d.z * tt
      if (accept(x, z)) return { t: tt, point: { x, y: ground.heightAt(x, z), z } }
    }
    tp = t
    fp = fc
  }
  return null
}

/**
 * PickResult plus the world-space normal of the surface hit (for snapping wall-mounted lights to
 * hitPoint + 0.3·normal, ARCHITECTURE §2). Still assignable to the contract's PickResult.
 */
export interface PickResultWithNormal extends PickResult {
  hitNormal: Vec3 | null
}

const tmpMatrix = new THREE.Matrix4()
const tmpNormalMatrix = new THREE.Matrix3()

/** World-space normal of a raycast hit (instance transform included), or null. */
export function hitWorldNormal(hit: THREE.Intersection): Vec3 | null {
  const n = hit.face?.normal
  if (!n) return null
  const m = tmpMatrix.copy(hit.object.matrixWorld)
  const inst = hit.object as THREE.InstancedMesh
  if (inst.isInstancedMesh && hit.instanceId !== undefined) {
    const im = new THREE.Matrix4()
    inst.getMatrixAt(hit.instanceId, im)
    m.multiply(im)
  }
  const v = n.clone().applyMatrix3(tmpNormalMatrix.getNormalMatrix(m)).normalize()
  return { x: v.x, y: v.y, z: v.z }
}

export interface PickHost {
  canvas: HTMLCanvasElement
  camera(): THREE.Camera
  scene(): SceneLike | null
  /** Levels drawn solid, with their pickable meshes. */
  solidLevels(): { levelId: Id; meshes: THREE.Mesh[] }[]
  tokenMeshes(): THREE.Object3D[]
  ground(levelId: Id): GroundSampler
  effectiveFloors(levelId: Id): EffectiveFloor[]
}

const floorAt = (floors: readonly EffectiveFloor[], x: number, z: number): EffectiveFloor | undefined =>
  floors.find((f) => x >= f.rect.x && x < f.rect.x + f.rect.w && z >= f.rect.z && z < f.rect.z + f.rect.d)

export class Picker {
  private readonly host: PickHost
  private readonly raycaster = new THREE.Raycaster()
  private readonly ndc = new THREE.Vector2()

  constructor(host: PickHost) {
    this.host = host
  }

  /** Point the internal ray through a client position; false if the canvas has no size. */
  private aim(clientX: number, clientY: number): boolean {
    const rect = this.host.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.host.camera())
    return true
  }

  /**
   * Ground of a level's terrain wherever it lies inside the grid extent (PickOptions.terrain), null on a
   * level without a heightmap or when the ray meets no terrain there.
   */
  private terrainHit(levelId: Id, grid: SceneLike["grid"]): { t: number; point: Vec3 } | null {
    const ground = this.host.ground(levelId)
    if (ground.flat) return null
    const w = grid.width * grid.cellSize
    const d = grid.depth * grid.cellSize
    // March no further than where the ray leaves the extent (long grazing rays keep their step size).
    const ray = this.raycaster.ray
    let tExit = 1e5
    for (const [o, dir, hi] of [
      [ray.origin.x, ray.direction.x, w],
      [ray.origin.z, ray.direction.z, d],
    ]) {
      if (dir > 1e-12) tExit = Math.min(tExit, (hi - o) / dir)
      else if (dir < -1e-12) tExit = Math.min(tExit, -o / dir)
    }
    if (!(tExit >= 0)) return null
    return marchTerrain(ray, ground, (x, z) => x >= 0 && x <= w && z >= 0 && z <= d, tExit + ground.spacing)
  }

  /** Floor hit on a level: terrain march (heightmap) or the elevation plane, inside a floor rect. */
  private floorHit(levelId: Id): { t: number; point: Vec3; floorId: Id } | null {
    const ground = this.host.ground(levelId)
    const floors = this.host.effectiveFloors(levelId)
    if (floors.length === 0) return null
    const ray = this.raycaster.ray
    if (ground.flat) {
      const h = planeHit(ray, ground.elevation)
      const f = h && floorAt(floors, h.point.x, h.point.z)
      return h && f ? { ...h, floorId: f.floorId } : null
    }
    const h = marchTerrain(ray, ground, (x, z) => floorAt(floors, x, z) !== undefined)
    if (!h) return null
    return { ...h, floorId: floorAt(floors, h.point.x, h.point.z)!.floorId }
  }

  pick(clientX: number, clientY: number, opts: PickOptions): PickResultWithNormal {
    const result: PickResultWithNormal = { ground: null, objectId: null, tokenId: null, hitPoint: null, hitNormal: null }
    if (!this.aim(clientX, clientY)) return result
    const ray = this.raycaster.ray
    result.ray = { origin: { x: ray.origin.x, y: ray.origin.y, z: ray.origin.z }, direction: { x: ray.direction.x, y: ray.direction.y, z: ray.direction.z } }
    const scene = this.host.scene()
    if (!scene) return result
    if (Object.hasOwn(scene.levels, opts.levelId)) {
      const gh = opts.terrain ? this.terrainHit(opts.levelId, scene.grid) : this.floorHit(opts.levelId)
      result.ground = gh ? gh.point : (planeHit(ray, scene.levels[opts.levelId].elevation)?.point ?? null)
    }
    let best = Infinity
    if (opts.objects) {
      const meshes: THREE.Mesh[] = []
      for (const lv of this.host.solidLevels()) {
        meshes.push(...lv.meshes)
        const fh = this.floorHit(lv.levelId)
        if (fh && fh.t < best) {
          best = fh.t
          result.objectId = fh.floorId
          result.hitPoint = fh.point
          result.hitNormal = { x: 0, y: 1, z: 0 }
        }
      }
      for (const hit of this.raycaster.intersectObjects(meshes, false)) {
        if (hit.distance >= best) break
        const { objectId } = resolveHitIds(hit.object, hit.faceIndex, hit.instanceId)
        if (!objectId || !Object.hasOwn(scene.objects, objectId)) continue
        best = hit.distance
        result.objectId = objectId
        result.hitPoint = { x: hit.point.x, y: hit.point.y, z: hit.point.z }
        result.hitNormal = hitWorldNormal(hit)
        break
      }
    }
    if (opts.tokens) {
      for (const hit of this.raycaster.intersectObjects(this.host.tokenMeshes(), false)) {
        const { tokenId } = resolveHitIds(hit.object, hit.faceIndex, hit.instanceId)
        if (!tokenId || !Object.hasOwn(scene.tokens, tokenId)) continue
        result.tokenId = tokenId
        if (!result.hitPoint || hit.distance < best) {
          result.hitPoint = { x: hit.point.x, y: hit.point.y, z: hit.point.z }
          result.hitNormal = hitWorldNormal(hit)
        }
        break
      }
    }
    return result
  }

  /** World point → canvas-relative CSS pixels. */
  project(p: Vec3): { x: number; y: number; visible: boolean } {
    const camera = this.host.camera()
    const rect = this.host.canvas.getBoundingClientRect()
    const v = new THREE.Vector3(p.x, p.y, p.z).project(camera)
    const x = ((v.x + 1) / 2) * rect.width
    const y = ((1 - v.y) / 2) * rect.height
    const visible = v.z >= -1 && v.z <= 1 && x >= 0 && y >= 0 && x <= rect.width && y <= rect.height
    return { x, y, visible }
  }
}
