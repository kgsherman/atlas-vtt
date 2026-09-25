/**
 * Free assets in the UI: the catalog (loaded once per app run by the repository) and the categories a
 * new table loads (the DM's last choice in the Assets tab on this browser; all categories at first).
 */
import * as React from "react"

import { FREE_ASSET_CATEGORIES, normalizeFreeAssetCategories, type FreeAssetCategory } from "@/core/session/freeAssets"
import { parseTokenModelRef } from "@/core/scene/tokenModel"
import type { FreeAsset } from "@/net/freeAssets"

import { ServicesContext } from "./services"
import { useAsync, type AsyncState } from "./useAsync"

/** The whole catalog (idle in local mode, or outside the services provider). */
export function useFreeAssets(): AsyncState<FreeAsset[]> {
  const freeAssets = React.useContext(ServicesContext)?.freeAssets
  return useAsync(freeAssets?.available ? "free-assets" : null, () => freeAssets?.list() ?? Promise.resolve([]))
}

/** Assets of one category, in catalog order. */
export function assetsOf(list: readonly FreeAsset[] | undefined, category: FreeAssetCategory): FreeAsset[] {
  return (list ?? []).filter((a) => a.category === category)
}

const START_KEY = "atlas-vtt:start-free-assets"

export function readStartFreeAssets(): FreeAssetCategory[] {
  try {
    const raw = globalThis.localStorage?.getItem(START_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) return normalizeFreeAssetCategories(parsed)
    }
  } catch {
    // Unreadable or blocked storage: the default below.
  }
  return FREE_ASSET_CATEGORIES.map((c) => c.id)
}

export function writeStartFreeAssets(categories: readonly FreeAssetCategory[]): void {
  try {
    globalThis.localStorage?.setItem(START_KEY, JSON.stringify(normalizeFreeAssetCategories(categories)))
  } catch {
    // Storage blocked: the choice lasts for this page.
  }
}

/** Token models a picker offers: every one, or none unless `scope` (a game's categories) loads them. */
export function tokenModelChoices(list: readonly FreeAsset[] | undefined, scope: readonly FreeAssetCategory[] | null): FreeAsset[] {
  return scope === null || scope.includes("token-models") ? assetsOf(list, "token-models") : []
}

/** The catalog entry a Token.model reference names (null: unknown, or the catalog is not loaded). */
export function tokenModelAsset(list: readonly FreeAsset[] | undefined, ref: string | undefined): FreeAsset | null {
  const parsed = parseTokenModelRef(ref)
  if (!parsed) return null
  return (list ?? []).find((a) => a.category === "token-models" && a.id === parsed.assetId) ?? null
}
