/**
 * Budgets for the per-player host pipeline on the stress scene (docs/PERFORMANCE.md): knowledge +
 * filter + diff must stay far below the ~100 ms flush interval. Bounds are generous (CI machines
 * vary); typical numbers are ~3 ms knowledge, ~10 ms cold filter, ~1 ms warm filter.
 */
import { describe, expect, it } from "vitest"

import { sampleById } from "../scene/samples"
import { diffViews } from "./diff"
import { filterForPlayer } from "./filter"
import { updateKnowledge } from "./memory"
import { TestHost } from "./test-utils"

describe("session pipeline performance (stress scene, one player seeing through every token)", () => {
  const scene = sampleById("stress-test")!.build()
  const host = new TestHost(scene, ["p1"])
  for (const t of Object.values(scene.tokens)) if (!t.hidden) host.assign(t.id)
  const vis = host.vis("p1")

  it("stays within budget", () => {
    let t0 = performance.now()
    const state = updateKnowledge(host.state, "p1", vis)
    const knowledgeMs = performance.now() - t0
    t0 = performance.now()
    const cold = filterForPlayer(state, "p1", vis)
    const coldMs = performance.now() - t0
    t0 = performance.now()
    const again = updateKnowledge(state, "p1", vis)
    const warm = filterForPlayer(again, "p1", vis)
    const warmMs = performance.now() - t0
    t0 = performance.now()
    const ops = diffViews(cold, warm)
    const diffMs = performance.now() - t0
    expect(again).toBe(state)
    expect(ops).toEqual([])
    expect(knowledgeMs).toBeLessThan(100)
    expect(coldMs).toBeLessThan(250)
    expect(warmMs).toBeLessThan(50)
    expect(diffMs).toBeLessThan(50)
    // A snapshot of this worst case still fits the realtime size guard (200 KB).
    expect(JSON.stringify(cold).length).toBeLessThan(200_000)
  })
})
