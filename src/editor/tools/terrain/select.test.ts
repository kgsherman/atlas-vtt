import { describe, expect, it } from "vitest"

import { gizmoHandles, gizmoRing, heightFollowParams, ringDistancePx, ringPoint, type GizmoAxis } from "@/core/geometry/gizmo"
import { blockShape, cylinderShape, loopCut, rotateShape, topFaces } from "@/core/scene/terrainShapes"
import type { Vec3 } from "@/core/scene/types"

import type { ShortcutAction } from "../../shortcuts"
import { key, perspectiveCamera } from "../../test-utils"
import type { ToolPointerEvent } from "../types"
import { NEED_THREE_VERTICES } from "./actions"
import { terrainHarness, type TerrainHarness } from "./harness"

const xyz = (pts: readonly Vec3[]) => pts.map((p) => [p.x, p.y, p.z])
const xz = (pts: readonly Vec3[]) => pts.map((p) => [p.x, p.z])
/** Mean of a shape's top vertices (the centre of a regular cylinder). */
const centreOf = (pts: readonly Vec3[]) => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, z: pts.reduce((s, p) => s + p.z, 0) / pts.length })

function setup() {
  const t = terrainHarness({ sub: "select" })
  const a = t.add(blockShape("a", { x: 10, z: 10, w: 10, d: 10 }, 0, 5, 0))
  const b = t.add(blockShape("b", { x: 40, z: 40, w: 10, d: 10 }, 0, 3, 1))
  return { ...t, a, b, sel: () => t.store.getState().terrainSelection }
}

function click(t: TerrainHarness, e: ToolPointerEvent) {
  t.tool.onPointerDown!(e)
  t.tool.onPointerUp!(e)
}

const act = (t: TerrainHarness, action: ShortcutAction, k = "") => t.tool.onKeyDown!(key(k, { action }))

/** The canvas point in the middle of a gizmo arrow. */
function onArrow(t: TerrainHarness, at: Vec3, axis: GizmoAxis) {
  const h = gizmoHandles(t.camera.project, at)[axis]
  return t.px((h.from.x + h.to.x) / 2, (h.from.y + h.to.y) / 2)
}

/** `e` moved on screen by `dy` feet of vertical motion at world point `at`. */
function raised(t: TerrainHarness, e: ToolPointerEvent, at: Vec3, dy: number) {
  const p = heightFollowParams(t.camera.project, at, e.pick.ray!.direction)!
  return t.px(e.canvasX! + p.u.x * p.k * dy, e.canvasY! + p.u.y * p.k * dy)
}

describe("terrain select: object mode", () => {
  it("click selects, Shift toggles, a click on nothing clears; repeated clicks cycle through overlaps", () => {
    const t = setup()
    const { a, b, levelId } = t
    click(t, t.at(15, 5, 15))
    expect(t.sel()).toEqual({ levelId, shapeIds: [a], elements: [] })
    expect(t.overlay().selectedShapeIds).toEqual([a])
    click(t, t.at(45, 3, 45, { shift: true }))
    expect(t.sel()?.shapeIds).toEqual([a, b])
    click(t, t.at(15, 5, 15, { shift: true }))
    expect(t.sel()?.shapeIds).toEqual([b])
    click(t, t.at(80, 0, 80))
    expect(t.sel()).toBeNull()

    const c = t.add(blockShape("c", { x: 12, z: 12, w: 6, d: 6 }, 0, 8, 2))
    // (Off the selection's gizmo arrows, which take priority over shapes.)
    const spot = t.at(13, 8, 13)
    click(t, spot)
    expect(t.sel()?.shapeIds).toEqual([c])
    click(t, spot)
    expect(t.sel()?.shapeIds).toEqual([a])
    click(t, spot)
    expect(t.sel()?.shapeIds).toEqual([c])
  })

  it("a press on the selected shape of a stack drags it: clicks cycle, presses keep the selection", () => {
    const t = setup()
    const { tool, a } = t
    const c = t.add(blockShape("c", { x: 10, z: 10, w: 5, d: 5 }, 0, 8, 2))
    // Over c and a (c on top), off the selection's gizmo arrows.
    const spot = t.at(11, 8, 11)
    click(t, spot)
    expect(t.sel()?.shapeIds).toEqual([c])
    // Press-drag at the same spot: c moves, a stays.
    tool.onPointerDown!(spot)
    expect(t.sel()?.shapeIds).toEqual([c])
    expect(t.overlay().hoverShapeId).toBeNull()
    tool.onPointerMove!(t.at(16, 8, 11))
    tool.onPointerMove!(t.at(21, 8, 11))
    tool.onPointerUp!(t.at(21, 8, 11))
    expect(xz(t.shape(c).points)).toEqual([
      [20, 10],
      [25, 10],
      [25, 15],
      [20, 15],
    ])
    expect(xz(t.shape(a).points)).toEqual([
      [10, 10],
      [20, 10],
      [20, 20],
      [10, 20],
    ])

    // Two clicks cycle down to a (buried under c), and a press-drag there drags a.
    const c2 = t.add(blockShape("c2", { x: 10, z: 10, w: 5, d: 5 }, 0, 8, 3))
    click(t, spot)
    expect(t.sel()?.shapeIds).toEqual([c2])
    click(t, spot)
    expect(t.sel()?.shapeIds).toEqual([a])
    // Hover shows what a press grabs: the selected shape under the pointer.
    tool.onPointerMove!(spot)
    expect(t.overlay().hoverShapeId).toBe(a)
    expect(tool.cursor!()).toBe("move")
    tool.onPointerDown!(spot)
    tool.onPointerMove!(t.at(11, 8, 16))
    tool.onPointerMove!(t.at(11, 8, 21))
    tool.onPointerUp!(t.at(11, 8, 21))
    expect(t.shape(a).points[0]).toEqual({ x: 10, y: 5, z: 20 })
    expect(t.shape(c2).points[0]).toEqual({ x: 10, y: 8, z: 10 })
    // After a drag the next click at that spot starts a new cycle (the top shape).
    click(t, t.at(11, 8, 11))
    expect(t.sel()?.shapeIds).toEqual([c2])
  })

  it("a press on a visible unselected shape drags it, not a selected shape under it", () => {
    const t = terrainHarness({ sub: "select" })
    const sel = () => t.store.getState().terrainSelection
    const { tool, store } = t
    const p = t.add(blockShape("p", { x: 10, z: 10, w: 60, d: 60 }, 0, 5, 0))
    const h = t.add(blockShape("h", { x: 50, z: 50, w: 10, d: 10 }, 0, 9, 1))
    click(t, t.at(20, 5, 60))
    expect(sel()?.shapeIds).toEqual([p])
    const spot = t.at(55, 9, 55)
    // Hover shows what a press takes: the hill in front.
    tool.onPointerMove!(spot)
    expect(t.overlay().hoverShapeId).toBe(h)
    tool.onPointerDown!(spot)
    expect(sel()?.shapeIds).toEqual([h])
    tool.onPointerMove!(t.at(60, 9, 55))
    tool.onPointerMove!(t.at(65, 9, 55))
    tool.onPointerUp!(t.at(65, 9, 55))
    expect(xz(t.shape(h).points)).toEqual([
      [60, 50],
      [70, 50],
      [70, 60],
      [60, 60],
    ])
    expect(xz(t.shape(p).points)).toEqual([
      [10, 10],
      [70, 10],
      [70, 70],
      [10, 70],
    ])
    expect(store.getState().history.undoLabel).toBe("Move terrain shape")
    expect(sel()?.shapeIds).toEqual([h])
  })

  it("a press-drag inside a selected pit moves the pit, not the plateau it carves", () => {
    const t = terrainHarness({ sub: "select" })
    const sel = () => t.store.getState().terrainSelection
    const { tool, store, levelId } = t
    const p = t.add(blockShape("p", { x: 10, z: 10, w: 60, d: 60 }, 0, 5, 0))
    // Drawn downward on the plateau (floor 2, base 5) and left selected; p's top is hit first inside it.
    const c = t.add(blockShape("c", { x: 30, z: 30, w: 10, d: 10 }, 5, -3, 1))
    store.getState().setTerrainSelection({ levelId, shapeIds: [c], elements: [] })
    const spot = t.at(35, 2, 35)
    tool.onPointerMove!(spot)
    expect(t.overlay().hoverShapeId).toBe(c)
    tool.onPointerDown!(spot)
    expect(sel()?.shapeIds).toEqual([c])
    tool.onPointerMove!(t.at(40, 2, 35))
    tool.onPointerMove!(t.at(45, 2, 35))
    tool.onPointerUp!(t.at(45, 2, 35))
    expect(xz(t.shape(c).points)).toEqual([
      [40, 30],
      [50, 30],
      [50, 40],
      [40, 40],
    ])
    expect(xz(t.shape(p).points)).toEqual([
      [10, 10],
      [70, 10],
      [70, 70],
      [10, 70],
    ])
    expect(store.getState().history.undoLabel).toBe("Move terrain shape")
    expect(sel()?.shapeIds).toEqual([c])
  })

  it("a press just inside the rim of an unselected cylinder on the selected plateau drags the cylinder", () => {
    // Off the sample lattice the bake slopes across the rim, so the terrain there lies below the cylinder's top
    // (only a carve hit counts as on the terrain, ShapeHit.onGround: the cylinder is still the front candidate).
    for (const inset of [1, 1.5, 2]) {
      const t = terrainHarness({ sub: "select" })
      const sel = () => t.store.getState().terrainSelection
      const { tool } = t
      const p = t.add(blockShape("p", { x: 10, z: 10, w: 60, d: 60 }, 0, 5, 0))
      const cy = t.add(cylinderShape("cy", { x: 56.3, z: 26.3 }, 6.3, 24, 5, 4, 1))
      click(t, t.at(20, 5, 20))
      expect(sel()?.shapeIds).toEqual([p])
      const x = 56.3 + 6.3 - inset
      tool.onPointerMove!(t.at(x, 9, 26.3))
      expect(t.overlay().hoverShapeId, `inset ${inset}`).toBe(cy)
      tool.onPointerDown!(t.at(x, 9, 26.3))
      // (Alt: free, so the centre moves by exactly 10.)
      tool.onPointerMove!(t.at(x + 5, 9, 26.3, { alt: true }))
      tool.onPointerMove!(t.at(x + 10, 9, 26.3, { alt: true }))
      tool.onPointerUp!(t.at(x + 10, 9, 26.3, { alt: true }))
      expect(sel()?.shapeIds, `inset ${inset}`).toEqual([cy])
      expect(centreOf(t.shape(cy).points).x, `inset ${inset}`).toBeCloseTo(66.3, 6)
      expect(t.shape(p).points[0]).toEqual({ x: 10, y: 5, z: 10 })
    }
  })

  it("a press on the overlap of coplanar shapes keeps the selected one, whichever id sorts first", () => {
    for (const [first, second] of [
      ["a", "b"],
      ["b", "a"],
    ]) {
      const t = terrainHarness({ sub: "select" })
      const sel = () => t.store.getState().terrainSelection
      const { tool, store, levelId } = t
      // An L-shaped plateau from two overlapping blocks with the same top: the overlap's hits tie.
      const one = t.add(blockShape(first, { x: 10, z: 10, w: 30, d: 30 }, 0, 5, 0))
      const two = t.add(blockShape(second, { x: 30, z: 30, w: 30, d: 30 }, 0, 5, 1))
      click(t, t.at(50, 5, 50))
      expect(sel()?.shapeIds).toEqual([two])
      const spot = t.at(35, 5, 35)
      tool.onPointerMove!(spot)
      expect(t.overlay().hoverShapeId, first).toBe(two)
      tool.onPointerDown!(spot)
      tool.onPointerMove!(t.at(40, 5, 35))
      tool.onPointerMove!(t.at(45, 5, 35))
      tool.onPointerUp!(t.at(45, 5, 35))
      expect(sel()?.shapeIds, first).toEqual([two])
      expect(xz(t.shape(two).points), first).toEqual([
        [40, 30],
        [70, 30],
        [70, 60],
        [40, 60],
      ])
      expect(xz(t.shape(one).points), first).toEqual([
        [10, 10],
        [40, 10],
        [40, 40],
        [10, 40],
      ])
      // Advanced mode (the move undone): a click on the overlap keeps the edit session, clearing the elements.
      store.getState().undo()
      expect(xz(t.shape(two).points)[0]).toEqual([30, 30])
      act(t, { type: "terrain-advanced" }, "Tab")
      click(t, t.at(60, 5, 60))
      expect(sel()?.elements).toHaveLength(1)
      tool.onPointerMove!(t.at(36, 5, 36))
      expect(t.overlay().hoverShapeId, first).toBeNull()
      click(t, t.at(36, 5, 36))
      expect(sel(), first).toEqual({ levelId, shapeIds: [two], elements: [] })
    }
  })

  it("a press-drag within the cylinder's cell commits nothing (no float-noise move)", () => {
    const t = terrainHarness({ sub: "select" })
    const { tool, store } = t
    store.getState().setSnapMode("center")
    const c0 = { x: 52.5, z: 47.5 }
    const cyl = t.add(cylinderShape("cyl", c0, 2.5, 24, 0, 5, 0))
    const before = t.shape(cyl)
    const n = t.previews.length
    tool.onPointerDown!(t.at(c0.x, 5, c0.z))
    tool.onPointerMove!(t.at(c0.x + 0.4, 5, c0.z + 0.2))
    tool.onPointerMove!(t.at(c0.x + 0.8, 5, c0.z + 0.3))
    expect(t.overlay().label).toBeNull()
    expect(t.previews).toHaveLength(n)
    tool.onPointerUp!(t.at(c0.x + 0.8, 5, c0.z + 0.3))
    expect(store.getState().history.undoLabel).toBe("Add shape")
    expect(t.shape(cyl)).toBe(before)
    // A drag away and back to the start commits nothing either.
    tool.onPointerDown!(t.at(c0.x, 5, c0.z))
    tool.onPointerMove!(t.at(c0.x + 5, 5, c0.z))
    expect(t.overlay().label?.text).toBe("+5, 0, 0 ft")
    tool.onPointerMove!(t.at(c0.x + 0.3, 5, c0.z))
    tool.onPointerUp!(t.at(c0.x + 0.3, 5, c0.z))
    expect(store.getState().history.undoLabel).toBe("Add shape")
    expect(t.shape(cyl)).toBe(before)
  })

  it("drags a cylinder by its centre with the snap mode and turns a lone one about its centre", () => {
    for (const [mode, c0] of [
      ["center", { x: 22.5, z: 22.5 }],
      ["vertex", { x: 20, z: 20 }],
    ] as const) {
      const t = terrainHarness({ sub: "select" })
      const { tool, store } = t
      store.getState().setSnapMode(mode)
      const cyl = t.add(cylinderShape("cyl", c0, 2.5, 24, 0, 5, 0))
      tool.onPointerDown!(t.at(c0.x, 5, c0.z))
      tool.onPointerMove!(t.at(c0.x + 3, 5, c0.z))
      tool.onPointerMove!(t.at(c0.x + 10.4, 5, c0.z + 0.3))
      tool.onPointerUp!(t.at(c0.x + 10.4, 5, c0.z + 0.3))
      const c1 = centreOf(t.shape(cyl).points)
      expect(c1.x, mode).toBeCloseTo(c0.x + 10, 9)
      expect(c1.z, mode).toBeCloseTo(c0.z, 9)
    }

    const t = terrainHarness({ sub: "select" })
    const cyl = t.add(cylinderShape("cyl", { x: 22.5, z: 22.5 }, 2.5, 24, 0, 5, 0))
    click(t, t.at(22.5, 5, 22.5))
    expect(act(t, { type: "rotate", turns: 1 })).toBe(true)
    expect(t.store.getState().history.undoLabel).toBe("Rotate terrain shape")
    const c = centreOf(t.shape(cyl).points)
    expect(c.x).toBeCloseTo(22.5, 9)
    expect(c.z).toBeCloseTo(22.5, 9)
  })

  it("releasing Alt without moving re-snaps the drag", () => {
    const t = setup()
    const { tool, store, a } = t
    store.getState().setAltHeld(true)
    tool.onPointerDown!(t.at(15, 5, 15, { alt: true }))
    tool.onPointerMove!(t.at(22.3, 5, 16.1, { alt: true }))
    expect(t.overlay().shapes.find((s) => s.id === a)!.points[0].x).toBeCloseTo(17.3)
    store.getState().setAltHeld(false)
    expect(t.overlay().shapes.find((s) => s.id === a)!.points[0]).toEqual({ x: 15, y: 5, z: 10 })
    expect(t.overlay().label?.text).toBe("+5, 0, 0 ft")
  })

  it("a drag back to its start does not claim there is no floor", () => {
    const t = setup()
    const { tool } = t
    tool.onPointerDown!(t.at(15, 5, 15))
    tool.onPointerMove!(t.at(20, 5, 15))
    tool.onPointerMove!(t.at(25, 5, 15))
    expect(tool.hint()).toBe("X / Y / Z constrain the move · Esc cancels")
    tool.onPointerMove!(t.at(15.2, 5, 15))
    expect(t.overlay().label).toBeNull()
    expect(tool.hint()).toBe("X / Y / Z constrain the move · Esc cancels")
    tool.onPointerUp!(t.at(15.2, 5, 15))
  })

  it("Y toggled by key follows screen up in a straight-down perspective view, off the centre too", () => {
    const t = terrainHarness({ sub: "select", camera: perspectiveCamera({ tilt: 0, target: { x: 30, y: 0, z: 30 } }) })
    const { tool } = t
    const s = t.add(blockShape("s", { x: 35, z: 35, w: 10, d: 10 }, 0, 5, 0))
    const press = t.at(40, 5, 40)
    tool.onPointerDown!(press)
    tool.onPointerMove!(t.px(press.canvasX! + 6, press.canvasY!))
    act(t, { type: "axis", axis: "y" }, "y")
    tool.onPointerMove!(t.px(press.canvasX!, press.canvasY! - 40))
    tool.onPointerUp!(t.px(press.canvasX!, press.canvasY! - 40))
    expect(t.shape(s).base).toBeGreaterThan(0)
  })

  it("a drag on nothing draws the marquee (canvas px) until the release selects what it encloses", () => {
    const t = setup()
    const { tool, a, b } = t
    const from = t.at(5, 0, 5)
    const to = t.at(55, 0, 55)
    tool.onPointerDown!(from)
    expect(t.overlay().marquee).toBeNull()
    // Under the drag threshold it is still a click.
    tool.onPointerMove!(t.px(from.canvasX! + 2, from.canvasY! + 1))
    expect(t.overlay().marquee).toBeNull()
    const redraws = t.invalidations()
    tool.onPointerMove!(to)
    expect(t.overlay().marquee).toEqual({ from: { x: from.canvasX, y: from.canvasY }, to: { x: to.canvasX, y: to.canvasY } })
    expect(t.invalidations()).toBeGreaterThan(redraws)
    expect(tool.cursor!()).toBe("crosshair")
    tool.onPointerUp!(to)
    expect(t.overlay().marquee).toBeNull()
    expect([...t.sel()!.shapeIds].sort()).toEqual([a, b].sort())
    // Escape mid-marquee drops it without selecting.
    click(t, t.at(80, 0, 80))
    tool.onPointerDown!(from)
    tool.onPointerMove!(to)
    expect(t.overlay().marquee).not.toBeNull()
    tool.onKeyDown!(key("Escape", { action: { type: "escape" } }))
    expect(t.overlay().marquee).toBeNull()
    tool.onPointerUp!(to)
    expect(t.sel()).toBeNull()
  })

  it("hover highlights the shape under the pointer", () => {
    const t = setup()
    t.tool.onPointerMove!(t.at(45, 3, 45))
    expect(t.overlay().hoverShapeId).toBe(t.b)
    expect(t.tool.cursor!()).toBe("pointer")
    t.tool.onPointerMove!(t.at(80, 0, 80))
    expect(t.overlay().hoverShapeId).toBeNull()
    // Pointer leaving the canvas (no ray) clears it.
    t.tool.onPointerMove!(t.at(45, 3, 45))
    t.tool.onPointerMove!({ ...t.at(45, 3, 45), pick: { ground: null, objectId: null, tokenId: null, hitPoint: null } })
    expect(t.overlay().hoverShapeId).toBeNull()
  })

  it("a press on an unselected shape selects and drags it; the drag previews locally and commits once", () => {
    const t = setup()
    const { tool, store, a, b } = t
    const before = store.getState().scene
    const bShape = t.shape(b)
    tool.onPointerDown!(t.at(15, 5, 15))
    expect(t.sel()?.shapeIds).toEqual([a])
    tool.onPointerMove!(t.at(18, 5, 15))
    expect(tool.capturesPointer).toBe(true)
    tool.onPointerMove!(t.at(25, 5, 15))
    const o = t.overlay()
    const moved = o.shapes.find((s) => s.id === a)!
    expect(moved.points.map((p) => p.x)).toEqual([20, 30, 30, 20])
    // Unchanged shapes keep their identity (the renderer caches per shape object).
    expect(o.shapes.find((s) => s.id === b)).toBe(bShape)
    expect(o.label?.text).toBe("+10, 0, 0 ft")
    expect(store.getState().scene).toBe(before)
    const preview = t.previews.at(-1)!
    expect(t.previewHeight(preview, 15, 15)).toBe(0)
    expect(t.previewHeight(preview, 25, 15)).toBe(5)

    tool.onPointerUp!(t.at(25, 5, 15))
    expect(store.getState().history).toMatchObject({ undoDepth: 3, undoLabel: "Move terrain shape" })
    expect(t.shape(a).points.map((p) => p.x)).toEqual([20, 30, 30, 20])
    expect(t.height(15, 15)).toBe(0)
    expect(t.height(25, 15)).toBe(5)
    expect(t.previews.at(-1)!.heights).not.toBeNull()
  })

  it("snaps the drag by the grabbed shape's first vertex (Alt: free) and refuses moves off the map", () => {
    const t = setup()
    const { tool, a } = t
    tool.onPointerDown!(t.at(15, 5, 15))
    tool.onPointerMove!(t.at(22.3, 5, 16.1))
    expect(t.overlay().shapes.find((s) => s.id === a)!.points[0]).toEqual({ x: 15, y: 5, z: 10 })
    tool.onPointerMove!(t.at(22.3, 5, 16.1, { alt: true }))
    const free = t.overlay().shapes.find((s) => s.id === a)!.points[0]
    expect(free.x).toBeCloseTo(17.3)
    expect(free.z).toBeCloseTo(11.1)
    // Far beyond the extent margin: refused, the drag keeps its last valid state.
    tool.onPointerMove!(t.at(-120, 5, 15))
    expect(t.overlay().shapes.find((s) => s.id === a)!.points[0].x).toBeCloseTo(17.3)
    expect(tool.onKeyDown!(key("Escape"))).toBe(true)
    expect(t.shape(a).points[0]).toEqual({ x: 10, y: 5, z: 10 })
    expect(t.sel()?.shapeIds).toEqual([a])
  })

  it("gizmo arrows constrain to an axis; Y moves top and base together, snapped to the height step", () => {
    const t = setup()
    const { tool, a } = t
    click(t, t.at(15, 5, 15))
    const gz = t.overlay().gizmo!
    expect(gz.at).toEqual({ x: 15, y: 5, z: 15 })
    const press = onArrow(t, gz.at, "y")
    tool.onPointerMove!(press)
    expect(t.overlay().gizmo?.hover).toBe("y")
    expect(tool.cursor!()).toBe("move")
    tool.onPointerDown!(press)
    expect(t.overlay().gizmo?.active).toBe("y")
    tool.onPointerMove!(raised(t, press, gz.at, 2.1))
    expect(t.overlay().label?.text).toBe("0, +2, 0 ft")
    tool.onPointerUp!(raised(t, press, gz.at, 2.1))
    expect(t.shape(a)).toMatchObject({ base: 2 })
    expect(t.shape(a).points.every((p) => p.y === 7)).toBe(true)

    // X arrow: a diagonal cursor move only moves along X.
    const at = t.overlay().gizmo!.at
    const px = onArrow(t, at, "x")
    tool.onPointerDown!(px)
    const d0 = t.camera.project(at)
    const d1 = t.camera.project({ x: at.x + 5, y: at.y, z: at.z + 3 })
    tool.onPointerMove!(t.px(px.canvasX! + d1.x - d0.x, px.canvasY! + d1.y - d0.y))
    tool.onPointerUp!(t.px(px.canvasX! + d1.x - d0.x, px.canvasY! + d1.y - d0.y))
    expect(xyz(t.shape(a).points).map(([x, , z]) => [x, z])).toEqual([
      [15, 10],
      [25, 10],
      [25, 20],
      [15, 20],
    ])
  })

  it("the green rotate ring turns the selection about the vertical axis in 15° steps (Alt: free), one undo step", () => {
    const t = setup()
    const { tool, a, store } = t
    click(t, t.at(15, 5, 15))
    const at = t.overlay().gizmo!.at
    const orig = t.shape(a)
    const ring = gizmoRing(t.camera.project, at)
    expect(ring.visible).toBe(true)
    // A point of the ring at `deg` (from +Z towards +X, the ring's sense), aimed at on the ring's plane.
    const onRing = (deg: number) => {
      const q = ringPoint(at, ring.radius, (deg / 360) * 64)
      return t.at(q.x, q.y, q.z)
    }
    const press = onRing(0)
    tool.onPointerMove!(press)
    expect(t.overlay().gizmo?.hover).toBe("rotate")
    expect(tool.cursor!()).toBe("grab")
    tool.onPointerDown!(press)
    expect(t.overlay().gizmo?.active).toBe("rotate")
    // 47° snaps to 45°; the arrows' X / Y / Z keys do nothing while rotating.
    tool.onPointerMove!(onRing(47))
    expect(t.overlay().label?.text).toBe("+45°")
    expect(act(t, { type: "axis", axis: "x" }, "x")).toBe(true)
    expect(t.overlay().label?.text).toBe("+45°")
    tool.onPointerUp!(onRing(47))
    const want = rotateShape(orig, { x: 15, z: 15 }, Math.PI / 4)!
    expect(t.shape(a).points.map((p) => [p.x, p.y, p.z])).toEqual(want.points.map((p) => [p.x, p.y, p.z]))
    expect(store.getState().history.undoLabel).toBe("Rotate terrain shape")
    expect(store.getState().history.undoDepth).toBe(3)
    // A quarter turn back to the original shape is exact; Alt rotates freely.
    store.getState().undo()
    tool.onPointerDown!(onRing(0))
    tool.onPointerMove!({ ...onRing(-31), alt: true })
    expect(t.overlay().label?.text).toBe("−31°")
    tool.onPointerUp!({ ...onRing(-31), alt: true })
    const free = rotateShape(orig, { x: 15, z: 15 }, (-31 * Math.PI) / 180)!
    t.shape(a).points.forEach((p, k) => {
      expect(p.x).toBeCloseTo(free.points[k].x, 6)
      expect(p.z).toBeCloseTo(free.points[k].z, 6)
    })
    // Esc mid-rotation cancels without an undo step.
    const depth = store.getState().history.undoDepth
    tool.onPointerDown!(onRing(0))
    tool.onPointerMove!(onRing(90))
    act(t, { type: "escape" }, "Escape")
    expect(store.getState().history.undoDepth).toBe(depth)
  })

  it("X / Y / Z keys toggle an axis constraint mid-drag and recompute right away", () => {
    const t = setup()
    const { tool, a, store } = t
    tool.onPointerDown!(t.at(15, 5, 15))
    tool.onPointerMove!(t.at(25, 5, 22.3))
    const first = () => t.overlay().shapes.find((s) => s.id === a)!.points[0]
    expect(first()).toEqual({ x: 20, y: 5, z: 15 })
    expect(act(t, { type: "axis", axis: "x" }, "x")).toBe(true)
    expect(first()).toEqual({ x: 20, y: 5, z: 10 })
    expect(t.overlay().gizmo?.active).toBe("x")
    act(t, { type: "axis", axis: "x" }, "x")
    expect(first()).toEqual({ x: 20, y: 5, z: 15 })
    act(t, { type: "axis", axis: "z" }, "z")
    expect(first()).toEqual({ x: 10, y: 5, z: 15 })
    // Undo mid-drag only cancels the drag.
    const depth = store.getState().history.undoDepth
    expect(act(t, { type: "undo" }, "z")).toBe(true)
    expect(store.getState().history.undoDepth).toBe(depth)
    expect(t.shape(a).points[0]).toEqual({ x: 10, y: 5, z: 10 })
    // Axis keys do nothing outside a drag.
    expect(act(t, { type: "axis", axis: "y" }, "y")).toBe(false)
  })

  it("Delete, Mod+D, Mod+A, arrow nudges (coalesced) and R act on the shape selection", () => {
    const t = setup()
    const { a, b, store, levelId } = t
    click(t, t.at(15, 5, 15))
    expect(act(t, { type: "duplicate" })).toBe(true)
    const copyId = t.sel()!.shapeIds[0]
    expect(copyId).not.toBe(a)
    const copy = t.shape(copyId)
    expect(copy).toMatchObject({ order: 2, base: 0 })
    expect(copy.points[0]).toEqual({ x: 15, y: 5, z: 15 })
    expect(store.getState().history.undoLabel).toBe("Duplicate terrain shape")
    expect(act(t, { type: "delete" })).toBe(true)
    expect(
      t
        .shapes()
        .map((s) => s.id)
        .sort()
    ).toEqual([a, b].sort())
    expect(t.sel()).toBeNull()

    expect(act(t, { type: "select-all" })).toBe(true)
    expect(t.sel()).toEqual({ levelId, shapeIds: [a, b], elements: [] })
    const depth = store.getState().history.undoDepth
    act(t, { type: "nudge", x: 1, z: 0, fine: false })
    act(t, { type: "nudge", x: 1, z: 0, fine: false })
    act(t, { type: "nudge", x: 0, z: -1, fine: true })
    expect(store.getState().history.undoDepth).toBe(depth + 1)
    expect(t.shape(a).points[0]).toEqual({ x: 20, y: 5, z: 9 })
    expect(t.shape(b).points[0]).toEqual({ x: 50, y: 3, z: 39 })

    const r = t.add(blockShape("r", { x: 60, z: 10, w: 20, d: 10 }, 0, 2, 3))
    click(t, t.at(70, 2, 15))
    expect(act(t, { type: "rotate", turns: 1 })).toBe(true)
    const rb = t.shape(r).points
    expect(Math.min(...rb.map((p) => p.x))).toBe(65)
    expect(Math.max(...rb.map((p) => p.x))).toBe(75)
    expect(Math.min(...rb.map((p) => p.z))).toBe(5)
    expect(Math.max(...rb.map((p) => p.z))).toBe(25)
    expect(t.height(70, 22.5)).toBe(2)
  })
})

describe("terrain select: advanced mode", () => {
  function advanced() {
    const t = setup()
    click(t, t.at(15, 5, 15))
    expect(act(t, { type: "terrain-advanced" }, "Tab")).toBe(true)
    expect(t.store.getState().toolSettings.terrain.advanced).toBe(true)
    expect(t.overlay().elements).toEqual({ mode: "vertex", selected: [], hover: null })
    return t
  }

  it("Tab needs a shape selection (without one it is left to focus navigation); 1 / 2 / 3 pick the element kind", () => {
    const t = setup()
    expect(act(t, { type: "terrain-advanced" }, "Tab")).toBe(false)
    expect(t.store.getState().toolSettings.terrain.advanced).toBe(false)
    expect(t.tool.hint()).not.toMatch(/Select a shape/)
    // The options bar's Advanced switch (no physical key) still explains why nothing happened.
    expect(act(t, { type: "terrain-advanced" })).toBe(true)
    expect(t.tool.hint()).toMatch(/Select a shape/)
    click(t, t.at(15, 5, 15))
    expect(t.tool.hint()).toMatch(/1 \/ 2 \/ 3: edit vertices\/edges\/faces/)
    act(t, { type: "terrain-element", element: "edge" }, "2")
    expect(t.store.getState().toolSettings.terrain).toMatchObject({ advanced: true, element: "edge" })
    expect(t.overlay().elements?.mode).toBe("edge")
    act(t, { type: "terrain-advanced" }, "Tab")
    expect(t.overlay().elements).toBeNull()
  })

  it("selects a vertex in screen space and drags it (absolute snap); a self-intersecting move is refused", () => {
    const t = advanced()
    const { tool, a, store } = t
    const v = t.at(20, 5, 20)
    click(t, t.px(v.canvasX! + 3, v.canvasY! - 2))
    expect(t.sel()?.elements).toEqual([{ shapeId: a, kind: "vertex", index: 2 }])
    tool.onPointerMove!(t.px(v.canvasX! + 1, v.canvasY!))
    expect(t.overlay().elements?.hover).toEqual({ shapeId: a, kind: "vertex", index: 2 })

    tool.onPointerDown!(v)
    tool.onPointerMove!(t.at(24.1, 5, 26.3))
    expect(t.overlay().shapes.find((s) => s.id === a)!.points[2]).toEqual({ x: 25, y: 5, z: 25 })
    // Across the opposite edge: the shape would cross itself, so the drag stays where it was valid.
    tool.onPointerMove!(t.at(15, 5, 5))
    expect(t.overlay().shapes.find((s) => s.id === a)!.points[2]).toEqual({ x: 25, y: 5, z: 25 })
    tool.onPointerUp!(t.at(15, 5, 5))
    expect(store.getState().history.undoLabel).toBe("Move terrain vertices")
    expect(xyz(t.shape(a).points)).toEqual([
      [10, 5, 10],
      [20, 5, 10],
      [25, 5, 25],
      [10, 5, 20],
    ])
    expect(t.sel()?.elements).toEqual([{ shapeId: a, kind: "vertex", index: 2 }])
  })

  it("moves a vertex vertically with the Y axis (tops only)", () => {
    const t = advanced()
    const { tool, a } = t
    const v = t.at(20, 5, 20)
    click(t, v)
    tool.onPointerDown!(v)
    tool.onPointerMove!(t.px(v.canvasX! + 6, v.canvasY!))
    act(t, { type: "axis", axis: "y" }, "y")
    tool.onPointerMove!(raised(t, v, { x: 20, y: 5, z: 20 }, 3))
    tool.onPointerUp!(raised(t, v, { x: 20, y: 5, z: 20 }, 3))
    const s = t.shape(a)
    expect(s.base).toBe(0)
    expect(s.points.map((p) => p.y)).toEqual([5, 5, 8, 5])
    expect(xyz(s.points)[2]).toEqual([20, 8, 20])
  })

  it("edges and faces: pick, drag, marquee", () => {
    const t = advanced()
    const { tool, a } = t
    act(t, { type: "terrain-element", element: "edge" }, "2")
    const mid = t.at(15, 5, 10)
    click(t, t.px(mid.canvasX!, mid.canvasY! + 2))
    expect(t.sel()?.elements).toEqual([{ shapeId: a, kind: "edge", index: 0 }])
    tool.onPointerDown!(mid)
    tool.onPointerMove!(t.at(15, 5, 5))
    tool.onPointerUp!(t.at(15, 5, 5))
    expect(xyz(t.shape(a).points).map(([x, , z]) => [x, z])).toEqual([
      [10, 5],
      [20, 5],
      [20, 20],
      [10, 20],
    ])

    act(t, { type: "terrain-element", element: "face" }, "3")
    click(t, t.at(15, 5, 12))
    expect(t.sel()?.elements).toEqual([{ shapeId: a, kind: "face", index: "top" }])
    // The near side (under edge 2, facing the camera), raised with the Y axis: its two top vertices move.
    const side = t.at(15, 2.5, 20)
    // Deselect the top face first: its gizmo's rotate ring runs along this block's edges in this view.
    expect(act(t, { type: "escape" }, "Escape")).toBe(true)
    click(t, side)
    expect(t.sel()?.elements).toEqual([{ shapeId: a, kind: "face", index: 2 }])
    tool.onPointerDown!(side)
    tool.onPointerMove!(t.px(side.canvasX! + 6, side.canvasY!))
    act(t, { type: "axis", axis: "y" }, "y")
    tool.onPointerMove!(raised(t, side, { x: 15, y: 2.5, z: 20 }, 2))
    tool.onPointerUp!(raised(t, side, { x: 15, y: 2.5, z: 20 }, 2))
    expect(t.shape(a).points.map((p) => p.y)).toEqual([5, 5, 7, 7])
    expect(t.height(15, 17.5)).toBeGreaterThan(5)

    // Marquee (vertex mode): a screen box around the right-hand corners.
    act(t, { type: "terrain-element", element: "vertex" }, "1")
    const from = t.at(23, 5, 2)
    const to = t.at(17, 5, 23)
    tool.onPointerDown!(from)
    tool.onPointerMove!(to)
    tool.onPointerUp!(to)
    expect(t.sel()?.elements.map((e) => e.index)).toEqual([1, 2])
    // Shift adds; a click on nothing clears the elements (the shape stays selected).
    const lone = t.at(10, 5, 20)
    tool.onPointerDown!(t.px(lone.canvasX! - 6, lone.canvasY! - 6, { shift: true }))
    tool.onPointerMove!(t.px(lone.canvasX! + 6, lone.canvasY! + 6, { shift: true }))
    tool.onPointerUp!(t.px(lone.canvasX! + 6, lone.canvasY! + 6, { shift: true }))
    expect(t.sel()?.elements.map((e) => e.index)).toEqual([1, 2, 3])
    click(t, t.at(80, 0, 80))
    expect(t.sel()).toMatchObject({ shapeIds: [a], elements: [] })
  })

  it("an edge under the rotate ring takes the click when it is nearer than the ring", () => {
    const t = terrainHarness({ sub: "select" })
    // A 16 × 16 block over (60, 60)–(76, 76); edge 1 runs up x = 76, edge 2 back along z = 76.
    const c = t.add(blockShape("c", { x: 60, z: 60, w: 16, d: 16 }, 0, 5, 0))
    click(t, t.at(68, 5, 68))
    act(t, { type: "terrain-advanced" }, "Tab")
    act(t, { type: "terrain-element", element: "edge" }, "2")
    click(t, t.at(68, 5, 76))
    expect(t.store.getState().terrainSelection?.elements).toEqual([{ shapeId: c, kind: "edge", index: 2 }])
    // The gizmo sits at edge 2's middle; its ring (8.8 ft at this zoom) crosses edge 1.
    const ring = gizmoRing(t.camera.project, { x: 68, y: 5, z: 76 })
    let hit: { x: number; y: number } | null = null
    for (let i = 1; i < 160 && !hit; i++) {
      const q = t.camera.project({ x: 76, y: 5, z: 60 + i / 10 })
      const d = ringDistancePx(ring, q)
      if (d > 2 && d < 6) hit = { x: q.x, y: q.y }
    }
    expect(hit).not.toBeNull()
    click(t, t.px(hit!.x, hit!.y))
    expect(t.store.getState().terrainSelection?.elements).toEqual([{ shapeId: c, kind: "edge", index: 1 }])
  })

  it("side and bottom edges: picked, moved (sideways; Y lifts a side edge's top, a bottom edge's base) and deleted", () => {
    const t = terrainHarness({ sub: "select", camera: perspectiveCamera({ tilt: 40, distance: 90, target: { x: 30, y: 0, z: 30 } }) })
    const { tool, store } = t
    // A 20 × 20 block, 10 ft tall, standing on a base at 0: corner k's side edge is edge 4 + k, the bottom
    // edge under top edge k is 8 + k.
    const id = t.add(blockShape("box", { x: 20, z: 20, w: 20, d: 20 }, 0, 10, 0))
    click(t, t.at(30, 10, 30))
    act(t, { type: "terrain-advanced" }, "Tab")
    act(t, { type: "terrain-element", element: "edge" }, "2")
    const sel = () => store.getState().terrainSelection?.elements
    // Halfway down the near-right corner (40, 40): its side edge.
    const side = t.at(40, 5, 40)
    click(t, side)
    expect(sel()).toEqual([{ shapeId: id, kind: "edge", index: 6 }])
    // Its highlight runs from the top corner down to the base.
    expect(t.overlay().elements?.selected).toEqual([{ shapeId: id, kind: "edge", index: 6 }])
    // Along the near bottom edge (z 40, under top edge 2).
    const bottom = t.at(30, 0, 40)
    click(t, bottom)
    expect(sel()).toEqual([{ shapeId: id, kind: "edge", index: 10 }])
    // Dragged down with the Y arrow the bottom edge lowers the base (one height for the shape); the top stays.
    const at = { x: 30, y: 0, z: 40 }
    const arrow = onArrow(t, at, "y")
    tool.onPointerDown!(arrow)
    tool.onPointerMove!(raised(t, arrow, at, -3))
    tool.onPointerUp!(raised(t, arrow, at, -3))
    expect(t.shape(id).base).toBe(-3)
    expect(t.shape(id).points.every((p) => p.y === 10)).toBe(true)
    // The side edge dragged up lifts its corner's top only.
    click(t, t.at(40, 5, 40))
    expect(sel()).toEqual([{ shapeId: id, kind: "edge", index: 6 }])
    const sideAt = { x: 40, y: 3.5, z: 40 }
    const lift = onArrow(t, sideAt, "y")
    tool.onPointerDown!(lift)
    tool.onPointerMove!(raised(t, lift, sideAt, 2))
    tool.onPointerUp!(raised(t, lift, sideAt, 2))
    expect(t.shape(id).points.map((p) => p.y)).toEqual([10, 10, 12, 10])
    expect(t.shape(id).base).toBe(-3)
    // Delete on a side edge dissolves its corner.
    expect(act(t, { type: "delete" }, "Delete")).toBe(true)
    expect(t.shape(id).points).toHaveLength(3)
    expect(store.getState().history.undoLabel).toBe("Dissolve terrain vertices")
  })

  it("faces of a cut top are picked, box selected and moved one by one", () => {
    const t = advanced()
    const { a, store, levelId } = t
    // Cut the 10 × 10 block (y 5) left to right, then top to bottom: four top faces around (15, 15).
    const once = loopCut(t.shape(a), 1, [0.5])!.shape
    const cut = loopCut(once, 0, [0.5])!.shape
    expect(store.getState().applyTerrainEdit(levelId, { upsert: [cut] }, "Cut")).toBe(true)
    const faces = topFaces(cut)
    expect(faces).toHaveLength(4)
    const n = cut.points.length
    act(t, { type: "terrain-element", element: "face" }, "3")
    // A click on the top picks the face under the pointer (element n + f), not the whole top.
    click(t, t.at(12, 5, 12))
    const [picked] = t.sel()!.elements
    expect(picked).toMatchObject({ shapeId: a, kind: "face" })
    const f = (picked.index as number) - n
    const corners = faces[f].map((k) => [t.shape(a).points[k] ?? t.shape(a).innerPoints![k - n]]).flat()
    expect(corners.every((p) => p.x <= 15 && p.z <= 15)).toBe(true)
    // Its overlay highlight is that face only.
    expect(t.overlay().elements?.selected).toEqual([picked])
    // Raised with the Y arrow: only that quarter's vertices move (the crossing and three on the outline).
    const at = { x: 12.5, y: 5, z: 12.5 }
    const arrow = onArrow(t, at, "y")
    t.tool.onPointerDown!(arrow)
    t.tool.onPointerMove!(raised(t, arrow, at, 2))
    t.tool.onPointerUp!(raised(t, arrow, at, 2))
    const moved = [...t.shape(a).points, ...t.shape(a).innerPoints!].filter((p) => p.y === 7)
    expect(moved).toHaveLength(4)
    // Select all takes the four top faces and the sides, not the whole top.
    act(t, { type: "select-all" }, "a")
    const all = t.sel()!.elements.map((e) => e.index)
    expect(all).not.toContain("top")
    expect(all.filter((i) => (i as number) >= n)).toHaveLength(4)
  })

  it("Delete dissolves vertices / collapses edges (a shape keeps 3 vertices); faces need object mode", () => {
    const t = advanced()
    const { a, store } = t
    click(t, t.at(10, 5, 20))
    expect(act(t, { type: "delete" })).toBe(true)
    expect(t.shape(a).points).toHaveLength(3)
    expect(store.getState().history.undoLabel).toBe("Dissolve terrain vertices")
    expect(t.sel()?.elements).toEqual([])
    click(t, t.at(10, 5, 10))
    const before = t.shape(a)
    act(t, { type: "delete" })
    expect(t.shape(a)).toBe(before)
    expect(t.tool.hint()).toBe(NEED_THREE_VERTICES)

    const c = t.add(cylinderShape("cyl", { x: 70, z: 70 }, 10, 8, 0, 4, 5))
    click(t, t.at(80, 80, 80))
    act(t, { type: "escape" })
    act(t, { type: "escape" })
    click(t, t.at(70, 4, 70))
    act(t, { type: "terrain-element", element: "edge" }, "2")
    const p0 = t.shape(c).points[0]
    const p1 = t.shape(c).points[1]
    click(t, t.at((p0.x + p1.x) / 2, 4, (p0.z + p1.z) / 2))
    expect(t.sel()?.elements).toEqual([{ shapeId: c, kind: "edge", index: 0 }])
    act(t, { type: "delete" })
    expect(t.shape(c).points).toHaveLength(7)
    expect(t.shape(c).points[0].x).toBeCloseTo((p0.x + p1.x) / 2)

    act(t, { type: "terrain-element", element: "face" }, "3")
    click(t, t.at(70, 4, 70))
    act(t, { type: "delete" })
    expect(t.shapes()).toHaveLength(3)
    expect(t.tool.hint()).toMatch(/object mode/)
  })

  it("a press on the selected element of an overlap drags it: clicks cycle, presses keep the selection", () => {
    // A block large enough that the corner stays clear of the gizmo arrows (at the selected edge's middle).
    const t = terrainHarness({ sub: "select" })
    const { tool } = t
    const big = t.add(blockShape("big", { x: 10, z: 10, w: 30, d: 30 }, 0, 5, 0))
    click(t, t.at(25, 5, 25))
    act(t, { type: "terrain-advanced" }, "Tab")
    act(t, { type: "terrain-element", element: "edge" }, "2")
    const sel = () => t.store.getState().terrainSelection?.elements
    // Near the corner (10, 40): edges 2 and 3 are both within reach, edge 2 nearest.
    const spot = t.at(10.4, 5, 39.8)
    click(t, spot)
    expect(sel()).toEqual([{ shapeId: big, kind: "edge", index: 2 }])
    tool.onPointerDown!(spot)
    expect(sel()).toEqual([{ shapeId: big, kind: "edge", index: 2 }])
    tool.onPointerMove!(t.at(10.4, 5, 42.3))
    tool.onPointerMove!(t.at(10.4, 5, 44.8))
    tool.onPointerUp!(t.at(10.4, 5, 44.8))
    expect(xz(t.shape(big).points)).toEqual([
      [10, 10],
      [40, 10],
      [40, 45],
      [10, 45],
    ])
    // Repeated clicks still cycle through the overlapping elements: the two top edges first, then the side
    // and bottom edges at that corner (they rank after top edges), then round again.
    const corner = t.at(10.4, 5, 44.8)
    const picks: number[] = []
    for (let k = 0; k < 6; k++) {
      click(t, corner)
      picks.push(sel()![0].index as number)
    }
    expect(picks.slice(0, 2)).toEqual([2, 3])
    const round = picks.indexOf(2, 1)
    expect(round).toBeGreaterThan(2)
    expect(picks.slice(2, round).every((k) => k >= 4)).toBe(true)
  })

  it("a press on a visible unselected vertex drags it, not a selected one within reach", () => {
    // A thin block: its corners at x 40 and 40.6 are a few px apart on screen, both within the pick radius.
    const t = terrainHarness({ sub: "select" })
    const sel = () => t.store.getState().terrainSelection
    const { tool } = t
    const n = t.add(blockShape("n", { x: 40, z: 40, w: 0.6, d: 10 }, 0, 5, 0))
    click(t, t.at(40.3, 5, 45))
    act(t, { type: "terrain-advanced" }, "Tab")
    click(t, t.at(40, 5, 40))
    expect(sel()?.elements).toEqual([{ shapeId: n, kind: "vertex", index: 0 }])
    const v1 = t.at(40.6, 5, 40)
    tool.onPointerMove!(v1)
    expect(t.overlay().elements?.hover).toEqual({ shapeId: n, kind: "vertex", index: 1 })
    tool.onPointerDown!(v1)
    expect(sel()?.elements).toEqual([{ shapeId: n, kind: "vertex", index: 1 }])
    // (Alt: free, so the vertex keeps its x.)
    tool.onPointerMove!(t.at(40.6, 5, 35, { alt: true }))
    tool.onPointerMove!(t.at(40.6, 5, 30, { alt: true }))
    tool.onPointerUp!(t.at(40.6, 5, 30, { alt: true }))
    const pts = t.shape(n).points
    expect(pts[0]).toEqual({ x: 40, y: 5, z: 40 })
    expect(pts[1].x).toBeCloseTo(40.6, 6)
    expect(pts[1].z).toBeCloseTo(30, 6)
  })

  it("a click inside the edited shape clears its elements; it never takes a shape hidden under it", () => {
    const t = terrainHarness({ sub: "select" })
    const sel = () => t.store.getState().terrainSelection
    const { tool, levelId } = t
    const p = t.add(blockShape("p", { x: 10, z: 10, w: 40, d: 40 }, 0, 5, 0))
    const c = t.add(blockShape("c", { x: 20, z: 20, w: 10, d: 10 }, 0, 8, 1))
    click(t, t.at(25, 8, 25))
    act(t, { type: "terrain-advanced" }, "Tab")
    click(t, t.at(20, 8, 20))
    const v0 = { shapeId: c, kind: "vertex", index: 0 }
    expect(sel()).toEqual({ levelId, shapeIds: [c], elements: [v0] })
    // Inside c's top (p lies under it): no hover, Shift+click keeps the selection, a click clears the elements.
    const inside = t.at(24, 8, 26)
    tool.onPointerMove!(inside)
    expect(t.overlay().hoverShapeId).toBeNull()
    click(t, t.at(24, 8, 26, { shift: true }))
    expect(sel()).toEqual({ levelId, shapeIds: [c], elements: [v0] })
    click(t, inside)
    expect(sel()).toEqual({ levelId, shapeIds: [c], elements: [] })
    // Where p is visible a click still switches the edit session to it.
    tool.onPointerMove!(t.at(40, 5, 40))
    expect(t.overlay().hoverShapeId).toBe(p)
    click(t, t.at(40, 5, 40))
    expect(sel()).toEqual({ levelId, shapeIds: [p], elements: [] })
  })

  it("a click inside an edited pit clears its elements (not the plateau it carves); an unselected pit takes the click", () => {
    const t = terrainHarness({ sub: "select" })
    const sel = () => t.store.getState().terrainSelection
    const { tool, store, levelId } = t
    const p = t.add(blockShape("p", { x: 10, z: 10, w: 60, d: 60 }, 0, 5, 0))
    const c = t.add(blockShape("c", { x: 30, z: 30, w: 10, d: 10 }, 5, -3, 1))
    store.getState().setTerrainSelection({ levelId, shapeIds: [c], elements: [] })
    act(t, { type: "terrain-advanced" }, "Tab")
    click(t, t.at(30, 2, 30))
    expect(sel()).toEqual({ levelId, shapeIds: [c], elements: [{ shapeId: c, kind: "vertex", index: 0 }] })
    // Inside the pit, away from its vertices: p's top is hit first there, but the pit floor is what shows.
    const inside = t.at(35, 2, 35)
    tool.onPointerMove!(inside)
    expect(t.overlay().hoverShapeId).toBeNull()
    click(t, inside)
    expect(sel()).toEqual({ levelId, shapeIds: [c], elements: [] })
    // Where p is visible a click switches the edit session to it; from p, a click in the pit switches to c.
    tool.onPointerMove!(t.at(60, 5, 60))
    expect(t.overlay().hoverShapeId).toBe(p)
    click(t, t.at(60, 5, 60))
    expect(sel()).toEqual({ levelId, shapeIds: [p], elements: [] })
    tool.onPointerMove!(inside)
    expect(t.overlay().hoverShapeId).toBe(c)
    click(t, inside)
    expect(sel()).toEqual({ levelId, shapeIds: [c], elements: [] })
  })

  it("a press on a shared edge keeps the selected one of the coincident edges, whichever shape comes first", () => {
    // [selected shape, its shared edge, the other shape, the selected shape's x after the drag]
    const cases = [
      ["a", 1, "b", [10, 45, 45, 10]],
      ["b", 3, "a", [45, 70, 70, 45]],
    ] as const
    for (const [held, index, other, xs] of cases) {
      const t = terrainHarness({ sub: "select" })
      const sel = () => t.store.getState().terrainSelection
      const { tool, store, levelId } = t
      // Side by side, sharing the edge x 40 (a's edge 1, b's edge 3): both are hit at the same distance.
      t.add(blockShape("a", { x: 10, z: 10, w: 30, d: 60 }, 0, 5, 0))
      t.add(blockShape("b", { x: 40, z: 10, w: 30, d: 60 }, 0, 5, 1))
      store.getState().setToolSettings("terrain", { advanced: true, element: "edge" })
      const edge = { shapeId: held, kind: "edge" as const, index }
      store.getState().setTerrainSelection({ levelId, shapeIds: ["a", "b"], elements: [edge] })
      const untouched = t.shape(other)
      // Far along the edge from the gizmo (at its middle), at a fresh spot.
      const spot = t.at(40, 5, 16)
      tool.onPointerMove!(spot)
      expect(t.overlay().elements?.hover, held).toEqual(edge)
      tool.onPointerDown!(spot)
      tool.onPointerMove!(t.at(42.5, 5, 16))
      tool.onPointerMove!(t.at(45, 5, 16))
      tool.onPointerUp!(t.at(45, 5, 16))
      expect(sel()?.elements, held).toEqual([edge])
      const moved = t.shape(held).points.map((q) => q.x)
      expect(moved, held).toEqual(xs)
      expect(t.shape(other), held).toBe(untouched)
    }
  })

  it("Shift+click on another shape adds it to the edit session and keeps the elements", () => {
    const t = advanced()
    const { a, b } = t
    const v0 = t.at(10, 5, 10)
    click(t, v0)
    click(t, t.at(20, 5, 10, { shift: true }))
    const elements = [
      { shapeId: a, kind: "vertex", index: 0 },
      { shapeId: a, kind: "vertex", index: 1 },
    ]
    expect(t.sel()?.elements).toEqual(elements)
    click(t, t.at(45, 3, 45, { shift: true }))
    expect(t.sel()).toMatchObject({ shapeIds: [a, b], elements })
  })

  it("outside the Select sub-tool the keys act on the whole shapes the overlay shows", () => {
    const t = advanced()
    const { a, b, store } = t
    click(t, t.at(20, 5, 20))
    expect(t.sel()?.elements).toEqual([{ shapeId: a, kind: "vertex", index: 2 }])
    store.getState().setToolSettings("terrain", { sub: "brush" })
    expect(t.overlay().elements).toBeNull()
    expect(t.overlay().selectedShapeIds).toEqual([a])
    // Arrow: the whole shape moves (not the hidden vertex).
    act(t, { type: "nudge", x: 1, z: 0, fine: false })
    expect(xz(t.shape(a).points)).toEqual([
      [15, 10],
      [25, 10],
      [25, 20],
      [15, 20],
    ])
    // Tab goes back to Select in the advanced mode.
    expect(act(t, { type: "terrain-advanced" }, "Tab")).toBe(true)
    expect(store.getState().toolSettings.terrain).toMatchObject({ sub: "select", advanced: true })
    expect(t.overlay().elements?.selected).toEqual([{ shapeId: a, kind: "vertex", index: 2 }])
    // Mod+D and R act on the shape; one Escape clears the visible selection.
    store.getState().setToolSettings("terrain", { sub: "block" })
    expect(act(t, { type: "rotate", turns: 1 })).toBe(true)
    expect(store.getState().history.undoLabel).toBe("Rotate terrain shape")
    expect(act(t, { type: "duplicate" })).toBe(true)
    expect(t.shapes()).toHaveLength(3)
    expect(act(t, { type: "escape" })).toBe(true)
    expect(t.sel()).toBeNull()
    // Delete removes the shape rather than dissolving a hidden vertex.
    store.getState().setToolSettings("terrain", { sub: "select" })
    click(t, t.at(45, 3, 45))
    act(t, { type: "terrain-advanced" }, "Tab")
    click(t, t.at(50, 3, 50))
    expect(t.sel()?.elements).toHaveLength(1)
    store.getState().setToolSettings("terrain", { sub: "brush" })
    act(t, { type: "delete" })
    expect(t.shapes().map((s) => s.id)).not.toContain(b)
    expect(t.sel()).toBeNull()
  })

  it("Escape: gesture → elements → advanced mode → shape selection → not consumed", () => {
    const t = advanced()
    const { tool, a } = t
    const v = t.at(20, 5, 20)
    click(t, v)
    tool.onPointerDown!(v)
    tool.onPointerMove!(t.at(25, 5, 25))
    expect(act(t, { type: "escape" })).toBe(true)
    expect(t.shape(a).points[2]).toEqual({ x: 20, y: 5, z: 20 })
    expect(t.sel()?.elements).toHaveLength(1)
    expect(act(t, { type: "escape" })).toBe(true)
    expect(t.sel()?.elements).toEqual([])
    expect(t.store.getState().toolSettings.terrain.advanced).toBe(true)
    expect(act(t, { type: "escape" })).toBe(true)
    expect(t.store.getState().toolSettings.terrain.advanced).toBe(false)
    expect(t.sel()?.shapeIds).toEqual([a])
    expect(act(t, { type: "escape" })).toBe(true)
    expect(t.sel()).toBeNull()
    expect(act(t, { type: "escape" })).toBe(false)
  })
})
