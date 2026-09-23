/**
 * The render engine (contracts.ts Engine; ARCHITECTURE §4.3, §4.5): WebGL2 renderer, frame loop,
 * resize with a pixel budget, adaptive quality, stats, context loss handling; per-level visual meshes
 * rebuilt incrementally from SceneChange; the OcclusionWorld kept in sync for the lighting system;
 * cameras, overlays and picking.
 *
 * World, token, glass and flame materials come only from the LightingSystem (render/lighting), so all of
 * them honour fog; editor overlays use unlit three.js materials. Nothing here adds THREE.Light,
 * scene.fog, shadow maps or clipping planes.
 *
 * Frame (ARCHITECTURE §10): low / medium render straight to the canvas (tone mapping in the materials,
 * context MSAA). High / ultra render the world into the post pipeline's HDR MSAA target, run AO (ultra),
 * bloom and the composite onto the canvas, then draw the OVERLAY layer (outlines, previews, rulers, token
 * rings) on top, depth-tested against the composited scene depth and untouched by tone mapping.
 */
import * as THREE from "three"

import { buildOcclusionWorld } from "@/core/occlusion"
import type { DirtyRegion, OcclusionWorld } from "@/core/occlusion/types"
import { effectiveFloorRects, lightLevelId, sortedLevels, tokenGroundY, type EffectiveFloor } from "@/core/scene/queries"
import type { Id, SceneLike, Vec3 } from "@/core/scene/types"

import { BuildContext, buildBucket, buildLevel, BUCKETS } from "../builders"
import { DOOR_ANIMATION_SECONDS } from "../builders/doors"
import { flameFlicker } from "../builders/fixtures"
import { updateTerrainGeometry } from "../builders/floors"
import { GroundSampler } from "../builders/ground"
import { tokenBaseGeometry } from "../builders/tokens"
import { sceneBounds, type Bounds3 } from "../cameras/fit"
import { OrbitCameraController } from "../cameras/orbit"
import { TopDownCameraController } from "../cameras/topdown"
import type { CameraController } from "../cameras/types"
import type { Engine, EngineOptions, FrameStats, OverlayState, PickOptions, PickResult, Quality, SceneChange, ViewState } from "../contracts"
import { LAYER, type LightingSystem } from "../internal"
import { createLightingSystem } from "../lighting/system"
import { precompileScene } from "../materials/util"
import { DIRECT_EMISSIVE, POST_SETTINGS, PostPipeline, type PostSettings } from "../post/pipeline"
import type { ObjectMeshRef } from "../overlays/highlight"
import { OverlayManager } from "../overlays/manager"
import { Picker } from "../picking/picker"
import { DEFAULT_VIEW, MAX_TILT } from "./defaults"
import { classifyStructure, diffScenes, gridRect, heightmapDiffRect, invalidation, occlusionClosure } from "./diff"
import { GpuTimer } from "./gpuTimer"
import { computeLevelPlan, effectiveActiveLevelId, type LevelPlanEntry } from "./levelPlan"
import { LevelView, type LevelMaterials, type SharedMaterials } from "./levels"
import { pickInitialQuality } from "./autoQuality"
import { BackdropManager, type BackdropOptions } from "./backdrops"
import { AdaptiveQuality, computePixelRatio, FrameTimeWindow, intervalFrameCost, MAX_PIXEL_RATIO, PIXEL_BUDGET } from "./quality"
import { TokenLayer } from "./tokens"

const LAYERS_ALL = (1 << LAYER.VISUAL) | (1 << LAYER.OVERLAY)
const LAYERS_WORLD = 1 << LAYER.VISUAL
const LAYERS_OVERLAY = 1 << LAYER.OVERLAY

export class AtlasEngine implements Engine {
  private readonly canvas: HTMLCanvasElement
  private readonly opts: EngineOptions
  private readonly renderer: THREE.WebGLRenderer
  private readonly lighting: LightingSystem
  private readonly root = new THREE.Scene()
  private readonly worldRoot = new THREE.Object3D()
  private readonly levels = new Map<Id, LevelView>()
  private readonly shared: SharedMaterials
  private readonly tokenInstancedMaterial: THREE.ShaderMaterial
  private readonly tokens: TokenLayer
  private readonly overlays: OverlayManager
  private readonly picker: Picker
  private readonly orbit: OrbitCameraController
  private readonly topdown: TopDownCameraController
  private controller: CameraController
  private gpuTimer: GpuTimer
  /** High / ultra post-processing (null = direct rendering). */
  private post: PostPipeline | null = null
  private readonly backdrops: BackdropManager

  private view: ViewState = { ...DEFAULT_VIEW }
  private plan = new Map<Id, LevelPlanEntry>()
  private scene: SceneLike | null = null
  private world: OcclusionWorld | null = null
  private bounds: Bounds3 = { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 10, z: 100 } }
  private framed = false
  private precompiled = false

  /** Heightmap-brush previews: dense lattices per level. */
  private readonly previews = new Map<Id, Float32Array>()
  private readonly samplers = new Map<Id, GroundSampler>()
  private readonly floorCache = new Map<Id, EffectiveFloor[]>()
  /** Door leaf open fraction per door id, and the frame it was last advanced. */
  private readonly doorT = new Map<Id, number>()
  private readonly doorFrame = new Map<Id, number>()
  private frameNo = 0
  private follow: { id: Id; key: string } | null = null

  private quality: Quality
  private qualityFrozen = false
  private readonly adaptive: AdaptiveQuality
  private readonly frameWindow = new FrameTimeWindow(2000)
  private readonly frameListeners = new Set<(s: FrameStats) => void>()
  private lastFrameAt: number | null = null
  private pixelRatio = 1
  private cssSize = { w: 0, h: 0 }
  private sizeDirty = true
  private lastDpr = 0
  private running = false
  private debugPaused = false
  private contextLost = false
  private disposed = false
  private errorLogged = false
  private readonly resizeObserver: ResizeObserver | null
  private readonly cleanups: (() => void)[] = []

  constructor(canvas: HTMLCanvasElement, opts: EngineOptions = {}) {
    this.canvas = canvas
    this.opts = opts
    this.quality = opts.quality ?? "high"
    this.adaptive = new AdaptiveQuality(this.quality)

    // MSAA is a context attribute: fixed at creation (medium/high on, low off).
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: this.quality !== "low",
      alpha: false,
      stencil: false,
      depth: true,
      powerPreference: "high-performance",
    })
    this.configureRenderer()
    this.gpuTimer = new GpuTimer(this.renderer.getContext() as WebGL2RenderingContext)

    this.lighting = createLightingSystem(this.renderer, { quality: this.quality })
    this.tokenInstancedMaterial = this.lighting.createTokenMaterial({ instanced: true })
    this.shared = {
      token: this.lighting.createTokenMaterial({ instanced: false }),
      glass: this.lighting.createOverlayMaterial({ kind: "glass" }),
      flame: this.lighting.createOverlayMaterial({ kind: "flame" }),
      glow: this.lighting.createOverlayMaterial({ kind: "glow" }),
    }
    this.backdrops = new BackdropManager(this.renderer, this.quality, (levelId, texture, rect, opacity, tintWalls) =>
      this.lighting.setLevelBackdrop(levelId, texture, rect, opacity, tintWalls)
    )
    this.configurePost(this.quality)

    this.worldRoot.name = "world"
    this.tokens = new TokenLayer(this.tokenInstancedMaterial)
    this.overlays = new OverlayManager({
      scene: () => this.scene,
      view: () => this.view,
      plan: () => this.plan,
      ground: (id) => this.ground(id),
      objectRefs: (id) => this.objectRefs(id),
      activeLevelId: () => this.activeLevelId(),
      worldPerPixel: () => this.controller.worldPerPixel(),
      worldPerPixelAt: (p) => this.worldPerPixelAt(p),
      fade: () => {
        const t = this.controller.getTarget()
        return { x: t.x, z: t.z, radius: this.controller.viewRadius() }
      },
    })
    this.overlays.root.add(this.tokens.decor)
    this.root.add(this.worldRoot, this.tokens.root, this.overlays.gridRoot, this.overlays.root)

    this.orbit = new OrbitCameraController(canvas)
    this.topdown = new TopDownCameraController(canvas)
    this.topdown.tilt = this.view.tilt
    this.controller = this.orbit
    this.orbit.active = true

    this.picker = new Picker({
      canvas,
      camera: () => this.controller.camera,
      scene: () => this.scene,
      solidLevels: () => [...this.levels.values()].filter((lv) => this.plan.get(lv.id)?.mode === "solid").map((lv) => ({ levelId: lv.id, meshes: lv.pickMeshes() })),
      tokenMeshes: () => this.tokens.pickMeshes(),
      ground: (id) => this.ground(id),
      effectiveFloors: (id) => this.effectiveFloors(id),
    })

    this.resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => (this.sizeDirty = true)) : null
    this.resizeObserver?.observe(canvas)
    this.on(document, "visibilitychange", () => this.syncLoop())
    this.on(canvas, "webglcontextlost", (e) => this.onContextLost(e))
    this.on(canvas, "webglcontextrestored", () => this.onContextRestored())

    this.lighting.setView(this.view)
    this.applySize()
    this.syncLoop()
  }

  private on(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn)
    this.cleanups.push(() => target.removeEventListener(type, fn))
  }

  private configureRenderer(): void {
    const r = this.renderer
    // Fixed output transform: no recompiles when toggling anything later (§4.1). Reinhard is close to
    // linear in the darks (hue-preserving): scenes here are mostly night / dungeon interiors, where
    // Neutral's toe subtracts the smallest channel and turns moonlit grass into saturated primaries,
    // and ACES / AgX shift or wash out the dim colours. Highlights near flames still compress.
    r.outputColorSpace = THREE.SRGBColorSpace
    r.toneMapping = THREE.ReinhardToneMapping
    r.toneMappingExposure = 1
    r.shadowMap.enabled = false
    r.localClippingEnabled = false
    r.sortObjects = true
    // Stats are read and reset once per frame (lighting tile passes render in between).
    r.info.autoReset = false
  }

  // -------------------------------------------------------------------------
  // Scene
  // -------------------------------------------------------------------------

  setScene(scene: SceneLike): void {
    this.scene = scene
    this.previews.clear()
    this.clearCaches()
    this.doorT.clear()
    this.world = buildOcclusionWorld(scene)
    this.rebuildAllLevels(scene)
    this.tokens.syncScene(scene, performance.now(), false)
    this.lighting.setScene(scene, this.world)
    this.backdrops.syncScene(scene)
    this.afterStructure(scene)
  }

  updateScene(scene: SceneLike, change?: SceneChange): void {
    const prev = this.scene
    if (!prev || !this.world) {
      this.setScene(scene)
      return
    }
    const ch = change ?? diffScenes(prev, scene)
    this.scene = scene
    this.clearCaches()
    if (ch.structure) {
      const s = classifyStructure(prev, scene)
      if (s.geometry) {
        // Levels or grid changed: rebuild everything (the occlusion world included).
        this.world = buildOcclusionWorld(scene)
        this.rebuildAllLevels(scene)
        this.tokens.syncScene(scene, performance.now(), true)
        this.lighting.setScene(scene, this.world)
        this.backdrops.syncScene(scene)
        this.afterStructure(scene)
        return
      }
      this.applyBackground(scene)
      this.backdrops.syncScene(scene)
    }
    const dirty: DirtyRegion[] = []
    if (ch.objects && ch.objects.length > 0) dirty.push(...this.world.update(scene, occlusionClosure(prev, scene, ch.objects)))
    for (const levelId of ch.terrain ?? []) {
      if (!Object.hasOwn(scene.levels, levelId)) continue
      const before = Object.hasOwn(prev.levels, levelId) ? prev.levels[levelId].heightmap : null
      const rect = heightmapDiffRect(before, scene.levels[levelId].heightmap, scene.grid) ?? gridRect(scene.grid)
      dirty.push(...this.world.updateTerrain(scene, levelId, rect))
      // A committed brush stroke replaces its preview.
      this.previews.delete(levelId)
      this.samplers.delete(levelId)
    }
    const inv = invalidation(prev, scene, ch)
    const ctx = new BuildContext(scene, this.previews)
    for (const [levelId, kinds] of inv.buckets) {
      const lv = this.levels.get(levelId)
      if (!lv) continue
      for (const kind of kinds) lv.setBucket(kind, buildBucket(ctx, levelId, kind))
    }
    for (const levelId of ch.terrain ?? []) this.overlays.terrainChanged(levelId)
    if ((ch.tokens && ch.tokens.length > 0) || inv.tokens) this.tokens.syncScene(scene, performance.now(), true)
    this.lighting.applyChange(scene, this.world, ch, dirty)
    this.tokens.invalidate()
    this.overlays.sceneChanged()
    this.checkFollow()
  }

  private clearCaches(): void {
    this.samplers.clear()
    this.floorCache.clear()
  }

  private rebuildAllLevels(scene: SceneLike): void {
    for (const [id, lv] of this.levels) {
      if (!Object.hasOwn(scene.levels, id)) {
        lv.dispose()
        this.levels.delete(id)
      }
    }
    const ctx = new BuildContext(scene, this.previews)
    for (const level of sortedLevels(scene)) {
      let lv = this.levels.get(level.id)
      if (!lv) {
        lv = new LevelView(level.id, this.createLevelMaterials(level.id), this.shared)
        this.levels.set(level.id, lv)
        this.worldRoot.add(lv.group)
      }
      const built = buildLevel(ctx, level.id)
      for (const kind of BUCKETS) lv.setBucket(kind, built[kind])
    }
  }

  private createLevelMaterials(levelId: Id): LevelMaterials {
    const make = (variant: "opaque" | "ghost" | "ghost-depth", instanced: boolean) => {
      const m = this.lighting.createWorldMaterial({ levelId, variant, instanced })
      // Ghost passes must sort after all opaques (§4.3): they belong in the transparent list.
      if (variant !== "opaque") m.transparent = true
      return m
    }
    return {
      opaque: make("opaque", false),
      opaqueInstanced: make("opaque", true),
      ghost: make("ghost", false),
      ghostInstanced: make("ghost", true),
      ghostDepth: make("ghost-depth", false),
      ghostDepthInstanced: make("ghost-depth", true),
    }
  }

  /** Shared work after a full (re)build. */
  private afterStructure(scene: SceneLike): void {
    this.applyBackground(scene)
    this.bounds = sceneBounds(scene)
    this.orbit.setBounds(this.bounds)
    this.topdown.setBounds(this.bounds)
    this.replan()
    this.tokens.invalidate()
    this.overlays.sceneChanged()
    if (!this.framed) {
      this.framed = true
      // Frame the active level's footprint (not the whole storey stack, which pushes the camera back
      // until the map is a small island in the middle of the screen).
      const fb = this.frameBounds()
      this.orbit.frame(fb, true)
      this.topdown.frame(fb, true)
      // Both cameras look at the active level's plane.
      const y = this.activeElevation()
      for (const c of [this.orbit, this.topdown]) {
        const t = c.getTarget()
        c.setTarget({ x: t.x, y, z: t.z }, true)
      }
    }
    this.precompile()
    this.checkFollow()
  }

  /**
   * Clear colour: the scene's background, except under player fog of war, where everything not explored
   * is black (SPEC "unexplored (black)"): a player's scene has no geometry there at all, so the clear
   * colour IS the unexplored area.
   */
  private applyBackground(scene: SceneLike): void {
    this.root.background = new THREE.Color(this.view.vision === "fog" ? "#000000" : scene.environment.backgroundColor)
  }

  /**
   * Battlemap image of a level (ARCHITECTURE §9; engine/backdrops.ts). Opacity / tintWalls come from
   * `opts`, else from the level document's `backdrop`, else opaque without wall tint.
   */
  setLevelImage(levelId: Id, image: TexImageSource | null, rect: { x: number; z: number; w: number; d: number } | null, opts?: BackdropOptions): void {
    this.backdrops.set(levelId, image, rect, opts)
  }

  updateLevelImage(levelId: Id, dirty?: { x: number; z: number; w: number; d: number }): void {
    this.backdrops.update(levelId, dirty)
  }

  previewTerrain(levelId: Id, heights: Float32Array | null, dirty: { x: number; z: number; w: number; d: number } | null): void {
    const scene = this.scene
    const lv = this.levels.get(levelId)
    if (!scene || !lv || !Object.hasOwn(scene.levels, levelId)) return
    this.samplers.delete(levelId)
    if (heights === null) {
      if (!this.previews.delete(levelId)) return
      lv.setBucket("floors", buildBucket(new BuildContext(scene, this.previews), levelId, "floors"))
      this.overlays.terrainChanged(levelId)
      return
    }
    const hadPreview = this.previews.has(levelId)
    this.previews.set(levelId, heights)
    const sampler = this.ground(levelId)
    const terrain = lv.terrain()
    if (!terrain || !hadPreview) {
      // First preview frame (or a flat level): build the terrain mesh once, then move it in place.
      lv.setBucket("floors", buildBucket(new BuildContext(scene, this.previews), levelId, "floors"))
      this.overlays.terrainChanged(levelId)
    } else {
      updateTerrainGeometry(terrain.mesh.geometry, terrain.offsets, sampler, dirty)
      this.overlays.terrainPreviewed(levelId, dirty)
    }
  }

  // -------------------------------------------------------------------------
  // View
  // -------------------------------------------------------------------------

  setView(partial: Partial<ViewState>): void {
    const prev = this.view
    const next: ViewState = { ...prev, ...partial }
    next.tilt = Math.min(MAX_TILT, Math.max(0, next.tilt))
    this.view = next
    if (next.camera !== prev.camera) this.switchCamera(next.camera === "topdown" ? this.topdown : this.orbit)
    this.topdown.tilt = next.tilt
    this.topdown.keyboardPan = next.mode !== "editor"
    this.replan()
    if (next.activeLevelId !== prev.activeLevelId && this.scene) {
      // Keep the look-at point on the active level.
      const y = this.activeElevation()
      for (const c of [this.orbit, this.topdown]) {
        const t = c.getTarget()
        c.setTarget({ x: t.x, y, z: t.z }, c !== this.controller)
      }
    }
    if (next.vision !== prev.vision && this.scene) this.applyBackground(this.scene)
    this.tokens.invalidate()
    this.overlays.viewChanged()
    this.lighting.setView(this.view)
  }

  getView(): ViewState {
    return { ...this.view }
  }

  private switchCamera(next: CameraController): void {
    if (next === this.controller) return
    const t = this.controller.getTarget()
    this.controller.active = false
    next.setTarget(t, true)
    next.active = true
    this.controller = next
    this.controller.setViewport(Math.max(1, this.cssSize.w), Math.max(1, this.cssSize.h))
  }

  private replan(): void {
    if (!this.scene) return
    this.plan = computeLevelPlan(sortedLevels(this.scene), this.view)
    for (const [id, lv] of this.levels) {
      const p = this.plan.get(id)
      lv.setMode(p?.mode ?? "hidden")
      lv.setRank(p?.rank ?? 99)
    }
  }

  private activeLevelId(): Id | null {
    return this.scene ? effectiveActiveLevelId(sortedLevels(this.scene), this.view.activeLevelId) : null
  }

  private activeElevation(): number {
    const id = this.activeLevelId()
    return id && this.scene ? this.scene.levels[id].elevation : 0
  }

  setOverlays(overlays: Partial<OverlayState>): void {
    this.overlays.set(overlays)
    this.tokens.invalidate()
    if (overlays.selectedIds !== undefined) this.checkFollow()
  }

  /**
   * Player camera follow: when the selected token's confirmed position changes, glide to it.
   * Selecting a token does not move the camera by itself.
   */
  private checkFollow(): void {
    const scene = this.scene
    if (!scene) return
    const id = this.overlays.current.selectedIds.find((i) => Object.hasOwn(scene.tokens, i))
    if (!id) {
      this.follow = null
      return
    }
    const t = scene.tokens[id]
    const key = `${t.levelId}|${t.position.x}|${t.position.z}`
    if (this.follow && this.follow.id === id && this.follow.key !== key && this.controller === this.topdown && Object.hasOwn(scene.levels, t.levelId)) {
      this.topdown.setTarget({ x: t.position.x, y: tokenGroundY(scene, t), z: t.position.z }, false)
    }
    this.follow = { id, key }
  }

  // -------------------------------------------------------------------------
  // Quality, sizing, frame loop
  // -------------------------------------------------------------------------

  setQuality(q: Quality): void {
    this.adaptive.setCeiling(q)
    // Image resolution follows the ceiling only (adaptive steps never re-upload map images).
    this.backdrops.setQuality(q)
    this.applyQuality(q)
  }

  async benchmarkQuality(): Promise<Quality> {
    const q = await pickInitialQuality({ cssWidth: this.canvas.clientWidth || undefined, cssHeight: this.canvas.clientHeight || undefined })
    if (!this.disposed) this.setQuality(q)
    return q
  }

  private applyQuality(q: Quality): void {
    if (q === this.quality) return
    this.quality = q
    this.lighting.setQuality(q)
    this.configurePost(q)
    this.sizeDirty = true
    // Tier defines / post targets change the programs: compile them again up front.
    this.precompiled = false
    this.precompile()
  }

  /** Post pipeline and emissive parameters of a tier. */
  private configurePost(q: Quality): void {
    const settings = POST_SETTINGS[q]
    if (settings) {
      if (!this.post) this.post = new PostPipeline(this.renderer, settings)
      else this.post.configure(settings)
      const size = this.drawingBufferSize()
      if (size) this.post.setSize(size.x, size.y)
      this.lighting.setRenderParams({ hdr: true, emissive: settings.emissive, glow: settings.glow })
    } else {
      this.post?.dispose()
      this.post = null
      this.lighting.setRenderParams({ hdr: false, emissive: DIRECT_EMISSIVE.emissive, glow: DIRECT_EMISSIVE.glow })
    }
  }

  private drawingBufferSize(): THREE.Vector2 | null {
    const r = this.renderer as Partial<THREE.WebGLRenderer>
    return typeof r.getDrawingBufferSize === "function" ? r.getDrawingBufferSize.call(this.renderer, new THREE.Vector2()) : null
  }

  resize(): void {
    this.applySize()
  }

  private applySize(): void {
    this.sizeDirty = false
    const w = this.canvas.clientWidth
    const h = this.canvas.clientHeight
    if (w <= 0 || h <= 0) return
    const dpr = window.devicePixelRatio || 1
    this.lastDpr = dpr
    const pr = computePixelRatio(w, h, dpr, PIXEL_BUDGET[this.quality], MAX_PIXEL_RATIO[this.quality])
    if (pr !== this.pixelRatio || w !== this.cssSize.w || h !== this.cssSize.h) {
      this.pixelRatio = pr
      this.cssSize = { w, h }
      this.renderer.setPixelRatio(pr)
      this.renderer.setSize(w, h, false)
    }
    if (this.post) {
      const size = this.drawingBufferSize()
      if (size) this.post.setSize(size.x, size.y)
    }
    this.orbit.setViewport(w, h)
    this.topdown.setViewport(w, h)
  }

  /** Start/stop the loop with page visibility and context state. */
  private syncLoop(): void {
    const shouldRun = !this.disposed && !this.contextLost && !this.debugPaused && document.visibilityState !== "hidden"
    if (shouldRun === this.running) return
    this.running = shouldRun
    this.renderer.setAnimationLoop(shouldRun ? this.frame : null)
    // Time spent hidden must not count as a slow frame.
    this.lastFrameAt = null
    this.frameWindow.clear()
    this.adaptive.reset()
  }

  /** Animation-loop callback; `time` is the rAF timestamp (same origin as performance.now()). */
  private readonly frame = (time?: number): void => {
    try {
      this.renderFrame(typeof time === "number" && Number.isFinite(time) ? time : performance.now())
    } catch (err) {
      if (!this.errorLogged) console.error("Atlas render frame failed", err)
      this.errorLogged = true
    }
  }

  private renderFrame(now: number): void {
    const dtMs = this.lastFrameAt === null ? 1000 / 60 : now - this.lastFrameAt
    this.lastFrameAt = now
    const dt = Math.min(0.1, dtMs / 1000)
    this.frameNo++
    if (this.sizeDirty || window.devicePixelRatio !== this.lastDpr) this.applySize()
    this.gpuTimer.poll()
    const cpu0 = performance.now()
    this.gpuTimer.begin()

    this.controller.update(dt)
    this.animateDoors(dt)
    this.tokens.update({ scene: this.scene, plan: this.plan, view: this.view, overlays: this.overlays.current }, now)
    const timeSec = now / 1000
    this.tokens.tick(timeSec)
    for (const lv of this.levels.values()) lv.animateFlames(timeSec, flameFlicker)
    this.overlays.update()

    const camera = this.controller.camera
    const ls = this.lighting.beforeRender(this.renderer, camera, timeSec)
    // Fog-aware grid (explored cells only in player fog mode) and its blending for the target.
    const active = this.activeLevelId()
    this.overlays.grid.bindVision(this.lighting.maskUniforms(), active ? this.lighting.maskLayerOf(active) : -1)
    this.overlays.grid.setHdr(this.post !== null)
    const info = this.renderer.info
    const calls0 = info.render.calls
    const tris0 = info.render.triangles
    this.renderMain(camera, timeSec)
    const drawCalls = info.render.calls - calls0
    const triangles = info.render.triangles - tris0
    info.reset()
    this.gpuTimer.end()
    const cpuMs = performance.now() - cpu0

    // Adaptive quality: real GPU cost when measurable, else the frame interval (steady vsync = headroom).
    if (dtMs < 250) {
      this.frameWindow.push(now, dtMs)
      const gpu = this.gpuTimer.latestMs
      const cost = gpu !== null ? Math.max(cpuMs, gpu) : intervalFrameCost(dtMs, this.frameWindow.percentile(0.5), this.frameWindow.p95())
      const step = this.qualityFrozen ? null : this.adaptive.push(now, cost)
      if (step) this.applyQuality(step)
    }
    if (this.frameListeners.size > 0) {
      const stats: FrameStats = {
        fps: this.frameWindow.fps(),
        frameMs: dtMs,
        frameMsP95: this.frameWindow.p95(),
        drawCalls,
        triangles,
        activeLights: ls.activeLights,
        shadowTilesUpdated: ls.tilesUpdated,
        shadowTilesTotal: ls.tilesTotal,
        shadowUpdateMs: ls.updateMs,
        pixelRatio: this.pixelRatio,
        quality: this.quality,
      }
      for (const cb of this.frameListeners) cb(stats)
    }
  }

  /** World (+ overlays): straight to the canvas, or through the post pipeline with an overlay pass after. */
  private renderMain(camera: THREE.Camera, timeSec: number): void {
    const r = this.renderer
    const post = this.post
    const target = post?.target ?? null
    if (!post || !target) {
      camera.layers.mask = LAYERS_ALL
      r.render(this.root, camera)
      return
    }
    const background = this.root.background
    const auto = r.autoClear
    try {
      camera.layers.mask = LAYERS_WORLD
      r.setRenderTarget(target)
      r.render(this.root, camera)
      post.finish(camera, this.view.vision === "fog", timeSec)
      // Overlays on the composited image: no clear (the background colour would force one).
      camera.layers.mask = LAYERS_OVERLAY
      this.root.background = null
      r.autoClear = false
      r.render(this.root, camera)
    } finally {
      this.root.background = background
      r.autoClear = auto
      camera.layers.mask = LAYERS_ALL
      r.setRenderTarget(null)
    }
  }

  private animateDoors(dt: number): void {
    const scene = this.scene
    if (!scene) return
    for (const lv of this.levels.values()) {
      for (const d of lv.doorLeaves()) {
        const id = d.leaf.doorId
        let t = this.doorT.get(id)
        if (this.doorFrame.get(id) !== this.frameNo) {
          // Advance each door once per frame (double doors have two leaves).
          this.doorFrame.set(id, this.frameNo)
          const door = Object.hasOwn(scene.objects, id) ? scene.objects[id] : undefined
          const target = door && door.type === "door" && door.state === "open" ? 1 : 0
          if (t === undefined) t = target
          else if (t !== target) {
            const step = dt / DOOR_ANIMATION_SECONDS
            t = target > t ? Math.min(target, t + step) : Math.max(target, t - step)
          }
          this.doorT.set(id, t)
        }
        LevelView.applyDoor(d, t ?? 0)
      }
    }
  }

  onFrame(cb: (stats: FrameStats) => void): () => void {
    this.frameListeners.add(cb)
    return () => {
      this.frameListeners.delete(cb)
    }
  }

  // -------------------------------------------------------------------------
  // Context loss
  // -------------------------------------------------------------------------

  private onContextLost(e: Event): void {
    // Allow the browser to restore the context.
    e.preventDefault()
    this.contextLost = true
    this.syncLoop()
    this.gpuTimer.reset()
    this.opts.onContextLost?.()
  }

  private onContextRestored(): void {
    this.contextLost = false
    // three.js re-creates its GL state (and a fresh `info`); GPU resources re-upload lazily. The lighting
    // system resets its own GPU state (atlases, directional maps, mask textures) from its listener; no
    // rebuild here: disposing geometries created in the lost context only makes WebGL warn about
    // deleting objects that no longer exist.
    this.configureRenderer()
    this.gpuTimer = new GpuTimer(this.renderer.getContext() as WebGL2RenderingContext)
    this.backdrops.invalidate()
    this.precompiled = false
    this.precompile()
    this.sizeDirty = true
    this.syncLoop()
    this.opts.onContextLost?.()
  }

  /**
   * Compile every material variant up front (§4.1: no hitches when a level turns into a ghost or a
   * token appears). Uses KHR_parallel_shader_compile through compileAsync when available, else compiles
   * synchronously (materials/util precompileScene).
   */
  private precompile(): void {
    if (this.precompiled || this.levels.size === 0) return
    this.precompiled = true
    const holder = new THREE.Object3D()
    const g = tokenBaseGeometry()
    const lv = this.levels.values().next().value as LevelView
    const add = (m: THREE.Material, instanced: boolean) => {
      if (instanced) {
        const im = new THREE.InstancedMesh(g, m, 1)
        im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3), 3)
        holder.add(im)
      } else holder.add(new THREE.Mesh(g, m))
    }
    const mats = lv.materials
    add(mats.opaque, false)
    add(mats.opaqueInstanced, true)
    add(mats.ghost, false)
    add(mats.ghostInstanced, true)
    add(mats.ghostDepth, false)
    add(mats.ghostDepthInstanced, true)
    add(this.shared.token, false)
    add(this.tokenInstancedMaterial, true)
    add(this.shared.flame, true)
    add(this.shared.glass, false)
    if (this.shared.glow) add(this.shared.glow, true)
    // Programs depend on the target (tone mapping / output transform): compile for the one the main pass uses.
    const r = this.renderer as Partial<THREE.WebGLRenderer>
    const prev = r.getRenderTarget?.call(this.renderer) ?? null
    const target = this.post?.target ?? null
    if (target) r.setRenderTarget?.call(this.renderer, target)
    const done = precompileScene(this.renderer, holder, this.controller.camera, this.root)
    if (target) r.setRenderTarget?.call(this.renderer, prev)
    void done.then(() => {
      for (const c of holder.children) if ((c as THREE.InstancedMesh).isInstancedMesh) (c as THREE.InstancedMesh).dispose()
    })
  }

  // -------------------------------------------------------------------------
  // Picking, camera helpers
  // -------------------------------------------------------------------------

  pick(clientX: number, clientY: number, opts: PickOptions): PickResult {
    return this.picker.pick(clientX, clientY, opts)
  }

  project(p: Vec3): { x: number; y: number; visible: boolean } {
    return this.picker.project(p)
  }

  focus(point: Vec3, opts?: { distance?: number; immediate?: boolean }): void {
    this.controller.focus(point, opts)
  }

  /** Bounds for framing: the grid extent around the active level's ground (a storey tall). */
  private frameBounds(): Bounds3 {
    const y = this.activeElevation()
    const id = this.activeLevelId()
    const h = id && this.scene ? Math.min(this.scene.levels[id].height, 12) : 10
    return { min: { x: this.bounds.min.x, y: y - 1, z: this.bounds.min.z }, max: { x: this.bounds.max.x, y: y + h * 0.6, z: this.bounds.max.z } }
  }

  frameScene(): void {
    this.controller.frame(this.frameBounds())
    // Keep looking at the active level's plane.
    const t = this.controller.getTarget()
    this.controller.setTarget({ x: t.x, y: this.activeElevation(), z: t.z }, false)
  }

  rotateCamera(quarterTurns: number): void {
    this.controller.rotate(quarterTurns)
  }

  /**
   * Dev/automation helper (not part of the Engine contract): render `frames` frames back to back, each
   * synchronised with the GPU through a 1-pixel readPixels, and report wall time per frame (CPU + GPU,
   * shadow/vision tile updates included). Pauses the animation loop meanwhile.
   */
  benchmark(frames = 60): { frames: number; meanMs: number; medianMs: number; p95Ms: number } {
    const gl = this.renderer.getContext()
    const pixel = new Uint8Array(4)
    const wasRunning = this.running
    if (wasRunning) this.renderer.setAnimationLoop(null)
    const times: number[] = []
    try {
      for (let k = 0; k < frames; k++) {
        const t0 = performance.now()
        this.renderFrame(t0)
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        times.push(performance.now() - t0)
      }
    } finally {
      if (wasRunning) this.renderer.setAnimationLoop(this.frame)
      this.lastFrameAt = null
    }
    const sorted = times.slice().sort((a, b) => a - b)
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
    return { frames, meanMs: times.reduce((a, b) => a + b, 0) / Math.max(1, times.length), medianMs: at(0.5), p95Ms: at(0.95) }
  }

  /**
   * Dev/automation helper (not part of the Engine contract): force the shaders' AT_TIER define (0..3)
   * independently of the quality tier, to measure feature costs; null restores the tier's own.
   */
  debugShaderTier(tier: number | null): void {
    const tiers = (this.lighting as { tiers?: { set(t: number): boolean } }).tiers
    tiers?.set(tier ?? { low: 0, medium: 1, high: 2, ultra: 3 }[this.quality])
  }

  /** Dev/automation helper: tweak the current tier's post-processing (tuning; lost on a tier change). */
  debugPostSettings(patch: Partial<PostSettings> & { view?: number }): void {
    if (!this.post) return
    if (patch.view !== undefined) this.post.debugView = patch.view
    const next = { ...this.post.current, ...patch }
    this.post.configure(next)
    const size = this.drawingBufferSize()
    if (size) this.post.setSize(size.x, size.y)
    this.lighting.setRenderParams({ hdr: true, emissive: next.emissive, glow: next.glow })
  }

  /**
   * Dev/automation helper: stop / resume rendering (the page stays live). Headless browsers never hide
   * background tabs, so measurements pause the other tabs' engines to keep the GPU to one renderer.
   */
  debugPause(paused: boolean): void {
    this.debugPaused = paused
    this.syncLoop()
  }

  /** Dev/automation helper: freeze adaptive quality (benchmarks measure one tier). */
  debugFreezeQuality(frozen: boolean): void {
    this.qualityFrozen = frozen
  }

  /** Dev/automation helper (not part of the Engine contract): orbit camera direction, radians. */
  setOrbitAngles(azimuth: number, elevation: number): void {
    this.orbit.setAngles(azimuth, elevation)
  }

  setCameraControlsEnabled(enabled: boolean): void {
    this.orbit.enabled = enabled
    this.topdown.enabled = enabled
  }

  // -------------------------------------------------------------------------
  // Helpers shared with overlays and picking
  // -------------------------------------------------------------------------

  /** Ground sampler of a level (the brush preview lattice while one is active). */
  private ground(levelId: Id): GroundSampler {
    let s = this.samplers.get(levelId)
    if (!s) {
      const scene = this.scene
      const level = scene && Object.hasOwn(scene.levels, levelId) ? scene.levels[levelId] : null
      if (!scene || !level) return new GroundSampler(0, 5, 2, 2, null)
      const preview = this.previews.get(levelId)
      s = (preview && GroundSampler.fromDense(level, scene.grid, preview)) || GroundSampler.forLevel(level, scene.grid)
      this.samplers.set(levelId, s)
    }
    return s
  }

  private effectiveFloors(levelId: Id): EffectiveFloor[] {
    let f = this.floorCache.get(levelId)
    if (!f) {
      f = this.scene ? effectiveFloorRects(this.scene, levelId) : []
      this.floorCache.set(levelId, f)
    }
    return f
  }

  private objectRefs(id: Id): ObjectMeshRef[] {
    const scene = this.scene
    if (!scene || !Object.hasOwn(scene.objects, id)) return []
    const o = scene.objects[id]
    const levelId = o.type === "light" ? lightLevelId(scene, o) : o.levelId
    return this.levels.get(levelId)?.objectRefs(id) ?? []
  }

  private worldPerPixelAt(p: THREE.Vector3): number {
    const cam = this.controller.camera
    if ((cam as THREE.PerspectiveCamera).isPerspectiveCamera) {
      const pc = cam as THREE.PerspectiveCamera
      const d = pc.position.distanceTo(p)
      return (2 * d * Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2)) / Math.max(1, this.cssSize.h)
    }
    return this.controller.worldPerPixel()
  }

  // -------------------------------------------------------------------------

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.syncLoop()
    this.renderer.setAnimationLoop(null)
    this.resizeObserver?.disconnect()
    for (const c of this.cleanups) c()
    this.orbit.dispose()
    this.topdown.dispose()
    for (const lv of this.levels.values()) lv.dispose()
    this.levels.clear()
    this.tokens.dispose()
    this.overlays.dispose()
    this.shared.token.dispose()
    this.shared.glass.dispose()
    this.shared.flame.dispose()
    this.shared.glow?.dispose()
    this.tokenInstancedMaterial.dispose()
    this.backdrops.dispose()
    this.post?.dispose()
    this.post = null
    this.lighting.dispose()
    this.gpuTimer.dispose()
    this.frameListeners.clear()
    this.renderer.dispose()
  }
}
