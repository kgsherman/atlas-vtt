import { describe, expect, it } from "vitest"

import { flickerFactor, flickerSeed, valueNoise } from "./flicker"
import { directionToSun, lightFalloff, softLambert } from "./lightModel"

describe("lightFalloff", () => {
  it("is 1 at the source, 0.5 at the bright radius and 0 at the dim radius", () => {
    expect(lightFalloff(0, 20, 40)).toBe(1)
    expect(lightFalloff(20, 20, 40)).toBeCloseTo(0.5, 12)
    expect(lightFalloff(40, 20, 40)).toBe(0)
    expect(lightFalloff(55, 20, 40)).toBe(0)
  })

  it("is continuous and non-increasing", () => {
    for (const [b, dim] of [
      [20, 40],
      [0, 10],
      [5, 5],
      [30, 60],
    ]) {
      let prev = lightFalloff(0, b, dim)
      for (let d = 0.01; d <= dim + 1; d += 0.01) {
        const v = lightFalloff(d, b, dim)
        expect(v).toBeLessThanOrEqual(prev + 1e-12)
        // Continuity except at the dim edge of a bright==dim light (a hard cutoff by definition).
        if (!(b === dim && Math.abs(d - dim) < 0.02)) expect(prev - v).toBeLessThan(0.02)
        prev = v
      }
    }
  })
})

describe("softLambert", () => {
  it("gates back faces and is continuous", () => {
    expect(softLambert(-0.5)).toBe(0)
    expect(softLambert(0)).toBe(0)
    expect(softLambert(1)).toBeCloseTo(1, 12)
    let prev = 0
    for (let x = 0; x <= 1; x += 0.001) {
      const v = softLambert(x)
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12)
      expect(v - prev).toBeLessThan(0.02)
      prev = v
    }
  })
})

describe("directionToSun", () => {
  it("follows the azimuth convention (0 = +Z, π/2 = +X) and clamps elevation", () => {
    const [x, y, z] = directionToSun({ azimuth: Math.PI / 2, elevation: 0 })
    expect(x).toBeCloseTo(Math.cos(0.1), 12)
    expect(y).toBeCloseTo(Math.sin(0.1), 12)
    expect(z).toBeCloseTo(0, 12)
    const up = directionToSun({ azimuth: 1, elevation: Math.PI / 2 })
    expect(up[1]).toBeCloseTo(1, 12)
    const n = directionToSun({ azimuth: 0.3, elevation: 0.7 })
    expect(Math.hypot(...n)).toBeCloseTo(1, 12)
  })
})

describe("flicker", () => {
  const torch = { enabled: true, speed: 6, amount: 0.2 }

  it("is deterministic per id and time, bounded to [1 − amount, 1]", () => {
    const seed = flickerSeed("light-1")
    expect(flickerFactor(seed, 1.234, torch)).toBe(flickerFactor(flickerSeed("light-1"), 1.234, torch))
    for (let t = 0; t < 10; t += 0.013) {
      const f = flickerFactor(seed, t, torch)
      expect(f).toBeGreaterThanOrEqual(0.8 - 1e-12)
      expect(f).toBeLessThanOrEqual(1)
    }
  })

  it("is smooth in time and differs between lights", () => {
    const a = flickerSeed("a")
    const b = flickerSeed("b")
    let prev = flickerFactor(a, 0, torch)
    let diff = 0
    for (let t = 0.001; t < 5; t += 0.001) {
      const f = flickerFactor(a, t, torch)
      // |df/dt| ≤ amount · (0.65·1.5·speed + 0.35·1.5·2.3·speed) ≈ 3.2 per second here.
      expect(Math.abs(f - prev)).toBeLessThan(0.005)
      prev = f
      diff += Math.abs(f - flickerFactor(b, t, torch))
    }
    expect(diff).toBeGreaterThan(1)
  })

  it("is off when disabled or zero amount", () => {
    expect(flickerFactor(1, 3, { enabled: false, speed: 6, amount: 0.5 })).toBe(1)
    expect(flickerFactor(1, 3, { enabled: true, speed: 6, amount: 0 })).toBe(1)
  })

  it("value noise stays in [0, 1)", () => {
    for (let x = -20; x < 20; x += 0.07) {
      const v = valueNoise(x, 42)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})
