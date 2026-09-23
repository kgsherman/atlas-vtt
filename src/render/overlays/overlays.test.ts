// @vitest-environment jsdom
import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { createDoor, createLevel, createLight, createProp, createScene, createWall } from "@/core/scene/factory"
import { createHeightmap, denseHeights } from "@/core/scene/heightmap"
import type { Scene } from "@/core/scene/types"

import { BuildContext, buildLevel, BUCKETS } from "../builders"
import { GroundSampler } from "../builders/ground"
import type { ToolPreview, ViewState } from "../contracts"
import { DEFAULT_VIEW } from "../engine/defaults"
import { computeLevelPlan } from "../engine/levelPlan"
import { LevelView } from "../engine/levels"
import { testMaterials } from "../engine/testUtils"
import { buildOutlines, extractTriangles } from "./highlight"
import { lightRingOpacity, OverlayManager } from "./manager"
import { buildToolPreview, disposePreview, drapedRectGeometry } from "./previews"

function setup() {
  const scene: Scene = createScene({ width: 10, depth: 10 })
  const lv = Object.keys(scene.levels)[0]
  const wall = createWall(lv, { x: 0, z: 20 }, { x: 40, z: 20 }, { hidden: true })
  const door = createDoor(wall, 10)
  const crate = createProp(lv, "crate", { x: 25, y: 0, z: 25 })
  for (const o of [wall, door, crate]) scene.objects[o.id] = o
  const m = testMaterials()
  const view = new LevelView(lv, m.level, m.shared)
  const built = buildLevel(new BuildContext(scene), lv)
  for (const k of BUCKETS) view.setBucket(k, built[k])
  view.group.updateMatrixWorld(true)
  return { scene, lv, view, wall, door, crate }
}

/** Anti-aliased overlay lines (materials/aaLineMaterial): outlines, rings, preview outlines. */
const isAALine = (o: THREE.Object3D) => (o as THREE.Mesh).isMesh && ((o as THREE.Mesh).material as THREE.Material).name === "atlas-overlay-aa-line"

const count = (root: THREE.Object3D, pred: (o: THREE.Object3D) => boolean) => {
  let n = 0
  root.traverse((o) => {
    if (pred(o)) n++
  })
  return n
}

describe("outlines", () => {
  it("extracts an object's triangles from a merged mesh", () => {
    const { view, wall } = setup()
    const [ref] = view.objectRefs(wall.id)
    if (ref.kind !== "ranges") throw new Error("expected ranges")
    const tri = extractTriangles(ref.mesh.geometry, ref.ranges)
    const expected = ref.ranges.reduce((s, r) => s + r.count, 0)
    expect(tri.getAttribute("position").count).toBe(expected * 3)
  })

  it("builds world-space and attached outlines", () => {
    const { view, wall, door, crate } = setup()
    const mat = new THREE.LineBasicMaterial()
    const w = buildOutlines(view.objectRefs(wall.id), mat)
    expect(w).toHaveLength(1)
    expect(w[0].attachTo).toBeNull()
    expect(w[0].line.geometry.getAttribute("position").count).toBeGreaterThan(0)
    const d = buildOutlines(view.objectRefs(door.id), mat)
    expect(d.every((o) => o.attachTo !== null)).toBe(true)
    const c = buildOutlines(view.objectRefs(crate.id), mat)
    const pos = new THREE.Vector3().setFromMatrixPosition(c[0].line.matrix)
    expect(pos.x).toBeCloseTo(25)
  })
})

describe("tool previews", () => {
  const scene = createScene({ width: 10, depth: 10 })
  const lv = Object.keys(scene.levels)[0]
  const ground = () => GroundSampler.forLevel(scene.levels[lv], scene.grid)
  const ghostScene = createScene({ width: 10, depth: 10 })
  const gl = Object.keys(ghostScene.levels)[0]
  const gw = createWall(gl, { x: 0, z: 0 }, { x: 10, z: 0 })
  ghostScene.objects[gw.id] = gw
  ghostScene.objects["door"] = { ...createDoor(gw, 5), id: "door" }
  ghostScene.objects["crate"] = { ...createProp(gl, "crate", { x: 5, y: 0, z: 5 }), id: "crate" }
  const previews: ToolPreview[] = [
    { kind: "rect", levelId: lv, rect: { x: 0, z: 0, w: 10, d: 5 } },
    { kind: "segment", levelId: lv, a: { x: 0, z: 0 }, b: { x: 10, z: 0 }, height: 10, thickness: 0.5, valid: true },
    { kind: "segment", levelId: lv, a: { x: 0, z: 0 }, b: { x: 0, z: 0 }, height: 10, thickness: 0.5, valid: false },
    { kind: "opening", levelId: lv, a: { x: 2, z: 0 }, b: { x: 6, z: 0 }, height: 3, sill: 3, valid: true },
    { kind: "point", levelId: lv, position: { x: 5, y: 4, z: 5 }, radius: 20, color: "#ff0000" },
    { kind: "brush", levelId: lv, center: { x: 10, z: 10 }, radius: 6, mode: "lower" },
    { kind: "ghost-objects", scene: ghostScene, offset: { x: 5, z: 5 } },
  ]
  for (const p of previews) {
    it(`builds a ${p.kind} preview`, () => {
      const root = buildToolPreview(p, { ground: () => ground(), scene, worldPerPixel: 0.1 })
      expect(count(root, (o) => (o as THREE.Mesh).isMesh)).toBeGreaterThan(0)
      // Outlines are anti-aliased quads, never 1-px GL lines.
      expect(count(root, (o) => (o as THREE.Line).isLine)).toBe(0)
      if (p.kind !== "brush" && p.kind !== "ghost-objects") expect(count(root, isAALine)).toBeGreaterThan(0)
      root.traverse((o) => {
        const g = (o as THREE.Mesh).geometry
        if (!g) return
        const pos = g.getAttribute("position")
        for (let k = 0; k < pos.count; k++) expect(Number.isFinite(pos.getY(k))).toBe(true)
      })
      disposePreview(root)
    })
  }

  it("places point previews relative to the level ground", () => {
    const root = buildToolPreview(previews[4], { ground: () => ground(), scene, worldPerPixel: 0.1 })
    const marker = root.children[0] as THREE.Mesh
    expect(marker.position.y).toBeCloseTo(4)
  })

  it("drapes rects on terrain", () => {
    const heights = denseHeights(createHeightmap(1), scene.grid).heights.slice()
    heights[1 * 11 + 1] = 2
    const g = GroundSampler.fromDense(scene.levels[lv], scene.grid, heights)!
    const geo = drapedRectGeometry({ x: 0, z: 0, w: 10, d: 10 }, g, 0)
    const pos = geo.getAttribute("position")
    let top = -Infinity
    for (let k = 0; k < pos.count; k++) top = Math.max(top, pos.getY(k))
    expect(top).toBeCloseTo(2)
  })
})

describe("OverlayManager", () => {
  function manager(viewPatch: Partial<ViewState> = {}) {
    const s = setup()
    const view: ViewState = { ...DEFAULT_VIEW, ...viewPatch }
    const plan = computeLevelPlan([{ id: s.lv }], view)
    const m = new OverlayManager({
      scene: () => s.scene,
      view: () => view,
      plan: () => plan,
      ground: (id) => GroundSampler.forLevel(s.scene.levels[id], s.scene.grid),
      objectRefs: (id) => s.view.objectRefs(id),
      activeLevelId: () => s.lv,
      worldPerPixel: () => 0.1,
      worldPerPixelAt: () => 0.1,
      fade: () => ({ x: 25, z: 25, radius: 100 }),
    })
    return { ...s, m }
  }

  it("draws the grid, selection, hover and helper outlines", () => {
    const { m, crate, door, view } = manager()
    m.set({ selectedIds: [crate.id], hoveredId: door.id })
    m.update()
    expect(m.gridRoot.visible).toBe(true)
    expect(m.grid.mesh.geometry.getAttribute("position").count).toBeGreaterThan(0)
    // Selection outline in the overlay root; the door's hover outline follows the leaf.
    expect(count(m.root, isAALine)).toBeGreaterThanOrEqual(2)
    const leafMesh = view.doorLeaves()[0].mesh
    expect(leafMesh.children.some(isAALine)).toBe(true)
  })

  it("draws rulers, pending paths and previews, and clears them", () => {
    const { m, scene, lv } = manager()
    const token = Object.values(scene.tokens)[0]
    const visibleMeshes = () => count(m.root, (o) => (o as THREE.Mesh).isMesh && o.visible && !(o as THREE.InstancedMesh).isInstancedMesh && o.type !== "Sprite")
    m.update()
    // The hidden wall's helper outline stays.
    const baseline = visibleMeshes()
    m.set({
      ruler: { levelId: lv, points: [{ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }], label: "10 ft" },
      pendingMoves: { [token?.id ?? "t"]: [{ cell: { i: 0, j: 0 }, levelId: lv }, { cell: { i: 3, j: 0 }, levelId: lv }] },
      preview: { kind: "rect", levelId: lv, rect: { x: 0, z: 0, w: 5, d: 5 } },
    })
    m.update()
    const meshes = () => count(m.root, (o) => (o as THREE.Mesh).isMesh)
    expect(meshes()).toBeGreaterThan(3)
    expect(m.rulerAnchor()).toEqual({ x: 10, y: 0, z: 0 })
    m.set({ ruler: null, pendingMoves: {}, preview: null })
    m.update()
    expect(visibleMeshes()).toBe(baseline)
  })

  it("draws light rings for the active level's lights and selected lights only", () => {
    const s = setup()
    const upper = createLevel({ name: "Upper", elevation: 10 })
    s.scene.levels[upper.id] = upper
    const here = createLight(s.lv, "torch", { x: 10, z: 10 })
    const above = createLight(upper.id, "torch", { x: 30, z: 30 })
    for (const o of [here, above]) s.scene.objects[o.id] = o
    const view: ViewState = { ...DEFAULT_VIEW }
    const plan = computeLevelPlan([{ id: s.lv }, { id: upper.id }], view)
    const m = new OverlayManager({
      scene: () => s.scene,
      view: () => view,
      plan: () => plan,
      ground: (id) => GroundSampler.forLevel(s.scene.levels[id], s.scene.grid),
      objectRefs: (id) => s.view.objectRefs(id),
      activeLevelId: () => s.lv,
      worldPerPixel: () => 0.1,
      worldPerPixelAt: () => 0.1,
      fade: () => ({ x: 25, z: 25, radius: 100 }),
    })
    const rings = () => count(m.root, (o) => isAALine(o) && o.userData.ownMaterial === true)
    m.update()
    expect(rings()).toBe(2)
    m.set({ selectedIds: [above.id] })
    m.update()
    expect(rings()).toBe(4)
  })

  it("keeps unselected rings faint and dims lights that are off", () => {
    const [b, d] = lightRingOpacity(true, false)
    const [sb, sd] = lightRingOpacity(true, true)
    expect(sb).toBeGreaterThan(b)
    expect(sd).toBeGreaterThan(d)
    expect(lightRingOpacity(false, false)[0]).toBeLessThan(b)
    expect(b).toBeGreaterThan(d)
  })

  it("hides helpers in player mode", () => {
    const { m } = manager({ mode: "player" })
    m.update()
    expect(count(m.root, isAALine)).toBe(0)
    // No 1-px GL lines anywhere in the overlays (the canvas has no MSAA).
    const { m: dm } = manager()
    dm.update()
    expect(count(dm.root, isAALine)).toBeGreaterThan(0)
    expect(count(dm.root, (o) => (o as THREE.Line).isLine)).toBe(0)
  })
})
