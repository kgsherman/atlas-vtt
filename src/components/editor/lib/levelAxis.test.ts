import { describe, expect, it } from "vitest"

import { axisTicks, levelAxisBounds, minorTicks, spreadLabels } from "./levelAxis"

describe("level axis bounds", () => {
  it("shows at least −10 → 50 ft", () => {
    expect(levelAxisBounds([])).toEqual({ lo: -10, hi: 50 })
    expect(levelAxisBounds([0, 10, 20])).toEqual({ lo: -10, hi: 50 })
  })

  it("extends 10 ft past the lowest and highest levels", () => {
    expect(levelAxisBounds([-30, 0, 55])).toEqual({ lo: -40, hi: 65 })
  })
})

describe("axis ticks", () => {
  it("picks round steps inside the range", () => {
    expect(axisTicks(-10, 50)).toEqual([-10, 0, 10, 20, 30, 40, 50])
    expect(axisTicks(-40, 65)).toEqual([-40, -20, 0, 20, 40, 60])
    expect(axisTicks(0, 1000)).toEqual([0, 200, 400, 600, 800, 1000])
  })
})

describe("minor ticks", () => {
  it("marks every 5 ft between the major ticks", () => {
    expect(minorTicks(-10, 50, [0, 20, 40], 3)).toEqual([-10, -5, 5, 10, 15, 25, 30, 35, 45, 50])
    expect(minorTicks(-22, 12, [-20, 0], 3)).toEqual([-15, -10, -5, 5, 10])
  })

  it("drops them when they would be packed tighter than a few pixels", () => {
    expect(minorTicks(0, 1000, [0, 200, 400], 0.5)).toEqual([])
  })
})

describe("spreadLabels", () => {
  const gaps = (z: number[]) => z.slice(1).map((v, i) => v - z[i])

  it("leaves labels that already fit where they are", () => {
    expect(spreadLabels([0, 50, 100], 10, 0, 200)).toEqual([0, 50, 100])
  })

  it("pushes crowded labels apart symmetrically around their mean", () => {
    const z = spreadLabels([50, 50, 50], 10, 0, 200)
    expect(z).toEqual([40, 50, 60])
  })

  it("keeps every gap and moves only the crowded group", () => {
    const z = spreadLabels([10, 100, 102, 104, 180], 10, 0, 200)
    expect(z[0]).toBe(10)
    expect(z[4]).toBe(180)
    for (const g of gaps(z)) expect(g).toBeGreaterThanOrEqual(10 - 1e-9)
    expect((z[1] + z[2] + z[3]) / 3).toBeCloseTo(102)
  })

  it("minimises squared displacement (matches a brute-force search)", () => {
    const t = [5, 7, 30, 31, 33]
    const z = spreadLabels(t, 6, 0, 100)
    const cost = (p: number[]) => p.reduce((s, v, i) => s + (v - t[i]) ** 2, 0)
    // Perturbing any single label (keeping it feasible) never lowers the cost.
    for (let i = 0; i < z.length; i++)
      for (const d of [-0.5, 0.5]) {
        const p = z.slice()
        p[i] += d
        const feasible = gaps(p).every((g) => g >= 6 - 1e-9) && p[0] >= 0 && p[p.length - 1] <= 100
        if (feasible) expect(cost(p)).toBeGreaterThanOrEqual(cost(z) - 1e-9)
      }
  })

  it("stays inside the bounds", () => {
    expect(spreadLabels([0, 0, 0], 10, 0, 100)).toEqual([0, 10, 20])
    expect(spreadLabels([100, 100], 10, 0, 100)).toEqual([90, 100])
  })

  it("spreads evenly when the labels cannot fit", () => {
    expect(spreadLabels([5, 5, 5], 10, 0, 10)).toEqual([0, 5, 10])
    expect(spreadLabels([3], 10, 0, 5)).toEqual([3])
  })
})
