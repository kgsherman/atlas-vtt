/**
 * Local-mode map image store (IndexedDB through LocalStore; in-memory under Node/Vitest). Dev/offline
 * only: there is no owner check and tiles are not published — the local tile source crops tiles
 * straight from the stored image (see tiles.ts), which is NOT a security boundary (like
 * LocalTransport).
 *
 * Records live in the LocalStore "sessions" object store under the key prefix `asset:` (the store
 * list is fixed by net/localStore; no other code uses that prefix):
 *   asset:{sceneId}:{assetId} → { meta, data: ArrayBuffer }
 * The bytes are kept as an ArrayBuffer (structured-clonable everywhere, unlike Blob in Node).
 */
import { idSchema } from "@/core/scene/schema"
import { newId } from "@/core/scene/factory"
import type { Id } from "@/core/scene/types"

import type { LocalStore, StoreName } from "../localStore"
import { NetError } from "../supabase"
import { addImageRefs, draftDocIds, sceneOf } from "./references"
import type { AssetMeta, AssetStore } from "./types"

export const LOCAL_ASSET_STORE: StoreName = "sessions"
export const LOCAL_ASSET_PREFIX = "asset:"

export interface LocalAssetRecord {
  meta: AssetMeta
  data: ArrayBuffer
}

export const localAssetKey = (sceneId: Id, assetId: Id) => `${LOCAL_ASSET_PREFIX}${sceneId}:${assetId}`

/** Ids end up in storage keys and paths: only the scene id alphabet is allowed. */
export function checkAssetId(kind: string, id: string): void {
  if (!idSchema.safeParse(id).success) throw new NetError("invalid_argument", `invalid ${kind} id`)
}

export async function readLocalAsset(store: LocalStore, sceneId: Id, assetId: Id): Promise<LocalAssetRecord | undefined> {
  return store.get<LocalAssetRecord>(LOCAL_ASSET_STORE, localAssetKey(sceneId, assetId))
}

export function createLocalAssetStore(store: LocalStore | Promise<LocalStore>): AssetStore {
  const st = () => Promise.resolve(store)
  return {
    mode: "local",
    async putImage(sceneId, blob, meta) {
      const id = meta.id ?? newId()
      checkAssetId("scene", sceneId)
      checkAssetId("asset", id)
      const full: AssetMeta = { id, kind: "image", name: meta.name, mime: meta.mime, width: meta.width, height: meta.height, bytes: blob.size }
      await (await st()).put<LocalAssetRecord>(LOCAL_ASSET_STORE, localAssetKey(sceneId, id), { meta: full, data: await blob.arrayBuffer() })
      return full
    },
    async getImage(sceneId, assetId) {
      const rec = await readLocalAsset(await st(), sceneId, assetId)
      return rec ? new Blob([rec.data], { type: rec.meta.mime }) : null
    },
    async deleteImage(sceneId, assetId) {
      await (await st()).delete(LOCAL_ASSET_STORE, localAssetKey(sceneId, assetId))
    },
    async copyImages(fromSceneId, toSceneId, assetIds) {
      checkAssetId("scene", toSceneId)
      const s = await st()
      for (const id of assetIds) {
        const rec = await readLocalAsset(s, fromSceneId, id)
        if (!rec) throw new NetError("not_found", `image ${id} not found`)
        await s.put<LocalAssetRecord>(LOCAL_ASSET_STORE, localAssetKey(toSceneId, id), rec)
      }
    },
    async deleteSceneImages(sceneId) {
      checkAssetId("scene", sceneId)
      return (await st()).deletePrefix(LOCAL_ASSET_STORE, localAssetKey(sceneId, ""))
    },
    async sweepUnreferencedImages() {
      const s = await st()
      const used = await localImageRefs(s)
      const drafts = await draftDocIds(s)
      let removed = 0
      let bytes = 0
      for (const [key, rec] of await s.entries<LocalAssetRecord>(LOCAL_ASSET_STORE, LOCAL_ASSET_PREFIX)) {
        const [sceneId, assetId] = key.slice(LOCAL_ASSET_PREFIX.length).split(":")
        if (!sceneId || !assetId || drafts.has(sceneId) || used.has(`${sceneId}/${assetId}`)) continue
        await s.delete(LOCAL_ASSET_STORE, key)
        removed++
        bytes += rec?.meta?.bytes ?? rec?.data?.byteLength ?? 0
      }
      return { removed, bytes }
    },
    // Local sessions have no tile bucket: players crop from the local copy (dev only).
    async putTileChunk() {},
    async deleteTileChunks() {},
    async removeSessionTiles() {
      return 0
    },
  }
}

/** Every (folder, asset) a local scene version or an active local session references. */
async function localImageRefs(s: LocalStore): Promise<Set<string>> {
  const used = new Set<string>()
  for (const [key, v] of await s.entries<{ data?: unknown }>("sceneVersions")) addImageRefs(v?.data, used, key.slice(0, key.indexOf(":")))
  for (const [key, session] of await s.entries<{ id?: string; status?: string; sceneId?: string | null }>("sessions", "s:")) {
    if (session?.status !== "active") continue
    const rec = await s.get<{ state?: unknown }>("sessions", `state:${key.slice(2)}`)
    addImageRefs(sceneOf(rec?.state), used, session.sceneId ?? null)
  }
  return used
}
