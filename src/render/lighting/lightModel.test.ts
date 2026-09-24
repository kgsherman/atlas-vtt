import { describe, expect, it } from "vitest"

import { flickerFactor, flickerSeed, valueNoise } from "./flicker"
import { DARKVISION_MAX_GAIN, darkvisionRaise, directionToSun, LAMBERT_MIN_SLOPE, lambertDirection, lambertGate, lightFalloff, luma, softLambert } from "./lightModel"

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

describe("lambertDirection", () => {
  const dir = (x: number, y: number, z: number): [number, number, number] => {
    const l = Math.hypot(x, y, z)
    return [x / l, y / l, z / l]
  }
  const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

  it("keeps directions above the minimum elevation and lifts lower ones to it, same azimuth", () => {
    const high = dir(3, 4, 0)
    expect(lambertDirection(high)).toEqual(high.map((v) => expect.closeTo(v, 12)))
    const low = lambertDirection(dir(20, -1, 5))
    expect(Math.hypot(...low)).toBeCloseTo(1, 12)
    expect(low[1] / Math.hypot(low[0], low[2])).toBeCloseTo(LAMBERT_MIN_SLOPE, 12)
    expect(low[2] / low[0]).toBeCloseTo(5 / 20, 12)
    expect(lambertDirection([0, 1, 0])).toEqual([0, 1, 0])
  })

  it("keeps a torch 1 ft above bumpy ground from swinging between dark and lit", () => {
    // Floor 20 ft away; ground tilted ±3° toward / away from the torch.
    const l = dir(20, 1, 0)
    const lit = (tilt: number) => {
      const n = [Math.sin(tilt), Math.cos(tilt), 0]
      return lambertGate(dot(n, l)) * softLambert(dot(n, lambertDirection(l)))
    }
    const raw = (tilt: number) => softLambert(dot([Math.sin(tilt), Math.cos(tilt), 0], l))
    // Tilts toward the torch or away by less than its ~2.9° elevation (true N·L ≥ 0.03 up to ~1.2°).
    const deg = Math.PI / 180
    expect(raw(-1 * deg)).toBeLessThan(0.15)
    expect(raw(3 * deg)).toBeGreaterThan(0.3)
    expect(lit(-1 * deg)).toBeGreaterThan(0.6)
    expect(lit(3 * deg) - lit(-1 * deg)).toBeLessThan(0.05)
    // Turned away from the true direction: self-shadowed, however high the lifted one.
    expect(lit(-4 * deg)).toBe(0)
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

describe("darkvisionRaise", () => {
  const l = (c: number[]) => luma(c[0], c[1], c[2])

  it("scales dark paint toward the grey's luma keeping its hue instead of adding flat grey", () => {
    // A night-painted battlemap: dark, saturated blue-green.
    const c: [number, number, number] = [0.01, 0.025, 0.04]
    const target = 0.05
    const out = darkvisionRaise(c, target, 1)
    expect(l(out)).toBeCloseTo(target, 9)
    // Within the gain: exactly proportional (no grey added), so the chroma ratios are unchanged.
    const k = out[0] / c[0]
    expect(k).toBeLessThanOrEqual(DARKVISION_MAX_GAIN + 1e-9)
    expect(out[1] / c[1]).toBeCloseTo(k, 9)
    expect(out[2] / c[2]).toBeCloseTo(k, 9)
  })

  it("never reads darker than the grey at full weight; adds grey only beyond the gain cap", () => {
    for (const c of [
      [0, 0, 0],
      [0.001, 0.002, 0.0005],
      [0.2, 0.01, 0.01],
      [0.04, 0.04, 0.04],
    ] as [number, number, number][]) {
      for (const target of [0.04, 0.1, 0.16]) {
        const out = darkvisionRaise(c, target, 1)
        expect(l(out)).toBeGreaterThanOrEqual(Math.max(target, l(c)) - 1e-9)
      }
    }
    // Very dark paint: the gain alone cannot reach the target, the remainder is grey.
    const out = darkvisionRaise([0.004, 0.004, 0.012], 0.1, 1)
    expect(out[0]).toBeGreaterThan(0.004 * DARKVISION_MAX_GAIN)
  })

  it("fades with the weight and leaves bright colours alone", () => {
    const c: [number, number, number] = [0.01, 0.02, 0.03]
    expect(darkvisionRaise(c, 0.1, 0)).toEqual(c)
    const half = darkvisionRaise(c, 0.1, 0.5)
    const full = darkvisionRaise(c, 0.1, 1)
    for (let k = 0; k < 3; k++) expect(half[k]).toBeCloseTo((c[k] + full[k]) / 2, 12)
    const bright: [number, number, number] = [0.3, 0.3, 0.3]
    expect(darkvisionRaise(bright, 0.1, 1)).toEqual(bright)
  })
})
