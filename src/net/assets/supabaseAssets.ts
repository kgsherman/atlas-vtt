/**
 * Supabase Storage map image store (ARCHITECTURE §9):
 *  - `scene-assets` (private): DM images at `{ownerId}/{sceneId}/{assetId}.{webp|png|jpg}`; storage
 *    policies allow only the owner's own folder.
 *  - `session-tiles` (private): per-player chunks of explored-cell tiles at
 *    `{sessionId}/{userId}/{levelId}/{ci}_{cj}.webp` (./chunks.ts), written by the session's DM (for
 *    members only) and readable only by that user while an active member (and the DM).
 * Quotas (migration *_owner_quotas.sql): ≤ 300 images / 1 GB per owner, ≤ 20000 tile objects per
 * session — Storage answers 403 beyond them, reported as "quota_exceeded" for images.
 * Migrations: supabase/migrations/*_map_assets_storage.sql, *_tile_chunks.sql, *_drop_legacy_tiles.sql.
 */
import { newId } from "@/core/scene/factory"
import type { Id } from "@/core/scene/types"

import { NetError, toNetError, type AtlasClient } from "../supabase"
import { chunkPath, MAX_CHUNK_COORD } from "./chunks"
import { checkAssetId } from "./localAssets"
import type { AssetMeta, AssetMime, AssetStore } from "./types"

export const ASSET_BUCKET = "scene-assets"
export const TILE_BUCKET = "session-tiles"
/** Objects per Storage list/remove call. */
const PAGE = 1000
/** Default age before an unreferenced image may be swept (drafts of other browsers may still use it). */
export const SWEEP_MIN_AGE_MS = 7 * 24 * 3600 * 1000

const EXT: Record<AssetMime, string> = { "image/webp": "webp", "image/png": "png", "image/jpeg": "jpg" }
const MIMES: AssetMime[] = ["image/webp", "image/png", "image/jpeg"]

export const assetPath = (ownerId: string, sceneId: Id, assetId: Id, mime: AssetMime) => `${ownerId}/${sceneId}/${assetId}.${EXT[mime]}`

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

function checkChunk(sessionId: string, userId: string, levelId: Id, ci: number, cj: number): void {
  if (!UUID_RE.test(sessionId) || !UUID_RE.test(userId)) throw new NetError("invalid_argument", "invalid session or user id")
  checkAssetId("level", levelId)
  if (![ci, cj].every((n) => Number.isInteger(n) && n >= 0 && n < MAX_CHUNK_COORD)) throw new NetError("invalid_argument", "invalid chunk")
}

export interface SupabaseAssetStoreOptions {
  /** Document ids whose images must never be swept (e.g. this browser's editor drafts). */
  keepDocIds?: () => Promise<Set<string>>
}

export function createSupabaseAssetStore(client: AtlasClient, ownerId: string, opts: SupabaseAssetStoreOptions = {}): AssetStore {
  const assets = () => client.storage.from(ASSET_BUCKET)
  const tiles = () => client.storage.from(TILE_BUCKET)

  /** Files (not folders) directly in `folder`: name → size in bytes. */
  const listFolder = async (folder: string): Promise<Map<string, number>> => {
    const out = new Map<string, number>()
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await assets().list(folder, { limit: PAGE, offset })
      if (error) throw storageError(error, "list images")
      const entries = data ?? []
      for (const f of entries) {
        if (f.id === null) continue
        const size = (f.metadata as { size?: unknown } | null)?.size
        out.set(`${folder}/${f.name}`, typeof size === "number" ? size : 0)
      }
      if (entries.length < PAGE) return out
    }
  }

  const removeAll = async (names: readonly string[]): Promise<number> => {
    let removed = 0
    for (let k = 0; k < names.length; k += PAGE) {
      const batch = names.slice(k, k + PAGE)
      const { error } = await assets().remove(batch)
      if (error) throw storageError(error, "delete images")
      removed += batch.length
    }
    return removed
  }

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
      if (error) {
        // The path is ours and well-formed (checked above): a refusal means the account's image quota.
        if (storageStatus(error) === 403) throw new NetError("quota_exceeded", "upload image: Storage refused the image; the account's image quota (300 images / 1 GB) may be used up", { cause: error })
        throw storageError(error, "upload image")
      }
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
      if (error) {
        if (storageStatus(error) === 403) {
          throw new NetError("permission_denied", "upload tile chunk: refused (the player may have left the session, or its tile storage is full)", { cause: error })
        }
        throw storageError(error, "upload tile chunk")
      }
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
    async deleteSceneImages(sceneId) {
      checkAssetId("scene", sceneId)
      let removed = 0
      // Removing shifts the listing: list from the start again until the folder is empty.
      for (;;) {
        const names = [...(await listFolder(`${ownerId}/${sceneId}`)).keys()].slice(0, PAGE)
        if (names.length === 0) return removed
        removed += await removeAll(names)
        if (names.length < PAGE) return removed
      }
    },
    async sweepUnreferencedImages(sweep = {}) {
      const minAgeMs = Math.max(0, sweep.minAgeMs ?? SWEEP_MIN_AGE_MS)
      const { data, error } = await client.rpc("unreferenced_scene_assets", { p_min_age: `${Math.round(minAgeMs / 1000)} seconds` })
      if (error) throw toNetError(error)
      const keep = opts.keepDocIds ? await opts.keepDocIds().catch(() => new Set<string>()) : new Set<string>()
      const names = (Array.isArray(data) ? data : [])
        .filter((n): n is string => typeof n === "string" && n.startsWith(`${ownerId}/`))
        .filter((n) => !keep.has(n.split("/")[1]))
      if (names.length === 0) return { removed: 0, bytes: 0 }
      // Sizes come from the folder listings (the RPC names objects only).
      let bytes = 0
      const wanted = new Set(names)
      for (const folder of new Set(names.map((n) => n.slice(0, n.lastIndexOf("/"))))) {
        for (const [name, size] of await listFolder(folder)) if (wanted.has(name)) bytes += size
      }
      return { removed: await removeAll(names), bytes }
    },
  }
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
 * DM cleanup: delete every tile object of a session (its players' chunks, and leftovers of the old
 * per-cell layout), e.g. after ending it. Returns the number of objects removed.
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
