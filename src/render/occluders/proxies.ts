/**
 * Occluder proxy scene (ARCHITECTURE §4.3, PERFORMANCE §4): OcclusionWorld.primitives → a separate
 * three.js scene that is never drawn to screen, only into shadow / line-of-sight captures and the
 * sun / sky depth maps.
 *
 *  - Boxes and cylinders become instances of a unit box / 16-sided prism, grouped by
 *    (level, channel mask, shape, 100 ft XZ bucket): a handful of draw calls per level, and the
 *    per-face frustum of a light's cube pass culls buckets outside its dim sphere.
 *  - Wall strips (sloped wall pieces) are not affine images of a cube: each (level, channel mask,
 *    100 ft bucket) group is one merged, closed world-space mesh with a per-vertex `aKey` (like the
 *    heightfield chunks; same shader), rebuilt whole when a member changes.
 *  - Heightfields become closed chunked meshes.
 *  - layers: LIGHT when the primitive blocks light, SIGHT when it blocks sight.
 *  - Every instance / vertex carries its primitive's numeric key (`aKey`) so a capture can exclude the
 *    primitives containing its source.
 *  - matrixWorldAutoUpdate is off everywhere (proxies are authored in world space).
 * Updates diff the world's primitives against the last build (by reference, then by content), rebuild
 * only the affected groups, and report the old/new bounds of what changed as dirty regions. A heightfield
 * whose heights changed on the same lattice (a terrain commit) is not rebuilt: the chunk meshes holding a
 * changed sample are rewritten in place, and only they are dirty.
 *
 * Terrain previews (previewTerrain / endPreview, LightingSystem.previewTerrain): a previewed level's
 * heightfield chunks are rewritten in place from the preview's lattice (same triangles, new heights), and
 * its flat floors (boxes: the level has no heightmap yet) are left out of their instance groups and
 * replaced by stand-in heightfields on the preview's lattice, so the shadow / sight captures and the
 * sun / sky maps see the terrain the DM sees. Heightfields rebuilt while a preview lasts get it again.
 */
import * as THREE from "three"

import type { DirtyRegion, Heightfield, OccluderPrimitive, OcclusionWorld, OrientedBox, VerticalCylinder, WallStrip } from "@/core/occlusion/types"
import type { Id, Rect } from "@/core/scene/types"
import { LAYER } from "../internal"
import {
  ArrayTriangleSink,
  boxInstanceMatrix,
  cylinderInstanceMatrix,
  heightfieldChunks,
  heightfieldChunkTriangles,
  HEIGHTFIELD_CHUNK_CELLS,
  HEIGHTFIELD_MIN_THICKNESS,
  positionsGeometry,
  stripTriangles,
  TriangleSink,
  unitBoxTriangles,
  unitPrismTriangles,
} from "./geometry"

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
    case "strip": {
      const c = Math.abs(Math.cos(p.yaw))
      const s = Math.abs(Math.sin(p.yaw))
      const ex = c * p.halfExtents.x + s * p.halfExtents.z
      const ez = s * p.halfExtents.x + c * p.halfExtents.z
      let hi = p.bottom
      for (const t of p.top) if (t > hi) hi = t
      return {
        min: new THREE.Vector3(p.center.x - ex, p.bottom, p.center.z - ez),
        max: new THREE.Vector3(p.center.x + ex, hi, p.center.z + ez),
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
        min: new THREE.Vector3(p.originX, lo - Math.max(p.thickness, HEIGHTFIELD_MIN_THICKNESS), p.originZ),
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
    case "strip": {
      const o = b as WallStrip
      return (
        a.yaw === o.yaw &&
        a.center.x === o.center.x &&
        a.center.z === o.center.z &&
        a.halfExtents.x === o.halfExtents.x &&
        a.halfExtents.z === o.halfExtents.z &&
        a.bottom === o.bottom &&
        sameArray(a.knots, o.knots) &&
        sameArray(a.top, o.top)
      )
    }
  }
}

type InstancedPrimitive = OrientedBox | VerticalCylinder
type GroupedPrimitive = InstancedPrimitive | WallStrip

interface InstanceGroup {
  kind: "instanced"
  key: string
  shape: "box" | "cylinder"
  layerMask: number
  prims: Map<string, InstancedPrimitive>
  mesh: THREE.InstancedMesh | null
  capacity: number
}

/** Wall strips of one (level, mask, bucket): a single merged mesh with per-vertex keys. */
interface StripGroup {
  kind: "strip"
  key: string
  layerMask: number
  prims: Map<string, WallStrip>
  mesh: THREE.Mesh | null
}

type Group = InstanceGroup | StripGroup

interface HeightfieldProxy {
  prim: Heightfield
  meshes: THREE.Mesh[]
  /** Chunk coordinates of each mesh. */
  chunks: { ci: number; cj: number }[]
  /** Lattice heights (world Y) the meshes show while a preview is applied; null = prim.heights. */
  live: Float32Array | null
  /** Meshes (indices) rewritten by the preview. */
  touched: Set<number>
}

/**
 * World-space terrain of a previewed level (render/builders GroundSampler): Y = elevation + sample on the
 * lattice of `spacing` from the origin, heightAt anywhere.
 */
export interface PreviewGround {
  readonly elevation: number
  readonly spacing: number
  /** Height of lattice sample (sx, sz), relative to the elevation. */
  sample(sx: number, sz: number): number
  /** World Y at (x, z). */
  heightAt(x: number, z: number): number
}

/** A level under terrain preview. */
interface LevelPreview {
  ground: PreviewGround
  /** Stand-in heightfields of the level's flat floor boxes, by box key (the boxes are hidden meanwhile). */
  standIns: Map<string, { box: OrientedBox; proxy: HeightfieldProxy }>
}

/** A flat level's floor slab: a box with sourceType "floor" (core/occlusion; on terrain floors are heightfields). */
const isFlatFloor = (p: OccluderPrimitive): p is OrientedBox => p.shape === "box" && p.sourceType === "floor"

/**
 * The heightfield core/occlusion would build for a flat floor box on the preview's terrain: the lattice
 * cells covering the box, solid where their centre lies inside it, same slab thickness (null: no cell).
 */
export function standInHeightfield(box: OrientedBox, ground: PreviewGround): Heightfield | null {
  const s = ground.spacing
  const x0 = box.center.x - box.halfExtents.x
  const x1 = box.center.x + box.halfExtents.x
  const z0 = box.center.z - box.halfExtents.z
  const z1 = box.center.z + box.halfExtents.z
  const i0 = Math.floor(x0 / s + 1e-9)
  const j0 = Math.floor(z0 / s + 1e-9)
  const cellsX = Math.ceil(x1 / s - 1e-9) - i0
  const cellsZ = Math.ceil(z1 / s - 1e-9) - j0
  if (!(s > 0) || cellsX <= 0 || cellsZ <= 0) return null
  const samplesX = cellsX + 1
  const samplesZ = cellsZ + 1
  const heights = new Float32Array(samplesX * samplesZ)
  for (let j = 0; j < samplesZ; j++) {
    for (let i = 0; i < samplesX; i++) heights[j * samplesX + i] = ground.elevation + ground.sample(i0 + i, j0 + j)
  }
  // Cells whose centre (i + 0.5)·s lies in [x0, x1) (half-open, as core/occlusion's floors).
  const ci0 = Math.max(0, Math.ceil(x0 / s - 0.5) - i0)
  const ci1 = Math.min(cellsX - 1, Math.ceil(x1 / s - 0.5) - 1 - i0)
  const cj0 = Math.max(0, Math.ceil(z0 / s - 0.5) - j0)
  const cj1 = Math.min(cellsZ - 1, Math.ceil(z1 / s - 0.5) - 1 - j0)
  if (ci0 > ci1 || cj0 > cj1) return null
  const solid = new Uint8Array(cellsX * cellsZ)
  for (let j = cj0; j <= cj1; j++) solid.fill(1, j * cellsX + ci0, j * cellsX + ci1 + 1)
  return {
    key: box.key,
    sourceId: box.sourceId,
    sourceType: "terrain",
    levelId: box.levelId,
    blocks: box.blocks,
    shape: "heightfield",
    originX: i0 * s,
    originZ: j0 * s,
    spacing: s,
    samplesX,
    samplesZ,
    heights,
    solid,
    thickness: 2 * box.halfExtents.y,
  }
}

const regionOf = (levelId: Id, b: THREE.Box3): DirtyRegion => ({
  levelId,
  min: { x: b.min.x, y: b.min.y, z: b.min.z },
  max: { x: b.max.x, y: b.max.y, z: b.max.z },
})

const aabbRegion = (p: OccluderPrimitive): DirtyRegion => {
  const b = primitiveAabb(p)
  return { levelId: p.levelId, min: { x: b.min.x, y: b.min.y, z: b.min.z }, max: { x: b.max.x, y: b.max.y, z: b.max.z } }
}

/** Union of the meshes' geometry bounds (empty box when none). */
function meshesBox(meshes: Iterable<THREE.Mesh>, into = new THREE.Box3()): THREE.Box3 {
  for (const m of meshes) {
    const g = m.geometry
    if (!g.boundingBox) g.computeBoundingBox()
    into.union(g.boundingBox!)
  }
  return into
}

const _m = new THREE.Matrix4()

export class OccluderProxies {
  /** The proxy scene. Its background clears captures to "no occluder" (1e6 ft) and depth to far. */
  readonly scene = new THREE.Scene()
  private readonly material: THREE.Material
  private readonly boxPositions = unitBoxTriangles()
  private readonly prismPositions = unitPrismTriangles()
  private readonly prims = new Map<string, OccluderPrimitive>()
  private readonly groups = new Map<string, Group>()
  private readonly heightfields = new Map<string, HeightfieldProxy>()
  /** Levels under terrain preview. */
  private readonly previews = new Map<Id, LevelPreview>()
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
    for (const lp of this.previews.values()) for (const st of lp.standIns.values()) n += st.proxy.meshes.length
    return n
  }

  /** Union of all proxy bounds, previewed terrain included (null when empty). */
  bounds(): THREE.Box3 | null {
    if (this.boundsCache) return this.boundsCache
    if (this.prims.size === 0) return null
    const box = new THREE.Box3()
    for (const p of this.prims.values()) {
      const b = primitiveAabb(p)
      box.expandByPoint(b.min)
      box.expandByPoint(b.max)
    }
    for (const h of this.heightfields.values()) if (h.live) meshesBox(h.meshes, box)
    for (const lp of this.previews.values()) for (const st of lp.standIns.values()) meshesBox(st.proxy.meshes, box)
    this.boundsCache = box
    return box
  }

  /** Levels under terrain preview (tests / debugging). */
  get previewedLevels(): Id[] {
    return [...this.previews.keys()]
  }

  /** Full rebuild from the world (ends every terrain preview). */
  rebuild(world: Pick<OcclusionWorld, "primitives">): void {
    this.dropPreviews()
    for (const g of this.groups.values()) this.disposeGroupMesh(g)
    for (const h of this.heightfields.values()) this.disposeHeightfield(h)
    this.groups.clear()
    this.heightfields.clear()
    this.prims.clear()
    this.boundsCache = null
    const touched = new Set<Group>()
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
   *
   * A heightfield whose heights changed on the same lattice (same origin, spacing, size, solid mask,
   * thickness and channels: a terrain commit) is moved in place: only the chunk meshes holding a changed
   * sample are rewritten, and only their old ∪ new bounds are dirty. `ending` = levels whose terrain
   * preview ends with this update (a terrain commit, LightingSystem.applyChange): their heightfields go
   * straight from the previewed heights to the world's, so after a drag the chunks the preview already
   * shows at the committed heights are not touched at all.
   */
  update(world: Pick<OcclusionWorld, "primitives">, ending: Iterable<Id> = []): DirtyRegion[] {
    const next = new Map<string, OccluderPrimitive>()
    for (const p of world.primitives) if (proxyLayerMask(p) !== 0) next.set(p.key, p)
    const dirty: DirtyRegion[] = []
    // Ended previews keep showing their heights until the diff below (moveHeightfield) or the settle pass.
    for (const levelId of ending) dirty.push(...this.endPreview(levelId, false))
    const touched = new Set<Group>()
    const region = (p: OccluderPrimitive) => {
      const b = primitiveAabb(p)
      dirty.push({ levelId: p.levelId, min: { x: b.min.x, y: b.min.y, z: b.min.z }, max: { x: b.max.x, y: b.max.y, z: b.max.z } })
    }
    for (const [key, old] of [...this.prims]) {
      const now = next.get(key)
      if (!now) {
        this.removePrimitive(old, touched, dirty)
        this.prims.delete(key)
        region(old)
      } else if (now !== old) {
        if (samePrimitive(now, old)) {
          this.prims.set(key, now)
          continue
        }
        if (now.shape === "heightfield" && this.moveHeightfield(now, dirty)) {
          this.prims.set(key, now)
          continue
        }
        this.removePrimitive(old, touched, dirty)
        this.prims.set(key, now)
        this.addPrimitive(now, touched, dirty)
        region(old)
        region(now)
      }
    }
    for (const [key, p] of next) {
      if (this.prims.has(key)) continue
      this.prims.set(key, p)
      this.addPrimitive(p, touched, dirty)
      region(p)
    }
    // Previewed levels: stand-ins follow their floor boxes (before the groups hide / show them).
    for (const [levelId, lp] of this.previews) this.syncStandIns(levelId, lp, touched, dirty)
    for (const g of touched) this.rebuildGroup(g)
    // Heightfields still showing an ended preview (the world left them as they were): back to their own heights.
    for (const h of this.heightfields.values()) if (h.live && !this.previews.has(h.prim.levelId)) this.restoreHeightfield(h, dirty)
    if (dirty.length > 0) this.boundsCache = null
    return dirty
  }

  /**
   * Terrain preview of a level (LightingSystem.previewTerrain): its heightfield proxies show `ground` over
   * `dirty` grown by one lattice spacing (null: everywhere), rewritten in place chunk by chunk; its flat
   * floor boxes are replaced by stand-in heightfields on the preview's lattice. The preview lasts until
   * endPreview or a full rebuild; heightfields rebuilt meanwhile (update) get it again. Returns the old
   * and new bounds of what moved.
   */
  previewTerrain(levelId: Id, ground: PreviewGround, dirty: Rect | null): DirtyRegion[] {
    const out: DirtyRegion[] = []
    let lp = this.previews.get(levelId)
    if (!lp) this.previews.set(levelId, (lp = { ground, standIns: new Map() }))
    lp.ground = ground
    const touched = new Set<Group>()
    const fresh = this.syncStandIns(levelId, lp, touched, out)
    for (const g of touched) this.rebuildGroup(g)
    for (const h of this.heightfields.values()) if (h.prim.levelId === levelId) this.applyPreview(h, ground, dirty, out)
    for (const { proxy } of lp.standIns.values()) if (!fresh.has(proxy)) this.applyPreview(proxy, ground, dirty, out)
    if (out.length > 0) this.boundsCache = null
    return out
  }

  /**
   * End a level's terrain preview: its proxies show the world's primitives again. Returns the bounds of what
   * moved. `restore` false (update's `ending`): the heightfields keep showing the preview for update to settle.
   */
  endPreview(levelId: Id, restore = true): DirtyRegion[] {
    const lp = this.previews.get(levelId)
    if (!lp) return []
    this.previews.delete(levelId)
    const out: DirtyRegion[] = []
    const touched = new Set<Group>()
    for (const { box, proxy } of lp.standIns.values()) {
      if (proxy.meshes.length > 0) out.push(regionOf(levelId, meshesBox(proxy.meshes)))
      this.disposeHeightfield(proxy)
      const g = this.groups.get(this.groupKey(box))
      if (g) {
        touched.add(g)
        out.push(aabbRegion(box))
      }
    }
    for (const g of touched) this.rebuildGroup(g)
    if (restore) for (const h of this.heightfields.values()) if (h.prim.levelId === levelId) this.restoreHeightfield(h, out)
    if (out.length > 0) this.boundsCache = null
    return out
  }

  /** Drop every preview without touching the heightfields (they are about to be disposed). */
  private dropPreviews(): void {
    for (const lp of this.previews.values()) for (const st of lp.standIns.values()) this.disposeHeightfield(st.proxy)
    this.previews.clear()
  }

  /**
   * Stand-ins of a previewed level: dropped when their box is gone or changed, created (from the whole
   * preview) for floor boxes without one. Adds the boxes' groups to `touched` (they hide / show the box).
   * Returns the stand-ins created.
   */
  private syncStandIns(levelId: Id, lp: LevelPreview, touched: Set<Group>, out: DirtyRegion[]): Set<HeightfieldProxy> {
    const fresh = new Set<HeightfieldProxy>()
    const touch = (box: OrientedBox) => {
      const g = this.groups.get(this.groupKey(box))
      if (g) touched.add(g)
    }
    for (const [key, st] of lp.standIns) {
      const now = this.prims.get(key)
      if (now && samePrimitive(now, st.box)) continue
      if (st.proxy.meshes.length > 0) out.push(regionOf(levelId, meshesBox(st.proxy.meshes)))
      this.disposeHeightfield(st.proxy)
      lp.standIns.delete(key)
      touch(st.box)
    }
    for (const p of this.prims.values()) {
      if (p.levelId !== levelId || !isFlatFloor(p) || lp.standIns.has(p.key)) continue
      const hf = standInHeightfield(p, lp.ground)
      if (!hf) continue
      const proxy = this.buildHeightfield(hf)
      lp.standIns.set(p.key, { box: p, proxy })
      fresh.add(proxy)
      touch(p)
      out.push(aabbRegion(p))
      if (proxy.meshes.length > 0) out.push(regionOf(levelId, meshesBox(proxy.meshes)))
    }
    return fresh
  }

  /** A box hidden behind its terrain-preview stand-in. */
  private hidden(p: OccluderPrimitive): boolean {
    return this.previews.get(p.levelId)?.standIns.has(p.key) ?? false
  }

  /**
   * Show `ground` on a heightfield proxy over the samples within `dirty` grown by one lattice spacing (null:
   * all): the chunks holding a changed sample are rewritten in place (same triangles), their bounds
   * recomputed. Pushes the old ∪ new bounds of the changed triangles.
   */
  private applyPreview(h: HeightfieldProxy, ground: PreviewGround, dirty: Rect | null, out: DirtyRegion[]): void {
    const p = h.prim
    const s = p.spacing
    const nx = p.samplesX
    const nz = p.samplesZ
    let i0 = 0
    let i1 = nx - 1
    let j0 = 0
    let j1 = nz - 1
    if (dirty) {
      const grow = Math.max(s, ground.spacing)
      i0 = Math.max(i0, Math.floor((dirty.x - grow - p.originX) / s))
      i1 = Math.min(i1, Math.ceil((dirty.x + dirty.w + grow - p.originX) / s))
      j0 = Math.max(j0, Math.floor((dirty.z - grow - p.originZ) / s))
      j1 = Math.min(j1, Math.ceil((dirty.z + dirty.d + grow - p.originZ) / s))
      if (i0 > i1 || j0 > j1) return
    }
    const live = h.live ?? p.heights.slice()
    // The preview's lattice is usually the heightfield's (same spacing, origin on it): read samples.
    const onLattice = Math.abs(ground.spacing - s) < 1e-9
    const gx = Math.round(p.originX / s)
    const gz = Math.round(p.originZ / s)
    // Bounds of the changed samples.
    let si0 = Infinity
    let si1 = -Infinity
    let sj0 = Infinity
    let sj1 = -Infinity
    let lo = Infinity
    let hi = -Infinity
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i
        const old = live[k]
        live[k] = onLattice ? ground.elevation + ground.sample(gx + i, gz + j) : ground.heightAt(p.originX + i * s, p.originZ + j * s)
        const now = live[k]
        if (now === old) continue
        if (i < si0) si0 = i
        if (i > si1) si1 = i
        if (j < sj0) sj0 = j
        if (j > sj1) sj1 = j
        lo = Math.min(lo, old, now)
        hi = Math.max(hi, old, now)
      }
    }
    // Nothing changed (a first call keeps showing prim.heights).
    if (si0 > si1) return
    h.live = live
    // The triangles of a changed sample reach one cell further (and down to the slab's bottom).
    const a0 = Math.max(0, si0 - 1)
    const a1 = Math.min(nx - 1, si1 + 1)
    const b0 = Math.max(0, sj0 - 1)
    const b1 = Math.min(nz - 1, sj1 + 1)
    for (let j = b0; j <= b1; j++) {
      for (let i = a0; i <= a1; i++) {
        const v = live[j * nx + i]
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    out.push({
      levelId: p.levelId,
      min: { x: p.originX + a0 * s, y: lo - Math.max(p.thickness, HEIGHTFIELD_MIN_THICKNESS), z: p.originZ + b0 * s },
      max: { x: p.originX + a1 * s, y: hi, z: p.originZ + b1 * s },
    })
    // Chunk (ci, cj) holds cells [ci·C, (ci + 1)·C), i.e. the triangles of samples ci·C..(ci + 1)·C.
    const C = HEIGHTFIELD_CHUNK_CELLS
    const surface = { ...p, heights: live }
    h.chunks.forEach((c, m) => {
      if (c.ci * C > si1 || (c.ci + 1) * C < si0 || c.cj * C > sj1 || (c.cj + 1) * C < sj0) return
      this.rewriteChunk(h, m, surface)
      h.touched.add(m)
    })
  }

  /** Back to the primitive's own heights (the chunks the preview rewrote), pushing their old ∪ new bounds. */
  private restoreHeightfield(h: HeightfieldProxy, out: DirtyRegion[]): void {
    if (!h.live) return
    h.live = null
    const touched = [...h.touched]
    h.touched.clear()
    const meshes = touched.map((m) => h.meshes[m])
    const box = meshesBox(meshes)
    for (const m of touched) this.rewriteChunk(h, m, h.prim)
    if (touched.length > 0) out.push(regionOf(h.prim.levelId, meshesBox(meshes, box)))
  }

  /**
   * A heightfield primitive replaced by `now` on the lattice its proxy was built from (same origin, spacing,
   * size, solid mask, thickness and channels; a terrain commit): the chunk meshes holding a sample whose
   * height differs from what they show (an ended preview's heights while update settles it, else the old
   * primitive's) are rewritten in place, pushing their old ∪ new bounds (one region per run of adjacent
   * chunks along a chunk row). False = rebuild it instead: no proxy, another lattice, or its level is still
   * previewed (the rebuild gets the preview again).
   */
  private moveHeightfield(now: Heightfield, out: DirtyRegion[]): boolean {
    const h = this.heightfields.get(now.key)
    if (!h || this.previews.has(now.levelId)) return false
    const p = h.prim
    const C = HEIGHTFIELD_CHUNK_CELLS
    const nx = now.samplesX
    const nz = now.samplesZ
    const cx = Math.ceil((nx - 1) / C)
    const cz = Math.ceil((nz - 1) / C)
    if (
      !(cx > 0 && cz > 0) ||
      now.levelId !== p.levelId ||
      proxyLayerMask(now) !== proxyLayerMask(p) ||
      now.originX !== p.originX ||
      now.originZ !== p.originZ ||
      now.spacing !== p.spacing ||
      nx !== p.samplesX ||
      nz !== p.samplesZ ||
      now.thickness !== p.thickness ||
      now.heights.length !== nx * nz ||
      !sameArray(now.solid, p.solid)
    ) {
      return false
    }
    const shown = h.live ?? p.heights
    const H = now.heights
    // Chunk (ci, cj) draws samples ci·C..(ci + 1)·C (heightfieldChunkTriangles): flag every chunk holding a changed one.
    const changed = new Uint8Array(cx * cz)
    let any = false
    for (let j = 0; j < nz; j++) {
      const row = j * nx
      for (let i = 0; i < nx; i++) {
        if (H[row + i] === shown[row + i]) continue
        any = true
        const ci0 = Math.max(Math.ceil(i / C) - 1, 0)
        const ci1 = Math.min(Math.floor(i / C), cx - 1)
        const cj0 = Math.max(Math.ceil(j / C) - 1, 0)
        const cj1 = Math.min(Math.floor(j / C), cz - 1)
        for (let b = cj0; b <= cj1; b++) for (let a = ci0; a <= ci1; a++) changed[b * cx + a] = 1
      }
    }
    h.prim = now
    h.live = null
    h.touched.clear()
    // primitiveAabb of the new heights, even when no mesh moves (they already showed them).
    this.boundsCache = null
    if (!any) return true
    const moved: { c: { ci: number; cj: number }; box: THREE.Box3 }[] = []
    h.chunks.forEach((c, m) => {
      if (!changed[c.cj * cx + c.ci]) return
      const box = meshesBox([h.meshes[m]])
      this.rewriteChunk(h, m, now)
      moved.push({ c, box: meshesBox([h.meshes[m]], box) })
    })
    moved.sort((a, b) => a.c.cj - b.c.cj || a.c.ci - b.c.ci)
    let run: THREE.Box3 | null = null
    for (let k = 0; k < moved.length; k++) {
      const { c, box } = moved[k]
      const prev = k > 0 ? moved[k - 1].c : null
      if (run && prev && prev.cj === c.cj && prev.ci + 1 === c.ci) run.union(box)
      else {
        if (run && !run.isEmpty()) out.push(regionOf(now.levelId, run))
        run = box
      }
    }
    if (run && !run.isEmpty()) out.push(regionOf(now.levelId, run))
    return true
  }

  /** Rewrite chunk mesh `m` of a heightfield proxy from `surface` (its heights), in place when the topology matches. */
  private rewriteChunk(h: HeightfieldProxy, m: number, surface: Heightfield): void {
    const mesh = h.meshes[m]
    const { ci, cj } = h.chunks[m]
    const position = mesh.geometry.getAttribute("position") as THREE.BufferAttribute
    const sink = new ArrayTriangleSink(position.array as Float32Array)
    heightfieldChunkTriangles(surface, ci, cj, sink)
    if (sink.offset === position.array.length) {
      position.needsUpdate = true
      mesh.geometry.computeBoundingBox()
      mesh.geometry.computeBoundingSphere()
      return
    }
    // Never expected (the triangle order depends only on the lattice size and the solid mask): rebuild.
    const grown = new TriangleSink()
    heightfieldChunkTriangles(surface, ci, cj, grown)
    const geometry = positionsGeometry(grown.toArray())
    geometry.setAttribute("aKey", new THREE.BufferAttribute(new Float32Array(grown.length / 3).fill(this.keyId(h.prim.key)), 1))
    mesh.geometry.dispose()
    mesh.geometry = geometry
  }

  private groupKey(p: GroupedPrimitive): string {
    const cx = p.shape === "cylinder" ? p.base.x : p.center.x
    const cz = p.shape === "cylinder" ? p.base.z : p.center.z
    return `${p.levelId}|${proxyLayerMask(p)}|${p.shape}|${Math.floor(cx / PROXY_BUCKET_FEET)},${Math.floor(cz / PROXY_BUCKET_FEET)}`
  }

  private addPrimitive(p: OccluderPrimitive, touched: Set<Group>, dirty?: DirtyRegion[]): void {
    if (p.shape === "heightfield") {
      const h = this.buildHeightfield(p)
      this.heightfields.set(p.key, h)
      // Rebuilt while its level is previewed: it shows the preview too.
      const lp = this.previews.get(p.levelId)
      if (lp) this.applyPreview(h, lp.ground, null, dirty ?? [])
      return
    }
    const key = this.groupKey(p)
    let g = this.groups.get(key)
    if (!g) {
      g =
        p.shape === "strip"
          ? { kind: "strip", key, layerMask: proxyLayerMask(p), prims: new Map(), mesh: null }
          : { kind: "instanced", key, shape: p.shape, layerMask: proxyLayerMask(p), prims: new Map(), mesh: null, capacity: 0 }
      this.groups.set(key, g)
    }
    // The key carries the shape, so a group only ever holds its own kind.
    if (g.kind === "strip") g.prims.set(p.key, p as WallStrip)
    else g.prims.set(p.key, p as InstancedPrimitive)
    touched.add(g)
  }

  /** `dirty` also gets what a heightfield showing a preview drew (update's region() covers the primitive's own heights). */
  private removePrimitive(p: OccluderPrimitive, touched: Set<Group>, dirty: DirtyRegion[]): void {
    if (p.shape === "heightfield") {
      const h = this.heightfields.get(p.key)
      if (h?.live && h.meshes.length > 0) dirty.push(regionOf(p.levelId, meshesBox(h.meshes)))
      if (h) this.disposeHeightfield(h)
      this.heightfields.delete(p.key)
      return
    }
    const g = this.groups.get(this.groupKey(p))
    if (!g) return
    g.prims.delete(p.key)
    touched.add(g)
  }

  private rebuildGroup(g: Group): void {
    if (g.prims.size === 0) {
      this.disposeGroupMesh(g)
      this.groups.delete(g.key)
      return
    }
    if (g.kind === "strip") this.rebuildStripGroup(g)
    else this.rebuildInstanceGroup(g)
  }

  /** Merge a strip group's members into one closed mesh (per-vertex keys). */
  private rebuildStripGroup(g: StripGroup): void {
    const sink = new TriangleSink()
    const keys: number[] = []
    for (const p of g.prims.values()) {
      const before = sink.length
      stripTriangles(p, sink)
      const key = this.keyId(p.key)
      for (let k = before; k < sink.length; k += 3) keys.push(key)
    }
    const geometry = positionsGeometry(sink.toArray())
    geometry.setAttribute("aKey", new THREE.BufferAttribute(new Float32Array(keys), 1))
    if (g.mesh) {
      g.mesh.geometry.dispose()
      g.mesh.geometry = geometry
      return
    }
    const mesh = new THREE.Mesh(geometry, this.material)
    mesh.name = `occluders:${g.key}`
    mesh.layers.mask = g.layerMask
    mesh.matrixAutoUpdate = false
    mesh.matrixWorldAutoUpdate = false
    this.scene.add(mesh)
    g.mesh = mesh
  }

  private rebuildInstanceGroup(g: InstanceGroup): void {
    // Floor boxes standing in for a terrain preview are left out.
    const members = this.previews.size === 0 ? [...g.prims.values()] : [...g.prims.values()].filter((p) => !this.hidden(p))
    const count = members.length
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
    for (const p of members) {
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
    const built = heightfieldChunks(p)
    const meshes = built.map((chunk) => {
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
    return { prim: p, meshes, chunks: built.map(({ ci, cj }) => ({ ci, cj })), live: null, touched: new Set() }
  }

  private disposeGroupMesh(g: Group): void {
    if (!g.mesh) return
    this.scene.remove(g.mesh)
    g.mesh.geometry.dispose()
    if (g.kind === "instanced") {
      g.mesh.dispose()
      g.capacity = 0
    }
    g.mesh = null
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
    for (const [levelId, lp] of this.previews) for (const st of lp.standIns.values()) if (st.proxy.meshes.includes(o as THREE.Mesh)) return levelId
    return null
  }

  dispose(): void {
    this.dropPreviews()
    for (const g of this.groups.values()) this.disposeGroupMesh(g)
    for (const h of this.heightfields.values()) this.disposeHeightfield(h)
    this.groups.clear()
    this.heightfields.clear()
    this.prims.clear()
    this.boundsCache = null
  }
}
