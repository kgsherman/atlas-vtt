/**
 * Free asset categories (ARCHITECTURE §6.4): groups of free files a DM can load into a game when
 * starting it (GameState.freeAssets, create_session's `p_free_assets`). Keep in step with
 * private.free_asset_categories() and the free_assets.category check (migration *_free_assets.sql).
 */

export type FreeAssetCategory = "token-models"

export interface FreeAssetCategoryInfo {
  id: FreeAssetCategory
  label: string
  description: string
}

/** Every category, in display order. */
export const FREE_ASSET_CATEGORIES: readonly FreeAssetCategoryInfo[] = [
  { id: "token-models", label: "Token models", description: "3D miniatures to stand on your tokens." },
]

const KNOWN = new Set<string>(FREE_ASSET_CATEGORIES.map((c) => c.id))

export function isFreeAssetCategory(v: unknown): v is FreeAssetCategory {
  return typeof v === "string" && KNOWN.has(v)
}

/** Known categories only, each once, sorted (the order create_session stores them in). */
export function normalizeFreeAssetCategories(list: readonly unknown[]): FreeAssetCategory[] {
  return [...new Set(list.filter(isFreeAssetCategory))].sort()
}
