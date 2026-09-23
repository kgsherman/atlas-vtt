/**
 * Player-side battlemap compositing (ARCHITECTURE §9).
 *
 * Players never receive a whole map image. For every level in `PlayerView.backdrops` this module keeps
 * one canvas covering the backdrop rect (`cellsX·pxPerCell × cellsZ·pxPerCell`, transparent where
 * nothing was drawn) and, whenever the player's explored mask grows, fetches the tiles of the newly
 * explored cells from a `BackdropTileSource` (retrying with backoff while the host is still
 * publishing them), draws them, and reports what changed so the play page can call
 * `engine.setLevelImage(levelId, canvas, rect)` (first content) / `engine.updateLevelImage(levelId, dirty)`.
 *
 * Cells that stop being explored (DM fog reset) are cleared again. Everything here is main-thread
 * canvas work but cheap: one `drawImage` of a ~140² bitmap per explored cell, coalesced into one
 * change event per level every `flushMs`.
 */
import type { Id, Rect } from "@/core/scene/types"
import type { PlayerBackdrop, PlayerView } from "@/core/session/types"
import { cellTouched, decodeMask } from "@/core/vision/mask"
import type { CellMask, EncodedMask } from "@/core/vision/types"

import type { BackdropTileSource } from "../assets/types"

/** What a level image is drawn into (both are valid `TexImageSource`s for the engine). */
export type BackdropCanvas = OffscreenCanvas | HTMLCanvasElement

/** Live description of one level's composited backdrop. */
export interface BackdropLayer {
  levelId: Id
  canvas: BackdropCanvas
  /** World rect (feet) the canvas covers: the backdrop rect. */
  rect: Rect
  opacity: number
  tintWalls: boolean
  /** Tile edge length announced by the host. */
  tilePx: number
  /** Canvas pixels per grid cell (tilePx, scaled down if the canvas would exceed the size budget). */
  pxPerCell: number
  /** True once the layer has been announced with a "set" event (the engine holds the canvas). */
  announced: boolean
  stats: BackdropStats
}

export interface BackdropStats {
  /** Explored cells overlapping the rect. */
  wanted: number
  drawn: number
  /** Queued, in flight or waiting for a retry. */
  pending: number
  /** Gave up after all retries (retried again when exploration grows or on retryMissing()). */
  missing: number
}

export type BackdropEvent =
  /** First content for a (new) canvas: `engine.setLevelImage(levelId, layer.canvas, layer.rect)`. */
  | { kind: "set"; levelId: Id; layer: BackdropLayer; dirty: Rect }
  /** More tiles drawn / cleared: `engine.updateLevelImage(levelId, dirty)` (world rect). */
  | { kind: "update"; levelId: Id; layer: BackdropLayer; dirty: Rect }
  /** The level lost its backdrop (or its canvas was replaced): `engine.setLevelImage(levelId, null, null)`. */
  | { kind: "remove"; levelId: Id }

export interface CompositorClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const defaultClock: CompositorClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface BackdropCompositorOptions {
  tiles: BackdropTileSource
  onEvent: (ev: BackdropEvent) => void
  /** Canvas factory (default: OffscreenCanvas, else a detached <canvas>). */
  createCanvas?: (width: number, height: number) => BackdropCanvas
  /** Longest canvas side in pixels (default 8192, the common WebGL max texture size). */
  maxCanvasSide?: number
  /** Canvas pixel budget per level (default 32 MP ≈ 128 MB RGBA). Larger backdrops are scaled down. */
  maxCanvasPixels?: number
  /** Concurrent getTile() calls over all levels (default 6). */
  concurrency?: number
  /** Coalescing window for change events (default 50 ms: the first tiles show up quickly). */
  flushMs?: number
  /**
   * Coalescing window while more tiles are still on their way (default 250 ms). Each event means a
   * texture upload of the dirty rect, so bursts (a newly explored room) are batched harder.
   */
  busyFlushMs?: number
  /** Delays between attempts for a tile the source does not have yet (default 0.3 s … 15 s, 7 retries). */
  retryDelaysMs?: readonly number[]
  clock?: CompositorClock
}

export const BACKDROP_DEFAULTS = {
  maxCanvasSide: 8192,
  maxCanvasPixels: 32 * 1024 * 1024,
  concurrency: 6,
  flushMs: 50,
  busyFlushMs: 250,
  retryDelaysMs: [300, 800, 1500, 3000, 5000, 10_000, 15_000] as readonly number[],
}

interface Ctx2D {
  clearRect(x: number, y: number, w: number, h: number): void
  drawImage(image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: ImageSmoothingQuality
}

function defaultCreateCanvas(width: number, height: number): BackdropCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height)
  if (typeof document !== "undefined") {
    const c = document.createElement("canvas")
    c.width = width
    c.height = height
    return c
  }
  throw new Error("backdrop compositing needs OffscreenCanvas or a DOM")
}

/** Canvas layout of a backdrop: pixel size and the world → pixel mapping. */
export interface BackdropLayout {
  width: number
  height: number
  pxPerCell: number
}

/** Size of the canvas for a backdrop rect at `tilePx` per cell, within the side and pixel budgets. */
export function backdropLayout(rect: Rect, cellSize: number, tilePx: number, maxSide = BACKDROP_DEFAULTS.maxCanvasSide, maxPixels = BACKDROP_DEFAULTS.maxCanvasPixels): BackdropLayout {
  const fullW = (rect.w / cellSize) * tilePx
  const fullH = (rect.d / cellSize) * tilePx
  let scale = 1
  if (fullW > 0 && fullH > 0) scale = Math.min(1, maxSide / Math.max(fullW, fullH), Math.sqrt(maxPixels / (fullW * fullH)))
  return {
    width: Math.max(1, Math.min(maxSide, Math.round(fullW * scale))),
    height: Math.max(1, Math.min(maxSide, Math.round(fullH * scale))),
    pxPerCell: tilePx * scale,
  }
}

/** Pixel rect of grid cell (i, j) in a canvas covering `rect` (edges rounded so neighbours abut exactly). */
export function cellPixelRect(i: number, j: number, cellSize: number, rect: Rect, width: number, height: number): { x: number; y: number; w: number; h: number } {
  const sx = width / rect.w
  const sy = height / rect.d
  const x0 = Math.round((i * cellSize - rect.x) * sx)
  const x1 = Math.round(((i + 1) * cellSize - rect.x) * sx)
  const y0 = Math.round((j * cellSize - rect.z) * sy)
  const y1 = Math.round(((j + 1) * cellSize - rect.z) * sy)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * Cells (index j·maskWidth + i) of `explored` that overlap `rect` with positive area and are touched
 * (fully or partly explored). The mask's own width/depth define the grid.
 */
export function exploredCellsInRect(explored: CellMask, cellSize: number, rect: Rect): Set<number> {
  const out = new Set<number>()
  if (!(rect.w > 0 && rect.d > 0)) return out
  const i0 = Math.max(0, Math.floor(rect.x / cellSize))
  const i1 = Math.min(explored.width, Math.ceil((rect.x + rect.w) / cellSize))
  const j0 = Math.max(0, Math.floor(rect.z / cellSize))
  const j1 = Math.min(explored.depth, Math.ceil((rect.z + rect.d) / cellSize))
  for (let j = j0; j < j1; j++) {
    if (!((j + 1) * cellSize > rect.z && j * cellSize < rect.z + rect.d)) continue
    for (let i = i0; i < i1; i++) {
      if (!((i + 1) * cellSize > rect.x && i * cellSize < rect.x + rect.w)) continue
      const k = j * explored.width + i
      if (cellTouched(explored, k)) out.add(k)
    }
  }
  return out
}

interface Bounds {
  x0: number
  z0: number
  x1: number
  z1: number
}

interface LayerState {
  levelId: Id
  key: string
  rect: Rect
  cellSize: number
  /** Width of the mask grid (cell index = j·gridW + i). */
  gridW: number
  tilePx: number
  opacity: number
  tintWalls: boolean
  layout: BackdropLayout
  canvas: BackdropCanvas
  ctx: Ctx2D
  alive: boolean
  announced: boolean
  /** Explored mask object last synced (identity fast path). */
  explored: EncodedMask | null
  wanted: Set<number>
  drawn: Set<number>
  queue: number[]
  queued: Set<number>
  inflight: Set<number>
  attempts: Map<number, number>
  retryTimers: Map<number, unknown>
  missing: Set<number>
  dirty: Bounds | null
  /** Focus points (controlled tokens on this level) for fetch ordering. */
  focus: Array<{ x: number; z: number }>
}

function layoutKey(b: PlayerBackdrop, cellSize: number, gridW: number, gridD: number, layout: BackdropLayout): string {
  return [b.rect.x, b.rect.z, b.rect.w, b.rect.d, b.tilePx, cellSize, gridW, gridD, layout.width, layout.height].join(",")
}

function isUsableBackdrop(b: PlayerBackdrop | undefined): b is PlayerBackdrop {
  return (
    !!b &&
    typeof b === "object" &&
    !!b.rect &&
    [b.rect.x, b.rect.z, b.rect.w, b.rect.d, b.tilePx].every((n) => typeof n === "number" && Number.isFinite(n)) &&
    b.rect.w > 0 &&
    b.rect.d > 0 &&
    b.tilePx > 0
  )
}

/**
 * Keeps one composited canvas per backdrop level in sync with a PlayerView (see module doc).
 * Call `sync(view)` after every view change; `dispose()` when done.
 */
export class BackdropCompositor {
  private readonly tiles: BackdropTileSource
  private readonly onEvent: (ev: BackdropEvent) => void
  private readonly createCanvas: (width: number, height: number) => BackdropCanvas
  private readonly maxSide: number
  private readonly maxPixels: number
  private readonly concurrency: number
  private readonly flushMs: number
  private readonly busyFlushMs: number
  private readonly retryDelays: readonly number[]
  private readonly clock: CompositorClock
  private readonly byLevel = new Map<Id, LayerState>()
  private active = 0
  private flushTimer: unknown = null
  private disposed = false
  /** Focus per level from the last view (controlled tokens). */
  private focus = new Map<Id, Array<{ x: number; z: number }>>()

  constructor(opts: BackdropCompositorOptions) {
    this.tiles = opts.tiles
    this.onEvent = opts.onEvent
    this.createCanvas = opts.createCanvas ?? defaultCreateCanvas
    this.maxSide = opts.maxCanvasSide ?? BACKDROP_DEFAULTS.maxCanvasSide
    this.maxPixels = opts.maxCanvasPixels ?? BACKDROP_DEFAULTS.maxCanvasPixels
    this.concurrency = Math.max(1, opts.concurrency ?? BACKDROP_DEFAULTS.concurrency)
    this.flushMs = opts.flushMs ?? BACKDROP_DEFAULTS.flushMs
    this.busyFlushMs = Math.max(this.flushMs, opts.busyFlushMs ?? BACKDROP_DEFAULTS.busyFlushMs)
    this.retryDelays = opts.retryDelaysMs ?? BACKDROP_DEFAULTS.retryDelaysMs
    this.clock = opts.clock ?? defaultClock
  }

  /** Reconcile layers with `view.backdrops` and the explored masks. */
  sync(view: PlayerView | null): void {
    if (this.disposed) return
    const backdrops = view?.backdrops ?? {}
    const grid = view?.scene.grid
    this.focus = view ? focusPoints(view) : new Map()

    for (const levelId of [...this.byLevel.keys()]) {
      if (!view || !Object.hasOwn(backdrops, levelId) || !isUsableBackdrop(backdrops[levelId])) this.removeLayer(levelId)
    }
    if (!view || !grid) return

    for (const levelId of Object.keys(backdrops)) {
      const b = backdrops[levelId]
      if (!isUsableBackdrop(b)) continue
      const explored = Object.hasOwn(view.masks, levelId) ? view.masks[levelId].explored : null
      const gridW = explored?.width ?? grid.width
      const gridD = explored?.depth ?? grid.depth
      const layout = backdropLayout(b.rect, grid.cellSize, b.tilePx, this.maxSide, this.maxPixels)
      const key = layoutKey(b, grid.cellSize, gridW, gridD, layout)
      let layer = this.byLevel.get(levelId)
      if (layer && layer.key !== key) {
        this.removeLayer(levelId)
        layer = undefined
      }
      if (!layer) {
        const created = this.createLayer(levelId, key, b, grid.cellSize, gridW, layout)
        if (!created) continue
        layer = created
      }
      layer.opacity = b.opacity
      layer.tintWalls = b.tintWalls
      layer.focus = this.focus.get(levelId) ?? []
      if (explored !== layer.explored) {
        layer.explored = explored
        this.reconcileCells(layer, explored)
      }
    }
    this.pump()
  }

  /**
   * Retry now every tile not drawn yet — given up on, or waiting for a retry (the host came back, or
   * announced new tile chunks). `levelId` limits it to one level.
   */
  retryMissing(levelId?: Id): void {
    if (this.disposed) return
    for (const layer of this.byLevel.values()) {
      if (levelId !== undefined && layer.levelId !== levelId) continue
      const cells = [...layer.missing, ...layer.retryTimers.keys()]
      if (cells.length === 0) continue
      for (const h of layer.retryTimers.values()) this.clock.clearTimeout(h)
      layer.retryTimers.clear()
      layer.missing.clear()
      for (const k of cells) layer.attempts.delete(k)
      this.enqueue(layer, cells)
    }
    this.pump()
  }

  layers(): BackdropLayer[] {
    return [...this.byLevel.values()].map((l) => this.describe(l))
  }

  layer(levelId: Id): BackdropLayer | null {
    const l = this.byLevel.get(levelId)
    return l ? this.describe(l) : null
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.flushTimer !== null) this.clock.clearTimeout(this.flushTimer)
    this.flushTimer = null
    for (const levelId of [...this.byLevel.keys()]) this.dropLayer(levelId)
  }

  // -------------------------------------------------------------------------

  private describe(l: LayerState): BackdropLayer {
    return {
      levelId: l.levelId,
      canvas: l.canvas,
      rect: { ...l.rect },
      opacity: l.opacity,
      tintWalls: l.tintWalls,
      tilePx: l.tilePx,
      pxPerCell: l.layout.pxPerCell,
      announced: l.announced,
      stats: {
        wanted: l.wanted.size,
        drawn: l.drawn.size,
        pending: l.queued.size + l.inflight.size + l.retryTimers.size,
        missing: l.missing.size,
      },
    }
  }

  private createLayer(levelId: Id, key: string, b: PlayerBackdrop, cellSize: number, gridW: number, layout: BackdropLayout): LayerState | null {
    let canvas: BackdropCanvas
    let ctx: Ctx2D | null
    try {
      canvas = this.createCanvas(layout.width, layout.height)
      ctx = (canvas as unknown as { getContext(kind: "2d"): Ctx2D | null }).getContext("2d")
    } catch (err) {
      console.error("[atlas backdrop] cannot create a canvas", err)
      return null
    }
    if (!ctx) return null
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = "high"
    const layer: LayerState = {
      levelId,
      key,
      rect: { ...b.rect },
      cellSize,
      gridW,
      tilePx: b.tilePx,
      opacity: b.opacity,
      tintWalls: b.tintWalls,
      layout,
      canvas,
      ctx,
      alive: true,
      announced: false,
      explored: null,
      wanted: new Set(),
      drawn: new Set(),
      queue: [],
      queued: new Set(),
      inflight: new Set(),
      attempts: new Map(),
      retryTimers: new Map(),
      missing: new Set(),
      dirty: null,
      focus: [],
    }
    this.byLevel.set(levelId, layer)
    return layer
  }

  /** Remove a layer and tell the engine (if it was announced). */
  private removeLayer(levelId: Id): void {
    const announced = this.byLevel.get(levelId)?.announced ?? false
    this.dropLayer(levelId)
    if (announced) this.emit({ kind: "remove", levelId })
  }

  private dropLayer(levelId: Id): void {
    const layer = this.byLevel.get(levelId)
    if (!layer) return
    layer.alive = false
    for (const h of layer.retryTimers.values()) this.clock.clearTimeout(h)
    layer.retryTimers.clear()
    layer.queue = []
    layer.queued.clear()
    this.byLevel.delete(levelId)
    // Release the backing store now rather than whenever the engine lets go of the canvas.
    try {
      layer.canvas.width = 0
      layer.canvas.height = 0
    } catch {
      // detached/transferred canvases may refuse; nothing to free then
    }
  }

  private reconcileCells(layer: LayerState, explored: EncodedMask | null): void {
    let wanted: Set<number>
    try {
      wanted = explored ? exploredCellsInRect(decodeMask(explored), layer.cellSize, layer.rect) : new Set()
    } catch (err) {
      console.error("[atlas backdrop] bad explored mask", err)
      return
    }
    // Cells no longer explored (fog reset): clear them and forget any work for them.
    for (const k of layer.wanted) {
      if (wanted.has(k)) continue
      if (layer.drawn.delete(k)) this.clearCell(layer, k)
      layer.queued.delete(k)
      layer.missing.delete(k)
      layer.attempts.delete(k)
      const t = layer.retryTimers.get(k)
      if (t !== undefined) {
        this.clock.clearTimeout(t)
        layer.retryTimers.delete(k)
      }
    }
    if (layer.queue.length && layer.queued.size !== layer.queue.length) layer.queue = layer.queue.filter((k) => layer.queued.has(k))
    const added: number[] = []
    for (const k of wanted) {
      if (!layer.wanted.has(k)) added.push(k)
    }
    layer.wanted = wanted
    if (added.length === 0) return
    // New exploration: the host is publishing again, so earlier give-ups get another chance.
    if (layer.missing.size) {
      for (const k of layer.missing) {
        layer.attempts.delete(k)
        added.push(k)
      }
      layer.missing.clear()
    }
    this.enqueue(layer, added)
  }

  private enqueue(layer: LayerState, cells: number[]): void {
    let changed = false
    for (const k of cells) {
      if (layer.drawn.has(k) || layer.queued.has(k) || layer.inflight.has(k) || layer.retryTimers.has(k)) continue
      layer.queued.add(k)
      layer.queue.push(k)
      changed = true
    }
    if (changed) this.sortQueue(layer)
  }

  /** Nearest-first to the player's tokens on this level (row-major otherwise). */
  private sortQueue(layer: LayerState): void {
    const focus = layer.focus
    const w = layer.gridW
    const cs = layer.cellSize
    if (focus.length === 0) {
      layer.queue.sort((a, b) => a - b)
      return
    }
    const dist = new Map<number, number>()
    for (const k of layer.queue) {
      const cx = ((k % w) + 0.5) * cs
      const cz = (Math.floor(k / w) + 0.5) * cs
      let best = Infinity
      for (const p of focus) best = Math.min(best, (p.x - cx) ** 2 + (p.z - cz) ** 2)
      dist.set(k, best)
    }
    layer.queue.sort((a, b) => (dist.get(a) ?? 0) - (dist.get(b) ?? 0) || a - b)
  }

  private nextJob(): { layer: LayerState; k: number } | null {
    // Levels holding the player's tokens first.
    let fallback: LayerState | null = null
    for (const layer of this.byLevel.values()) {
      if (layer.queue.length === 0) continue
      if (layer.focus.length > 0) return { layer, k: this.shift(layer) }
      fallback ??= layer
    }
    return fallback ? { layer: fallback, k: this.shift(fallback) } : null
  }

  private shift(layer: LayerState): number {
    const k = layer.queue.shift() as number
    layer.queued.delete(k)
    return k
  }

  private pump(): void {
    while (!this.disposed && this.active < this.concurrency) {
      const job = this.nextJob()
      if (!job) return
      this.fetch(job.layer, job.k)
    }
  }

  private fetch(layer: LayerState, k: number): void {
    const i = k % layer.gridW
    const j = Math.floor(k / layer.gridW)
    layer.inflight.add(k)
    this.active++
    let request: Promise<ImageBitmap | null>
    try {
      request = this.tiles.getTile(layer.levelId, { i, j })
    } catch (err) {
      request = Promise.reject(err)
    }
    request.then(
      (bitmap) => this.finish(layer, k, bitmap),
      (err: unknown) => {
        console.warn(`[atlas backdrop] tile ${layer.levelId} ${i},${j} failed`, err)
        this.finish(layer, k, null)
      }
    )
  }

  private finish(layer: LayerState, k: number, bitmap: ImageBitmap | null): void {
    this.active--
    layer.inflight.delete(k)
    const current = layer.alive && !this.disposed && this.byLevel.get(layer.levelId) === layer
    if (!current || !layer.wanted.has(k)) {
      bitmap?.close()
      this.pump()
      return
    }
    if (bitmap) {
      this.drawCell(layer, k, bitmap)
      layer.attempts.delete(k)
    } else {
      this.scheduleRetry(layer, k)
    }
    this.pump()
  }

  private scheduleRetry(layer: LayerState, k: number): void {
    const attempt = (layer.attempts.get(k) ?? 0) + 1
    layer.attempts.set(k, attempt)
    if (attempt > this.retryDelays.length) {
      layer.missing.add(k)
      return
    }
    const handle = this.clock.setTimeout(() => {
      layer.retryTimers.delete(k)
      if (!layer.alive || this.disposed || !layer.wanted.has(k)) return
      this.enqueue(layer, [k])
      this.pump()
    }, this.retryDelays[attempt - 1])
    layer.retryTimers.set(k, handle)
  }

  private cellRect(layer: LayerState, k: number) {
    return cellPixelRect(k % layer.gridW, Math.floor(k / layer.gridW), layer.cellSize, layer.rect, layer.layout.width, layer.layout.height)
  }

  private drawCell(layer: LayerState, k: number, bitmap: ImageBitmap): void {
    const r = this.cellRect(layer, k)
    try {
      layer.ctx.clearRect(r.x, r.y, r.w, r.h)
      layer.ctx.drawImage(bitmap, r.x, r.y, r.w, r.h)
      layer.drawn.add(k)
      this.markDirty(layer, k)
    } catch (err) {
      console.error("[atlas backdrop] drawImage failed", err)
    } finally {
      bitmap.close()
    }
  }

  private clearCell(layer: LayerState, k: number): void {
    const r = this.cellRect(layer, k)
    layer.ctx.clearRect(r.x, r.y, r.w, r.h)
    this.markDirty(layer, k)
  }

  /** Grow the level's pending dirty region by cell k (world feet, clipped to the rect). */
  private markDirty(layer: LayerState, k: number): void {
    const cs = layer.cellSize
    const i = k % layer.gridW
    const j = Math.floor(k / layer.gridW)
    const r = layer.rect
    const b: Bounds = {
      x0: Math.max(r.x, i * cs),
      z0: Math.max(r.z, j * cs),
      x1: Math.min(r.x + r.w, (i + 1) * cs),
      z1: Math.min(r.z + r.d, (j + 1) * cs),
    }
    const d = layer.dirty
    layer.dirty = d ? { x0: Math.min(d.x0, b.x0), z0: Math.min(d.z0, b.z0), x1: Math.max(d.x1, b.x1), z1: Math.max(d.z1, b.z1) } : b
    if (this.flushTimer === null) {
      // First content fast; later batches wait longer while the burst is still arriving.
      const busy = layer.announced && (layer.queue.length > 0 || layer.inflight.size > 0)
      this.flushTimer = this.clock.setTimeout(() => this.flush(), busy ? this.busyFlushMs : this.flushMs)
    }
  }

  /** Emit the coalesced changes (also callable directly, e.g. by tests). */
  flush(): void {
    if (this.flushTimer !== null) this.clock.clearTimeout(this.flushTimer)
    this.flushTimer = null
    if (this.disposed) return
    for (const layer of this.byLevel.values()) {
      const d = layer.dirty
      if (!d) continue
      layer.dirty = null
      const dirty: Rect = { x: d.x0, z: d.z0, w: d.x1 - d.x0, d: d.z1 - d.z0 }
      if (!layer.announced) {
        // Nothing to show until the first tile lands: announce with content, not an empty texture.
        if (layer.drawn.size === 0) continue
        layer.announced = true
        this.emit({ kind: "set", levelId: layer.levelId, layer: this.describe(layer), dirty })
      } else {
        this.emit({ kind: "update", levelId: layer.levelId, layer: this.describe(layer), dirty })
      }
    }
  }

  private emit(ev: BackdropEvent): void {
    try {
      this.onEvent(ev)
    } catch (err) {
      console.error("[atlas backdrop] listener failed", err)
    }
  }
}

/** Controlled + vision tokens' positions per level (fetch ordering). */
function focusPoints(view: PlayerView): Map<Id, Array<{ x: number; z: number }>> {
  const out = new Map<Id, Array<{ x: number; z: number }>>()
  for (const id of new Set([...view.controlledTokenIds, ...view.visionTokenIds])) {
    const t = Object.hasOwn(view.tokens, id) ? view.tokens[id] : undefined
    if (!t) continue
    const list = out.get(t.levelId) ?? []
    list.push({ x: t.position.x, z: t.position.z })
    out.set(t.levelId, list)
  }
  return out
}
