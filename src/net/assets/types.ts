/**
 * Map image assets (battlemap backdrops) — ARCHITECTURE §9.
 *
 * DM side: images are stored owner-private (Supabase Storage bucket `scene-assets`, or IndexedDB in
 * local mode) and referenced from the scene by id (`Scene.assets`, `Level.backdrop`).
 * Player side: players NEVER receive a whole image. During a session the host uploads, per player,
 * chunks of the cells that player has explored (Supabase: bucket `session-tiles`, path
 * `{sessionId}/{userId}/{levelId}/{ci}_{cj}.webp`, readable only by that player and the DM; see
 * ./chunks.ts) and announces them with `{t: "tiles"}` messages.
 */
import type { Cell, Id } from "@/core/scene/types"

import type { ChunkEntry } from "./chunks"

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

/**
 * `sceneId` is always the document's own `Scene.id` (not the library's storage row id): the editor,
 * the importer and duplicate/import in the library store and copy images under it, and the host reads
 * them with it (then, as a fallback, with the session's scene row id).
 */
export interface AssetStore {
  readonly mode: "supabase" | "local"
  /** Store an (already normalised) image for a scene. */
  putImage(sceneId: Id, blob: Blob, meta: Omit<AssetMeta, "id" | "bytes"> & { id?: Id }): Promise<AssetMeta>
  getImage(sceneId: Id, assetId: Id): Promise<Blob | null>
  deleteImage(sceneId: Id, assetId: Id): Promise<void>
  /** Copy a scene's assets to another scene id (fork/import). */
  copyImages(fromSceneId: Id, toSceneId: Id, assetIds: Id[]): Promise<void>
  /**
   * Delete every image stored under a document id (a deleted scene's folder: pass the ids from
   * ScenesRepo.imageFoldersToFree, BEFORE removing the scene). Returns the number of objects removed.
   * (Optional only so stand-in stores outside net/ keep compiling; both real stores implement it.)
   */
  deleteSceneImages?(sceneId: Id): Promise<number>
  /**
   * Delete the caller's images that no saved scene version, no active session and (in this browser) no
   * editor draft references, among those older than `minAgeMs` (default 7 days; Supabase only — local
   * mode has no age). Returns what was removed. (Optional like deleteSceneImages.)
   */
  sweepUnreferencedImages?(opts?: { minAgeMs?: number }): Promise<{ removed: number; bytes: number }>

  // ---- host side, during a session -------------------------------------------------------------
  /**
   * Upload (replace) one player's chunk of explored-cell tiles (Supabase; a no-op in local mode, where
   * the player's tile source crops the locally stored image itself).
   */
  putTileChunk(sessionId: string, userId: string, levelId: Id, ci: number, cj: number, blob: Blob): Promise<void>
  /** Delete a player's chunks (a fog reset emptied them). */
  deleteTileChunks(sessionId: string, userId: string, levelId: Id, chunks: Array<{ ci: number; cj: number }>): Promise<void>
  /** Delete every tile chunk of a session (the DM, after ending it). Returns the number removed. */
  removeSessionTiles(sessionId: string): Promise<number>
  /**
   * @deprecated The per-cell tile API (`player_tiles`, grant_tiles) was removed from the database and
   * the stores; these remain optional only so stand-in stores that still list them type-check.
   */
  publishTiles?(sessionId: string, levelId: Id, tiles: Array<{ cell: Cell; blob: Blob }>): Promise<void>
  /** @deprecated See publishTiles. */
  grantTiles?(sessionId: string, hostEpoch: number, userId: string, levelId: Id, cells: Cell[]): Promise<void>
}

/** Player side: fetch the tile for an explored cell (null if not (yet) available). */
export interface BackdropTileSource {
  getTile(levelId: Id, cell: Cell): Promise<ImageBitmap | null>
  /**
   * The host's `{t: "tiles"}` announcement: which cells each of this player's chunks holds (reset = the
   * level's list replaces what was known). Sources that crop locally ignore it.
   * Returns the cells whose chunk was re-cut (new mask or rev) while they stayed in it — their tile
   * changed (e.g. more of a partly explored cell), so a compositor that drew them should redraw them.
   */
  setChunks?(levelId: Id, chunks: ChunkEntry[], reset: boolean): Cell[] | void
  dispose(): void
}
