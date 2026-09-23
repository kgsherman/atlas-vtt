// @vitest-environment jsdom
/**
 * Engine integration without WebGL: three's WebGLRenderer and the lighting system are replaced by
 * recording fakes; everything else (builders, occlusion world, cameras, overlays, picking) is real.
 */
import * as THREE from "three"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { createDoor, createFloor, createLevel, createLight, createProp, createScene, createToken, createWall } from "@/core/scene/factory"
import { denseHeights, createHeightmap } from "@/core/scene/heightmap"
import type { DoorObject, Scene } from "@/core/scene/types"

import type { FrameStats, SceneChange } from "../contracts"

const calls = vi.hoisted(() => ({
  setScene: 0,
  applyChange: [] as { change: SceneChange; dirty: unknown[] }[],
  setView: [] as { mode: string; activeLevelId: string | null }[],
  setQuality: [] as string[],
  beforeRender: 0,
  backdrops: [] as { levelId: string; texture: unknown; opacity: number; tintWalls: boolean }[],
  renderParams: [] as { hdr: boolean; emissive: number; glow: number }[],
  renders: [] as { target: unknown; layers: number; background: unknown }[],
  renderer: null as null | { loop: ((t: number) => void) | null; size: number[]; pixelRatio: number; params: Record<string, unknown>; contextLost: number },
}))

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>()
  class FakeRenderer {
    domElement: HTMLCanvasElement
    info = {
      autoReset: true,
      render: { calls: 0, triangles: 0 },
      reset() {
        this.render.calls = 0
        this.render.triangles = 0
      },
    }
    shadowMap = { enabled: false }
    outputColorSpace = ""
    toneMapping = 0
    toneMappingExposure = 1
    localClippingEnabled = false
    sortObjects = true
    loop: ((t: number) => void) | null = null
    pixelRatio = 1
    size = [0, 0]
    autoClear = true
    target: unknown = null
    params: Record<string, unknown>
    contextLost = 0
    constructor(p: { canvas: HTMLCanvasElement }) {
      this.domElement = p.canvas
      this.params = { ...p }
      calls.renderer = this
    }
    forceContextLoss() {
      this.contextLost++
    }
    getContext() {
      return { getExtension: () => null }
    }
    setAnimationLoop(cb: ((t: number) => void) | null) {
      this.loop = cb
    }
    setPixelRatio(p: number) {
      this.pixelRatio = p
    }
    setSize(w: number, h: number) {
      this.size = [w, h]
    }
    getDrawingBufferSize(v: import("three").Vector2) {
      return v.set(this.size[0] * this.pixelRatio, this.size[1] * this.pixelRatio)
    }
    setRenderTarget(t: unknown) {
      this.target = t
    }
    getRenderTarget() {
      return this.target
    }
    render(scene: import("three").Scene, camera: import("three").Camera) {
      scene.updateMatrixWorld()
      calls.renders.push({ target: this.target, layers: camera.layers.mask, background: scene.background })
      this.info.render.calls += 3
      this.info.render.triangles += 100
    }
    compileAsync() {
      return Promise.resolve()
    }
    dispose() {}
  }
  return { ...actual, WebGLRenderer: FakeRenderer }
})

vi.mock("../lighting/system", async () => {
  const T = await import("three")
  return {
    createLightingSystem: () => ({
      createWorldMaterial: (o: { variant: string }) => new T.ShaderMaterial({ name: `world:${o.variant}` }),
      createTokenMaterial: () => new T.ShaderMaterial({ name: "token" }),
      createOverlayMaterial: (o: { kind: string }) => new T.ShaderMaterial({ name: `overlay:${o.kind}` }),
      setScene: () => {
        calls.setScene++
      },
      applyChange: (_s: unknown, _w: unknown, change: SceneChange, dirty: unknown[]) => {
        calls.applyChange.push({ change, dirty })
      },
      setView: (v: { mode: string; activeLevelId: string | null }) => {
        calls.setView.push({ mode: v.mode, activeLevelId: v.activeLevelId })
      },
      setQuality: (q: string) => {
        calls.setQuality.push(q)
      },
      beforeRender: () => {
        calls.beforeRender++
        return { activeLights: 2, tilesUpdated: 1, tilesTotal: 3, updateMs: 0.5 }
      },
      setLevelBackdrop: (levelId: string, texture: unknown, _rect: unknown, opacity: number, tintWalls: boolean) => {
        calls.backdrops.push({ levelId, texture, opacity, tintWalls })
      },
      setRenderParams: (p: { hdr: boolean; emissive: number; glow: number }) => {
        calls.renderParams.push(p)
      },
      maskUniforms: () => ({ uMasks: { value: null }, uMaskGrid: { value: new T.Vector4() }, uVisionMode: { value: 0 } }),
      maskLayerOf: () => -1,
      dispose: () => {},
    }),
  }
})

const { createEngine } = await import("../index")
const { placeholderFloatTexture } = await import("../materials/placeholders")
const { noiseTexture } = await import("../materials/surface")
const { tokenBaseGeometry } = await import("../builders/tokens")

interface Internals {
  levels: Map<string, { group: THREE.Group; mode: string; doorLeaves(): { pivot: THREE.Object3D; mesh: THREE.Mesh }[]; terrain(): { mesh: THREE.Mesh } | null }>
  controller: { kind: string; getTarget(): { x: number; y: number; z: number } }
  plan: Map<string, { mode: string }>
  root: THREE.Scene
}

function canvasEl(): HTMLCanvasElement {
  const c = document.createElement("canvas")
  Object.defineProperty(c, "clientWidth", { value: 800 })
  Object.defineProperty(c, "clientHeight", { value: 600 })
  c.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) })
  return c
}

function sampleScene() {
  const scene: Scene = createScene({ width: 20, depth: 20 })
  const ground = Object.keys(scene.levels)[0]
  const upper = createLevel({ name: "Upper", elevation: 10 })
  scene.levels[upper.id] = upper
  const upperFloor = createFloor(upper.id, { x: 0, z: 0, w: 50, d: 50 }, "wood")
  const wall = createWall(ground, { x: 10, z: 30 }, { x: 60, z: 30 })
  const door = createDoor(wall, 20)
  const crate = createProp(ground, "crate", { x: 50, y: 0, z: 50 })
  for (const o of [upperFloor, wall, door, crate]) scene.objects[o.id] = o
  const token = createToken(ground, { x: 22.5, z: 22.5 })
  scene.tokens[token.id] = token
  return { scene, ground, upper: upper.id, wall, door, crate, token }
}

const frame = (t = 0) => calls.renderer!.loop!(t)

describe("engine", () => {
  beforeEach(() => {
    calls.setScene = 0
    calls.applyChange = []
    calls.setView = []
    calls.setQuality = []
    calls.beforeRender = 0
    calls.backdrops = []
    calls.renderParams = []
    calls.renders = []
  })

  it("builds levels, renders frames and reports stats", () => {
    const { scene } = sampleScene()
    const engine = createEngine(canvasEl(), { quality: "medium" })
    const internals = engine as unknown as Internals
    engine.setScene(scene)
    expect(calls.setScene).toBe(1)
    expect(internals.levels.size).toBe(2)
    for (const lv of internals.levels.values()) expect(lv.group.children.length).toBe(7)
    const stats: FrameStats[] = []
    const off = engine.onFrame((s) => stats.push(s))
    frame(0)
    frame(16)
    off()
    frame(32)
    expect(calls.beforeRender).toBe(3)
    expect(stats).toHaveLength(2)
    // Medium: world pass, composite and overlay pass (the fake renderer counts 3 calls / 100 triangles each).
    expect(stats[1]).toMatchObject({ drawCalls: 9, triangles: 300, activeLights: 2, shadowTilesUpdated: 1, shadowTilesTotal: 3, quality: "medium" })
    // Pixel budget: 800×600 fits 2.1 MP at the jsdom device ratio of 1.
    expect(calls.renderer!.size).toEqual([800, 600])
    expect(calls.renderer!.pixelRatio).toBe(1)
    engine.dispose()
    expect(calls.renderer!.loop).toBeNull()
  })

  it("updates incrementally and animates doors", () => {
    const { scene, door, wall } = sampleScene()
    const engine = createEngine(canvasEl())
    const internals = engine as unknown as Internals
    engine.setScene(scene)
    frame(0)
    const groundView = internals.levels.get(wall.levelId)!
    const [leaf] = groundView.doorLeaves()
    const closedYaw = leaf.pivot.rotation.y
    // Open the door: no geometry rebuild, the occlusion world reports what changed.
    const opened: Scene = { ...scene, objects: { ...scene.objects, [door.id]: { ...(scene.objects[door.id] as DoorObject), state: "open" } } }
    engine.updateScene(opened)
    expect(calls.applyChange).toHaveLength(1)
    expect(calls.applyChange[0].change.objects).toEqual([door.id])
    expect(calls.applyChange[0].dirty.length).toBeGreaterThan(0)
    expect(groundView.doorLeaves()[0]).toBe(leaf)
    for (let t = 16; t <= 1000; t += 16) frame(t)
    expect(Math.abs(leaf.pivot.rotation.y - closedYaw)).toBeCloseTo(Math.PI / 2)
    // Moving the wall rebuilds the walls and doors buckets.
    const moved: Scene = { ...opened, objects: { ...opened.objects, [wall.id]: { ...wall, a: { x: 10, z: 35 }, b: { x: 60, z: 35 } } } }
    engine.updateScene(moved, { objects: [wall.id] })
    expect(groundView.doorLeaves()[0]).not.toBe(leaf)
    engine.dispose()
  })

  it("editor top-down view does not follow the selected token", () => {
    const { scene, ground, token } = sampleScene()
    const engine = createEngine(canvasEl())
    const internals = engine as unknown as Internals
    engine.setScene(scene)
    engine.setView({ mode: "editor", camera: "topdown", activeLevelId: ground, tilt: 0 })
    engine.focus({ x: 50, y: 0, z: 50 }, { distance: 90, immediate: true })
    frame(0)
    engine.setOverlays({ selectedIds: [token.id] })
    // A drag step / inspector edit moves the selected token: the camera stays put.
    const moved: Scene = { ...scene, tokens: { ...scene.tokens, [token.id]: { ...token, position: { x: 72.5, z: 72.5 } } } }
    engine.updateScene(moved)
    for (let t = 16; t <= 2000; t += 16) frame(t)
    expect(internals.controller.getTarget().x).toBeCloseTo(50)
    expect(internals.controller.getTarget().z).toBeCloseTo(50)
    // Switching to a play view does not glide to the edit made in the editor…
    engine.setView({ mode: "player" })
    for (let t = 2016; t <= 3000; t += 16) frame(t)
    expect(internals.controller.getTarget().x).toBeCloseTo(50)
    // …but the next confirmed move is followed.
    const again: Scene = { ...moved, tokens: { ...moved.tokens, [token.id]: { ...token, position: { x: 32.5, z: 82.5 } } } }
    engine.updateScene(again)
    for (let t = 3016; t <= 5000; t += 16) frame(t)
    expect(internals.controller.getTarget().x).toBeCloseTo(32.5)
    expect(internals.controller.getTarget().z).toBeCloseTo(82.5)
    engine.dispose()
  })

  it("releases module-level GPU singletons and loses a detached canvas' context on dispose", () => {
    const { scene } = sampleScene()
    const canvas = canvasEl()
    document.body.appendChild(canvas)
    const engine = createEngine(canvas)
    engine.setScene(scene)
    const fired: string[] = []
    const shared = [placeholderFloatTexture(), noiseTexture(), tokenBaseGeometry()] as const
    shared.forEach((o, k) => {
      // Like three's renderer listener: removes itself when the object is disposed.
      const d = o as THREE.EventDispatcher<{ dispose: object }>
      const onDispose = () => {
        fired.push(String(k))
        d.removeEventListener("dispose", onDispose)
      }
      d.addEventListener("dispose", onDispose)
    })
    // Attached canvas (StrictMode / HMR re-creating an engine on it): the context must survive.
    engine.dispose()
    expect(fired.sort()).toEqual(["0", "1", "2"])
    for (const o of shared) {
      const listeners = (o as unknown as { _listeners?: Record<string, unknown[]> })._listeners
      expect(listeners?.dispose ?? []).toHaveLength(0)
    }
    expect(calls.renderer!.contextLost).toBe(0)
    // Detached (a real unmount): lost at once.
    canvas.remove()
    const second = createEngine(canvas)
    second.dispose()
    expect(calls.renderer!.contextLost).toBe(1)
  })

  it("switches to the player camera with cutaway and follows the selected token", () => {
    const { scene, ground, upper, token } = sampleScene()
    const engine = createEngine(canvasEl())
    const internals = engine as unknown as Internals
    engine.setScene(scene)
    engine.setView({ mode: "player", camera: "topdown", activeLevelId: ground, tilt: 2 })
    expect(engine.getView().tilt).toBeCloseTo((35 * Math.PI) / 180)
    expect(internals.controller.kind).toBe("topdown")
    expect(internals.plan.get(upper)!.mode).toBe("hidden")
    expect(internals.levels.get(upper)!.group.visible).toBe(false)
    expect(calls.setView.at(-1)).toEqual({ mode: "player", activeLevelId: ground })
    engine.setOverlays({ selectedIds: [token.id] })
    const next: Scene = { ...scene, tokens: { ...scene.tokens, [token.id]: { ...token, position: { x: 72.5, z: 72.5 } } } }
    engine.updateScene(next)
    for (let t = 0; t <= 2000; t += 16) frame(t)
    const target = internals.controller.getTarget()
    expect(target.x).toBeCloseTo(72.5)
    expect(target.z).toBeCloseTo(72.5)
    engine.dispose()
  })

  it("shows door markers in top-down views only", () => {
    const { scene, ground, door } = sampleScene()
    const engine = createEngine(canvasEl())
    const internals = engine as unknown as Internals
    engine.setScene(scene)
    const leaf = () => internals.levels.get(ground)!.doorLeaves()[0] as unknown as { marker: THREE.Mesh | null; leaf: { doorId: string } }
    expect(leaf().leaf.doorId).toBe(door.id)
    expect(leaf().marker!.visible).toBe(false)
    engine.setView({ mode: "player", camera: "topdown", activeLevelId: ground, tilt: 0 })
    expect(leaf().marker!.visible).toBe(true)
    // Rebuilt door buckets keep following the camera.
    const locked: Scene = { ...scene, objects: { ...scene.objects, [door.id]: { ...door, state: "locked" } } }
    engine.updateScene(locked, { objects: [door.id] })
    frame(0)
    expect(leaf().marker!.visible).toBe(true)
    engine.setView({ mode: "editor", camera: "orbit" })
    expect(leaf().marker!.visible).toBe(false)
    engine.dispose()
  })

  it("picks through the active camera", () => {
    const { scene, ground, crate } = sampleScene()
    const engine = createEngine(canvasEl())
    engine.setScene(scene)
    engine.setView({ mode: "player", camera: "topdown", activeLevelId: ground, tilt: 0 })
    engine.focus({ x: 50, y: 0, z: 50 }, { distance: 40, immediate: true })
    frame(0)
    const hit = engine.pick(400, 300, { levelId: ground, objects: true, tokens: true })
    expect(hit.objectId).toBe(crate.id)
    expect(hit.ground!.x).toBeCloseTo(50)
    const p = engine.project({ x: 50, y: 0, z: 50 })
    expect(p.x).toBeCloseTo(400)
    expect(p.y).toBeCloseTo(300)
    engine.dispose()
  })

  it("previews terrain in place and restores the document terrain", () => {
    const { scene, ground } = sampleScene()
    const engine = createEngine(canvasEl())
    const internals = engine as unknown as Internals
    engine.setScene(scene)
    const lv = internals.levels.get(ground)!
    expect(lv.terrain()).toBeNull()
    const heights = denseHeights(createHeightmap(2), scene.grid).heights.slice()
    heights[10 * 41 + 10] = 4
    engine.previewTerrain(ground, heights, { x: 20, z: 20, w: 10, d: 10 })
    const terrain = lv.terrain()!
    expect(terrain).not.toBeNull()
    heights[10 * 41 + 10] = 6
    engine.previewTerrain(ground, heights, { x: 20, z: 20, w: 10, d: 10 })
    expect(lv.terrain()!.mesh).toBe(terrain.mesh)
    const pos = terrain.mesh.geometry.getAttribute("position")
    let peak = -Infinity
    for (let k = 0; k < pos.count; k++) peak = Math.max(peak, pos.getY(k))
    expect(peak).toBeCloseTo(6)
    engine.previewTerrain(ground, null, null)
    expect(lv.terrain()).toBeNull()
    engine.dispose()
  })

  it("applies quality changes to the lighting system and the pixel budget", () => {
    const { scene } = sampleScene()
    const engine = createEngine(canvasEl(), { quality: "high" })
    engine.setScene(scene)
    engine.setQuality("low")
    frame(0)
    expect(calls.setQuality).toEqual(["low"])
    const stats: FrameStats[] = []
    engine.onFrame((s) => stats.push(s))
    frame(16)
    expect(stats[0].quality).toBe("low")
    engine.dispose()
  })

  it("compiles an adaptive step's tier in the background and switches once it is ready", async () => {
    const { scene } = sampleScene()
    const engine = createEngine(canvasEl(), { quality: "high" })
    const internals = engine as unknown as { pendingQuality: { q: string } | null; releaseAfterFrame: unknown[] }
    engine.setScene(scene)
    // Slow frames (40 ms) until adaptive quality steps down.
    let t = 0
    while (!internals.pendingQuality && t < 10000) frame((t += 40))
    expect(internals.pendingQuality?.q).toBe("medium")
    // Nothing switched yet: the live materials keep drawing the old tier while the new one compiles.
    expect(calls.setQuality).toEqual([])
    frame((t += 40))
    await Promise.resolve()
    await Promise.resolve()
    // Compiled: the next frame commits, and the compile clones are released after it drew.
    frame(t + 40)
    expect(calls.setQuality).toEqual(["medium"])
    expect(internals.pendingQuality).toBeNull()
    expect(internals.releaseAfterFrame).toHaveLength(0)
    // A user choice applies at once and drops any pending step.
    engine.setQuality("ultra")
    expect(calls.setQuality).toEqual(["medium", "ultra"])
    expect(engine.getQualityCeiling()).toBe("ultra")
    engine.dispose()
  })

  it("draws flames in the overlay pass on medium (no bloom) and in the world pass otherwise", () => {
    const { scene, ground } = sampleScene()
    const torch = createLight(ground, "torch", { x: 30, z: 30 })
    scene.objects[torch.id] = torch
    const engine = createEngine(canvasEl(), { quality: "medium" })
    const internals = engine as unknown as { levels: Map<string, { flames(): { mesh: THREE.Object3D }[] }> }
    engine.setScene(scene)
    const layers = () => internals.levels.get(ground)!.flames().map((f) => f.mesh.layers.mask)
    expect(layers().length).toBeGreaterThan(0)
    expect(layers().every((m) => m === 0b1000)).toBe(true)
    engine.setQuality("high")
    expect(layers().every((m) => m === 0b0001)).toBe(true)
    engine.setQuality("low")
    expect(layers().every((m) => m === 0b0001)).toBe(true)
    engine.dispose()
  })

  it("never asks for context MSAA, on any tier", () => {
    for (const quality of ["low", "medium", "high", "ultra"] as const) {
      const engine = createEngine(canvasEl(), { quality })
      expect(calls.renderer!.params.antialias).toBe(false)
      // The overlay pass depth-tests against the composite's gl_FragDepth.
      expect(calls.renderer!.params.depth).toBe(true)
      engine.dispose()
    }
  })

  it("renders low straight to the canvas and medium / high / ultra through the post pipeline, overlays last", () => {
    const { scene } = sampleScene()
    const engine = createEngine(canvasEl(), { quality: "low" })
    engine.setScene(scene)
    frame(0)
    // Direct: one pass, world + overlay layers, no target, direct emissive parameters.
    expect(calls.renders.map((r) => [r.target, r.layers])).toEqual([[null, 0b1001]])
    expect(calls.renderParams.at(-1)).toMatchObject({ hdr: false, emissive: 1 })
    // Medium (lite post): the world into the MSAA target, the composite, then the overlays.
    engine.setQuality("medium")
    expect(calls.renderParams.at(-1)).toMatchObject({ hdr: true, emissive: 1, glow: 0.55 })
    calls.renders = []
    frame(16)
    expect(calls.renders[0].target).not.toBeNull()
    expect(calls.renders[0].layers).toBe(0b0001)
    expect(calls.renders.at(-1)).toMatchObject({ target: null, layers: 0b1000, background: null })
    // No bloom / AO passes: world + composite + overlays.
    expect(calls.renders.length).toBe(3)
    // Back to low: the post pipeline goes away, everything straight to the canvas again.
    engine.setQuality("low")
    expect(calls.renderParams.at(-1)).toMatchObject({ hdr: false })
    calls.renders = []
    frame(32)
    expect(calls.renders.map((r) => [r.target, r.layers])).toEqual([[null, 0b1001]])
    engine.setQuality("ultra")
    expect(calls.renderParams.at(-1)).toMatchObject({ hdr: true })
    calls.renders = []
    frame(16)
    // World into the HDR target, post passes, then the OVERLAY layer onto the canvas without the
    // background (which would force a clear).
    const world = calls.renders[0]
    expect(world.target).not.toBeNull()
    expect(world.layers).toBe(0b0001)
    const overlay = calls.renders.at(-1)!
    expect(overlay.target).toBeNull()
    expect(overlay.layers).toBe(0b1000)
    expect(overlay.background).toBeNull()
    // AO (3 passes) + bloom (1 + 5 + 5) + composite between them.
    expect(calls.renders.length).toBe(2 + 3 + 11 + 1)
    engine.dispose()
  })

  it("routes level images to the lighting system with the document's opacity and tint", () => {
    const { scene, ground } = sampleScene()
    scene.levels[ground].backdrop = { assetId: "a", rect: { x: 0, z: 0, w: 100, d: 100 }, opacity: 0.7, tintWalls: true }
    const engine = createEngine(canvasEl())
    engine.setScene(scene)
    const image = { width: 64, height: 32 } as unknown as ImageBitmap
    engine.setLevelImage(ground, image, { x: 0, z: 0, w: 100, d: 100 })
    const set = calls.backdrops.at(-1)!
    expect(set).toMatchObject({ levelId: ground, opacity: 0.7, tintWalls: true })
    expect((set.texture as THREE.Texture).colorSpace).toBe(THREE.SRGBColorSpace)
    // Explicit options win; a document change re-applies; null removes.
    engine.setLevelImage(ground, image, { x: 0, z: 0, w: 100, d: 100 }, { opacity: 0.4 })
    expect(calls.backdrops.at(-1)).toMatchObject({ opacity: 0.4, tintWalls: true })
    engine.setLevelImage(ground, null, null)
    expect(calls.backdrops.at(-1)).toMatchObject({ levelId: ground, texture: null, opacity: 0 })
    engine.dispose()
  })

  it("clears to the scene background, except to black under player fog of war (unexplored = black)", () => {
    const { scene } = sampleScene()
    scene.environment.backgroundColor = "#203040"
    const engine = createEngine(canvasEl())
    const internals = engine as unknown as Internals
    engine.setScene(scene)
    expect((internals.root.background as THREE.Color).getHexString()).toBe(new THREE.Color("#203040").getHexString())
    engine.setView({ mode: "player", vision: "fog" })
    expect((internals.root.background as THREE.Color).getHex()).toBe(0x000000)
    engine.setView({ mode: "dm-play", vision: "off" })
    expect((internals.root.background as THREE.Color).getHexString()).toBe(new THREE.Color("#203040").getHexString())
    engine.dispose()
  })
})
