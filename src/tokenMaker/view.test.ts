import { describe, expect, it } from "vitest"

import { clampView, DEFAULT_VIEW, fitSize, MAX_ZOOM, MIN_ZOOM, panView, screenToCanvas, tokenRect, zoomViewAt, zoomViewCentre } from "./view"

const vp = { width: 800, height: 720 }

describe("stage view", () => {
  it("fits the token with room for the toolbar and outlines", () => {
    expect(fitSize(vp)).toBe(600)
    expect(fitSize({ width: 300, height: 900 })).toBe(252)
    expect(fitSize({ width: 10, height: 10 })).toBe(64)
    expect(tokenRect(DEFAULT_VIEW, vp)).toEqual({ left: 100, top: 60, side: 600 })
    expect(screenToCanvas(DEFAULT_VIEW, vp, 400, 360)).toEqual({ x: 0.5, y: 0.5 })
    expect(screenToCanvas(DEFAULT_VIEW, vp, 100, 60)).toEqual({ x: 0, y: 0 })
  })

  it("zooms about the pointer", () => {
    const before = screenToCanvas(DEFAULT_VIEW, vp, 250, 200)
    const v = zoomViewAt(DEFAULT_VIEW, vp, 250, 200, 2)
    expect(v.zoom).toBe(2)
    const after = screenToCanvas(v, vp, 250, 200)
    expect(after.x).toBeCloseTo(before.x)
    expect(after.y).toBeCloseTo(before.y)
    expect(tokenRect(v, vp).side).toBe(1200)
    // About the centre, the centre stays centred.
    expect(zoomViewCentre(DEFAULT_VIEW, vp, 1.5)).toEqual({ zoom: 1.5, x: 0, y: 0 })
  })

  it("clamps zoom and pan", () => {
    expect(zoomViewCentre(DEFAULT_VIEW, vp, 100).zoom).toBe(MAX_ZOOM)
    expect(zoomViewCentre(DEFAULT_VIEW, vp, 0.001).zoom).toBe(MIN_ZOOM)
    const panned = panView(DEFAULT_VIEW, vp, 60, -30)
    expect(panned.x).toBeCloseTo(0.1)
    expect(panned.y).toBeCloseTo(-0.05)
    expect(panView(DEFAULT_VIEW, vp, 1e6, 0).x).toBe(1)
    expect(clampView({ zoom: 4, x: -9, y: 9 })).toEqual({ zoom: 4, x: -2.5, y: 2.5 })
  })
})
