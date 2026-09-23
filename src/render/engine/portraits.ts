/**
 * Token portraits (Token.imageUrl): images are loaded once per URL, cropped to a circle and packed into
 * one 2048² atlas texture (8×8 slots of 256 px) that every token instance samples through its
 * `aPortrait` attribute, so portraits never break token instancing. Slots are reused least-recently-used.
 * Loading is asynchronous; `onChange` fires when a portrait becomes available (the token layer then
 * rebuilds its instances). Failed URLs are remembered and not retried.
 */
import * as THREE from "three"

const SLOT_PX = 256
const GRID = 8
const SIZE = SLOT_PX * GRID

interface Slot {
  index: number
  url: string | null
  state: "loading" | "ready" | "error"
  lastUsed: number
}

/** Slot → atlas uv offset and scale (the portrait disc's uv spans one slot). */
export function slotUv(index: number): { u: number; v: number; scale: number } {
  const col = index % GRID
  const row = Math.floor(index / GRID)
  // flipY upload: canvas row 0 is at the top of the texture (v = 1).
  return { u: col / GRID, v: 1 - (row + 1) / GRID, scale: 1 / GRID }
}

export class PortraitAtlas {
  /** The atlas (null until the first portrait loaded: no 16 MB texture for scenes without images). */
  texture: THREE.Texture | null = null
  onChange: (() => void) | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private unavailable = false
  private readonly slots: Slot[] = []
  private readonly byUrl = new Map<string, Slot>()
  private readonly failed = new Set<string>()
  private tick = 0
  private disposed = false

  constructor() {
    for (let k = 0; k < GRID * GRID; k++) this.slots.push({ index: k, url: null, state: "error", lastUsed: -1 })
  }

  /** Canvas + texture on first use; false when there is no 2D canvas (tests, workers). */
  private ensureCanvas(): boolean {
    if (this.ctx) return true
    if (this.unavailable) return false
    try {
      const canvas = typeof document !== "undefined" ? document.createElement("canvas") : null
      if (canvas) {
        canvas.width = SIZE
        canvas.height = SIZE
        this.ctx = canvas.getContext("2d")
      }
      if (!canvas || !this.ctx) {
        this.unavailable = true
        return false
      }
      const t = new THREE.CanvasTexture(canvas)
      t.name = "atlas-token-portraits"
      t.colorSpace = THREE.SRGBColorSpace
      t.premultiplyAlpha = true
      t.generateMipmaps = true
      t.minFilter = THREE.LinearMipmapLinearFilter
      t.magFilter = THREE.LinearFilter
      t.anisotropy = 4
      this.texture = t
      return true
    } catch {
      this.unavailable = true
      return false
    }
  }

  /** Atlas uv of a loaded portrait, starting the load when needed; null until it is ready. */
  lookup(url: string | null): { u: number; v: number; scale: number } | null {
    if (!url || this.failed.has(url) || !this.ensureCanvas()) return null
    this.tick++
    const s = this.byUrl.get(url)
    if (s) {
      s.lastUsed = this.tick
      return s.state === "ready" ? slotUv(s.index) : null
    }
    this.load(url)
    return null
  }

  private load(url: string): void {
    const slot = this.slots.reduce((a, b) => (b.lastUsed < a.lastUsed ? b : a))
    if (slot.url) this.byUrl.delete(slot.url)
    slot.url = url
    slot.state = "loading"
    slot.lastUsed = this.tick
    this.byUrl.set(url, slot)
    const img = new Image()
    img.crossOrigin = "anonymous"
    // Third-party image hosts learn nothing about the page (a session URL, a room code) from the request.
    img.referrerPolicy = "no-referrer"
    img.decoding = "async"
    img.src = url
    img
      .decode()
      .then(() => {
        if (this.disposed || slot.url !== url) return
        this.draw(slot.index, img)
        slot.state = "ready"
        if (this.texture) this.texture.needsUpdate = true
        this.onChange?.()
      })
      .catch(() => {
        if (slot.url === url) {
          slot.state = "error"
          slot.url = null
          this.byUrl.delete(url)
        }
        this.failed.add(url)
      })
  }

  /** Circle-cropped, centre-cropped ("cover") portrait with a 3 px transparent margin. */
  private draw(index: number, img: HTMLImageElement): void {
    const ctx = this.ctx
    if (!ctx) return
    const x = (index % GRID) * SLOT_PX
    const y = Math.floor(index / GRID) * SLOT_PX
    ctx.clearRect(x, y, SLOT_PX, SLOT_PX)
    const w = img.naturalWidth || img.width
    const h = img.naturalHeight || img.height
    if (!(w > 0 && h > 0)) return
    const side = Math.min(w, h)
    const r = SLOT_PX / 2 - 3
    ctx.save()
    ctx.beginPath()
    ctx.arc(x + SLOT_PX / 2, y + SLOT_PX / 2, r, 0, Math.PI * 2)
    ctx.closePath()
    ctx.clip()
    ctx.imageSmoothingQuality = "high"
    ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, x + 3, y + 3, SLOT_PX - 6, SLOT_PX - 6)
    ctx.restore()
  }

  dispose(): void {
    this.disposed = true
    this.texture?.dispose()
  }
}
