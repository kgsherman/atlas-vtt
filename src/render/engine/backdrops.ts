/**
 * Level battlemap images (ARCHITECTURE §9) on the engine side: one sRGB, mipmapped, anisotropic texture
 * per level, handed to the lighting system's per-level backdrop uniforms (no recompiles when images come
 * and go).
 *
 * Sources: DM modes pass the whole decoded image (ImageBitmap, canvas, <img>, ImageData); player mode
 * passes a canvas it composites explored-cell tiles into and calls update() with the dirty world rects
 * after drawing more, which re-uploads only those sub-rectangles (one texSubImage2D per region, then one
 * mipmap regeneration for the whole update) instead of the whole image.
 *
 * Images larger than the tier's texel budget (or the GPU's max texture size) are downscaled once into
 * a private canvas; the budget follows the user's quality ceiling, not adaptive steps, so an adaptive
 * step never re-uploads images. ImageBitmaps should be created with premultiplyAlpha "premultiply"
 * (canvases are premultiplied on upload); the world shader composites premultiplied colour.
 */
import * as THREE from "three"

import type { Id, Rect, SceneLike } from "@/core/scene/types"
import type { Quality } from "../contracts"

/** Max texels of one level image per quality ceiling. */
export const BACKDROP_MAX_TEXELS: Record<Quality, number> = {
  low: 4.2e6,
  medium: 12.6e6,
  high: 26e6,
  ultra: 67e6,
}

/** Longest side of a level image texture (before the GPU limit). */
export const BACKDROP_MAX_SIDE = 8192

export interface BackdropOptions {
  opacity?: number
  tintWalls?: boolean
}

type Canvas2D = HTMLCanvasElement | OffscreenCanvas

interface Entry {
  source: TexImageSource
  rect: Rect
  opts: BackdropOptions
  texture: THREE.Texture
  /** Downscaled copy (null = the source is uploaded directly). */
  scaled: Canvas2D | null
  /** Source pixel size the texture was built from (a different live size means the source was resized). */
  srcWidth: number
  srcHeight: number
  /** Texture size. */
  width: number
  height: number
  /** Texture texels per source pixel. */
  scale: number
}

/** Integer pixel rectangle. */
export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

export interface BackdropSink {
  (levelId: Id, texture: THREE.Texture | null, rect: Rect | null, opacity: number, tintWalls: boolean): void
}

/** Pixel size of an image source (0 × 0 when unknown). */
export function sourceSize(src: TexImageSource): { width: number; height: number } {
  const s = src as { naturalWidth?: number; naturalHeight?: number; videoWidth?: number; videoHeight?: number; displayWidth?: number; displayHeight?: number; width?: number; height?: number }
  const width = s.naturalWidth || s.videoWidth || s.displayWidth || s.width || 0
  const height = s.naturalHeight || s.videoHeight || s.displayHeight || s.height || 0
  return { width, height }
}

/**
 * Texture size for an image under a texel budget and a side limit (aspect kept, never upscaled). A source
 * within both limits (compared exactly, before any square root) keeps its size with scale exactly 1, so a
 * canvas sized to the budget (`backdropTexelBudget`) is uploaded directly, without a private downscaled copy.
 */
export function fitTextureSize(width: number, height: number, maxTexels: number, maxSide: number): { width: number; height: number; scale: number } {
  if (!(width > 0 && height > 0)) return { width: 0, height: 0, scale: 1 }
  if (width * height <= maxTexels && Math.max(width, height) <= maxSide) return { width, height, scale: 1 }
  const scale = Math.min(1, Math.sqrt(maxTexels / (width * height)), maxSide / Math.max(width, height))
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)), scale }
}

/**
 * Max texels of one level image for a quality ceiling (the engine's own cap). Player compositors size
 * their canvases with it so canvas and texture match and no second, downscaled copy is made.
 */
export function backdropTexelBudget(q: Quality): number {
  return BACKDROP_MAX_TEXELS[q]
}

/**
 * Coalesce pixel regions for upload: two regions are merged when their summed area covers at least
 * `fill` of their bounding box (neighbouring cells become one copy; distant ones stay separate, so a
 * move that explores both ends of the map never re-uploads everything in between).
 */
export function mergePixelRegions(regions: readonly PixelRect[], fill = 0.5): PixelRect[] {
  const out: { r: PixelRect; area: number }[] = []
  for (const region of regions) {
    let cur = { r: region, area: region.w * region.h }
    for (let merged = true; merged; ) {
      merged = false
      for (let i = 0; i < out.length; i++) {
        const u = unionPixelRect(out[i].r, cur.r)
        const area = out[i].area + cur.area
        if (area >= fill * u.w * u.h) {
          cur = { r: u, area: Math.min(area, u.w * u.h) }
          out.splice(i, 1)
          merged = true
          break
        }
      }
    }
    out.push(cur)
  }
  return out.map((o) => o.r)
}

function unionPixelRect(a: PixelRect, b: PixelRect): PixelRect {
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

/**
 * Source pixel rectangle covered by a world rect of an image placed over `rect` (clamped, integer,
 * expanded by `pad` pixels); null when they do not overlap.
 */
export function dirtyPixels(rect: Rect, width: number, height: number, dirty: Rect, pad = 1): PixelRect | null {
  const sx = width / rect.w
  const sy = height / rect.d
  const x0 = Math.max(0, Math.floor((dirty.x - rect.x) * sx) - pad)
  const y0 = Math.max(0, Math.floor((dirty.z - rect.z) * sy) - pad)
  const x1 = Math.min(width, Math.ceil((dirty.x + dirty.w - rect.x) * sx) + pad)
  const y1 = Math.min(height, Math.ceil((dirty.z + dirty.d - rect.z) * sy) + pad)
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}

function createCanvas(w: number, h: number): Canvas2D | null {
  try {
    if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h)
    if (typeof document !== "undefined") {
      const c = document.createElement("canvas")
      c.width = w
      c.height = h
      return c
    }
  } catch {
    // Fall through: no canvas support (tests).
  }
  return null
}

function context2d(c: Canvas2D): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null {
  try {
    return c.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null
  } catch {
    return null
  }
}

/** Draw a source (any TexImageSource) scaled into a canvas region. */
function drawSource(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  src: TexImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dx: number,
  dy: number,
  dw: number,
  dh: number
): void {
  if (typeof ImageData !== "undefined" && src instanceof ImageData) {
    const tmp = createCanvas(src.width, src.height)
    const tctx = tmp && context2d(tmp)
    if (!tmp || !tctx) return
    tctx.putImageData(src, 0, 0)
    ctx.drawImage(tmp, sx, sy, sw, sh, dx, dy, dw, dh)
    return
  }
  ctx.drawImage(src as CanvasImageSource, sx, sy, sw, sh, dx, dy, dw, dh)
}

function isRectList(d: Rect | readonly Rect[]): d is readonly Rect[] {
  return Array.isArray(d)
}

export class BackdropManager {
  private readonly renderer: THREE.WebGLRenderer
  private readonly sink: BackdropSink
  private readonly entries = new Map<Id, Entry>()
  private quality: Quality
  private scene: SceneLike | null = null

  constructor(renderer: THREE.WebGLRenderer, quality: Quality, sink: BackdropSink) {
    this.renderer = renderer
    this.quality = quality
    this.sink = sink
  }

  private maxSide(): number {
    const caps = (this.renderer as Partial<THREE.WebGLRenderer>).capabilities
    return Math.min(BACKDROP_MAX_SIDE, caps?.maxTextureSize ?? BACKDROP_MAX_SIDE)
  }

  private anisotropy(): number {
    const caps = (this.renderer as Partial<THREE.WebGLRenderer>).capabilities
    try {
      return Math.min(16, caps?.getMaxAnisotropy?.() ?? 1)
    } catch {
      return 1
    }
  }

  /** Opacity / tint of a level: explicit options, else the level document's backdrop, else opaque. */
  private params(levelId: Id, opts: BackdropOptions): { opacity: number; tintWalls: boolean } {
    const doc = this.scene && Object.hasOwn(this.scene.levels, levelId) ? this.scene.levels[levelId].backdrop : null
    return { opacity: opts.opacity ?? doc?.opacity ?? 1, tintWalls: opts.tintWalls ?? doc?.tintWalls ?? false }
  }

  set(levelId: Id, image: TexImageSource | null, rect: Rect | null, opts: BackdropOptions = {}): void {
    const old = this.entries.get(levelId)
    if (!image || !rect || !(rect.w > 0 && rect.d > 0)) {
      if (old) this.release(old)
      this.entries.delete(levelId)
      this.sink(levelId, null, null, 0, false)
      return
    }
    const entry = this.build(image, { ...rect }, opts)
    if (old) this.release(old)
    if (!entry) {
      this.entries.delete(levelId)
      this.sink(levelId, null, null, 0, false)
      return
    }
    this.entries.set(levelId, entry)
    this.apply(levelId, entry)
  }

  /**
   * Re-upload after the source changed: everything when `dirty` is omitted, else only the texels under
   * the dirty world rect(s). A list holds independent regions, uploaded separately (nearby ones are
   * coalesced), with one mipmap regeneration for the whole update. Regions outside the image are ignored.
   */
  update(levelId: Id, dirty?: Rect | readonly Rect[]): void {
    const e = this.entries.get(levelId)
    if (!e) return
    const { width, height } = sourceSize(e.source)
    if (width !== e.srcWidth || height !== e.srcHeight) {
      // The source was resized: rebuild.
      this.set(levelId, e.source, e.rect, e.opts)
      return
    }
    if (dirty !== undefined) {
      const rects: readonly Rect[] = isRectList(dirty) ? dirty : [dirty]
      const px: PixelRect[] = []
      for (const r of rects) {
        const p = dirtyPixels(e.rect, width, height, r, 2)
        if (p) px.push(p)
      }
      if (px.length === 0 || this.uploadRegions(e, mergePixelRegions(px))) return
    }
    // Full upload.
    if (e.scaled) this.redrawScaled(e, null)
    e.texture.needsUpdate = true
  }

  /** Scene revision: re-read per-level opacity / tint from the document. */
  syncScene(scene: SceneLike): void {
    this.scene = scene
    for (const [levelId, e] of this.entries) this.apply(levelId, e)
  }

  /** The user's quality ceiling changed: rebuild textures whose size depends on the budget. */
  setQuality(q: Quality): void {
    if (q === this.quality) return
    this.quality = q
    for (const [levelId, e] of [...this.entries]) {
      const { width, height } = sourceSize(e.source)
      const fit = fitTextureSize(width, height, BACKDROP_MAX_TEXELS[q], this.maxSide())
      if (fit.width !== e.width || fit.height !== e.height) this.set(levelId, e.source, e.rect, e.opts)
    }
  }

  /** Context restored: textures re-upload lazily; mark them. */
  invalidate(): void {
    for (const e of this.entries.values()) e.texture.needsUpdate = true
  }

  has(levelId: Id): boolean {
    return this.entries.has(levelId)
  }

  private apply(levelId: Id, e: Entry): void {
    const p = this.params(levelId, e.opts)
    this.sink(levelId, e.texture, e.rect, p.opacity, p.tintWalls)
  }

  private build(source: TexImageSource, rect: Rect, opts: BackdropOptions): Entry | null {
    const { width, height } = sourceSize(source)
    if (!(width > 0 && height > 0)) return null
    const fit = fitTextureSize(width, height, BACKDROP_MAX_TEXELS[this.quality], this.maxSide())
    let scaled: Canvas2D | null = null
    if (fit.scale < 1) {
      scaled = createCanvas(fit.width, fit.height)
      if (!scaled) return null
    }
    const image = (scaled ?? source) as THREE.Texture["image"]
    const texture = new THREE.Texture(image)
    texture.name = "atlas-level-backdrop"
    texture.colorSpace = THREE.SRGBColorSpace
    texture.flipY = false
    texture.premultiplyAlpha = true
    texture.generateMipmaps = true
    texture.minFilter = THREE.LinearMipmapLinearFilter
    texture.magFilter = THREE.LinearFilter
    texture.wrapS = THREE.ClampToEdgeWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    texture.anisotropy = this.anisotropy()
    const entry: Entry = { source, rect, opts: { ...opts }, texture, scaled, srcWidth: width, srcHeight: height, width: fit.width, height: fit.height, scale: fit.scale }
    if (scaled) this.redrawScaled(entry, null)
    texture.needsUpdate = true
    // Upload now (not at first draw), so later partial updates always have a GPU texture to patch.
    try {
      ;(this.renderer as Partial<THREE.WebGLRenderer>).initTexture?.call(this.renderer, texture)
    } catch {
      // Uploaded lazily on first use instead.
    }
    return entry
  }

  /** Redraw the downscaled copy (a source pixel region, or all of it). */
  private redrawScaled(e: Entry, px: PixelRect | null): PixelRect | null {
    const c = e.scaled
    const ctx = c && context2d(c)
    if (!c || !ctx) return null
    const { width, height } = sourceSize(e.source)
    const r = px ?? { x: 0, y: 0, w: width, h: height }
    const k = e.scale
    const dx = Math.floor(r.x * k)
    const dy = Math.floor(r.y * k)
    const dw = Math.min(e.width, Math.ceil((r.x + r.w) * k)) - dx
    const dh = Math.min(e.height, Math.ceil((r.y + r.h) * k)) - dy
    if (dw <= 0 || dh <= 0) return null
    // Source region aligned to the destination pixels (no seams between partial redraws).
    const sx = dx / k
    const sy = dy / k
    const sw = Math.min(width - sx, dw / k)
    const sh = Math.min(height - sy, dh / k)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    ctx.clearRect(dx, dy, dw, dh)
    drawSource(ctx, e.source, sx, sy, sw, sh, dx, dy, dw, dh)
    return { x: dx, y: dy, w: dw, h: dh }
  }

  /**
   * texSubImage2D of each source pixel region (downscaled first when the texture is a scaled copy); false
   * when not possible (the caller does a full upload then). three regenerates the whole mip chain after
   * every copy into a texture with `generateMipmaps`, so it is switched off for all copies but the last.
   */
  private uploadRegions(e: Entry, pxs: readonly PixelRect[]): boolean {
    const r = this.renderer as Partial<THREE.WebGLRenderer>
    if (typeof r.copyTextureToTexture !== "function" || e.texture.version === 0) return false
    const regions: PixelRect[] = []
    for (const px of pxs) {
      const region = e.scaled ? this.redrawScaled(e, px) : px
      if (region) regions.push(region)
    }
    const mips = e.texture.generateMipmaps
    try {
      for (let i = 0; i < regions.length; i++) {
        e.texture.generateMipmaps = mips && i === regions.length - 1
        if (!this.copyRegion(e, regions[i])) return false
      }
    } finally {
      e.texture.generateMipmaps = mips
    }
    return true
  }

  /** Copy one texture-pixel region from the uploaded image (the scaled copy or the source). */
  private copyRegion(e: Entry, region: PixelRect): boolean {
    const r = this.renderer as Partial<THREE.WebGLRenderer> & Pick<THREE.WebGLRenderer, "copyTextureToTexture">
    const from = e.scaled ?? e.source
    const crop = createCanvas(region.w, region.h)
    const ctx = crop && context2d(crop)
    if (!crop || !ctx) return false
    drawSource(ctx, from, region.x, region.y, region.w, region.h, 0, 0, region.w, region.h)
    const src = new THREE.Texture(crop as THREE.Texture["image"])
    src.flipY = false
    src.premultiplyAlpha = true
    src.colorSpace = THREE.SRGBColorSpace
    try {
      r.copyTextureToTexture.call(this.renderer, src, e.texture, null, new THREE.Vector2(region.x, region.y))
    } catch {
      return false
    } finally {
      src.dispose()
    }
    return true
  }

  private release(e: Entry): void {
    e.texture.dispose()
  }

  dispose(): void {
    for (const e of this.entries.values()) this.release(e)
    this.entries.clear()
  }
}
