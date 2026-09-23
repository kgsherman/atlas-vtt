/**
 * Supabase Storage map image store (ARCHITECTURE §9):
 *  - `scene-assets` (private): DM images at `{ownerId}/{sceneId}/{assetId}.{webp|png|jpg}`; storage
 *    policies allow only the owner's own folder.
 *  - `session-tiles` (private): per-player chunks of explored-cell tiles at
 *    `{sessionId}/{userId}/{levelId}/{ci}_{cj}.webp` (./chunks.ts), written by the session's DM and
 *    readable only by that user while an active member (and the DM).
 *    (The superseded per-cell layout `{sessionId}/{levelId}/{i}_{j}.webp` + `player_tiles` grants is
 *    kept by publishTiles / grantTiles for compatibility.)
 * Migrations: supabase/migrations/*_map_assets_storage.sql, *_tile_chunks.sql.
 */
import { newId } from "@/core/scene/factory"
import type { Cell, Id } from "@/core/scene/types"

import { NetError, toNetError, type AtlasClient } from "../supabase"
import { chunkPath, MAX_CHUNK_COORD } from "./chunks"
import { checkAssetId } from "./localAssets"
import type { AssetMeta, AssetMime, AssetStore } from "./types"

export const ASSET_BUCKET = "scene-assets"
export const TILE_BUCKET = "session-tiles"
/** Server cap on cells per grant_tiles call (the client sends smaller batches). */
export const GRANT_BATCH = 2000
const UPLOAD_CONCURRENCY = 6

const EXT: Record<AssetMime, string> = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg" }
const MIMES: AssetMime[] = ["image/webp", "image/png", "image/jpeg"]

export const assetPath = (ownerId: string, sceneId: Id, assetId: Id, mime: AssetMime) => `${ownerId}/${sceneId}/${assetId}.${EXT[mime]}`
export const tilePath = (sessionId: string, levelId: Id, cell: Cell) => `${sessionId}/${levelId}/${cell.i}_${cell.j}.webp`

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** HTTP status of a storage-js error (StorageApiError.status, or the wrapped response's). */
export function storageStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null
  const e = err as { status?: unknown; statusCode?: unknown; originalError?: { status?: unknown } }
  if (typeof e.status === "number") return e.status
  if (typeof e.statusCode === "string" && /^\d{3}$/.test(e.statusCode)) return Number(e.statusCode)
  if (e.originalError && typeof e.originalError.status === "number") return e.originalError.status
  return null
}

/** Storage "does not exist or you may not see it" (Storage answers 400 for missing objects). */
export const isMissing = (err: unknown) => {
  const s = storageStatus(err)
  return s === 400 || s === 403 || s === 404
}

function storageError(err: unknown, what: string): NetError {
  if (err instanceof NetError) return err
  const status = storageStatus(err)
  const message = err instanceof Error ? err.message : String(err)
  if (status === 401) return new NetError("not_authenticated", `${what}: ${message}`, { cause: err })
  if (status === 403) return new NetError("permission_denied", `${what}: ${message}`, { cause: err })
  if (status === 404 || status === 400) return new NetError("not_found", `${what}: ${message}`, { cause: err })
  if (status === 413) return new NetError("payload_too_large", `${what}: ${message}`, { cause: err })
  if (status === null && /fetch|network/i.test(message)) return new NetError("network", `${what}: ${message}`, { cause: err })
  return new NetError("unknown", `${what}: ${message}`, { cause: err })
}

/** Run tasks with bounded concurrency; resolves when all settle, rethrows the first failure. */
export async function runLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  let firstError: unknown = null
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]
      try {
        await fn(item)
      } catch (err) {
        firstError ??= err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  if (firstError) throw firstError
}

function checkChunk(sessionId: string, userId: string, levelId: Id, ci: number, cj: number): void {
  if (!UUID_RE.test(sessionId) || !UUID_RE.test(userId)) throw new NetError("invalid_argument", "invalid session or user id")
  checkAssetId("level", levelId)
  if (![ci, cj].every((n) => Number.isInteger(n) && n >= 0 && n < MAX_CHUNK_COORD)) throw new NetError("invalid_argument", "invalid chunk")
}

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }

export function createSupabaseAssetStore(client: AtlasClient, ownerId: string): AssetStore {
  const assets = () => client.storage.from(ASSET_BUCKET)
  const tiles = () => client.storage.from(TILE_BUCKET)
  /**
   * Tiles uploaded by this store, keyed by path + size + type, so re-publishing the same tile is free
   * while a re-cut tile (new backdrop image under the same cell) is uploaded again.
   */
  const published = new Set<string>()
  const publishKey = (path: string, blob: Blob) => `${path}|${blob.size}|${blob.type}`

  /** Download the asset whichever extension it was stored with (WebP first: imports encode WebP). */
  const download = async (sceneId: Id, assetId: Id): Promise<Blob | null> => {
    for (const mime of MIMES) {
      const { data, error } = await assets().download(assetPath(ownerId, sceneId, assetId, mime))
      if (!error && data) return data.type ? data : new Blob([data], { type: mime })
      if (error && !isMissing(error)) throw storageError(error, "download image")
    }
    return null
  }

  return {
    mode: "supabase",
    async putImage(sceneId, blob, meta) {
      const id = meta.id ?? newId()
      checkAssetId("scene", sceneId)
      checkAssetId("asset", id)
      if (!EXT[meta.mime]) throw new NetError("invalid_argument", "unsupported image type")
      const { error } = await assets().upload(assetPath(ownerId, sceneId, id, meta.mime), blob, {
        contentType: meta.mime,
        upsert: true,
        cacheControl: "31536000",
      })
      if (error) throw storageError(error, "upload image")
      const full: AssetMeta = { id, kind: "image", name: meta.name, mime: meta.mime, width: meta.width, height: meta.height, bytes: blob.size }
      return full
    },
    async getImage(sceneId, assetId) {
      checkAssetId("scene", sceneId)
      checkAssetId("asset", assetId)
      return download(sceneId, assetId)
    },
    async deleteImage(sceneId, assetId) {
      checkAssetId("scene", sceneId)
      checkAssetId("asset", assetId)
      const { error } = await assets().remove(MIMES.map((m) => assetPath(ownerId, sceneId, assetId, m)))
      if (error) throw storageError(error, "delete image")
    },
    async copyImages(fromSceneId, toSceneId, assetIds) {
      checkAssetId("scene", fromSceneId)
      checkAssetId("scene", toSceneId)
      for (const id of assetIds) {
        checkAssetId("asset", id)
        let copied = false
        for (const mime of MIMES) {
          const { error } = await assets().copy(assetPath(ownerId, fromSceneId, id, mime), assetPath(ownerId, toSceneId, id, mime))
          if (!error) {
            copied = true
            break
          }
          if (!isMissing(error)) throw storageError(error, "copy image")
        }
        if (!copied) throw new NetError("not_found", `image ${id} not found`)
      }
    },
    async putTileChunk(sessionId, userId, levelId, ci, cj, blob) {
      checkChunk(sessionId, userId, levelId, ci, cj)
      // No CDN caching: a chunk is replaced as its player explores (clients also bust the cache).
      const { error } = await tiles().upload(chunkPath(sessionId, userId, levelId, ci, cj), blob, { contentType: blob.type || "image/webp", upsert: true, cacheControl: "0" })
      if (error) throw storageError(error, "upload tile chunk")
    },
    async deleteTileChunks(sessionId, userId, levelId, chunks) {
      for (const c of chunks) checkChunk(sessionId, userId, levelId, c.ci, c.cj)
      if (chunks.length === 0) return
      const { error } = await tiles().remove(chunks.map((c) => chunkPath(sessionId, userId, levelId, c.ci, c.cj)))
      if (error) throw storageError(error, "delete tile chunks")
    },
    async removeSessionTiles(sessionId) {
      return removeSessionTiles(client, sessionId)
    },
    async publishTiles(sessionId, levelId, list) {
      if (!UUID_RE.test(sessionId)) throw new NetError("invalid_argument", "invalid session id")
      checkAssetId("level", levelId)
      const todo = list.filter((t) => !published.has(publishKey(tilePath(sessionId, levelId, t.cell), t.blob)))
      await runLimited(todo, UPLOAD_CONCURRENCY, async (t) => {
        const path = tilePath(sessionId, levelId, t.cell)
        // Short cache: a re-cut tile replaces the object under the same path.
        const { error } = await tiles().upload(path, t.blob, { contentType: t.blob.type || "image/webp", upsert: true, cacheControl: "60" })
        if (error) throw storageError(error, "upload tile")
        published.add(publishKey(path, t.blob))
      })
    },
    async grantTiles(sessionId, hostEpoch, userId, levelId, cells) {
      if (!UUID_RE.test(sessionId) || !UUID_RE.test(userId)) throw new NetError("invalid_argument", "invalid session or user id")
      checkAssetId("level", levelId)
      const rpc = client as unknown as RpcClient
      for (let k = 0; k < cells.length; k += GRANT_BATCH) {
        const batch = cells.slice(k, k + GRANT_BATCH).map((c) => [c.i, c.j])
        const { error } = await rpc.rpc("grant_tiles", {
          p_session_id: sessionId,
          p_host_epoch: hostEpoch,
          p_user_id: userId,
          p_level_id: levelId,
          p_cells: batch,
        })
        if (error) throw toNetError(error)
      }
    },
  }
}

/**
 * Download one granted tile; null when it is not published or not granted (400/403/404).
 *
 * Supabase's CDN caches private objects per requester for the object's cache time (tiles: 60 s), so a
 * player keeps seeing a tile they already downloaded for up to a minute after a revoke (they have its
 * pixels anyway). Pass `nonce` to bypass the cache, e.g. when retrying a tile that was not granted yet.
 */
export async function downloadTile(client: AtlasClient, sessionId: string, levelId: Id, cell: Cell, signal?: AbortSignal, nonce?: string): Promise<Blob | null> {
  const { data, error } = await client.storage
    .from(TILE_BUCKET)
    .download(tilePath(sessionId, levelId, cell), nonce ? { cacheNonce: nonce } : {}, signal ? { signal } : undefined)
  if (error) {
    if (isMissing(error)) return null
    throw storageError(error, "download tile")
  }
  return data
}

/**
 * Download one of the signed-in player's tile chunks; null when it does not exist (yet) or may not be
 * read (400/403/404). `nonce` bypasses the CDN cache (the chunk's cell mask: a chunk is replaced as its
 * player explores).
 */
export async function downloadChunk(client: AtlasClient, sessionId: string, userId: string, levelId: Id, ci: number, cj: number, nonce: string, signal?: AbortSignal): Promise<Blob | null> {
  const { data, error } = await client.storage.from(TILE_BUCKET).download(chunkPath(sessionId, userId, levelId, ci, cj), { cacheNonce: nonce }, signal ? { signal } : undefined)
  if (error) {
    if (isMissing(error)) return null
    throw storageError(error, "download tile chunk")
  }
  return data
}

/**
 * Remove a player's (or, with userId null, everyone's) tile grants, e.g. after a fog reset — fenced by
 * the host epoch like grant_tiles. Returns the number of grants removed.
 */
export async function revokeTiles(client: AtlasClient, sessionId: string, hostEpoch: number, userId: string | null = null, levelId: Id | null = null): Promise<number> {
  if (!UUID_RE.test(sessionId) || (userId !== null && !UUID_RE.test(userId))) throw new NetError("invalid_argument", "invalid session or user id")
  if (levelId !== null) checkAssetId("level", levelId)
  const rpc = client as unknown as RpcClient
  const { data, error } = await rpc.rpc("revoke_tiles", { p_session_id: sessionId, p_host_epoch: hostEpoch, p_user_id: userId, p_level_id: levelId })
  if (error) throw toNetError(error)
  return typeof data === "number" ? data : 0
}

/**
 * DM cleanup: delete every tile object of a session (its players' chunks, and per-cell tiles of the
 * superseded layout), e.g. after ending it. Returns the number of objects removed.
 */
export async function removeSessionTiles(client: AtlasClient, sessionId: string): Promise<number> {
  if (!UUID_RE.test(sessionId)) throw new NetError("invalid_argument", "invalid session id")
  const bucket = client.storage.from(TILE_BUCKET)
  let removed = 0
  const walk = async (folder: string, depth: number): Promise<void> => {
    for (;;) {
      const { data, error } = await bucket.list(folder, { limit: 1000 })
      if (error) throw storageError(error, "list tiles")
      const entries = data ?? []
      // Folders come back with a null id.
      const files = entries.filter((f) => f.id !== null).map((f) => `${folder}/${f.name}`)
      if (depth < 3) for (const f of entries.filter((e) => e.id === null)) await walk(`${folder}/${f.name}`, depth + 1)
      if (files.length === 0) return
      const res = await bucket.remove(files)
      if (res.error) throw storageError(res.error, "remove tiles")
      removed += files.length
      if (files.length < 1000) return
    }
  }
  await walk(sessionId, 1)
  return removed
}
