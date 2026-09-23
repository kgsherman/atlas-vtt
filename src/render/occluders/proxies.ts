/**
 * Occluder proxy scene (ARCHITECTURE §4.3, PERFORMANCE §4): OcclusionWorld.primitives → a separate
 * three.js scene that is never drawn to screen, only into shadow / line-of-sight captures and the
 * sun / sky depth maps.
 *
 *  - Boxes and cylinders become instances of a unit box / 16-sided prism, grouped by
 *    (level, channel mask, shape, 100 ft XZ bucket): a handful of draw calls per level, and the
 *    per-face frustum of a light's cube pass culls buckets outside its dim sphere.
 *  - Heightfields become closed chunked meshes.
 *  - layers: LIGHT when the primitive blocks light, SIGHT when it blocks sight.
 *  - Every instance / vertex carries its primitive's numeric key (`aKey`) so a capture can exclude the
 *    primitives containing its source.
 *  - matrixWorldAutoUpdate is off everywhere (proxies are authored in world space).
 * Updates diff the world's primitives against the last build (by reference, then by content), rebuild
 * only the affected groups, and report the old/new bounds of what changed as dirty regions.
 */
import * as THREE from "three"

import type { DirtyRegion, Heightfield, OccluderPrimitive, OcclusionWorld, OrientedBox, VerticalCylinder } from "@/core/occlusion/types"
import type { Id } from "@/core/scene/types"
import { LAYER } from "../internal"
import { boxInstanceMatrix, cylinderInstanceMatrix, heightfieldChunks, positionsGeometry, unitBoxTriangles, unitPrismTriangles } from "./geometry"

/** XZ bucket edge for instance groups (feet). */
export const PROXY_BUCKET_FEET = 100

const LAYER_LIGHT_BIT = 1 << LAYER.LIGHT
const LAYER_SIGHT_BIT = 1 << LAYER.SIGHT

/** Layer mask of a primitive (0 = blocks neither light nor sight: not a proxy). */
export function proxyLayerMask(p: Pick<OccluderPrimitive, "blocks">): number {
  return (p.blocks.light ? LAYER_LIGHT_BIT : 0) | (p.blocks.sight ? LAYER_SIGHT_BIT : 0)
}

/** World AABB of a primitive (heightfields: whole lattice, top surface down by the thickness). */
export function primitiveAabb(p: OccluderPrimitive): { min: THREE.Vector3; max: THREE.Vector3 } {
  switch (p.shape) {
    case "box": {
      const c = Math.abs(Math.cos(p.yaw))
      const s = Math.abs(Math.sin(p.yaw))
      const ex = c * p.halfExtents.x + s * p.halfExtents.z
      const ez = s * p.halfExtents.x + c * p.halfExtents.z
      return {
        min: new THREE.Vector3(p.center.x - ex, p.center.y - p.halfExtents.y, p.center.z - ez),
        max: new THREE.Vector3(p.center.x + ex, p.center.y + p.halfExtents.y, p.center.z + ez),
      }
    }
    case "cylinder":
      return {
        min: new THREE.Vector3(p.base.x - p.radius, p.base.y, p.base.z - p.radius),
        max: new THREE.Vector3(p.base.x + p.radius, p.base.y + p.height, p.base.z + p.radius),
      }
    case "heightfield": {
      let lo = Infinity
      let hi = -Infinity
      for (let k = 0; k < p.heights.length; k++) {
        const h = p.heights[k]
        if (h < lo) lo = h
        if (h > hi) hi = h
      }
      if (!Number.isFinite(lo)) lo = hi = 0
      return {
        min: new THREE.Vector3(p.originX, lo - Math.max(p.thickness, 0.05), p.originZ),
        max: new THREE.Vector3(p.originX + (p.samplesX - 1) * p.spacing, hi, p.originZ + (p.samplesZ - 1) * p.spacing),
      }
    }
  }
}

function sameArray(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false
  return true
}

/** Content equality of two primitives with the same key (so rebuilt-but-identical ones are not dirty). */
export function samePrimitive(a: OccluderPrimitive, b: OccluderPrimitive): boolean {
  if (a === b) return true
  if (a.shape !== b.shape || a.levelId !== b.levelId) return false
  if (a.blocks.light !== b.blocks.light || a.blocks.sight !== b.blocks.sight) return false
  switch (a.shape) {
    case "box": {
      const o = b as OrientedBox
      return (
        a.yaw === o.yaw &&
        a.center.x === o.center.x &&
        a.center.y === o.center.y &&
        a.center.z === o.center.z &&
        a.halfExtents.x === o.halfExtents.x &&
        a.halfExtents.y === o.halfExtents.y &&
        a.halfExtents.z === o.halfExtents.z
      )
    }
    case "cylinder": {
      const o = b as VerticalCylinder
      return a.radius === o.radius && a.height === o.height && a.base.x === o.base.x && a.base.y === o.base.y && a.base.z === o.base.z
    }
    case "heightfield": {
      const o = b as Heightfield
      return (
        a.originX === o.originX &&
        a.originZ === o.originZ &&
        a.spacing === o.spacing &&
        a.samplesX === o.samplesX &&
        a.samplesZ === o.samplesZ &&
        a.thickness === o.thickness &&
        sameArray(a.heights, o.heights) &&
        sameArray(a.solid, o.solid)
      )
    }
  }
}

type InstancedPrimitive = OrientedBox | VerticalCylinder

interface InstanceGroup {
  key: string
  shape: "box" | "cylinder"
  layerMask: number
  prims: Map<string, InstancedPrimitive>
  mesh: THREE.InstancedMesh | null
  capacity: number
}

interface HeightfieldProxy {
  prim: Heightfield
  meshes: THREE.Mesh[]
}

const _m = new THREE.Matrix4()

export class OccluderProxies {
  /** The proxy scene. Its background clears captures to "no occluder" (1e6 ft) and depth to far. */
  readonly scene = new THREE.Scene()
  private readonly material: THREE.Material
  private readonly boxPositions = unitBoxTriangles()
  private readonly prismPositions = unitPrismTriangles()
  private readonly prims = new Map<string, OccluderPrimitive>()
  private readonly groups = new Map<string, InstanceGroup>()
  private readonly heightfields = new Map<string, HeightfieldProxy>()
  private readonly keyIds = new Map<string, number>()
  private nextKeyId = 0
  private boundsCache: THREE.Box3 | null = null

  constructor(material: THREE.Material) {
    this.material = material
    this.scene.name = "atlas-occluder-proxies"
    this.scene.matrixWorldAutoUpdate = false
    this.scene.background = new THREE.Color(1e6, 1e6, 1e6)
  }

  /** Numeric key of a primitive (stable for the session), as written to `aKey`. */
  keyId(key: string): number {
    let id = this.keyIds.get(key)
    if (id === undefined) {
      id = this.nextKeyId++
      this.keyIds.set(key, id)
    }
    return id
  }

  get primitiveCount(): number {
    return this.prims.size
  }

  /** Draw calls a full capture would issue per cube face (for stats/tests). */
  get meshCount(): number {
    let n = 0
    for (const g of this.groups.values()) if (g.mesh) n++
    for (const h of this.heightfields.values()) n += h.meshes.length
    return n
  }

  /** Union of all proxy bounds (null when empty). */
  bounds(): THREE.Box3 | null {
    if (this.boundsCache) return this.boundsCache
    if (this.prims.size === 0) return null
    const box = new THREE.Box3()
    for (const p of this.prims.values()) {
      const b = primitiveAabb(p)
      box.expandByPoint(b.min)
      box.expandByPoint(b.max)
    }
    this.boundsCache = box
    return box
  }

  /** Full rebuild from the world. */
  rebuild(world: Pick<OcclusionWorld, "primitives">): void {
    for (const g of this.groups.values()) this.disposeGroupMesh(g)
    for (const h of this.heightfields.values()) this.disposeHeightfield(h)
    this.groups.clear()
    this.heightfields.clear()
    this.prims.clear()
    this.boundsCache = null
    const touched = new Set<InstanceGroup>()
    for (const p of world.primitives) {
      if (proxyLayerMask(p) === 0) continue
      this.prims.set(p.key, p)
      this.addPrimitive(p, touched)
    }
    for (const g of touched) this.rebuildGroup(g)
  }

  /**
   * Incremental update: diff against the last build and rebuild only what changed. Returns the old and
   * new bounds of changed primitives (in addition to whatever the occlusion world reported).
   */
  update(world: Pick<OcclusionWorld, "primitives">): DirtyRegion[] {
    const next = new Map<string, OccluderPrimitive>()
    for (const p of world.primitives) if (proxyLayerMask(p) !== 0) next.set(p.key, p)
    const dirty: DirtyRegion[] = []
    const touched = new Set<InstanceGroup>()
    const region = (p: OccluderPrimitive) => {
      const b = primitiveAabb(p)
      dirty.push({ levelId: p.levelId, min: { x: b.min.x, y: b.min.y, z: b.min.z }, max: { x: b.max.x, y: b.max.y, z: b.max.z } })
    }
    for (const [key, old] of [...this.prims]) {
      const now = next.get(key)
      if (!now) {
        this.removePrimitive(old, touched)
        this.prims.delete(key)
        region(old)
      } else if (now !== old) {
        if (samePrimitive(now, old)) {
          this.prims.set(key, now)
          continue
        }
        this.removePrimitive(old, touched)
        this.prims.set(key, now)
        this.addPrimitive(now, touched)
        region(old)
        region(now)
      }
    }
    for (const [key, p] of next) {
      if (this.prims.has(key)) continue
      this.prims.set(key, p)
      this.addPrimitive(p, touched)
      region(p)
    }
    for (const g of touched) this.rebuildGroup(g)
    if (dirty.length > 0) this.boundsCache = null
    return dirty
  }

  private groupKey(p: InstancedPrimitive): string {
    const cx = p.shape === "box" ? p.center.x : p.base.x
    const cz = p.shape === "box" ? p.center.z : p.base.z
    return `${p.levelId}|${proxyLayerMask(p)}|${p.shape}|${Math.floor(cx / PROXY_BUCKET_FEET)},${Math.floor(cz / PROXY_BUCKET_FEET)}`
  }

  private addPrimitive(p: OccluderPrimitive, touched: Set<InstanceGroup>): void {
    if (p.shape === "heightfield") {
      this.heightfields.set(p.key, this.buildHeightfield(p))
      return
    }
    const key = this.groupKey(p)
    let g = this.groups.get(key)
    if (!g) {
      g = { key, shape: p.shape, layerMask: proxyLayerMask(p), prims: new Map(), mesh: null, capacity: 0 }
      this.groups.set(key, g)
    }
    g.prims.set(p.key, p)
    touched.add(g)
  }

  private removePrimitive(p: OccluderPrimitive, touched: Set<InstanceGroup>): void {
    if (p.shape === "heightfield") {
      const h = this.heightfields.get(p.key)
      if (h) this.disposeHeightfield(h)
      this.heightfields.delete(p.key)
      return
    }
    const g = this.groups.get(this.groupKey(p))
    if (!g) return
    g.prims.delete(p.key)
    touched.add(g)
  }

  private rebuildGroup(g: InstanceGroup): void {
    const count = g.prims.size
    if (count === 0) {
      this.disposeGroupMesh(g)
      this.groups.delete(g.key)
      return
    }
    if (!g.mesh || count > g.capacity) {
      this.disposeGroupMesh(g)
      const capacity = Math.max(8, 2 ** Math.ceil(Math.log2(count)))
      const geometry = positionsGeometry(g.shape === "box" ? this.boxPositions.slice() : this.prismPositions.slice())
      const keys = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
      keys.setUsage(THREE.DynamicDrawUsage)
      geometry.setAttribute("aKey", keys)
      const mesh = new THREE.InstancedMesh(geometry, this.material, capacity)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.name = `occluders:${g.key}`
      mesh.layers.mask = g.layerMask
      mesh.matrixAutoUpdate = false
      mesh.matrixWorldAutoUpdate = false
      this.scene.add(mesh)
      g.mesh = mesh
      g.capacity = capacity
    }
    const mesh = g.mesh
    const keys = mesh.geometry.getAttribute("aKey") as THREE.InstancedBufferAttribute
    let i = 0
    for (const p of g.prims.values()) {
      if (p.shape === "box") boxInstanceMatrix(p, _m)
      else cylinderInstanceMatrix(p, _m)
      mesh.setMatrixAt(i, _m)
      keys.setX(i, this.keyId(p.key))
      i++
    }
    mesh.count = count
    mesh.instanceMatrix.needsUpdate = true
    keys.needsUpdate = true
    mesh.computeBoundingSphere()
    mesh.computeBoundingBox()
  }

  private buildHeightfield(p: Heightfield): HeightfieldProxy {
    const key = this.keyId(p.key)
    const meshes = heightfieldChunks(p).map((chunk) => {
      const geometry = positionsGeometry(chunk.positions)
      geometry.setAttribute("aKey", new THREE.BufferAttribute(new Float32Array(chunk.positions.length / 3).fill(key), 1))
      const mesh = new THREE.Mesh(geometry, this.material)
      mesh.name = `occluders:${p.key}@${chunk.ci},${chunk.cj}`
      mesh.layers.mask = proxyLayerMask(p)
      mesh.matrixAutoUpdate = false
      mesh.matrixWorldAutoUpdate = false
      this.scene.add(mesh)
      return mesh
    })
    return { prim: p, meshes }
  }

  private disposeGroupMesh(g: InstanceGroup): void {
    if (!g.mesh) return
    this.scene.remove(g.mesh)
    g.mesh.geometry.dispose()
    g.mesh.dispose()
    g.mesh = null
    g.capacity = 0
  }

  private disposeHeightfield(h: HeightfieldProxy): void {
    for (const m of h.meshes) {
      this.scene.remove(m)
      m.geometry.dispose()
    }
    h.meshes = []
  }

  /** Proxies of one level (tests / debugging). */
  levelMeshes(levelId: Id): THREE.Object3D[] {
    return this.scene.children.filter((o) => o.name.startsWith(`occluders:${levelId}|`) || this.heightfieldLevel(o) === levelId)
  }

  private heightfieldLevel(o: THREE.Object3D): Id | null {
    for (const h of this.heightfields.values()) if (h.meshes.includes(o as THREE.Mesh)) return h.prim.levelId
    return null
  }

  dispose(): void {
    for (const g of this.groups.values()) this.disposeGroupMesh(g)
    for (const h of this.heightfields.values()) this.disposeHeightfield(h)
    this.groups.clear()
    this.heightfields.clear()
    this.prims.clear()
    this.boundsCache = null
  }
}
