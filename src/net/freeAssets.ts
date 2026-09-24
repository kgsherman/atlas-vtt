/**
 * The free asset catalog (ARCHITECTURE §6.4): public.free_assets rows, whose files live in the PUBLIC
 * Storage bucket `free-assets`, so any client (a player too) can load them by URL without a grant.
 * The catalog is read once per app run and cached; a failed read is retried on the next call.
 *
 * Local mode has no catalog (`available` false): free assets need Atlas Cloud.
 *
 * Token parts (ARCHITECTURE §11) are files in the bucket's `token/` folder that the Token Maker offers as starting
 * layers (a background disc and a ring). They are not catalog rows: they are not loaded into games,
 * and the Token Maker offers them all, whatever game it is used with.
 */
import type { FreeAssetCategory } from "@/core/session/freeAssets"
import { isFreeAssetCategory } from "@/core/session/freeAssets"
import { FREE_ASSET_ID_RE, parseTokenModelRef } from "@/core/scene/tokenModel"
import type { CreatureSize } from "@/core/scene/types"

import type { Database } from "./database.types"
import { unwrap, type AtlasClient } from "./supabase"

export const FREE_ASSETS_BUCKET = "free-assets"

export interface FreeAsset {
  id: string
  category: FreeAssetCategory
  name: string
  description: string
  /** Public URL of the file. */
  url: string
  thumbnailUrl: string | null
  bytes: number
  /** Creator / licence credit to show with the asset (null = none required). */
  attribution: string | null
  /** Token models: figure size in footprint sides, and the creature size it was sculpted for. */
  model?: { height: number; radius: number; size: CreatureSize | null }
}

/** A free Token Maker layer: the file's public URL and the role it is added with. */
export interface FreeTokenPart {
  id: string
  role: "background" | "frame"
  name: string
  url: string
}

/** Token parts in the `free-assets` bucket (object paths at its root). */
export const FREE_TOKEN_PARTS: ReadonlyArray<Omit<FreeTokenPart, "url"> & { path: string }> = [
  { id: "token-bg", role: "background", name: "Slate backdrop", path: "token/token-bg.png" },
  { id: "token-frame", role: "frame", name: "Stone ring", path: "token/token-frame.png" },
]

export interface FreeAssetsRepo {
  /** false in local mode: there is no catalog. */
  readonly available: boolean
  /** Every asset, by category, then catalog order. */
  list(): Promise<FreeAsset[]>
  /** Public URL of a token model reference (`free:<id>`), or null when it names no token model. */
  tokenModelUrl(ref: string): Promise<string | null>
  /** The Token Maker's free parts (none in local mode). */
  tokenParts(): FreeTokenPart[]
}

type Row = Database["public"]["Tables"]["free_assets"]["Row"]

const SIZES: readonly CreatureSize[] = ["tiny", "small", "medium", "large", "huge", "gargantuan"]

const finite = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback)

/** A catalog row as an asset, or null for rows this app does not understand (unknown category, bad id). */
export function freeAssetFromRow(row: Row, publicUrl: (path: string) => string): FreeAsset | null {
  if (!isFreeAssetCategory(row.category) || !FREE_ASSET_ID_RE.test(row.id)) return null
  const asset: FreeAsset = {
    id: row.id,
    category: row.category,
    name: row.name,
    description: row.description,
    url: publicUrl(row.path),
    thumbnailUrl: row.thumbnail_path ? publicUrl(row.thumbnail_path) : null,
    bytes: row.bytes,
    attribution: row.attribution,
  }
  if (row.category === "token-models") {
    const m = typeof row.metadata === "object" && row.metadata !== null && !Array.isArray(row.metadata) ? row.metadata : {}
    const size = SIZES.find((s) => s === m.size) ?? null
    asset.model = { height: finite(m.height, 1), radius: finite(m.radius, 0.5), size }
  }
  return asset
}

export function createRemoteFreeAssetsRepo(client: AtlasClient): FreeAssetsRepo {
  let cached: Promise<FreeAsset[]> | null = null
  const publicUrl = (path: string) => client.storage.from(FREE_ASSETS_BUCKET).getPublicUrl(path).data.publicUrl
  const list = (): Promise<FreeAsset[]> => {
    cached ??= (async () => {
      const rows = unwrap(await client.from("free_assets").select("*").order("category").order("sort_order").order("id"))
      return (rows ?? []).map((r) => freeAssetFromRow(r, publicUrl)).filter((a): a is FreeAsset => a !== null)
    })().catch((err: unknown) => {
      cached = null
      throw err
    })
    return cached
  }
  return {
    available: true,
    list,
    async tokenModelUrl(ref) {
      const parsed = parseTokenModelRef(ref)
      if (!parsed) return null
      const asset = (await list()).find((a) => a.id === parsed.assetId && a.category === "token-models")
      return asset?.url ?? null
    },
    tokenParts: () => FREE_TOKEN_PARTS.map(({ path, ...part }) => ({ ...part, url: publicUrl(path) })),
  }
}

export function createLocalFreeAssetsRepo(): FreeAssetsRepo {
  return {
    available: false,
    list: async () => [],
    tokenModelUrl: async () => null,
    tokenParts: () => [],
  }
}
