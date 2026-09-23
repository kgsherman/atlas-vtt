/**
 * Decoded level backdrop images (ARCHITECTURE §9), cached per (scene, asset) so the viewport can
 * re-apply them after a full engine rebuild without re-downloading or re-decoding.
 */
import type { TraceImage } from "@/core/scene/imageTrace"
import type { Id, Rect } from "@/core/scene/types"
import { loadBackdropImage } from "@/net/assets"
import type { AssetStore } from "@/net/assets/types"

const cache = new Map<string, Promise<ImageBitmap>>()

const keyOf = (sceneId: Id, assetId: Id) => `${sceneId}/${assetId}`

/** Load (or reuse) the decoded image of an asset. Rejects when the asset is missing or undecodable. */
export function loadLevelImage(assets: AssetStore, sceneId: Id, assetId: Id): Promise<ImageBitmap> {
  const key = keyOf(sceneId, assetId)
  let p = cache.get(key)
  if (!p) {
    p = (async () => {
      const image = await loadBackdropImage(assets, sceneId, assetId)
      if (!image) throw new Error("the map image is missing from storage")
      return image
    })()
    cache.set(key, p)
    // Failed loads are not cached, so a later retry can succeed.
    p.catch(() => {
      if (cache.get(key) === p) cache.delete(key)
    })
  }
  return p
}

/** Put an image the caller already decoded (e.g. right after an import) into the cache. */
export function seedLevelImage(sceneId: Id, assetId: Id, image: Promise<ImageBitmap> | ImageBitmap): void {
  cache.set(keyOf(sceneId, assetId), Promise.resolve(image))
}

/** Drop cached images of other scenes (called when a different document is opened). */
export function retainLevelImages(sceneId: Id): void {
  // Not closed: the engine may still hold the bitmap until it is told to drop the level image.
  for (const key of [...cache.keys()]) if (!key.startsWith(`${sceneId}/`)) cache.delete(key)
}

/** Pixels per cell used when a stored image is re-read for tracing (plenty for 1.25 ft floor cells). */
export const TRACE_PX_PER_CELL = 32

/** RGBA pixels of a decoded image at ≤ TRACE_PX_PER_CELL px per grid cell (for imageTrace). */
export function imagePixelsForTrace(image: ImageBitmap, rect: Rect, cellSize: number): TraceImage {
  const cellsX = Math.max(1, rect.w / cellSize)
  const cellsZ = Math.max(1, rect.d / cellSize)
  const scale = Math.min(1, (TRACE_PX_PER_CELL * cellsX) / image.width, (TRACE_PX_PER_CELL * cellsZ) / image.height)
  const width = Math.max(1, Math.round(image.width * scale))
  const height = Math.max(1, Math.round(image.height * scale))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) throw new Error("2D canvas unavailable")
  ctx.drawImage(image, 0, 0, width, height)
  return { width, height, data: ctx.getImageData(0, 0, width, height).data }
}
