/**
 * Token layer: instanced token bodies drawn with the lighting system's token material, one set of
 * InstancedMeshes per level (the material reads `userData.levelId` for the level's host-mask layer
 * and `userData.tokenIds` for per-instance dimming): a dark bevelled base, a ring and a body in the
 * token colour, a portrait disc on top when `imageUrl` loaded (engine/portraits.ts), and a soft blob
 * shadow on the ground. Unlit decorations (OVERLAY layer): faded outline markers for tokens on levels
 * above the cutaway, soft pulsing selection / hover / pending rings and drag ghosts.
 *
 * Appear/disappear: 150 ms fade through the token material's per-instance `aFade` attribute (with
 * a slight scale-in). Instance data is recomputed only when inputs change or a fade is running.
 */
import * as THREE from "three"

import { groundIndex } from "@/core/scene/queries"
import type { Id, SceneLike, Token } from "@/core/scene/types"

import { hexToLinear, scaleRgb, type RGB } from "../builders/color"
import {
  tokenBaseGeometry,
  tokenBodyGeometry,
  tokenCapGeometry,
  tokenQuadGeometry,
  tokenRingGeometry,
  tokenTransforms,
  tokenVisual,
  type TokenVisual,
} from "../builders/tokens"
import type { OverlayState, ViewState } from "../contracts"
import { LAYER } from "../internal"
import type { LevelPlanEntry } from "./levelPlan"
import { PortraitAtlas } from "./portraits"

export const TOKEN_FADE_MS = 150

interface Entry {
  visual: TokenVisual
  /** performance.now() when it appeared (null = present from the start). */
  appearAt: number | null
  /** When it left the scene (kept for the fade-out). */
  leaveAt: number | null
  hidden: boolean
  imageUrl: string | null
}

const SELECT: RGB = hexToLinear("#34d399")
const HOVER: RGB = hexToLinear("#d4d4d8")
const PENDING: RGB = hexToLinear("#38bdf8")

interface InstanceData {
  matrices: THREE.Matrix4[]
  colors: RGB[]
  fades?: number[]
  /** Per instance portrait slot (u, v, scale, 1) for meshes with an `aPortrait` attribute. */
  portraits?: [number, number, number, number][]
}

/** Soft ground blob under each token: black, radial falloff, faded with the token. */
const SHADOW_VERTEX = /* glsl */ `
attribute float aFade;
varying vec2 vUv;
varying float vFade;
void main() {
  vUv = uv;
  vFade = aFade;
  vec4 p = vec4(position, 1.0);
#ifdef USE_INSTANCING
  p = instanceMatrix * p;
#endif
  gl_Position = projectionMatrix * modelViewMatrix * p;
}
`
const SHADOW_FRAGMENT = /* glsl */ `
uniform float uStrength;
varying vec2 vUv;
varying float vFade;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float a = 1.0 - smoothstep(0.25, 1.0, r);
  gl_FragColor = vec4(0.0, 0.0, 0.0, a * a * uStrength * vFade);
}
`

/** Soft ring decoration (selection / hover / pending): a glowing annulus that breathes slowly. */
const RING_VERTEX = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vUv = uv;
  vColor = vec3(1.0);
#ifdef USE_INSTANCING_COLOR
  vColor = instanceColor;
#endif
  vec4 p = vec4(position, 1.0);
#ifdef USE_INSTANCING
  p = instanceMatrix * p;
#endif
  gl_Position = projectionMatrix * modelViewMatrix * p;
}
`
const RING_FRAGMENT = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float w = fwidth(r);
  // Crisp ring at r ≈ 0.86..0.92 plus a soft outer glow.
  float ring = smoothstep(0.84 - w, 0.84 + w, r) * (1.0 - smoothstep(0.92 - w, 0.92 + w, r));
  float glow = exp(-pow(max(r - 0.88, 0.0) * 14.0, 2.0)) * (1.0 - step(0.999, r)) * step(0.84, r);
  float pulse = 0.8 + 0.2 * sin(uTime * 3.2);
  float a = max(ring * 0.95, glow * 0.45 * pulse);
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
}
`

/**
 * Faded outline marker of a token on a level above (annulus r 0.84..0.98 of the unit quad), with the
 * same analytic fwidth edge as the rings: the canvas has no MSAA (engine.ts), and overlays draw onto it.
 */
const MARKER_FRAGMENT = /* glsl */ `
uniform float uOpacity;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  float r = length(vUv - 0.5) * 2.0;
  float w = fwidth(r);
  float a = smoothstep(0.84 - w, 0.84 + w, r) * (1.0 - smoothstep(0.98 - w, 0.98 + w, r));
  if (a < 0.004) discard;
  gl_FragColor = vec4(vColor, a * uOpacity);
  #include <colorspace_fragment>
}
`

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

  private readonly portraits: boolean

  constructor(
    parent: THREE.Object3D,
    unit: THREE.BufferGeometry,
    material: THREE.Material,
    ownGeometry: boolean,
    configure: (m: THREE.InstancedMesh) => void,
    portraits = false
  ) {
    this.parent = parent
    this.unit = unit
    this.material = material
    this.ownGeometry = ownGeometry
    this.configure = configure
    this.portraits = portraits
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
      if (this.portraits) {
        const portrait = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
        portrait.setUsage(THREE.DynamicDrawUsage)
        geometry.setAttribute("aPortrait", portrait)
      }
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
    const portrait = m.geometry.getAttribute("aPortrait") as THREE.InstancedBufferAttribute | undefined
    for (let k = 0; k < n; k++) {
      m.setMatrixAt(k, data.matrices[k])
      const c = data.colors[k]
      m.instanceColor!.setXYZ(k, c[0], c[1], c[2])
      if (fade) fade.setX(k, data.fades?.[k] ?? 1)
      if (portrait) {
        const q = data.portraits?.[k] ?? [0, 0, 0, 0]
        portrait.setXYZW(k, q[0], q[1], q[2], q[3])
      }
    }
    m.count = n
    m.instanceMatrix.needsUpdate = true
    m.instanceColor!.needsUpdate = true
    if (fade) fade.needsUpdate = true
    if (portrait) portrait.needsUpdate = true
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
  /** Portrait discs (only tokens whose image loaded). */
  readonly cap: GrowingInstances
  readonly shadow: GrowingInstances

  constructor(levelId: Id, material: THREE.Material, shadowMaterial: THREE.Material) {
    this.root.name = `tokens:${levelId}`
    const configure = (m: THREE.InstancedMesh) => {
      m.userData.levelId = levelId
      m.userData.slot = "token"
    }
    this.shadow = new GrowingInstances(this.root, tokenQuadGeometry(), shadowMaterial, true, (m) => {
      m.userData.levelId = levelId
      m.userData.slot = "token-shadow"
      // Sorts before the token meshes while they fade (both transparent); at rest the tokens are
      // opaque and their depth hides the blob under them, which looks the same.
      m.renderOrder = -1
      m.raycast = () => {}
    })
    this.base = new GrowingInstances(this.root, tokenBaseGeometry(), material, true, configure)
    this.ring = new GrowingInstances(this.root, tokenRingGeometry(), material, true, configure)
    this.body = new GrowingInstances(this.root, tokenBodyGeometry(), material, true, configure)
    this.cap = new GrowingInstances(this.root, tokenCapGeometry(), material, true, (m) => {
      configure(m)
      m.raycast = () => {}
    }, true)
  }

  dispose(): void {
    this.shadow.dispose()
    this.base.dispose()
    this.ring.dispose()
    this.body.dispose()
    this.cap.dispose()
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
  private readonly shadowMaterial: THREE.ShaderMaterial
  private readonly ringMaterial: THREE.ShaderMaterial
  private readonly entries = new Map<Id, Entry>()
  private readonly portraits = new PortraitAtlas()
  private dirty = true
  private wasAnimating = false
  private initialised = false

  /**
   * `tokenMaterial`: the lighting system's instanced token material. Tokens are opaque at rest, so
   * they sort into the opaque pass: `root` is a Group with renderOrder 0 and level groups use
   * renderOrder = rank ≥ 1 (levelPlan.ts), so resting tokens draw before all level geometry. The
   * material is transparent only while an appear / leave fade runs (`update`). The cost was draw
   * order, not blending: tokens drawn after the Vineyard floor cost ~1.7 ms (medium) and ~2.9 ms
   * (high) of GPU time on the AMD iGPU. Toggling `transparent` needs no recompile (three reads it
   * per frame for list placement and blending; the token shader never reads the OPAQUE define).
   */
  constructor(tokenMaterial: THREE.Material) {
    this.material = tokenMaterial
    tokenMaterial.transparent = false
    this.portraits.onChange = () => {
      // Bind the atlas once it exists (tokens without images keep sampling the 1×1 placeholder).
      const tu = (tokenMaterial as THREE.ShaderMaterial).uniforms
      if (tu?.uPortraits && this.portraits.texture) tu.uPortraits.value = this.portraits.texture
      this.invalidate()
    }
    this.root.name = "tokens"
    this.root.renderOrder = 0
    this.decor.name = "token-decor"
    this.shadowMaterial = new THREE.ShaderMaterial({
      name: "atlas-token-shadow",
      vertexShader: SHADOW_VERTEX,
      fragmentShader: SHADOW_FRAGMENT,
      uniforms: { uStrength: { value: 0.5 } },
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    })
    this.ringMaterial = new THREE.ShaderMaterial({
      name: "atlas-token-ring",
      vertexShader: RING_VERTEX,
      fragmentShader: RING_FRAGMENT,
      uniforms: { uTime: { value: 0 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    })
    const markerMat = new THREE.ShaderMaterial({
      name: "atlas-token-marker",
      vertexShader: RING_VERTEX,
      fragmentShader: MARKER_FRAGMENT,
      uniforms: { uOpacity: { value: 0.45 } },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide,
    })
    const ghostMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, depthWrite: false, toneMapped: false, vertexColors: true })
    this.decorMaterials = [markerMat, ghostMat, this.shadowMaterial, this.ringMaterial]
    const decor = (order: number) => (m: THREE.InstancedMesh) => {
      m.renderOrder = order
      m.raycast = () => {}
      m.layers.set(LAYER.OVERLAY)
    }
    this.markers = new GrowingInstances(this.decor, tokenQuadGeometry(), markerMat, false, decor(8))
    this.rings = new GrowingInstances(this.decor, tokenQuadGeometry(), this.ringMaterial, false, decor(9))
    this.ghostBase = new GrowingInstances(this.decor, tokenBaseGeometry(), ghostMat, false, decor(10))
    this.ghostBody = new GrowingInstances(this.decor, tokenBodyGeometry(), ghostMat, false, decor(10))
  }

  /** Per frame: ring animation clock. */
  tick(timeSec: number): void {
    this.ringMaterial.uniforms.uTime.value = timeSec % 1000
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
      // Committed scenes only (never mutated in place), so the memoised GroundIndex is valid.
      const ground = groundIndex(scene)
      for (const t of Object.values(scene.tokens) as Token[]) {
        if (!Object.hasOwn(scene.levels, t.levelId)) continue
        present.add(t.id)
        const visual = tokenVisual(scene, t, ground)
        const e = this.entries.get(t.id)
        if (e && e.leaveAt === null) {
          e.visual = visual
          e.hidden = t.hidden
          e.imageUrl = t.imageUrl ?? null
        } else {
          this.entries.set(t.id, { visual, appearAt: animate && this.initialised ? now : null, leaveAt: null, hidden: t.hidden, imageUrl: t.imageUrl ?? null })
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
      lt = new LevelTokens(levelId, this.material, this.shadowMaterial)
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
    // Blend only while a fade runs (alpha < 1 through aFade); opaque at rest (constructor comment).
    this.material.transparent = animating
    if (!this.dirty && !animating && !settle) return false
    this.dirty = false
    const { plan, view, overlays } = inputs
    const selected = new Set(overlays.selectedIds)
    const perLevel = new Map<Id, { base: InstanceData; body: InstanceData; ids: Id[]; cap: InstanceData; capIds: Id[]; shadow: InstanceData }>()
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
      if (!lvl) {
        lvl = {
          base: { matrices: [], colors: [], fades: [] },
          body: { matrices: [], colors: [], fades: [] },
          ids: [],
          cap: { matrices: [], colors: [], fades: [], portraits: [] },
          capIds: [],
          shadow: { matrices: [], colors: [], fades: [] },
        }
        perLevel.set(e.visual.levelId, lvl)
      }
      lvl.base.matrices.push(tr.base.clone())
      lvl.base.colors.push(color)
      lvl.base.fades!.push(f)
      lvl.body.matrices.push(tr.body.clone())
      lvl.body.colors.push(color)
      lvl.body.fades!.push(f)
      lvl.ids.push(id)
      lvl.shadow.matrices.push(tr.shadow.clone())
      lvl.shadow.colors.push(color)
      lvl.shadow.fades!.push(f)
      const slot = this.portraits.lookup(e.imageUrl)
      if (slot) {
        lvl.cap.matrices.push(tr.cap.clone())
        // The portrait replaces the colour; hidden tokens stay darker for the DM.
        lvl.cap.colors.push(e.hidden && view.mode !== "player" ? [0.5, 0.5, 0.5] : [1, 1, 1])
        lvl.cap.fades!.push(f)
        lvl.cap.portraits!.push([slot.u, slot.v, slot.scale, 1])
        lvl.capIds.push(id)
      }
      const ringState = selected.has(id) ? SELECT : overlays.hoveredId === id ? HOVER : Object.hasOwn(overlays.pendingMoves, id) ? PENDING : null
      if (ringState) {
        const k = ringState === SELECT ? 1.32 : 1.24
        rings.matrices.push(tr.outline.clone().multiply(new THREE.Matrix4().makeScale(k, 1, k)))
        rings.colors.push(ringState)
      }
    }
    const empty: InstanceData = { matrices: [], colors: [], fades: [] }
    for (const levelId of new Set([...this.levels.keys(), ...perLevel.keys()])) {
      const data = perLevel.get(levelId)
      const lt = this.levelTokens(levelId)
      lt.shadow.set(data?.shadow ?? empty)
      lt.base.set(data?.base ?? empty, data?.ids ?? [])
      lt.ring.set(data?.base ?? empty, data?.ids ?? [])
      lt.body.set(data?.body ?? empty, data?.ids ?? [])
      lt.cap.set(data?.cap ?? empty, data?.capIds ?? [])
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
      const ground = groundIndex(scene)
      for (const [id, g] of Object.entries(inputs.overlays.dragGhosts)) {
        if (!Object.hasOwn(scene.tokens, id) || !Object.hasOwn(scene.levels, g.levelId)) continue
        const t = scene.tokens[id]
        const v = tokenVisual(scene, { ...t, levelId: g.levelId, position: g.position }, ground)
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
    this.portraits.dispose()
    this.root.removeFromParent()
    this.decor.removeFromParent()
  }
}
