import { describe, expect, it } from "vitest"

import { createScene } from "@/core/scene/factory"
import type { GridSettings } from "@/core/scene/types"

import { at, key, makeStore } from "../test-utils"
import { createMeasureTool, formatFeet, legCells, measureDistance } from "./measure"

const grid = (diagonalRule: GridSettings["diagonalRule"]): GridSettings => ({ cellSize: 5, width: 20, depth: 20, diagonalRule })

describe("measure: distance", () => {
  it("expands legs into king moves (diagonals first)", () => {
    expect(legCells({ i: 0, j: 0 }, { i: 3, j: 1 })).toEqual([
      { i: 1, j: 1 },
      { i: 2, j: 1 },
      { i: 3, j: 1 },
    ])
    expect(legCells({ i: 2, j: 2 }, { i: 2, j: 2 })).toEqual([])
  })

  it("follows the grid's diagonal rule across the whole path", () => {
    const pts = [
      { x: 2.5, z: 2.5 },
      { x: 27.5, z: 12.5 },
    ]
    expect(measureDistance(grid("5-5-5"), pts, false)).toBe(25)
    expect(measureDistance(grid("5-10-5"), pts, false)).toBe(30)
    // One diagonal per leg: the second diagonal of the path costs 10 under 5-10-5.
    const legs = [
      { x: 2.5, z: 2.5 },
      { x: 7.5, z: 7.5 },
      { x: 12.5, z: 12.5 },
    ]
    expect(measureDistance(grid("5-10-5"), legs, false)).toBe(15)
    expect(measureDistance(grid("euclidean"), legs, false)).toBeCloseTo(10 * Math.SQRT2)
  })

  it("free mode is euclidean", () => {
    expect(measureDistance(grid("5-5-5"), [{ x: 0, z: 0 }, { x: 3, z: 4 }, { x: 3, z: 10 }], true)).toBe(11)
    expect(measureDistance(grid("5-5-5"), [{ x: 0, z: 0 }], true)).toBe(0)
    expect(formatFeet(11.26, true)).toBe("11.3 ft")
    expect(formatFeet(25.4, false)).toBe("25 ft")
  })
})

describe("measure tool", () => {
  it("accumulates waypoints and exposes a ruler overlay", () => {
    const scene = createScene({ width: 20, depth: 20 })
    const store = makeStore(scene)
    const levelId = store.getState().activeLevelId
    const tool = createMeasureTool({ store, now: () => 0 })
    expect(tool.ruler()).toBeNull()
    tool.onPointerDown!(at(1, 1, { clientX: 0 }))
    tool.onPointerMove!(at(26, 11))
    const r = tool.ruler()
    expect(r).toEqual({
      levelId,
      points: [
        { x: 2.5, y: 0, z: 2.5 },
        { x: 27.5, y: 0, z: 12.5 },
      ],
      label: "25 ft",
    })
    expect(tool.ruler()).toBe(r)
    tool.onPointerDown!(at(26, 11, { clientX: 100 }))
    tool.onPointerMove!(at(26, 31))
    expect(tool.distance()).toBe(45)
    // Right-click freezes the ruler at the placed waypoints.
    tool.onPointerDown!(at(26, 31, { button: 2 }))
    tool.onPointerMove!(at(90, 90))
    expect(tool.ruler()?.points).toHaveLength(2)
    expect(tool.ruler()?.label).toBe("25 ft")
    // The next click starts over; Escape clears.
    tool.onPointerDown!(at(50, 50, { clientX: 500 }))
    expect(tool.ruler()?.points).toHaveLength(1)
    expect(tool.onKeyDown!(key("Escape"))).toBe(true)
    expect(tool.ruler()).toBeNull()
    expect(tool.onKeyDown!(key("Escape"))).toBe(false)
  })

  it("Alt measures freely; clicking the last point again finishes", () => {
    const store = makeStore(createScene({ width: 20, depth: 20 }))
    const tool = createMeasureTool({ store, now: () => 0 })
    tool.onPointerDown!(at(0, 0, { alt: true, clientX: 0 }))
    tool.onPointerDown!(at(3, 4, { alt: true, clientX: 100 }))
    tool.onPointerDown!(at(3, 4, { alt: true, clientX: 300 }))
    tool.onPointerMove!(at(50, 50))
    expect(tool.ruler()?.label).toBe("5 ft")
    expect(tool.distance()).toBe(5)
  })

  it("ruler points follow the ground height", () => {
    const f = createScene({ width: 20, depth: 20 })
    const store = makeStore(f)
    const levelId = store.getState().activeLevelId
    store.getState().updateLevel(levelId, { elevation: 3 })
    const tool = createMeasureTool({ store, now: () => 0 })
    tool.onPointerDown!(at(1, 1))
    expect(tool.ruler()?.points[0].y).toBe(3)
  })
})
