/**
 * Token Maker editor state (ARCHITECTURE §11): the working design, the image blobs it uses, selection,
 * the active tool (move / paint the mask) and undo/redo.
 *
 * Designs are small immutable values, so history keeps whole snapshots (≤ 100). Commits sharing a
 * `coalesce` key within 800 ms (a drag, a slider, wheel zooming) make one undo step. Images are kept
 * for the whole session (undo may bring back a layer that used one); the draft store saves only the
 * ones the current design uses. Decoded bitmaps live in an ImageCache beside the store.
 */
import { nanoid } from "nanoid"
import { createStore, type StoreApi } from "zustand/vanilla"

import { addLayer, clampRadius, createLayer, emptyDesign, findLayer, layerIndex } from "@/core/tokenMaker/design"
import type { LayerRole, TokenDesign } from "@/core/tokenMaker/types"

import { alphaAt, alphaMap, decodeImage, type AlphaMap } from "./images"
import { clampView, DEFAULT_VIEW, type StageView } from "./view"

export interface StoredImage {
  blob: Blob
  width: number
  height: number
}

export type MakerTool = "move" | "reveal" | "hide"

export interface TokenMakerState {
  design: TokenDesign
  images: Record<string, StoredImage>
  selectedId: string | null
  tool: MakerTool
  /** Mask brush diameter, canvas units. */
  brush: number
  past: TokenDesign[]
  future: TokenDesign[]
  /** Layers with a long operation in flight (e.g. background removal), with its label. */
  working: Record<string, string>
  /** Bumps whenever a decoded image becomes available (the stage redraws). */
  decodedRev: number
  /** How the stage shows the token (zoom, pan). Not part of the design or its history. */
  view: StageView
}

export interface TokenMakerActions {
  /** Replace the design as one undo step (merged with the previous commit of the same `coalesce` key). */
  commit(next: TokenDesign, coalesce?: string): void
  undo(): void
  redo(): void
  select(id: string | null): void
  setTool(tool: MakerTool): void
  setBrush(size: number): void
  setRadius(radius: number, coalesce?: string): void
  /** Keep an image; returns its id. */
  addImage(image: StoredImage): string
  /** Add an image layer (on top, or at `index`) and select it; null when the design is full. */
  addImageLayer(image: StoredImage, name: string, role: LayerRole, index?: number): string | null
  addFillLayer(color: string, name: string, role: LayerRole, index?: number): string | null
  setWorking(layerId: string, label: string | null): void
  setView(view: StageView): void
  /** Start over from a design and its images (no history). */
  load(design: TokenDesign, images: Record<string, StoredImage>): void
}

export type TokenMakerStore = StoreApi<TokenMakerState & TokenMakerActions>

const HISTORY_LIMIT = 100
const COALESCE_MS = 800

export const newLayerId = () => nanoid(12)
const newImageId = () => nanoid(16)

/** A store and its image cache, made together (the cache tells this store when images decode). */
export function createTokenMaker(): { store: TokenMakerStore; cache: ImageCache } {
  const cache = new ImageCache()
  return { store: createTokenMakerStore(cache), cache }
}

export function createTokenMakerStore(cache: ImageCache): TokenMakerStore {
  let last: { key: string; at: number } | null = null

  const store = createStore<TokenMakerState & TokenMakerActions>()((set, get) => ({
    design: emptyDesign(),
    images: {},
    selectedId: null,
    tool: "move",
    brush: 0.06,
    past: [],
    future: [],
    working: {},
    decodedRev: 0,
    view: DEFAULT_VIEW,

    commit(next, coalesce) {
      const s = get()
      if (next === s.design) return
      const now = performance.now()
      const merge = coalesce !== undefined && last !== null && last.key === coalesce && now - last.at < COALESCE_MS && s.past.length > 0
      last = coalesce === undefined ? null : { key: coalesce, at: now }
      const past = merge ? s.past : [...s.past, s.design].slice(-HISTORY_LIMIT)
      const selectedId = s.selectedId !== null && layerIndex(next, s.selectedId) < 0 ? null : s.selectedId
      set({ design: next, past, future: [], selectedId })
    },
    undo() {
      const s = get()
      const prev = s.past[s.past.length - 1]
      if (!prev) return
      last = null
      set({ design: prev, past: s.past.slice(0, -1), future: [s.design, ...s.future], selectedId: findLayer(prev, s.selectedId)?.id ?? null })
    },
    redo() {
      const s = get()
      const next = s.future[0]
      if (!next) return
      last = null
      set({ design: next, past: [...s.past, s.design], future: s.future.slice(1), selectedId: findLayer(next, s.selectedId)?.id ?? null })
    },
    select(id) {
      set({ selectedId: id })
    },
    setTool(tool) {
      set({ tool })
    },
    setBrush(size) {
      set({ brush: Math.min(0.5, Math.max(0.005, size)) })
    },
    setRadius(radius, coalesce) {
      get().commit({ ...get().design, radius: clampRadius(radius) }, coalesce)
    },
    addImage(image) {
      const id = newImageId()
      set({ images: { ...get().images, [id]: image } })
      cache.put(id, image.blob)
      return id
    },
    addImageLayer(image, name, role, index) {
      const imageId = get().addImage(image)
      const layer = createLayer(newLayerId(), name, { type: "image", imageId, width: image.width, height: image.height }, role, get().design.radius)
      const next = addLayer(get().design, layer, index)
      if (next === get().design) return null
      get().commit(next)
      set({ selectedId: layer.id, tool: "move" })
      return layer.id
    },
    addFillLayer(color, name, role, index) {
      const layer = createLayer(newLayerId(), name, { type: "fill", color }, role, get().design.radius)
      const next = addLayer(get().design, layer, index)
      if (next === get().design) return null
      get().commit(next)
      set({ selectedId: layer.id, tool: "move" })
      return layer.id
    },
    setWorking(layerId, label) {
      const working = { ...get().working }
      if (label === null) delete working[layerId]
      else working[layerId] = label
      set({ working })
    },
    setView(view) {
      set({ view: clampView(view) })
    },
    load(design, images) {
      last = null
      for (const [id, img] of Object.entries(images)) cache.put(id, img.blob)
      set({ design, images, selectedId: null, tool: "move", past: [], future: [], working: {}, view: DEFAULT_VIEW })
    },
  }))

  cache.onDecoded = () => store.setState((s) => ({ decodedRev: s.decodedRev + 1 }))
  return store
}

// ---------------------------------------------------------------------------
// Decoded images
// ---------------------------------------------------------------------------

interface Entry {
  blob: Blob
  promise: Promise<ImageBitmap>
  bitmap: ImageBitmap | null
  alpha: AlphaMap | null
}

/** Decoded bitmaps (and small alpha maps for picking) per image id, decoded on first use. */
export class ImageCache {
  onDecoded: (() => void) | null = null
  private readonly blobs = new Map<string, Blob>()
  private readonly entries = new Map<string, Entry>()
  private disposed = false

  put(id: string, blob: Blob): void {
    if (this.blobs.get(id) === blob) return
    this.blobs.set(id, blob)
    this.entries.get(id)?.bitmap?.close()
    this.entries.delete(id)
  }

  private entry(id: string): Entry | null {
    const blob = this.blobs.get(id)
    if (!blob || this.disposed) return null
    let e = this.entries.get(id)
    if (!e || e.blob !== blob) {
      const entry: Entry = { blob, promise: decodeImage(blob), bitmap: null, alpha: null }
      entry.promise
        .then((bitmap) => {
          if (this.disposed || this.entries.get(id) !== entry) {
            bitmap.close()
            return
          }
          entry.bitmap = bitmap
          this.onDecoded?.()
        })
        .catch(() => {})
      this.entries.set(id, entry)
      e = entry
    }
    return e
  }

  /** The decoded image, starting the decode when needed (null until ready). */
  get(id: string): ImageBitmap | null {
    return this.entry(id)?.bitmap ?? null
  }

  /** The decoded image once ready. */
  ready(id: string): Promise<ImageBitmap> {
    const e = this.entry(id)
    return e ? e.promise : Promise.reject(new Error("That image is not available."))
  }

  /** Alpha (0..1) of an image at uv, or 1 while it is not decoded yet. */
  alphaAt(id: string, u: number, v: number): number {
    const e = this.entries.get(id)
    if (!e?.bitmap) return 1
    e.alpha ??= alphaMap(e.bitmap)
    return alphaAt(e.alpha, u, v)
  }

  dispose(): void {
    this.disposed = true
    for (const e of this.entries.values()) e.bitmap?.close()
    this.entries.clear()
    this.blobs.clear()
  }
}
