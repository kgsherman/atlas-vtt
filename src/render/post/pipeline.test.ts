import { describe, expect, it } from "vitest"

import { MSAA_SAMPLES } from "../engine/quality"
import { DIRECT_EMISSIVE, POST_SETTINGS } from "./pipeline"

describe("post settings per tier", () => {
  it("renders only low straight to the canvas", () => {
    expect(POST_SETTINGS.low).toBeNull()
    for (const q of ["medium", "high", "ultra"] as const) expect(POST_SETTINGS[q]).not.toBeNull()
  })

  it("gives medium a lite preset: MSAA and tone mapping, no bloom / AO / vignette / grain, direct emissive look", () => {
    const m = POST_SETTINGS.medium!
    expect(m.bloom).toBeNull()
    expect(m.ao).toBeNull()
    expect(m.vignette).toBe(0)
    expect(m.grain).toBe(0)
    expect(m.tone).toBe("reinhard")
    expect(m.exposure).toBe(1)
    expect(m.samples).toBeGreaterThan(0)
    expect({ emissive: m.emissive, glow: m.glow }).toEqual(DIRECT_EMISSIVE)
  })

  it("takes MSAA samples from the tier table", () => {
    for (const q of ["medium", "high", "ultra"] as const) expect(POST_SETTINGS[q]!.samples).toBe(MSAA_SAMPLES[q])
  })
})
