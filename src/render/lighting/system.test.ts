/**
 * LightingSystem orchestration against a recording mock renderer (no WebGL in vitest): tile budget and
 * priorities, "never unshadowed", invalidation, hidden lights per vision mode, viewer tiles, quality
 * tiers, static sun map caching, renderer state restoration and uniform packing.
 */
import * as THREE from "three"
import { describe, expect, it } from "vitest"

import type { Heightfield, OccluderPrimitive, OcclusionWorld, OrientedBox } from "@/core/occlusion/types"
import { createLevel, createLight, createScene, createToken } from "@/core/scene/factory"
import type { LightObject, Scene, Vec3 } from "@/core/scene/types"
import { GroundSampler } from "../builders/ground"
import { LAYER } from "../internal"
import { AtlasLightingSystem, DEFAULT_VIEW_STATE, QUALITY_CONFIG, viewerTouch } from "./system"
import { DARK_VISION_STRIPE_PX, LIGHT_VEC4S, VIEWER_VEC4S } from "./uniforms"

interface RenderCall {
  target: string | null
  scene: string
  layers: number
  override: string | null
  exclude: number | null
}

function mockRenderer() {
  const calls: RenderCall[] = []
  let target: THREE.WebGLRenderTarget | null = null
  let face = 0
  let mip = 0
  const r = {
    isWebGLRenderer: true,
    coordinateSystem: THREE.WebGLCoordinateSystem,
    xr: { enabled: false },
    state: { buffers: { depth: { getReversed: () => false } } },
    autoClear: true,
    autoClearColor: true,
    autoClearDepth: true,
    autoClearStencil: true,
    sortObjects: true,
    getRenderTarget: () => target,
    getActiveCubeFace: () => face,
    getActiveMipmapLevel: () => mip,
    setRenderTarget(t: THREE.WebGLRenderTarget | null, f = 0, m = 0) {
      target = t
      face = f
      mip = m
    },
    clearDepth() {},
    clearColor: new THREE.Color(0, 0, 0),
    clearAlpha: 1,
    getClearColor(target: THREE.Color) {
      return target.copy(r.clearColor)
    },
    getClearAlpha: () => r.clearAlpha,
    getPixelRatio: () => 1,
    setClearColor(c: THREE.Color, a: number) {
      r.clearColor.copy(c)
      r.clearAlpha = a
      calls.push({ target: target?.texture.name ?? null, scene: "setClearColor", layers: 0, override: null, exclude: null })
    },
    render(scene: THREE.Scene, camera: THREE.Camera) {
      const proxy = scene.children.find((o) => (o as THREE.Mesh).isMesh) as THREE.Mesh | undefined
      const mat = proxy?.material as THREE.ShaderMaterial | undefined
      calls.push({
        target: target?.texture.name ?? null,
        scene: scene.name,
        layers: camera.layers.mask,
        override: scene.overrideMaterial?.name ?? null,
        exclude: mat?.uniforms?.uExclude ? (mat.uniforms.uExclude.value as THREE.Vector4).x : null,
      })
    },
  }
  return { renderer: r as unknown as THREE.WebGLRenderer, calls, raw: r }
}

function wall(key: string, x: number, z: number): OrientedBox {
  return {
    key,
    sourceId: key,
    sourceType: "wall",
    levelId: "ground",
    blocks: { movement: true, sight: true, light: true },
    shape: "box",
    center: { x, y: 5, z },
    halfExtents: { x: 5, y: 5, z: 0.25 },
    yaw: 0,
  }
}

function fakeWorld(primitives: OccluderPrimitive[], containing: (p: Vec3) => OccluderPrimitive[] = () => []): OcclusionWorld {
  return {
    version: 1,
    primitives,
    segmentBlocked: () => false,
    raycast: () => null,
    containing: (p) => containing(p),
    queryCircle: () => [],
    queryRect: () => [],
    update: () => [],
    updateTerrain: () => [],
  }
}

/** Frozen clock: the 2 ms CPU cap never triggers, so tile counts are deterministic. */
const fakeClock = () => 0

function setup(lightCount = 7, visionOrigin: Scene["grid"]["visionOrigin"] = "eye") {
  const scene: Scene = createScene({ width: 40, depth: 40 })
  scene.grid.visionOrigin = visionOrigin
  const ground = Object.keys(scene.levels)[0]
  const lights: LightObject[] = []
  for (let k = 0; k < lightCount; k++) {
    const l = createLight(ground, "torch", { x: 20 + k * 20, z: 100 }, { id: `t${k}`, flicker: { enabled: false, speed: 1, amount: 0 } })
    scene.objects[l.id] = l
    lights.push(l)
  }
  const plain = createLight(ground, "magical", { x: 100, z: 60 }, { id: "unshadowed", castsShadows: false })
  const hidden = createLight(ground, "torch", { x: 100, z: 140 }, { id: "hidden", hidden: true })
  const off = createLight(ground, "torch", { x: 60, z: 60 }, { id: "off", on: false })
  for (const l of [plain, hidden, off]) scene.objects[l.id] = l
  const camera = new THREE.OrthographicCamera(-110, 110, 110, -110, 0.5, 1000)
  camera.position.set(100, 300, 100)
  camera.up.set(0, 0, -1)
  camera.lookAt(100, 0, 100)
  camera.updateMatrixWorld(true)
  const world = fakeWorld([wall("w1", 30, 105), wall("w2", 150, 105)])
  const { renderer, calls, raw } = mockRenderer()
  const sys = new AtlasLightingSystem(renderer, "medium", { now: fakeClock })
  sys.setScene(scene, world)
  sys.setView({ ...DEFAULT_VIEW_STATE })
  return { scene, ground, lights, world, renderer, calls, raw, sys, camera }
}

const lightIds = (sys: AtlasLightingSystem, count: number) => {
  // Identify packed lights by their position (x) — ids are not in the uniforms.
  const u = sys.shared.uLights.value
  return Array.from({ length: count }, (_, k) => u[k * LIGHT_VEC4S * 4])
}

describe("AtlasLightingSystem", () => {
  it("publishes the cutaway plane for the cap rule in play views with cutaway, 1e9 otherwise", () => {
    const { scene, ground, world, renderer, camera } = setup()
    const upper = createLevel({ name: "Upper", elevation: 10, floorThickness: 1 })
    const twoStoreys: Scene = { ...scene, levels: { ...scene.levels, [upper.id]: upper } }
    const sys = new AtlasLightingSystem(renderer, "medium", { now: fakeClock })
    sys.setScene(twoStoreys, world)
    const at = (view: Partial<typeof DEFAULT_VIEW_STATE>) => {
      sys.setView({ ...DEFAULT_VIEW_STATE, activeLevelId: ground, ...view })
      sys.beforeRender(renderer, camera, 0)
      return sys.shared.uCutawayY.value
    }
    expect(at({ mode: "editor", cutaway: true })).toBe(1e9)
    expect(at({ mode: "dm-play", cutaway: true })).toBe(9)
    expect(at({ mode: "player", cutaway: true, vision: "fog" })).toBe(9)
    expect(at({ mode: "player", cutaway: false, vision: "fog" })).toBe(1e9)
    // The top storey has nothing above it.
    expect(at({ mode: "dm-play", cutaway: true, activeLevelId: upper.id })).toBe(1e9)
  })

  it("stops at the CPU time cap", () => {
    const { scene, world, renderer, camera } = setup()
    let t = 0
    // Every clock read advances 1.5 ms: the first capture runs, the second exceeds the 2 ms cap.
    const sys = new AtlasLightingSystem(renderer, "medium", { now: () => (t += 1.5) })
    sys.setScene(scene, world)
    sys.setView({ ...DEFAULT_VIEW_STATE })
    expect(sys.beforeRender(renderer, camera, 0).tilesUpdated).toBe(1)
  })

  it("captures at most 4 tiles per frame and never draws shadowed lights without a tile", () => {
    const { sys, renderer, camera, calls } = setup()
    const s1 = sys.beforeRender(renderer, camera, 0)
    // 7 torches + the hidden torch are shadowed (DM "off" mode sees hidden lights); 4 captured.
    expect(s1.tilesUpdated).toBe(4)
    expect(s1.activeLights).toBe(5) // 4 captured + the unshadowed light
    expect(s1.tilesTotal).toBe(4)
    // Each capture = 6 cube faces on the LIGHT layer + 1 re-encode into the atlas.
    expect(calls.filter((c) => c.scene === "atlas-occluder-proxies")).toHaveLength(24)
    expect(calls.filter((c) => c.scene === "atlas-occluder-proxies").every((c) => c.layers === 1 << LAYER.LIGHT)).toBe(true)
    expect(calls.filter((c) => c.target === "atlas-lights-atlas")).toHaveLength(4)
    expect(calls.filter((c) => c.target === "atlas-lights-cube")).toHaveLength(24)

    const s2 = sys.beforeRender(renderer, camera, 0.016)
    expect(s2.tilesUpdated).toBe(4)
    expect(s2.activeLights).toBe(9)
    calls.length = 0
    const s3 = sys.beforeRender(renderer, camera, 0.032)
    expect(s3.tilesUpdated).toBe(0)
    expect(s3.updateMs).toBe(0)
    expect(calls).toHaveLength(0) // nothing to do: no passes, no renderer state touched
    expect(sys.shared.uLightCount.value).toBe(9)
  })

  it("restores renderer state after its passes", () => {
    const { sys, renderer, camera, raw, calls } = setup()
    const rt = new THREE.WebGLRenderTarget(4, 4)
    rt.texture.name = "engine-target"
    raw.setRenderTarget(rt, 0, 0)
    raw.autoClear = true
    raw.sortObjects = true
    sys.beforeRender(renderer, camera, 0)
    expect(raw.getRenderTarget()).toBe(rt)
    expect(raw.autoClear).toBe(true)
    expect(raw.sortObjects).toBe(true)
    // The clear colour is re-applied after the target is restored.
    expect(calls[calls.length - 1]).toMatchObject({ scene: "setClearColor", target: rt.texture.name })
  })

  it("packs lights in the documented layout with tile and capture origin", () => {
    const { sys, renderer, camera, lights } = setup(1)
    sys.beforeRender(renderer, camera, 0)
    const u = sys.shared.uLights.value
    const count = sys.shared.uLightCount.value
    const xs = lightIds(sys, count)
    const k = xs.indexOf(lights[0].position.x)
    expect(k).toBeGreaterThanOrEqual(0)
    const o = k * LIGHT_VEC4S * 4
    expect(u[o + 1]).toBeCloseTo(5, 6) // torch 5 ft above flat ground
    expect(u[o + 3]).toBe(40) // dim
    expect(u[o + 7]).toBe(20) // bright
    expect(u[o + 10]).toBe(QUALITY_CONFIG.medium.lightAtlas.tileSize)
    expect(u[o + 11]).toBe(QUALITY_CONFIG.medium.widePcfLights > 0 ? 1 : 0) // medium: the strongest lights get wide PCF
    expect([u[o + 12], u[o + 13], u[o + 14]]).toEqual([lights[0].position.x, 5, lights[0].position.z])
    // Radiance = linear colour × intensity (flicker off).
    expect(u[o + 4]).toBeCloseTo(1 * 1.4, 4)
  })

  it("recaptures only tiles whose sphere meets a dirty region, and moved lights", () => {
    const { sys, renderer, camera, scene, world, lights } = setup()
    for (let k = 0; k < 3; k++) sys.beforeRender(renderer, camera, k)
    // A door toggles next to torch t0 (x = 20): only lights within 40 ft of x ∈ [18, 22] are dirty.
    sys.applyChange(scene, world, { objects: ["door"] }, [{ levelId: "ground", min: { x: 18, y: 0, z: 100 }, max: { x: 22, y: 7, z: 100.2 } }])
    expect(sys.tileOf("light:t0")?.dirty).toBe(true)
    expect(sys.tileOf("light:t1")?.dirty).toBe(true) // x = 40
    expect(sys.tileOf("light:t2")?.dirty).toBe(true) // x = 60, 38 ft away
    expect(sys.tileOf("light:t3")?.dirty).toBe(false) // x = 80
    const s = sys.beforeRender(renderer, camera, 4)
    expect(s.tilesUpdated).toBe(3)
    // Stale tiles keep drawing until refreshed (light count unchanged during the update).
    expect(s.activeLights).toBe(9)

    // Move t3: recaptured from its new position.
    const moved = { ...lights[3], position: { ...lights[3].position, x: 85 } }
    scene.objects = { ...scene.objects, [moved.id]: moved }
    sys.applyChange(scene, world, { objects: [moved.id] }, [])
    const s2 = sys.beforeRender(renderer, camera, 5)
    expect(s2.tilesUpdated).toBe(1)
    expect(sys.tileOf("light:t3")?.origin.x).toBe(85)
  })

  it("excludes primitives containing the source from its capture", () => {
    const { scene, renderer, camera, calls } = setup(1)
    const box = wall("sconce", 20, 100)
    const world = fakeWorld([box], (p) => (Math.abs(p.x - 20) < 1 && Math.abs(p.z - 100) < 1 ? [box] : []))
    const sys = new AtlasLightingSystem(renderer, "medium", { now: fakeClock })
    sys.setScene(scene, world)
    sys.setView({ ...DEFAULT_VIEW_STATE })
    calls.length = 0
    sys.beforeRender(renderer, camera, 0)
    const cube = calls.filter((c) => c.target === "atlas-lights-cube")
    // t0 sits inside the sconce (its 6 faces exclude it); the fixture's hidden torch excludes nothing.
    expect(cube.filter((c) => c.exclude === sys.proxies.keyId("sconce"))).toHaveLength(6)
    expect(cube.filter((c) => c.exclude === -1)).toHaveLength(6)
  })

  it("hides hidden lights in fog / preview modes", () => {
    const { sys, renderer, camera } = setup()
    for (let k = 0; k < 3; k++) sys.beforeRender(renderer, camera, k)
    expect(sys.shared.uLightCount.value).toBe(9)
    sys.setView({ ...DEFAULT_VIEW_STATE, vision: "preview" })
    sys.beforeRender(renderer, camera, 4)
    expect(sys.shared.uLightCount.value).toBe(8)
    expect(sys.shared.uVisionMode.value).toBe(2)
  })

  it("enables DM dark vision only with vision off outside player mode, stripes scaled by pixel ratio", () => {
    const { sys, renderer, camera, raw } = setup()
    const dv = () => sys.shared.uDarkVision.value
    sys.setView({ ...DEFAULT_VIEW_STATE, darkVision: true })
    expect(dv().x).toBe(1)
    sys.setView({ ...DEFAULT_VIEW_STATE, darkVision: true, mode: "dm-play", vision: "preview" })
    expect(dv().x).toBe(0)
    sys.setView({ ...DEFAULT_VIEW_STATE, darkVision: true, mode: "player" })
    expect(dv().x).toBe(0)
    sys.setView({ ...DEFAULT_VIEW_STATE })
    expect(dv().x).toBe(0)
    raw.getPixelRatio = () => 2
    sys.beforeRender(renderer, camera, 0)
    expect(dv().y).toBe(DARK_VISION_STRIPE_PX * 2)
  })

  it("captures viewer LOS tiles on the SIGHT layer, forcing the primary viewer over budget", () => {
    const { sys, renderer, camera, scene, ground, world, calls } = setup()
    const a = createToken(ground, { x: 102.5, z: 102.5 }, { id: "a" })
    const b = createToken(ground, { x: 52.5, z: 102.5 }, { id: "b", vision: { darkvision: 60, blindsight: 0, blind: false } })
    scene.tokens = { a, b }
    sys.applyChange(scene, world, { tokens: ["a", "b"] }, [])
    sys.setView({ ...DEFAULT_VIEW_STATE, mode: "dm-play", vision: "preview", viewerTokenIds: ["a", "b"], gpuVisionRefine: true })
    calls.length = 0
    const s = sys.beforeRender(renderer, camera, 0)
    // Forced primary viewer first, then new sources by coverage (viewer b, 2 torches): 4 tiles.
    expect(s.tilesUpdated).toBe(4)
    expect(sys.tileOf("viewer:b:0")).not.toBeNull()
    const sight = calls.filter((c) => c.target === "atlas-viewers-cube")
    expect(sight.length).toBeGreaterThanOrEqual(6)
    expect(sight.every((c) => c.layers === 1 << LAYER.SIGHT)).toBe(true)
    expect(sys.tileOf("viewer:a:0")).not.toBeNull()
    expect(sys.shared.uViewerCount.value).toBe(2)
    expect(sys.shared.uGpuRefine.value).toBe(1)
    const v = sys.shared.uViewers.value
    expect(v[0]).toBe(102.5)
    expect(v[2]).toBe(102.5)
    expect(v[1]).toBeGreaterThan(0)
    expect(v[1]).toBeLessThanOrEqual(5.5 + 1e-6)
    expect(v[6]).toBe(QUALITY_CONFIG.medium.viewerAtlas!.tileSize)
    expect(v[VIEWER_VEC4S * 4 + 3]).toBe(60) // viewer b darkvision
    // Low tier: no GPU refinement.
    sys.setQuality("low")
    sys.beforeRender(renderer, camera, 1)
    expect(sys.shared.uGpuRefine.value).toBe(0)
    expect(sys.viewerAtlasTexture).toBeNull()
    expect(sys.shared.uViewers.value[6]).toBe(0)
  })

  it("builds the per-cell slot mask from the packed slots and rebuilds it only when they change", () => {
    const { sys, renderer, camera } = setup(4)
    // No slots yet: the placeholder (every bit set, grid off).
    expect(sys.shared.uLightMaskGrid.value.w).toBe(0)
    for (let k = 0; k < 3; k++) sys.beforeRender(renderer, camera, k)
    const grid = sys.shared.uLightMaskGrid.value
    expect(grid.w).toBe(1)
    const tex = sys.shared.uLightMask.value as THREE.DataTexture
    const version = tex.version
    const data = tex.image.data as Uint32Array
    const w = tex.image.width
    const u = sys.shared.uLights.value
    const count = sys.shared.uLightCount.value
    expect(count).toBeGreaterThan(0)
    for (let k = 0; k < count; k++) {
      // Each slot's own position lies in a cell carrying its bit.
      const x = u[k * LIGHT_VEC4S * 4]
      const z = u[k * LIGHT_VEC4S * 4 + 2]
      const i = Math.floor((x - grid.x) * grid.z)
      const j = Math.floor((z - grid.y) * grid.z)
      expect((data[j * w + i] >>> k) & 1).toBe(1)
    }
    sys.beforeRender(renderer, camera, 3)
    expect(sys.shared.uLightMask.value).toBe(tex)
    expect(tex.version).toBe(version)
  })

  it("packs each viewer's touch square and skips per-pixel perception removal beyond MAX_VIEWERS", () => {
    const { sys, renderer, camera, scene, ground, world } = setup()
    const small = createToken(ground, { x: 102.5, z: 102.5 }, { id: "small" })
    // Off-grid large token: its footprint (10 ft) overlaps a 3×3 block of cells.
    const large = createToken(ground, { x: 51, z: 101 }, { id: "large", size: "large" })
    scene.tokens = { small, large }
    sys.applyChange(scene, world, { tokens: ["small", "large"] }, [])
    sys.setView({ ...DEFAULT_VIEW_STATE, mode: "player", vision: "fog", viewerTokenIds: ["small", "large"], gpuVisionRefine: true })
    sys.beforeRender(renderer, camera, 0)
    const t = sys.shared.uTouch.value
    expect(sys.shared.uTouchCount.value).toBe(2)
    expect(Array.from(t.subarray(0, 3))).toEqual([102.5, 102.5, 2.5]) // centred medium token: its own cell
    expect(t[4]).toBe(51)
    expect(t[5]).toBe(101)
    expect(t[6]).toBeCloseTo(9) // cells x ∈ [45, 60), z ∈ [95, 110) around (51, 101)
    expect(viewerTouch(scene, large, { x: 51, y: 5, z: 101 })).toBeCloseTo(9)
    expect(sys.shared.uViewersAll.value).toBe(1)
    expect(sys.shared.uGpuRefine.value).toBe(1)
    // Nine viewers: the ninth has no slot, so GPU line of sight and the senses' range cut are off.
    const ids: string[] = []
    const tokens: Scene["tokens"] = {}
    for (let k = 0; k < 9; k++) {
      const t = createToken(ground, { x: 12.5 + k * 20, z: 12.5 }, { id: `v${k}` })
      tokens[t.id] = t
      ids.push(t.id)
    }
    scene.tokens = tokens
    sys.applyChange(scene, world, { tokens: ids }, [])
    sys.setView({ ...DEFAULT_VIEW_STATE, mode: "player", vision: "fog", viewerTokenIds: ids, gpuVisionRefine: true })
    sys.beforeRender(renderer, camera, 1)
    expect(sys.shared.uViewerCount.value).toBe(8)
    expect(sys.shared.uViewersAll.value).toBe(0)
    expect(sys.shared.uGpuRefine.value).toBe(0)
    sys.setView({ ...DEFAULT_VIEW_STATE, mode: "player", vision: "fog", viewerTokenIds: ids.slice(0, 8), gpuVisionRefine: true })
    sys.beforeRender(renderer, camera, 2)
    expect(sys.shared.uViewersAll.value).toBe(1)
    expect(sys.shared.uGpuRefine.value).toBe(1)
  })

  it("sight from the square: one slot and tile per eye (the eye, then the footprint's corners)", () => {
    const { sys, renderer, camera, scene, ground, world } = setup(0, "square")
    const a = createToken(ground, { x: 102.5, z: 102.5 }, { id: "a", vision: { darkvision: 60, blindsight: 0, blind: false } })
    const b = createToken(ground, { x: 52.5, z: 42.5 }, { id: "b" })
    scene.tokens = { a, b }
    sys.applyChange(scene, world, { tokens: ["a", "b"] }, [])
    sys.setView({ ...DEFAULT_VIEW_STATE, mode: "player", vision: "fog", viewerTokenIds: ["a", "b"], gpuVisionRefine: true })
    for (let k = 0; k < 4; k++) sys.beforeRender(renderer, camera, k)
    expect(sys.shared.uViewerCount.value).toBe(10)
    expect(sys.shared.uTouchCount.value).toBe(2)
    expect(sys.shared.uViewersAll.value).toBe(1)
    const v = sys.shared.uViewers.value
    const eyes = Array.from({ length: 10 }, (_, k) => [v[k * 12], v[k * 12 + 2], v[k * 12 + 3]])
    expect(eyes.slice(0, 5)).toEqual([
      [102.5, 102.5, 60],
      [100.5, 100.5, 60],
      [104.5, 100.5, 60],
      [100.5, 104.5, 60],
      [104.5, 104.5, 60],
    ])
    expect(eyes[5]).toEqual([52.5, 42.5, 0])
    for (let k = 0; k < 5; k++) {
      expect(sys.tileOf(`viewer:a:${k}`)?.origin).toMatchObject({ x: eyes[k][0], z: eyes[k][1] })
      expect(v[k * 12 + 6]).toBe(QUALITY_CONFIG.medium.viewerAtlas!.tileSize)
    }
    // Nine square viewers need 45 eye slots: the ninth is left out and refinement stops.
    const ids: string[] = []
    const tokens: Scene["tokens"] = {}
    for (let k = 0; k < 9; k++) {
      const t = createToken(ground, { x: 12.5 + k * 20, z: 12.5 }, { id: `v${k}` })
      tokens[t.id] = t
      ids.push(t.id)
    }
    scene.tokens = tokens
    sys.applyChange(scene, world, { tokens: ids }, [])
    sys.setView({ ...DEFAULT_VIEW_STATE, mode: "player", vision: "fog", viewerTokenIds: ids, gpuVisionRefine: true })
    sys.beforeRender(renderer, camera, 9)
    expect(sys.shared.uViewerCount.value).toBe(40)
    expect(sys.shared.uViewersAll.value).toBe(0)
  })

  it("draws grid fog when the view asks for it, and always on the low tier (no GPU line of sight)", () => {
    const { sys } = setup(0)
    const grid = () => sys.shared.uFogGrid.value
    sys.setView({ ...DEFAULT_VIEW_STATE, mode: "player", vision: "fog" })
    expect(sys.fogStyle).toBe("smooth")
    expect(grid()).toBe(0)
    sys.setView({ ...DEFAULT_VIEW_STATE, mode: "player", vision: "fog", fogStyle: "grid" })
    expect(grid()).toBe(1)
    sys.setView({ ...DEFAULT_VIEW_STATE, mode: "player", vision: "fog", fogStyle: "smooth" })
    sys.setQuality("low")
    expect(sys.fogStyle).toBe("grid")
    expect(grid()).toBe(1)
    sys.setQuality("high")
    expect(grid()).toBe(0)
  })

  it("switches atlas resolution and wide PCF with the quality tier", () => {
    const { sys, renderer, camera } = setup(5)
    sys.setQuality("high")
    for (let k = 0; k < 3; k++) sys.beforeRender(renderer, camera, k)
    const u = sys.shared.uLights.value
    const count = sys.shared.uLightCount.value
    let wide = 0
    let shadowed = 0
    for (let k = 0; k < count; k++) {
      if (u[k * 16 + 11] === 1) wide++
      if (u[k * 16 + 10] > 0) shadowed++
    }
    // High: every shadowed light in a slot (up to widePcfLights); unshadowed lights have no tile to filter.
    expect(wide).toBe(Math.min(shadowed, QUALITY_CONFIG.high.widePcfLights))
    expect(wide).toBeGreaterThan(0)
    sys.setQuality("low")
    expect(sys.shared.uLightCount.value).toBe(count) // previous frame's list until the next beforeRender
    const s = sys.beforeRender(renderer, camera, 4)
    // New atlas: every tile must be recaptured, all at once in the first frame (no lights popping back
    // in 4 per frame); the frame after is back to the normal budget.
    expect(s.tilesUpdated).toBe(shadowed)
    expect(shadowed).toBeGreaterThan(4)
    let drawn = 0
    for (let k = 0; k < sys.shared.uLightCount.value; k++) if (u[k * 16 + 10] > 0) drawn++
    expect(drawn).toBe(shadowed)
    expect(u[10]).toBe(256)
    expect(sys.beforeRender(renderer, camera, 5).tilesUpdated).toBeLessThanOrEqual(4)
  })

  it("prepares an adaptive tier in unbound atlases and commits it without dropping a light", () => {
    const { sys, renderer, camera, calls } = setup(7)
    for (let k = 0; k < 4; k++) sys.beforeRender(renderer, camera, k)
    const u = sys.shared.uLights.value
    const shadowedNow = () => {
      let n = 0
      for (let k = 0; k < sys.shared.uLightCount.value; k++) if (u[k * 16 + 10] > 0) n++
      return n
    }
    const count = sys.shared.uLightCount.value
    const shadowed = shadowedNow()
    expect(shadowed).toBeGreaterThan(4)
    const bound = sys.shared.uLightAtlas.value
    sys.prepareQuality("low")
    expect(sys.qualityReady("low")).toBe(false)
    expect(sys.qualityReady("medium")).toBe(true)
    // Filling runs under its own budget (4 tiles per frame) while the medium atlas stays bound and drawn.
    let frames = 0
    for (let k = 4; !sys.qualityReady("low") && k < 20; k++, frames++) {
      calls.length = 0
      sys.beforeRender(renderer, camera, k)
      expect(sys.shared.uLightAtlas.value).toBe(bound)
      expect(shadowedNow()).toBe(shadowed)
      expect(u[10]).toBe(512)
      expect(calls.filter((c) => c.target === "atlas-lights-atlas").length).toBeLessThanOrEqual(4)
    }
    expect(sys.qualityReady("low")).toBe(true)
    expect(frames).toBe(Math.ceil(shadowed / 4))
    // Commit: the prepared atlas is swapped in; the first frame at low draws every light, with no burst.
    sys.setQuality("low")
    const s = sys.beforeRender(renderer, camera, 30)
    expect(sys.shared.uLightCount.value).toBe(count)
    expect(shadowedNow()).toBe(shadowed)
    expect(u[10]).toBe(256)
    expect(s.tilesUpdated).toBe(0)
  })

  it("keeps every light when an ultra → high step is prepared (lo tiles for the hi-res lights)", () => {
    const { sys, renderer, camera } = setup(5)
    sys.setQuality("ultra")
    for (let k = 0; k < 6; k++) sys.beforeRender(renderer, camera, k)
    const u = sys.shared.uLights.value
    const lights = () => {
      const out: number[] = []
      for (let k = 0; k < sys.shared.uLightCount.value; k++) if (u[k * 16 + 10] > 0) out.push(u[k * 16])
      return out.sort((a, b) => a - b)
    }
    const before = lights()
    expect(before.length).toBeGreaterThan(0)
    sys.prepareQuality("high")
    for (let k = 6; !sys.qualityReady("high") && k < 30; k++) {
      sys.beforeRender(renderer, camera, k)
      expect(lights()).toEqual(before)
    }
    expect(sys.qualityReady("high")).toBe(true)
    sys.setQuality("high")
    const s = sys.beforeRender(renderer, camera, 40)
    expect(lights()).toEqual(before)
    for (let k = 0; k < sys.shared.uLightCount.value; k++) expect(u[k * 16 + 11] & 6).toBe(0)
    expect(s.tilesUpdated).toBe(0)
  })

  it("drops a prepared tier when the current one is prepared again, and refills it after occluder changes", () => {
    const { sys, renderer, camera, scene, world } = setup(3)
    for (let k = 0; k < 3; k++) sys.beforeRender(renderer, camera, k)
    sys.prepareQuality("low")
    for (let k = 3; k < 8; k++) sys.beforeRender(renderer, camera, k)
    expect(sys.qualityReady("low")).toBe(true)
    // A wall edit dirties the prepared captures as well (stale captures still count as ready).
    sys.applyChange(scene, world, { objects: ["w1"] }, [{ levelId: "ground", min: { x: 0, y: 0, z: 90 }, max: { x: 200, y: 20, z: 120 } }])
    const s = sys.beforeRender(renderer, camera, 8)
    expect(s.tilesUpdated).toBeGreaterThan(4) // live tiles (4) plus prepared ones
    sys.prepareQuality("medium")
    expect(sys.qualityReady("low")).toBe(false)
    // Unprepared commit: re-allocates and recaptures in one burst.
    sys.setQuality("low")
    expect(sys.beforeRender(renderer, camera, 9).tilesUpdated).toBeGreaterThan(0)
  })

  it("gives the highest-ranked lights hi-res tiles and soft shadows on ultra", () => {
    const { sys, renderer, camera } = setup(5)
    sys.setQuality("ultra")
    for (let k = 0; k < 4; k++) sys.beforeRender(renderer, camera, k)
    const u = sys.shared.uLights.value
    const count = sys.shared.uLightCount.value
    let hi = 0
    for (let k = 0; k < count; k++) {
      const flags = u[k * 16 + 11]
      if (u[k * 16 + 10] === 0) continue // unshadowed
      expect(flags & 2).toBe(2)
      expect(flags & 4).toBe(4)
      expect(u[k * 16 + 10]).toBe(QUALITY_CONFIG.ultra.hiAtlas!.tileSize)
      // Torch source radius for the penumbra.
      expect(u[k * 16 + 15]).toBeCloseTo(0.5)
      hi++
    }
    expect(hi).toBeGreaterThan(0)
    expect(hi).toBeLessThanOrEqual(QUALITY_CONFIG.ultra.hiLights)
    // The DM (vision off) also sees the hidden torch.
    const hiTiles = ["t0", "t1", "t2", "t3", "t4", "hidden"].map((id) => sys.tileOf(`hi:light:${id}`)).filter((t) => t !== null)
    expect(hiTiles.length).toBe(hi)
    for (const t of hiTiles) expect(t.size).toBe(1024)
    // Back to high: no hi-res atlas, hard shadows, every light recaptured in the 512² atlas.
    sys.setQuality("high")
    for (let k = 4; k < 8; k++) sys.beforeRender(renderer, camera, k)
    for (let k = 0; k < sys.shared.uLightCount.value; k++) expect(u[k * 16 + 11] & 6).toBe(0)
  })

  it("renders the static sun map once and again only after occluder changes", () => {
    const { sys, renderer, camera, scene, world, calls } = setup(1)
    scene.environment = { ...scene.environment, directional: { ...scene.environment.directional, enabled: true } }
    sys.applyChange(scene, world, { structure: true }, [])
    calls.length = 0
    sys.beforeRender(renderer, camera, 0)
    const sunPasses = () => calls.filter((c) => c.target === "atlas-sun" && c.override === "atlas-occluder-depth")
    expect(sunPasses()).toHaveLength(1)
    expect(sys.shared.uSunColor.value.r).toBeGreaterThan(0)
    expect(sys.shared.uSunShadow.value).not.toBeNull()
    sys.beforeRender(renderer, camera, 1)
    expect(sunPasses()).toHaveLength(1)
    sys.applyChange(scene, world, { objects: ["w1"] }, [{ levelId: "ground", min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } }])
    sys.beforeRender(renderer, camera, 2)
    expect(sunPasses()).toHaveLength(2)
  })

  it("keeps the terrain occluders, nearby tiles and the sun / sky maps in step with a terrain preview", () => {
    const { sys, renderer, camera, scene, ground, calls } = setup(5)
    scene.environment = { ...scene.environment, directional: { ...scene.environment.directional, enabled: true } }
    // A floor on terrain under the torches (x 0..120, z 80..120, 2.5 ft lattice), flat at 0.
    const floor: Heightfield = {
      key: "floor",
      sourceId: "floor",
      sourceType: "terrain",
      levelId: ground,
      blocks: { movement: true, sight: true, light: true },
      shape: "heightfield",
      originX: 0,
      originZ: 80,
      spacing: 2.5,
      samplesX: 49,
      samplesZ: 17,
      heights: new Float32Array(49 * 17),
      solid: new Uint8Array(48 * 16).fill(1),
      thickness: 1,
    }
    const world = fakeWorld([wall("w1", 30, 105), floor])
    sys.setScene(scene, world)
    for (let k = 0; k < 3; k++) sys.beforeRender(renderer, camera, k)
    const sunPasses = () => calls.filter((c) => c.target === "atlas-sun").length
    const suns = sunPasses()
    const floorMeshes = () => sys.proxies.scene.children.filter((o) => o.name.startsWith("occluders:floor@")) as THREE.Mesh[]
    const lowest = () => Math.min(...floorMeshes().map((m) => m.geometry.boundingBox!.min.y))
    expect(lowest()).toBe(-1)
    expect(floorMeshes().every((m) => (m.layers.mask & (1 << LAYER.LIGHT)) !== 0)).toBe(true)

    // The DM drags a 3 ft pit under torch t0 (x = 20): the preview lattice (grid 200 ft, 2.5 ft spacing).
    const n = 81
    const heights = new Float32Array(n * n)
    for (let sz = 38; sz <= 42; sz++) for (let sx = 6; sx <= 10; sx++) heights[sz * n + sx] = -3
    const preview = new GroundSampler(0, 2.5, n, n, heights)
    sys.previewTerrain(ground, preview, { x: 15, z: 95, w: 10, d: 10 })
    // The LIGHT / SIGHT occluders are the previewed terrain (the committed floor would shade the pit)...
    expect(lowest()).toBe(-4)
    // ...the tiles that can see the change are recaptured, the far ones kept...
    expect(sys.tileOf("light:t0")?.dirty).toBe(true)
    expect(sys.tileOf("light:t4")?.dirty).toBe(false) // x = 100
    // ...and the sun map is rendered again from them.
    sys.beforeRender(renderer, camera, 3)
    expect(sunPasses()).toBe(suns + 1)
    expect(sys.tileOf("light:t0")?.dirty).toBe(false)

    // Cancelled (Esc): back to the document's terrain, invalidated the same way.
    sys.previewTerrain(ground, null, null)
    expect(lowest()).toBe(-1)
    expect(sys.tileOf("light:t0")?.dirty).toBe(true)
    sys.beforeRender(renderer, camera, 4)
    expect(sunPasses()).toBe(suns + 2)
    // Nothing previewed: nothing to do.
    sys.previewTerrain(ground, null, null)
    sys.beforeRender(renderer, camera, 5)
    expect(sunPasses()).toBe(suns + 2)

    // A committed terrain change of the level ends its preview even when the world's floor is unchanged
    // (a refused or no-op commit).
    sys.previewTerrain(ground, preview, null)
    expect(lowest()).toBe(-4)
    sys.applyChange(scene, world, { terrain: [ground] }, [])
    expect(lowest()).toBe(-1)
    expect(sys.proxies.previewedLevels).toEqual([])
  })

  it("stands the lights and viewer eyes of a previewed level on the previewed ground until it ends", () => {
    const { sys, renderer, camera, scene, ground, world } = setup(5)
    const viewer = createToken(ground, { x: 22.5, z: 102.5 }, { id: "v" })
    scene.tokens = { v: viewer }
    sys.applyChange(scene, world, { tokens: ["v"] }, [])
    sys.setView({ ...DEFAULT_VIEW_STATE, mode: "dm-play", vision: "preview", viewerTokenIds: ["v"], gpuVisionRefine: true })
    const u = sys.shared.uLights.value
    /** Packed position y and capture origin y of the torch at `x`, after a few frames (tiles captured). */
    let frame = 0
    const torch = (x: number) => {
      for (let k = 0; k < 4; k++) sys.beforeRender(renderer, camera, frame++)
      const o = lightIds(sys, sys.shared.uLightCount.value).indexOf(x) * LIGHT_VEC4S * 4
      expect(o).toBeGreaterThanOrEqual(0)
      return { y: u[o + 1], capture: u[o + 13] }
    }
    const eyeY = () => sys.shared.uViewers.value[1]
    expect(torch(20)).toEqual({ y: 5, capture: 5 })
    expect(eyeY()).toBeCloseTo(viewer.eyeHeight, 6)
    // The DM drags a 7.5 ft block over torch t0 (x 20) and the viewer: they stand on it, as the occluders
    // do (inside the previewed block the torch would light nothing and the viewer see nothing).
    const n = 81
    const heights = new Float32Array(n * n)
    for (let sz = 38; sz <= 42; sz++) for (let sx = 6; sx <= 10; sx++) heights[sz * n + sx] = 7.5
    sys.previewTerrain(ground, new GroundSampler(0, 2.5, n, n, heights), { x: 15, z: 95, w: 10, d: 10 })
    expect(torch(20)).toEqual({ y: 12.5, capture: 12.5 })
    expect(torch(40).y).toBe(5)
    expect(eyeY()).toBeCloseTo(7.5 + viewer.eyeHeight, 6)
    expect(sys.tileOf("viewer:v:0")?.origin.y).toBeCloseTo(7.5 + viewer.eyeHeight, 6)
    // Cancelled: back on the document's ground.
    sys.previewTerrain(ground, null, null)
    expect(torch(20)).toEqual({ y: 5, capture: 5 })
    expect(eyeY()).toBeCloseTo(viewer.eyeHeight, 6)
    // Committed (here: the document unchanged): the document's ground too.
    sys.previewTerrain(ground, new GroundSampler(0, 2.5, n, n, heights), null)
    expect(torch(20).y).toBe(12.5)
    sys.applyChange(scene, world, { terrain: [ground] }, [])
    expect(torch(20).y).toBe(5)
    expect(eyeY()).toBeCloseTo(viewer.eyeHeight, 6)
  })

  it("keeps world materials attached to per-level mask layers", () => {
    const { sys, scene, ground } = setup(1)
    const m = sys.createWorldMaterial({ levelId: ground, variant: "opaque", instanced: false })
    expect(m.uniforms.uLevelLayer.value).toBe(-1)
    sys.setView({ ...DEFAULT_VIEW_STATE, mode: "player", vision: "fog", hostMasks: {} })
    expect(m.uniforms.uLevelLayer.value).toBe(0)
    expect(sys.shared.uMasks.value).not.toBeNull()
    expect(sys.shared.uSkyParams.value.w).toBe(0) // no sky exposure in fog mode
    expect(scene.levels[ground]).toBeDefined()
    const t = sys.createTokenMaterial({ instanced: false })
    expect(t.uniforms.uLights).toBe(sys.shared.uLights)
  })
})
