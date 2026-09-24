import { describe, expect, it } from "vitest"

import { blockShape, cylinderShape, isValidTerrainShape, loopCut } from "@/core/scene/terrainShapes"
import type { GridSettings } from "@/core/scene/types"

import {
  allElements,
  collapseEdges,
  cycleCurrent,
  cyclePick,
  edgeHits,
  elementsInScreenRect,
  elementVerticesByShape,
  faceHits,
  formatFeet,
  heightLabel,
  horizontalForward,
  maxRadiusInExtent,
  rampDirection,
  rayPlaneY,
  screenRect,
  screenUpForward,
  shapeHits,
  shapeInExtent,
  shapesInScreenRect,
  shapesPivot,
  snapHeight,
  turnRampDir,
  vertexHits,
  verticesCentroid,
} from "./terrainMath"
import { orthoCamera, perspectiveCamera } from "./test-utils"

const grid: GridSettings = { cellSize: 5, width: 20, depth: 20, diagonalRule: "5-5-5" }
const down = (x: number, z: number) => ({ origin: { x, y: 100, z }, direction: { x: 0, y: -1, z: 0 } })

describe("terrain math: rays, directions, heights", () => {
  it("intersects rays with horizontal planes", () => {
    expect(rayPlaneY(down(3, 4), 2)).toEqual({ x: 3, y: 2, z: 4 })
    const slant = { origin: { x: 0, y: 10, z: 0 }, direction: { x: 1, y: -1, z: 0 } }
    expect(rayPlaneY(slant, 4)).toEqual({ x: 6, y: 4, z: 0 })
    // Parallel, or the plane behind the origin.
    expect(rayPlaneY({ origin: { x: 0, y: 1, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, 0)).toBeNull()
    expect(rayPlaneY(slant, 20)).toBeNull()
  })

  it("picks the ramp direction from the dominant drag axis, with hysteresis and a camera tie-break", () => {
    const awayNorth = { x: 0, z: -1 }
    expect(rampDirection(10, 2, null, awayNorth)).toBe(1)
    expect(rampDirection(-10, 2, null, awayNorth)).toBe(3)
    expect(rampDirection(1, 10, null, awayNorth)).toBe(0)
    expect(rampDirection(1, -10, null, awayNorth)).toBe(2)
    // Hysteresis: from +X, Z must beat X by 25% to take over.
    expect(rampDirection(10, 11, 1, awayNorth)).toBe(1)
    expect(rampDirection(10, 13, 1, awayNorth)).toBe(0)
    // The sign flips along the same axis immediately.
    expect(rampDirection(-10, 1, 1, awayNorth)).toBe(3)
    // A tie rises away from the camera among the drag's directions.
    expect(rampDirection(10, -10, null, awayNorth)).toBe(2)
    expect(rampDirection(10, 10, null, awayNorth)).toBe(1)
    // No drag: straight away from the camera (or −Z when the view has no horizontal direction).
    expect(rampDirection(0, 0, null, { x: 1, z: 0 })).toBe(1)
    expect(rampDirection(0, 0, null, null)).toBe(2)
    expect(rampDirection(0, 0, 3, awayNorth)).toBe(3)
    expect(turnRampDir(3, 1)).toBe(0)
    expect(turnRampDir(0, -1)).toBe(3)
  })

  it("derives the camera's forward from the ray, or from the projection when looking straight down", () => {
    expect(horizontalForward({ x: 0, y: -1, z: 0 })).toBeNull()
    const f = horizontalForward({ x: 0, y: -0.9, z: -0.3 })!
    expect(f.x).toBeCloseTo(0)
    expect(f.z).toBeCloseTo(-1)
    const cam = orthoCamera({ tilt: 0, yaw: 90 })
    const up = screenUpForward(cam.project, { x: 50, y: 0, z: 50 })!
    // Yawed a quarter turn: screen up is a world X direction.
    expect(Math.abs(up.x)).toBeCloseTo(1)
    expect(up.z).toBeCloseTo(0)
    const north = screenUpForward(orthoCamera({ tilt: 0 }).project, { x: 50, y: 0, z: 50 })!
    expect(north.x).toBeCloseTo(0)
    expect(north.z).toBeCloseTo(-1)
  })

  it("snaps heights without float noise and labels them", () => {
    expect(snapHeight(7.3, 0.5)).toBe(7.5)
    expect(snapHeight(-3.2, 0.5)).toBe(-3)
    expect(snapHeight(0.1 + 0.2, 0.1)).toBe(0.3)
    expect(snapHeight(7.3, 0)).toBe(7.3)
    expect(snapHeight(-0.2, 0.5)).toBe(0)
    expect(Object.is(snapHeight(-0.2, 0.5), -0)).toBe(false)
    expect(heightLabel(7.5)).toBe("+7.5 ft · Add")
    expect(heightLabel(-3)).toBe("−3 ft · Carve")
    expect(heightLabel(0)).toBe("0 ft")
    expect(formatFeet(2.345)).toBe("2.35")
  })

  it("keeps shapes within the extent ± the schema margin", () => {
    expect(shapeInExtent(blockShape("a", { x: 0, z: 0, w: 100, d: 100 }, 0, 1, 0), grid)).toBe(true)
    expect(shapeInExtent(blockShape("a", { x: -40, z: 0, w: 10, d: 10 }, 0, 1, 0), grid)).toBe(true)
    expect(shapeInExtent(blockShape("a", { x: -60, z: 0, w: 10, d: 10 }, 0, 1, 0), grid)).toBe(false)
    expect(maxRadiusInExtent({ x: 10, z: 50 }, grid)).toBe(60)
    expect(maxRadiusInExtent({ x: 95, z: 50 }, grid)).toBe(55)
  })
})

describe("terrain math: hit testing", () => {
  const a = blockShape("a", { x: 10, z: 10, w: 10, d: 10 }, 0, 5, 0)
  const b = blockShape("b", { x: 12, z: 12, w: 6, d: 6 }, 0, 8, 1)
  const pit = blockShape("pit", { x: 40, z: 40, w: 10, d: 10 }, 0, -4, 2)

  it("orders shape hits by distance, buried ones last", () => {
    const hits = shapeHits([a, b], 0, down(15, 15))
    expect(hits.map((h) => [h.shapeId, h.face])).toEqual([
      ["b", "top"],
      ["a", "top"],
    ])
    expect(hits[0].point.y).toBeCloseTo(8)
    // The baked terrain is in front of both tops (something higher covers them): both are hidden.
    const buried = shapeHits([a, b], 0, down(15, 15), { groundT: 100 - 20 })
    expect(buried.every((h) => h.hidden)).toBe(true)
    // Terrain at y 6: b's top (8) is above it, a's top (5) under it.
    const partly = shapeHits([a, b], 0, down(15, 15), { groundT: 100 - 6 })
    expect(partly.map((h) => [h.shapeId, h.hidden])).toEqual([
      ["b", false],
      ["a", true],
    ])
    // A carve's top is its pit floor; misses give nothing.
    expect(shapeHits([pit], 0, down(45, 45))[0].point.y).toBeCloseTo(-4)
    expect(shapeHits([a, b, pit], 0, down(70, 70))).toEqual([])
  })

  it("finds vertices and edges in screen space and faces by ray", () => {
    const cam = orthoCamera({ tilt: 0, scale: 10 })
    const corner = cam.project({ x: 20, y: 5, z: 20 })
    const v = vertexHits([a], 0, cam.project, { x: corner.x + 3, y: corner.y - 4 })
    expect(v.map((h) => h.ref)).toEqual([{ shapeId: "a", kind: "vertex", index: 2 }])
    expect(v[0].distance).toBeCloseTo(5)
    expect(vertexHits([a], 0, cam.project, { x: corner.x + 9, y: corner.y })).toEqual([])
    const mid = cam.project({ x: 15, y: 5, z: 10 })
    const e = edgeHits([a], 0, cam.project, { x: mid.x, y: mid.y + 2 })
    expect(e[0].ref).toEqual({ shapeId: "a", kind: "edge", index: 0 })
    expect(e[0].point.x).toBeCloseTo(15)
    const f = faceHits([a], 0, { origin: { x: 0, y: 2, z: 15 }, direction: { x: 1, y: 0, z: 0 } })
    expect(f[0].ref).toEqual({ shapeId: "a", kind: "face", index: 3 })
    expect(faceHits([a], 0, down(15, 15))[0].ref).toEqual({ shapeId: "a", kind: "face", index: "top" })
  })

  it("selects elements and shapes inside a screen rect", () => {
    const cam = perspectiveCamera({ tilt: 30, distance: 150, target: { x: 15, y: 0, z: 15 } })
    const p = (x: number, y: number, z: number) => cam.project({ x, y, z })
    const r = screenRect({ x: p(20, 5, 10).x - 5, y: p(20, 5, 10).y - 5 }, { x: p(20, 5, 20).x + 5, y: p(20, 5, 20).y + 5 })
    expect(elementsInScreenRect([a], 0, cam.project, r, "vertex").map((x) => x.index)).toEqual([1, 2])
    // Top edge 1 and the side edge under its first corner (edge 4 + 1: its foot projects into the box too).
    expect(elementsInScreenRect([a], 0, cam.project, r, "edge").map((x) => x.index)).toEqual([1, 5])
    const all = screenRect({ x: 0, y: 0 }, { x: cam.width, y: cam.height })
    expect(elementsInScreenRect([a], 0, cam.project, all, "face").map((x) => x.index)).toEqual(["top", 0, 1, 2, 3])
    expect(shapesInScreenRect([a, pit], 0, cam.project, r)).toEqual([])
    expect(shapesInScreenRect([a, b], 0, cam.project, all)).toEqual(["a", "b"])
  })

  it("cycles through candidates on repeated clicks at the same spot", () => {
    const at = { x: 100, y: 100 }
    const first = cyclePick(["b", "a"], (s) => s, at, null)
    expect(first.choice).toBe("b")
    const second = cyclePick(["b", "a"], (s) => s, { x: 102, y: 101 }, first.cycle)
    expect(second.choice).toBe("a")
    expect(cyclePick(["b", "a"], (s) => s, at, second.cycle).choice).toBe("b")
    // Elsewhere, or other candidates: start over.
    expect(cyclePick(["b", "a"], (s) => s, { x: 140, y: 100 }, first.cycle).choice).toBe("b")
    expect(cyclePick(["c", "a"], (s) => s, at, first.cycle).choice).toBe("c")
    expect(cyclePick([], (s: string) => s, at, first.cycle)).toEqual({ choice: null, cycle: null })
  })

  it("names the candidate the click cycle sits on at the same spot (none at a fresh one)", () => {
    const at = { x: 100, y: 100 }
    const first = cyclePick(["b", "a"], (s) => s, at, null)
    const second = cyclePick(["b", "a"], (s) => s, at, first.cycle)
    expect(cycleCurrent(["b", "a"], (s) => s, at, first.cycle)).toBe("b")
    expect(cycleCurrent(["b", "a"], (s) => s, { x: 103, y: 101 }, second.cycle)).toBe("a")
    // Elsewhere, other candidates or no cycle: none.
    expect(cycleCurrent(["b", "a"], (s) => s, { x: 140, y: 100 }, second.cycle)).toBeNull()
    expect(cycleCurrent(["c", "a"], (s) => s, at, second.cycle)).toBeNull()
    expect(cycleCurrent(["b", "a"], (s) => s, at, null)).toBeNull()
    expect(cycleCurrent([], (s: string) => s, at, second.cycle)).toBeNull()
  })
})

describe("terrain math: elements and edits", () => {
  it("maps elements to vertices, lists all elements, pivots and centroids", () => {
    const a = blockShape("a", { x: 10, z: 10, w: 10, d: 10 }, 0, 5, 0)
    const byShape = elementVerticesByShape({ a }, [
      { shapeId: "a", kind: "edge", index: 3 },
      { shapeId: "a", kind: "vertex", index: 1 },
      { shapeId: "gone", kind: "vertex", index: 0 },
    ])
    expect([...byShape]).toEqual([["a", [0, 1, 3]]])
    expect(allElements([a], "face")).toHaveLength(5)
    // Top edges 0–3, side edges 4–7, bottom edges 8–11.
    expect(allElements([a], "edge").map((e) => e.index)).toEqual(Array.from({ length: 12 }, (_, k) => k))
    expect(shapesPivot([a], grid, "center")).toEqual({ x: 15, z: 15 })
    expect(shapesPivot([blockShape("c", { x: 10, z: 10, w: 5, d: 10 }, 0, 1, 0)], grid, "vertex")).toEqual({ x: 15, z: 15 })
    expect(shapesPivot([blockShape("c", { x: 10, z: 10, w: 5, d: 10 }, 0, 1, 0)], grid, "free")).toEqual({ x: 12.5, z: 15 })
    expect(verticesCentroid(new Map([["a", a]]), byShape, 10)).toEqual({ x: 40 / 3, y: 15, z: 40 / 3 })
  })

  it("collapses chains of edges to their mean vertex", () => {
    const c = cylinderShape("c", { x: 50, z: 50 }, 10, 8, 0, 2, 0)
    const one = collapseEdges(c, [0])!
    expect(one.points).toHaveLength(7)
    expect(one.points[0].x).toBeCloseTo((c.points[0].x + c.points[1].x) / 2)
    const chain = collapseEdges(c, [1, 2])!
    expect(chain.points).toHaveLength(6)
    const merged = chain.points.find((p) => Math.abs(p.x - (c.points[1].x + c.points[2].x + c.points[3].x) / 3) < 1e-9)
    expect(merged).toBeDefined()
    expect(isValidTerrainShape(chain)).toBe(true)
    // Two separate edges, and too many.
    expect(collapseEdges(c, [0, 4])!.points).toHaveLength(6)
    expect(collapseEdges(c, [0, 1, 2, 3, 4, 5])).toBeNull()
    expect(collapseEdges(blockShape("b", { x: 0, z: 0, w: 5, d: 5 }, 0, 1, 0), [0, 2])).toBeNull()
    expect(collapseEdges(c, [])).toBe(c)
  })

  it("treats inner edges (loop cuts) as edges n + c: picking, lists, rects; collapses re-index them", () => {
    // 20 × 10 block cut at x 20: points (10,10) (20,10) (30,10) (30,20) (20,20) (10,20), inner edge 6 = [1, 4].
    const cut = loopCut(blockShape("a", { x: 10, z: 10, w: 20, d: 10 }, 0, 5, 0), 0, [0.5])!.shape
    // 6 outline edges, the inner edge, 6 side and 6 bottom edges.
    expect(allElements([cut], "edge").map((e) => e.index)).toEqual(Array.from({ length: 19 }, (_, k) => k))
    const cam = orthoCamera({ tilt: 0, scale: 10 })
    const mid = cam.project({ x: 20, y: 5, z: 15 })
    expect(edgeHits([cut], 0, cam.project, { x: mid.x + 2, y: mid.y })[0].ref).toEqual({ shapeId: "a", kind: "edge", index: 6 })
    // Outline edges only (the loop cut tool's fallback).
    expect(edgeHits([cut], 0, cam.project, { x: mid.x + 2, y: mid.y }, 8, "outline")).toEqual([])
    const all = screenRect({ x: 0, y: 0 }, { x: cam.width, y: cam.height })
    expect(elementsInScreenRect([cut], 0, cam.project, all, "edge").map((x) => x.index)).toEqual(Array.from({ length: 19 }, (_, k) => k))
    expect(elementVerticesByShape({ a: cut }, [{ shapeId: "a", kind: "edge", index: 6 }]).get("a")).toEqual([1, 4])
    // Collapsing the outline edges 2 and 3 (vertices 2, 3, 4 merge) re-indexes the inner edge's far end.
    const collapsed = collapseEdges(cut, [2, 3])!
    expect(collapsed.points).toHaveLength(4)
    expect(collapsed.innerEdges).toBeUndefined()
    const other = collapseEdges(cut, [4, 5])!
    expect(other.innerEdges).toBeUndefined()
    const keep = collapseEdges(loopCut(cut, 0, [0.5])!.shape, [3])!
    expect(keep.innerEdges).toHaveLength(2)
    expect(isValidTerrainShape(keep)).toBe(true)
  })
})
