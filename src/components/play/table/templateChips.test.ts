import { describe, expect, it } from "vitest"

import { stackChip } from "./templateChips"

describe("stackChip", () => {
  it("keeps a chip that overlaps nothing where it is", () => {
    expect(stackChip([], { x: 0, y: 50, w: 80, h: 20 }).y).toBe(50)
    expect(
      stackChip([{ x: 200, y: 50, w: 80, h: 20 }], {
        x: 0,
        y: 50,
        w: 80,
        h: 20,
      }).y
    ).toBe(50)
  })

  it("moves an overlapping chip above the ones already placed, through a stack", () => {
    const placed = [
      { x: 0, y: 100, w: 80, h: 20 },
      { x: 10, y: 78, w: 80, h: 20 },
    ]
    const r = stackChip(placed, { x: 20, y: 95, w: 80, h: 20 })
    expect(r.y).toBe(56)
    expect(r.x).toBe(20)
  })
})
