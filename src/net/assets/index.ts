/**
 * Public API of net/assets — map image assets (ARCHITECTURE §9):
 *  - createAssetStore: DM images in Supabase Storage (`scene-assets`, owner-only) or IndexedDB (local
 *    mode), plus session tile publishing/grants (Supabase only);
 *  - createTileSource: player-side tile fetches for explored cells (Supabase: per-player chunks, see
 *    ./chunks.ts; local: crops of the locally stored image);
 *  - importMapImage / guessGridFromName: battlemap import (decode huge images, normalise, encode WebP);
 *  - tiles: tile geometry and the superseded per-cell publisher (the host uploads per-player chunks,
 *    net/host/tiles.ts; the player composites them, net/player/backdropCanvas.ts).
 */
import type { Id } from "@/core/scene/types"

import type { AtlasClient } from "../supabase"
import type { LocalStore } from "../localStore"
import { createLocalAssetStore } from "./localAssets"
import { createSupabaseAssetStore } from "./supabaseAssets"
import { createTileSource as createTileSourceImpl, decodeImageBlob, type TileSourceOptions } from "./tiles"
import type { AssetStore, BackdropTileSource } from "./types"

export type * from "./types"
export {
  canvasToBlob,
  encodeImage,
  guessGridFromName,
  importMapImage,
  MAX_IMAGE_SIDE,
  MAX_PX_PER_CELL,
  normalisedSize,
  probeImageSize,
  readImageSize,
  type ImageSize,
  type ImportCalibration,
  type ImportedImage,
  type ImportOptions,
} from "./import"
export {
  backdropCanvasSize,
  backdropCells,
  createBackdropPublisher,
  cutTiles,
  decodeImageBlob,
  tileDestRect,
  tileSourceRect,
  type BackdropPublisher,
  type BackdropPublisherOptions,
  type CutTilesOptions,
  type TileSourceOptions,
} from "./tiles"
export { ASSET_BUCKET, TILE_BUCKET, assetPath, downloadChunk, downloadTile, removeSessionTiles, revokeTiles, tilePath } from "./supabaseAssets"
export { chunkFromKey, chunkKey, chunkOfCell, chunkPath, FULL_CHUNK_MASK, isChunkEntry, TILE_CHUNK, type CellChunk, type ChunkEntry } from "./chunks"
export { LOCAL_ASSET_PREFIX, LOCAL_ASSET_STORE } from "./localAssets"

export interface AssetStoreOptions {
  client: AtlasClient | null
  store: LocalStore
  userId: string
}

/** Supabase Storage when a client is given, else the local (IndexedDB) store. */
export function createAssetStore(opts: AssetStoreOptions): AssetStore {
  return opts.client ? createSupabaseAssetStore(opts.client, opts.userId) : createLocalAssetStore(opts.store)
}

/** Player-side tiles: Supabase storage downloads (granted cells only) or local crops (dev only). */
export function createTileSource(opts: TileSourceOptions): BackdropTileSource {
  return createTileSourceImpl(opts)
}

/** The DM's full backdrop image, decoded (for Engine.setLevelImage in DM modes). null when missing. */
export async function loadBackdropImage(store: AssetStore, sceneId: Id, assetId: Id): Promise<ImageBitmap | null> {
  return decodeImageBlob(await store.getImage(sceneId, assetId))
}
