/**
 * Map image import (ARCHITECTURE §9 "Import"): decode a battlemap of any size, resample it to the
 * calibrated grid at ≤ 140 px per cell and ≤ 8192 px per side, encode WebP (PNG fallback), and hand
 * back the stored pixels for tracing floors/walls (core/scene/imageTrace).
 *
 * Decoding goes through `createImageBitmap(blob, { resizeWidth, resizeHeight, resizeQuality })`, which
 * scales while decoding: `HTMLImageElement.decode()` fails on 100+ MP images (e.g. 9000×15000 JPEGs),
 * and a full-size bitmap would need > 500 MB. The source size comes from the file header (PNG, JPEG,
 * WebP, GIF, BMP) so the target size is known before decoding.
 */
import type { Rect } from "@/core/scene/types"

import type { AssetMime } from "./types"

/** Stored resolution cap (Forgotten Adventures maps are drawn at 140 px per 5 ft cell). */
export const MAX_PX_PER_CELL = 140
/** Stored side cap (WebGL max texture size on most GPUs; WebP allows 16383). */
export const MAX_IMAGE_SIDE = 8192
/** Refuse absurd files before decoding. */
export const MAX_IMPORT_BYTES = 512 * 1024 * 1024

export interface ImportCalibration {
  /** Grid cells the image spans horizontally / vertically. */
  cellsX: number
  cellsZ: number
  /** World placement of the image's top-left corner (feet). */
  origin: { x: number; z: number }
}

export interface ImportedImage {
  blob: Blob
  width: number
  height: number
  mime: AssetMime
  /** Stored px per grid cell after normalisation. */
  pxPerCell: number
  /** Pixel data at stored size for tracing floors/walls (core/scene/imageTrace). */
  pixels: { width: number; height: number; data: Uint8ClampedArray }
  /** World rect the image covers. */
  rect: Rect
}

export interface ImportOptions {
  /** Default MAX_PX_PER_CELL. */
  maxPxPerCell?: number
  /** Default MAX_IMAGE_SIDE. */
  maxSide?: number
  /** WebP quality (default 0.9). */
  quality?: number
  /** Skip reading back pixels (no tracing needed). */
  skipPixels?: boolean
}

export interface ImageSize {
  width: number
  height: number
  /** Container format detected from the header. */
  format: "png" | "jpeg" | "webp" | "gif" | "bmp"
}

// ---------------------------------------------------------------------------
// Header sniffing
// ---------------------------------------------------------------------------

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1]
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8)
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)
const i32le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n))

/**
 * Pixel size from an image header. For JPEG, `bytes` must reach the SOF marker (EXIF/ICC segments
 * come first); returns "more" when the header continues past the given bytes, null when the data is
 * not a recognised image.
 */
export function readImageSize(bytes: Uint8Array): ImageSize | "more" | null {
  const b = bytes
  if (b.length < 12) return b.length === 0 ? null : "more"
  // PNG: signature + IHDR.
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG") {
    if (b.length < 24) return "more"
    return { width: u32be(b, 16), height: u32be(b, 20), format: "png" }
  }
  // GIF87a / GIF89a.
  if (ascii(b, 0, 4) === "GIF8") return { width: u16le(b, 6), height: u16le(b, 8), format: "gif" }
  // BMP (BITMAPINFOHEADER or later).
  if (b[0] === 0x42 && b[1] === 0x4d) {
    if (b.length < 26) return "more"
    return { width: Math.abs(i32le(b, 18)), height: Math.abs(i32le(b, 22)), format: "bmp" }
  }
  // WebP: RIFF....WEBP + VP8 / VP8L / VP8X chunk.
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    if (b.length < 16) return "more"
    const chunk = ascii(b, 12, 4)
    if (b.length < (chunk === "VP8L" ? 25 : 30)) return "more"
    if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1, format: "webp" }
    if (chunk === "VP8L") {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, format: "webp" }
    }
    if (chunk === "VP8 ") return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, format: "webp" }
    return null
  }
  // JPEG: walk the segments to the first SOFn.
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2
    while (o + 4 <= b.length) {
      if (b[o] !== 0xff) return null
      const marker = b[o + 1]
      if (marker === 0xff) {
        o++ // fill byte
        continue
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2
        continue
      }
      const len = u16be(b, o + 2)
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (isSof) {
        if (o + 9 > b.length) return "more"
        return { width: u16be(b, o + 7), height: u16be(b, o + 5), format: "jpeg" }
      }
      if (marker === 0xd9 || marker === 0xda) return null // end of image / start of scan before any SOF
      o += 2 + len
    }
    return "more"
  }
  return null
}

/** Header-sniffed size of an image blob (reads only as much of the file as the header needs). */
export async function probeImageSize(blob: Blob): Promise<ImageSize | null> {
  let n = 64 * 1024
  for (;;) {
    const bytes = new Uint8Array(await blob.slice(0, Math.min(n, blob.size)).arrayBuffer())
    const r = readImageSize(bytes)
    if (r !== "more") return r
    if (n >= blob.size || n >= 16 * 1024 * 1024) return null
    n *= 4
  }
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/**
 * Stored size for an image calibrated to `cellsX × cellsZ` cells: a whole number of px per cell (so
 * per-cell tiles line up exactly), ≤ maxPxPerCell, never upscaled beyond the source, and ≤ maxSide.
 */
export function normalisedSize(
  src: { width: number; height: number },
  calib: Pick<ImportCalibration, "cellsX" | "cellsZ">,
  maxPxPerCell = MAX_PX_PER_CELL,
  maxSide = MAX_IMAGE_SIDE
): { width: number; height: number; pxPerCell: number } {
  if (!(calib.cellsX > 0 && calib.cellsZ > 0)) throw new Error("calibration needs a positive grid size")
  const limit = Math.min(maxPxPerCell, src.width / calib.cellsX, src.height / calib.cellsZ, maxSide / calib.cellsX, maxSide / calib.cellsZ)
  const pxPerCell = Math.max(1, Math.floor(limit + 1e-9))
  return {
    width: Math.max(1, Math.min(maxSide, Math.round(calib.cellsX * pxPerCell))),
    height: Math.max(1, Math.min(maxSide, Math.round(calib.cellsZ * pxPerCell))),
    pxPerCell,
  }
}

/**
 * Grid size from a file name following the Forgotten Adventures convention ("…-27x47-…", also
 * "27 x 47", "27×47", "[27x47]"). Values must be 1..200 (the grid limit); resolutions such as
 * "1920x1080" never match.
 */
export function guessGridFromName(name: string): { cellsX: number; cellsZ: number } | null {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, "")
  const re = /(?:^|[^0-9A-Za-z])(\d{1,3})\s*[x×X]\s*(\d{1,3})(?=$|[^0-9A-Za-z])/gu
  for (const m of base.matchAll(re)) {
    const cellsX = Number(m[1])
    const cellsZ = Number(m[2])
    if (cellsX >= 1 && cellsX <= 200 && cellsZ >= 1 && cellsZ <= 200) return { cellsX, cellsZ }
  }
  return null
}

// ---------------------------------------------------------------------------
// Canvas helpers (OffscreenCanvas in workers and modern browsers, <canvas> otherwise)
// ---------------------------------------------------------------------------

export type Canvas2D = OffscreenCanvas | HTMLCanvasElement
type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

export function makeCanvas(width: number, height: number): Canvas2D {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height)
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas")
    c.width = width
    c.height = height
    return c
  }
  throw new Error("no canvas implementation available")
}

export function context2d(canvas: Canvas2D, opts?: CanvasRenderingContext2DSettings): Ctx2D {
  const ctx = (canvas as OffscreenCanvas).getContext("2d", opts) as Ctx2D | null
  if (!ctx) throw new Error("2D canvas context unavailable")
  return ctx
}

/** Encode a canvas; `type` is honoured when the browser supports it (check the blob's type). */
export async function canvasToBlob(canvas: Canvas2D, type: string, quality?: number): Promise<Blob> {
  if ("convertToBlob" in canvas) return canvas.convertToBlob({ type, quality })
  return new Promise((resolve, reject) => {
    ;(canvas as HTMLCanvasElement).toBlob((b) => (b ? resolve(b) : reject(new Error("canvas encoding failed"))), type, quality)
  })
}

/** WebP when the browser can encode it, else PNG (lossless, keeps alpha). */
export async function encodeImage(canvas: Canvas2D, quality = 0.9): Promise<{ blob: Blob; mime: AssetMime }> {
  const webp = await canvasToBlob(canvas, "image/webp", quality)
  if (webp.type === "image/webp") return { blob: webp, mime: "image/webp" }
  const png = webp.type === "image/png" ? webp : await canvasToBlob(canvas, "image/png")
  return { blob: png, mime: "image/png" }
}

// ---------------------------------------------------------------------------
// importMapImage
// ---------------------------------------------------------------------------

/** Decode (huge images OK), normalise to ≤ 140 px/cell and ≤ 8192 px, encode WebP. */
export async function importMapImage(file: Blob, calib: ImportCalibration, cellSize: number, opts: ImportOptions = {}): Promise<ImportedImage> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error(`the image is larger than ${Math.round(MAX_IMPORT_BYTES / 1048576)} MB`)
  if (!(cellSize > 0)) throw new Error("cell size must be positive")
  let src: { width: number; height: number } | null = await probeImageSize(file)
  if (!src) {
    // Unknown container (AVIF, TIFF…): let the browser tell us, then decode again at the target size.
    let probe: ImageBitmap
    try {
      probe = await createImageBitmap(file)
    } catch (err) {
      throw new Error("this file is not an image the browser can decode", { cause: err })
    }
    src = { width: probe.width, height: probe.height }
    probe.close()
  }
  const target = normalisedSize(src, calib, opts.maxPxPerCell, opts.maxSide)
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { resizeWidth: target.width, resizeHeight: target.height, resizeQuality: "high" })
  } catch (err) {
    throw new Error(`could not decode the image (${src.width}×${src.height}): ${err instanceof Error ? err.message : String(err)}`, { cause: err })
  }
  try {
    const canvas = makeCanvas(target.width, target.height)
    const ctx = context2d(canvas, { willReadFrequently: !opts.skipPixels })
    ctx.drawImage(bitmap, 0, 0, target.width, target.height)
    const { blob, mime } = await encodeImage(canvas, opts.quality ?? 0.9)
    const pixels = opts.skipPixels
      ? { width: 0, height: 0, data: new Uint8ClampedArray(0) }
      : (() => {
          const img = ctx.getImageData(0, 0, target.width, target.height)
          return { width: img.width, height: img.height, data: img.data }
        })()
    return {
      blob,
      width: target.width,
      height: target.height,
      mime,
      pxPerCell: target.pxPerCell,
      pixels,
      rect: { x: calib.origin.x, z: calib.origin.z, w: calib.cellsX * cellSize, d: calib.cellsZ * cellSize },
    }
  } finally {
    bitmap.close()
  }
}
