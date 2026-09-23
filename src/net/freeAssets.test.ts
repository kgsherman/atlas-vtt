import { describe, expect, it } from "vitest"

import { createLocalFreeAssetsRepo, createRemoteFreeAssetsRepo, freeAssetFromRow } from "./freeAssets"
import type { AtlasClient } from "./supabase"

const row = (over: Record<string, unknown> = {}) => ({
  id: "elf-archer",
  category: "token-models",
  name: "Elf archer",
  description: "",
  path: "token-models/elf-archer.glb",
  thumbnail_path: "token-models/elf-archer.png",
  bytes: 1234,
  metadata: { lods: [3, 2, 1], height: 1.07, radius: 0.8, size: "small" },
  attribution: null,
  sort_order: 0,
  created_at: "2026-09-23T00:00:00Z",
  ...over,
})

const url = (p: string) => `https://cdn.example/free-assets/${p}`

describe("freeAssetFromRow", () => {
  it("maps a catalog row to public URLs and token model metadata", () => {
    expect(freeAssetFromRow(row(), url)).toEqual({
      id: "elf-archer",
      category: "token-models",
      name: "Elf archer",
      description: "",
      url: "https://cdn.example/free-assets/token-models/elf-archer.glb",
      thumbnailUrl: "https://cdn.example/free-assets/token-models/elf-archer.png",
      bytes: 1234,
      attribution: null,
      model: { height: 1.07, radius: 0.8, size: "small" },
    })
  })

  it("tolerates odd metadata and skips rows this app does not understand", () => {
    expect(freeAssetFromRow(row({ metadata: [], thumbnail_path: null }), url)).toMatchObject({
      thumbnailUrl: null,
      model: { height: 1, radius: 0.5, size: null },
    })
    expect(freeAssetFromRow(row({ category: "maps" }), url)).toBeNull()
    expect(freeAssetFromRow(row({ id: "Bad Id" }), url)).toBeNull()
  })
})

describe("free assets repository", () => {
  /** A client whose free_assets query returns `rows` (or fails once with `failFirst`). */
  function client(rows: unknown[], failFirst = false) {
    let calls = 0
    const query = {
      select: () => query,
      order: () => query,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        calls++
        const res = failFirst && calls === 1 ? { data: null, error: { message: "offline", code: "" } } : { data: rows, error: null }
        return Promise.resolve(res).then(resolve, reject)
      },
    }
    const c = {
      from: () => query,
      storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: url(p) } }) }) },
    }
    return { client: c as unknown as AtlasClient, calls: () => calls }
  }

  it("loads the catalog once and resolves token model references", async () => {
    const c = client([row(), row({ id: "map-1", category: "maps" })])
    const repo = createRemoteFreeAssetsRepo(c.client)
    expect((await repo.list()).map((a) => a.id)).toEqual(["elf-archer"])
    expect(await repo.tokenModelUrl("free:elf-archer")).toBe(url("token-models/elf-archer.glb"))
    expect(await repo.tokenModelUrl("free:nope")).toBeNull()
    expect(await repo.tokenModelUrl("https://evil.example/x.glb")).toBeNull()
    expect(c.calls()).toBe(1)
  })

  it("retries after a failed read", async () => {
    const c = client([row()], true)
    const repo = createRemoteFreeAssetsRepo(c.client)
    await expect(repo.list()).rejects.toBeTruthy()
    expect(await repo.list()).toHaveLength(1)
  })

  it("has no catalog in local mode", async () => {
    const repo = createLocalFreeAssetsRepo()
    expect(repo.available).toBe(false)
    expect(await repo.list()).toEqual([])
    expect(await repo.tokenModelUrl("free:elf-archer")).toBeNull()
  })
})
