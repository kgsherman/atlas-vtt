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
 *  - host-mask textures (render/fog) and the shared uniforms of world / token materials.
 */
import * as THREE from "three"

import type { BlockChannel, DirtyRegion, OcclusionWorld } from "@/core/occlusion/types"
import { levelCeilingY, nominalTokenEye, sortedLevels } from "@/core/scene/queries"
import type { Id, SceneLike, Token, Vec3, VisionSettings } from "@/core/scene/types"
import { resolveViewerEye } from "@/core/vision"
import type { Quality, SceneChange, ViewState } from "../contracts"
import { HostMaskTextures } from "../fog/hostMaskTextures"
import { LAYER, type CreateLightingSystem, type LightingFrameStats, type LightingSystem, type WorldMaterialOptions } from "../internal"
import { createOccluderDepthMaterial, createOccluderDistanceMaterial, createReencodeMaterial } from "../materials/occluderMaterials"
import { createOverlayMaterial } from "../materials/overlayMaterial"
import { placeholderFloatTexture } from "../materials/placeholders"
import { precompileScene } from "../materials/util"
import { createTokenMaterial } from "../materials/tokenMaterial"
import { createWorldMaterial } from "../materials/worldMaterial"
import { OccluderProxies } from "../occluders/proxies"
import { DirectionalShadowMap } from "../shadows/directionalShadow"
import { DistanceAtlas, type DistanceAtlasOptions } from "../shadows/distanceAtlas"
import { flickerFactor } from "./flicker"
import { directionToSun, levelFill } from "./lightModel"
import { cullAndRankLights, cutawayPlaneY, linearColor, resolveLights, type ResolvedLight } from "./lights"
import { orderTileUpdates, runTileUpdates, SHADOW_UPDATE_MS, SHADOW_UPDATES_PER_FRAME, type TileUpdateRequest } from "./scheduler"
import {
  createSharedUniforms,
  ENV_FLAG_SKY_MAP,
  ENV_FLAG_SUN_MAP,
  LIGHT_LEVEL_NUMBER,
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
   * them for ~0.1 ms on the stress scene (measured on an integrated GPU), so high uses it for every light.
   */
  widePcfLights: number
}

export const QUALITY_CONFIG: Record<Quality, QualityConfig> = {
  low: {
    lightAtlas: { width: 2048, height: 1024, tileSize: 256, cubeSize: 256 },
    viewerAtlas: null,
    widePcfLights: 0,
  },
  medium: {
    lightAtlas: { width: 4096, height: 2048, tileSize: 512, cubeSize: 256 },
    viewerAtlas: { width: 4096, height: 2048, tileSize: 1024, cubeSize: 512 },
    widePcfLights: 8,
  },
  high: {
    lightAtlas: { width: 4096, height: 2048, tileSize: 512, cubeSize: 256 },
    viewerAtlas: { width: 4096, height: 2048, tileSize: 1024, cubeSize: 512 },
    widePcfLights: 32,
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
  private viewerAtlas: DistanceAtlas | null
  private scene: SceneLike | null = null
  private world: OcclusionWorld | null = null
  private view: ViewState = DEFAULT_VIEW_STATE
  private dimmed = new Set<Id>()
  private lights: ResolvedLight[] | null = null
  private viewers: ResolvedViewer[] | null = null
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
    this.lightAtlas = new DistanceAtlas({ name: "atlas-lights", ...this.config.lightAtlas }, this.reencodeMaterial)
    this.viewerAtlas = this.config.viewerAtlas ? new DistanceAtlas({ name: "atlas-viewers", ...this.config.viewerAtlas }, this.reencodeMaterial) : null
    const canvas = (renderer as { domElement?: unknown }).domElement
    this.canvas = typeof HTMLCanvasElement !== "undefined" && canvas instanceof HTMLCanvasElement ? canvas : null
    this.canvas?.addEventListener("webglcontextrestored", this.onContextRestored)
  }

  // ---------------------------------------------------------------------------------------------
  // Materials

  createWorldMaterial(opts: WorldMaterialOptions): THREE.ShaderMaterial {
    return createWorldMaterial({ shared: this.shared, levelUniform: (id) => this.masks.levelUniform(id) }, opts)
  }

  createTokenMaterial(opts: { instanced: boolean }): THREE.ShaderMaterial {
    return createTokenMaterial(
      { shared: this.shared, isDimmed: (id) => this.dimmed.has(id), layerOf: (id) => this.masks.layerOf(id) },
      opts
    )
  }

  createOverlayMaterial(opts: { kind: "glass" | "flame" }): THREE.ShaderMaterial {
    return createOverlayMaterial({ shared: this.shared, layerOf: (id) => this.masks.layerOf(id) }, opts)
  }

  // ---------------------------------------------------------------------------------------------
  // Scene / view / quality

  setScene(scene: SceneLike, world: OcclusionWorld): void {
    this.scene = scene
    this.world = world
    this.proxies.rebuild(world)
    this.lightAtlas.invalidateAll()
    this.viewerAtlas?.invalidateAll()
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
    for (const r of regions) {
      this.lightAtlas.invalidateRegion(r)
      this.viewerAtlas?.invalidateRegion(r)
    }
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

  setQuality(q: Quality): void {
    if (q === this.quality) return
    this.quality = q
    const next = QUALITY_CONFIG[q]
    const sameLights = JSON.stringify(next.lightAtlas) === JSON.stringify(this.config.lightAtlas)
    const sameViewers = JSON.stringify(next.viewerAtlas) === JSON.stringify(this.config.viewerAtlas)
    this.config = next
    if (!sameLights) {
      this.lightAtlas.dispose()
      this.lightAtlas = new DistanceAtlas({ name: "atlas-lights", ...next.lightAtlas }, this.reencodeMaterial)
    }
    if (!sameViewers) {
      this.viewerAtlas?.dispose()
      this.viewerAtlas = next.viewerAtlas ? new DistanceAtlas({ name: "atlas-viewers", ...next.viewerAtlas }, this.reencodeMaterial) : null
    }
    // beforeRender binds the new atlases once they hold captures.
    this.shared.uLightAtlas.value = placeholderFloatTexture()
    this.shared.uViewerAtlas.value = placeholderFloatTexture()
  }

  // ---------------------------------------------------------------------------------------------
  // Per frame

  beforeRender(renderer: THREE.WebGLRenderer, camera: THREE.Camera, timeSec: number): LightingFrameStats {
    const frame = ++this.frame
    const s = this.shared
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

    const ranked = cullAndRankLights(this.resolvedLights(scene), {
      frustum: this.frustum,
      camera,
      cutawayY: this.cutawayY(scene),
      maxLights: MAX_LIGHTS,
    })
    const viewers = this.view.vision === "off" ? [] : this.resolvedViewers(scene, world)
    const refine = this.refineActive()

    // Tile requests: every slotted shadowed light / viewer claims its tile (LRU keeps the rest cached).
    const requests: TileUpdateRequest[] = []
    const jobs = new Map<string, () => void>()
    const lightAtlas = this.lightAtlas
    for (const l of ranked) {
      if (!l.castsShadows) continue
      const key = `light:${l.id}`
      const tile = lightAtlas.tiles.acquire(key, frame)
      if (!tile) continue
      const st = tile.state
      const moved = st !== null && DistanceAtlas.moved(st, l.position, l.dim)
      if (st === null || moved || st.dirty) {
        requests.push({ key, kind: "light", forced: false, moved, uncaptured: st === null, dirty: st?.dirty ?? false, coverage: l.coverage })
        jobs.set(key, () =>
          lightAtlas.capture(renderer, tile, l.position, l.dim, LIGHT_LAYER_MASK, this.proxies.scene, this.distanceMaterial, this.excludeKeys(world, l.position, "light"))
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
    const needSun = this.sunEnabled && this.sunDirty
    const needSky = this.skyEnabled && this.skyDirty
    let tilesUpdated = 0
    let updateMs = 0
    if (ordered.length > 0 || needSun || needSky) {
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
        const run = runTileUpdates(ordered, { maxTiles: SHADOW_UPDATES_PER_FRAME, maxMs: SHADOW_UPDATE_MS }, (r) => jobs.get(r.key)?.(), this.now)
        tilesUpdated = run.updated.length
      } finally {
        restoreRendererState(renderer, saved)
      }
      updateMs = this.now() - t0
    }

    // Which directional maps hold a current render (the perception refinement trusts only those).
    s.uEnvLevels.value.w = (this.skyEnabled && !this.skyDirty ? ENV_FLAG_SKY_MAP : 0) + (this.sunEnabled && !this.sunDirty ? ENV_FLAG_SUN_MAP : 0)

    // Light uniforms: shadowed lights need a captured tile, otherwise they are not drawn this frame.
    const packed = s.uLights.value
    let count = 0
    let wide = 0
    for (const l of ranked) {
      let tile: { x: number; y: number; size: number } | null = null
      let capture: Vec3 | null = null
      if (l.castsShadows) {
        const t = lightAtlas.tiles.get(`light:${l.id}`)
        if (!t?.state) continue
        tile = t
        capture = t.state.origin
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
      })
      count++
    }
    s.uLightCount.value = count

    let viewerCount = 0
    for (const v of viewers) {
      const t = viewerAtlas?.tiles.get(`viewer:${v.tokenId}`)
      packViewer(s.uViewers.value, viewerCount++, {
        eye: v.eye,
        darkvision: v.vision.blind ? 0 : v.vision.darkvision,
        blindsight: v.vision.blindsight,
        tile: t?.state ? t : null,
        capture: t?.state?.origin ?? null,
        far: t?.state?.far ?? v.range,
      })
    }
    s.uViewerCount.value = viewerCount
    s.uGpuRefine.value = viewerAtlas ? 1 : 0
    // Atlases are allocated on their first capture; until then the samplers read a real placeholder.
    s.uLightAtlas.value = lightAtlas.captured ? lightAtlas.texture : placeholderFloatTexture()
    s.uViewerAtlas.value = viewerAtlas?.captured ? viewerAtlas.texture : placeholderFloatTexture()

    let tilesTotal = 0
    for (const t of lightAtlas.tiles.owned()) if (t.state) tilesTotal++
    if (this.viewerAtlas) for (const t of this.viewerAtlas.tiles.owned()) if (t.state) tilesTotal++
    return { activeLights: count, tilesUpdated, tilesTotal, updateMs }
  }

  dispose(): void {
    this.canvas?.removeEventListener("webglcontextrestored", this.onContextRestored)
    this.lightAtlas.dispose()
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

  /** Current tile of a light / viewer ("light:<id>" / "viewer:<id>"), if captured. */
  tileOf(key: string): { x: number; y: number; size: number; origin: Vec3; dirty: boolean } | null {
    const atlas = key.startsWith("viewer:") ? this.viewerAtlas : this.lightAtlas
    const t = atlas?.tiles.get(key)
    return t?.state ? { x: t.x, y: t.y, size: t.size, origin: t.state.origin, dirty: t.state.dirty } : null
  }

  // ---------------------------------------------------------------------------------------------
  // Internals

  private resolvedLights(scene: SceneLike): ResolvedLight[] {
    // The DM with vision "off" sees hidden lights; previews show what the previewed tokens' players see.
    if (!this.lights) this.lights = resolveLights(scene, { includeHidden: this.view.vision === "off" })
    return this.lights
  }

  private resolvedViewers(scene: SceneLike, world: OcclusionWorld): ResolvedViewer[] {
    if (this.viewers) return this.viewers
    const out: ResolvedViewer[] = []
    for (const id of this.view.viewerTokenIds) {
      if (out.length >= MAX_VIEWERS) break
      if (!Object.hasOwn(scene.tokens, id)) continue
      const token = scene.tokens[id]
      const range = token.vision.blind ? Math.max(token.vision.blindsight, 1) : Math.max(this.sceneDiagonal, 1)
      const eye = viewerEye(world, scene, token)
      if (!Number.isFinite(eye.x + eye.y + eye.z + range)) continue
      out.push({ tokenId: id, levelId: token.levelId, eye, vision: token.vision, range })
    }
    this.viewers = out
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
    this.lightAtlas.reset()
    this.viewerAtlas?.reset()
    this.sunDirty = true
    this.skyDirty = true
    this.masks.invalidate()
  }
}

export const createLightingSystem: CreateLightingSystem = (renderer, opts) => new AtlasLightingSystem(renderer, opts.quality)
