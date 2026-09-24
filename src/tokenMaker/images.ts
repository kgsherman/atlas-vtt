/**
 * Token Maker images (ARCHITECTURE §11): importing files (decoded at ≤ 2048 px, alpha kept), decoding
 * blobs for the compositor, alpha sampling for click-to-select, and the frame opening of a ring image.
 */
import { detectFrameOpening } from "@/core/tokenMaker/frame"
import { canvasToBlob, context2d, makeCanvas, probeImageSize } from "@/net/assets/import"

/** Longest side of an imported image (a 2048 px token never needs more). */
export const MAX_SOURCE_SIDE = 2048
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024

export interface SourceImage {
  blob: Blob
  width: number
  height: number
}

const KEEP_TYPES = new Set(["image/png", "image/webp", "image/jpeg"])

/**
 * A file as a token source: ≤ MAX_SOURCE_SIDE px (downscaled while decoding), stored as PNG unless it
 * already is a small enough PNG / WebP / JPEG. Throws a user-facing Error for non-images.
 */
export async function importSourceImage(file: Blob, maxSide = MAX_SOURCE_SIDE): Promise<SourceImage> {
  if (file.size > MAX_SOURCE_BYTES) throw new Error(`That file is larger than ${MAX_SOURCE_BYTES / 1048576} MB.`)
  let size: { width: number; height: number } | null = await probeImageSize(file)
  if (!size) {
    let probe: ImageBitmap
    try {
      probe = await createImageBitmap(file)
    } catch (err) {
      throw new Error("That file is not an image this browser can open.", { cause: err })
    }
    size = { width: probe.width, height: probe.height }
    probe.close()
  }
  if (!(size.width > 0 && size.height > 0)) throw new Error("That image is empty.")
  const k = Math.min(1, maxSide / Math.max(size.width, size.height))
  if (k === 1 && KEEP_TYPES.has(file.type)) return { blob: file, width: size.width, height: size.height }
  const width = Math.max(1, Math.round(size.width * k))
  const height = Math.max(1, Math.round(size.height * k))
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" })
  } catch (err) {
    throw new Error("That file is not an image this browser can open.", { cause: err })
  }
  try {
    const canvas = makeCanvas(width, height)
    context2d(canvas).drawImage(bitmap, 0, 0)
    return { blob: await canvasToBlob(canvas, "image/png"), width, height }
  } finally {
    bitmap.close()
  }
}

/** Decode a stored source image for drawing. */
export function decodeImage(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob)
}

/** Alpha of a decoded image at a small resolution, for "is the pointer on something opaque?". */
export interface AlphaMap {
  width: number
  height: number
  alpha: Uint8Array
}

export function alphaMap(img: ImageBitmap, maxSide = 256): AlphaMap {
  const k = Math.min(1, maxSide / Math.max(img.width, img.height))
  const width = Math.max(1, Math.round(img.width * k))
  const height = Math.max(1, Math.round(img.height * k))
  const canvas = makeCanvas(width, height)
  const ctx = context2d(canvas, { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, width, height)
  const data = ctx.getImageData(0, 0, width, height).data
  const alpha = new Uint8Array(width * height)
  for (let i = 0; i < alpha.length; i++) alpha[i] = data[i * 4 + 3]
  return { width, height, alpha }
}

export function alphaAt(map: AlphaMap, u: number, v: number): number {
  const x = Math.min(map.width - 1, Math.max(0, Math.floor(u * map.width)))
  const y = Math.min(map.height - 1, Math.max(0, Math.floor(v * map.height)))
  return map.alpha[y * map.width + x] / 255
}

/** The opening of a ring image as a fraction of its width (core detectFrameOpening), or null. */
export function frameOpening(img: ImageBitmap): number | null {
  const k = Math.min(1, 512 / Math.max(img.width, img.height))
  const width = Math.max(1, Math.round(img.width * k))
  const height = Math.max(1, Math.round(img.height * k))
  const canvas = makeCanvas(width, height)
  const ctx = context2d(canvas, { willReadFrequently: true })
  ctx.drawImage(img, 0, 0, width, height)
  return detectFrameOpening(ctx.getImageData(0, 0, width, height).data, width, height)
}

/** Whether an image has any transparent pixels (a cut-out subject vs. a full picture). */
export function hasTransparency(map: AlphaMap): boolean {
  for (let i = 0; i < map.alpha.length; i++) if (map.alpha[i] < 250) return true
  return false
}
