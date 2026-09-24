import { describe, expect, it } from "vitest"

import { blockShape, cylinderShape, shapeTopAt } from "@/core/scene/terrainShapes"

import { key } from "../../test-utils"
import { terrainHarness } from "./harness"

const brush = (factor: number) => key(factor > 1 ? "]" : "[", { action: { type: "brush-size", factor } })

describe("terrain loop cut", () => {
  it("hover previews a cut across the top; a click cuts (one undo step) and selects the new edge", () => {
    const t = terrainHarness({ sub: "loopcut" })
    const { tool, store, levelId } = t
    // A 20 × 10 block at y 4; edge 0 runs (20, 20) → (40, 20).
    const id = t.add(blockShape("b", { x: 20, z: 20, w: 20, d: 10 }, 0, 4, 0))
    expect(tool.hint()).toMatch(/Point at a shape's side/)
    // Over the top near the bottom side, a quarter along it (snapped to eighths).
    tool.onPointerMove!(t.at(25.3, 4, 21))
    const o = t.overlay()
    expect(o.hoverShapeId).toBe(id)
    expect(o.cuts?.valid).toBe(true)
    expect(o.cuts?.segments.map(([a, b]) => [a.x, a.z, b.x, b.z])).toEqual([[25, 20, 25, 30]])
    expect(o.label?.text).toBe("5 | 15 ft")
    expect(tool.cursorKeys!()?.map((k) => k.label)).toEqual(["Cut", "Fewer / more cuts", "Free position"])

    tool.onPointerDown!(t.at(25.3, 4, 21))
    tool.onPointerUp!(t.at(25.3, 4, 21))
    const shape = t.shape(id)
    expect(shape.points.map((p) => [p.x, p.z])).toEqual([
      [20, 20],
      [25, 20],
      [40, 20],
      [40, 30],
      [25, 30],
      [20, 30],
    ])
    expect(shape.innerEdges).toEqual([[1, 4]])
    expect(store.getState().history).toMatchObject({ undoDepth: 2, undoLabel: "Loop cut terrain shape" })
    // The terrain is unchanged: the cut keeps the top's form.
    expect(t.height(30, 25)).toBe(4)
    // The new inner edge is selected in the edge mode.
    expect(store.getState().terrainSelection).toEqual({ levelId, shapeIds: [id], elements: [{ shapeId: id, kind: "edge", index: 6 }] })
    expect(store.getState().toolSettings.terrain).toMatchObject({ advanced: true, element: "edge" })
    // The overlay draws the selected inner edge as an element.
    expect(t.overlay().elements?.selected).toEqual([{ shapeId: id, kind: "edge", index: 6 }])
    store.getState().undo()
    expect(t.shape(id).innerEdges).toBeUndefined()
  })

  it("[ / ] set the number of evenly spaced cuts; Alt places one cut freely", () => {
    const t = terrainHarness({ sub: "loopcut" })
    const { tool, store } = t
    const id = t.add(blockShape("b", { x: 20, z: 20, w: 20, d: 10 }, 0, 4, 0))
    expect(tool.onKeyDown!(brush(1.25))).toBe(true)
    expect(tool.onKeyDown!(brush(1.25))).toBe(true)
    expect(store.getState().toolSettings.terrain.loopCuts).toBe(3)
    // Brush size untouched.
    expect(store.getState().toolSettings.brush.radius).toBe(10)
    tool.onPointerMove!(t.at(33, 4, 21))
    expect(t.overlay().cuts?.segments.map(([a]) => a.x)).toEqual([25, 30, 35])
    expect(t.overlay().label?.text).toBe("3 cuts")
    tool.onPointerDown!(t.at(33, 4, 21))
    expect(t.shape(id).innerEdges).toHaveLength(3)
    expect(store.getState().history.undoLabel).toBe("Loop cut terrain shape (3 cuts)")
    expect(store.getState().terrainSelection?.elements).toHaveLength(3)
    // Down to one cut, never below.
    for (let k = 0; k < 4; k++) tool.onKeyDown!(brush(0.8))
    expect(store.getState().toolSettings.terrain.loopCuts).toBe(1)

    // Alt: a free position along the side (here on the short left side, x = 20, from (20, 30) to (20, 20)).
    store.getState().undo()
    store.getState().setAltHeld(true)
    tool.onPointerMove!(t.at(21, 4, 27.3))
    const [[a, b]] = t.overlay().cuts!.segments
    expect(a.x).toBe(20)
    expect(a.z).toBeCloseTo(27.3, 6)
    expect(b.x).toBe(40)
    expect(b.z).toBeCloseTo(27.3, 6)
  })

  it("refuses where there is no loop (odd faces) and explains why", () => {
    const t = terrainHarness({ sub: "loopcut" })
    const { tool, store } = t
    const id = t.add(cylinderShape("c", { x: 40, z: 40 }, 8, 7, 0, 3, 0))
    tool.onPointerMove!(t.at(40, 3, 40))
    expect(t.overlay().cuts?.valid).toBe(false)
    expect(t.overlay().label?.text).toBe("Can't cut here")
    expect(tool.hint()).toMatch(/odd number of sides/)
    expect(tool.cursorKeys!()).toBeNull()
    const before = store.getState().scene
    tool.onPointerDown!(t.at(40, 3, 40))
    expect(store.getState().scene).toBe(before)
    expect(t.shape(id).innerEdges).toBeUndefined()
    // Off the shapes: nothing to preview.
    tool.onPointerMove!(t.at(80, 0, 80))
    expect(t.overlay().cuts ?? null).toBeNull()
  })

  it("a raised cut makes a ridge; deleting the inner edge in the edge mode removes the cut", () => {
    const t = terrainHarness({ sub: "loopcut" })
    const { tool, store, levelId } = t
    const id = t.add(blockShape("b", { x: 20, z: 20, w: 20, d: 10 }, 0, 4, 0))
    tool.onPointerMove!(t.at(30, 4, 21))
    tool.onPointerDown!(t.at(30, 4, 21))
    const cut = t.shape(id)
    const [i, j] = cut.innerEdges![0]
    const raised = { ...cut, points: cut.points.map((p, k) => (k === i || k === j ? { ...p, y: 7 } : p)) }
    expect(store.getState().applyTerrainEdit(levelId, { upsert: [raised] }, "Raise")).toBe(true)
    expect(shapeTopAt(t.shape(id), 30, 22)).toBeCloseTo(7, 9)
    expect(shapeTopAt(t.shape(id), 25, 28)).toBeCloseTo(5.5, 9)
    // Select + Delete on the inner edge (still selected) removes the cut, keeping the vertices.
    store.getState().setToolSettings("terrain", { sub: "select" })
    expect(tool.onKeyDown!(key("Delete", { action: { type: "delete" } }))).toBe(true)
    expect(store.getState().history.undoLabel).toBe("Remove terrain loop cuts")
    expect(t.shape(id).innerEdges).toBeUndefined()
    expect(t.shape(id).points).toHaveLength(6)
  })
})
