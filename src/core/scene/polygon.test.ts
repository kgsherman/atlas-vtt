import { describe, expect, it } from "vitest"

import { signedArea } from "./polygon"

describe("signedArea", () => {
  const square = [
    { x: 0, z: 0 },
    { x: 10, z: 0 },
    { x: 10, z: 10 },
    { x: 0, z: 10 },
  ]

  it("is positive in the canonical orientation and flips sign when reversed", () => {
    expect(signedArea(square)).toBe(100)
    expect(signedArea([...square].reverse())).toBe(-100)
  })

  it("does not depend on the starting vertex or on collinear / repeated points", () => {
    expect(signedArea([...square.slice(2), ...square.slice(0, 2)])).toBe(100)
    expect(signedArea([square[0], { x: 5, z: 0 }, square[1], square[1], square[2], square[3]])).toBe(100)
  })

  it("is 0 for degenerate polygons", () => {
    expect(signedArea([])).toBe(0)
    expect(signedArea(square.slice(0, 2))).toBe(0)
    expect(
      signedArea([
        { x: 0, z: 0 },
        { x: 5, z: 5 },
        { x: 10, z: 10 },
      ])
    ).toBe(0)
  })

  it("accepts Vec3 points (y is ignored)", () => {
    expect(signedArea(square.map((p, k) => ({ ...p, y: k })))).toBe(100)
  })
})
