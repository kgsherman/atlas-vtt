import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { createLevel, createScene, createToken } from "@/core/scene/factory"
import type { Scene } from "@/core/scene/types"

import type { OverlayState } from "../contracts"
import { DEFAULT_VIEW } from "./defaults"
import type { LevelPlanEntry } from "./levelPlan"
import { PortraitAtlas, slotUv } from "./portraits"
import { TOKEN_FADE_MS, TokenLayer } from "./tokens"

const overlays = (o: Partial<OverlayState> = {}): OverlayState => ({ selectedIds: [], hoveredId: null, preview: null, ruler: null, pendingMoves: {}, dragGhosts: {}, ...o })

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
  it("draws solid tokens per level and markers above the cutaway", () => {
    const { scene, ground, a, b, plan, layer, material } = setup()
    layer.syncScene(scene, 0, false)
    layer.update({ scene, plan, view: DEFAULT_VIEW, overlays: overlays() }, 0)
    const all = meshes(layer.root)
    // Base, ring, body and the portrait cap draw with the token material; the blob shadow has its own.
    const solid = all.filter((m) => m.material === material && m.geometry.name !== "token:cap")
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
    expect(picks).toHaveLength(2)
    expect(picks[0].count).toBe(42)
    expect((picks[0].userData.tokenIds as string[]).length).toBe(42)
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
