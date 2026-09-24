import { describe, expect, it } from "vitest"

import { MAX_DURATION, MAX_GLIDE, MIN_DURATION, MOTION_SPEED, motionAt, planMotion, travel } from "./tokenMotion"

const p = (x: number, z = 0, levelId = "L") => ({ levelId, position: { x, z } })

describe("token motion", () => {
  it("eases in and out and covers the whole way", () => {
    expect(travel(0, 0.2)).toBe(0)
    expect(travel(1, 0.2)).toBeCloseTo(1)
    expect(travel(0.5, 0.2)).toBeCloseTo(0.5)
    // Slow at the ends, steady in the middle; monotonic.
    expect(travel(0.05, 0.2)).toBeLessThan(0.05)
    let last = 0
    for (let u = 0; u <= 1.0001; u += 0.01) {
      const s = travel(u, 0.2)
      expect(s).toBeGreaterThanOrEqual(last - 1e-9)
      last = s
    }
  })

  it("walks along the route at a steady speed, and ends exactly on the target", () => {
    const route = [p(0), p(10), p(10, 10)]
    const m = planMotion(p(1), p(10, 10), route, 1000)!
    expect(m.points[0]).toEqual(p(1))
    expect(m.length).toBeCloseTo(19)
    expect(m.duration).toBeCloseTo((19 / MOTION_SPEED) * 1000)
    const mid = motionAt(m, 1000 + m.duration / 2)
    expect(mid.done).toBe(false)
    expect(mid.x).toBeCloseTo(10)
    expect(mid.z).toBeCloseTo(0.5)
    expect(motionAt(m, 1000 + m.duration)).toEqual({ levelId: "L", x: 10, z: 10, done: true })
  })

  it("glides straight without a route over short distances on one level, else jumps", () => {
    expect(planMotion(p(0), p(MAX_GLIDE - 1), null, 0)?.points).toEqual([p(0), p(MAX_GLIDE - 1)])
    expect(planMotion(p(0), p(MAX_GLIDE + 1), null, 0)).toBeNull()
    expect(planMotion(p(0), p(5, 0, "U"), null, 0)).toBeNull()
    // A route that does not end at the target is not used.
    expect(planMotion(p(0), p(100), [p(0), p(50)], 0)).toBeNull()
    expect(planMotion(p(3), p(3), null, 0)).toBeNull()
  })

  it("bounds the duration and switches level halfway along a level change", () => {
    expect(planMotion(p(0), p(0.5), null, 0)!.duration).toBe(MIN_DURATION * 1000)
    const long = [p(0), p(300)]
    expect(planMotion(p(0), p(300), long, 0)!.duration).toBe(MAX_DURATION * 1000)
    const stairs = planMotion(p(0), p(10, 0, "U"), [p(0), p(5), p(10, 0, "U")], 0)!
    const at = (x: number) => {
      for (let t = 0; t <= stairs.duration; t += 1) {
        const q = motionAt(stairs, t)
        if (q.x >= x) return q.levelId
      }
      return null
    }
    expect(at(7)).toBe("L")
    expect(at(8)).toBe("U")
    // A ladder switches at once.
    const ladder = planMotion(p(0), p(10, 0, "U"), [p(0), p(5), p(5, 0, "U"), p(10, 0, "U")], 0)!
    const past = (x: number) => {
      for (let t = 0; t <= ladder.duration; t += 1) {
        const q = motionAt(ladder, t)
        if (q.x > x) return q.levelId
      }
      return null
    }
    expect(past(4.9)).toBe("L")
    expect(past(5.05)).toBe("U")
  })
})
