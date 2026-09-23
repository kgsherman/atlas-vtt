/**
 * LightingSystem implementation (render/internal.ts; ARCHITECTURE §4.1, §4.2, §4.4; PERFORMANCE.md).
 *
 * Owns everything that makes the world shader's global state:
 *  - occluder proxy scene (render/occluders) built from OcclusionWorld.primitives, diffed incrementally;
 *  - light atlas (point-light shadows) and viewer atlas (GPU line of sight) with LRU tiles, scheduled
 *    under a per-frame budget (4 tiles / ~2 ms CPU, moved sources first);
 *  - static sun/moon shadow map and sky-exposure map, re-rendered only when occluders or the sun change;
 *  - light manager: resolve, cull (off/hidden, frustum ∩ dim sphere, cutaway), rank → 32 uniform slots,
 *    flicker on intensity only; shadowed lights without a captured tile are dropped (never unshadowed);
 *    a per-cell mask of the slots whose dim disc reaches each 10 ft cell lets the shaders skip the rest;
 *  - host-mask textures (render/fog) and the shared uniforms of world / token materials;
 *  - per-level backdrop uniforms (battlemap images) and the quality tier define of every material.
 *
 * Ultra tier: the 16 highest-ranked shadowed lights get 1024² tiles in a second (hi-res) atlas, and every
 * light soft (PCSS-style) shadows. A light switching between the two atlases keeps drawing from whichever
 * tile is captured until its new tile is ready (never unshadowed, never dropped for a frame).
 *
 * Tier changes: an adaptive step first prepares the new tier (prepareQuality): atlases whose layout
 * changes are allocated unbound and filled in later frames under their own tile budget, including lo
 * tiles for lights leaving the hi-res atlas; qualityReady says when every ranked shadowed light (and
 * viewer) has a capture where it will draw from, and setQuality then swaps them in, so no light drops
 * out on the switch. An unprepared setQuality (the user's choice) re-allocates at once and recaptures
 * every visible tile in its first frame (TIER_SWITCH_CAPTURE_MS) instead of 4 per frame.
 */
import * as THREE from "three"

import type { BlockChannel, DirtyRegion, OcclusionWorld } from "@/core/occlusion/types"
import { levelCeilingY, nominalTokenEye, sortedLevels, tokenRect } from "@/core/scene/queries"
import type { Id, Rect, SceneLike, Token, Vec3, VisionSettings } from "@/core/scene/types"
import { resolveViewerEye } from "@/core/vision"
import type { Quality, SceneChange, ViewState } from "../contracts"
import { HostMaskTextures } from "../fog/hostMaskTextures"
import { LAYER, type CreateLightingSystem, type LightingFrameStats, type LightingSystem, type WorldMaterialOptions } from "../internal"
import { createBackdropUniforms, setBackdropUniforms, type BackdropUniforms } from "../materials/backdrop"
import { createOccluderDepthMaterial, createOccluderDistanceMaterial, createReencodeMaterial } from "../materials/occluderMaterials"
import { createOverlayMaterial } from "../materials/overlayMaterial"
import { lightMaskTexture, placeholderFloatTexture, placeholderLightMaskTexture } from "../materials/placeholders"
import { precompileScene, TIER_DEFINE, TierRegistry } from "../materials/util"
import { createTokenMaterial } from "../materials/tokenMaterial"
import { createWorldMaterial } from "../materials/worldMaterial"
import { OccluderProxies } from "../occluders/proxies"
import { DirectionalShadowMap } from "../shadows/directionalShadow"
import { DistanceAtlas, type DistanceAtlasOptions } from "../shadows/distanceAtlas"
import { flickerFactor } from "./flicker"
import { directionToSun, levelFill } from "./lightModel"
import { buildLightMask, packedLightSlots, updateLightMaskKey } from "./lightMask"
import { cullAndRankLights, cutawayPlaneY, linearColor, resolveLights, type RankedLight, type ResolvedLight } from "./lights"
import { orderTileUpdates, runTileUpdates, SHADOW_UPDATE_MS, SHADOW_UPDATES_PER_FRAME, type TileUpdateRequest } from "./scheduler"
import {
  createSharedUniforms,
  ENV_FLAG_SKY_MAP,
  ENV_FLAG_SUN_MAP,
  LIGHT_LEVEL_NUMBER,
  LIGHT_VEC4S,
  MAX_LIGHTS,
  MAX_VIEWERS,
  packLight,
  packViewer,
  VISION_MODE,
  type SharedUniforms,
} from "./uniforms"

export interface QualityConfig {
  lightAtlas: Omit<DistanceAtlasOptions, "name">
  /** null = no GPU line-of-sight refinement on this tier. */
  viewerAtlas: Omit<DistanceAtlasOptions, "name"> | null
  /**
   * Strongest shadowed lights that get the 3×3 (2-texel box) PCF instead of 2×2 bilinear. At grazing
   * angles a 1-texel filter leaves long radial "comb" teeth along shadow edges; the wider box softens
   * them. Cost on the AMD iGPU at 1080p, medium: 0.5–0.7 ms for 8 lights on the Crooked Lantern DM view
   * (4 lights would save ~0.3 ms, at a visible cost on the next 4). High uses it for every light.
   */
  widePcfLights: number
  /** Hi-res atlas for the `hiLights` highest-ranked shadowed lights (ultra), null = none. */
  hiAtlas: Omit<DistanceAtlasOptions, "name"> | null
  hiLights: number
  /** PCSS-style soft shadows (blocker search → penumbra-sized PCF). */
  softShadows: boolean
}

export const QUALITY_CONFIG: Record<Quality, QualityConfig> = {
  low: {
    lightAtlas: { width: 2048, height: 1024, tileSize: 256, cubeSize: 256 },
    viewerAtlas: null,
    widePcfLights: 0,
    hiAtlas: null,
    hiLights: 0,
    softShadows: false,
  },
  medium: {
    lightAtlas: { width: 4096, height: 2048, tileSize: 512, cubeSize: 256 },
    viewerAtlas: { width: 4096, height: 2048, tileSize: 1024, cubeSize: 512 },
    widePcfLights: 8,
    hiAtlas: null,
    hiLights: 0,
    softShadows: false,
  },
  high: {
    lightAtlas: { width: 4096, height: 2048, tileSize: 512, cubeSize: 256 },
    viewerAtlas: { width: 4096, height: 2048, tileSize: 1024, cubeSize: 512 },
    widePcfLights: 32,
    hiAtlas: null,
    hiLights: 0,
    softShadows: false,
  },
  // 16 × 1024² tiles (cube faces 512²) for the highest-priority lights + the 512² atlas for the rest.
  ultra: {
    lightAtlas: { width: 4096, height: 2048, tileSize: 512, cubeSize: 256 },
    viewerAtlas: { width: 4096, height: 2048, tileSize: 1024, cubeSize: 512 },
    widePcfLights: 32,
    hiAtlas: { width: 4096, height: 4096, tileSize: 1024, cubeSize: 512 },
    hiLights: 16,
    softShadows: true,
  },
}

export const SUN_MAP_SIZE = 2048
export const SKY_MAP_SIZE = 1024
/**
 * Depth bias of the directional maps (feet; BackSide rendering removes most acne already). Mirrored by
 * AT_DIR_BIAS_FT in materials/glsl/common.ts.
 */
export const DIRECTIONAL_BIAS_FT = 0.05
const LIGHT_LAYER_MASK = 1 << LAYER.LIGHT
const SIGHT_LAYER_MASK = 1 << LAYER.SIGHT

/**
 * CPU budget of the one frame after a tier change reallocated the atlases (every visible shadowed light
 * and viewer is recaptured at once, up to this time, instead of 4 tiles per frame).
 */
export const TIER_SWITCH_CAPTURE_MS = 12

export const DEFAULT_VIEW_STATE: ViewState = {
  mode: "editor",
  camera: "orbit",
  activeLevelId: null,
  levelVisibility: {},
  ghostAdjacent: false,
  cutaway: false,
  showGrid: true,
  vision: "off",
  viewerTokenIds: [],
  hostMasks: {},
  gpuVisionRefine: false,
  dimmedTokenIds: [],
  primaryViewerId: null,
  tilt: 0,
  showHelpers: false,
}

export interface ResolvedViewer {
  tokenId: Id
  levelId: Id
  eye: Vec3
  vision: VisionSettings
  /** Capture range of its LOS tile (feet). */
  range: number
  /** Half-extent (ft) of the square around the eye covering the token's own footprint cells (viewerTouch). */
  touch: number
}

/**
 * Half-extent (ft, Chebyshev around `eye`) of the cells a viewer perceives by touch whatever its senses:
 * the cells its footprint overlaps with positive area (core/vision footprintCells). The world shader
 * never removes grade-1 perception inside it (its per-pixel blindsight range test).
 */
export function viewerTouch(scene: SceneLike, token: Token, eye: Vec3): number {
  const s = scene.grid.cellSize
  const r = tokenRect(scene, token)
  const x0 = Math.floor(r.x / s) * s
  const z0 = Math.floor(r.z / s) * s
  const x1 = Math.max(x0 + s, Math.ceil((r.x + r.w) / s) * s)
  const z1 = Math.max(z0 + s, Math.ceil((r.z + r.d) / s) * s)
  return Math.max(eye.x - x0, x1 - eye.x, eye.z - z0, z1 - eye.z)
}

/** Eye through core/vision (so CPU and GPU agree), with a nominal-eye fallback if it fails. */
export function viewerEye(world: OcclusionWorld, scene: SceneLike, token: Token): Vec3 {
  try {
    return resolveViewerEye(world, scene, token)
  } catch {
    const eye = nominalTokenEye(scene, token)
    return { x: eye.x, y: Math.min(eye.y, levelCeilingY(scene, token.levelId) - 0.25), z: eye.z }
  }
}

interface RendererState {
  target: THREE.WebGLRenderTarget | null
  face: number
  mip: number
  autoClear: boolean
  autoClearColor: boolean
  autoClearDepth: boolean
  autoClearStencil: boolean
  sortObjects: boolean
}

function saveRendererState(r: THREE.WebGLRenderer): RendererState {
  return {
    target: r.getRenderTarget(),
    face: r.getActiveCubeFace(),
    mip: r.getActiveMipmapLevel(),
    autoClear: r.autoClear,
    autoClearColor: r.autoClearColor,
    autoClearDepth: r.autoClearDepth,
    autoClearStencil: r.autoClearStencil,
    sortObjects: r.sortObjects,
  }
}

const _clearColor = new THREE.Color()

function restoreRendererState(r: THREE.WebGLRenderer, s: RendererState): void {
  r.autoClear = s.autoClear
  r.autoClearColor = s.autoClearColor
  r.autoClearDepth = s.autoClearDepth
  r.autoClearStencil = s.autoClearStencil
  r.sortObjects = s.sortObjects
  r.setRenderTarget(s.target, s.face, s.mip)
  // The proxy scene's background (1e6) leaves the GL clear colour behind; re-apply the renderer's own
  // (after the target is restored: the colour-space conversion depends on it) for manual clear() calls.
  r.setClearColor(r.getClearColor(_clearColor), r.getClearAlpha())
}

/** Atlases of a tier being prepared (prepareQuality). */
interface PendingTier {
  q: Quality
  config: QualityConfig
  /** The tier's new light atlas; undefined = the current one carries over (same layout). */
  light?: DistanceAtlas
  /** The tier's new hi-res / viewer atlas; null = the tier has none; undefined = the current one carries over. */
  hi?: DistanceAtlas | null
  viewer?: DistanceAtlas | null
  /** Every ranked shadowed light (and viewer) had a capture in its tier-`q` atlas after the last frame. */
  ready: boolean
}

const sameLayout = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export interface LightingSystemOptions {
  /** Clock for the per-frame CPU budget (default performance.now; tests inject a fake one). */
  now?: () => number
}

export class AtlasLightingSystem implements LightingSystem {
  readonly shared: SharedUniforms = createSharedUniforms()
  readonly proxies: OccluderProxies
  private readonly renderer: THREE.WebGLRenderer
  private readonly masks: HostMaskTextures
  private readonly distanceMaterial = createOccluderDistanceMaterial()
  private readonly depthMaterial = createOccluderDepthMaterial()
  private readonly reencodeMaterial = createReencodeMaterial()
  private readonly sun = new DirectionalShadowMap(SUN_MAP_SIZE, "atlas-sun")
  private readonly sky = new DirectionalShadowMap(SKY_MAP_SIZE, "atlas-sky")
  private quality: Quality
  private config: QualityConfig
  private lightAtlas: DistanceAtlas
  private hiAtlas: DistanceAtlas | null
  private viewerAtlas: DistanceAtlas | null
  /** AT_TIER define of every world / token / overlay material. */
  readonly tiers: TierRegistry
  private readonly backdrops = new Map<Id, BackdropUniforms>()
  private scene: SceneLike | null = null
  private world: OcclusionWorld | null = null
  private view: ViewState = DEFAULT_VIEW_STATE
  private dimmed = new Set<Id>()
  private lights: ResolvedLight[] | null = null
  /** The atlases were just reallocated (tier change): the next frame recaptures with TIER_SWITCH_CAPTURE_MS. */
  private captureBurst = false
  /** Tier being prepared (adaptive step), committed by setQuality. */
  private pending: PendingTier | null = null
  /** Per-cell slot mask texture (null until the first non-empty slot list) and the slots it was built from. */
  private lightMask: THREE.DataTexture | null = null
  private readonly lightMaskKey = new Float32Array(1 + MAX_LIGHTS * 3).fill(Number.NaN)
  private viewers: ResolvedViewer[] | null = null
  /** More viewers than MAX_VIEWERS uniform slots (set with `viewers`): no per-pixel perception removal. */
  private viewersTruncated = false
  private readonly bounds = new THREE.Box3()
  private sceneDiagonal = 100
  private sunDirty = true
  private skyDirty = true
  private sunDirKey = ""
  private sunEnabled = false
  /** The sky-exposure map is rendered (fill differs, or the rules levels of sky and cover differ). */
  private skyEnabled = false
  /** The sky-exposure map also drives the visual fill (off in player fog mode). */
  private skyVisual = false
  private frame = 0
  private readonly frustum = new THREE.Frustum()
  private readonly projScreen = new THREE.Matrix4()
  private readonly canvas: HTMLCanvasElement | null
  private readonly onContextRestored = () => this.resetGpuState()
  private readonly now: () => number

  constructor(renderer: THREE.WebGLRenderer, quality: Quality, options: LightingSystemOptions = {}) {
    this.renderer = renderer
    this.now = options.now ?? (() => performance.now())
    this.quality = quality
    this.config = QUALITY_CONFIG[quality]
    this.masks = new HostMaskTextures(this.shared)
    this.proxies = new OccluderProxies(this.distanceMaterial)
    this.tiers = new TierRegistry(TIER_DEFINE[quality])
    this.lightAtlas = new DistanceAtlas({ name: "atlas-lights", ...this.config.lightAtlas }, this.reencodeMaterial)
    this.hiAtlas = this.config.hiAtlas ? new DistanceAtlas({ name: "atlas-lights-hi", ...this.config.hiAtlas }, this.reencodeMaterial) : null
    this.viewerAtlas = this.config.viewerAtlas ? new DistanceAtlas({ name: "atlas-viewers", ...this.config.viewerAtlas }, this.reencodeMaterial) : null
    const canvas = (renderer as { domElement?: unknown }).domElement
    this.canvas = typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement ? canvas : null
    this.canvas?.addEventListener("webglcontextrestored", this.onContextRestored)
  }

  // ---------------------------------------------------------------------------------------------
  // Materials

  createWorldMaterial(opts: WorldMaterialOptions): THREE.ShaderMaterial {
    return createWorldMaterial(
      { shared: this.shared, levelUniform: (id) => this.masks.levelUniform(id), levelBackdrop: (id) => this.backdropUniforms(id), tiers: this.tiers },
      opts
    )
  }

  createTokenMaterial(opts: { instanced: boolean }): THREE.ShaderMaterial {
    return createTokenMaterial(
      { shared: this.shared, isDimmed: (id) => this.dimmed.has(id), layerOf: (id) => this.masks.layerOf(id), tiers: this.tiers },
      opts
    )
  }

  createOverlayMaterial(opts: { kind: "glass" | "flame" | "glow" }): THREE.ShaderMaterial {
    return createOverlayMaterial({ shared: this.shared, layerOf: (id) => this.masks.layerOf(id), tiers: this.tiers }, opts)
  }

  /** Shared backdrop uniforms of a level (created on first use; they outlive level rebuilds). */
  private backdropUniforms(levelId: Id): BackdropUniforms {
    let u = this.backdrops.get(levelId)
    if (!u) this.backdrops.set(levelId, (u = createBackdropUniforms()))
    return u
  }

  setLevelBackdrop(levelId: Id, texture: THREE.Texture | null, rect: Rect | null, opacity: number, tintWalls: boolean): void {
    setBackdropUniforms(this.backdropUniforms(levelId), texture, rect, opacity, tintWalls)
  }

  setRenderParams(params: { hdr: boolean; emissive: number; glow: number }): void {
    this.shared.uRenderParams.value.set(params.emissive, params.glow, params.hdr ? 1 : 0, 0)
  }

  maskUniforms(): { uMasks: THREE.IUniform; uMaskGrid: THREE.IUniform; uVisionMode: THREE.IUniform } {
    return { uMasks: this.shared.uMasks, uMaskGrid: this.shared.uMaskGrid, uVisionMode: this.shared.uVisionMode }
  }

  maskLayerOf(levelId: Id): number {
    return this.masks.layerOf(levelId)
  }

  // ---------------------------------------------------------------------------------------------
  // Scene / view / quality

  setScene(scene: SceneLike, world: OcclusionWorld): void {
    this.scene = scene
    this.world = world
    this.proxies.rebuild(world)
    for (const atlas of this.allAtlases()) atlas.invalidateAll()
    this.lights = null
    this.viewers = null
    this.recomputeBounds()
    this.sunDirty = true
    this.skyDirty = true
    this.updateEnvironment()
    this.syncMasks()
    this.precompile()
  }

  applyChange(scene: SceneLike, world: OcclusionWorld, change: SceneChange, dirty: DirtyRegion[]): void {
    this.scene = scene
    this.world = world
    const proxyDirty = this.proxies.update(world)
    const regions = dirty.concat(proxyDirty)
    const atlases = this.allAtlases()
    for (const r of regions) for (const atlas of atlases) atlas.invalidateRegion(r)
    if (regions.length > 0 || change.structure || (change.terrain?.length ?? 0) > 0) {
      this.recomputeBounds()
      this.sunDirty = true
      this.skyDirty = true
    }
    // Lights and eyes depend on objects, tokens (attached lights, viewers), terrain and levels.
    this.lights = null
    this.viewers = null
    this.updateEnvironment()
    this.syncMasks()
  }

  setView(view: ViewState): void {
    const prev = this.view
    this.view = view
    if (prev.vision !== view.vision) this.lights = null
    if (prev.viewerTokenIds.length !== view.viewerTokenIds.length || prev.viewerTokenIds.some((id, k) => view.viewerTokenIds[k] !== id)) {
      this.viewers = null
    }
    this.dimmed = new Set(view.dimmedTokenIds)
    this.shared.uVisionMode.value = VISION_MODE[view.vision]
    this.updateEnvironment()
    this.syncMasks()
  }

  /**
   * Start preparing tier `q` (see the header): allocate the atlases whose layout differs, unbound; later
   * frames fill them. Preparing the current tier cancels a pending one; a different tier replaces it.
   */
  prepareQuality(q: Quality): void {
    if (this.pending?.q === q) return
    this.discardPending()
    if (q === this.quality) return
    const next = QUALITY_CONFIG[q]
    const p: PendingTier = { q, config: next, ready: false }
    if (!sameLayout(next.lightAtlas, this.config.lightAtlas)) p.light = new DistanceAtlas({ name: "atlas-lights", ...next.lightAtlas }, this.reencodeMaterial)
    if (!sameLayout(next.hiAtlas, this.config.hiAtlas)) p.hi = next.hiAtlas ? new DistanceAtlas({ name: "atlas-lights-hi", ...next.hiAtlas }, this.reencodeMaterial) : null
    if (!sameLayout(next.viewerAtlas, this.config.viewerAtlas)) {
      p.viewer = next.viewerAtlas ? new DistanceAtlas({ name: "atlas-viewers", ...next.viewerAtlas }, this.reencodeMaterial) : null
    }
    this.pending = p
  }

  /** Tier `q` can be committed without dropping a light: it is current, or prepared and filled. */
  qualityReady(q: Quality): boolean {
    return q === this.quality || (this.pending?.q === q && this.pending.ready)
  }

  /** Commit tier `q`: the prepared atlases if `q` was prepared, else new ones recaptured in one burst. */
  setQuality(q: Quality): void {
    const p = this.pending?.q === q ? this.pending : null
    if (p) this.pending = null
    else this.discardPending()
    if (q === this.quality) return
    this.quality = q
    const next = QUALITY_CONFIG[q]
    if (p) {
      if (p.light) {
        this.lightAtlas.dispose()
        this.lightAtlas = p.light
      }
      if (p.hi !== undefined) {
        this.hiAtlas?.dispose()
        this.hiAtlas = p.hi
      }
      if (p.viewer !== undefined) {
        this.viewerAtlas?.dispose()
        this.viewerAtlas = p.viewer
      }
      // Committed before every light was filled (the engine's deadline): recapture the rest at once.
      if (!p.ready) this.captureBurst = true
    } else {
      const sameLights = sameLayout(next.lightAtlas, this.config.lightAtlas)
      const sameHi = sameLayout(next.hiAtlas, this.config.hiAtlas)
      const sameViewers = sameLayout(next.viewerAtlas, this.config.viewerAtlas)
      if (!sameLights) {
        this.lightAtlas.dispose()
        this.lightAtlas = new DistanceAtlas({ name: "atlas-lights", ...next.lightAtlas }, this.reencodeMaterial)
      }
      if (!sameHi) {
        this.hiAtlas?.dispose()
        this.hiAtlas = next.hiAtlas ? new DistanceAtlas({ name: "atlas-lights-hi", ...next.hiAtlas }, this.reencodeMaterial) : null
      }
      if (!sameViewers) {
        this.viewerAtlas?.dispose()
        this.viewerAtlas = next.viewerAtlas ? new DistanceAtlas({ name: "atlas-viewers", ...next.viewerAtlas }, this.reencodeMaterial) : null
      }
      // New atlases hold no captures: recapture everything on screen in the next frame (one longer frame)
      // instead of dropping every shadowed light and switching them back on 4 per frame.
      if (!sameLights || !sameHi || !sameViewers) this.captureBurst = true
    }
    this.config = next
    // One-time recompile of every material for the new tier's shader features.
    this.tiers.set(TIER_DEFINE[q])
    // Prepared atlases already hold captures; new ones are bound by beforeRender once they do.
    const bind = (a: DistanceAtlas | null) => (a?.captured ? a.texture : placeholderFloatTexture())
    this.shared.uLightAtlas.value = bind(this.lightAtlas)
    this.shared.uLightAtlasHi.value = bind(this.hiAtlas)
    this.shared.uViewerAtlas.value = bind(this.viewerAtlas)
  }

  private discardPending(): void {
    const p = this.pending
    this.pending = null
    if (!p) return
    p.light?.dispose()
    p.hi?.dispose()
    p.viewer?.dispose()
  }

  /**
   * Per-cell point-light slot mask (lighting/lightMask.ts) of the packed slots, rebuilt only when the slot
   * list changed (count, positions, radii; slots are re-ranked every frame).
   */
  private updateLightMask(packed: Float32Array, count: number): void {
    const slots = packedLightSlots(packed, count, LIGHT_VEC4S)
    if (updateLightMaskKey(this.lightMaskKey, slots)) return
    const s = this.shared
    const mask = buildLightMask(slots)
    if (!mask) {
      s.uLightMask.value = placeholderLightMaskTexture()
      s.uLightMaskGrid.value.set(0, 0, 0, 0)
      return
    }
    let t = this.lightMask
    if (!t || t.image.width !== mask.width || t.image.height !== mask.depth) {
      t?.dispose()
      t = this.lightMask = lightMaskTexture(mask.bits, mask.width, mask.depth)
    } else {
      ;(t.image.data as Uint32Array).set(mask.bits)
      t.needsUpdate = true
    }
    s.uLightMask.value = t
    s.uLightMaskGrid.value.set(mask.originX, mask.originZ, 1 / mask.cell, 1)
  }

  /** Live and pending atlases (invalidation and resets reach both). */
  private allAtlases(): DistanceAtlas[] {
    const out: DistanceAtlas[] = [this.lightAtlas]
    if (this.hiAtlas) out.push(this.hiAtlas)
    if (this.viewerAtlas) out.push(this.viewerAtlas)
    const p = this.pending
    if (p?.light) out.push(p.light)
    if (p?.hi) out.push(p.hi)
    if (p?.viewer) out.push(p.viewer)
    return out
  }

  // ---------------------------------------------------------------------------------------------
  // Per frame

  beforeRender(renderer: THREE.WebGLRenderer, camera: THREE.Camera, timeSec: number): LightingFrameStats {
    const frame = ++this.frame
    const s = this.shared
    // Wrapped so float precision stays fine for animated surfaces after hours of play.
    s.uTime.value = timeSec % 3600
    const scene = this.scene
    const world = this.world
    if (!scene || !world) {
      s.uLightCount.value = 0
      s.uViewerCount.value = 0
      return { activeLights: 0, tilesUpdated: 0, tilesTotal: 0, updateMs: 0 }
    }

    camera.updateMatrixWorld()
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.projScreen, THREE.WebGLCoordinateSystem, camera.reversedDepth === true)

    const cut = this.cutawayY(scene)
    // Caps above the cutaway plane are not lit by shadowed lights of the hidden storey (glsl/common.ts).
    s.uCutawayY.value = cut ?? 1e9
    const ranked = cullAndRankLights(this.resolvedLights(scene, world), {
      frustum: this.frustum,
      camera,
      cutawayY: cut,
      maxLights: MAX_LIGHTS,
    })
    const viewers = this.view.vision === "off" ? [] : this.resolvedViewers(scene, world)
    // GPU line of sight can only veto perception: a viewer without a slot would lose what only it sees.
    const allViewers = this.view.vision === "off" || !this.viewersTruncated
    const refine = this.refineActive() && allViewers

    // Tile requests: every slotted shadowed light / viewer claims its tile (LRU keeps the rest cached).
    // Ultra: the first `hiLights` shadowed lights by rank claim a hi-res tile instead.
    const requests: TileUpdateRequest[] = []
    const jobs = new Map<string, () => void>()
    const lightAtlas = this.lightAtlas
    const hiAtlas = this.hiAtlas
    const hiRanked = new Set<Id>()
    for (const l of ranked) {
      if (!l.castsShadows) continue
      const key = `light:${l.id}`
      const useHi = hiAtlas !== null && hiRanked.size < this.config.hiLights
      if (useHi) hiRanked.add(l.id)
      const atlas = useHi ? hiAtlas : lightAtlas
      const tile = atlas.tiles.acquire(key, frame)
      // Keep the other atlas' tile of this light cached as a fallback while the new one is captured.
      ;(useHi ? lightAtlas : hiAtlas)?.tiles.touch(key, frame)
      if (!tile) continue
      const st = tile.state
      const moved = st !== null && DistanceAtlas.moved(st, l.position, l.dim)
      if (st === null || moved || st.dirty) {
        requests.push({ key: useHi ? `hi:${key}` : key, kind: "light", forced: false, moved, uncaptured: st === null, dirty: st?.dirty ?? false, coverage: l.coverage })
        jobs.set(useHi ? `hi:${key}` : key, () =>
          atlas.capture(renderer, tile, l.position, l.dim, LIGHT_LAYER_MASK, this.proxies.scene, this.distanceMaterial, this.excludeKeys(world, l.position, "light"))
        )
      }
    }
    const viewerAtlas = refine ? this.viewerAtlas : null
    if (viewerAtlas) {
      viewers.forEach((v, index) => {
        const key = `viewer:${v.tokenId}`
        const tile = viewerAtlas.tiles.acquire(key, frame)
        if (!tile) return
        const st = tile.state
        const moved = st !== null && DistanceAtlas.moved(st, v.eye, v.range)
        if (st === null || moved || st.dirty) {
          // The first viewer is the locally controlled / selected token: always updated, even over budget.
          requests.push({ key, kind: "viewer", forced: index === 0, moved, uncaptured: st === null, dirty: st?.dirty ?? false, coverage: 1 })
          jobs.set(key, () =>
            viewerAtlas.capture(renderer, tile, v.eye, v.range, SIGHT_LAYER_MASK, this.proxies.scene, this.distanceMaterial, this.excludeKeys(world, v.eye, "sight"))
          )
        }
      })
    }

    const ordered = orderTileUpdates(requests)
    const burst = this.captureBurst
    this.captureBurst = false
    const prep = this.pending ? this.pendingTileRequests(this.pending, ranked, viewers, allViewers, world, renderer, frame) : null
    const needSun = this.sunEnabled && this.sunDirty
    const needSky = this.skyEnabled && this.skyDirty
    let tilesUpdated = 0
    let updateMs = 0
    if (ordered.length > 0 || needSun || needSky || (prep?.ordered.length ?? 0) > 0) {
      const t0 = this.now()
      const saved = saveRendererState(renderer)
      renderer.autoClear = false
      renderer.autoClearColor = true
      renderer.autoClearDepth = true
      renderer.autoClearStencil = true
      renderer.sortObjects = false
      try {
        if (needSun) this.renderSun(renderer, scene)
        if (needSky) this.renderSky(renderer)
        const budget = burst ? { maxTiles: MAX_LIGHTS + MAX_VIEWERS, maxMs: TIER_SWITCH_CAPTURE_MS } : { maxTiles: SHADOW_UPDATES_PER_FRAME, maxMs: SHADOW_UPDATE_MS }
        const run = runTileUpdates(ordered, budget, (r) => jobs.get(r.key)?.(), this.now)
        tilesUpdated = run.updated.length
        // The tier being prepared fills its atlases under a budget of its own (unbound until committed).
        if (prep && prep.ordered.length > 0) {
          const pre = runTileUpdates(prep.ordered, { maxTiles: SHADOW_UPDATES_PER_FRAME, maxMs: SHADOW_UPDATE_MS }, (r) => prep.jobs.get(r.key)?.(), this.now)
          tilesUpdated += pre.updated.length
        }
      } finally {
        restoreRendererState(renderer, saved)
      }
      updateMs = this.now() - t0
    }
    if (prep && this.pending) this.pending.ready = prep.isReady()

    // Which directional maps hold a current render (the perception refinement trusts only those).
    s.uEnvLevels.value.w = (this.skyEnabled && !this.skyDirty ? ENV_FLAG_SKY_MAP : 0) + (this.sunEnabled && !this.sunDirty ? ENV_FLAG_SUN_MAP : 0)

    // Light uniforms: shadowed lights need a captured tile, otherwise they are not drawn this frame.
    // A light prefers its tile in the atlas it is ranked for; a current capture in the other atlas
    // (it just switched) stands in until then.
    const packed = s.uLights.value
    let count = 0
    let wide = 0
    const soft = this.config.softShadows
    for (const l of ranked) {
      let tile: { x: number; y: number; size: number } | null = null
      let capture: Vec3 | null = null
      let hi = false
      if (l.castsShadows) {
        const key = `light:${l.id}`
        const hiTile = hiAtlas?.tiles.get(key)
        const loTile = lightAtlas.tiles.get(key)
        const usable = (t: typeof hiTile) => (t?.state && !DistanceAtlas.moved(t.state, l.position, l.dim) ? t : undefined)
        const pick = hiRanked.has(l.id)
          ? (hiTile?.state ? hiTile : undefined) ?? usable(loTile)
          : (loTile?.state ? loTile : undefined) ?? usable(hiTile)
        if (!pick?.state) continue
        tile = pick
        capture = pick.state.origin
        hi = pick === hiTile
      }
      const f = flickerFactor(l.seed, timeSec, l.flicker) * l.intensity
      const widePcf = tile !== null && wide < this.config.widePcfLights
      if (widePcf) wide++
      packLight(packed, count, {
        position: l.position,
        dim: l.dim,
        bright: l.bright,
        radiance: [l.color[0] * f, l.color[1] * f, l.color[2] * f],
        tile,
        capture,
        widePcf,
        hiAtlas: hi,
        softRadius: soft && tile !== null ? l.sourceRadius : 0,
      })
      count++
    }
    s.uLightCount.value = count
    this.updateLightMask(packed, count)

    let viewerCount = 0
    for (const v of viewers) {
      const t = viewerAtlas?.tiles.get(`viewer:${v.tokenId}`)
      packViewer(s.uViewers.value, viewerCount++, {
        eye: v.eye,
        darkvision: v.vision.blind ? 0 : v.vision.darkvision,
        blindsight: v.vision.blindsight,
        tile: t?.state ? t : null,
        capture: t?.state?.origin ?? null,
        touch: v.touch,
      })
    }
    s.uViewerCount.value = viewerCount
    s.uViewersAll.value = allViewers ? 1 : 0
    s.uGpuRefine.value = viewerAtlas ? 1 : 0
    // Atlases are allocated on their first capture; until then the samplers read a real placeholder.
    s.uLightAtlas.value = lightAtlas.captured ? lightAtlas.texture : placeholderFloatTexture()
    s.uLightAtlasHi.value = hiAtlas?.captured ? hiAtlas.texture : placeholderFloatTexture()
    s.uViewerAtlas.value = viewerAtlas?.captured ? viewerAtlas.texture : placeholderFloatTexture()

    let tilesTotal = 0
    for (const t of lightAtlas.tiles.owned()) if (t.state) tilesTotal++
    if (hiAtlas) for (const t of hiAtlas.tiles.owned()) if (t.state) tilesTotal++
    if (this.viewerAtlas) for (const t of this.viewerAtlas.tiles.owned()) if (t.state) tilesTotal++
    return { activeLights: count, tilesUpdated, tilesTotal, updateMs }
  }

  dispose(): void {
    this.canvas?.removeEventListener("webglcontextrestored", this.onContextRestored)
    this.discardPending()
    this.lightMask?.dispose()
    this.lightMask = null
    this.lightAtlas.dispose()
    this.hiAtlas?.dispose()
    this.viewerAtlas?.dispose()
    this.sun.dispose()
    this.sky.dispose()
    this.proxies.dispose()
    this.masks.dispose()
    this.distanceMaterial.dispose()
    this.depthMaterial.dispose()
    this.reencodeMaterial.dispose()
    this.scene = null
    this.world = null
  }

  // ---------------------------------------------------------------------------------------------
  // Introspection (engine stats overlay, tests)

  get lightAtlasTexture(): THREE.Texture {
    return this.lightAtlas.texture
  }

  get viewerAtlasTexture(): THREE.Texture | null {
    return this.viewerAtlas?.texture ?? null
  }

  /** Current tile of a light / viewer ("light:<id>" / "viewer:<id>"; "hi:light:<id>" = hi-res atlas), if captured. */
  tileOf(key: string): { x: number; y: number; size: number; origin: Vec3; dirty: boolean } | null {
    const atlas = key.startsWith("viewer:") ? this.viewerAtlas : key.startsWith("hi:") ? this.hiAtlas : this.lightAtlas
    if (key.startsWith("hi:")) key = key.slice(3)
    const t = atlas?.tiles.get(key)
    return t?.state ? { x: t.x, y: t.y, size: t.size, origin: t.state.origin, dirty: t.state.dirty } : null
  }

  // ---------------------------------------------------------------------------------------------
  // Internals

  /**
   * Captures the tier being prepared still needs: each ranked shadowed light in the atlas it will draw
   * from at that tier (its hi-res tile by rank, else a lo tile, in the new atlas or, when the lo layout
   * carries over, the current one: ultra → high lights keep their lo tiles captured), and each viewer when
   * the tier refines line of sight on the GPU. Tiles the current tier already keeps up to date for the
   * same atlas need nothing. `isReady()` (after the captures ran) = every one of them has a capture.
   */
  private pendingTileRequests(
    p: PendingTier,
    ranked: readonly RankedLight[],
    viewers: readonly ResolvedViewer[],
    allViewers: boolean,
    world: OcclusionWorld,
    renderer: THREE.WebGLRenderer,
    frame: number
  ): { ordered: TileUpdateRequest[]; jobs: Map<string, () => void>; isReady: () => boolean } {
    const lightAtlas = p.light ?? this.lightAtlas
    const hiAtlas = p.hi === undefined ? this.hiAtlas : p.hi
    const viewerAtlas = p.viewer === undefined ? this.viewerAtlas : p.viewer
    const requests: TileUpdateRequest[] = []
    const jobs = new Map<string, () => void>()
    const needed: { atlas: DistanceAtlas; key: string }[] = []
    let hiCount = 0
    for (const l of ranked) {
      if (!l.castsShadows) continue
      const key = `light:${l.id}`
      const useHi = hiAtlas !== null && hiCount < p.config.hiLights
      if (useHi) hiCount++
      const atlas = useHi ? hiAtlas : lightAtlas
      const tile = atlas.tiles.acquire(key, frame)
      if (!tile) continue
      needed.push({ atlas, key })
      const st = tile.state
      const moved = st !== null && DistanceAtlas.moved(st, l.position, l.dim)
      if (st !== null && !moved && !st.dirty) continue
      const job = `prep:${atlas.options.name}:${key}`
      requests.push({ key: job, kind: "light", forced: false, moved, uncaptured: st === null, dirty: st?.dirty ?? false, coverage: l.coverage })
      jobs.set(job, () => atlas.capture(renderer, tile, l.position, l.dim, LIGHT_LAYER_MASK, this.proxies.scene, this.distanceMaterial, this.excludeKeys(world, l.position, "light")))
    }
    const refine = viewerAtlas !== null && viewerAtlas !== this.viewerAtlas && allViewers && this.view.vision !== "off" && this.view.gpuVisionRefine
    if (refine) {
      for (const v of viewers) {
        const key = `viewer:${v.tokenId}`
        const tile = viewerAtlas.tiles.acquire(key, frame)
        if (!tile) continue
        needed.push({ atlas: viewerAtlas, key })
        const st = tile.state
        const moved = st !== null && DistanceAtlas.moved(st, v.eye, v.range)
        if (st !== null && !moved && !st.dirty) continue
        const job = `prep:${viewerAtlas.options.name}:${key}`
        requests.push({ key: job, kind: "viewer", forced: false, moved, uncaptured: st === null, dirty: st?.dirty ?? false, coverage: 1 })
        jobs.set(job, () => viewerAtlas.capture(renderer, tile, v.eye, v.range, SIGHT_LAYER_MASK, this.proxies.scene, this.distanceMaterial, this.excludeKeys(world, v.eye, "sight")))
      }
    }
    return {
      ordered: orderTileUpdates(requests),
      jobs,
      // Stale captures are fine (they are refreshed after the switch); missing ones would drop a light.
      isReady: () => needed.every(({ atlas, key }) => atlas.tiles.get(key)?.state != null),
    }
  }

  private resolvedLights(scene: SceneLike, world: OcclusionWorld): ResolvedLight[] {
    // The DM with vision "off" sees hidden lights; previews show what the previewed tokens' players see.
    // Origins are pushed out of light blockers (cleared with the world in setScene / applyChange).
    if (!this.lights) this.lights = resolveLights(scene, world, { includeHidden: this.view.vision === "off" })
    return this.lights
  }

  private resolvedViewers(scene: SceneLike, world: OcclusionWorld): ResolvedViewer[] {
    if (this.viewers) return this.viewers
    const out: ResolvedViewer[] = []
    let truncated = false
    for (const id of this.view.viewerTokenIds) {
      if (!Object.hasOwn(scene.tokens, id)) continue
      const token = scene.tokens[id]
      const range = token.vision.blind ? Math.max(token.vision.blindsight, 1) : Math.max(this.sceneDiagonal, 1)
      const eye = viewerEye(world, scene, token)
      if (!Number.isFinite(eye.x + eye.y + eye.z + range)) continue
      if (out.length >= MAX_VIEWERS) {
        truncated = true
        break
      }
      out.push({ tokenId: id, levelId: token.levelId, eye, vision: token.vision, range, touch: viewerTouch(scene, token, eye) })
    }
    this.viewers = out
    this.viewersTruncated = truncated
    return out
  }

  private refineActive(): boolean {
    return this.view.vision !== "off" && this.view.gpuVisionRefine && this.viewerAtlas !== null
  }

  private cutawayY(scene: SceneLike): number | null {
    const v = this.view
    if (!v.cutaway || (v.mode !== "player" && v.mode !== "dm-play")) return null
    return cutawayPlaneY(scene, v.activeLevelId)
  }

  /** Numeric keys of up to 4 primitives containing a capture source (they must not occlude it). */
  private excludeKeys(world: OcclusionWorld, p: Vec3, channel: BlockChannel): number[] {
    try {
      return world
        .containing(p, channel)
        .slice(0, 4)
        .map((prim) => this.proxies.keyId(prim.key))
    } catch {
      return []
    }
  }

  private syncMasks(): void {
    if (!this.scene || this.view.vision === "off") return
    this.masks.sync(this.scene, this.view.hostMasks)
  }

  private updateEnvironment(): void {
    const scene = this.scene
    if (!scene) return
    const env = scene.environment
    const s = this.shared
    const [ar, ag, ab] = linearColor(env.ambientColor)
    const covered = env.ambientIntensity + levelFill(env.ambientLevel)
    const open = env.ambientIntensity + levelFill(env.skyLevel)
    s.uAmbient.value.setRGB(ar * covered, ag * covered, ab * covered, THREE.LinearSRGBColorSpace)
    s.uSkyAmbient.value.setRGB(ar * open, ag * open, ab * open, THREE.LinearSRGBColorSpace)
    // Sky exposure changes the visual fill only outside player fog mode: the player's scene lacks
    // unexplored roofs, so its sky map would light interiors. The map is still rendered when the rules
    // levels differ: the perception refinement reads it as an upper bound (missing roofs only
    // over-estimate exposure, which never removes perception wrongly).
    const ambientN = LIGHT_LEVEL_NUMBER[env.ambientLevel]
    const skyN = LIGHT_LEVEL_NUMBER[env.skyLevel]
    this.skyVisual = open !== covered && this.view.vision !== "fog"
    this.skyEnabled = open !== covered || skyN !== ambientN
    s.uSkyParams.value.w = this.skyVisual ? 1 : 0

    const d = env.directional
    const dir = directionToSun(d)
    s.uSunDir.value.set(dir[0], dir[1], dir[2])
    const key = dir.map((v) => v.toFixed(6)).join(",")
    if (key !== this.sunDirKey) {
      this.sunDirKey = key
      this.sunDirty = true
    }
    s.uEnvLevels.value.set(ambientN, skyN, d.enabled ? LIGHT_LEVEL_NUMBER[d.grants] : 0, s.uEnvLevels.value.w)
    this.sunEnabled = d.enabled && d.intensity > 0
    if (this.sunEnabled) {
      const [r, g, b] = linearColor(d.color)
      s.uSunColor.value.setRGB(r * d.intensity, g * d.intensity, b * d.intensity, THREE.LinearSRGBColorSpace)
    } else {
      s.uSunColor.value.setRGB(0, 0, 0, THREE.LinearSRGBColorSpace)
    }
  }

  private recomputeBounds(): void {
    const scene = this.scene
    if (!scene) return
    const b = this.bounds.makeEmpty()
    const g = scene.grid
    let lo = 0
    let hi = 0
    for (const l of sortedLevels(scene)) {
      lo = Math.min(lo, l.elevation - l.floorThickness)
      hi = Math.max(hi, l.elevation + l.height)
    }
    b.expandByPoint(new THREE.Vector3(0, lo, 0))
    b.expandByPoint(new THREE.Vector3(g.width * g.cellSize, hi, g.depth * g.cellSize))
    const pb = this.proxies.bounds()
    if (pb) b.union(pb)
    this.sceneDiagonal = b.getSize(new THREE.Vector3()).length()
    // Viewer ranges depend on the diagonal.
    this.viewers = null
  }

  private renderSun(renderer: THREE.WebGLRenderer, scene: SceneLike): void {
    const dir = directionToSun(scene.environment.directional)
    this.sun.render(renderer, this.proxies.scene, this.depthMaterial, this.bounds, new THREE.Vector3(dir[0], dir[1], dir[2]), LIGHT_LAYER_MASK)
    const s = this.shared
    s.uSunMatrix.value.copy(this.sun.matrix)
    s.uSunShadow.value = this.sun.depthTexture
    const reversed = renderer.state.buffers.depth.getReversed() ? 1 : 0
    s.uSunParams.value.set(1 / this.sun.size, DIRECTIONAL_BIAS_FT / Math.max(this.sun.depthRange, 1e-3), reversed, 1.5 * this.sun.texelWorld)
    this.sunDirty = false
  }

  private renderSky(renderer: THREE.WebGLRenderer): void {
    this.sky.render(renderer, this.proxies.scene, this.depthMaterial, this.bounds, new THREE.Vector3(0, 1, 0), LIGHT_LAYER_MASK)
    const s = this.shared
    s.uSkyMatrix.value.copy(this.sky.matrix)
    s.uSkyShadow.value = this.sky.depthTexture
    s.uSkyParams.value.set(1 / this.sky.size, DIRECTIONAL_BIAS_FT / Math.max(this.sky.depthRange, 1e-3), 1.5 * this.sky.texelWorld, this.skyVisual ? 1 : 0)
    // Sun params carry the reversed-depth flag shared by both maps.
    s.uSunParams.value.z = renderer.state.buffers.depth.getReversed() ? 1 : 0
    this.skyDirty = false
  }

  /** Compile the proxy / re-encode programs ahead of the first capture (best effort, async). */
  private precompile(): void {
    void precompileScene(this.renderer, this.proxies.scene, new THREE.PerspectiveCamera(90, 1, 0.05, 100))
  }

  private resetGpuState(): void {
    for (const atlas of this.allAtlases()) atlas.reset()
    if (this.pending) this.pending.ready = false
    this.sunDirty = true
    this.skyDirty = true
    this.masks.invalidate()
  }
}

export const createLightingSystem: CreateLightingSystem = (renderer, opts) => new AtlasLightingSystem(renderer, opts.quality)
