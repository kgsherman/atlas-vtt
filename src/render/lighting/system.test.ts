/**
 * LightingSystem orchestration against a recording mock renderer (no WebGL in vitest): tile budget and
 * priorities, "never unshadowed", invalidation, hidden lights per vision mode, viewer tiles, quality
 * tiers, static sun map caching, renderer state restoration and uniform packing.
 */
import * as THREE from "three"
import { describe, expect, it } from "vitest"

import type { OccluderPrimitive, OcclusionWorld, OrientedBox } from "@/core/occlusion/types"
import { createLight, createScene, createToken } from "@/core/scene/factory"
import type { LightObject, Scene, Vec3 } from "@/core/scene/types"
import { LAYER } from "../internal"
import { AtlasLightingSystem, DEFAULT_VIEW_STATE, QUALITY_CONFIG } from "./system"
import { LIGHT_VEC4S, VIEWER_VEC4S } from "./uniforms"

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

function setup(lightCount = 7) {
  const scene: Scene = createScene({ width: 40, depth: 40 })
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
    expect(sys.tileOf("viewer:b")).not.toBeNull()
    const sight = calls.filter((c) => c.target === "atlas-viewers-cube")
    expect(sight.length).toBeGreaterThanOrEqual(6)
    expect(sight.every((c) => c.layers === 1 << LAYER.SIGHT)).toBe(true)
    expect(sys.tileOf("viewer:a")).not.toBeNull()
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
    // New atlas: every tile must be recaptured; lights without one are not drawn yet.
    expect(s.tilesUpdated).toBe(4)
    expect(u[10]).toBe(256)
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
