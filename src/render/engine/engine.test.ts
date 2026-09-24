// @vitest-environment jsdom
/**
 * Engine integration without WebGL: three's WebGLRenderer and the lighting system are replaced by
 * recording fakes; everything else (builders, occlusion world, cameras, overlays, picking) is real.
 */
import * as THREE from "three"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { createDoor, createFloor, createLevel, createLight, createProp, createScene, createToken, createWall } from "@/core/scene/factory"
import { denseHeights, createHeightmap, writeHeights } from "@/core/scene/heightmap"
import { blockShape, writeTerrain } from "@/core/scene/terrainShapes"
import type { DoorObject, FloorObject, Scene } from "@/core/scene/types"

import type { FrameStats, SceneChange } from "../contracts"

const calls = vi.hoisted(() => ({
  setScene: 0,
  applyChange: [] as { change: SceneChange; dirty: unknown[] }[],
  /** LightingSystem.previewTerrain calls (ground: the sampler passed, or null). */
  lightPreviews: [] as { levelId: string; ground: unknown; dirty: unknown }[],
  setView: [] as { mode: string; activeLevelId: string | null }[],
  setQuality: [] as string[],
  prepareQuality: [] as string[],
  /** Tiers the mock lighting system reports as prepared (qualityReady). */
  readyTiers: [] as string[],
  beforeRender: 0,
  /** Shadow tiles the mock lighting system reports as updated per frame. */
  tilesUpdated: 1,
  /** The fake renderer supports KHR_parallel_shader_compile; compileAsync resolves with `compileGate`. */
  parallel: false,
  compileGate: null as Promise<void> | null,
  /** The fake renderer keeps a three.js-like program list (one per compiled mesh), as the serial compile needs. */
  trackPrograms: false,
  /** Programs whose first-use work ran (getUniforms), in compile order. */
  warmed: [] as string[],
  /** Fake main-thread clock (ms) each tracked program's compile advances by 5 ms. */
  clock: 0,
  backdrops: [] as { levelId: string; texture: unknown; opacity: number; tintWalls: boolean }[],
  renderParams: [] as { hdr: boolean; emissive: number; glow: number }[],
  renders: [] as { target: unknown; layers: number; background: unknown }[],
  renderer: null as null | {
    loop: ((t: number) => void) | null
    size: number[]
    pixelRatio: number
    params: Record<string, unknown>
    contextLost: number
    programList: { program: object; name: string; getUniforms(): void; getAttributes(): void }[]
  },
}))

vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>()
  class FakeRenderer {
    domElement: HTMLCanvasElement
    programList: { program: object; name: string; getUniforms(): void; getAttributes(): void }[] = []
    info = {
      autoReset: true,
      render: { calls: 0, triangles: 0 },
      get programs() {
        return calls.trackPrograms ? calls.renderer!.programList : undefined
      },
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
    extensions = { has: (name: string) => calls.parallel && name === "KHR_parallel_shader_compile" }
    compile(scene: import("three").Object3D) {
      if (!calls.trackPrograms) return
      scene.traverse((o) => {
        const m = (o as import("three").Mesh).material as import("three").Material | undefined
        if (!m) return
        const name = `${m.name}#${this.programList.length}`
        this.programList.push({ program: {}, name, getUniforms: () => calls.warmed.push(name), getAttributes() {} })
        calls.clock += 5
      })
    }
    compileAsync() {
      return calls.compileGate ?? Promise.resolve()
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
      previewTerrain: (levelId: string, ground: unknown, dirty: unknown) => {
        calls.lightPreviews.push({ levelId, ground, dirty })
      },
      setView: (v: { mode: string; activeLevelId: string | null }) => {
        calls.setView.push({ mode: v.mode, activeLevelId: v.activeLevelId })
      },
      setQuality: (q: string) => {
        calls.setQuality.push(q)
      },
      prepareQuality: (q: string) => {
        calls.prepareQuality.push(q)
      },
      qualityReady: (q: string) => calls.readyTiers.includes(q),
      beforeRender: () => {
        calls.beforeRender++
        return { activeLights: 2, tilesUpdated: calls.tilesUpdated, tilesTotal: 3, updateMs: 0.5 }
      },
      setLevelBackdrop: (levelId: string, texture: unknown, _rect: unknown, opacity: number, tintWalls: boolean) => {
        calls.backdrops.push({ levelId, texture, opacity, tintWalls })
      },
      setRenderParams: (p: { hdr: boolean; emissive: number; glow: number }) => {
        calls.renderParams.push(p)
      },
      maskUniforms: () => ({ uMasks: { value: null }, uMaskGrid: { value: new T.Vector4() }, uVisionMode: { value: 0 } }),
      maskLayerOf: () => -1,
      precompile: () => calls.compileGate ?? Promise.resolve(),
      dispose: () => {},
    }),
  }
})

const { createEngine } = await import("../index")
const { placeholderFloatTexture } = await import("../materials/placeholders")
const { noiseTexture } = await import("../materials/surface")
const { tokenBaseGeometry } = await import("../builders/tokens")
const { BuildContext, buildBucket } = await import("../builders")
const { GroundSampler } = await import("../builders/ground")
const { gridGeometry } = await import("../overlays/grid")
const { LevelView } = await import("./levels")

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
    calls.lightPreviews = []
    calls.setView = []
    calls.setQuality = []
    calls.prepareQuality = []
    calls.readyTiers = ["low", "medium", "high", "ultra"]
    calls.beforeRender = 0
    calls.tilesUpdated = 1
    calls.parallel = false
    calls.compileGate = null
    calls.trackPrograms = false
    calls.warmed = []
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

  it("holds frames while start-up programs compile in parallel, then waits for the first captures", async () => {
    calls.parallel = true
    let release!: () => void
    calls.compileGate = new Promise<void>((r) => (release = r))
    const engine = createEngine(canvasEl(), { quality: "medium" })
    const stages: string[] = []
    engine.onLoadState((s) => stages.push(s.stage))
    expect(engine.getLoadState()).toEqual({ loading: false, stage: "ready", progress: 1 })
    engine.setScene(sampleScene().scene)
    frame(0)
    frame(16)
    // Drawing now would make three.js wait for every program's link on the main thread.
    expect(calls.renders).toHaveLength(0)
    expect(calls.beforeRender).toBe(0)
    expect(engine.getLoadState()).toMatchObject({ loading: true, stage: "compiling" })
    release()
    await new Promise((r) => setTimeout(r, 0))
    frame(32)
    expect(calls.renders.length).toBeGreaterThan(0)
    expect(engine.getLoadState()).toMatchObject({ loading: true, stage: "lighting" })
    // Still capturing shadow tiles: loading until they are done…
    frame(48)
    expect(engine.getLoadState().loading).toBe(true)
    calls.tilesUpdated = 0
    frame(64)
    expect(engine.getLoadState()).toEqual({ loading: false, stage: "ready", progress: 1 })
    expect(stages).toEqual(["compiling", "lighting", "ready"])
    engine.dispose()
  })

  it("caps the wait for the first captures, and never holds without parallel compilation", async () => {
    calls.parallel = true
    const engine = createEngine(canvasEl(), { quality: "medium" })
    engine.setScene(sampleScene().scene)
    frame(0)
    await new Promise((r) => setTimeout(r, 0))
    frame(16)
    expect(engine.getLoadState().stage).toBe("lighting")
    // Lights that keep moving keep capturing: the loading state ends anyway.
    frame(2000)
    expect(engine.getLoadState().loading).toBe(false)
    engine.dispose()

    calls.parallel = false
    calls.renders = []
    const sync = createEngine(canvasEl(), { quality: "medium" })
    sync.setScene(sampleScene().scene)
    frame(0)
    expect(calls.renders.length).toBeGreaterThan(0)
    expect(sync.getLoadState().loading).toBe(false)
    sync.dispose()
  })

  it("without parallel compilation, compiles and queries one program at a time over held frames", () => {
    calls.trackPrograms = true
    const now = vi.spyOn(performance, "now").mockImplementation(() => calls.clock)
    const engine = createEngine(canvasEl(), { quality: "medium" })
    engine.setScene(sampleScene().scene)
    frame(0)
    frame(100)
    // The loading card gets to paint first: nothing compiled yet.
    expect(calls.warmed).toHaveLength(0)
    expect(engine.getLoadState()).toMatchObject({ loading: true, stage: "compiling", progress: 0 })
    const progress: number[] = []
    let t = 300
    for (; t < 3000 && engine.getLoadState().stage === "compiling"; t += 16) {
      const before = calls.renderer!.programList.length
      frame(t)
      progress.push(engine.getLoadState().progress)
      // Every program compiled in a frame was queried in that frame (the blocking wait is per program).
      expect(calls.warmed.length).toBe(calls.renderer!.programList.length)
      if (engine.getLoadState().stage === "compiling") expect(calls.renderer!.programList.length).toBeGreaterThan(before)
    }
    expect(progress.length).toBeGreaterThan(3)
    expect(progress).toEqual([...progress].sort((a, b) => a - b))
    expect(calls.renders.length).toBeGreaterThan(0)
    expect(engine.getLoadState().stage).toBe("lighting")
    engine.dispose()
    now.mockRestore()
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
    engine.setView({ mode: "editor", camera: "topdown", activeLevelId: ground })
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

  it("refocuses on the active level when its elevation changes", () => {
    const { scene, upper } = sampleScene()
    const engine = createEngine(canvasEl())
    const internals = engine as unknown as Internals
    engine.setScene(scene)
    engine.setView({ mode: "editor", camera: "orbit", activeLevelId: upper })
    for (let t = 0; t <= 2000; t += 16) frame(t)
    expect(internals.controller.getTarget().y).toBeCloseTo(10)
    const { x, z } = internals.controller.getTarget()
    const raised: Scene = { ...scene, levels: { ...scene.levels, [upper]: { ...scene.levels[upper], elevation: 25 } } }
    engine.updateScene(raised)
    for (let t = 2016; t <= 4000; t += 16) frame(t)
    expect(internals.controller.getTarget()).toEqual({ x: expect.closeTo(x), y: expect.closeTo(25), z: expect.closeTo(z) })
    // The other camera follows too.
    engine.setView({ camera: "topdown" })
    expect(internals.controller.getTarget().y).toBeCloseTo(25)
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
    engine.setView({ mode: "player", camera: "topdown", activeLevelId: ground })
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
    engine.setView({ mode: "player", camera: "topdown", activeLevelId: ground })
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
    engine.setView({ mode: "player", camera: "topdown", activeLevelId: ground })
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

  it("moves an existing terrain mesh in place from the first preview frame and grows the camera bounds", () => {
    const { scene, ground } = sampleScene()
    const level = scene.levels[ground]
    const withTerrain: Scene = { ...scene, levels: { ...scene.levels, [ground]: { ...level, heightmap: createHeightmap(2) } } }
    const engine = createEngine(canvasEl())
    const internals = engine as unknown as Internals & { bounds: { max: { y: number } } }
    engine.setScene(withTerrain)
    const lv = internals.levels.get(ground)!
    const terrain = lv.terrain()!
    expect(terrain).not.toBeNull()
    const maxBefore = internals.bounds.max.y
    const heights = denseHeights(createHeightmap(2), scene.grid).heights.slice()
    heights[10 * 41 + 10] = 30
    engine.previewTerrain(ground, heights, { x: 24, z: 24, w: 2, d: 2 })
    // No rebuild: the same mesh, its vertices moved; the bounds cover the raised ground.
    expect(lv.terrain()!.mesh).toBe(terrain.mesh)
    const pos = terrain.mesh.geometry.getAttribute("position")
    let peak = -Infinity
    for (let k = 0; k < pos.count; k++) peak = Math.max(peak, pos.getY(k))
    expect(peak).toBeCloseTo(30)
    expect(terrain.mesh.geometry.boundingBox!.max.y).toBeCloseTo(30)
    expect(internals.bounds.max.y).toBeCloseTo(Math.max(maxBefore, 30 + level.height))
    engine.dispose()
  })

  it("refreshes the camera bounds when committed terrain changes", () => {
    const { scene, ground } = sampleScene()
    const engine = createEngine(canvasEl())
    const internals = engine as unknown as { bounds: { max: { y: number } } }
    engine.setScene(scene)
    const before = internals.bounds.max.y
    const heights = denseHeights(createHeightmap(2), scene.grid).heights.slice()
    heights[10 * 41 + 10] = 40
    const heightmap = writeHeights(createHeightmap(2), scene.grid, heights)
    const raised: Scene = { ...scene, levels: { ...scene.levels, [ground]: { ...scene.levels[ground], heightmap } } }
    engine.updateScene(raised, { terrain: [ground] })
    expect(internals.bounds.max.y).toBeGreaterThan(before)
    expect(internals.bounds.max.y).toBeCloseTo(40 + scene.levels[ground].height)
    engine.dispose()
  })

  it("rebuilds follow-terrain walls on a terrain preview, throttled, and restores them when it ends", () => {
    const { scene, ground, wall } = sampleScene()
    const now = vi.spyOn(performance, "now").mockReturnValue(1000)
    const engine = createEngine(canvasEl())
    const internals = engine as unknown as Internals
    engine.setScene(scene)
    const lv = internals.levels.get(ground)!
    const wallsRoot = lv.group.children[1]
    const wallTop = () => {
      const g = (wallsRoot.children[0] as THREE.Mesh).geometry
      g.computeBoundingBox()
      return g.boundingBox!.max.y
    }
    expect(wallTop()).toBeCloseTo(wall.height)
    const heights = denseHeights(createHeightmap(2), scene.grid).heights.slice()
    // Raise the ground under the wall (z = 30 → lattice row 12; x = 30 → column 12).
    heights[12 * 41 + 12] = 5
    engine.previewTerrain(ground, heights, { x: 29, z: 29, w: 2, d: 2 })
    const first = wallsRoot.children[0]
    expect(wallTop()).toBeCloseTo(5 + wall.height)
    // Within the interval: no rebuild yet...
    heights[12 * 41 + 12] = 8
    now.mockReturnValue(1050)
    engine.previewTerrain(ground, heights, { x: 29, z: 29, w: 2, d: 2 })
    expect(wallsRoot.children[0]).toBe(first)
    // ... the next frame after it rebuilds once more.
    frame(16)
    expect(wallsRoot.children[0]).toBe(first)
    now.mockReturnValue(1101)
    frame(32)
    expect(wallsRoot.children[0]).not.toBe(first)
    expect(wallTop()).toBeCloseTo(8 + wall.height)
    // A preview away from every follow-terrain wall leaves them alone.
    const rebuilt = wallsRoot.children[0]
    now.mockReturnValue(2000)
    heights[2 * 41 + 2] = 3
    engine.previewTerrain(ground, heights, { x: 4, z: 4, w: 2, d: 2 })
    expect(wallsRoot.children[0]).toBe(rebuilt)
    // Clearing the preview puts the walls back on the document terrain.
    engine.previewTerrain(ground, null, null)
    expect(wallTop()).toBeCloseTo(wall.height)
    now.mockRestore()
    engine.dispose()
  })

  it("waits after a slow preview wall rebuild in proportion to its cost, measured from its end", () => {
    const { scene, ground } = sampleScene()
    let clock = 1000
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock)
    const engine = createEngine(canvasEl())
    const internals = engine as unknown as Internals
    engine.setScene(scene)
    // Every walls / doors bucket build takes 25 ms of the fake clock (a 50 ms rebuild).
    const setBucket = LevelView.prototype.setBucket
    const slow = vi.spyOn(LevelView.prototype, "setBucket").mockImplementation(function (this: InstanceType<typeof LevelView>, kind, build) {
      if (kind === "walls" || kind === "doors") clock += 25
      setBucket.call(this, kind, build)
    })
    const wallsRoot = internals.levels.get(ground)!.group.children[1]
    const heights = denseHeights(createHeightmap(2), scene.grid).heights.slice()
    const at = { x: 29, z: 29, w: 2, d: 2 }
    heights[12 * 41 + 12] = 5
    engine.previewTerrain(ground, heights, at)
    const first = wallsRoot.children[0]
    expect(clock).toBe(1050)
    // 150 ms after the rebuild started: the old throttle (100 ms from its start) rebuilt again here. Now the
    // next one waits 8 × 50 ms after the rebuild ended (1450).
    clock = 1150
    heights[12 * 41 + 12] = 6
    engine.previewTerrain(ground, heights, at)
    expect(wallsRoot.children[0]).toBe(first)
    clock = 1440
    frame(16)
    expect(wallsRoot.children[0]).toBe(first)
    // The trailing rebuild once the wait is over.
    clock = 1450
    frame(32)
    expect(wallsRoot.children[0]).not.toBe(first)
    slow.mockRestore()
    now.mockRestore()
    engine.dispose()
  })

  it("rebuilds outlines after a preview wall rebuild only when they hang on that level's walls", () => {
    const { scene, ground, wall } = sampleScene()
    const now = vi.spyOn(performance, "now").mockReturnValue(1000)
    const engine = createEngine(canvasEl())
    const internals = engine as unknown as Internals & { overlays: { sceneChanged(): void } }
    engine.setScene(scene)
    const sceneChanged = vi.spyOn(internals.overlays, "sceneChanged")
    const wallsRoot = internals.levels.get(ground)!.group.children[1]
    const heights = denseHeights(createHeightmap(2), scene.grid).heights.slice()
    heights[12 * 41 + 12] = 5
    engine.previewTerrain(ground, heights, { x: 29, z: 29, w: 2, d: 2 })
    const first = wallsRoot.children[0]
    // Walls rebuilt, nothing outlined on them: outlines and light rings are left alone.
    expect(sceneChanged).not.toHaveBeenCalled()
    engine.setOverlays({ selectedIds: [wall.id] })
    now.mockReturnValue(2000)
    heights[12 * 41 + 12] = 6
    engine.previewTerrain(ground, heights, { x: 29, z: 29, w: 2, d: 2 })
    expect(wallsRoot.children[0]).not.toBe(first)
    expect(sceneChanged).toHaveBeenCalledTimes(1)
    now.mockRestore()
    engine.dispose()
  })

  it("passes terrain previews on to the lighting system, throttled, and ends them on clear but not on commit", () => {
    const { scene, ground } = sampleScene()
    let clock = 1000
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock)
    const engine = createEngine(canvasEl())
    engine.setScene(scene)
    const heights = denseHeights(createHeightmap(2), scene.grid).heights.slice()
    heights[2 * 41 + 2] = 3
    engine.previewTerrain(ground, heights, { x: 4, z: 4, w: 2, d: 2 })
    expect(calls.lightPreviews).toHaveLength(1)
    expect(calls.lightPreviews[0]).toMatchObject({ levelId: ground, dirty: { x: 4, z: 4, w: 2, d: 2 } })
    const sampler = calls.lightPreviews[0].ground as { heightAt(x: number, z: number): number }
    expect(sampler.heightAt(5, 5)).toBeCloseTo(3)
    // Within the interval: folded into one trailing call over the union of the dirty rects.
    clock = 1040
    heights[3 * 41 + 3] = 4
    engine.previewTerrain(ground, heights, { x: 6, z: 6, w: 2, d: 2 })
    clock = 1060
    heights[6 * 41 + 6] = 4
    engine.previewTerrain(ground, heights, { x: 14, z: 14, w: 2, d: 2 })
    expect(calls.lightPreviews).toHaveLength(1)
    frame(16)
    expect(calls.lightPreviews).toHaveLength(1)
    clock = 1100
    frame(32)
    expect(calls.lightPreviews).toHaveLength(2)
    expect(calls.lightPreviews[1].dirty).toEqual({ x: 6, z: 6, w: 10, d: 10 })
    // Clearing ends the lighting preview at once.
    engine.previewTerrain(ground, null, null)
    expect(calls.lightPreviews[2]).toEqual({ levelId: ground, ground: null, dirty: null })
    // A commit replaces a preview: its pending update is dropped (applyChange brings the lighting system
    // the committed terrain), no stale preview reaches it afterwards.
    clock = 2000
    engine.previewTerrain(ground, heights, { x: 4, z: 4, w: 2, d: 2 })
    clock = 2010
    engine.previewTerrain(ground, heights, { x: 14, z: 14, w: 2, d: 2 })
    expect(calls.lightPreviews).toHaveLength(4)
    const heightmap = writeHeights(createHeightmap(2), scene.grid, heights)
    engine.updateScene({ ...scene, levels: { ...scene.levels, [ground]: { ...scene.levels[ground], heightmap } } }, { terrain: [ground] })
    clock = 3000
    frame(48)
    expect(calls.lightPreviews).toHaveLength(4)
    now.mockRestore()
    engine.dispose()
  })

  it("commits a terrain edit in place: a one-shape nudge on a 100×100-cell resolution-4 level rebuilds neither the terrain mesh nor the grid", () => {
    const scene: Scene = createScene({ width: 100, depth: 100 })
    const ground = Object.keys(scene.levels)[0]
    const far = createWall(ground, { x: 20, z: 450 }, { x: 80, z: 450 })
    scene.objects[far.id] = far
    const level = { ...scene.levels[ground], heightmap: createHeightmap(4) }
    writeTerrain(level, scene.grid, { upsert: [blockShape("hill", { x: 200, z: 200, w: 40, d: 40 }, 0, 5, 0)] })
    scene.levels[ground] = level
    const engine = createEngine(canvasEl())
    const internals = engine as unknown as Internals & { overlays: { grid: { mesh: THREE.Mesh } } }
    engine.setScene(scene)
    frame(0)
    const lv = internals.levels.get(ground)!
    const mesh = lv.terrain()!.mesh
    const grid = internals.overlays.grid.mesh.geometry
    expect(grid.getAttribute("position").count).toBe(401 * 401)
    // Nudge the shape 5 ft east: the commit rewrites the chunks its old ∪ new footprint reaches.
    const hm = level.heightmap!
    const te = level.terrainEdits!
    const nudged = { ...level, heightmap: { ...hm, chunks: { ...hm.chunks } }, terrainEdits: { shapes: { ...te.shapes }, baseChunks: { ...te.baseChunks } } }
    writeTerrain(nudged, scene.grid, { upsert: [blockShape("hill", { x: 205, z: 200, w: 40, d: 40 }, 0, 5, 0)] })
    const next: Scene = { ...scene, levels: { ...scene.levels, [ground]: nudged } }
    const setBucket = vi.spyOn(LevelView.prototype, "setBucket")
    const t0 = performance.now()
    engine.updateScene(next, { terrain: [ground] })
    const commitMs = performance.now() - t0
    const rebuilt = setBucket.mock.calls.map((c) => c[0])
    setBucket.mockRestore()
    // Neither the terrain mesh nor the walls (none near the shape) are rebuilt.
    expect(rebuilt).not.toContain("floors")
    expect(rebuilt).not.toContain("walls")
    expect(rebuilt).not.toContain("doors")
    expect(lv.terrain()!.mesh).toBe(mesh)
    // The mesh moved in place is what a full rebuild on the committed terrain draws.
    const t1 = performance.now()
    const fresh = buildBucket(new BuildContext(next), ground, "floors").meshes[0].geometry
    const rebuildMs = performance.now() - t1
    for (const name of ["position", "normal"]) {
      const a = mesh.geometry.getAttribute(name).array
      const b = fresh.getAttribute(name).array
      expect(a.length).toBe(b.length)
      let worst = 0
      for (let k = 0; k < a.length; k++) worst = Math.max(worst, Math.abs(a[k] - b[k]))
      expect(worst, name).toBeLessThan(1e-4)
    }
    fresh.dispose()
    // The draped grid moved in place too.
    frame(16)
    expect(internals.overlays.grid.mesh.geometry).toBe(grid)
    const want = gridGeometry(500, 500, GroundSampler.forLevel(nudged, next.grid)).getAttribute("position").array
    const got = grid.getAttribute("position").array
    let worst = 0
    for (let k = 1; k < got.length; k += 3) worst = Math.max(worst, Math.abs(got[k] - want[k]))
    expect(worst).toBeLessThan(1e-4)
    // Measured ≈ 35 ms against ≈ 345 ms for the floors rebuild alone (the grid and the other buckets came on top).
    console.log(`terrain commit, 100×100 cells at resolution 4: updateScene ${commitMs.toFixed(1)} ms in place (a floors rebuild alone: ${rebuildMs.toFixed(1)} ms)`)
    expect(commitMs).toBeLessThan(rebuildMs / 2)
    engine.dispose()
  }, 30000)

  it("rebuilds walls and doors on a terrain commit only when the change reaches a wall", () => {
    const { scene, ground, wall } = sampleScene()
    const withTerrain: Scene = { ...scene, levels: { ...scene.levels, [ground]: { ...scene.levels[ground], heightmap: createHeightmap(2) } } }
    const engine = createEngine(canvasEl())
    const internals = engine as unknown as Internals
    engine.setScene(withTerrain)
    const lv = internals.levels.get(ground)!
    const mesh = lv.terrain()!.mesh
    const wallsRoot = lv.group.children[1]
    const heights = denseHeights(createHeightmap(2), scene.grid).heights.slice()
    const commit = (prev: Scene) => {
      const next: Scene = { ...prev, levels: { ...prev.levels, [ground]: { ...prev.levels[ground], heightmap: writeHeights(prev.levels[ground].heightmap!, scene.grid, heights) } } }
      engine.updateScene(next, { terrain: [ground] })
      return next
    }
    // Far from the wall (x 10..60 at z = 30): chunk (2, 2) only.
    const wallMesh = wallsRoot.children[0]
    const [leaf] = lv.doorLeaves()
    heights[36 * 41 + 36] = 3
    const far = commit(withTerrain)
    expect(wallsRoot.children[0]).toBe(wallMesh)
    expect(lv.doorLeaves()[0]).toBe(leaf)
    // Under the wall: walls (with their follow-terrain tops) and doors are rebuilt.
    heights[12 * 41 + 12] = 4
    commit(far)
    const rebuilt = wallsRoot.children[0] as THREE.Mesh
    expect(rebuilt).not.toBe(wallMesh)
    expect(lv.doorLeaves()[0]).not.toBe(leaf)
    rebuilt.geometry.computeBoundingBox()
    expect(rebuilt.geometry.boundingBox!.max.y).toBeCloseTo(4 + wall.height)
    expect(lv.terrain()!.mesh).toBe(mesh)
    engine.dispose()
  })

  it("moves the terrain back over every area a preview drew, on commit and on clear, without rebuilding it", () => {
    const { scene, ground } = sampleScene()
    const withTerrain: Scene = { ...scene, levels: { ...scene.levels, [ground]: { ...scene.levels[ground], heightmap: createHeightmap(2) } } }
    const engine = createEngine(canvasEl())
    const internals = engine as unknown as Internals
    engine.setScene(withTerrain)
    const lv = internals.levels.get(ground)!
    const mesh = lv.terrain()!.mesh
    const peakNear = (x: number, z: number) => {
      const pos = mesh.geometry.getAttribute("position")
      let peak = -Infinity
      for (let k = 0; k < pos.count; k++) if (Math.abs(pos.getX(k) - x) < 1e-6 && Math.abs(pos.getZ(k) - z) < 1e-6) peak = Math.max(peak, pos.getY(k))
      return peak
    }
    const base = denseHeights(createHeightmap(2), scene.grid).heights
    // A preview raises (10, 10); the commit changes only (90, 90): the net change does not reach (10, 10).
    const preview = base.slice()
    preview[4 * 41 + 4] = 6
    engine.previewTerrain(ground, preview, { x: 9, z: 9, w: 2, d: 2 })
    expect(peakNear(10, 10)).toBeCloseTo(6)
    const committed = base.slice()
    committed[36 * 41 + 36] = 3
    const next: Scene = { ...withTerrain, levels: { ...withTerrain.levels, [ground]: { ...withTerrain.levels[ground], heightmap: writeHeights(createHeightmap(2), scene.grid, committed) } } }
    engine.updateScene(next, { terrain: [ground] })
    expect(lv.terrain()!.mesh).toBe(mesh)
    expect(peakNear(10, 10)).toBeCloseTo(0)
    expect(peakNear(90, 90)).toBeCloseTo(3)
    // A cleared preview goes back to the document in place as well.
    preview.set(committed)
    preview[8 * 41 + 30] = -4
    engine.previewTerrain(ground, preview, { x: 74, z: 19, w: 2, d: 2 })
    expect(peakNear(75, 20)).toBeCloseTo(-4)
    engine.previewTerrain(ground, null, null)
    expect(lv.terrain()!.mesh).toBe(mesh)
    expect(peakNear(75, 20)).toBeCloseTo(0)
    expect(peakNear(90, 90)).toBeCloseTo(3)
    engine.dispose()
  })

  it("keeps floor outlines (hover, selection, hidden helpers) on the terrain as it moves in place on commits and cleared previews", () => {
    const { scene, ground } = sampleScene()
    const withTerrain: Scene = { ...scene, levels: { ...scene.levels, [ground]: { ...scene.levels[ground], heightmap: createHeightmap(2) } } }
    const engine = createEngine(canvasEl())
    type Outlines = { line: THREE.Mesh }[]
    const internals = engine as unknown as Internals & { overlays: { outlines: Outlines; helperOutlines: Outlines; sceneChanged(): void } }
    engine.setScene(withTerrain)
    const mesh = internals.levels.get(ground)!.terrain()!.mesh
    const floorId = Object.keys(scene.objects).find((id) => scene.objects[id].type === "floor" && scene.objects[id].levelId === ground)!
    const top = (list: Outlines) => {
      let y = -Infinity
      for (const { line } of list) {
        const a = line.geometry.getAttribute("position").array
        for (let k = 1; k < a.length; k += 3) y = Math.max(y, a[k])
      }
      return y
    }
    /** A 6 ft spike at (10, 10) (its slopes are feature edges), or a flat ground. */
    const spike = (on: boolean) => {
      const h = denseHeights(createHeightmap(2), scene.grid).heights.slice()
      if (on) h[4 * 41 + 4] = 6
      return h
    }
    const commit = (prev: Scene, on: boolean): Scene => {
      const next: Scene = {
        ...prev,
        levels: { ...prev.levels, [ground]: { ...prev.levels[ground], heightmap: writeHeights(createHeightmap(2), scene.grid, spike(on)) } },
      }
      engine.updateScene(next, { terrain: [ground] })
      return next
    }
    let t = 0
    const tick = () => frame((t += 16))
    // Hovered once (its edges cached), then committed: hovered again, the outline is on the new terrain.
    engine.setOverlays({ hoveredId: floorId })
    tick()
    expect(top(internals.overlays.outlines)).toBeCloseTo(0)
    engine.setOverlays({ hoveredId: null })
    tick()
    let doc = commit(withTerrain, true)
    tick()
    expect(internals.levels.get(ground)!.terrain()!.mesh).toBe(mesh)
    engine.setOverlays({ hoveredId: floorId })
    tick()
    expect(top(internals.overlays.outlines)).toBeCloseTo(6)
    // Selected through a commit: rebuilt on it.
    engine.setOverlays({ hoveredId: null, selectedIds: [floorId] })
    tick()
    doc = commit(doc, false)
    tick()
    expect(top(internals.overlays.outlines)).toBeCloseTo(0)
    // First outlined during a preview (flattening the committed spike), which is then cleared: back on the
    // document terrain. (Outlines drawn before a preview still lag behind it until it ends.)
    engine.setOverlays({ selectedIds: [] })
    tick()
    doc = commit(doc, true)
    engine.previewTerrain(ground, spike(false), { x: 9, z: 9, w: 2, d: 2 })
    engine.setOverlays({ selectedIds: [floorId] })
    tick()
    expect(top(internals.overlays.outlines)).toBeCloseTo(0)
    const sceneChanged = vi.spyOn(internals.overlays, "sceneChanged")
    engine.previewTerrain(ground, null, null)
    expect(sceneChanged).toHaveBeenCalledTimes(1)
    tick()
    expect(internals.levels.get(ground)!.terrain()!.mesh).toBe(mesh)
    expect(top(internals.overlays.outlines)).toBeCloseTo(6)
    // Nothing outlined on the level's floors: a cleared preview leaves the overlays alone.
    engine.setOverlays({ selectedIds: [] })
    engine.previewTerrain(ground, spike(true), { x: 9, z: 9, w: 2, d: 2 })
    engine.previewTerrain(ground, null, null)
    expect(sceneChanged).toHaveBeenCalledTimes(1)
    sceneChanged.mockRestore()
    // A hidden floor's helper outline follows commits too.
    const floor = doc.objects[floorId] as FloorObject
    doc = { ...doc, objects: { ...doc.objects, [floorId]: { ...floor, hidden: true } } }
    engine.updateScene(doc)
    tick()
    expect(internals.overlays.helperOutlines.length).toBeGreaterThan(0)
    expect(top(internals.overlays.helperOutlines)).toBeCloseTo(6)
    const hiddenMesh = internals.levels.get(ground)!.terrain()!.mesh
    commit(doc, false)
    tick()
    expect(internals.levels.get(ground)!.terrain()!.mesh).toBe(hiddenMesh)
    expect(top(internals.overlays.helperOutlines)).toBeCloseTo(0)
    engine.dispose()
  })

  it("rebuilds the terrain mesh on a commit it cannot apply in place (floors changed too, another resolution)", () => {
    const { scene, ground } = sampleScene()
    const withTerrain: Scene = { ...scene, levels: { ...scene.levels, [ground]: { ...scene.levels[ground], heightmap: createHeightmap(2) } } }
    const engine = createEngine(canvasEl())
    const internals = engine as unknown as Internals
    engine.setScene(withTerrain)
    const lv = internals.levels.get(ground)!
    const mesh = lv.terrain()!.mesh
    const heights = denseHeights(createHeightmap(2), scene.grid).heights.slice()
    heights[36 * 41 + 36] = 3
    const floorId = Object.keys(scene.objects).find((id) => scene.objects[id].type === "floor" && scene.objects[id].levelId === ground)!
    const floor = scene.objects[floorId] as FloorObject
    const changed: Scene = {
      ...withTerrain,
      levels: { ...withTerrain.levels, [ground]: { ...withTerrain.levels[ground], heightmap: writeHeights(createHeightmap(2), scene.grid, heights) } },
      objects: { ...withTerrain.objects, [floorId]: { ...floor, material: "dirt" } },
    }
    engine.updateScene(changed, { terrain: [ground], objects: [floorId] })
    const rebuilt = lv.terrain()!.mesh
    expect(rebuilt).not.toBe(mesh)
    // Another lattice spacing.
    const fine: Scene = { ...changed, levels: { ...changed.levels, [ground]: { ...changed.levels[ground], heightmap: createHeightmap(4) } } }
    engine.updateScene(fine, { terrain: [ground] })
    expect(lv.terrain()!.mesh).not.toBe(rebuilt)
    expect(lv.terrain()!.mesh.geometry.userData.terrainSpacing).toBeCloseTo(1.25)
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

  it("commits an adaptive step only once the lighting system filled the tier's shadow atlases", async () => {
    const { scene } = sampleScene()
    calls.readyTiers = []
    const engine = createEngine(canvasEl(), { quality: "high" })
    const internals = engine as unknown as { pendingQuality: { q: string } | null }
    engine.setScene(scene)
    let t = 0
    while (!internals.pendingQuality && t < 10000) frame((t += 40))
    expect(internals.pendingQuality?.q).toBe("medium")
    expect(calls.prepareQuality).toEqual(["medium"])
    await Promise.resolve()
    await Promise.resolve()
    // Compiled, but the atlases are still filling: the old tier keeps drawing.
    frame((t += 16))
    frame((t += 16))
    expect(calls.setQuality).toEqual([])
    calls.readyTiers = ["medium"]
    frame(t + 16)
    expect(calls.setQuality).toEqual(["medium"])
    expect(internals.pendingQuality).toBeNull()
    engine.dispose()
  })

  it("commits a pending step at its deadline even if the atlases are not filled, and cancels on a user choice", async () => {
    const { scene } = sampleScene()
    calls.readyTiers = []
    const engine = createEngine(canvasEl(), { quality: "high" })
    const internals = engine as unknown as { pendingQuality: { q: string; deadline: number } | null }
    engine.setScene(scene)
    let t = 0
    while (!internals.pendingQuality && t < 10000) frame((t += 40))
    await Promise.resolve()
    await Promise.resolve()
    const deadline = internals.pendingQuality!.deadline
    frame(deadline - 1)
    expect(calls.setQuality).toEqual([])
    frame(deadline + 1)
    expect(calls.setQuality).toEqual(["medium"])
    // The next adaptive request is cancelled (and its atlases dropped) by the user's choice.
    t = deadline + 1
    while (!internals.pendingQuality && t < 30000) frame((t += 40))
    expect(internals.pendingQuality?.q).toBe("low")
    calls.prepareQuality = []
    engine.setQuality("high")
    expect(internals.pendingQuality).toBeNull()
    expect(calls.prepareQuality).toEqual(["medium"])
    expect(calls.setQuality).toEqual(["medium", "high"])
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
