/**
 * Backdrop tiles (ARCHITECTURE §9 "Players never receive a whole image").
 *
 * Tile geometry (shared by the host that cuts tiles and the player that composites them): tile (i, j)
 * is the part of the level's backdrop image covering grid cell (i, j) — world
 * [i·s, (i+1)·s) × [j·s, (j+1)·s) — resampled to `tilePx` × `tilePx` (tilePx = stored px per cell,
 * PlayerBackdrop.tilePx from core/session/backdrop `playerBackdrop`, the one rule the filter, the host
 * tiler and this module use). Parts of the cell outside the image are transparent. The cells a backdrop
 * covers are core/session/backdrop `backdropCellRange`, again shared by host and player.
 *
 * Host side (sessions): net/host/tiles.ts uploads per-player chunks of explored sub-cells
 * (./chunks.ts). Player side: createTileSource fetches one tile (Supabase: cropped from the player's
 * own chunk once the host announced it; local mode: cropped from the locally stored image — dev only,
 * NOT a security boundary). The player client composites fetched tiles into per-level canvases for
 * Engine.setLevelImage / updateLevelImage (net/player/backdropCanvas.ts).
 *
 * Imports stay light (core/session/backdrop has no runtime imports beyond a tiny util): every route
 * loads this module through the app services.
 */
import type { Cell, Id, Rect, Scene } from "@/core/scene/types"
import { playerBackdrop } from "@/core/session/backdrop"

import type { LocalStore } from "../localStore"
import type { AtlasClient } from "../supabase"
import { context2d, makeCanvas } from "./import"
import { readLocalAsset } from "./localAssets"
import { chunkKey, chunkOfCell, TILE_CHUNK } from "./chunks"
import { downloadChunk } from "./supabaseAssets"
import type { BackdropTileSource } from "./types"

// ---------------------------------------------------------------------------
// Geometry (pure)
// ---------------------------------------------------------------------------

/** Source rect (image px, may extend beyond the image) of tile (i, j). */
export function tileSourceRect(rect: Rect, image: { width: number; height: number }, cellSize: number, cell: Cell): { sx: number; sy: number; sw: number; sh: number } {
  const kx = image.width / rect.w
  const kz = image.height / rect.d
  return { sx: (cell.i * cellSize - rect.x) * kx, sy: (cell.j * cellSize - rect.z) * kz, sw: cellSize * kx, sh: cellSize * kz }
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

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

export async function decodeImageBlob(blob: Blob | null): Promise<ImageBitmap | null> {
  if (!blob) return null
  try {
    return await createImageBitmap(blob)
  } catch {
    return null
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

/** The announced content of one chunk: its cells (mask) and content version (rev; 0 from older hosts). */
interface ChunkVersion {
  mask: number
  rev: number
}

/**
 * Supabase: the player's own tile chunks (./chunks.ts). The host announces which cells each uploaded
 * chunk holds and its content version (setChunks, from `{t: "tiles"}` messages); a cell's tile is cropped
 * from its chunk once the announced mask includes it, else null (the compositor retries; a new
 * announcement triggers a retry). Announced chunks are prefetched (a few at a time, in announcement order
 * — the host uploads nearest first); downloads are keyed by the announced `${mask}.${rev}` (cache nonce),
 * compressed blobs are kept for the session and a few decoded chunks for cropping. A chunk re-cut under a
 * new rev while a cell stays in it (a partly explored cell grew) is reported by setChunks so the
 * compositor redraws that cell.
 */
export function createSupabaseTileSource(client: AtlasClient, sessionId: string, userId: string): BackdropTileSource {
  const controller = new AbortController()
  /** levelId → chunk key → announced version. */
  const masks = new Map<Id, Map<number, ChunkVersion>>()
  /** `${levelId}/${key}@${mask}.${rev}` → blob download. */
  const blobs = new Map<string, Promise<Blob | null>>()
  /** Same key → decoded chunk (LRU by insertion order). */
  const bitmaps = new Map<string, Promise<ImageBitmap | null>>()
  let disposed = false
  /** Prefetch queue (announced chunk versions) and downloads in flight. */
  let queue: Array<{ levelId: Id; ci: number; cj: number; mask: number; rev: number }> = []
  let downloading = 0
  const versionKey = (levelId: Id, ci: number, cj: number, v: ChunkVersion) => `${levelId}/${chunkKey(ci, cj)}@${v.mask}.${v.rev}`

  const blobFor = (levelId: Id, ci: number, cj: number, v: ChunkVersion): Promise<Blob | null> => {
    const k = versionKey(levelId, ci, cj, v)
    let p = blobs.get(k)
    if (!p) {
      // Older versions of this chunk are superseded.
      const prefix = `${levelId}/${chunkKey(ci, cj)}@`
      for (const old of [...blobs.keys()]) if (old.startsWith(prefix)) blobs.delete(old)
      downloading++
      const run = downloadChunk(client, sessionId, userId, levelId, ci, cj, `${v.mask}.${v.rev}`, controller.signal)
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
      const cur = masks.get(next.levelId)?.get(chunkKey(next.ci, next.cj))
      if (!cur || cur.mask !== next.mask || cur.rev !== next.rev) continue
      void blobFor(next.levelId, next.ci, next.cj, cur).catch(() => {})
    }
  }
  const bitmapFor = (levelId: Id, ci: number, cj: number, v: ChunkVersion): Promise<ImageBitmap | null> => {
    const k = versionKey(levelId, ci, cj, v)
    let p = bitmaps.get(k)
    if (p) {
      bitmaps.delete(k)
      bitmaps.set(k, p)
      return p
    }
    p = blobFor(levelId, ci, cj, v).then((b) => decodeImageBlob(b))
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
      const v = masks.get(levelId)?.get(chunkKey(ci, cj))
      if (!v || (v.mask & (1 << bit)) === 0) return null
      try {
        const chunk = await bitmapFor(levelId, ci, cj, v)
        if (!chunk || disposed) return null
        const px = chunk.width / TILE_CHUNK
        return await createImageBitmap(chunk, (cell.i - ci * TILE_CHUNK) * px, (cell.j - cj * TILE_CHUNK) * px, px, px)
      } catch (err) {
        if (disposed) return null
        throw err
      }
    },
    setChunks(levelId, chunks, reset) {
      const before = masks.get(levelId)
      let level = before
      if (!level || reset) masks.set(levelId, (level = new Map()))
      if (reset) queue = queue.filter((q) => q.levelId !== levelId)
      const refreshed: Cell[] = []
      for (const entry of chunks) {
        const [ci, cj, mask] = entry
        const rev = entry.length === 4 ? entry[3] : 0
        const key = chunkKey(ci, cj)
        const old = before?.get(key)
        if (mask === 0) {
          level.delete(key)
          continue
        }
        level.set(key, { mask, rev })
        queue.push({ levelId, ci, cj, mask, rev })
        if (!old || (old.mask === mask && old.rev === rev)) continue
        // Re-cut: cells that were in the old version and still are have a new tile.
        const kept = old.mask & mask
        for (let bit = 0; bit < TILE_CHUNK * TILE_CHUNK; bit++) {
          if (kept & (1 << bit)) refreshed.push({ i: ci * TILE_CHUNK + (bit % TILE_CHUNK), j: cj * TILE_CHUNK + Math.floor(bit / TILE_CHUNK) })
        }
      }
      pump()
      return refreshed
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
      const assetId = sc.levels[levelId].backdrop?.assetId
      // The placement and tile size the player was sent (the same rule as the filter's).
      const pb = playerBackdrop(sc, levelId)
      if (!assetId || !pb) return null
      const bmp = await image(sc.id, assetId)
      if (!bmp || disposed) return null
      const canvas = makeCanvas(pb.tilePx, pb.tilePx)
      const ctx = context2d(canvas)
      ctx.imageSmoothingQuality = "high"
      if (!drawTile(ctx, bmp, bmp, pb.rect, sc.grid.cellSize, pb.tilePx, cell)) return null
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
