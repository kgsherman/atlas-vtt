/**
 * Frame opening detection (ARCHITECTURE §11): how big the hole in a ring / frame image is, so the token
 * disc (and every disc mask) can be fitted to it. Pure: works on RGBA pixels (ImageData.data).
 */

export interface FrameOpeningOptions {
  /** Alpha (0..1) from which a pixel counts as part of the ring. Default 0.5. */
  threshold?: number
  /** Rays cast from the centre. Default 72. */
  rays?: number
}

/**
 * The opening's radius as a fraction of the image WIDTH, measured from the image centre: the median
 * distance, over rays cast in every direction, to the first pixel at least `threshold` opaque. The
 * median ignores decorations (studs, gems) and gaps in the ring. null when the image has no opening
 * (opaque at the centre) or no ring around it (most rays leave the image without meeting one).
 */
export function detectFrameOpening(rgba: ArrayLike<number>, width: number, height: number, opts: FrameOpeningOptions = {}): number | null {
  if (width < 3 || height < 3 || rgba.length < width * height * 4) return null
  const threshold = Math.round((opts.threshold ?? 0.5) * 255)
  const rays = Math.max(8, opts.rays ?? 72)
  const cx = (width - 1) / 2
  const cy = (height - 1) / 2
  const alphaAt = (x: number, y: number) => rgba[(y * width + x) * 4 + 3]
  if (alphaAt(Math.round(cx), Math.round(cy)) >= threshold) return null

  const maxR = Math.hypot(width, height) / 2
  const hits: number[] = []
  for (let k = 0; k < rays; k++) {
    const a = (k / rays) * Math.PI * 2
    const dx = Math.cos(a)
    const dy = Math.sin(a)
    for (let r = 1; r <= maxR; r += 0.5) {
      const x = Math.round(cx + dx * r)
      const y = Math.round(cy + dy * r)
      if (x < 0 || y < 0 || x >= width || y >= height) break
      if (alphaAt(x, y) >= threshold) {
        hits.push(r)
        break
      }
    }
  }
  // A ring stops most rays; a few may slip through gaps in it.
  if (hits.length < rays * 0.6) return null
  hits.sort((a, b) => a - b)
  const mid = hits.length >> 1
  const median = hits.length % 2 ? hits[mid] : (hits[mid - 1] + hits[mid]) / 2
  return median / width
}
