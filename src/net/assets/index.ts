/**
 * Public API of net/assets. STUB bodies — implemented by the map-assets module (ARCHITECTURE §9).
 */
import type { Rect } from "@/core/scene/types"
import type { AtlasClient } from "../supabase"
import type { LocalStore } from "../localStore"
import type { AssetMeta, AssetStore, BackdropTileSource } from "./types"

export type * from "./types"

export interface AssetStoreOptions {
  client: AtlasClient | null
  store: LocalStore
  userId: string
}

export function createAssetStore(_opts: AssetStoreOptions): AssetStore {
  throw new Error("createAssetStore: not implemented")
}

export interface TileSourceOptions {
  sessionId: string
  client: AtlasClient | null
  store: LocalStore
}

export function createTileSource(_opts: TileSourceOptions): BackdropTileSource {
  throw new Error("createTileSource: not implemented")
}

export interface ImportCalibration {
  /** Grid cells the image spans horizontally / vertically. */
  cellsX: number
  cellsZ: number
  /** World placement of the image's top-left corner (feet). */
  origin: { x: number; z: number }
}

export interface ImportedImage {
  blob: Blob
  width: number
  height: number
  mime: AssetMeta["mime"]
  /** Stored px per grid cell after normalisation. */
  pxPerCell: number
  /** Pixel data at stored size for tracing floors/walls (core/scene/imageTrace). */
  pixels: { width: number; height: number; data: Uint8ClampedArray }
  /** World rect the image covers. */
  rect: Rect
}

/** Decode (huge images OK), normalise to ≤ 140 px/cell and ≤ 8192 px, encode WebP. */
export async function importMapImage(_file: Blob, _calib: ImportCalibration, _cellSize: number): Promise<ImportedImage> {
  throw new Error("importMapImage: not implemented")
}

/** Guess the grid size from a file name like "…-27x47-…" (Forgotten Adventures convention). */
export function guessGridFromName(_name: string): { cellsX: number; cellsZ: number } | null {
  throw new Error("guessGridFromName: not implemented")
}


