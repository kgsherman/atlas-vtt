import { describe, expect, it } from "vitest"

import { computeLevelPlan, effectiveActiveLevelId, type LevelPlanView } from "./levelPlan"

const levels = [{ id: "cellar" }, { id: "ground" }, { id: "upper" }, { id: "roof" }]

const view = (v: Partial<LevelPlanView>): LevelPlanView => ({
  mode: "editor",
  activeLevelId: "ground",
  levelVisibility: {},
  ghostAdjacent: false,
  cutaway: true,
  ...v,
})

const modes = (p: ReturnType<typeof computeLevelPlan>) => Object.fromEntries([...p].map(([id, e]) => [id, e.mode]))
const tokens = (p: ReturnType<typeof computeLevelPlan>) => Object.fromEntries([...p].map(([id, e]) => [id, e.tokens]))

describe("level plan", () => {
  it("falls back to the lowest level", () => {
    expect(effectiveActiveLevelId(levels, null)).toBe("cellar")
    expect(effectiveActiveLevelId(levels, "missing")).toBe("cellar")
    expect(effectiveActiveLevelId([], null)).toBeNull()
  })

  it("orders the active level first, then lower levels descending, then upper levels", () => {
    const p = computeLevelPlan(levels, view({ activeLevelId: "upper" }))
    expect(p.get("upper")!.rank).toBe(1)
    expect(p.get("ground")!.rank).toBe(2)
    expect(p.get("cellar")!.rank).toBe(3)
    expect(p.get("roof")!.rank).toBe(4)
  })

  it("ranks every level 1 or more (resting tokens, renderOrder 0, draw before all level geometry)", () => {
    for (const mode of ["editor", "player", "dm-play"] as const) {
      for (const active of [...levels.map((l) => l.id), null]) {
        const p = computeLevelPlan(levels, view({ mode, activeLevelId: active }))
        for (const e of p.values()) expect(e.rank).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it("editor: honours visibility toggles", () => {
    const p = computeLevelPlan(levels, view({ levelVisibility: { upper: false } }))
    expect(modes(p)).toEqual({ cellar: "solid", ground: "solid", upper: "hidden", roof: "solid" })
    expect(tokens(p).upper).toBe("none")
  })

  it("editor: ghosts the adjacent levels and hides the rest", () => {
    const p = computeLevelPlan(levels, view({ ghostAdjacent: true }))
    expect(modes(p)).toEqual({ cellar: "ghost", ground: "solid", upper: "ghost", roof: "hidden" })
    expect(tokens(p)).toEqual({ cellar: "marker", ground: "solid", upper: "marker", roof: "none" })
  })

  it("player: cuts away every level above the active one (tokens become markers)", () => {
    const p = computeLevelPlan(levels, view({ mode: "player", levelVisibility: { cellar: false } }))
    expect(modes(p)).toEqual({ cellar: "solid", ground: "solid", upper: "hidden", roof: "hidden" })
    expect(tokens(p)).toEqual({ cellar: "solid", ground: "solid", upper: "marker", roof: "marker" })
  })

  it("dm-play honours toggles; no cutaway shows everything", () => {
    const p = computeLevelPlan(levels, view({ mode: "dm-play", levelVisibility: { cellar: false } }))
    expect(modes(p).cellar).toBe("hidden")
    const all = computeLevelPlan(levels, view({ mode: "player", cutaway: false }))
    expect(Object.values(modes(all))).toEqual(["solid", "solid", "solid", "solid"])
  })
})
