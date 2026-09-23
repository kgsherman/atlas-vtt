/**
 * Backdrop tiles (ARCHITECTURE §9 "Players never receive a whole image").
 *
 * Tile geometry (shared by the host that cuts tiles and the player that composites them): tile (i, j)
 * is the part of the level's backdrop image covering grid cell (i, j) — world
 * [i·s, (i+1)·s) × [j·s, (j+1)·s) — resampled to `tilePx` × `tilePx` (tilePx = stored px per cell,
 * PlayerBackdrop.tilePx). Parts of the cell outside the image are transparent. A player's per-level
 * canvas covers the backdrop rect at tilePx per cell, so tile (i, j) lands at
 * ((i·s − rect.x) / s · tilePx, (j·s − rect.z) / s · tilePx).
 *
 * Host side (sessions): net/host/tiles.ts uploads per-player chunks of explored cells (./chunks.ts).
 * createBackdropPublisher here is the superseded per-cell publisher (publishTiles + grantTiles), kept
 * for its tests. Player side: createTileSource fetches one tile (Supabase: cropped from the player's
 * own chunk once the host announced it; local mode: cropped from the locally stored image — dev only,
 * NOT a security boundary). The player client composites fetched tiles into per-level canvases for
 * Engine.setLevelImage / updateLevelImage (net/player/backdropCanvas.ts).
 */
import type { Cell, GridSettings, Id, Rect, Scene } from "@/core/scene/types"
import { playerBackdrop } from "@/core/session/filter"
import { cellTouched, decodeMask } from "@/core/vision/mask"
import type { EncodedMask } from "@/core/vision/types"

import type { LocalStore } from "../localStore"
import type { AtlasClient } from "../supabase"
import { canvasToBlob, context2d, makeCanvas } from "./import"
import { readLocalAsset } from "./localAssets"
import { chunkKey, chunkOfCell, TILE_CHUNK } from "./chunks"
import { downloadChunk } from "./supabaseAssets"
import type { AssetStore, BackdropTileSource } from "./types"

// ---------------------------------------------------------------------------
// Geometry (pure)
// ---------------------------------------------------------------------------

/** Grid cells a backdrop rect overlaps with positive area (clamped to the grid). */
export function backdropCells(rect: Rect, grid: Pick<GridSettings, "cellSize" | "width" | "depth">): Cell[] {
  const s = grid.cellSize
  const eps = 1e-9
  const i0 = Math.max(0, Math.floor(rect.x / s + eps))
  const i1 = Math.min(grid.width - 1, Math.ceil((rect.x + rect.w) / s - eps) - 1)
  const j0 = Math.max(0, Math.floor(rect.z / s + eps))
  const j1 = Math.min(grid.depth - 1, Math.ceil((rect.z + rect.d) / s - eps) - 1)
  const out: Cell[] = []
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) out.push({ i, j })
  return out
}

/** Source rect (image px, may extend beyond the image) of tile (i, j). */
export function tileSourceRect(rect: Rect, image: { width: number; height: number }, cellSize: number, cell: Cell): { sx: number; sy: number; sw: number; sh: number } {
  const kx = image.width / rect.w
  const kz = image.height / rect.d
  return { sx: (cell.i * cellSize - rect.x) * kx, sy: (cell.j * cellSize - rect.z) * kz, sw: cellSize * kx, sh: cellSize * kz }
}

/** Where tile (i, j) goes on a player canvas covering `rect` at `tilePx` per cell (× scale). */
export function tileDestRect(rect: Rect, cellSize: number, tilePx: number, cell: Cell, scale = 1): { dx: number; dy: number; size: number } {
  const k = (tilePx / cellSize) * scale
  return { dx: (cell.i * cellSize - rect.x) * k, dy: (cell.j * cellSize - rect.z) * k, size: tilePx * scale }
}

/** Canvas size for a backdrop at tilePx per cell (× scale). */
export function backdropCanvasSize(rect: Rect, cellSize: number, tilePx: number, scale = 1): { width: number; height: number } {
  return { width: Math.max(1, Math.round((rect.w / cellSize) * tilePx * scale)), height: Math.max(1, Math.round((rect.d / cellSize) * tilePx * scale)) }
}

// ---------------------------------------------------------------------------
// Cutting (host)
// ---------------------------------------------------------------------------

export interface CutTilesOptions {
  /** Encoded type (default image/webp; PNG when the browser cannot encode WebP). */
  type?: string
  quality?: number
  /** Leave out tiles whose pixels are all transparent (nothing to publish). Default true. */
  skipTransparent?: boolean
}

/**
 * Cut tiles for `cells` out of a backdrop image (the DM's stored image, e.g. an ImageBitmap).
 * Returns only non-empty tiles unless `skipTransparent` is false.
 */
export async function cutTiles(
  image: CanvasImageSource,
  imageSize: { width: number; height: number },
  rect: Rect,
  cellSize: number,
  tilePx: number,
  cells: readonly Cell[],
  opts: CutTilesOptions = {}
): Promise<Array<{ cell: Cell; blob: Blob }>> {
  const canvas = makeCanvas(tilePx, tilePx)
  const ctx = context2d(canvas, { willReadFrequently: opts.skipTransparent !== false })
  ctx.imageSmoothingQuality = "high"
  const out: Array<{ cell: Cell; blob: Blob }> = []
  for (const cell of cells) {
    if (!drawTile(ctx, image, imageSize, rect, cellSize, tilePx, cell)) continue
    if (opts.skipTransparent !== false && isTransparent(ctx, tilePx)) continue
    const blob = await canvasToBlob(canvas, opts.type ?? "image/webp", opts.quality ?? 0.85)
    out.push({ cell, blob })
  }
  return out
}

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

/** Paint tile `cell` into a tilePx² context (cleared first). false when the cell misses the image. */
function drawTile(ctx: Ctx, image: CanvasImageSource, size: { width: number; height: number }, rect: Rect, cellSize: number, tilePx: number, cell: Cell): boolean {
  ctx.clearRect(0, 0, tilePx, tilePx)
  const { sx, sy, sw, sh } = tileSourceRect(rect, size, cellSize, cell)
  // Clip the source rect to the image, mapping the clipped part to the matching part of the tile.
  const x0 = Math.max(0, sx)
  const y0 = Math.max(0, sy)
  const x1 = Math.min(size.width, sx + sw)
  const y1 = Math.min(size.height, sy + sh)
  if (!(x1 > x0 && y1 > y0)) return false
  const k = tilePx / sw
  const kz = tilePx / sh
  ctx.drawImage(image, x0, y0, x1 - x0, y1 - y0, (x0 - sx) * k, (y0 - sy) * kz, (x1 - x0) * k, (y1 - y0) * kz)
  return true
}

function isTransparent(ctx: Ctx, tilePx: number): boolean {
  const data = ctx.getImageData(0, 0, tilePx, tilePx).data
  for (let k = 3; k < data.length; k += 4) if (data[k] !== 0) return false
  return true
}

// ---------------------------------------------------------------------------
// Publisher (host)
// ---------------------------------------------------------------------------

export interface BackdropPublisherOptions {
  sessionId: string
  assets: AssetStore
  /** Decoded full image of a backdrop asset (default: assets.getImage + createImageBitmap). */
  loadImage?: (sceneId: Id, assetId: Id) => Promise<ImageBitmap | null>
  /** Called when a sync fails (the next sync retries the missing cells). */
  onError?: (err: unknown) => void
  /** Tile cutter (default cutTiles; injectable for tests without a canvas). */
  cut?: typeof cutTiles
}

export interface BackdropPublisher {
  /**
   * Make sure every explored cell of `userId` that lies on a level's backdrop is published and
   * granted to that player. Idempotent and incremental (only new cells cost anything); calls are
   * serialised. No-op for local asset stores (players crop locally).
   */
  sync(scene: Pick<Scene, "id" | "grid" | "levels" | "assets">, userId: string, hostEpoch: number, explored: Readonly<Record<Id, EncodedMask>>): Promise<void>
  /** Forget what was published/granted (e.g. after a new host epoch). */
  reset(): void
  dispose(): void
}

export async function decodeImageBlob(blob: Blob | null): Promise<ImageBitmap | null> {
  if (!blob) return null
  try {
    return await createImageBitmap(blob)
  } catch {
    return null
  }
}

export function createBackdropPublisher(opts: BackdropPublisherOptions): BackdropPublisher {
  const loadImage = opts.loadImage ?? (async (sceneId: Id, assetId: Id) => decodeImageBlob(await opts.assets.getImage(sceneId, assetId)))
  const images = new Map<string, Promise<ImageBitmap | null>>()
  /** level → { key of the backdrop it was cut from, published cell indices }. */
  const published = new Map<Id, { key: string; cells: Set<number> }>()
  /** `${userId}|${levelId}|${key}` → granted cell indices. */
  const granted = new Map<string, Set<number>>()
  let chain: Promise<void> = Promise.resolve()
  let disposed = false

  const image = (sceneId: Id, assetId: Id) => {
    const k = `${sceneId}/${assetId}`
    let p = images.get(k)
    if (!p) {
      p = loadImage(sceneId, assetId).catch(() => null)
      images.set(k, p)
      // A failed load is retried on a later sync.
      void p.then((bmp) => {
        if (!bmp) images.delete(k)
      })
    }
    return p
  }

  const syncNow = async (scene: Pick<Scene, "id" | "grid" | "levels" | "assets">, userId: string, hostEpoch: number, explored: Readonly<Record<Id, EncodedMask>>) => {
    if (opts.assets.mode === "local" || disposed) return
    const grid = scene.grid
    for (const levelId of Object.keys(explored).sort()) {
      const level = Object.hasOwn(scene.levels, levelId) ? scene.levels[levelId] : undefined
      const b = level?.backdrop
      const pb = playerBackdrop(scene, levelId)
      if (!b || !pb) continue
      const enc = explored[levelId]
      if (enc.width !== grid.width || enc.depth !== grid.depth) continue
      const mask = decodeMask(enc)
      const key = `${b.assetId}|${b.rect.x},${b.rect.z},${b.rect.w},${b.rect.d}|${pb.tilePx}|${grid.cellSize}`
      let pub = published.get(levelId)
      if (!pub || pub.key !== key) published.set(levelId, (pub = { key, cells: new Set() }))
      const gKey = `${userId}|${levelId}|${key}`
      let g = granted.get(gKey)
      if (!g) granted.set(gKey, (g = new Set()))
      const want: Cell[] = []
      for (const c of backdropCells(b.rect, grid)) {
        const idx = c.j * grid.width + c.i
        if (!g.has(idx) && cellTouched(mask, idx)) want.push(c)
      }
      if (want.length === 0) continue
      const toCut = want.filter((c) => !pub.cells.has(c.j * grid.width + c.i))
      if (toCut.length > 0) {
        const bmp = await image(scene.id, b.assetId)
        if (!bmp) throw new Error(`backdrop image ${b.assetId} is unavailable`)
        const cut = await (opts.cut ?? cutTiles)(bmp, bmp, b.rect, grid.cellSize, pb.tilePx, toCut)
        if (cut.length > 0) await opts.assets.publishTiles(opts.sessionId, levelId, cut)
        for (const c of toCut) pub.cells.add(c.j * grid.width + c.i)
      }
      await opts.assets.grantTiles(opts.sessionId, hostEpoch, userId, levelId, want)
      for (const c of want) g.add(c.j * grid.width + c.i)
    }
  }

  return {
    sync(scene, userId, hostEpoch, explored) {
      const run = chain.then(() => syncNow(scene, userId, hostEpoch, explored))
      chain = run.catch((err) => opts.onError?.(err))
      return run
    },
    reset() {
      published.clear()
      granted.clear()
    },
    dispose() {
      disposed = true
      for (const p of images.values()) void p.then((b) => b?.close())
      images.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Tile sources (player)
// ---------------------------------------------------------------------------

export interface TileSourceOptions {
  sessionId: string
  /** The signed-in player (Supabase chunks live under their user id). */
  userId: string
  client: AtlasClient | null
  store: LocalStore
}

/** Decoded chunks kept for cropping (a 4×4-cell chunk at 140 px/cell is 560² ≈ 1.3 MB). */
const CHUNK_BITMAPS = 24
/** Chunk downloads in flight at once (announced chunks are prefetched in announcement order). */
const CHUNK_DOWNLOADS = 6

/**
 * Supabase: the player's own tile chunks (./chunks.ts). The host announces which cells each uploaded
 * chunk holds (setChunks, from `{t: "tiles"}` messages); a cell's tile is cropped from its chunk once the
 * announced mask includes it, else null (the compositor retries; a new announcement triggers a retry).
 * Announced chunks are prefetched (a few at a time, in announcement order — the host uploads nearest
 * first); downloads are keyed by the announced mask (cache nonce), compressed blobs are kept for the
 * session and a few decoded chunks for cropping.
 */
export function createSupabaseTileSource(client: AtlasClient, sessionId: string, userId: string): BackdropTileSource {
  const controller = new AbortController()
  /** levelId → chunk key → announced cell mask. */
  const masks = new Map<Id, Map<number, number>>()
  /** `${levelId}/${key}@${mask}` → blob download. */
  const blobs = new Map<string, Promise<Blob | null>>()
  /** Same key → decoded chunk (LRU by insertion order). */
  const bitmaps = new Map<string, Promise<ImageBitmap | null>>()
  let disposed = false
  /** Prefetch queue (announced chunk versions) and downloads in flight. */
  let queue: Array<{ levelId: Id; ci: number; cj: number; mask: number }> = []
  let downloading = 0

  const blobFor = (levelId: Id, ci: number, cj: number, mask: number): Promise<Blob | null> => {
    const k = `${levelId}/${chunkKey(ci, cj)}@${mask}`
    let p = blobs.get(k)
    if (!p) {
      // Older versions of this chunk are superseded.
      const prefix = `${levelId}/${chunkKey(ci, cj)}@`
      for (const old of [...blobs.keys()]) if (old.startsWith(prefix)) blobs.delete(old)
      downloading++
      const run = downloadChunk(client, sessionId, userId, levelId, ci, cj, String(mask), controller.signal)
      p = run
      void run.finally(() => {
        downloading--
        pump()
      }).catch(() => {})
      // A missing object (upload still in flight on another replica) is fetched again next time.
      void run.then((b) => b === null && blobs.get(k) === run && blobs.delete(k)).catch(() => blobs.get(k) === run && blobs.delete(k))
      blobs.set(k, run)
    }
    return p
  }
  /** Start prefetches while below the download limit (skipping versions already superseded). */
  const pump = () => {
    while (!disposed && downloading < CHUNK_DOWNLOADS && queue.length > 0) {
      const next = queue.shift()!
      if (masks.get(next.levelId)?.get(chunkKey(next.ci, next.cj)) !== next.mask) continue
      void blobFor(next.levelId, next.ci, next.cj, next.mask).catch(() => {})
    }
  }
  const bitmapFor = (levelId: Id, ci: number, cj: number, mask: number): Promise<ImageBitmap | null> => {
    const k = `${levelId}/${chunkKey(ci, cj)}@${mask}`
    let p = bitmaps.get(k)
    if (p) {
      bitmaps.delete(k)
      bitmaps.set(k, p)
      return p
    }
    p = blobFor(levelId, ci, cj, mask).then((b) => decodeImageBlob(b))
    void p.then((b) => b === null && bitmaps.get(k) === p && bitmaps.delete(k)).catch(() => bitmaps.get(k) === p && bitmaps.delete(k))
    bitmaps.set(k, p)
    while (bitmaps.size > CHUNK_BITMAPS) {
      const [oldest, bp] = bitmaps.entries().next().value as [string, Promise<ImageBitmap | null>]
      bitmaps.delete(oldest)
      void bp.then((b) => b?.close()).catch(() => {})
    }
    return p
  }

  return {
    async getTile(levelId, cell) {
      if (disposed) return null
      const { ci, cj, bit } = chunkOfCell(cell.i, cell.j)
      const mask = masks.get(levelId)?.get(chunkKey(ci, cj)) ?? 0
      if ((mask & (1 << bit)) === 0) return null
      try {
        const chunk = await bitmapFor(levelId, ci, cj, mask)
        if (!chunk || disposed) return null
        const px = chunk.width / TILE_CHUNK
        return await createImageBitmap(chunk, (cell.i - ci * TILE_CHUNK) * px, (cell.j - cj * TILE_CHUNK) * px, px, px)
      } catch (err) {
        if (disposed) return null
        throw err
      }
    },
    setChunks(levelId, chunks, reset) {
      let level = masks.get(levelId)
      if (!level || reset) masks.set(levelId, (level = new Map()))
      if (reset) queue = queue.filter((q) => q.levelId !== levelId)
      for (const [ci, cj, mask] of chunks) {
        if (mask === 0) level.delete(chunkKey(ci, cj))
        else {
          level.set(chunkKey(ci, cj), mask)
          queue.push({ levelId, ci, cj, mask })
        }
      }
      pump()
    },
    dispose() {
      disposed = true
      controller.abort()
      for (const p of bitmaps.values()) void p.then((b) => b?.close()).catch(() => {})
      bitmaps.clear()
      blobs.clear()
      masks.clear()
      queue = []
    },
  }
}

interface LocalStateRecord {
  state: unknown
}

/** The scene of a local session (seed or saved GameState), read from the local sessions store. */
async function localSessionScene(store: LocalStore, sessionId: string): Promise<Scene | null> {
  const rec = await store.get<LocalStateRecord>("sessions", `state:${sessionId}`)
  const state = rec?.state as { scene?: unknown } | undefined
  const scene = state && typeof state === "object" ? (state.scene as Scene | undefined) : undefined
  return scene && typeof scene === "object" && scene.levels && scene.grid ? scene : null
}

/**
 * Local mode (dev only, NOT secure — like LocalTransport): crops tiles straight from the locally
 * stored image, using the backdrop placement of the session's last saved state. Any tab of this
 * browser could read the whole image from IndexedDB anyway.
 */
export function createLocalTileSource(store: LocalStore, sessionId: string): BackdropTileSource {
  let sceneCache: { at: number; scene: Promise<Scene | null> } | null = null
  const images = new Map<string, Promise<ImageBitmap | null>>()
  let disposed = false
  const scene = () => {
    const now = Date.now()
    if (!sceneCache || now - sceneCache.at > 3000) sceneCache = { at: now, scene: localSessionScene(store, sessionId).catch(() => null) }
    return sceneCache.scene
  }
  const image = (sceneId: Id, assetId: Id) => {
    const k = `${sceneId}/${assetId}`
    let p = images.get(k)
    if (!p) {
      p = readLocalAsset(store, sceneId, assetId)
        .then((rec) => decodeImageBlob(rec ? new Blob([rec.data], { type: rec.meta.mime }) : null))
        .catch(() => null)
      images.set(k, p)
    }
    return p
  }
  return {
    async getTile(levelId, cell) {
      if (disposed) return null
      const sc = await scene()
      if (!sc || !Object.hasOwn(sc.levels, levelId)) return null
      const b = sc.levels[levelId].backdrop
      const pb = playerBackdrop(sc, levelId)
      if (!b || !pb) return null
      const bmp = await image(sc.id, b.assetId)
      if (!bmp || disposed) return null
      const canvas = makeCanvas(pb.tilePx, pb.tilePx)
      const ctx = context2d(canvas)
      ctx.imageSmoothingQuality = "high"
      if (!drawTile(ctx, bmp, bmp, b.rect, sc.grid.cellSize, pb.tilePx, cell)) return null
      return createImageBitmap(canvas)
    },
    dispose() {
      disposed = true
      for (const p of images.values()) void p.then((b) => b?.close())
      images.clear()
    },
  }
}

export function createTileSource(opts: TileSourceOptions): BackdropTileSource {
  return opts.client ? createSupabaseTileSource(opts.client, opts.sessionId, opts.userId) : createLocalTileSource(opts.store, opts.sessionId)
}
