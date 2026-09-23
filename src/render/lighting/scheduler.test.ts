import { describe, expect, it } from "vitest"

import { orderTileUpdates, runTileUpdates, SHADOW_UPDATES_PER_FRAME, type TileUpdateRequest } from "./scheduler"

const req = (key: string, o: Partial<TileUpdateRequest>): TileUpdateRequest => ({
  key,
  kind: "light",
  forced: false,
  moved: false,
  uncaptured: false,
  dirty: false,
  coverage: 0,
  ...o,
})

describe("tile update scheduler", () => {
  it("orders forced → moved/new → dirty viewers → on-screen lights by coverage → rest", () => {
    const ordered = orderTileUpdates([
      req("light:offscreen", { dirty: true }),
      req("light:small", { dirty: true, coverage: 0.1 }),
      req("light:big", { dirty: true, coverage: 0.6 }),
      req("viewer:b", { kind: "viewer", dirty: true }),
      req("light:new", { uncaptured: true, coverage: 0.2 }),
      req("light:moved", { moved: true, coverage: 0.5 }),
      req("viewer:me", { kind: "viewer", forced: true, moved: true }),
      req("light:clean", { coverage: 0.9 }),
    ])
    expect(ordered.map((r) => r.key)).toEqual([
      "viewer:me",
      "light:moved",
      "light:new",
      "viewer:b",
      "light:big",
      "light:small",
      "light:offscreen",
    ])
  })

  it("caps updates per frame but always runs forced requests", () => {
    const reqs = orderTileUpdates([
      ...Array.from({ length: 8 }, (_, k) => req(`light:${k}`, { dirty: true, coverage: 0.1 + k / 100 })),
      req("viewer:me", { kind: "viewer", forced: true, dirty: true }),
      req("viewer:clean", { kind: "viewer", forced: true }),
    ])
    const ran: string[] = []
    const res = runTileUpdates(reqs, { maxTiles: SHADOW_UPDATES_PER_FRAME, maxMs: 1000 }, (r) => ran.push(r.key), () => 0)
    expect(ran[0]).toBe("viewer:me")
    expect(res.updated).toHaveLength(SHADOW_UPDATES_PER_FRAME)
    expect(res.deferred).toHaveLength(9 - SHADOW_UPDATES_PER_FRAME)
    // Highest coverage lights first.
    expect(ran.slice(1)).toEqual(["light:7", "light:6", "light:5"])
  })

  it("stops at the CPU time cap", () => {
    let t = 0
    const reqs = orderTileUpdates(Array.from({ length: 4 }, (_, k) => req(`light:${k}`, { dirty: true })))
    const res = runTileUpdates(reqs, { maxTiles: 4, maxMs: 2 }, () => (t += 1.5), () => t)
    // 0 → 1.5 (ok) → 3 (over the 2 ms cap): only two run.
    expect(res.updated).toHaveLength(2)
    expect(res.deferred).toHaveLength(2)
    expect(res.elapsedMs).toBe(3)
  })

  it("forced requests run even after the budget is spent", () => {
    let t = 0
    const reqs = [req("light:a", { dirty: true }), req("viewer:me", { kind: "viewer", forced: true, moved: true })]
    const res = runTileUpdates(reqs, { maxTiles: 0, maxMs: 0 }, () => (t += 5), () => t)
    expect(res.updated).toEqual(["viewer:me"])
  })
})
