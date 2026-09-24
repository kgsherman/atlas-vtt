import { describe, expect, it } from "vitest"

import { detectFrameOpening } from "./frame"

/** A size×size RGBA image whose alpha is `alpha(x, y)`. */
function image(size: number, alpha: (x: number, y: number) => number): Uint8ClampedArray {
  const px = new Uint8ClampedArray(size * size * 4)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) px[(y * size + x) * 4 + 3] = alpha(x, y)
  return px
}

const c = (size: number) => (size - 1) / 2

describe("detectFrameOpening", () => {
  it("measures the hole of a ring", () => {
    const n = 200
    // Ring from r = 70 to r = 95 px, with a soft inner shadow (alpha < 50%) from r = 60.
    const px = image(n, (x, y) => {
      const r = Math.hypot(x - c(n), y - c(n))
      if (r >= 70 && r <= 95) return 255
      if (r >= 60 && r < 70) return 80
      return 0
    })
    const opening = detectFrameOpening(px, n, n)!
    expect(opening * n).toBeGreaterThan(69)
    expect(opening * n).toBeLessThan(71.5)
    // A lower threshold stops at the shadow.
    expect(detectFrameOpening(px, n, n, { threshold: 0.2 })! * n).toBeLessThan(61.5)
  })

  it("ignores studs and gaps (median of the rays)", () => {
    const n = 200
    const px = image(n, (x, y) => {
      const r = Math.hypot(x - c(n), y - c(n))
      const a = Math.atan2(y - c(n), x - c(n))
      if (Math.abs(a) < 0.15) return 0 // a gap on the right
      if (r >= 50 && r <= 90 && Math.abs(a - 1.5) < 0.2) return 255 // a stud reaching inwards at the bottom
      return r >= 80 && r <= 95 ? 255 : 0
    })
    const opening = detectFrameOpening(px, n, n)!
    expect(opening * n).toBeGreaterThan(79)
    expect(opening * n).toBeLessThan(81.5)
  })

  it("returns null without an opening or a ring", () => {
    const n = 64
    const opaque = image(n, () => 255)
    const empty = image(n, () => 0)
    expect(detectFrameOpening(opaque, n, n)).toBeNull()
    expect(detectFrameOpening(empty, n, n)).toBeNull()
    // Only the left half has a ring: most rays escape.
    const half = image(n, (x, y) => (x < c(n) && Math.hypot(x - c(n), y - c(n)) > 20 ? 255 : 0))
    expect(detectFrameOpening(half, n, n)).toBeNull()
    expect(detectFrameOpening(new Uint8ClampedArray(8), 2, 1)).toBeNull()
  })

  it("reports the radius relative to the width for non-square images", () => {
    const w = 300
    const h = 200
    const px = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const r = Math.hypot(x - (w - 1) / 2, y - (h - 1) / 2)
        px[(y * w + x) * 4 + 3] = r >= 60 ? 255 : 0
      }
    expect(detectFrameOpening(px, w, h)! * w).toBeCloseTo(60, 0)
  })
})
