// @vitest-environment jsdom
import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { createFloor, createLevel, createScene } from "@/core/scene/factory"
import { groundIndex } from "@/core/scene/queries"
import type { Scene } from "@/core/scene/types"

import { GroundSampler } from "../builders/ground"
import type { TemplateOverlay, ViewState } from "../contracts"
import { DEFAULT_VIEW } from "../engine/defaults"
import { computeLevelPlan } from "../engine/levelPlan"
import { OverlayManager } from "./manager"
import { buildTemplate, cellFillGeometry, drapedOutline, regionBoundaryPairs, TEMPLATE_ORDER, TemplateMaterials } from "./templates"

function scene2(): { scene: Scene; ground: string; upper: string } {
  const scene = createScene({ width: 10, depth: 10 })
  const ground = Object.keys(scene.levels)[0]
  const up = createLevel({ name: "Upper", elevation: 10 })
  scene.levels[up.id] = up
  const f = createFloor(up.id, { x: 0, z: 0, w: 50, d: 50 })
  scene.objects[f.id] = f
  return { scene, ground, upper: up.id }
}

const tpl = (levelId: string, cells: Record<string, number[]>, partial: Partial<TemplateOverlay> = {}): TemplateOverlay => ({
  id: "t1",
  levelId,
  outline: [
    { x: 10, z: 10 },
    { x: 20, z: 10 },
    { x: 20, z: 20 },
  ],
  origin: { x: 10, z: 10 },
  color: "#f97316",
  cells,
  ...partial,
})

describe("template geometry", () => {
  it("fills each covered cell on its level's ground", () => {
    const { scene, upper } = scene2()
    const g = cellFillGeometry(scene, groundIndex(scene), upper, [0, 11])
    const pos = g.getAttribute("position")
    expect(pos.count).toBe(8)
    expect(g.getIndex()!.count).toBe(12)
    for (let k = 0; k < pos.count; k++) expect(pos.getY(k)).toBeCloseTo(10.05)
    // The second cell is (1, 1): x ∈ [5, 10].
    expect([pos.getX(4), pos.getX(5)]).toEqual([5, 10])
  })

  it("outlines the covered region only where it meets uncovered cells", () => {
    const { scene, ground } = scene2()
    // Two cells side by side: 6 outer edges, the shared one left out.
    const pairs = regionBoundaryPairs(scene, groundIndex(scene), ground, [0, 1])
    expect(pairs.length / 6).toBe(6)
    const single = regionBoundaryPairs(scene, groundIndex(scene), ground, [55])
    expect(single.length / 6).toBe(4)
  })

  it("drapes the outline with points at most a foot apart", () => {
    const { scene, ground } = scene2()
    const pts = drapedOutline(groundIndex(scene), ground, [
      { x: 0, z: 0 },
      { x: 10, z: 0 },
    ])
    // 10 ft there and 10 ft back.
    expect(pts).toHaveLength(20)
    expect(pts.every((p) => Math.abs(p.y - 0.1) < 1e-9)).toBe(true)
  })

  it("draws cells only on shown levels, and the outline and origin on its own", () => {
    const { scene, ground, upper } = scene2()
    const materials = new TemplateMaterials()
    const meshes = (root: THREE.Object3D) => root.children.length
    const all = buildTemplate(tpl(ground, { [ground]: [0, 1], [upper]: [22] }), { scene, drawn: () => true, worldPerPixel: 0.1 }, materials)
    // fill + region per level, outline, origin dot.
    expect(meshes(all)).toBe(6)
    all.traverse((o) => expect(o.renderOrder).toBe(TEMPLATE_ORDER))
    const lowerOnly = buildTemplate(tpl(ground, { [ground]: [0], [upper]: [22] }), { scene, drawn: (id) => id === ground, worldPerPixel: 0.1 }, materials)
    expect(meshes(lowerOnly)).toBe(4)
    const neither = buildTemplate(tpl(ground, { [upper]: [22] }), { scene, drawn: (id) => id === upper, worldPerPixel: 0.1 }, materials)
    expect(meshes(neither)).toBe(2)
    // Fills are depth-tested (tokens and walls stand over them); the shape outline is drawn through.
    const fill = all.children[0] as THREE.Mesh
    expect((fill.material as THREE.Material).depthTest).toBe(true)
    const outline = all.children[4] as THREE.Mesh
    expect((outline.material as THREE.Material).depthTest).toBe(false)
    materials.dispose()
  })
})

describe("OverlayManager templates", () => {
  function manager(view: ViewState = { ...DEFAULT_VIEW, mode: "dm-play" }) {
    const s = scene2()
    const plan = computeLevelPlan(
      Object.values(s.scene.levels)
        .sort((a, b) => a.elevation - b.elevation)
        .map((l) => ({ id: l.id })),
      { ...view, activeLevelId: s.ground }
    )
    let wpp = 0.1
    const m = new OverlayManager({
      scene: () => s.scene,
      view: () => view,
      plan: () => plan,
      ground: (id) => GroundSampler.forLevel(s.scene.levels[id], s.scene.grid),
      objectRefs: () => [],
      activeLevelId: () => s.ground,
      worldPerPixel: () => wpp,
      worldPerPixelAt: () => wpp,
      fade: () => ({ x: 25, z: 25, radius: 100 }),
    })
    return { ...s, m, zoom: (v: number) => (wpp = v) }
  }
  const built = (m: OverlayManager) => {
    const out: THREE.Object3D[] = []
    m.root.traverse((o) => {
      if (o.name.startsWith("template:")) out.push(o)
    })
    return out
  }

  it("builds templates, rebuilds only the changed ones and drops removed ones", () => {
    const { m, ground } = manager()
    const a = tpl(ground, { [ground]: [0] })
    const b = tpl(ground, { [ground]: [5] }, { id: "t2" })
    m.set({ templates: [a, b] })
    m.update()
    const first = built(m)
    expect(first.map((o) => o.name).sort()).toEqual(["template:t1", "template:t2"])
    const b2 = { ...b, state: "selected" as const }
    m.set({ templates: [a, b2] })
    m.update()
    const second = built(m)
    expect(second.find((o) => o.name === "template:t1")).toBe(first.find((o) => o.name === "template:t1"))
    expect(second.find((o) => o.name === "template:t2")).not.toBe(first.find((o) => o.name === "template:t2"))
    m.set({ templates: [a] })
    m.update()
    expect(built(m).map((o) => o.name)).toEqual(["template:t1"])
    m.set({ templates: [] })
    m.update()
    expect(built(m)).toHaveLength(0)
    m.dispose()
  })

  it("rebuilds everything when the zoom changes a lot (origin dots keep their pixel size)", () => {
    const { m, ground, zoom } = manager()
    m.set({ templates: [tpl(ground, { [ground]: [0] })] })
    m.update()
    const before = built(m)[0]
    zoom(0.11)
    m.update()
    expect(built(m)[0]).toBe(before)
    zoom(0.5)
    m.update()
    expect(built(m)[0]).not.toBe(before)
    m.dispose()
  })
})
