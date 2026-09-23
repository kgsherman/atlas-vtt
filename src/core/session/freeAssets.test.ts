import { describe, expect, it } from "vitest"

import { FREE_ASSET_CATEGORIES, isFreeAssetCategory, normalizeFreeAssetCategories } from "./freeAssets"

describe("free asset categories", () => {
  it("lists every category once", () => {
    const ids = FREE_ASSET_CATEGORIES.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(isFreeAssetCategory(id)).toBe(true)
  })

  it("normalises to known categories, each once, sorted", () => {
    expect(normalizeFreeAssetCategories(["token-models", "maps", 3, null, "token-models"])).toEqual(["token-models"])
    expect(normalizeFreeAssetCategories([])).toEqual([])
    expect(isFreeAssetCategory("__proto__")).toBe(false)
  })
})
