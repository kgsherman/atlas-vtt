import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { BACKDROP_MAX_SIDE, BACKDROP_MAX_TEXELS, BackdropManager, dirtyPixels, fitTextureSize, sourceSize } from "./backdrops"

describe("backdrop sizing", () => {
  it("keeps images within the texel budget and side limit, never upscaling", () => {
    expect(fitTextureSize(3780, 6580, 67e6, 8192)).toEqual({ width: 3780, height: 6580, scale: 1 })
    const medium = fitTextureSize(3780, 6580, BACKDROP_MAX_TEXELS.medium, BACKDROP_MAX_SIDE)
    expect(medium.width * medium.height).toBeLessThanOrEqual(BACKDROP_MAX_TEXELS.medium)
    expect(medium.width / medium.height).toBeCloseTo(3780 / 6580, 2)
    const huge = fitTextureSize(9000, 15000, 1e9, 8192)
    expect(huge.height).toBeLessThanOrEqual(8192)
    expect(fitTextureSize(0, 10, 1e6, 8192)).toEqual({ width: 0, height: 0, scale: 1 })
  })

  it("maps a dirty world rect to the covered source pixels", () => {
    const rect = { x: 0, z: 0, w: 135, d: 235 }
    // One 5 ft cell of a 140 px/cell image, padded by 1 px.
    expect(dirtyPixels(rect, 3780, 6580, { x: 10, z: 20, w: 5, d: 5 })).toEqual({ x: 279, y: 559, w: 142, h: 142 })
    expect(dirtyPixels(rect, 3780, 6580, { x: 500, z: 500, w: 5, d: 5 })).toBeNull()
    // Clamped to the image.
    expect(dirtyPixels(rect, 3780, 6580, { x: -10, z: -10, w: 12, d: 12 }, 0)).toEqual({ x: 0, y: 0, w: 56, h: 56 })
  })

  it("reads the size of any image source", () => {
    expect(sourceSize({ width: 3, height: 4 } as unknown as ImageBitmap)).toEqual({ width: 3, height: 4 })
    expect(sourceSize({ naturalWidth: 5, naturalHeight: 6, width: 1, height: 1 } as unknown as HTMLImageElement)).toEqual({ width: 5, height: 6 })
    expect(sourceSize({ videoWidth: 7, videoHeight: 8 } as unknown as HTMLVideoElement)).toEqual({ width: 7, height: 8 })
  })
})

describe("BackdropManager", () => {
  const renderer = {} as THREE.WebGLRenderer
  const image = { width: 64, height: 32 } as unknown as ImageBitmap
  const rect = { x: 0, z: 0, w: 100, d: 50 }

  it("hands levels an sRGB mipmapped texture and removes it again", () => {
    const calls: { levelId: string; texture: THREE.Texture | null; opacity: number; tintWalls: boolean }[] = []
    const m = new BackdropManager(renderer, "high", (levelId, texture, _rect, opacity, tintWalls) => calls.push({ levelId, texture, opacity, tintWalls }))
    m.set("L", image, rect)
    const t = calls[0].texture!
    expect(t.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(t.generateMipmaps).toBe(true)
    expect(t.flipY).toBe(false)
    expect(t.premultiplyAlpha).toBe(true)
    expect(calls[0]).toMatchObject({ opacity: 1, tintWalls: false })
    m.set("L", null, null)
    expect(calls.at(-1)).toMatchObject({ levelId: "L", texture: null })
    expect(m.has("L")).toBe(false)
  })

  it("takes opacity / tint from options, else the level document", () => {
    const calls: { opacity: number; tintWalls: boolean }[] = []
    const m = new BackdropManager(renderer, "high", (_l, _t, _r, opacity, tintWalls) => calls.push({ opacity, tintWalls }))
    const level = { id: "L", name: "L", elevation: 0, height: 10, floorThickness: 1, heightmap: null, backdrop: { assetId: "a", rect, opacity: 0.5, tintWalls: true } }
    m.syncScene({ grid: { cellSize: 5, width: 20, depth: 10, diagonalRule: "5-5-5" }, environment: {} as never, levels: { L: level }, objects: {}, tokens: {} })
    m.set("L", image, rect)
    expect(calls.at(-1)).toEqual({ opacity: 0.5, tintWalls: true })
    m.set("L", image, rect, { opacity: 0.25 })
    expect(calls.at(-1)).toEqual({ opacity: 0.25, tintWalls: true })
  })

  it("ignores empty images and degenerate rects", () => {
    const calls: (THREE.Texture | null)[] = []
    const m = new BackdropManager(renderer, "high", (_l, t) => calls.push(t))
    m.set("L", { width: 0, height: 0 } as unknown as ImageBitmap, rect)
    m.set("M", image, { x: 0, z: 0, w: 0, d: 5 })
    expect(calls).toEqual([null, null])
  })
})
