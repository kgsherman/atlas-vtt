import { describe, expect, it } from "vitest"

import { backdropFolders, levelImageKey } from "./host"

describe("DM view backdrops", () => {
  it("looks images up under the document, its library row, then the session's first row", () => {
    expect(backdropFolders("doc", "row-b", "row-a")).toEqual([
      "doc",
      "row-b",
      "row-a",
    ])
    // After a map change the session row still names the first map: tried last.
    expect(backdropFolders("doc-b", "row-b", "row-a")[0]).toBe("doc-b")
    // Unknown (not looked up yet, none) and repeated ids are left out.
    expect(backdropFolders("doc", null, undefined)).toEqual(["doc"])
    expect(backdropFolders("doc", undefined, "row")).toEqual(["doc", "row"])
    expect(backdropFolders("doc", "row", "row")).toEqual(["doc", "row"])
    expect(backdropFolders("doc", "doc", "")).toEqual(["doc"])
  })

  it("keys a level's image by document, so a duplicated map's same level reloads", () => {
    const b = {
      assetId: "map",
      rect: { x: 0, z: 0, w: 70, d: 40 },
      opacity: 0.9,
      tintWalls: true,
    }
    const key = levelImageKey("doc-a", b)
    expect(levelImageKey("doc-a", structuredClone(b))).toBe(key)
    // Same level id, asset and placement on a duplicate: another key.
    expect(levelImageKey("doc-b", b)).not.toBe(key)
    // Anything drawn differently: another key.
    expect(levelImageKey("doc-a", { ...b, assetId: "map2" })).not.toBe(key)
    expect(
      levelImageKey("doc-a", { ...b, rect: { ...b.rect, x: 5 } })
    ).not.toBe(key)
    expect(levelImageKey("doc-a", { ...b, opacity: 1 })).not.toBe(key)
    expect(levelImageKey("doc-a", { ...b, tintWalls: false })).not.toBe(key)
  })
})
