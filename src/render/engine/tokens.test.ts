import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { createLevel, createScene, createToken } from "@/core/scene/factory"
import type { Scene } from "@/core/scene/types"

import type { OverlayState } from "../contracts"
import { DEFAULT_VIEW } from "./defaults"
import type { LevelPlanEntry } from "./levelPlan"
import { PortraitAtlas, slotUv } from "./portraits"
import { chooseLod, TokenModelLibrary, type TokenModel } from "./tokenModels"
import { TOKEN_FADE_MS, TokenLayer } from "./tokens"

const overlays = (o: Partial<OverlayState> = {}): OverlayState => ({ selectedIds: [], hoveredId: null, preview: null, ruler: null, pendingMoves: {}, dragGhosts: {}, templates: [], ...o })

function setup() {
  const scene: Scene = createScene({ width: 10, depth: 10 })
  const ground = Object.keys(scene.levels)[0]
  const upper = createLevel({ elevation: 10 })
  scene.levels[upper.id] = upper
  const a = createToken(ground, { x: 2.5, z: 2.5 })
  const b = createToken(ground, { x: 7.5, z: 2.5 }, { size: "large" })
  const c = createToken(upper.id, { x: 12.5, z: 2.5 })
  for (const t of [a, b, c]) scene.tokens[t.id] = t
  const plan = new Map<string, LevelPlanEntry>([
    [ground, { mode: "solid", tokens: "solid", rank: 1 }],
    [upper.id, { mode: "hidden", tokens: "marker", rank: 2 }],
  ])
  const material = new THREE.ShaderMaterial()
  const layer = new TokenLayer(material)
  return { scene, ground, upper: upper.id, a, b, c, plan, layer, material }
}

const meshes = (root: THREE.Object3D) => {
  const out: THREE.InstancedMesh[] = []
  root.traverse((o) => {
    if ((o as THREE.InstancedMesh).isInstancedMesh) out.push(o as THREE.InstancedMesh)
  })
  return out
}

describe("TokenLayer", () => {
  it("walks moved tokens along the router's route and settles on the target", () => {
    const { scene, ground, a, plan, layer } = setup()
    const baseX = () => {
      const base = meshes(layer.root).find((m) => m.userData.slot === "token" && m.count > 0 && (m.userData.tokenIds as string[]).includes(a.id))!
      const ids = base.userData.tokenIds as string[]
      const mat = new THREE.Matrix4()
      base.getMatrixAt(ids.indexOf(a.id), mat)
      return new THREE.Vector3().setFromMatrixPosition(mat)
    }
    const routes: unknown[] = []
    layer.setRouter((id, from, to) => {
      routes.push({ id, from, to })
      return [from, { levelId: ground, position: { x: 2.5, z: 22.5 } }, to]
    })
    layer.syncScene(scene, 0, false)
    layer.update({ scene, plan, view: DEFAULT_VIEW, overlays: overlays() }, 0)
    const moved: Scene = { ...scene, tokens: { ...scene.tokens, [a.id]: { ...a, position: { x: 22.5, z: 22.5 } } } }
    layer.syncScene(moved, 100, true)
    expect(routes).toEqual([{ id: a.id, from: { levelId: ground, position: { x: 2.5, z: 2.5 } }, to: { levelId: ground, position: { x: 22.5, z: 22.5 } } }])
    expect(layer.moving(a.id)).toBe(true)
    // Still at the start, then down the first leg (x unchanged), then at the target.
    expect(layer.update({ scene: moved, plan, view: DEFAULT_VIEW, overlays: overlays() }, 100)).toBe(true)
    expect(baseX().x).toBeCloseTo(2.5)
    layer.update({ scene: moved, plan, view: DEFAULT_VIEW, overlays: overlays() }, 500)
    expect(baseX().x).toBeCloseTo(2.5)
    expect(baseX().z).toBeGreaterThan(2.5)
    layer.update({ scene: moved, plan, view: DEFAULT_VIEW, overlays: overlays() }, 10_000)
    expect(baseX().x).toBeCloseTo(22.5)
    expect(baseX().z).toBeCloseTo(22.5)
    expect(layer.moving(a.id)).toBe(false)
    // A full scene replacement (not animated) puts tokens in place at once.
    layer.syncScene(scene, 20_000, false)
    layer.update({ scene, plan, view: DEFAULT_VIEW, overlays: overlays() }, 20_000)
    expect(baseX().x).toBeCloseTo(2.5)
  })

  it("draws solid tokens per level and markers above the cutaway", () => {
    const { scene, ground, a, b, plan, layer, material } = setup()
    layer.syncScene(scene, 0, false)
    layer.update({ scene, plan, view: DEFAULT_VIEW, overlays: overlays() }, 0)
    const all = meshes(layer.root)
    // Base, ring, body and the portrait cap draw with the token material; the blob shadow has its own.
    // (The pick proxy of model tokens is invisible and empty here.)
    const solid = all.filter((m) => m.material === material && m.geometry.name !== "token:cap" && m.userData.slot !== "token-pick")
    expect(solid).toHaveLength(3)
    expect(all.find((m) => m.userData.slot === "token-shadow")!.count).toBe(2)
    // No portraits: the cap mesh draws nothing.
    expect(all.find((m) => m.geometry.name === "token:cap")!.count).toBe(0)
    for (const m of solid) {
      expect(m.material).toBe(material)
      expect(m.count).toBe(2)
      expect(m.userData.levelId).toBe(ground)
      expect(m.userData.tokenIds).toEqual([a.id, b.id].sort())
      expect(m.instanceColor).not.toBeNull()
      expect(m.geometry.getAttribute("aFade").getX(0)).toBe(1)
    }
    const decor = meshes(layer.decor)
    expect(decor.find((m) => m.renderOrder === 8)!.count).toBe(1)
    // Opaque at rest: tokens sort into the opaque pass and draw before level geometry.
    expect(material.transparent).toBe(false)
  })

  it("fades tokens in and out over 150 ms", () => {
    const { scene, ground, plan, layer, material } = setup()
    layer.syncScene(scene, 0, false)
    layer.update({ scene, plan, view: DEFAULT_VIEW, overlays: overlays() }, 0)
    const d = createToken(ground, { x: 22.5, z: 22.5 })
    const next = { ...scene, tokens: { ...scene.tokens, [d.id]: d } }
    layer.syncScene(next, 1000, true)
    const inputs = { scene: next, plan, view: DEFAULT_VIEW, overlays: overlays() }
    expect(layer.update(inputs, 1000 + TOKEN_FADE_MS / 2)).toBe(true)
    const body = meshes(layer.root).find((m) => m.geometry.name === "token:body")!
    const k = (body.userData.tokenIds as string[]).indexOf(d.id)
    const fade = body.geometry.getAttribute("aFade").getX(k)
    expect(fade).toBeGreaterThan(0)
    expect(fade).toBeLessThan(1)
    // Blending only while the fade runs.
    expect(material.transparent).toBe(true)
    expect(layer.update(inputs, 1000 + TOKEN_FADE_MS + 1)).toBe(false)
    expect(body.geometry.getAttribute("aFade").getX(k)).toBe(1)
    expect(material.transparent).toBe(false)
    // Removal keeps the token while it fades out, then drops it.
    layer.syncScene(scene, 2000, true)
    layer.update({ ...inputs, scene }, 2050)
    expect(body.count).toBe(3)
    expect(material.transparent).toBe(true)
    layer.update({ ...inputs, scene }, 2000 + TOKEN_FADE_MS + 1)
    expect(body.count).toBe(2)
    layer.update({ ...inputs, scene }, 2000 + TOKEN_FADE_MS + 20)
    expect(material.transparent).toBe(false)
  })

  it("draws state rings and drag ghosts", () => {
    const { scene, ground, a, b, plan, layer } = setup()
    layer.syncScene(scene, 0, false)
    layer.update(
      {
        scene,
        plan,
        view: DEFAULT_VIEW,
        overlays: overlays({ selectedIds: [a.id], hoveredId: b.id, dragGhosts: { [a.id]: { levelId: ground, position: { x: 30, z: 30 } } } }),
      },
      0
    )
    const decor = meshes(layer.decor)
    expect(decor.find((m) => m.renderOrder === 9)!.count).toBe(2)
    const ghosts = decor.filter((m) => m.renderOrder === 10)
    expect(ghosts.map((m) => m.count)).toEqual([1, 1])
    const mtx = new THREE.Matrix4()
    ghosts[0].getMatrixAt(0, mtx)
    expect(new THREE.Vector3().setFromMatrixPosition(mtx).x).toBeCloseTo(30)
  })

  it("exposes solid meshes for picking and grows past its initial capacity", () => {
    const { scene, ground, plan, layer } = setup()
    for (let k = 0; k < 40; k++) {
      const t = createToken(ground, { x: 2.5 + (k % 10) * 5, z: 12.5 + Math.floor(k / 10) * 5 })
      scene.tokens[t.id] = t
    }
    layer.syncScene(scene, 0, false)
    layer.update({ scene, plan, view: DEFAULT_VIEW, overlays: overlays() }, 0)
    const picks = layer.pickMeshes()
    // Bodies, model pick proxies (none here) and bases.
    expect(picks).toHaveLength(3)
    expect(picks[0].count).toBe(42)
    expect(picks[1].count).toBe(0)
    expect(picks[1].visible).toBe(false)
    expect((picks[0].userData.tokenIds as string[]).length).toBe(42)
  })
})

describe("TokenLayer with models", () => {
  /** A model whose LODs have 1200 / 300 / 12 triangles (boxes subdivided), 1.5 footprints tall. */
  const fakeModel = (): TokenModel => {
    const lods = [
      new THREE.BoxGeometry(1, 1.5, 1, 10, 10, 10),
      new THREE.BoxGeometry(1, 1.5, 1, 5, 5, 5),
      new THREE.BoxGeometry(1, 1.5, 1),
    ].map((g) => g.translate(0, 0.75, 0))
    return { lods, triangles: lods.map((g) => g.index!.count / 3), height: 1.5 }
  }

  function modelSetup() {
    const s = setup()
    s.scene.tokens[s.a.id] = { ...s.a, model: "free:elf" }
    const loads: string[] = []
    const model = fakeModel()
    const library = new TokenModelLibrary({ resolveUrl: async (ref) => (ref === "free:elf" ? "https://x/elf.glb" : null) }, async (url) => {
      loads.push(url)
      return model
    })
    const modelMaterial = new THREE.ShaderMaterial()
    const layer = new TokenLayer(s.material, library, modelMaterial)
    return { ...s, layer, loads, model, modelMaterial }
  }

  const flush = () => new Promise((r) => setTimeout(r, 0))
  const bySlot = (layer: TokenLayer, slot: string) => meshes(layer.root).filter((m) => m.userData.slot === slot && m.count > 0)

  it("draws the default body until the model loads, then the figure on the base", async () => {
    const { scene, a, b, plan, layer, loads, model, modelMaterial } = modelSetup()
    const inputs = { scene, plan, view: DEFAULT_VIEW, overlays: overlays() }
    layer.syncScene(scene, 0, false)
    layer.update(inputs, 0)
    const body = () => meshes(layer.root).find((m) => m.geometry.name === "token:body")!
    expect(body().userData.tokenIds).toEqual([a.id, b.id].sort())
    await flush()
    expect(loads).toEqual(["https://x/elf.glb"])
    // Ready: the layer re-buckets on its own (no scene change needed).
    expect(layer.update(inputs, 16)).toBe(false)
    expect(body().userData.tokenIds).toEqual([b.id])
    const [figure] = bySlot(layer, "token-model")
    expect(figure.material).toBe(modelMaterial)
    expect(figure.userData.tokenIds).toEqual([a.id])
    // No pixel density given: the most detailed LOD, sharing its attributes with the model's geometry.
    expect(figure.geometry.getAttribute("position")).toBe(model.lods[0].getAttribute("position"))
    // Base still drawn for both; picking goes through the invisible proxy, as tall as the figure.
    expect(meshes(layer.root).find((m) => m.geometry.name === "token:base")!.count).toBe(2)
    const [proxy] = bySlot(layer, "token-pick")
    expect(proxy.visible).toBe(false)
    expect(proxy.userData.tokenIds).toEqual([a.id])
    expect(layer.pickMeshes()).toContain(proxy)
    const m = new THREE.Matrix4()
    figure.getMatrixAt(0, m)
    const scale = new THREE.Vector3().setFromMatrixScale(m)
    // Figure unit = the base disc (0.9 × the 5 ft footprint).
    expect(scale.x).toBeCloseTo(4.5)
    proxy.getMatrixAt(0, m)
    expect(new THREE.Vector3().setFromMatrixScale(m).y).toBeCloseTo(1.5 * 4.5)
  })

  it("picks the level of detail from the on-screen size and follows the zoom", async () => {
    const { scene, plan, layer, model } = modelSetup()
    let ppf = 1
    const inputs = { scene, plan, view: DEFAULT_VIEW, overlays: overlays(), pixelsPerFootAt: () => ppf }
    layer.syncScene(scene, 0, false)
    layer.update(inputs, 0)
    await flush()
    layer.update(inputs, 16)
    // 5 ft at 1 px/ft: 25 px² → the coarsest LOD.
    const lodOf = () => model.lods.findIndex((g) => g.getAttribute("position") === bySlot(layer, "token-model")[0].geometry.getAttribute("position"))
    expect(lodOf()).toBe(2)
    // Zooming in far enough re-buckets without any scene change.
    ppf = 20
    layer.update(inputs, 32)
    expect(lodOf()).toBe(0)
    // Removing the model returns the default body.
    const plain = { ...scene, tokens: { ...scene.tokens } }
    const t = { ...plain.tokens[Object.keys(plain.tokens).find((id) => plain.tokens[id].model)!] }
    delete t.model
    plain.tokens[t.id] = t
    layer.syncScene(plain, 48, false)
    layer.update({ ...inputs, scene: plain }, 48)
    expect(bySlot(layer, "token-model")).toHaveLength(0)
  })
})

describe("chooseLod", () => {
  const tris = [24000, 6000, 1500]
  it("keeps about 3 px² per triangle by default", () => {
    expect(chooseLod(tris, 40)).toBe(2)
    expect(chooseLod(tris, 150)).toBe(1)
    expect(chooseLod(tris, 300)).toBe(0)
    // Fewer pixels per triangle (strong GPUs): finer sooner.
    expect(chooseLod(tris, 180)).toBe(1)
    expect(chooseLod(tris, 180, undefined, 1.25)).toBe(0)
  })

  it("switches only 10% past a threshold", () => {
    // 6000 triangles need 134 px at 3 px² each.
    expect(chooseLod(tris, 136, 2)).toBe(2)
    expect(chooseLod(tris, 150, 2)).toBe(1)
    expect(chooseLod(tris, 130, 1)).toBe(1)
    expect(chooseLod(tris, 118, 1)).toBe(2)
  })
})

describe("portrait atlas", () => {
  it("maps slots to atlas uv (8×8 grid, top row first)", () => {
    expect(slotUv(0)).toEqual({ u: 0, v: 7 / 8, scale: 1 / 8 })
    expect(slotUv(9)).toEqual({ u: 1 / 8, v: 6 / 8, scale: 1 / 8 })
  })

  it("draws no portrait while an image is unavailable", () => {
    const atlas = new PortraitAtlas()
    expect(atlas.lookup(null)).toBeNull()
    expect(atlas.texture).toBeNull()
  })
})
