/**
 * Token layer: instanced token bodies drawn with the lighting system's token material, one set of
 * InstancedMeshes per level (the material reads `userData.levelId` for the level's host-mask layer
 * and `userData.tokenIds` for per-instance dimming), plus unlit decorations: faded outline markers
 * for tokens on levels above the cutaway, selection / hover / pending rings and drag ghosts.
 *
 * Appear/disappear: 150 ms fade through the token material's per-instance `aFade` attribute (with
 * a slight scale-in). Instance data is recomputed only when inputs change or a fade is running.
 */
import * as THREE from "three"

import type { Id, SceneLike, Token } from "@/core/scene/types"

import { hexToLinear, scaleRgb, type RGB } from "../builders/color"
import { tokenBaseGeometry, tokenBodyGeometry, tokenOutlineGeometry, tokenRingGeometry, tokenTransforms, tokenVisual, type TokenVisual } from "../builders/tokens"
import type { OverlayState, ViewState } from "../contracts"
import type { LevelPlanEntry } from "./levelPlan"

export const TOKEN_FADE_MS = 150

interface Entry {
  visual: TokenVisual
  /** performance.now() when it appeared (null = present from the start). */
  appearAt: number | null
  /** When it left the scene (kept for the fade-out). */
  leaveAt: number | null
  hidden: boolean
}

const SELECT: RGB = hexToLinear("#34d399")
const HOVER: RGB = hexToLinear("#d4d4d8")
const PENDING: RGB = hexToLinear("#38bdf8")

interface InstanceData {
  matrices: THREE.Matrix4[]
  colors: RGB[]
  fades?: number[]
}

/**
 * InstancedMesh that grows its capacity on demand. With `ownGeometry` it draws a private clone of
 * the unit geometry, so per-instance attributes set on the geometry (aFade here, aDim by the token
 * material) never leak between meshes.
 */
class GrowingInstances {
  mesh: THREE.InstancedMesh
  private readonly unit: THREE.BufferGeometry
  private readonly material: THREE.Material
  private readonly parent: THREE.Object3D
  private readonly ownGeometry: boolean
  private readonly configure: (m: THREE.InstancedMesh) => void

  constructor(parent: THREE.Object3D, unit: THREE.BufferGeometry, material: THREE.Material, ownGeometry: boolean, configure: (m: THREE.InstancedMesh) => void) {
    this.parent = parent
    this.unit = unit
    this.material = material
    this.ownGeometry = ownGeometry
    this.configure = configure
    this.mesh = this.create(16)
  }

  private create(capacity: number): THREE.InstancedMesh {
    let geometry = this.unit
    if (this.ownGeometry) {
      geometry = this.unit.clone()
      geometry.userData = { owned: true }
      const fade = new THREE.InstancedBufferAttribute(new Float32Array(capacity).fill(1), 1)
      fade.setUsage(THREE.DynamicDrawUsage)
      geometry.setAttribute("aFade", fade)
    }
    const m = new THREE.InstancedMesh(geometry, this.material, capacity)
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
    m.instanceColor.setUsage(THREE.DynamicDrawUsage)
    m.count = 0
    m.frustumCulled = false
    this.configure(m)
    this.parent.add(m)
    return m
  }

  set(data: InstanceData, ids?: Id[]): void {
    const n = data.matrices.length
    if (n > this.mesh.instanceMatrix.count) {
      const old = this.mesh
      this.mesh = this.create(Math.max(n, old.instanceMatrix.count * 2))
      this.release(old)
    }
    const m = this.mesh
    const fade = m.geometry.getAttribute("aFade") as THREE.InstancedBufferAttribute | undefined
    for (let k = 0; k < n; k++) {
      m.setMatrixAt(k, data.matrices[k])
      const c = data.colors[k]
      m.instanceColor!.setXYZ(k, c[0], c[1], c[2])
      if (fade) fade.setX(k, data.fades?.[k] ?? 1)
    }
    m.count = n
    m.instanceMatrix.needsUpdate = true
    m.instanceColor!.needsUpdate = true
    if (fade) fade.needsUpdate = true
    if (ids) m.userData.tokenIds = ids
    m.computeBoundingSphere()
  }

  private release(m: THREE.InstancedMesh): void {
    m.removeFromParent()
    m.dispose()
    if (m.geometry.userData.owned) m.geometry.dispose()
  }

  dispose(): void {
    this.release(this.mesh)
  }
}

/** Solid tokens of one level. */
class LevelTokens {
  readonly root = new THREE.Object3D()
  readonly base: GrowingInstances
  readonly ring: GrowingInstances
  readonly body: GrowingInstances

  constructor(levelId: Id, material: THREE.Material) {
    this.root.name = `tokens:${levelId}`
    const configure = (m: THREE.InstancedMesh) => {
      m.userData.levelId = levelId
      m.userData.slot = "token"
    }
    this.base = new GrowingInstances(this.root, tokenBaseGeometry(), material, true, configure)
    this.ring = new GrowingInstances(this.root, tokenRingGeometry(), material, true, configure)
    this.body = new GrowingInstances(this.root, tokenBodyGeometry(), material, true, configure)
  }

  dispose(): void {
    this.base.dispose()
    this.ring.dispose()
    this.body.dispose()
    this.root.removeFromParent()
  }
}

export interface TokenLayerInputs {
  scene: SceneLike | null
  plan: ReadonlyMap<Id, LevelPlanEntry>
  view: ViewState
  overlays: OverlayState
}

export class TokenLayer {
  /** Solid tokens (lit). */
  readonly root = new THREE.Group()
  /** Unlit decorations; the engine adds this under the overlay root. */
  readonly decor = new THREE.Object3D()
  private readonly material: THREE.Material
  private readonly levels = new Map<Id, LevelTokens>()
  private readonly markers: GrowingInstances
  private readonly rings: GrowingInstances
  private readonly ghostBase: GrowingInstances
  private readonly ghostBody: GrowingInstances
  private readonly decorMaterials: THREE.Material[]
  private readonly entries = new Map<Id, Entry>()
  private dirty = true
  private wasAnimating = false
  private initialised = false

  /** `tokenMaterial`: the lighting system's instanced token material (made transparent for fades). */
  constructor(tokenMaterial: THREE.Material) {
    this.material = tokenMaterial
    // Fades write alpha < 1 through aFade; blending needs the transparent pipeline.
    tokenMaterial.transparent = true
    this.root.name = "tokens"
    this.root.renderOrder = 0
    this.decor.name = "token-decor"
    const markerMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide })
    const ringMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthTest: false, depthWrite: false, toneMapped: false, side: THREE.DoubleSide })
    const ghostMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, depthWrite: false, toneMapped: false, vertexColors: true })
    this.decorMaterials = [markerMat, ringMat, ghostMat]
    const decor = (order: number) => (m: THREE.InstancedMesh) => {
      m.renderOrder = order
      m.raycast = () => {}
    }
    this.markers = new GrowingInstances(this.decor, tokenOutlineGeometry(), markerMat, false, decor(8))
    this.rings = new GrowingInstances(this.decor, tokenOutlineGeometry(), ringMat, false, decor(9))
    this.ghostBase = new GrowingInstances(this.decor, tokenBaseGeometry(), ghostMat, false, decor(10))
    this.ghostBody = new GrowingInstances(this.decor, tokenBodyGeometry(), ghostMat, false, decor(10))
  }

  /** Inputs changed (scene, view, overlays): recompute on the next update. */
  invalidate(): void {
    this.dirty = true
  }

  /** Solid token meshes (for picking). */
  pickMeshes(): THREE.InstancedMesh[] {
    const out: THREE.InstancedMesh[] = []
    for (const lt of this.levels.values()) out.push(lt.body.mesh, lt.base.mesh)
    return out
  }

  /**
   * Sync entries with the scene (appear/disappear timestamps). `animate` = false (a full scene
   * replacement) shows tokens immediately.
   */
  syncScene(scene: SceneLike | null, now: number, animate: boolean): void {
    const present = new Set<Id>()
    if (scene) {
      for (const t of Object.values(scene.tokens) as Token[]) {
        if (!Object.hasOwn(scene.levels, t.levelId)) continue
        present.add(t.id)
        const visual = tokenVisual(scene, t)
        const e = this.entries.get(t.id)
        if (e && e.leaveAt === null) {
          e.visual = visual
          e.hidden = t.hidden
        } else {
          this.entries.set(t.id, { visual, appearAt: animate && this.initialised ? now : null, leaveAt: null, hidden: t.hidden })
        }
      }
      // Levels that no longer exist lose their meshes.
      for (const [levelId, lt] of this.levels) {
        if (!Object.hasOwn(scene.levels, levelId)) {
          lt.dispose()
          this.levels.delete(levelId)
        }
      }
    }
    for (const [id, e] of this.entries) {
      if (present.has(id)) continue
      if (!animate) this.entries.delete(id)
      else if (e.leaveAt === null) e.leaveAt = now
    }
    this.initialised = true
    this.dirty = true
  }

  private levelTokens(levelId: Id): LevelTokens {
    let lt = this.levels.get(levelId)
    if (!lt) {
      lt = new LevelTokens(levelId, this.material)
      this.levels.set(levelId, lt)
      this.root.add(lt.root)
    }
    return lt
  }

  /** Recompute instances when needed. Returns true while a fade is running. */
  update(inputs: TokenLayerInputs, now: number): boolean {
    let animating = false
    for (const [id, e] of this.entries) {
      if (e.leaveAt !== null && now - e.leaveAt >= TOKEN_FADE_MS) {
        this.entries.delete(id)
        this.dirty = true
      } else if ((e.appearAt !== null && now - e.appearAt < TOKEN_FADE_MS) || e.leaveAt !== null) animating = true
    }
    // One more pass after a fade ends so the final (fully opaque) state is written.
    const settle = this.wasAnimating && !animating
    this.wasAnimating = animating
    if (!this.dirty && !animating && !settle) return false
    this.dirty = false
    const { plan, view, overlays } = inputs
    const selected = new Set(overlays.selectedIds)
    const perLevel = new Map<Id, { base: InstanceData; body: InstanceData; ids: Id[] }>()
    const markers: InstanceData = { matrices: [], colors: [] }
    const rings: InstanceData = { matrices: [], colors: [] }
    const sorted = [...this.entries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    for (const [id, e] of sorted) {
      const draw = plan.get(e.visual.levelId)?.tokens ?? "none"
      if (draw === "none") continue
      let f = 1
      if (e.leaveAt !== null) f = 1 - (now - e.leaveAt) / TOKEN_FADE_MS
      else if (e.appearAt !== null) f = (now - e.appearAt) / TOKEN_FADE_MS
      // Clamp: frame timestamps can precede an event handled during the same frame.
      f = Math.min(1, Math.max(0, f))
      f = f * f * (3 - 2 * f)
      if (f <= 0.001) continue
      const tr = tokenTransforms(e.visual, 0.85 + 0.15 * f)
      if (draw === "marker") {
        markers.matrices.push(tr.outline.clone())
        markers.colors.push(e.visual.color)
        continue
      }
      // Hidden tokens (DM only) are drawn darker; dimming for vision previews is the material's job.
      const color = e.hidden && view.mode !== "player" ? scaleRgb(e.visual.color, 0.5) : e.visual.color
      let lvl = perLevel.get(e.visual.levelId)
      if (!lvl) perLevel.set(e.visual.levelId, (lvl = { base: { matrices: [], colors: [], fades: [] }, body: { matrices: [], colors: [], fades: [] }, ids: [] }))
      lvl.base.matrices.push(tr.base.clone())
      lvl.base.colors.push(color)
      lvl.base.fades!.push(f)
      lvl.body.matrices.push(tr.body.clone())
      lvl.body.colors.push(color)
      lvl.body.fades!.push(f)
      lvl.ids.push(id)
      const ringState = selected.has(id) ? SELECT : overlays.hoveredId === id ? HOVER : Object.hasOwn(overlays.pendingMoves, id) ? PENDING : null
      if (ringState) {
        const k = ringState === SELECT ? 1.18 : 1.12
        rings.matrices.push(tr.outline.clone().multiply(new THREE.Matrix4().makeScale(k, 1, k)))
        rings.colors.push(ringState)
      }
    }
    const empty: InstanceData = { matrices: [], colors: [], fades: [] }
    for (const levelId of new Set([...this.levels.keys(), ...perLevel.keys()])) {
      const data = perLevel.get(levelId)
      const lt = this.levelTokens(levelId)
      lt.base.set(data?.base ?? empty, data?.ids ?? [])
      lt.ring.set(data?.base ?? empty, data?.ids ?? [])
      lt.body.set(data?.body ?? empty, data?.ids ?? [])
    }
    this.markers.set(markers)
    this.rings.set(rings)
    this.updateGhosts(inputs)
    return animating
  }

  private updateGhosts(inputs: TokenLayerInputs): void {
    const scene = inputs.scene
    const base: InstanceData = { matrices: [], colors: [] }
    const body: InstanceData = { matrices: [], colors: [] }
    if (scene) {
      for (const [id, g] of Object.entries(inputs.overlays.dragGhosts)) {
        if (!Object.hasOwn(scene.tokens, id) || !Object.hasOwn(scene.levels, g.levelId)) continue
        const t = scene.tokens[id]
        const v = tokenVisual(scene, { ...t, levelId: g.levelId, position: g.position })
        const tr = tokenTransforms(v)
        base.matrices.push(tr.base.clone())
        body.matrices.push(tr.body.clone())
        base.colors.push(v.color)
        body.colors.push(v.color)
      }
    }
    this.ghostBase.set(base)
    this.ghostBody.set(body)
  }

  dispose(): void {
    for (const lt of this.levels.values()) lt.dispose()
    this.levels.clear()
    for (const g of [this.markers, this.rings, this.ghostBase, this.ghostBody]) g.dispose()
    for (const m of this.decorMaterials) m.dispose()
    this.root.removeFromParent()
    this.decor.removeFromParent()
  }
}
