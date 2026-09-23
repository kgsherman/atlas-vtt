// @vitest-environment jsdom
import * as THREE from "three"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GIZMO_SHAFT_END_PX, GIZMO_SHAFT_START_PX, gizmoHandles, type GizmoAxis, type Projector } from "@/core/geometry/gizmo"
import { createScene } from "@/core/scene/factory"
import { bakeRegion, blockShape, cylinderShape, rampShape, translateVertices, triangulateFootprint } from "@/core/scene/terrainShapes"
import type { TerrainShape, Vec3 } from "@/core/scene/types"

import { GroundSampler } from "../builders/ground"
import type { TerrainOverlay } from "../contracts"
import { buildToolPreview, disposePreview } from "./previews"
import {
  buildTerrainOverlay,
  MARQUEE_STYLE,
  marqueeMesh,
  shapePrism,
  TERRAIN_OVERLAY_COLORS,
  topLift,
  TERRAIN_OVERLAY_ORDER,
  TerrainOverlayResources,
  type ShapePrism,
} from "./terrainOverlay"

const ELEVATION = 10
/** Terrain lattice spacing (resolution 2). */
const SPACING = 2.5

function fakeCtx(): CanvasRenderingContext2D {
  const noop = () => {}
  return {
    font: "",
    fillStyle: "",
    textBaseline: "",
    textAlign: "",
    measureText: (t: string) => ({ width: t.length * 14 }),
    beginPath: noop,
    moveTo: noop,
    arcTo: noop,
    closePath: noop,
    fill: noop,
    fillText: noop,
  } as unknown as CanvasRenderingContext2D
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(fakeCtx as never)
})
afterEach(() => vi.restoreAllMocks())

const block = (id = "b1", x = 0) => blockShape(id, { x, z: 0, w: 10, d: 5 }, 1, 4, 0)
const carve = (id = "c1") => blockShape(id, { x: 20, z: 0, w: 5, d: 5 }, 0, -3, 1)

function overlay(patch: Partial<TerrainOverlay> = {}): TerrainOverlay {
  return {
    kind: "terrain",
    levelId: "lv",
    shapes: [block(), carve()],
    selectedShapeIds: [],
    hoverShapeId: null,
    elements: null,
    draft: null,
    gizmo: null,
    brush: null,
    label: null,
    ...patch,
  }
}

/** Triangle normals of a non-indexed position array. */
function normals(tris: Float32Array): THREE.Vector3[] {
  const out: THREE.Vector3[] = []
  for (let o = 0; o + 8 < tris.length; o += 9) {
    const a = new THREE.Vector3(tris[o], tris[o + 1], tris[o + 2])
    const b = new THREE.Vector3(tris[o + 3], tris[o + 4], tris[o + 5])
    const c = new THREE.Vector3(tris[o + 6], tris[o + 7], tris[o + 8])
    out.push(b.sub(a).cross(c.sub(a)))
  }
  return out
}

/** Every side triangle faces away from the footprint's centroid (horizontally). */
function expectOutwardSides(prism: ShapePrism, shape: TerrainShape): void {
  const cx = shape.points.reduce((s, p) => s + p.x, 0) / shape.points.length
  const cz = shape.points.reduce((s, p) => s + p.z, 0) / shape.points.length
  const n = normals(prism.sides)
  for (let t = 0; t < n.length; t++) {
    const o = t * 9
    const mx = (prism.sides[o] + prism.sides[o + 3] + prism.sides[o + 6]) / 3
    const mz = (prism.sides[o + 2] + prism.sides[o + 5] + prism.sides[o + 8]) / 3
    expect(Math.abs(n[t].y)).toBeLessThan(1e-6)
    expect(n[t].x * (mx - cx) + n[t].z * (mz - cz)).toBeGreaterThan(0)
  }
}

const segments = (edges: Float32Array) => edges.length / 6
const triangles = (tris: Float32Array) => tris.length / 9

describe("shape prisms", () => {
  it("meshes a block: two top triangles facing up, four side quads facing out, 12 edges", () => {
    const s = block()
    const p = shapePrism(s, ELEVATION)
    expect(triangles(p.top)).toBe(2)
    for (const n of normals(p.top)) expect(n.y).toBeGreaterThan(0)
    expect(triangles(p.sides)).toBe(8)
    expectOutwardSides(p, s)
    expect(Array.from(p.sideStart)).toEqual([0, 18, 36, 54, 72])
    // Top outline, vertical edges, base outline.
    expect(segments(p.edges)).toBe(12)
    expect(p.vertices.length).toBe(12)
    // World Y = elevation + value: top 5, base 1.
    const ys = new Set(Array.from(p.sides).filter((_, k) => k % 3 === 1))
    expect([...ys].sort()).toEqual([ELEVATION + 1, ELEVATION + 5])
  })

  it("meshes a ramp without degenerate sides or duplicate edges on its low edge", () => {
    const s = rampShape("r", { x: 0, z: 0, w: 10, d: 10 }, 0, 0, 5, 0)
    const p = shapePrism(s, 0)
    expect(triangles(p.top)).toBe(2)
    for (const n of normals(p.top)) expect(n.y).toBeGreaterThan(0)
    // Low edge: no side; the two sloped sides are triangles; the high side is a quad.
    expect(triangles(p.sides)).toBe(4)
    expectOutwardSides(p, s)
    expect(p.sideStart[1] - p.sideStart[0]).toBe(0)
    // 4 top edges + 2 vertical edges (high corners) + 3 base edges (the low one is the top edge).
    expect(segments(p.edges)).toBe(9)
    for (const n of normals(p.sides)) expect(n.length()).toBeGreaterThan(1e-9)
  })

  it("meshes a cylinder and a carve (pit floor facing up, pit walls facing out)", () => {
    const c = cylinderShape("cy", { x: 50, z: 50 }, 8, 24, 0, 6, 0)
    const p = shapePrism(c, 0)
    expect(triangles(p.top)).toBe(22)
    expect(triangles(p.sides)).toBe(48)
    expect(segments(p.edges)).toBe(72)
    expectOutwardSides(p, c)
    const pit = carve()
    const q = shapePrism(pit, ELEVATION)
    expect(triangles(q.top)).toBe(2)
    for (const n of normals(q.top)) expect(n.y).toBeGreaterThan(0)
    expect(triangles(q.sides)).toBe(8)
    expectOutwardSides(q, pit)
    expect(Math.min(...Array.from(q.top).filter((_, k) => k % 3 === 1))).toBe(ELEVATION - 3)
  })

  it("caches prisms by shape object identity and elevation", () => {
    const s = block()
    const p = shapePrism(s, 0)
    expect(shapePrism(s, 0)).toBe(p)
    // An equal but new object (an edit makes a new object) is meshed again.
    expect(shapePrism({ ...s, points: s.points.map((q) => ({ ...q })) }, 0)).not.toBe(p)
    const moved = shapePrism(s, 5)
    expect(moved).not.toBe(p)
    expect(moved.top[1]).toBe(p.top[1] + 5)
  })
})

/** Y of the triangle soup `tris` over (x, z) (the highest where triangles meet), null outside it. */
function surfaceAt(tris: Float32Array, x: number, z: number): number | null {
  let best: number | null = null
  for (let o = 0; o + 8 < tris.length; o += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tris.subarray(o, o + 9)
    const det = (bx - ax) * (cz - az) - (cx - ax) * (bz - az)
    const u = ((x - ax) * (cz - az) - (cx - ax) * (z - az)) / det
    const v = ((bx - ax) * (z - az) - (x - ax) * (bz - az)) / det
    if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue
    const y = ay + u * (by - ay) + v * (cy - ay)
    if (best === null || y > best) best = y
  }
  return best
}

describe("shape prisms on the baked terrain", () => {
  /** A 6 ft block with the corner that only one top triangle holds raised to 9 ft (the advanced mode's vertex drag). */
  function raisedCorner(): TerrainShape {
    const flat = blockShape("s", { x: 90, z: 65, w: 20, d: 15 }, 0, 6, 0)
    const tris = triangulateFootprint(flat.points)
    const corner = flat.points.findIndex((_, k) => tris.filter((t) => t === k).length === 1)
    return translateVertices(flat, [corner], { x: 0, y: 3, z: 0 })!
  }
  /** The terrain the renderer draws (GroundSampler: linear over each lattice triangle): `shapes` baked on the 2.5 ft lattice. */
  function baked(shapes: TerrainShape[]): GroundSampler {
    const n = 81
    const lattice = { samplesX: n, samplesZ: n, spacing: SPACING, heights: new Float32Array(n * n) }
    bakeRegion(lattice, shapes, null)
    return new GroundSampler(ELEVATION, SPACING, n, n, lattice.heights)
  }
  /** How far the terrain rises above the surface `tris` over the block's inner lattice cells (x 92.5..107.5, z 67.5..77.5). */
  function cut(tris: Float32Array, ground: GroundSampler): number {
    let worst = -Infinity
    for (let x = 92.5; x <= 107.5; x += 0.25) {
      for (let z = 67.5; z <= 77.5; z += 0.25) worst = Math.max(worst, ground.heightAt(x, z) - surfaceAt(tris, x, z)!)
    }
    return worst
  }

  it("lifts the depth-tested top of a non-planar shape above the terrain its bake interpolates", () => {
    const shape = raisedCorner()
    const ground = baked([shape])
    const p = shapePrism(shape, ELEVATION, SPACING)
    // The lattice chord rises above the valley crease: the unlifted fill fails the depth test there.
    expect(cut(p.top, ground)).toBeGreaterThan(0.1)
    // Slopes 0 and (0.15, 0.2): lifted by 2.5 · √2/2 · 0.25/2 (the worst chord is 2.5·√2 · 0.25/4 above).
    expect(p.topLift).toBeCloseTo(SPACING * Math.SQRT1_2 * 0.125, 6)
    expect(cut(p.liftedTop, ground)).toBeLessThanOrEqual(1e-4)
    // Only Y moves.
    for (let k = 0; k < p.top.length; k++) expect(p.liftedTop[k]).toBeCloseTo(p.top[k] + (k % 3 === 1 ? p.topLift : 0), 5)
    // Without a lattice there is nothing to clear.
    expect(shapePrism(shape, ELEVATION).topLift).toBe(0)
  })

  it("draws the lifted top in the depth-tested fill only (x-ray fill and edges stay on the true top)", () => {
    const shape = raisedCorner()
    const p = shapePrism(shape, ELEVATION, SPACING)
    const maxY = (g: THREE.BufferGeometry) => Math.max(...Array.from(g.getAttribute("position").array).filter((_, k) => k % 3 === 1))
    const res = new TerrainOverlayResources()
    for (const patch of [{ shapes: [shape], selectedShapeIds: ["s"] }, { shapes: [shape] }, { shapes: [], draft: { shape, valid: true } }]) {
      const root = buildTerrainOverlay(overlay(patch), ELEVATION, SPACING, res)
      const fills = meshes(root).filter((m) => (m.material as THREE.Material).type === "MeshBasicMaterial")
      const solid = fills.find((m) => mat(m).depthTest)!
      const xray = fills.find((m) => !mat(m).depthTest)!
      expect(solid.geometry).not.toBe(xray.geometry)
      expect(maxY(solid.geometry)).toBeCloseTo(ELEVATION + 9 + p.topLift, 5)
      expect(maxY(xray.geometry)).toBe(ELEVATION + 9)
      disposePreview(root)
    }
    expect(Math.max(...Array.from(p.edges).filter((_, k) => k % 3 === 1))).toBe(ELEVATION + 9)
    // The lifted faces are cached with the layer and freed with it.
    const layer = res.selected.get([shape], ELEVATION, SPACING)
    const disposed = vi.fn()
    layer.add.depthFaces!.addEventListener("dispose", disposed)
    expect(layer.add.depthFaces!.userData.cached).toBe(true)
    res.release()
    expect(disposed).toHaveBeenCalled()
    res.dispose()
  })

  it("does not lift planar tops (blocks, ramps, cylinders, pits)", () => {
    const shapes = [block(), carve(), rampShape("r", { x: 0, z: 0, w: 10, d: 10 }, 0, 0, 5, 0), cylinderShape("cy", { x: 50, z: 50 }, 8, 24, 0, 6, 0)]
    for (const s of shapes) {
      const p = shapePrism(s, ELEVATION, SPACING)
      expect(p.topLift).toBe(0)
      expect(p.liftedTop).toBe(p.top)
    }
    // Their layers keep one faces geometry for both fills.
    const res = new TerrainOverlayResources()
    const g = res.unselected.get(shapes, ELEVATION, SPACING)
    expect(g.add.depthFaces).toBe(g.add.faces)
    expect(g.carve.depthFaces).toBe(g.carve.faces)
    res.dispose()
    // A steep thin triangle: the lift never exceeds the top's height range. A degenerate one has no slope.
    const flatTri = [0, 0, 0, 1, 0, 0, 0, 0, 1]
    expect(topLift(new Float32Array([...flatTri, 0, 0, 0, 1, 0, 0, 0.5, 0.5, 1e-6]), SPACING)).toBe(0.5)
    expect(topLift(new Float32Array([...flatTri, 0, 0, 0, 1, 0, 0, 2, 5, 1e-12]), SPACING)).toBe(0)
  })
})

/** Meshes below a root with their materials. */
function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh)
  })
  return out
}
const mat = (m: THREE.Mesh) => m.material as THREE.Material & { opacity?: number; uniforms?: Record<string, { value: unknown }> }

describe("terrain overlay", () => {
  it("draws faces twice: depth-tested with a polygon offset, and a dimmer x-ray pass first", () => {
    const res = new TerrainOverlayResources()
    const root = buildTerrainOverlay(overlay(), ELEVATION, SPACING, res)
    const fills = meshes(root).filter((m) => (m.material as THREE.Material).type === "MeshBasicMaterial")
    // add + carve, each x-ray + depth-tested.
    expect(fills).toHaveLength(4)
    for (const g of new Set(fills.map((m) => m.geometry))) {
      const pair = fills.filter((m) => m.geometry === g)
      const xray = pair.find((m) => !mat(m).depthTest)!
      const solid = pair.find((m) => mat(m).depthTest)!
      expect(solid.material).toMatchObject({ polygonOffset: true, depthWrite: false, transparent: true })
      expect(mat(solid).polygonOffsetFactor).toBeLessThan(0)
      expect(mat(xray).opacity!).toBeLessThan(mat(solid).opacity!)
      expect(xray.renderOrder).toBeLessThan(solid.renderOrder)
    }
    // Anti-aliased edges, depth-tested and x-ray.
    const lines = meshes(root).filter((m) => (m.material as THREE.Material).name === "atlas-overlay-aa-line")
    expect(lines.map((m) => mat(m).depthTest).sort()).toEqual([false, false, true, true])
    // Carves are orange, adds green.
    const colors = fills.map((m) => "#" + (m.material as THREE.MeshBasicMaterial).color.getHexString())
    expect(new Set(colors)).toEqual(new Set([TERRAIN_OVERLAY_COLORS.add, TERRAIN_OVERLAY_COLORS.carve]))
    res.dispose()
  })

  it("reuses the unselected layer's geometry across rebuilds and while the selection is dragged", () => {
    const res = new TerrainOverlayResources()
    const shapes = [block("a"), block("b", 20), block("c", 40)]
    const geos = (root: THREE.Object3D) => new Set(meshes(root).map((m) => m.geometry))
    const first = buildTerrainOverlay(overlay({ shapes, selectedShapeIds: ["b"] }), 0, SPACING, res)
    const normal0 = res.unselected.get([shapes[0], shapes[2]], 0, SPACING)
    const selected0 = res.selected.get([shapes[1]], 0, SPACING)
    // A new overlay object and a new (equal) array: nothing is re-meshed.
    const again = buildTerrainOverlay(overlay({ shapes: shapes.slice(), selectedShapeIds: ["b"] }), 0, SPACING, res)
    expect(geos(again)).toEqual(geos(first))
    // Dragging "b" (a new object) keeps the unselected layer.
    const dragged = { ...shapes[1], points: shapes[1].points.map((p) => ({ ...p, x: p.x + 1 })) }
    const drag = buildTerrainOverlay(overlay({ shapes: [shapes[0], dragged, shapes[2]], selectedShapeIds: ["b"] }), 0, SPACING, res)
    expect(res.unselected.get([shapes[0], shapes[2]], 0, SPACING)).toBe(normal0)
    expect(res.selected.get([dragged], 0, SPACING)).not.toBe(selected0)
    expect(geos(drag).has(normal0.add.faces!)).toBe(true)
    expect(normal0.add.faces!.userData.cached).toBe(true)
    res.dispose()
  })

  it("disposes its own geometry but never the cached geometry or the shared materials", () => {
    const res = new TerrainOverlayResources()
    const scene = createScene({ width: 10, depth: 10 })
    const lv = Object.keys(scene.levels)[0]
    const ground = GroundSampler.forLevel(scene.levels[lv], scene.grid)
    const shapes = [block("a"), block("b", 20)]
    const p = overlay({
      levelId: lv,
      shapes,
      selectedShapeIds: ["a"],
      hoverShapeId: "b",
      draft: { shape: block("d", 30), valid: true },
      brush: { center: { x: 5, z: 5 }, radius: 3, mode: "raise" },
    })
    const root = buildToolPreview(p, { ground: () => ground, scene, worldPerPixel: 0.1, terrain: res })
    const disposed = new Set<unknown>()
    const all = meshes(root)
    for (const m of all) {
      m.geometry.addEventListener("dispose", () => disposed.add(m.geometry))
      ;(m.material as THREE.Material).addEventListener("dispose", () => disposed.add(m.material))
    }
    disposePreview(root)
    const cached = all.filter((m) => m.geometry.userData.cached)
    const shared = all.filter((m) => (m.material as THREE.Material).userData.shared)
    expect(cached.length).toBeGreaterThan(0)
    expect(shared.length).toBeGreaterThan(0)
    for (const m of cached) expect(disposed.has(m.geometry)).toBe(false)
    for (const m of shared) expect(disposed.has(m.material)).toBe(false)
    // Hover / draft / brush ring geometry and the ring's own materials are freed.
    const owned = all.filter((m) => !m.geometry.userData.cached)
    expect(owned.length).toBeGreaterThan(0)
    for (const m of owned) expect(disposed.has(m.geometry)).toBe(true)
    // Leaving the mode frees the cached layers.
    res.release()
    for (const m of cached) expect(disposed.has(m.geometry)).toBe(true)
    res.dispose()
  })

  it("keeps its own draw order and draws the brush ring above the shapes", () => {
    const scene = createScene({ width: 10, depth: 10 })
    const lv = Object.keys(scene.levels)[0]
    const ground = GroundSampler.forLevel(scene.levels[lv], scene.grid)
    const res = new TerrainOverlayResources()
    const root = buildToolPreview(overlay({ levelId: lv, brush: { center: { x: 5, z: 5 }, radius: 3, mode: "lower" } }), {
      ground: () => ground,
      scene,
      worldPerPixel: 0.1,
      terrain: res,
    })
    const orders = meshes(root).map((m) => m.renderOrder)
    expect(orders.every((o) => o > 12 && o < 13)).toBe(true)
    expect(Math.max(...orders)).toBe(TERRAIN_OVERLAY_ORDER.brush)
    disposePreview(root)
    // Without the manager's resources the preview owns (and frees) its own.
    const own = buildToolPreview(overlay({ levelId: lv }), { ground: () => ground, scene, worldPerPixel: 0.1 })
    const res2 = own.userData.ownedResources as TerrainOverlayResources
    expect(res2).toBeInstanceOf(TerrainOverlayResources)
    const spy = vi.spyOn(res2, "dispose")
    disposePreview(own)
    expect(spy).toHaveBeenCalled()
    res.dispose()
  })

  it("styles the selection, the hovered shape and the draft", () => {
    const res = new TerrainOverlayResources()
    const colorsOf = (root: THREE.Object3D) =>
      new Set(
        meshes(root).map((m) => {
          const x = m.material as THREE.MeshBasicMaterial & THREE.ShaderMaterial
          return "#" + (x.color ?? x.uniforms.uColor.value).getHexString()
        })
      )
    const C = TERRAIN_OVERLAY_COLORS
    const sel = colorsOf(buildTerrainOverlay(overlay({ selectedShapeIds: ["b1"], hoverShapeId: "c1" }), 0, SPACING, res))
    expect(sel.has(C.addBright)).toBe(true)
    expect(sel.has(C.carveLight)).toBe(true)
    const draft = colorsOf(buildTerrainOverlay(overlay({ shapes: [], draft: { shape: block("d"), valid: true } }), 0, SPACING, res))
    expect(draft.has(C.draft)).toBe(true)
    const invalid = colorsOf(buildTerrainOverlay(overlay({ shapes: [], draft: { shape: block("d"), valid: false } }), 0, SPACING, res))
    expect([...invalid]).toEqual([C.invalid])
    // A zero-height draft (base phase) is its top face and outline only.
    const flat = shapePrism(blockShape("z", { x: 0, z: 0, w: 5, d: 5 }, 2, 0, 0), 0)
    expect(triangles(flat.sides)).toBe(0)
    expect(segments(flat.edges)).toBe(4)
    res.dispose()
  })

  it("shows the advanced mode's vertices and highlights selected and hovered elements", () => {
    const res = new TerrainOverlayResources()
    const a = block("a")
    const b = block("b", 20)
    const root = buildTerrainOverlay(
      overlay({
        shapes: [a, b],
        selectedShapeIds: ["a", "b"],
        elements: {
          mode: "vertex",
          selected: [
            { shapeId: "a", kind: "vertex", index: 2 },
            { shapeId: "b", kind: "edge", index: 1 },
            { shapeId: "a", kind: "face", index: "top" },
            { shapeId: "a", kind: "face", index: 3 },
            // Ignored: out of range, unselected shape.
            { shapeId: "a", kind: "vertex", index: 9 },
            { shapeId: "zz", kind: "vertex", index: 0 },
          ],
          hover: { shapeId: "b", kind: "vertex", index: 0 },
        },
      }),
      0,
      SPACING,
      res
    )
    const dots = meshes(root).filter((m) => (m.material as THREE.Material).name === "atlas-overlay-aa-point")
    // All 8 vertices (4 quad corners each), the selected vertex, the hovered vertex.
    expect(dots.map((m) => m.geometry.getAttribute("position").count).sort((p, q) => p - q)).toEqual([4, 4, 32])
    const C = TERRAIN_OVERLAY_COLORS
    const element = meshes(root).filter((m) => m.renderOrder >= TERRAIN_OVERLAY_ORDER.face && m.renderOrder < TERRAIN_OVERLAY_ORDER.dot)
    // Faces (top 2 + side 2 triangles), face outlines, the selected edge.
    const faceMesh = element.find((m) => (m.material as THREE.Material).type === "MeshBasicMaterial")!
    expect(faceMesh.geometry.getAttribute("position").count).toBe(12)
    expect("#" + (faceMesh.material as THREE.MeshBasicMaterial).color.getHexString()).toBe(C.element)
    expect(mat(faceMesh).depthTest).toBe(false)
    expect(element.filter((m) => (m.material as THREE.Material).name === "atlas-overlay-aa-line")).toHaveLength(2)
    // Edge mode: no vertex dots for the whole selection.
    const edgeMode = buildTerrainOverlay(
      overlay({ shapes: [a, b], selectedShapeIds: ["a"], elements: { mode: "edge", selected: [], hover: null } }),
      0,
      SPACING,
      res
    )
    expect(meshes(edgeMode).some((m) => (m.material as THREE.Material).name === "atlas-overlay-aa-point")).toBe(false)
    res.dispose()
  })
})

// ---------------------------------------------------------------------------
// Gizmo: the drawn arrows are gizmoHandles' shafts
// ---------------------------------------------------------------------------

const W = 800
const H = 600
const RATIO = 2

function projectorOf(camera: THREE.Camera): Projector {
  return (p: Vec3) => {
    const v = new THREE.Vector3(p.x, p.y, p.z).project(camera)
    const x = ((v.x + 1) / 2) * W
    const y = ((1 - v.y) / 2) * H
    return { x, y, visible: v.z >= -1 && v.z <= 1 && x >= 0 && y >= 0 && x <= W && y <= H }
  }
}

const fakeRenderer = {
  getCurrentViewport: (v: THREE.Vector4) => v.set(0, 0, W * RATIO, H * RATIO),
  getPixelRatio: () => RATIO,
} as unknown as THREE.WebGLRenderer

/** Where GIZMO_ARROW_VERTEX puts a corner at `offset` CSS px (canvas CSS px), from the material's uniforms. */
function drawnAt(
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>,
  camera: THREE.Camera,
  offset: { x: number; y: number }
): { x: number; y: number } {
  mesh.material.onBeforeRender(fakeRenderer, new THREE.Scene(), camera, mesh.geometry, mesh, null as unknown as THREE.Group)
  const u = mesh.material.uniforms
  mesh.updateMatrixWorld(true)
  camera.updateMatrixWorld(true)
  const clip = new THREE.Vector4(0, 0, 0, 1)
    .applyMatrix4(new THREE.Matrix4().multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld))
    .applyMatrix4(camera.projectionMatrix)
  const d = { x: u.uDir.value.x, y: -u.uDir.value.y }
  const n = { x: -d.y, y: d.x }
  const vp = u.uViewport.value as THREE.Vector4
  const ratio = u.uPixelRatio.value as number
  clip.x += (((d.x * offset.x + n.x * offset.y) * ratio) / (vp.z * 0.5)) * clip.w
  clip.y += (((d.y * offset.x + n.y * offset.y) * ratio) / (vp.w * 0.5)) * clip.w
  return { x: ((clip.x / clip.w + 1) / 2) * W, y: ((1 - clip.y / clip.w) / 2) * H }
}

function orbitCamera(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(50, W / H, 0.5, 2000)
  c.position.set(-40, 60, 70)
  c.lookAt(10, 0, 5)
  c.updateMatrixWorld(true)
  return c
}

function topDownCamera(): THREE.OrthographicCamera {
  const c = new THREE.OrthographicCamera(-40, 40, 30, -30, 0.1, 1000)
  c.position.set(10, 200, 5)
  c.up.set(0, 0, -1)
  c.lookAt(10, 0, 5)
  c.updateMatrixWorld(true)
  return c
}

describe("terrain overlay gizmo", () => {
  const at = { x: 10, y: 4, z: 5 }
  for (const [name, camera] of [
    ["perspective orbit", orbitCamera()],
    ["top-down ortho", topDownCamera()],
  ] as const) {
    it(`draws the tool's hit-test shafts (${name})`, () => {
      const res = new TerrainOverlayResources()
      buildTerrainOverlay(overlay({ gizmo: { at, active: null, hover: null } }), 0, SPACING, res)
      const project = projectorOf(camera)
      res.frame(project, () => 0.1)
      const handles = gizmoHandles(project, at)
      expect(handles.x.visible && handles.z.visible).toBe(true)
      for (const axis of ["x", "y", "z"] as GizmoAxis[]) {
        const mesh = res.arrows[axis]
        expect(mesh.visible).toBe(handles[axis].visible)
        if (!handles[axis].visible) continue
        const from = drawnAt(mesh, camera, { x: GIZMO_SHAFT_START_PX, y: 0 })
        const to = drawnAt(mesh, camera, { x: GIZMO_SHAFT_END_PX, y: 0 })
        expect(from.x).toBeCloseTo(handles[axis].from.x, 6)
        expect(from.y).toBeCloseTo(handles[axis].from.y, 6)
        expect(to.x).toBeCloseTo(handles[axis].to.x, 6)
        expect(to.y).toBeCloseTo(handles[axis].to.y, 6)
      }
      if (name === "top-down ortho") expect(res.arrows.y.visible).toBe(false)
      else expect(res.arrows.y.visible).toBe(true)
      expect(res.gizmoCentre.visible).toBe(true)
      res.dispose()
    })
  }

  it("highlights the hovered and active axes, hides without a gizmo or projector", () => {
    const res = new TerrainOverlayResources()
    const C = TERRAIN_OVERLAY_COLORS
    const color = (axis: GizmoAxis) => "#" + (res.arrows[axis].material.uniforms.uColor.value as THREE.Color).getHexString()
    buildTerrainOverlay(overlay({ gizmo: { at, active: null, hover: "x" } }), 0, SPACING, res)
    expect(color("x")).toBe(C.gizmoLight.x)
    expect(color("z")).toBe(C.gizmo.z)
    buildTerrainOverlay(overlay({ gizmo: { at, active: "z", hover: "x" } }), 0, SPACING, res)
    expect(color("z")).toBe(C.gizmoLight.z)
    expect(color("x")).toBe(C.gizmo.x)
    expect(res.arrows.x.material.uniforms.uOpacity.value).toBeLessThan(1)
    res.frame(null, () => 0.1)
    expect(res.arrows.z.visible).toBe(false)
    buildTerrainOverlay(overlay(), 0, SPACING, res)
    res.frame(projectorOf(orbitCamera()), () => 0.1)
    expect(Object.values(res.arrows).some((m) => m.visible)).toBe(false)
    expect(res.gizmoCentre.visible).toBe(false)
    res.dispose()
  })

  it("shows the label at its point with a constant pixel size", () => {
    const res = new TerrainOverlayResources()
    buildTerrainOverlay(overlay({ label: { at: { x: 1, y: 2, z: 3 }, text: "+7.5 ft · Add" } }), 0, SPACING, res)
    const sprite = res.decor.children.find((o) => (o as THREE.Sprite).isSprite) as THREE.Sprite
    expect(sprite.visible).toBe(true)
    expect(sprite.position.toArray()).toEqual([1, 2, 3])
    res.frame(null, () => 0.5)
    const h = sprite.scale.y
    res.frame(null, () => 1)
    expect(sprite.scale.y).toBeCloseTo(h * 2)
    buildTerrainOverlay(overlay(), 0, SPACING, res)
    expect(sprite.visible).toBe(false)
    res.dispose()
  })
})

// ---------------------------------------------------------------------------
// Marquee: a screen-space rect in canvas CSS px
// ---------------------------------------------------------------------------

describe("terrain overlay marquee", () => {
  type MarqueeMesh = THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>
  const marqueeOf = (root: THREE.Object3D) => meshes(root).find((m) => m.name === "terrain-marquee") as MarqueeMesh | undefined

  /** Canvas CSS px where MARQUEE_VERTEX puts each vertex of the quad (the shader's math, from its uniforms). */
  function drawnCorners(mesh: MarqueeMesh): { x: number; y: number }[] {
    mesh.material.onBeforeRender(fakeRenderer, new THREE.Scene(), new THREE.Camera(), mesh.geometry, mesh, null as unknown as THREE.Group)
    const u = mesh.material.uniforms
    const r = u.uRect.value as THREE.Vector4
    const vp = u.uViewport.value as THREE.Vector4
    const ratio = u.uPixelRatio.value as number
    const pos = mesh.geometry.getAttribute("position")
    const out: { x: number; y: number }[] = []
    for (let k = 0; k < pos.count; k++) {
      const css = { x: r.x - 1 + (r.z - r.x + 2) * pos.getX(k), y: r.y - 1 + (r.w - r.y + 2) * pos.getY(k) }
      const ndc = { x: ((css.x * ratio) / vp.z) * 2 - 1, y: -(((css.y * ratio) / vp.w) * 2 - 1) }
      // NDC → canvas CSS px (as the rasteriser maps it over the W × H canvas).
      out.push({ x: ((ndc.x + 1) / 2) * W, y: ((1 - ndc.y) / 2) * H })
    }
    return out
  }

  /** MARQUEE_FRAGMENT's alpha at a canvas point (CSS px), from the material's uniforms. */
  function alphaAt(mesh: MarqueeMesh, x: number, y: number): number {
    const u = mesh.material.uniforms
    const r = u.uRect.value as THREE.Vector4
    const sd = Math.max(r.x - x, x - r.z, r.y - y, y - r.w)
    const px = 1 / RATIO
    const clamp = (v: number) => Math.min(1, Math.max(0, v))
    const inside = clamp(0.5 - sd / px)
    const line = clamp(0.5 - (Math.abs(sd + 0.5 * u.uLine.value) - 0.5 * u.uLine.value) / px)
    const a = Math.max(u.uFill.value * inside, u.uLineOpacity.value * line)
    return a < 0.002 ? 0 : a
  }

  it("draws the rect between from and to (any drag direction), over everything, without depth test", () => {
    const res = new TerrainOverlayResources()
    const root = buildTerrainOverlay(overlay({ marquee: { from: { x: 420, y: 90 }, to: { x: 130, y: 260.5 } } }), 0, SPACING, res)
    const mesh = marqueeOf(root)!
    expect(mesh).toBeDefined()
    expect(mesh.renderOrder).toBe(TERRAIN_OVERLAY_ORDER.marquee)
    expect(meshes(root).every((m) => m.renderOrder <= mesh.renderOrder)).toBe(true)
    expect(mesh.material.depthTest).toBe(false)
    expect(mesh.material.depthWrite).toBe(false)
    expect(mesh.material.transparent).toBe(true)
    expect(mesh.frustumCulled).toBe(false)
    expect("#" + (mesh.material.uniforms.uColor.value as THREE.Color).getHexString()).toBe(TERRAIN_OVERLAY_COLORS.marquee)
    // The quad covers the rect plus one CSS px of anti-aliasing margin, wherever the viewport and ratio are.
    const xs = drawnCorners(mesh).map((c) => c.x)
    const ys = drawnCorners(mesh).map((c) => c.y)
    expect(Math.min(...xs)).toBeCloseTo(129, 9)
    expect(Math.max(...xs)).toBeCloseTo(421, 9)
    expect(Math.min(...ys)).toBeCloseTo(89, 9)
    expect(Math.max(...ys)).toBeCloseTo(261.5, 9)
    // A faint fill inside, the outline on the border, nothing outside.
    expect(alphaAt(mesh, 275, 175)).toBeCloseTo(MARQUEE_STYLE.fill, 9)
    for (const [x, y] of [
      [130.25, 175],
      [419.75, 175],
      [275, 90.25],
      [275, 260.25],
    ])
      expect(alphaAt(mesh, x, y)).toBeCloseTo(MARQUEE_STYLE.lineOpacity, 9)
    for (const [x, y] of [
      [129, 175],
      [421, 175],
      [275, 89],
      [275, 261.5],
      [100, 100],
    ])
      expect(alphaAt(mesh, x, y)).toBe(0)
    disposePreview(root)
    res.dispose()
  })

  it("draws nothing for no marquee or a press that has not moved; the mesh is freed with the preview", () => {
    const res = new TerrainOverlayResources()
    expect(marqueeOf(buildTerrainOverlay(overlay(), 0, SPACING, res))).toBeUndefined()
    expect(marqueeOf(buildTerrainOverlay(overlay({ marquee: null }), 0, SPACING, res))).toBeUndefined()
    expect(marqueeMesh({ from: { x: 10, y: 10 }, to: { x: 10.2, y: 10.3 } })).toBeNull()
    expect(marqueeMesh({ from: { x: 10, y: 10 }, to: { x: Number.NaN, y: 30 } })).toBeNull()
    // A thin box is still drawn (its outline).
    expect(marqueeMesh({ from: { x: 10, y: 10 }, to: { x: 10, y: 60 } })).not.toBeNull()

    const scene = createScene({ width: 10, depth: 10 })
    const lv = Object.keys(scene.levels)[0]
    const ground = GroundSampler.forLevel(scene.levels[lv], scene.grid)
    const root = buildToolPreview(overlay({ levelId: lv, marquee: { from: { x: 5, y: 5 }, to: { x: 50, y: 40 } } }), {
      ground: () => ground,
      scene,
      worldPerPixel: 0.1,
      terrain: res,
    })
    const mesh = marqueeOf(root)!
    // The preview's own ordering pass leaves it on top.
    expect(mesh.renderOrder).toBe(TERRAIN_OVERLAY_ORDER.marquee)
    const disposed: string[] = []
    mesh.geometry.addEventListener("dispose", () => disposed.push("geometry"))
    mesh.material.addEventListener("dispose", () => disposed.push("material"))
    disposePreview(root)
    expect(disposed.sort()).toEqual(["geometry", "material"])
    res.dispose()
  })
})
