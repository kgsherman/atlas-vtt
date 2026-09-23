/**
 * Map image assets (battlemap backdrops) — ARCHITECTURE §9.
 *
 * DM side: images are stored owner-private (Supabase Storage bucket `scene-assets`, or IndexedDB in
 * local mode) and referenced from the scene by id (`Scene.assets`, `Level.backdrop`).
 * Player side: players NEVER receive a whole image. During a session the host cuts the backdrop into
 * one tile per grid cell and publishes a tile only for cells that player has explored (Supabase:
 * bucket `session-tiles` + `player_tiles` grants enforced by storage RLS).
 */
import type { Cell, Id } from "@/core/scene/types"

export type AssetMime = "image/webp" | "image/png" | "image/jpeg"

export interface AssetMeta {
  id: Id
  kind: "image"
  name: string
  mime: AssetMime
  /** Stored pixel size. */
  width: number
  height: number
  bytes: number
}

export interface AssetStore {
  readonly mode: "supabase" | "local"
  /** Store an (already normalised) image for a scene. */
  putImage(sceneId: Id, blob: Blob, meta: Omit<AssetMeta, "id" | "bytes"> & { id?: Id }): Promise<AssetMeta>
  getImage(sceneId: Id, assetId: Id): Promise<Blob | null>
  deleteImage(sceneId: Id, assetId: Id): Promise<void>
  /** Copy a scene's assets to another scene id (fork/import). */
  copyImages(fromSceneId: Id, toSceneId: Id, assetIds: Id[]): Promise<void>

  // ---- host side, during a session -------------------------------------------------------------
  /** Upload tiles (idempotent; skips tiles already published this session). */
  publishTiles(sessionId: string, levelId: Id, tiles: Array<{ cell: Cell; blob: Blob }>): Promise<void>
  /** Grant a player read access to published tiles (fenced by the host epoch). */
  grantTiles(sessionId: string, hostEpoch: number, userId: string, levelId: Id, cells: Cell[]): Promise<void>
}

/** Player side: fetch the tile for an explored cell (null if not (yet) granted / not published). */
export interface BackdropTileSource {
  getTile(levelId: Id, cell: Cell): Promise<ImageBitmap | null>
  dispose(): void
}
