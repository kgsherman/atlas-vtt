import { describe, expect, it } from "vitest"

import { applyDamage, applyHealing, clampHp, healthBand, hpFraction, normalizeConditions, TOKEN_CONDITIONS } from "./tokenStatus"

describe("token status", () => {
  it("normalizes conditions: known ones, once, in catalog order", () => {
    expect(normalizeConditions(["prone", "poisoned", "prone", "sleepy", 3, "blinded"])).toEqual(["blinded", "poisoned", "prone"])
    expect(normalizeConditions([])).toEqual([])
    expect(normalizeConditions([...TOKEN_CONDITIONS].reverse())).toEqual([...TOKEN_CONDITIONS])
  })

  it("clamps hit points to their rules", () => {
    expect(clampHp({ current: 15, max: 12 })).toEqual({ current: 12, max: 12, temp: 0 })
    expect(clampHp({ current: -3, max: 0.4, temp: -2 })).toEqual({ current: 0, max: 1, temp: 0 })
    expect(clampHp({ current: 7.6, max: 12.2, temp: 2.5 })).toEqual({ current: 8, max: 12, temp: 3 })
    expect(clampHp({ current: Number.NaN, max: Number.POSITIVE_INFINITY })).toEqual({ current: 0, max: 1, temp: 0 })
  })

  it("damage spends temporary hit points first and stops at 0; healing stops at max", () => {
    const hp = { current: 10, max: 20, temp: 4 }
    expect(applyDamage(hp, 3)).toEqual({ current: 10, max: 20, temp: 1 })
    expect(applyDamage(hp, 9)).toEqual({ current: 5, max: 20, temp: 0 })
    expect(applyDamage(hp, 999)).toEqual({ current: 0, max: 20, temp: 0 })
    expect(applyDamage(hp, -5)).toEqual(hp)
    expect(applyHealing(hp, 7)).toEqual({ current: 17, max: 20, temp: 4 })
    expect(applyHealing(hp, 70)).toEqual({ current: 20, max: 20, temp: 4 })
  })

  it("bands: down, bloodied at half or less, wounded, unhurt", () => {
    expect(healthBand({ current: 0, max: 10, temp: 5 })).toBe("down")
    expect(healthBand({ current: 5, max: 10, temp: 0 })).toBe("bloodied")
    expect(healthBand({ current: 3, max: 7, temp: 0 })).toBe("bloodied")
    expect(healthBand({ current: 4, max: 7, temp: 0 })).toBe("wounded")
    expect(healthBand({ current: 10, max: 10, temp: 0 })).toBe("unhurt")
    expect(hpFraction({ hp: { current: 5, max: 20, temp: 0 } })).toBe(0.25)
    expect(hpFraction({})).toBeNull()
  })
})
