// @vitest-environment jsdom
/**
 * Engine integration without WebGL: three's WebGLRenderer and the lighting system are replaced by
 * recording fakes; everything else (builders, occlusion world, cameras, overlays, picking) is real.
 */
import * as THREE from "three"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { createDoor, createFloor, createLevel, createProp, createScene, createToken, createWall } from "@/core/scene/factory"
import { denseHeights, createHeightmap } from "@/core/scene/heightmap"
import type { DoorObject, Scene } from "@/core/scene/types"

import type { FrameStats, SceneChange } from "../contracts"

const calls = vi.hoisted(() => ({
  setScene: 0,
  applyChange: [] as { change: SceneChange; dirty: unknown[] }[],
  setView: [] as { mode: string; activeLevelId: string | null }[],
  setQuality: [] as string[],
  beforeRender: 0,
  renderer: null as null | { loop: ((t: number) => void) | null; size: number[]; pixelRatio: number },
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
    constructor(p: { canvas: HTMLCanvasElement }) {
      this.domElement = p.canvas
      calls.renderer = this
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
    render(scene: import("three").Object3D) {
      scene.updateMatrixWorld()
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
      dispose: () => {},
    }),
  }
})

const { createEngine } = await import("../index")

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
    expect(stats[1]).toMatchObject({ drawCalls: 3, triangles: 100, activeLights: 2, shadowTilesUpdated: 1, shadowTilesTotal: 3, quality: "medium" })
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
