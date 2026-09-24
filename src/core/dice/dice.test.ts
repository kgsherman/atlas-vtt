import { describe, expect, it } from "vitest"

import {
  cleanText,
  cryptoDiceRng,
  DICE_LIMITS,
  describeRoll,
  isFormula,
  naturalD20,
  parseRoll,
  roll,
  rollFormula,
  type DiceFormula,
  type DiceRng,
} from "./index"

/** Replays fixed values (mod sides, 1-based), then repeats the last. */
function fixed(...values: number[]): DiceRng {
  let k = 0
  return (sides) => {
    const v = values[Math.min(k++, values.length - 1)]
    return ((v - 1) % sides) + 1
  }
}

/** Deterministic PRNG (mulberry32) for property tests. */
function seeded(seed: number): DiceRng {
  let a = seed >>> 0
  return (sides) => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    const u = ((t ^ (t >>> 14)) >>> 0) / 4294967296
    return 1 + Math.floor(u * sides)
  }
}

function formula(input: string): DiceFormula {
  const p = parseRoll(input)
  if (!p.ok) throw new Error(p.error)
  return p.formula
}

describe("parseRoll", () => {
  it("reads dice, constants and signs into a canonical formula", () => {
    expect(formula("1d20+5").text).toBe("1d20 + 5")
    expect(formula(" d20 +5").text).toBe("1d20 + 5")
    expect(formula("2d6 - 1 + d4").text).toBe("2d6 - 1 + 1d4")
    expect(formula("-2 + 3d8").text).toBe("-2 + 3d8")
    expect(formula("+7").text).toBe("7")
    expect(formula("D%").text).toBe("1d100")
    expect(formula("4d6DL1").text).toBe("4d6dl1")
    expect(formula("2d20k").text).toBe("2d20kh1")
    expect(formula("3d6!").text).toBe("3d6!")
    expect(formula("6d10!kh3").text).toBe("6d10!kh3")
  })

  it("expands adv / dis", () => {
    expect(formula("adv+3").text).toBe("2d20kh1 + 3")
    expect(formula("DIS - 1").text).toBe("2d20kl1 - 1")
  })

  it("splits off the label", () => {
    expect(parseRoll("1d20+5 to hit")).toMatchObject({ ok: true, label: "to hit" })
    expect(parseRoll("2d6 # fire  damage")).toMatchObject({ ok: true, label: "fire damage" })
    expect(parseRoll("d20: Stealth")).toMatchObject({ ok: true, label: "Stealth" })
    expect(parseRoll("adv Perception")).toMatchObject({ ok: true, label: "Perception" })
    expect(parseRoll("1d20")).toMatchObject({ ok: true, label: "" })
  })

  it("cleans and bounds the label", () => {
    const r = parseRoll(`d6 a\u0000b\nc ${"x".repeat(200)}`)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.label.startsWith("a b c x")).toBe(true)
    expect([...r.label].length).toBe(DICE_LIMITS.maxLabelLength)
  })

  it("refuses what it cannot read, with a reason", () => {
    for (const bad of ["", "   ", "hello", "d0", "0d6", "d1001", "2d6fire", "1d20+", "1d20 + stealth", "3d6kh4", "d1!", "advantage", "4d6d1", "1d20 ++ 2"]) {
      const r = parseRoll(bad)
      expect(r.ok, bad).toBe(false)
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
    }
  })

  it("enforces the limits", () => {
    expect(parseRoll(`${DICE_LIMITS.maxDice}d6`).ok).toBe(true)
    expect(parseRoll(`${DICE_LIMITS.maxDice + 1}d6`).ok).toBe(false)
    expect(parseRoll(`60d6 + 41d6`).ok).toBe(false)
    expect(parseRoll("99999999999999999999d6").ok).toBe(false)
    expect(parseRoll(`d${DICE_LIMITS.maxSides}`).ok).toBe(true)
    expect(parseRoll(`${DICE_LIMITS.maxConstant + 1}`).ok).toBe(false)
    const terms = Array.from({ length: DICE_LIMITS.maxTerms + 1 }, () => "1").join("+")
    expect(parseRoll(terms).ok).toBe(false)
    expect(parseRoll(`d20+${"0".repeat(DICE_LIMITS.maxFormulaLength)}1`).ok).toBe(false)
  })

  it("isFormula tells a bare formula from chat", () => {
    expect(isFormula("2d6+3")).toBe(true)
    expect(isFormula("2d6+3 fire")).toBe(false)
    expect(isFormula("hello there")).toBe(false)
  })
})

describe("rollFormula", () => {
  it("adds dice and constants with their signs", () => {
    const r = rollFormula(formula("2d6 + 3 - 1d4"), fixed(4, 5, 2))
    expect(r.total).toBe(4 + 5 + 3 - 2)
    expect(r.formula).toBe("2d6 + 3 - 1d4")
    expect(r.terms[0]).toMatchObject({ kind: "dice", rolls: [4, 5], dropped: [] })
  })

  it("keeps and drops", () => {
    expect(rollFormula(formula("adv"), fixed(7, 15)).total).toBe(15)
    expect(rollFormula(formula("dis"), fixed(7, 15)).total).toBe(7)
    const stats = rollFormula(formula("4d6dl1"), fixed(3, 1, 6, 1))
    // Equal values: the first one is dropped.
    expect(stats.terms[0]).toMatchObject({ rolls: [3, 1, 6, 1], dropped: [1] })
    expect(stats.total).toBe(10)
    expect(rollFormula(formula("4d6dh2"), fixed(3, 1, 6, 5)).total).toBe(4)
    expect(rollFormula(formula("4d6kl2"), fixed(3, 1, 6, 5)).total).toBe(4)
    expect(rollFormula(formula("3d6kh3"), fixed(3, 1, 6)).total).toBe(10)
  })

  it("explodes, with a cap", () => {
    const r = rollFormula(formula("2d6!"), fixed(6, 6, 2, 3))
    expect(r.terms[0]).toMatchObject({ rolls: [6, 6, 2, 3] })
    expect(r.total).toBe(17)
    const capped = rollFormula(formula("d2!"), () => 2)
    expect(capped.terms[0].kind === "dice" && capped.terms[0].rolls.length).toBe(DICE_LIMITS.maxExplosions + 1)
  })

  it("stays within the formula's range (property)", () => {
    const rng = seeded(42)
    const cases: [string, number, number][] = [
      ["1d20+5", 6, 25],
      ["4d6dl1", 3, 18],
      ["adv-2", -1, 18],
      ["2d8 - 1d4 + 3", 1 - 4 + 3, 16 - 1 + 3],
      ["d%", 1, 100],
    ]
    for (const [input, lo, hi] of cases) {
      const f = formula(input)
      for (let k = 0; k < 500; k++) {
        const t = rollFormula(f, rng).total
        expect(t).toBeGreaterThanOrEqual(lo)
        expect(t).toBeLessThanOrEqual(hi)
      }
    }
  })

  it("roll() parses and rolls, or explains", () => {
    expect(roll("1d4+1 heal", fixed(3))).toMatchObject({ ok: true, label: "heal", result: { total: 4 } })
    expect(roll("nope", fixed(1)).ok).toBe(false)
  })
})

describe("cryptoDiceRng", () => {
  it("returns every face, uniformly enough", () => {
    const rng = cryptoDiceRng()
    const counts = new Array(7).fill(0)
    const n = 60_000
    for (let k = 0; k < n; k++) {
      const v = rng(6)
      expect(Number.isInteger(v) && v >= 1 && v <= 6).toBe(true)
      counts[v]++
    }
    // Chi-square with 5 degrees of freedom: 20.5 is p ≈ 0.001.
    const e = n / 6
    const chi = counts.slice(1).reduce((s, c) => s + ((c - e) * (c - e)) / e, 0)
    expect(chi).toBeLessThan(20.5)
  })

  it("handles one-sided and large dice", () => {
    const rng = cryptoDiceRng()
    expect(rng(1)).toBe(1)
    for (let k = 0; k < 100; k++) {
      const v = rng(1000)
      expect(v >= 1 && v <= 1000).toBe(true)
    }
  })
})

describe("reading results", () => {
  it("naturalD20 finds the kept d20 of single-d20 rolls only", () => {
    expect(naturalD20(rollFormula(formula("1d20+5"), fixed(20)))).toBe(20)
    expect(naturalD20(rollFormula(formula("adv"), fixed(1, 12)))).toBe(12)
    expect(naturalD20(rollFormula(formula("dis+2"), fixed(1, 12)))).toBe(1)
    expect(naturalD20(rollFormula(formula("2d20"), fixed(1, 12)))).toBeNull()
    expect(naturalD20(rollFormula(formula("1d20+1d4"), fixed(1, 2)))).toBeNull()
    expect(naturalD20(rollFormula(formula("2d6"), fixed(1, 2)))).toBeNull()
  })

  it("describeRoll shows each die, dropped ones in parentheses", () => {
    expect(describeRoll(rollFormula(formula("adv+5"), fixed(17, 4)))).toBe("2d20kh1 + 5: [17, (4)] + 5 = 22")
    expect(describeRoll(rollFormula(formula("-1d4"), fixed(3)))).toBe("-1d4: -[3] = -3")
  })

  it("cleanText strips control characters and collapses spaces", () => {
    expect(cleanText("  a\tb\u0007c\u2028 d  ", 10)).toBe("a b c d")
    expect(cleanText("🎲🎲🎲", 2)).toBe("🎲🎲")
  })
})
