/**
 * Player-side battlemap compositing (ARCHITECTURE §9).
 *
 * Players never receive a whole map image. For every level in `PlayerView.backdrops` this module keeps
 * one canvas (transparent where nothing was drawn) and, whenever the player's explored mask grows,
 * fetches the tiles of the newly explored cells from a `BackdropTileSource` (retrying with backoff while
 * the host is still publishing them), draws them, and reports what changed so the play page can call
 * `engine.setLevelImage(levelId, canvas, rect)` (first content, or a new canvas) /
 * `engine.updateLevelImage(levelId, dirtyRects)`.
 *
 * Canvas size: the scale (`pxPerCell`, a whole number of pixels per cell so cell edges land on whole
 * pixels) is fixed per layer from the FULL backdrop rect within the size budgets, but the canvas itself
 * only covers the explored part: the cell bounding box of the explored cells, expanded to 4×4-cell chunk
 * boundaries (net/assets/chunks.ts) and clipped to the backdrop rect. It is created on the first explored
 * cell and grows (by at least half its size per axis, copying the pixels already drawn at an integer
 * offset) when exploration leaves it; a grown canvas is announced with a new "set". It never shrinks
 * (a fog reset clears cells); a level whose explored cells all disappear loses its canvas ("remove").
 * `BackdropLayer.rect` is therefore the world rect of the canvas, a sub-rect of the backdrop.
 *
 * Change events carry `dirty` (the bounding box of everything drawn or cleared since the last event)
 * and `dirtyRects` (one rect per touched 4×4-cell chunk): the engine uploads the list region by region,
 * so exploring two distant spots never re-uploads everything between them.
 *
 * Another map (the view's scene.mapSerial changed) rebuilds every layer, also one whose level id and
 * placement did not change (a duplicated scene): the tile source keeps what the host announced, so the new
 * layer draws from the new map's chunks, never keeping the old map's pixels.
 *
 * Cells that stop being explored (DM fog reset) are cleared again. `refreshCells` redraws cells whose
 * tile changed (a partly explored cell the host re-cut with more of its sub-cells). Everything here is
 * main-thread canvas work but cheap: one `drawImage` of a ~140² bitmap per explored cell, coalesced into
 * one change event per level every `flushMs`.
 */
import type { Cell, Id, Rect } from "@/core/scene/types"
import { BACKDROP_CELL_EPS, backdropCellRange, type BackdropCellRange } from "@/core/session/backdrop"
import type { PlayerBackdrop, PlayerView } from "@/core/session/types"
import { cellTouched, decodeMask } from "@/core/vision/mask"
import type { CellMask, EncodedMask } from "@/core/vision/types"

import { chunkKey, TILE_CHUNK } from "../assets/chunks"
import type { BackdropTileSource } from "../assets/types"

/** What a level image is drawn into (both are valid `TexImageSource`s for the engine). */
export type BackdropCanvas = OffscreenCanvas | HTMLCanvasElement

/** Live description of one level's composited backdrop. */
export interface BackdropLayer {
  levelId: Id
  canvas: BackdropCanvas
  /**
   * World rect (feet) the canvas covers: the explored part of the backdrop rect (chunk-aligned, grown
   * as exploration spreads), so usually a sub-rect of the level's backdrop rect.
   */
  rect: Rect
  opacity: number
  tintWalls: boolean
  /** Tile edge length announced by the host. */
  tilePx: number
  /** Canvas pixels per grid cell (a whole number: tilePx, scaled down if the full backdrop would exceed the size budget). */
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
  /**
   * First content for a (new or grown) canvas: `engine.setLevelImage(levelId, layer.canvas, layer.rect)`.
   * `dirty` / `dirtyRects` describe what was drawn (informational: the whole canvas is uploaded).
   */
  | { kind: "set"; levelId: Id; layer: BackdropLayer; dirty: Rect; dirtyRects: Rect[] }
  /**
   * More tiles drawn / cleared: `engine.updateLevelImage(levelId, dirtyRects)` (world rects, one per
   * touched chunk). `dirty` is their bounding box (kept for older consumers).
   */
  | { kind: "update"; levelId: Id; layer: BackdropLayer; dirty: Rect; dirtyRects: Rect[] }
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
  /**
   * Pixel budget of a level's FULL backdrop (default 32 MP ≈ 128 MB RGBA): larger backdrops are scaled
   * down. Pass the engine's texel budget (`backdropTexelBudget(quality)`) so canvas and texture match.
   */
  maxCanvasPixels?: number
  /** Concurrent getTile() calls over all levels (default 6). */
  concurrency?: number
  /** Coalescing window for change events (default 50 ms: the first tiles show up quickly). */
  flushMs?: number
  /**
   * Coalescing window while more tiles are still on their way (default 250 ms). Each event means a
   * texture upload of the dirty rects, so bursts (a newly explored room) are batched harder.
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
export function backdropLayout(
  rect: Rect,
  cellSize: number,
  tilePx: number,
  maxSide = BACKDROP_DEFAULTS.maxCanvasSide,
  maxPixels = BACKDROP_DEFAULTS.maxCanvasPixels
): BackdropLayout {
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

/** Whole canvas pixels per cell for a backdrop (the layout's scale rounded down, at least 1). */
export function backdropPxPerCell(
  rect: Rect,
  cellSize: number,
  tilePx: number,
  maxSide = BACKDROP_DEFAULTS.maxCanvasSide,
  maxPixels = BACKDROP_DEFAULTS.maxCanvasPixels
): number {
  return Math.max(1, Math.floor(backdropLayout(rect, cellSize, tilePx, maxSide, maxPixels).pxPerCell + 1e-9))
}

/** Pixel rect of grid cell (i, j) in a canvas covering `rect` (edges rounded so neighbours abut exactly). */
export function cellPixelRect(
  i: number,
  j: number,
  cellSize: number,
  rect: Rect,
  width: number,
  height: number
): { x: number; y: number; w: number; h: number } {
  const sx = width / rect.w
  const sy = height / rect.d
  const x0 = Math.round((i * cellSize - rect.x) * sx)
  const x1 = Math.round(((i + 1) * cellSize - rect.x) * sx)
  const y0 = Math.round((j * cellSize - rect.z) * sy)
  const y1 = Math.round(((j + 1) * cellSize - rect.z) * sy)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * Cells (index j·maskWidth + i) of `explored` that the backdrop `rect` covers (`backdropCellRange`, the
 * host tiler's rule: exactly the cells it cuts tiles for) and that are touched (fully or partly
 * explored). The mask's own width/depth define the grid.
 */
export function exploredCellsInRect(explored: CellMask, cellSize: number, rect: Rect): Set<number> {
  const out = new Set<number>()
  const range = backdropCellRange(rect, { cellSize, width: explored.width, depth: explored.depth })
  if (!range) return out
  for (let j = range.j0; j <= range.j1; j++) {
    for (let i = range.i0; i <= range.i1; i++) {
      const k = j * explored.width + i
      if (cellTouched(explored, k)) out.add(k)
    }
  }
  return out
}

/**
 * One axis of a canvas cell range that has to cover [lo, hi] (inclusive): the union with the current
 * range, grown to at least 1.5× the current size in the direction(s) it grew, aligned to chunk
 * boundaries and clipped to [min, max].
 */
function growAxis(lo: number, hi: number, cur: [number, number] | null, min: number, max: number): [number, number] {
  let a = lo
  let b = hi
  if (cur) {
    a = Math.min(a, cur[0])
    b = Math.max(b, cur[1])
    const size = cur[1] - cur[0] + 1
    const grown = b - a + 1
    if (grown > size) {
      const extra = Math.ceil(size * 1.5) - grown
      if (extra > 0) {
        const low = a < cur[0]
        const high = b > cur[1]
        if (high && !low) b += extra
        else if (low && !high) a -= extra
        else {
          a -= Math.floor(extra / 2)
          b += Math.ceil(extra / 2)
        }
      }
    }
  }
  a = Math.floor(a / TILE_CHUNK) * TILE_CHUNK
  b = Math.ceil((b + 1) / TILE_CHUNK) * TILE_CHUNK - 1
  return [Math.max(min, a), Math.min(max, b)]
}

interface Bounds {
  x0: number
  z0: number
  x1: number
  z1: number
}

const boundsRect = (b: Bounds): Rect => ({ x: b.x0, z: b.z0, w: b.x1 - b.x0, d: b.z1 - b.z0 })

interface LayerState {
  levelId: Id
  /** Stable layout inputs (a different key rebuilds the layer). */
  key: string
  /** The map it shows (PlayerView scene.mapSerial, 0 for the first): part of the key. */
  map: number
  /** The backdrop rect (world feet). */
  backdrop: Rect
  cellSize: number
  /** Width / depth of the mask grid (cell index = j·gridW + i). */
  gridW: number
  gridD: number
  tilePx: number
  opacity: number
  tintWalls: boolean
  /** Whole canvas pixels per cell (fixed for the layer, except through setMaxCanvasPixels). */
  ppc: number
  /** Cells the backdrop overlaps (clamped to the grid): a canvas never extends beyond them. */
  limits: BackdropCellRange
  /** Cell (bi0, bj0)'s top-left corner is pixel (0, 0) of the layer's pixel space. */
  bi0: number
  bj0: number
  /** The backdrop rect in that pixel space (rounded): canvases are clipped to it. */
  clip: { x0: number; y0: number; x1: number; y1: number }
  canvas: BackdropCanvas | null
  ctx: Ctx2D | null
  /** Cells the canvas covers, its pixel origin in the layer's pixel space, and its world rect. */
  cells: BackdropCellRange | null
  px0: number
  py0: number
  width: number
  height: number
  rect: Rect | null
  alive: boolean
  announced: boolean
  /** Explored mask object last synced (identity fast path). */
  explored: EncodedMask | null
  wanted: Set<number>
  drawn: Set<number>
  queue: number[]
  queued: Set<number>
  inflight: Set<number>
  /** In flight while their tile changed: fetch again once the old one landed. */
  refetch: Set<number>
  attempts: Map<number, number>
  retryTimers: Map<number, unknown>
  missing: Set<number>
  /** Union of everything drawn / cleared since the last event (drives "set"/"update"). */
  dirty: Bounds | null
  /** The same per touched chunk (chunkKey → bounds). */
  dirtyChunks: Map<number, Bounds>
  /** Focus points (controlled tokens on this level) for fetch ordering. */
  focus: Array<{ x: number; z: number }>
}

/**
 * `map`: the view's map marker. Another map rebuilds the layer even when a level id and its placement are
 * the same (a duplicated scene): its cells are drawn afresh from the current tile entries, never kept
 * from the old map's image.
 */
function layoutKey(b: PlayerBackdrop, cellSize: number, gridW: number, gridD: number, ppc: number, map: number): string {
  return [b.rect.x, b.rect.z, b.rect.w, b.rect.d, b.tilePx, cellSize, gridW, gridD, ppc, map].join(",")
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
  private maxPixels: number
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
    const map = view.scene.mapSerial ?? 0

    for (const levelId of Object.keys(backdrops)) {
      const b = backdrops[levelId]
      if (!isUsableBackdrop(b)) continue
      const explored = Object.hasOwn(view.masks, levelId) ? view.masks[levelId].explored : null
      const gridW = explored?.width ?? grid.width
      const gridD = explored?.depth ?? grid.depth
      const ppc = backdropPxPerCell(b.rect, grid.cellSize, b.tilePx, this.maxSide, this.maxPixels)
      const key = layoutKey(b, grid.cellSize, gridW, gridD, ppc, map)
      let layer = this.byLevel.get(levelId)
      if (layer && layer.key !== key) {
        this.removeLayer(levelId)
        layer = undefined
      }
      if (!layer) {
        const created = this.createLayer(levelId, key, map, b, grid.cellSize, gridW, gridD, ppc)
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

  /**
   * The tiles of these cells changed (the host re-cut their chunk, e.g. a partly explored cell grew):
   * fetch and draw them again. The old pixels stay until the new tile lands on top of them.
   */
  refreshCells(levelId: Id, cells: readonly Cell[]): void {
    if (this.disposed) return
    const layer = this.byLevel.get(levelId)
    if (!layer) return
    const redo: number[] = []
    for (const c of cells) {
      if (!Number.isInteger(c.i) || !Number.isInteger(c.j) || c.i < 0 || c.j < 0 || c.i >= layer.gridW || c.j >= layer.gridD) continue
      const k = c.j * layer.gridW + c.i
      if (!layer.wanted.has(k)) continue
      if (layer.inflight.has(k)) layer.refetch.add(k)
      else if (layer.drawn.delete(k)) redo.push(k)
      // Queued or waiting for a retry: that fetch gets the new tile anyway.
    }
    if (redo.length === 0) return
    this.enqueue(layer, redo)
    this.pump()
  }

  /**
   * Change the pixel budget of a level's full backdrop (e.g. the engine's texel budget after a quality
   * change). Layers whose scale changes are redrawn scaled into a new canvas and announced again.
   */
  setMaxCanvasPixels(maxPixels: number): void {
    if (this.disposed || !(maxPixels > 0) || maxPixels === this.maxPixels) return
    this.maxPixels = maxPixels
    for (const layer of this.byLevel.values()) {
      const b: PlayerBackdrop = { rect: layer.backdrop, opacity: layer.opacity, tintWalls: layer.tintWalls, tilePx: layer.tilePx }
      const ppc = backdropPxPerCell(layer.backdrop, layer.cellSize, layer.tilePx, this.maxSide, this.maxPixels)
      if (ppc === layer.ppc) continue
      layer.key = layoutKey(b, layer.cellSize, layer.gridW, layer.gridD, ppc, layer.map)
      this.rescale(layer, ppc)
    }
  }

  layers(): BackdropLayer[] {
    return [...this.byLevel.values()].filter((l) => l.canvas !== null).map((l) => this.describe(l))
  }

  layer(levelId: Id): BackdropLayer | null {
    const l = this.byLevel.get(levelId)
    return l && l.canvas ? this.describe(l) : null
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
      canvas: l.canvas as BackdropCanvas,
      rect: l.rect ? { ...l.rect } : { x: 0, z: 0, w: 0, d: 0 },
      opacity: l.opacity,
      tintWalls: l.tintWalls,
      tilePx: l.tilePx,
      pxPerCell: l.ppc,
      announced: l.announced,
      stats: {
        wanted: l.wanted.size,
        drawn: l.drawn.size,
        pending: l.queued.size + l.inflight.size + l.retryTimers.size,
        missing: l.missing.size,
      },
    }
  }

  /**
   * Layer bookkeeping only: the canvas is created with the first explored cell. null when the backdrop
   * covers no grid cell (nothing could ever be drawn).
   */
  private createLayer(
    levelId: Id,
    key: string,
    map: number,
    b: PlayerBackdrop,
    cellSize: number,
    gridW: number,
    gridD: number,
    ppc: number
  ): LayerState | null {
    const r = b.rect
    const limits = backdropCellRange(r, { cellSize, width: gridW, depth: gridD })
    if (!limits) return null
    const bi0 = Math.floor(r.x / cellSize + BACKDROP_CELL_EPS)
    const bj0 = Math.floor(r.z / cellSize + BACKDROP_CELL_EPS)
    const layer: LayerState = {
      levelId,
      key,
      map,
      backdrop: { x: r.x, z: r.z, w: r.w, d: r.d },
      cellSize,
      gridW,
      gridD,
      tilePx: b.tilePx,
      opacity: b.opacity,
      tintWalls: b.tintWalls,
      ppc,
      limits,
      bi0,
      bj0,
      clip: { x0: 0, y0: 0, x1: 0, y1: 0 },
      canvas: null,
      ctx: null,
      cells: null,
      px0: 0,
      py0: 0,
      width: 0,
      height: 0,
      rect: null,
      alive: true,
      announced: false,
      explored: null,
      wanted: new Set(),
      drawn: new Set(),
      queue: [],
      queued: new Set(),
      inflight: new Set(),
      refetch: new Set(),
      attempts: new Map(),
      retryTimers: new Map(),
      missing: new Set(),
      dirty: null,
      dirtyChunks: new Map(),
      focus: [],
    }
    this.setScale(layer, ppc)
    this.byLevel.set(levelId, layer)
    return layer
  }

  /** Pixel-space constants of a layer at `ppc` pixels per cell. */
  private setScale(layer: LayerState, ppc: number): void {
    const cs = layer.cellSize
    const r = layer.backdrop
    const ox = layer.bi0 * cs
    const oz = layer.bj0 * cs
    layer.ppc = ppc
    layer.clip = {
      x0: Math.round(((r.x - ox) / cs) * ppc),
      y0: Math.round(((r.z - oz) / cs) * ppc),
      x1: Math.round(((r.x + r.w - ox) / cs) * ppc),
      y1: Math.round(((r.z + r.d - oz) / cs) * ppc),
    }
  }

  /** Pixel bounds (layer pixel space) and world rect of a canvas covering `cells`. */
  private canvasGeometry(layer: LayerState, cells: BackdropCellRange): { px0: number; py0: number; width: number; height: number; rect: Rect } {
    const ppc = layer.ppc
    const c = layer.clip
    const px0 = Math.max((cells.i0 - layer.bi0) * ppc, c.x0)
    const py0 = Math.max((cells.j0 - layer.bj0) * ppc, c.y0)
    const px1 = Math.max(px0 + 1, Math.min((cells.i1 + 1 - layer.bi0) * ppc, c.x1))
    const py1 = Math.max(py0 + 1, Math.min((cells.j1 + 1 - layer.bj0) * ppc, c.y1))
    const width = Math.min(this.maxSide, px1 - px0)
    const height = Math.min(this.maxSide, py1 - py0)
    const k = layer.cellSize / ppc
    return {
      px0,
      py0,
      width,
      height,
      rect: { x: layer.bi0 * layer.cellSize + px0 * k, z: layer.bj0 * layer.cellSize + py0 * k, w: width * k, d: height * k },
    }
  }

  private newCanvas(width: number, height: number): { canvas: BackdropCanvas; ctx: Ctx2D } | null {
    try {
      const canvas = this.createCanvas(width, height)
      const ctx = (canvas as unknown as { getContext(kind: "2d"): Ctx2D | null }).getContext("2d")
      if (!ctx) return null
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = "high"
      return { canvas, ctx }
    } catch (err) {
      console.error("[atlas backdrop] cannot create a canvas", err)
      return null
    }
  }

  private static release(canvas: BackdropCanvas): void {
    // Release the backing store now rather than whenever the engine lets go of the canvas.
    try {
      canvas.width = 0
      canvas.height = 0
    } catch {
      // detached/transferred canvases may refuse; nothing to free then
    }
  }

  /**
   * Make the canvas cover every wanted cell: create it (first explored cell) or grow it, copying what
   * was drawn at an integer pixel offset. false when no canvas could be created.
   */
  private ensureCanvas(layer: LayerState): boolean {
    let ci0 = Infinity
    let cj0 = Infinity
    let ci1 = -Infinity
    let cj1 = -Infinity
    for (const k of layer.wanted) {
      const i = k % layer.gridW
      const j = Math.floor(k / layer.gridW)
      if (i < ci0) ci0 = i
      if (i > ci1) ci1 = i
      if (j < cj0) cj0 = j
      if (j > cj1) cj1 = j
    }
    if (!Number.isFinite(ci0)) return layer.canvas !== null
    const cur = layer.cells
    if (cur && layer.canvas && ci0 >= cur.i0 && ci1 <= cur.i1 && cj0 >= cur.j0 && cj1 <= cur.j1) return true
    const lim = layer.limits
    const [i0, i1] = growAxis(ci0, ci1, cur ? [cur.i0, cur.i1] : null, lim.i0, lim.i1)
    const [j0, j1] = growAxis(cj0, cj1, cur ? [cur.j0, cur.j1] : null, lim.j0, lim.j1)
    const cells = { i0, j0, i1, j1 }
    const geo = this.canvasGeometry(layer, cells)
    const made = this.newCanvas(geo.width, geo.height)
    if (!made) return false
    const old = layer.canvas
    if (old && layer.drawn.size > 0) {
      try {
        made.ctx.drawImage(old as CanvasImageSource, layer.px0 - geo.px0, layer.py0 - geo.py0, layer.width, layer.height)
      } catch (err) {
        console.error("[atlas backdrop] copying the canvas failed", err)
      }
    }
    if (old) BackdropCompositor.release(old)
    this.install(layer, made, cells, geo)
    if (layer.announced) {
      // The engine held the old canvas: hand it the new one (everything drawn so far is in it).
      layer.dirty = null
      layer.dirtyChunks.clear()
      const rect = { ...geo.rect }
      this.emit({ kind: "set", levelId: layer.levelId, layer: this.describe(layer), dirty: rect, dirtyRects: [rect] })
    }
    return true
  }

  private install(
    layer: LayerState,
    made: { canvas: BackdropCanvas; ctx: Ctx2D },
    cells: BackdropCellRange,
    geo: { px0: number; py0: number; width: number; height: number; rect: Rect }
  ): void {
    layer.canvas = made.canvas
    layer.ctx = made.ctx
    layer.cells = cells
    layer.px0 = geo.px0
    layer.py0 = geo.py0
    layer.width = geo.width
    layer.height = geo.height
    layer.rect = geo.rect
  }

  /** A new pixel scale for a layer: redraw its canvas scaled into a new one and announce it. */
  private rescale(layer: LayerState, ppc: number): void {
    const old = layer.canvas
    const oldGeo = { px0: layer.px0, py0: layer.py0, width: layer.width, height: layer.height, ppc: layer.ppc }
    this.setScale(layer, ppc)
    if (!old || !layer.cells) return
    const geo = this.canvasGeometry(layer, layer.cells)
    const made = this.newCanvas(geo.width, geo.height)
    if (!made) {
      this.dropCanvas(layer)
      return
    }
    if (layer.drawn.size > 0) {
      const k = ppc / oldGeo.ppc
      try {
        made.ctx.drawImage(old as CanvasImageSource, oldGeo.px0 * k - geo.px0, oldGeo.py0 * k - geo.py0, oldGeo.width * k, oldGeo.height * k)
      } catch (err) {
        console.error("[atlas backdrop] rescaling the canvas failed", err)
      }
    }
    BackdropCompositor.release(old)
    this.install(layer, made, layer.cells, geo)
    if (layer.announced) {
      layer.dirty = null
      layer.dirtyChunks.clear()
      const rect = { ...geo.rect }
      this.emit({ kind: "set", levelId: layer.levelId, layer: this.describe(layer), dirty: rect, dirtyRects: [rect] })
    }
  }

  /** No explored cell left: release the canvas and tell the engine. */
  private dropCanvas(layer: LayerState): void {
    const canvas = layer.canvas
    const announced = layer.announced
    layer.canvas = null
    layer.ctx = null
    layer.cells = null
    layer.rect = null
    layer.width = layer.height = 0
    layer.announced = false
    layer.drawn.clear()
    layer.dirty = null
    layer.dirtyChunks.clear()
    if (canvas) BackdropCompositor.release(canvas)
    if (announced) this.emit({ kind: "remove", levelId: layer.levelId })
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
    if (layer.canvas) BackdropCompositor.release(layer.canvas)
    layer.canvas = null
    layer.ctx = null
  }

  private reconcileCells(layer: LayerState, explored: EncodedMask | null): void {
    let wanted: Set<number>
    try {
      wanted = explored ? exploredCellsInRect(decodeMask(explored), layer.cellSize, layer.backdrop) : new Set()
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
      layer.refetch.delete(k)
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
    if (wanted.size === 0) {
      // Nothing explored on this backdrop any more: no canvas (created again with the next cell).
      if (layer.canvas) this.dropCanvas(layer)
      return
    }
    if (added.length === 0) return
    if (!this.ensureCanvas(layer)) return
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
    const refetch = layer.refetch.delete(k)
    const current = layer.alive && !this.disposed && this.byLevel.get(layer.levelId) === layer
    if (!current || !layer.wanted.has(k) || !layer.canvas) {
      bitmap?.close()
      this.pump()
      return
    }
    if (bitmap) {
      this.drawCell(layer, k, bitmap)
      layer.attempts.delete(k)
      if (refetch) {
        // Its tile changed while this (older) one was on its way: fetch the new one too.
        layer.drawn.delete(k)
        this.enqueue(layer, [k])
      }
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
    const handle = this.clock.setTimeout(
      () => {
        layer.retryTimers.delete(k)
        if (!layer.alive || this.disposed || !layer.wanted.has(k)) return
        this.enqueue(layer, [k])
        this.pump()
      },
      this.retryDelays[attempt - 1]
    )
    layer.retryTimers.set(k, handle)
  }

  /** Cell k's pixel rect on the layer's canvas (whole pixels; may extend past a clipped canvas edge). */
  private cellRect(layer: LayerState, k: number) {
    const i = k % layer.gridW
    const j = Math.floor(k / layer.gridW)
    return { x: (i - layer.bi0) * layer.ppc - layer.px0, y: (j - layer.bj0) * layer.ppc - layer.py0, w: layer.ppc, h: layer.ppc }
  }

  private drawCell(layer: LayerState, k: number, bitmap: ImageBitmap): void {
    const r = this.cellRect(layer, k)
    try {
      layer.ctx!.clearRect(r.x, r.y, r.w, r.h)
      layer.ctx!.drawImage(bitmap, r.x, r.y, r.w, r.h)
      layer.drawn.add(k)
      this.markDirty(layer, k)
    } catch (err) {
      console.error("[atlas backdrop] drawImage failed", err)
    } finally {
      bitmap.close()
    }
  }

  private clearCell(layer: LayerState, k: number): void {
    if (!layer.ctx) return
    const r = this.cellRect(layer, k)
    layer.ctx.clearRect(r.x, r.y, r.w, r.h)
    this.markDirty(layer, k)
  }

  /** Grow the level's pending dirty region (and its chunk's) by cell k (world feet, clipped to the canvas rect). */
  private markDirty(layer: LayerState, k: number): void {
    const r = layer.rect
    if (!r) return
    const cs = layer.cellSize
    const i = k % layer.gridW
    const j = Math.floor(k / layer.gridW)
    const b: Bounds = {
      x0: Math.max(r.x, i * cs),
      z0: Math.max(r.z, j * cs),
      x1: Math.min(r.x + r.w, (i + 1) * cs),
      z1: Math.min(r.z + r.d, (j + 1) * cs),
    }
    if (!(b.x1 > b.x0 && b.z1 > b.z0)) return
    const grow = (d: Bounds | null | undefined): Bounds =>
      d ? { x0: Math.min(d.x0, b.x0), z0: Math.min(d.z0, b.z0), x1: Math.max(d.x1, b.x1), z1: Math.max(d.z1, b.z1) } : { ...b }
    layer.dirty = grow(layer.dirty)
    const ck = chunkKey(Math.floor(i / TILE_CHUNK), Math.floor(j / TILE_CHUNK))
    layer.dirtyChunks.set(ck, grow(layer.dirtyChunks.get(ck)))
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
      const dirty = boundsRect(d)
      const dirtyRects = [...layer.dirtyChunks.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => boundsRect(c))
      layer.dirtyChunks.clear()
      if (!layer.canvas) continue
      if (!layer.announced) {
        // Nothing to show until the first tile lands: announce with content, not an empty texture.
        if (layer.drawn.size === 0) continue
        layer.announced = true
        this.emit({ kind: "set", levelId: layer.levelId, layer: this.describe(layer), dirty, dirtyRects })
      } else {
        this.emit({ kind: "update", levelId: layer.levelId, layer: this.describe(layer), dirty, dirtyRects })
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
