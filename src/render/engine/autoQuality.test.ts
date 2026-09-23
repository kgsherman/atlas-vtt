import { describe, expect, it, vi } from "vitest"

import { classifyRenderer, PREDICTED_BUDGET_MS, PROBE_CACHE_KEY, predictTierMs, probeQuality, rendererStrings, tierForCost, tierPixels } from "./autoQuality"

class MemoryStorage {
  private readonly m = new Map<string, string>()
  getItem(k: string) {
    return this.m.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.m.set(k, v)
  }
}

describe("renderer heuristics", () => {
  it("caps software, mobile and weak integrated GPUs", () => {
    expect(classifyRenderer("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)")).toMatchObject({ cap: "low", software: true })
    expect(classifyRenderer("llvmpipe (LLVM 15.0.7, 256 bits)").cap).toBe("low")
    expect(classifyRenderer("ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)").cap).toBe("medium")
    expect(classifyRenderer("ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)").cap).toBe("high")
    expect(classifyRenderer("Mali-G78").cap).toBe("medium")
    expect(classifyRenderer("ANGLE (Microsoft Corporation, D3D12 (AMD Radeon(TM) Graphics), OpenGL 4.6)").cap).toBe("high")
  })

  it("lets discrete GPUs and Apple silicon reach ultra", () => {
    expect(classifyRenderer("ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 5070 Ti), OpenGL 4.6)").cap).toBe("ultra")
    expect(classifyRenderer("ANGLE (AMD, AMD Radeon RX 7800 XT Direct3D11 vs_5_0 ps_5_0, D3D11)").cap).toBe("ultra")
    expect(classifyRenderer("Apple M2 Pro").cap).toBe("ultra")
  })

  it("reads RENDERER, and the debug extension only when RENDERER is masked", () => {
    const fakeGl = (renderer: string, vendor: string, unmasked: [string, string] | null) => {
      const params: Record<number, string> = { 0x1f01: renderer, 0x1f00: vendor }
      if (unmasked) [params[0x9246], params[0x9245]] = unmasked
      const getExtension = vi.fn(() => (unmasked ? { UNMASKED_RENDERER_WEBGL: 0x9246, UNMASKED_VENDOR_WEBGL: 0x9245 } : null))
      const gl = { RENDERER: 0x1f01, VENDOR: 0x1f00, getParameter: (p: number) => params[p], getExtension }
      return { gl: gl as unknown as Parameters<typeof rendererStrings>[0], getExtension }
    }
    // Chromium masks RENDERER: the GPU comes from WEBGL_debug_renderer_info.
    const chromium = fakeGl("WebKit WebGL", "WebKit", ["ANGLE (NVIDIA GeForce RTX 5070 Ti)", "Google Inc. (NVIDIA)"])
    expect(rendererStrings(chromium.gl)).toEqual({ renderer: "ANGLE (NVIDIA GeForce RTX 5070 Ti)", vendor: "Google Inc. (NVIDIA)" })
    // Firefox reports the GPU in RENDERER and warns when the deprecated extension is read.
    const ff = fakeGl("llvmpipe, or similar", "Mozilla", ["llvmpipe, or similar", "Mozilla"])
    expect(rendererStrings(ff.gl)).toEqual({ renderer: "llvmpipe, or similar", vendor: "Mozilla" })
    expect(ff.getExtension).not.toHaveBeenCalled()
    expect(classifyRenderer(rendererStrings(ff.gl).renderer).software).toBe(true)
    // Masked with no extension: keep what RENDERER says.
    expect(rendererStrings(fakeGl("WebKit WebGL", "WebKit", null).gl)).toEqual({ renderer: "WebKit WebGL", vendor: "WebKit" })
  })
})

describe("tier from the measured cost", () => {
  const px = tierPixels(1920, 1080, 1)

  it("counts the pixels each tier renders", () => {
    expect(px).toEqual({ low: 1.3e6, medium: 1920 * 1080, native: 1920 * 1080 })
    const hidpi = tierPixels(1920, 1080, 2)
    expect(hidpi.medium).toBe(2.1e6)
    expect(hidpi.native).toBe(1920 * 1080 * 4)
    expect(tierPixels(2560, 1440, 2).native).toBe(8.3e6)
  })

  it("picks the highest tier that fits the budget, never above the cap", () => {
    // A fast GPU fits everything; the cap still wins.
    expect(tierForCost(0.2, "ultra", px)).toBe("ultra")
    expect(tierForCost(0.2, "high", px)).toBe("high")
    // A slow GPU drops tiers; costs are monotonic in the tier.
    const c = predictTierMs(2, px)
    expect(c.low).toBeLessThan(c.medium)
    expect(c.medium).toBeLessThan(c.high)
    expect(c.high).toBeLessThan(c.ultra)
    // The calibration GPUs: a Radeon iGPU (1.93 ms/MP) gets medium, an RTX 5070 Ti ultra even at 4K.
    expect(tierForCost(1.93, "high", px)).toBe("medium")
    expect(predictTierMs(1.93, px).medium).toBeLessThanOrEqual(PREDICTED_BUDGET_MS)
    expect(tierForCost(0.033, "ultra", tierPixels(1920, 1080, 2))).toBe("ultra")
    expect(tierForCost(50, "ultra", px)).toBe("low")
  })

  it("re-derives the tier from a cached measurement without benchmarking again", async () => {
    const storage = new MemoryStorage()
    storage.setItem(PROBE_CACHE_KEY, JSON.stringify({ renderer: "GPU", tier: "high", msPerMP: 0.05, cap: "ultra", reason: "cached", at: Date.now() }))
    const p = await probeQuality({ storage: storage as unknown as Storage, cssWidth: 1920, cssHeight: 1080, dpr: 1 })
    expect(p).toMatchObject({ cached: true, tier: "ultra", msPerMP: 0.05 })
    // A stale cache is ignored (no WebGL in Node: the probe falls back to medium).
    storage.setItem(PROBE_CACHE_KEY, JSON.stringify({ renderer: "GPU", tier: "high", msPerMP: 0.2, cap: "ultra", reason: "old", at: 0 }))
    const q = await probeQuality({ storage: storage as unknown as Storage, cssWidth: 1920, cssHeight: 1080, dpr: 1 })
    expect(q).toMatchObject({ cached: false, tier: "medium" })
  })

  it("classifies a software renderer as low without running the timed benchmark", async () => {
    const storage = new MemoryStorage()
    const measure = vi.fn(() => ({ msPerMP: 40, renderer: "SwiftShader", vendor: "Google" }))
    const p = await probeQuality({
      storage: storage as unknown as Storage,
      rendererInfo: () => ({ renderer: "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)", vendor: "Google Inc." }),
      measure,
    })
    expect(measure).not.toHaveBeenCalled()
    expect(p).toMatchObject({ tier: "low", cap: "low", msPerMP: null, reason: "software renderer", cached: false })
    // Cached like a measurement: the next page load does not even read the renderer.
    const again = await probeQuality({ storage: storage as unknown as Storage, rendererInfo: () => null, measure })
    expect(again).toMatchObject({ tier: "low", cached: true })
    expect(measure).not.toHaveBeenCalled()
  })

  it("times hardware renderers as before", async () => {
    const measure = vi.fn(() => ({ msPerMP: 0.033, renderer: "ANGLE (NVIDIA GeForce RTX 5070 Ti)", vendor: "NVIDIA" }))
    const p = await probeQuality({ storage: null, rendererInfo: () => ({ renderer: "ANGLE (NVIDIA GeForce RTX 5070 Ti)", vendor: "NVIDIA" }), measure, cssWidth: 1920, cssHeight: 1080, dpr: 1 })
    expect(measure).toHaveBeenCalledTimes(1)
    expect(p).toMatchObject({ tier: "ultra", cap: "ultra", msPerMP: 0.033 })
  })
})
