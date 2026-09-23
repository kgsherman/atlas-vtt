/**
 * One level's three.js objects (ARCHITECTURE §4.3): a THREE.Group (renderOrder = draw rank) holding
 * one plain Object3D per bucket (never nested Groups, so the level's group order applies to every
 * mesh). World meshes use the level's materials from the lighting system; ghost mode swaps them to
 * the ghost variant and adds a depth-only pre-pass clone per mesh.
 */
import * as THREE from "three"

import type { DoorState, Id } from "@/core/scene/types"

import { DOOR_MARKER_ACCENT, doorLeafPose, type DoorLeaf } from "../builders/doors"
import { isSharedGeometry } from "../builders/shared"
import { BUCKETS, type BucketBuild, type BucketKind, type FlameAnimation, type MeshBuild } from "../builders/types"
import type { TriRange } from "../builders/writer"
import { LAYER } from "../internal"
import { disposeCachedEdges, type ObjectMeshRef } from "../overlays/highlight"
import type { LevelDrawMode } from "./levelPlan"
import { trackShared } from "./sharedResources"

export interface LevelMaterials {
  opaque: THREE.ShaderMaterial
  opaqueInstanced: THREE.ShaderMaterial
  ghost: THREE.ShaderMaterial
  ghostInstanced: THREE.ShaderMaterial
  ghostDepth: THREE.ShaderMaterial
  ghostDepthInstanced: THREE.ShaderMaterial
}

/** Materials shared by every level (created once by the engine). */
export interface SharedMaterials {
  token: THREE.ShaderMaterial
  glass: THREE.Material
  flame: THREE.Material
  /** Additive glow sprites around flames (optional: none when absent). */
  glow?: THREE.Material
}

export interface DoorLeafState {
  leaf: DoorLeaf
  pivot: THREE.Object3D
  mesh: THREE.Mesh
  /** Last applied open fraction (NaN = never applied). */
  applied: number
  /** Top-down marker (second child of the pivot; builders/doors.ts doorMarkerGeometry), null if none. */
  marker: THREE.Mesh | null
  /** The marker's built vertex colours (the style colour), recoloured per door state. */
  markerBase: Float32Array | null
  /** Door state the marker colours show ("" = never applied). */
  markerState: DoorState | ""
}

/** userData.slot of door markers (drawn with the world material, shown only in top-down views). */
export const DOOR_MARKER_SLOT = "doorMarker"

/** Linear red of a locked door's marker plate. */
const LOCKED_ACCENT: readonly [number, number, number] = [0.8, 0.06, 0.04]
/** Colour scale of an open door's marker. */
const OPEN_MARKER_SCALE = 0.45

export interface FlameState {
  mesh: THREE.InstancedMesh
  base: Float32Array
  flames: FlameAnimation[]
}

interface BucketState {
  root: THREE.Object3D
  meshes: THREE.Mesh[]
  doors: DoorLeafState[]
  flames: FlameState[]
  terrain: { mesh: THREE.Mesh; offsets: Float32Array } | null
  index: Map<Id, ObjectMeshRef[]> | null
}

/** Render orders inside a level group (the group's own renderOrder is the level rank). */
const ORDER_GHOST_DEPTH = 1
const ORDER_GHOST_COLOR = 2
const ORDER_GLASS = 3
const ORDER_GLOW = 4

let glowQuad: THREE.BufferGeometry | null = null
/** Unit quad in the XY plane (camera-facing in the glow shader), shared by every glow mesh. */
function glowQuadGeometry(): THREE.BufferGeometry {
  if (!glowQuad) {
    glowQuad = new THREE.PlaneGeometry(1, 1)
    glowQuad.userData.shared = true
    glowQuad.name = "fixture:glow"
    trackShared(glowQuad)
  }
  return glowQuad
}

const tmpMatrix = new THREE.Matrix4()
/** Depth pre-pass clone of each ghosted mesh (kept out of userData so meshes stay clonable). */
const ghostClones = new WeakMap<THREE.Mesh, THREE.Mesh>()

export class LevelView {
  readonly id: Id
  readonly group = new THREE.Group()
  readonly materials: LevelMaterials
  private readonly shared: SharedMaterials
  private readonly buckets = new Map<BucketKind, BucketState>()
  private _mode: LevelDrawMode = "solid"
  private markersVisible = false
  /** Render layer of flames and glow sprites (see setEmissiveLayer). */
  private emissiveLayer: number = LAYER.VISUAL

  constructor(id: Id, materials: LevelMaterials, shared: SharedMaterials) {
    this.id = id
    this.materials = materials
    this.shared = shared
    this.group.name = `level:${id}`
    for (const kind of BUCKETS) {
      const root = new THREE.Object3D()
      root.name = kind
      this.group.add(root)
      this.buckets.set(kind, { root, meshes: [], doors: [], flames: [], terrain: null, index: null })
    }
  }

  get mode(): LevelDrawMode {
    return this._mode
  }

  setRank(rank: number): void {
    this.group.renderOrder = rank
  }

  /** Replace a bucket's meshes (old geometries are disposed unless shared). */
  setBucket(kind: BucketKind, build: BucketBuild): void {
    const b = this.buckets.get(kind)!
    this.clearBucket(b)
    for (const m of build.meshes) this.addMesh(b, m)
    this.applyModeTo(b)
  }

  /**
   * Render layer of flames and glow sprites: VISUAL (the world pass; into the HDR target with bloom on
   * high / ultra) or OVERLAY (medium's bloom-less post: drawn onto the canvas after the composite, so
   * they blend in display space and look exactly as when the world was drawn straight to the canvas).
   */
  setEmissiveLayer(layer: number): void {
    if (layer === this.emissiveLayer) return
    this.emissiveLayer = layer
    for (const b of this.buckets.values()) for (const mesh of b.meshes) this.applyEmissiveLayer(mesh)
  }

  private applyEmissiveLayer(mesh: THREE.Mesh): void {
    if (mesh.userData.slot === "flame" || mesh.userData.slot === "glow") mesh.layers.set(this.emissiveLayer)
  }

  private addMesh(b: BucketState, m: MeshBuild): void {
    switch (m.kind) {
      case "merged": {
        const material = m.slot === "world" ? this.materials.opaque : m.slot === "token" ? this.shared.token : m.slot === "glass" ? this.shared.glass : this.shared.flame
        const mesh = new THREE.Mesh(m.geometry, material)
        mesh.name = m.name
        mesh.userData.slot = m.slot
        // The token material (fixture holders) reads the level for its host-mask layer.
        mesh.userData.levelId = this.id
        mesh.userData.ranges = m.geometry.userData.ranges as TriRange[]
        if (m.slot === "glass") mesh.renderOrder = ORDER_GLASS
        mesh.matrixAutoUpdate = false
        this.applyEmissiveLayer(mesh)
        b.root.add(mesh)
        b.meshes.push(mesh)
        if (m.terrainOffsets) b.terrain = { mesh, offsets: m.terrainOffsets }
        break
      }
      case "instanced": {
        const material = m.slot === "world" ? this.materials.opaqueInstanced : m.slot === "flame" ? this.shared.flame : this.shared.token
        const mesh = new THREE.InstancedMesh(m.geometry, material, m.ids.length)
        mesh.name = m.name
        mesh.userData.slot = m.slot
        mesh.userData.levelId = this.id
        mesh.userData.instanceIds = m.ids
        mesh.instanceMatrix.array.set(m.matrices)
        mesh.instanceMatrix.needsUpdate = true
        mesh.instanceColor = new THREE.InstancedBufferAttribute(m.colors.slice(), 3)
        mesh.computeBoundingSphere()
        mesh.computeBoundingBox()
        mesh.matrixAutoUpdate = false
        this.applyEmissiveLayer(mesh)
        b.root.add(mesh)
        b.meshes.push(mesh)
        if (m.flames) {
          mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
          b.flames.push({ mesh, base: m.matrices.slice(), flames: m.flames })
          if (this.shared.glow) {
            // Glow sprites share the flames' instances (and so their flicker).
            const glow = new THREE.InstancedMesh(glowQuadGeometry(), this.shared.glow, m.ids.length)
            glow.name = `${m.name}:glow`
            glow.instanceMatrix = mesh.instanceMatrix
            glow.instanceColor = mesh.instanceColor
            glow.userData.slot = "glow"
            glow.userData.levelId = this.id
            glow.renderOrder = ORDER_GLOW
            glow.frustumCulled = false
            glow.matrixAutoUpdate = false
            glow.raycast = () => {}
            this.applyEmissiveLayer(glow)
            b.root.add(glow)
            b.meshes.push(glow)
          }
        }
        break
      }
      case "door": {
        const pivot = new THREE.Object3D()
        pivot.name = m.name
        const mesh = new THREE.Mesh(m.geometry, this.materials.opaque)
        mesh.name = m.name
        mesh.userData.slot = "world"
        mesh.userData.objectId = m.leaf.doorId
        pivot.add(mesh)
        let marker: THREE.Mesh | null = null
        if (m.marker) {
          // Second child of the pivot: follows the leaf's swing / slide (an open swing door shows as a
          // bar at right angles to the wall). Outlined on hover / selection like the leaf (objectRefs).
          marker = new THREE.Mesh(m.marker, this.materials.opaque)
          marker.name = `${m.name}:marker`
          marker.userData.slot = DOOR_MARKER_SLOT
          marker.userData.objectId = m.leaf.doorId
          pivot.add(marker)
          b.meshes.push(marker)
        }
        b.root.add(pivot)
        b.meshes.push(mesh)
        const base = m.marker?.getAttribute("color")?.array
        b.doors.push({ leaf: m.leaf, pivot, mesh, applied: Number.NaN, marker, markerBase: base ? Float32Array.from(base) : null, markerState: "" })
        break
      }
    }
  }

  private clearBucket(b: BucketState): void {
    for (const mesh of b.meshes) {
      this.removeGhostClone(mesh)
      if (!isSharedGeometry(mesh.geometry)) {
        disposeCachedEdges(mesh.geometry)
        mesh.geometry.dispose()
      }
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose()
    }
    b.root.clear()
    b.meshes = []
    b.doors = []
    b.flames = []
    b.terrain = null
    b.index = null
  }

  // -------------------------------------------------------------------------
  // Draw modes
  // -------------------------------------------------------------------------

  setMode(mode: LevelDrawMode): void {
    if (mode === this._mode) return
    this._mode = mode
    for (const b of this.buckets.values()) this.applyModeTo(b)
  }

  /** Door markers are for top-down views only (the engine follows ViewState.camera). */
  setDoorMarkersVisible(visible: boolean): void {
    if (visible === this.markersVisible) return
    this.markersVisible = visible
    for (const b of this.buckets.values()) for (const d of b.doors) this.syncMarker(d.marker)
  }

  private syncMarker(marker: THREE.Mesh | null): void {
    if (marker) marker.visible = this.markersVisible && this._mode === "solid" && marker.userData.liftHidden !== true
  }

  private applyModeTo(b: BucketState): void {
    const mode = this._mode
    this.group.visible = mode !== "hidden"
    for (const mesh of b.meshes) {
      const inst = (mesh as THREE.InstancedMesh).isInstancedMesh === true
      if (mesh.userData.slot === DOOR_MARKER_SLOT) {
        // Never ghosted: shown on solid levels in top-down views.
        this.syncMarker(mesh)
        continue
      }
      if (mesh.userData.slot !== "world") {
        // Glass, flames and fixture holders are not ghosted.
        mesh.visible = mode === "solid"
        continue
      }
      if (mode === "ghost") {
        mesh.material = inst ? this.materials.ghostInstanced : this.materials.ghost
        mesh.renderOrder = ORDER_GHOST_COLOR
        this.addGhostClone(mesh, inst)
      } else {
        mesh.material = inst ? this.materials.opaqueInstanced : this.materials.opaque
        mesh.renderOrder = 0
        this.removeGhostClone(mesh)
      }
    }
  }

  /** Depth-only pre-pass copy (§4.3): same geometry/instances, colorWrite off, drawn just before. */
  private addGhostClone(mesh: THREE.Mesh, instanced: boolean): void {
    if (ghostClones.has(mesh)) return
    let clone: THREE.Mesh
    if (instanced) {
      const src = mesh as THREE.InstancedMesh
      const c = new THREE.InstancedMesh(src.geometry, this.materials.ghostDepthInstanced, src.count)
      c.instanceMatrix = src.instanceMatrix
      c.instanceColor = src.instanceColor
      c.computeBoundingSphere()
      clone = c
    } else {
      clone = new THREE.Mesh(mesh.geometry, this.materials.ghostDepth)
    }
    clone.name = `${mesh.name}:ghost-depth`
    clone.renderOrder = ORDER_GHOST_DEPTH
    clone.raycast = () => {}
    mesh.add(clone)
    ghostClones.set(mesh, clone)
  }

  private removeGhostClone(mesh: THREE.Mesh): void {
    const clone = ghostClones.get(mesh)
    if (!clone) return
    // The clone shares the source's buffers; detaching is enough (no dispose).
    clone.removeFromParent()
    ghostClones.delete(mesh)
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Meshes drawing an object (for outlines). */
  objectRefs(id: Id): ObjectMeshRef[] {
    const out: ObjectMeshRef[] = []
    for (const b of this.buckets.values()) {
      if (!b.index) b.index = buildIndex(b)
      const refs = b.index.get(id)
      if (refs) out.push(...refs)
    }
    return out
  }

  /** Meshes to raycast for object picking (floors are picked analytically by the engine). */
  pickMeshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = []
    for (const [kind, b] of this.buckets) {
      if (kind === "floors") continue
      for (const m of b.meshes) {
        if (m.userData.slot === "glass" || m.userData.slot === "glow") continue
        // THREE.Raycaster ignores .visible: hidden door markers (orbit views) must not be picked.
        if (m.userData.slot === DOOR_MARKER_SLOT && !m.visible) continue
        out.push(m)
      }
    }
    return out
  }

  /** Terrain mesh of the floors bucket (levels with a heightmap or a brush preview). */
  terrain(): { mesh: THREE.Mesh; offsets: Float32Array } | null {
    return this.buckets.get("floors")!.terrain
  }

  doorLeaves(): DoorLeafState[] {
    return this.buckets.get("doors")!.doors
  }

  flames(): FlameState[] {
    return this.buckets.get("fixtures")!.flames
  }

  /** Apply a door leaf pose at open fraction t (skips unchanged leaves). */
  static applyDoor(state: DoorLeafState, t: number): void {
    if (state.applied === t) return
    const pose = doorLeafPose(state.leaf, t)
    state.pivot.position.set(pose.x, pose.y, pose.z)
    state.pivot.rotation.set(0, pose.yaw, 0)
    state.pivot.updateMatrix()
    state.pivot.updateMatrixWorld(true)
    state.applied = t
  }

  /**
   * Door marker for the door's state: the style colour when closed, a red centre plate when locked,
   * dimmed when open; hidden while a lifting door is more than half raised (lifting is not visible from
   * above). Cheap when nothing changed.
   */
  applyDoorMarker(state: DoorLeafState, doorState: DoorState, t: number): void {
    const marker = state.marker
    if (!marker) return
    const liftHidden = state.leaf.motion === "lift" && t > 0.5
    if (marker.userData.liftHidden !== liftHidden) {
      marker.userData.liftHidden = liftHidden
      this.syncMarker(marker)
    }
    const base = state.markerBase
    if (state.markerState === doorState || !base) return
    state.markerState = doorState
    const attr = marker.geometry.getAttribute("color") as THREE.BufferAttribute | undefined
    if (!attr) return
    const arr = attr.array as Float32Array
    const accentStart = (marker.geometry.userData[DOOR_MARKER_ACCENT] as number | undefined) ?? attr.count
    const scale = doorState === "open" ? OPEN_MARKER_SCALE : 1
    for (let v = 0; v < attr.count; v++) {
      for (let c = 0; c < 3; c++) {
        arr[v * 3 + c] = doorState === "locked" && v >= accentStart ? LOCKED_ACCENT[c] : base[v * 3 + c] * scale
      }
    }
    attr.needsUpdate = true
  }

  /** Update flame instances for flicker (visual only). */
  animateFlames(timeSec: number, flicker: (a: FlameAnimation, t: number) => number): void {
    if (this._mode !== "solid") return
    for (const f of this.flames()) {
      const arr = f.mesh.instanceMatrix.array as Float32Array
      for (let k = 0; k < f.flames.length; k++) {
        const s = flicker(f.flames[k], timeSec)
        tmpMatrix.fromArray(f.base, k * 16)
        // Scale about the flame's own centre: columns 0..2 scale, translation unchanged.
        const e = tmpMatrix.elements
        const sy = s * (0.9 + 0.1 * s)
        for (let c = 0; c < 3; c++) {
          e[c] *= s
          e[4 + c] *= sy
          e[8 + c] *= s
        }
        tmpMatrix.toArray(arr, k * 16)
      }
      f.mesh.instanceMatrix.needsUpdate = true
    }
  }

  dispose(): void {
    for (const b of this.buckets.values()) this.clearBucket(b)
    this.group.removeFromParent()
    for (const m of Object.values(this.materials)) m.dispose()
  }
}

function buildIndex(b: BucketState): Map<Id, ObjectMeshRef[]> {
  const index = new Map<Id, ObjectMeshRef[]>()
  const push = (id: Id, ref: ObjectMeshRef) => {
    let list = index.get(id)
    if (!list) index.set(id, (list = []))
    list.push(ref)
  }
  for (const mesh of b.meshes) {
    if (mesh.userData.slot === "glow") continue
    if (mesh.userData.objectId) {
      push(mesh.userData.objectId as Id, { kind: "whole", mesh })
    } else if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
      const ids = mesh.userData.instanceIds as Id[]
      ids.forEach((id, index) => push(id, { kind: "instance", mesh: mesh as THREE.InstancedMesh, index }))
    } else {
      const ranges = mesh.userData.ranges as TriRange[] | undefined
      if (!ranges) continue
      const byId = new Map<Id, TriRange[]>()
      for (const r of ranges) {
        let list = byId.get(r.id)
        if (!list) byId.set(r.id, (list = []))
        list.push(r)
      }
      for (const [id, rs] of byId) push(id, { kind: "ranges", mesh, ranges: rs })
    }
  }
  return index
}
