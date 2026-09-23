import { describe, expect, it } from "vitest"

import { createScene } from "@/core/scene/factory"
import { formatFeet as playFormatFeet } from "@/play/geometry"

import { at, key, makeStore } from "../test-utils"

import { createMeasureTool, formatFeet } from "./measure"

describe("measure: distance", () => {
  // The distance itself is core/grid rulerDistance (tested there); the tool tests below check its wiring.
  it("formats feet like the play ruler", () => {
    expect(formatFeet(11.26)).toBe("11.3 ft")
    // Same text as the play ruler: whole feet when (nearly) whole, else one decimal.
    expect(formatFeet(25.02)).toBe("25 ft")
    expect(formatFeet(10 * Math.SQRT2)).toBe(playFormatFeet(10 * Math.SQRT2))
    expect(formatFeet(25.4)).toBe(playFormatFeet(25.4))
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
