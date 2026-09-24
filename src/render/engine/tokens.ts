/**
 * Token layer: instanced token bodies drawn with the lighting system's token material, one set of
 * InstancedMeshes per level (the material reads `userData.levelId` for the level's host-mask layer
 * and `userData.tokenIds` for per-instance dimming): a dark bevelled base, a ring and a body in the
 * token colour, a portrait disc on top when `imageUrl` loaded (engine/portraits.ts), and a soft blob
 * shadow on the ground. A token with a loaded 3D model (Token.model, engine/tokenModels.ts) draws the
 * figure on its base instead of the body and portrait, at the level of detail its on-screen size calls
 * for (one InstancedMesh per level and LOD geometry, re-bucketed when the zoom changes a token's LOD),
 * and picks through an invisible body-shaped proxy (raycasting the sculpt would be slow).
 * Unlit decorations (OVERLAY layer): faded outline markers for tokens on levels above the cutaway, soft
 * pulsing selection / hover / pending rings and drag ghosts.
 *
 * Appear/disappear: 150 ms fade through the token material's per-instance `aFade` attribute (with
 * a slight scale-in). Moves: a token whose position changes walks there (engine/tokenMotion.ts) along
 * the route the router gives (setRouter), following the ground. Instance data is recomputed only when
 * inputs change or a fade or walk is running.
 */
import * as THREE from "three"

import { groundIndex } from "@/core/scene/queries"
import type { Id, SceneLike, Token } from "@/core/scene/types"

import { hexToLinear, mixRgb, scaleRgb, type RGB } from "../builders/color"
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
import { TOKEN_BASE_HEIGHT } from "../builders/tokens"
import type { OverlayState, TokenModelSource, TokenRouter, ViewState } from "../contracts"
import { LAYER } from "../internal"
import type { LevelPlanEntry } from "./levelPlan"
import { PortraitAtlas } from "./portraits"
import { chooseLod, TokenModelLibrary } from "./tokenModels"
import { motionAt, planMotion, type TokenMotion } from "./tokenMotion"

export const TOKEN_FADE_MS = 150

interface Entry {
  /** Where the token is drawn (its scene position, or a point along its walk). */
  visual: TokenVisual
  /** Where the scene puts it. */
  target: TokenVisual
  motion: TokenMotion | null
  /** performance.now() when it appeared (null = present from the start). */
  appearAt: number | null
  /** When it left the scene (kept for the fade-out). */
  leaveAt: number | null
  hidden: boolean
  imageUrl: string | null
  model: string | null
  /** LOD drawn for the model (undefined until drawn with one). */
  lod?: number
}

/** Unpainted-miniature resin, with a hint of the token colour. */
const RESIN: RGB = hexToLinear("#bdb5a8")
const RESIN_TINT = 0.14
/** A model's footprint unit spans the base disc (tokenTransforms: side × 0.9). */
const MODEL_SCALE = 0.9

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
  private readonly shareAttributes: boolean

  /**
   * `shareAttributes` (with `ownGeometry`): the private geometry reuses the unit's index and vertex
   * attributes instead of copying them (large model geometries are uploaded once, not per mesh).
   */
  constructor(
    parent: THREE.Object3D,
    unit: THREE.BufferGeometry,
    material: THREE.Material,
    ownGeometry: boolean,
    configure: (m: THREE.InstancedMesh) => void,
    portraits = false,
    shareAttributes = false
  ) {
    this.parent = parent
    this.unit = unit
    this.material = material
    this.ownGeometry = ownGeometry
    this.configure = configure
    this.portraits = portraits
    this.shareAttributes = shareAttributes
    this.mesh = this.create(16)
  }

  private create(capacity: number): THREE.InstancedMesh {
    let geometry = this.unit
    if (this.ownGeometry) {
      geometry = this.shareAttributes ? shallowCopy(this.unit) : this.unit.clone()
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

function shallowCopy(unit: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setIndex(unit.index)
  for (const [name, attr] of Object.entries(unit.attributes)) g.setAttribute(name, attr)
  g.boundingSphere = unit.boundingSphere
  g.name = unit.name
  return g
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
  /** Model figures, one mesh per LOD geometry (created on first use). */
  readonly models = new Map<THREE.BufferGeometry, GrowingInstances>()
  /** Invisible bodies of model tokens: what picking raycasts for them. */
  readonly proxy: GrowingInstances
  private readonly levelId: Id
  private readonly modelMaterial: THREE.Material

  constructor(levelId: Id, material: THREE.Material, shadowMaterial: THREE.Material, modelMaterial: THREE.Material) {
    this.levelId = levelId
    this.modelMaterial = modelMaterial
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
    this.proxy = new GrowingInstances(this.root, tokenBodyGeometry(), material, false, (m) => {
      m.userData.levelId = levelId
      m.userData.slot = "token-pick"
      m.visible = false
    })
  }

  model(geometry: THREE.BufferGeometry): GrowingInstances {
    let g = this.models.get(geometry)
    if (!g) {
      const levelId = this.levelId
      g = new GrowingInstances(
        this.root,
        geometry,
        this.modelMaterial,
        true,
        (m) => {
          m.userData.levelId = levelId
          m.userData.slot = "token-model"
          m.raycast = () => {}
        },
        false,
        true
      )
      this.models.set(geometry, g)
    }
    return g
  }

  dispose(): void {
    this.shadow.dispose()
    this.base.dispose()
    this.ring.dispose()
    this.body.dispose()
    this.cap.dispose()
    this.proxy.dispose()
    for (const g of this.models.values()) g.dispose()
    this.models.clear()
    this.root.removeFromParent()
  }
}

export interface TokenLayerInputs {
  scene: SceneLike | null
  plan: ReadonlyMap<Id, LevelPlanEntry>
  view: ViewState
  overlays: OverlayState
  /** Physical pixels per foot at a world point (model LODs); absent = draw the most detailed LOD. */
  pixelsPerFootAt?: (x: number, y: number, z: number) => number
  /** Pixels per model triangle the LOD choice aims for (default 3; lower = more detail). */
  modelPxPerTriangle?: number
}

export class TokenLayer {
  /** Solid tokens (lit). */
  readonly root = new THREE.Group()
  /** Unlit decorations; the engine adds this under the overlay root. */
  readonly decor = new THREE.Object3D()
  private readonly material: THREE.Material
  private readonly modelMaterial: THREE.Material
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
  private readonly models: TokenModelLibrary
  private dirty = true
  private wasAnimating = false
  private initialised = false
  private router: TokenRouter | null = null

  /**
   * `tokenMaterial`: the lighting system's instanced token material. Tokens are opaque at rest, so
   * they sort into the opaque pass: `root` is a Group with renderOrder 0 and level groups use
   * renderOrder = rank ≥ 1 (levelPlan.ts), so resting tokens draw before all level geometry. The
   * material is transparent only while an appear / leave fade runs (`update`). The cost was draw
   * order, not blending: tokens drawn after the Vineyard floor cost ~1.7 ms (medium) and ~2.9 ms
   * (high) of GPU time on the AMD iGPU. Toggling `transparent` needs no recompile (three reads it
   * per frame for list placement and blending; the token shader never reads the OPAQUE define).
   */
  /**
   * `models`: where token models come from (a TokenModelLibrary in tests); `modelMaterial`: the
   * material of model figures (default: `tokenMaterial`).
   */
  constructor(tokenMaterial: THREE.Material, models: TokenModelSource | TokenModelLibrary | null = null, modelMaterial: THREE.Material = tokenMaterial) {
    this.material = tokenMaterial
    this.modelMaterial = modelMaterial
    tokenMaterial.transparent = false
    modelMaterial.transparent = false
    this.models = models instanceof TokenModelLibrary ? models : new TokenModelLibrary(models)
    this.models.onChange = () => this.invalidate()
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

  /** Routes moved tokens walk along (null: straight glides over short distances, else jumps). */
  setRouter(router: TokenRouter | null): void {
    this.router = router
  }

  /** A token is walking to its position. */
  moving(tokenId: Id): boolean {
    return this.entries.get(tokenId)?.motion != null
  }

  /** Where a token is drawn (mid-walk while it moves), or null. */
  drawnAt(tokenId: Id): { levelId: Id; position: { x: number; y: number; z: number } } | null {
    const v = this.entries.get(tokenId)?.visual
    return v ? { levelId: v.levelId, position: { x: v.x, y: v.y, z: v.z } } : null
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
    for (const lt of this.levels.values()) out.push(lt.body.mesh, lt.proxy.mesh, lt.base.mesh)
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
        // Load every model the scene uses up front, so switching levels does not pop bodies into figures.
        if (t.model) this.models.get(t.model)
        const visual = tokenVisual(scene, t, ground)
        const e = this.entries.get(t.id)
        if (e && e.leaveAt === null) {
          const moved = e.target.levelId !== visual.levelId || e.target.x !== visual.x || e.target.z !== visual.z
          if (moved) {
            // Walk from where it is drawn now (possibly mid-walk).
            const from = { levelId: e.visual.levelId, position: { x: e.visual.x, z: e.visual.z } }
            const to = { levelId: visual.levelId, position: { x: visual.x, z: visual.z } }
            let route = null
            try {
              route = animate && this.router ? this.router(t.id, from, to) : null
            } catch (err) {
              console.error("[atlas] token router failed", err)
            }
            e.motion = animate ? planMotion(from, to, route, now) : null
          }
          e.target = visual
          e.visual = e.motion ? { ...visual, levelId: e.visual.levelId, x: e.visual.x, y: e.visual.y, z: e.visual.z } : visual
          e.hidden = t.hidden
          e.imageUrl = t.imageUrl ?? null
          if (e.model !== (t.model ?? null)) e.lod = undefined
          e.model = t.model ?? null
        } else {
          this.entries.set(t.id, {
            visual,
            target: visual,
            motion: null,
            appearAt: animate && this.initialised ? now : null,
            leaveAt: null,
            hidden: t.hidden,
            imageUrl: t.imageUrl ?? null,
            model: t.model ?? null,
          })
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
      lt = new LevelTokens(levelId, this.material, this.shadowMaterial, this.modelMaterial)
      this.levels.set(levelId, lt)
      this.root.add(lt.root)
    }
    return lt
  }

  /** Recompute instances when needed. Returns true while a fade is running. */
  update(inputs: TokenLayerInputs, now: number): boolean {
    let animating = false
    let walking = false
    const ground = inputs.scene ? groundIndex(inputs.scene) : null
    for (const [id, e] of this.entries) {
      if (e.leaveAt !== null && now - e.leaveAt >= TOKEN_FADE_MS) {
        this.entries.delete(id)
        this.dirty = true
        continue
      } else if ((e.appearAt !== null && now - e.appearAt < TOKEN_FADE_MS) || e.leaveAt !== null) animating = true
      if (e.motion) {
        const p = motionAt(e.motion, now)
        if (p.done || !ground || !inputs.scene || !Object.hasOwn(inputs.scene.levels, p.levelId)) {
          e.motion = null
          e.visual = e.target
        } else {
          e.visual = { ...e.target, levelId: p.levelId, x: p.x, z: p.z, y: ground.groundHeightAt(p.levelId, { x: p.x, z: p.z }) }
          walking = true
        }
        this.dirty = true
      }
    }
    // One more pass after a fade ends so the final (fully opaque) state is written.
    const settle = this.wasAnimating && !animating
    this.wasAnimating = animating
    // Blend only while a fade runs (alpha < 1 through aFade); opaque at rest (constructor comment).
    this.material.transparent = animating
    this.modelMaterial.transparent = animating
    // Model LODs follow the zoom: re-bucket when one would change.
    if (!this.dirty && !animating && !settle && !this.lodChanged(inputs)) return false
    this.dirty = false
    const { plan, view, overlays } = inputs
    const selected = new Set(overlays.selectedIds)
    const perLevel = new Map<
      Id,
      {
        base: InstanceData
        ids: Id[]
        body: InstanceData
        bodyIds: Id[]
        cap: InstanceData
        capIds: Id[]
        shadow: InstanceData
        proxy: InstanceData
        proxyIds: Id[]
        models: Map<THREE.BufferGeometry, { data: InstanceData; ids: Id[] }>
      }
    >()
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
          ids: [],
          body: { matrices: [], colors: [], fades: [] },
          bodyIds: [],
          cap: { matrices: [], colors: [], fades: [], portraits: [] },
          capIds: [],
          shadow: { matrices: [], colors: [], fades: [] },
          proxy: { matrices: [], colors: [] },
          proxyIds: [],
          models: new Map(),
        }
        perLevel.set(e.visual.levelId, lvl)
      }
      lvl.base.matrices.push(tr.base.clone())
      lvl.base.colors.push(color)
      lvl.base.fades!.push(f)
      lvl.ids.push(id)
      lvl.shadow.matrices.push(tr.shadow.clone())
      lvl.shadow.colors.push(color)
      lvl.shadow.fades!.push(f)
      const model = this.models.get(e.model ?? undefined)
      if (model) {
        // The figure stands on the base; the proxy is a body as tall as the figure.
        const lod = this.lodFor(e, model.triangles, inputs)
        e.lod = lod
        const scale = e.visual.side * MODEL_SCALE * (0.85 + 0.15 * f)
        const baseTop = e.visual.y + TOKEN_BASE_HEIGHT * (0.85 + 0.15 * f)
        const geometry = model.lods[lod]
        let bucket = lvl.models.get(geometry)
        if (!bucket) lvl.models.set(geometry, (bucket = { data: { matrices: [], colors: [], fades: [] }, ids: [] }))
        bucket.data.matrices.push(new THREE.Matrix4().makeScale(scale, scale, scale).setPosition(e.visual.x, baseTop, e.visual.z))
        const resin = mixRgb(RESIN, e.visual.color, RESIN_TINT)
        bucket.data.colors.push(e.hidden && view.mode !== "player" ? scaleRgb(resin, 0.5) : resin)
        bucket.data.fades!.push(f)
        bucket.ids.push(id)
        const bd = e.visual.side * 0.45
        lvl.proxy.matrices.push(new THREE.Matrix4().makeScale(bd, Math.max(0.1, model.height * scale), bd).setPosition(e.visual.x, baseTop, e.visual.z))
        lvl.proxy.colors.push(color)
        lvl.proxyIds.push(id)
      } else {
        lvl.body.matrices.push(tr.body.clone())
        lvl.body.colors.push(color)
        lvl.body.fades!.push(f)
        lvl.bodyIds.push(id)
      }
      const slot = model ? null : this.portraits.lookup(e.imageUrl)
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
      lt.body.set(data?.body ?? empty, data?.bodyIds ?? [])
      lt.cap.set(data?.cap ?? empty, data?.capIds ?? [])
      lt.proxy.set(data?.proxy ?? empty, data?.proxyIds ?? [])
      for (const geometry of new Set([...lt.models.keys(), ...(data?.models.keys() ?? [])])) {
        const bucket = data?.models.get(geometry)
        lt.model(geometry).set(bucket?.data ?? empty, bucket?.ids ?? [])
      }
    }
    this.markers.set(markers)
    this.rings.set(rings)
    this.updateGhosts(inputs)
    return animating || walking
  }

  /** The LOD a model token should draw now (hysteresis around its current one). */
  private lodFor(e: Entry, triangles: readonly number[], inputs: TokenLayerInputs): number {
    const ppf = inputs.pixelsPerFootAt?.(e.visual.x, e.visual.y, e.visual.z)
    if (ppf === undefined || !Number.isFinite(ppf)) return 0
    return chooseLod(triangles, e.visual.side * ppf, e.lod, inputs.modelPxPerTriangle)
  }

  /** Whether any drawn model token would switch LOD at the current zoom. */
  private lodChanged(inputs: TokenLayerInputs): boolean {
    if (!inputs.pixelsPerFootAt) return false
    for (const e of this.entries.values()) {
      if (e.lod === undefined || e.model === null) continue
      const model = this.models.get(e.model)
      if (model && this.lodFor(e, model.triangles, inputs) !== e.lod) return true
    }
    return false
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
    this.models.dispose()
    this.root.removeFromParent()
    this.decor.removeFromParent()
  }
}
