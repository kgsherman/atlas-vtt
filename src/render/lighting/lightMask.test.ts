import { describe, expect, it } from "vitest"

import { buildLightMask, LIGHT_MASK_CELL, LIGHT_MASK_MAX_SIDE, lightMaskAt, packedLightSlots, updateLightMaskKey, type LightMaskSlot } from "./lightMask"

/** Deterministic pseudo-random numbers in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 4294967296
  }
}

describe("buildLightMask", () => {
  it("sets a slot's bit on every cell its dim disc reaches, and on no other", () => {
    const slots: LightMaskSlot[] = [
      { x: 20, z: 20, dim: 15 },
      { x: 100, z: 40, dim: 30 },
      { x: 60, z: 90, dim: 5 },
    ]
    const mask = buildLightMask(slots)!
    expect(mask.cell).toBe(LIGHT_MASK_CELL)
    expect(lightMaskAt(mask, 20, 20)).toBe(0b001)
    expect(lightMaskAt(mask, 100, 40)).toBe(0b010)
    expect(lightMaskAt(mask, 60, 90)).toBe(0b100)
    // Far from every disc, inside the grid: no bits; outside the grid: none either.
    expect(lightMaskAt(mask, 60, 20)).toBe(0)
    expect(lightMaskAt(mask, -500, 20)).toBe(0)
    // Conservative: any point within a disc (XZ) reads its bit.
    const r = rng(7)
    for (let k = 0; k < 5000; k++) {
      const s = Math.floor(r() * slots.length)
      const l = slots[s]
      const a = r() * Math.PI * 2
      const d = Math.sqrt(r()) * l.dim
      expect(lightMaskAt(mask, l.x + Math.cos(a) * d, l.z + Math.sin(a) * d) & (1 << s)).not.toBe(0)
    }
  })

  it("uses bit 31 for the last of 32 slots (unsigned)", () => {
    const slots = Array.from({ length: 32 }, (_, k) => ({ x: k * 30 + 5, z: 5, dim: 1 }))
    const mask = buildLightMask(slots)!
    expect(lightMaskAt(mask, 31 * 30 + 5, 5)).toBe(2 ** 31)
    expect(lightMaskAt(mask, 5, 5)).toBe(1)
    expect(mask.bits.every((b) => b >= 0)).toBe(true)
  })

  it("grows the cell to keep the grid within its side limit", () => {
    const mask = buildLightMask([
      { x: 0, z: 0, dim: 10 },
      { x: 10000, z: 50, dim: 10 },
    ])!
    expect(mask.width).toBeLessThanOrEqual(LIGHT_MASK_MAX_SIDE)
    expect(mask.depth).toBeLessThanOrEqual(LIGHT_MASK_MAX_SIDE)
    expect(mask.cell).toBeGreaterThan(LIGHT_MASK_CELL)
    expect(lightMaskAt(mask, 10000, 50)).toBe(0b10)
  })

  it("is null without a usable disc", () => {
    expect(buildLightMask([])).toBeNull()
    expect(buildLightMask([{ x: 0, z: 0, dim: 0 }])).toBeNull()
    expect(buildLightMask([{ x: Number.NaN, z: 0, dim: 5 }])).toBeNull()
  })

  it("reads slots from the packed uniforms and rebuilds only when count, a position or a radius changes", () => {
    const packed = new Float32Array(3 * 16)
    packed.set([1, 5, 2, 3], 0)
    packed.set([10, 5, 20, 30], 16)
    const slots = packedLightSlots(packed, 2, 4)
    expect(slots).toEqual([
      { x: 1, z: 2, dim: 3 },
      { x: 10, z: 20, dim: 30 },
    ])
    const key = new Float32Array(1 + 32 * 3)
    expect(updateLightMaskKey(key, slots)).toBe(false)
    expect(updateLightMaskKey(key, slots)).toBe(true)
    expect(updateLightMaskKey(key, [slots[1], slots[0]])).toBe(false) // re-ranked
    expect(updateLightMaskKey(key, [slots[1], { ...slots[0], dim: 4 }])).toBe(false)
    expect(updateLightMaskKey(key, [slots[1]])).toBe(false)
    expect(updateLightMaskKey(key, [])).toBe(false)
    expect(updateLightMaskKey(key, [])).toBe(true)
  })
})
