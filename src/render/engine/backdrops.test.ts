import * as THREE from "three"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BACKDROP_MAX_SIDE, BACKDROP_MAX_TEXELS, BackdropManager, backdropTexelBudget, dirtyPixels, fitTextureSize, mergePixelRegions, sourceSize } from "./backdrops"

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

  it("keeps a source sized to exactly the budget at scale 1 (no private copy)", () => {
    const budget = backdropTexelBudget("medium")
    expect(budget).toBe(BACKDROP_MAX_TEXELS.medium)
    // 2690 × 4684 = 12 599 960 ≤ 12.6e6.
    expect(fitTextureSize(2690, 4684, budget, BACKDROP_MAX_SIDE)).toEqual({ width: 2690, height: 4684, scale: 1 })
    expect(fitTextureSize(1000, 1000, 1e6, 1000)).toEqual({ width: 1000, height: 1000, scale: 1 })
    expect(fitTextureSize(1000, 1000, 1e6 - 1, 8192).scale).toBeLessThan(1)
  })

  it("merges neighbouring upload regions and keeps distant ones apart", () => {
    const a = { x: 0, y: 0, w: 10, h: 10 }
    const b = { x: 10, y: 0, w: 10, h: 10 }
    const far = { x: 500, y: 500, w: 10, h: 10 }
    expect(mergePixelRegions([a, b])).toEqual([{ x: 0, y: 0, w: 20, h: 10 }])
    expect(mergePixelRegions([a, far])).toEqual([a, far])
    // A chain of neighbours collapses into one strip.
    const row = Array.from({ length: 6 }, (_, i) => ({ x: i * 10, y: 0, w: 10, h: 10 }))
    expect(mergePixelRegions(row)).toEqual([{ x: 0, y: 0, w: 60, h: 10 }])
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
    m.syncScene({ grid: { cellSize: 5, width: 20, depth: 10, diagonalRule: "5-5-5", visionOrigin: "square" }, environment: {} as never, levels: { L: level }, objects: {}, tokens: {} })
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

/** Minimal 2D canvas for Node: records nothing, draws nothing. */
class FakeCanvas {
  width: number
  height: number
  constructor(w: number, h: number) {
    this.width = w
    this.height = h
  }
  getContext() {
    return { clearRect() {}, drawImage() {}, putImageData() {}, imageSmoothingEnabled: true, imageSmoothingQuality: "low" }
  }
}

describe("BackdropManager partial updates", () => {
  interface Copy {
    w: number
    h: number
    x: number
    y: number
    mips: boolean
    dst: THREE.Texture
  }
  let copies: Copy[]
  let renderer: THREE.WebGLRenderer
  const rect = { x: 0, z: 0, w: 135, d: 235 }

  beforeEach(() => {
    vi.stubGlobal("OffscreenCanvas", FakeCanvas)
    copies = []
    renderer = {
      capabilities: { maxTextureSize: 16384 },
      initTexture(t: THREE.Texture) {
        t.version = 1
      },
      copyTextureToTexture: vi.fn((src: THREE.Texture, dst: THREE.Texture, _region: unknown, pos: THREE.Vector2) => {
        const img = src.image as FakeCanvas
        copies.push({ w: img.width, h: img.height, x: pos.x, y: pos.y, mips: dst.generateMipmaps, dst })
      }),
    } as unknown as THREE.WebGLRenderer
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function manager(quality: "medium" | "high", source: FakeCanvas) {
    const textures: (THREE.Texture | null)[] = []
    const m = new BackdropManager(renderer, quality, (_l, t) => textures.push(t))
    m.set("L", source as unknown as OffscreenCanvas, rect)
    return { m, textures }
  }

  it("uploads distant dirty cells as separate small copies with one mipmap regeneration", () => {
    const source = new FakeCanvas(3780, 6580)
    const { m, textures } = manager("high", source)
    m.update("L", [
      { x: 0, z: 0, w: 5, d: 5 },
      { x: 130, z: 230, w: 5, d: 5 },
    ])
    expect(textures).toHaveLength(1)
    expect(copies).toHaveLength(2)
    for (const c of copies) {
      // One 140 px cell plus padding, not the 3780 × 6580 bounding box.
      expect(c.w).toBeLessThan(150)
      expect(c.h).toBeLessThan(150)
    }
    // three regenerates the mip chain after a copy into a texture with generateMipmaps: only the last.
    expect(copies.map((c) => c.mips)).toEqual([false, true])
    expect(textures[0]!.generateMipmaps).toBe(true)
    // An empty list, or cells outside the image, upload nothing.
    const version = textures[0]!.version
    m.update("L", [])
    m.update("L", { x: 500, z: 500, w: 5, d: 5 })
    expect(copies).toHaveLength(2)
    expect(textures[0]!.version).toBe(version)
  })

  it("does not rebuild a downscaled texture when the source is unchanged (medium, 3780 × 6580)", () => {
    const source = new FakeCanvas(3780, 6580)
    const { m, textures } = manager("medium", source)
    const t = textures[0]!
    expect((t.image as FakeCanvas).width).toBeLessThan(3780)
    m.update("L", { x: 10, z: 20, w: 5, d: 5 })
    expect(textures).toHaveLength(1)
    expect(copies).toHaveLength(1)
    expect(copies[0].dst).toBe(t)
  })

  it("does not rebuild a player canvas above the high budget (3360 × 7840)", () => {
    const source = new FakeCanvas(3360, 7840)
    const { m, textures } = manager("high", source)
    expect((textures[0]!.image as FakeCanvas).width).toBeLessThan(3360)
    m.update("L", { x: 10, z: 20, w: 5, d: 5 })
    expect(textures).toHaveLength(1)
    expect(copies).toHaveLength(1)
  })

  it("rebuilds when the source was really resized", () => {
    const source = new FakeCanvas(3780, 6580)
    const { m, textures } = manager("medium", source)
    source.width = 3920
    m.update("L", { x: 10, z: 20, w: 5, d: 5 })
    expect(textures).toHaveLength(2)
    expect(textures[1]).not.toBe(textures[0])
    expect((textures[1]!.image as FakeCanvas).width).toBe(fitTextureSize(3920, 6580, BACKDROP_MAX_TEXELS.medium, 8192).width)
    expect(copies).toHaveLength(0)
  })
})
