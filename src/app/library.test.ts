import { afterEach, describe, expect, it, vi } from "vitest"

import { createScene } from "@/core/scene/factory"
import { parseScene } from "@/core/scene/schema"
import type { Scene } from "@/core/scene/types"
import type { AssetMeta, AssetStore } from "@/net/assets/types"
import { createMemoryStore } from "@/net/localStore"
import { readSceneFile } from "@/net/scenesRepo"
import { isNetError } from "@/net/supabase"

import { createServices } from "./createServices"
import {
  copySharedScene,
  createFromSample,
  deleteScene,
  duplicateScene,
  exportScene,
  IMAGE_SWEEP_INTERVAL_MS,
  importedName,
  importSceneFile,
  LibraryError,
  loadLibraryScene,
  nextCopyName,
  sweepUnusedImages,
  userMessage,
} from "./library"
import type { AppServices } from "./services"

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 250])

/** In-memory AssetStore keyed by `${sceneId}/${assetId}`. */
function fakeAssets(): AssetStore & { blobs: Map<string, Blob>; calls: string[] } {
  const blobs = new Map<string, Blob>()
  const calls: string[] = []
  return {
    mode: "local",
    blobs,
    calls,
    async putImage(sceneId, blob, meta) {
      const id = meta.id ?? "generated"
      calls.push(`put ${sceneId}/${id}`)
      blobs.set(`${sceneId}/${id}`, blob)
      const out: AssetMeta = { id, kind: meta.kind, name: meta.name, mime: meta.mime, width: meta.width, height: meta.height, bytes: blob.size }
      return out
    },
    async getImage(sceneId, assetId) {
      return blobs.get(`${sceneId}/${assetId}`) ?? null
    },
    async deleteImage(sceneId, assetId) {
      blobs.delete(`${sceneId}/${assetId}`)
    },
    async copyImages(from, to, ids) {
      calls.push(`copy ${from}->${to} ${ids.join(",")}`)
      for (const id of ids) {
        const b = blobs.get(`${from}/${id}`)
        if (b) blobs.set(`${to}/${id}`, b)
      }
    },
    async putTileChunk() {},
    async deleteTileChunks() {},
    async removeSessionTiles() {
      return 0
    },
    async deleteSceneImages(sceneId) {
      calls.push(`delete ${sceneId}`)
      let n = 0
      for (const key of [...blobs.keys()])
        if (key.startsWith(`${sceneId}/`)) {
          blobs.delete(key)
          n++
        }
      return n
    },
    async sweepUnreferencedImages() {
      calls.push("sweep")
      return { removed: 0, bytes: 0 }
    },
  }
}

function sceneWithBackdrop(): Scene {
  const scene = createScene({ name: "Vineyard", width: 10, depth: 10 })
  const level = Object.values(scene.levels)[0]
  scene.assets = { map1: { id: "map1", kind: "image", name: "ground.webp", mime: "image/png", width: 1400, height: 1400, bytes: PNG_BYTES.length } }
  level.backdrop = { assetId: "map1", rect: { x: 0, z: 0, w: 50, d: 50 }, opacity: 1, tintWalls: false }
  const ok = parseScene(JSON.parse(JSON.stringify(scene)))
  if (!ok.ok) throw new Error(`fixture invalid: ${JSON.stringify(ok.issues)}`)
  return scene
}

let services: AppServices | null = null

async function localServices(): Promise<AppServices & { assets: ReturnType<typeof fakeAssets> }> {
  const s = await createServices({ mode: "local", store: createMemoryStore() })
  const withAssets = { ...s, assets: fakeAssets() }
  services = withAssets
  return withAssets
}

afterEach(async () => {
  await services?.transport.dispose()
  services = null
})

describe("nextCopyName", () => {
  it("numbers copies and never stacks suffixes", () => {
    expect(nextCopyName("Keep", [])).toBe("Keep (copy)")
    expect(nextCopyName("Keep", ["Keep (copy)"])).toBe("Keep (copy 2)")
    expect(nextCopyName("Keep (copy)", ["Keep (copy)", "Keep (copy 2)"])).toBe("Keep (copy 3)")
  })
})

describe("importedName", () => {
  it("keeps new names and suffixes names already in the library", () => {
    expect(importedName("Keep", ["Other"])).toBe("Keep")
    expect(importedName("Keep", ["Keep"])).toBe("Keep (imported)")
    expect(importedName("Keep", ["Keep", "Keep (imported)"])).toBe("Keep (imported 2)")
    expect(importedName("Keep (imported)", ["Keep (imported)"])).toBe("Keep (imported 2)")
  })
})

describe("atlas files", () => {
  it("embeds map images and restores them on import (format shared with net/scenesRepo)", async () => {
    const s = await localServices()
    const scene = sceneWithBackdrop()
    await s.assets.putImage(scene.id, new Blob([PNG_BYTES], { type: "image/png" }), {
      id: "map1",
      kind: "image",
      name: "ground.webp",
      mime: "image/png",
      width: 1400,
      height: 1400,
    })
    const summary = await s.scenes.create(scene)
    const file = await exportScene(s, summary)
    expect(file.fileName).toBe("vineyard.atlas.json")
    const json = JSON.parse(file.text)
    json.assetsData.stray = json.assetsData.map1
    json.assetsData.bad = "javascript:alert(1)"
    const parsed = readSceneFile(JSON.stringify(json))
    expect(parsed.parsed.ok).toBe(true)
    expect(Object.keys(parsed.assetsData)).toEqual(["map1"])
  })

  it("rejects invalid and too-new files", async () => {
    const s = await localServices()
    await expect(importSceneFile(s, new Blob(["{nope"]))).rejects.toThrow("not a valid Atlas scene")
    const tooNew = JSON.stringify({ ...createScene(), schemaVersion: 999 })
    await expect(importSceneFile(s, new Blob([tooNew]))).rejects.toThrow("newer version")
  })
})

describe("library operations", () => {
  it("creates a copy of a sample", async () => {
    const s = await localServices()
    const { summary } = await createFromSample(s, "crooked-lantern")
    expect(summary.name).toBe("The Crooked Lantern")
    const loaded = await s.scenes.load(summary.id)
    expect(loaded.parsed.ok && Object.keys(loaded.parsed.scene.levels).length).toBe(4)
    await expect(createFromSample(s, "nope")).rejects.toBeInstanceOf(LibraryError)
  })

  it("duplicates a scene with a fresh document id and its images", async () => {
    const s = await localServices()
    const scene = sceneWithBackdrop()
    await s.assets.putImage(scene.id, new Blob([PNG_BYTES], { type: "image/png" }), {
      id: "map1",
      kind: "image",
      name: "ground.webp",
      mime: "image/png",
      width: 1400,
      height: 1400,
    })
    const original = await s.scenes.create(scene)
    const { summary, warnings } = await duplicateScene(s, original, ["Vineyard"])
    expect(warnings).toEqual([])
    expect(summary.name).toBe("Vineyard (copy)")
    const loaded = await s.scenes.load(summary.id)
    if (!loaded.parsed.ok) throw new Error("copy did not load")
    expect(loaded.parsed.scene.id).not.toBe(scene.id)
    expect(s.assets.calls).toContain(`copy ${scene.id}->${loaded.parsed.scene.id} map1`)
    expect(s.assets.blobs.has(`${loaded.parsed.scene.id}/map1`)).toBe(true)
  })

  it("exports with embedded images and imports them back", async () => {
    const s = await localServices()
    const scene = sceneWithBackdrop()
    await s.assets.putImage(scene.id, new Blob([PNG_BYTES], { type: "image/png" }), {
      id: "map1",
      kind: "image",
      name: "ground.webp",
      mime: "image/png",
      width: 1400,
      height: 1400,
    })
    const summary = await s.scenes.create(scene)
    const file = await exportScene(s, summary)
    expect(file.warnings).toEqual([])
    expect(JSON.parse(file.text).assetsData.map1).toMatch(/^data:image\/png;base64,/)

    const imported = await importSceneFile(s, new Blob([file.text], { type: "application/json" }))
    expect(imported.warnings).toEqual([])
    const loaded = await s.scenes.load(imported.summary.id)
    if (!loaded.parsed.ok) throw new Error("import did not load")
    const newId = loaded.parsed.scene.id
    expect(newId).not.toBe(scene.id)
    const blob = await s.assets.getImage(newId, "map1")
    expect(blob && new Uint8Array(await blob.arrayBuffer())).toEqual(PNG_BYTES)
  })

  it("warns about images missing from an import or an export", async () => {
    const s = await localServices()
    const scene = sceneWithBackdrop()
    const summary = await s.scenes.create(scene)
    const file = await exportScene(s, summary)
    expect(file.warnings).toEqual(["1 map image could not be included."])
    const imported = await importSceneFile(s, new Blob([file.text]))
    expect(imported.warnings).toEqual(["1 map image is not included in the file."])
  })

  it("rejects invalid imports with details", async () => {
    const s = await localServices()
    const err = await importSceneFile(s, new Blob(["{}"])).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LibraryError)
    expect(userMessage(err)).toBe("This file is not a valid Atlas scene.")
    expect((err as LibraryError).details.length).toBeGreaterThan(0)
  })

  it("copies shared scenes without the owner's map images", async () => {
    const s = await localServices()
    const scene = sceneWithBackdrop()
    const { summary, warnings } = await copySharedScene(s, {
      name: "Shared Vineyard",
      version: 3,
      schemaVersion: 1,
      parsed: { ok: true, scene, migratedFrom: null },
    })
    expect(summary.name).toBe("Shared Vineyard")
    expect(warnings).toHaveLength(1)
    const loaded = await s.scenes.load(summary.id)
    if (!loaded.parsed.ok) throw new Error("copy did not load")
    expect(loaded.parsed.scene.assets).toBeUndefined()
    expect(Object.values(loaded.parsed.scene.levels).every((l) => !l.backdrop)).toBe(true)
    expect(loaded.parsed.scene.id).not.toBe(scene.id)
  })
})

describe("loadLibraryScene", () => {
  it("loads the latest version with the origin to record", async () => {
    const s = await localServices()
    const scene = createScene({ name: "Keep", width: 10, depth: 10 })
    const summary = await s.scenes.create(scene)
    const first = await loadLibraryScene(s, summary.id)
    expect(first.origin).toEqual({ sceneId: summary.id, version: 1, dirty: false })
    expect(first.scene.id).toBe(scene.id)
    expect(first.name).toBe("Keep")

    // A version saved meanwhile (e.g. in the editor): the origin follows it, the name follows the row.
    await s.scenes.saveVersion(summary.id, { ...scene, name: "Keep (ruined)" })
    const second = await loadLibraryScene(s, summary.id)
    expect(second.origin).toEqual({ sceneId: summary.id, version: 2, dirty: false })
    expect(second.name).toBe("Keep (ruined)")
    expect(second.scene.name).toBe("Keep (ruined)")
  })

  it("refuses documents from a newer version of Atlas and invalid ones", async () => {
    const s = await localServices()
    const scene = createScene({ name: "Keep" })
    const summary = await s.scenes.create(scene)
    await s.scenes.saveVersion(summary.id, { ...scene, schemaVersion: 999 } as unknown as Scene)
    const tooNew = await loadLibraryScene(s, summary.id).catch((e: unknown) => e)
    expect(tooNew).toBeInstanceOf(LibraryError)
    expect(userMessage(tooNew)).toMatch(/newer version of Atlas, so it can't be played here/)

    await s.scenes.saveVersion(summary.id, { ...scene, levels: "nope" } as unknown as Scene)
    const invalid = await loadLibraryScene(s, summary.id).catch((e: unknown) => e)
    expect(invalid).toBeInstanceOf(LibraryError)
    expect(userMessage(invalid)).toBe("This scene's data is not valid, so it can't be played.")
  })

  it("reports a row deleted meanwhile as not found", async () => {
    const s = await localServices()
    const summary = await s.scenes.create(createScene())
    await s.scenes.remove(summary.id)
    const err = await loadLibraryScene(s, summary.id).catch((e: unknown) => e)
    expect(isNetError(err, "not_found")).toBe(true)
  })

  it("loads a sample's library copy", async () => {
    const s = await localServices()
    const { summary } = await createFromSample(s, "crooked-lantern")
    const played = await loadLibraryScene(s, summary.id)
    expect(played.origin).toEqual({ sceneId: summary.id, version: 1, dirty: false })
    expect(played.name).toBe("The Crooked Lantern")
    expect(Object.keys(played.scene.levels)).toHaveLength(4)
  })
})

describe("map image cleanup", () => {
  const storeMap = (s: Awaited<ReturnType<typeof localServices>>, scene: Scene) =>
    s.assets.putImage(scene.id, new Blob([PNG_BYTES], { type: "image/png" }), {
      id: "map1",
      kind: "image",
      name: "ground.webp",
      mime: "image/png",
      width: 1400,
      height: 1400,
    })

  it("deleting a scene removes its map images", async () => {
    const s = await localServices()
    const scene = sceneWithBackdrop()
    await storeMap(s, scene)
    const summary = await s.scenes.create(scene)
    const { warnings } = await deleteScene(s, summary)
    expect(warnings).toEqual([])
    expect(await s.scenes.get(summary.id)).toBeNull()
    expect(s.assets.blobs.has(`${scene.id}/map1`)).toBe(false)
  })

  it("deleting a scene also removes images only older versions used, never another scene's", async () => {
    const s = await localServices()
    const scene = sceneWithBackdrop()
    await storeMap(s, scene)
    // An image an older version used (the latest no longer references it).
    s.assets.blobs.set(`${scene.id}/old-map`, new Blob([PNG_BYTES]))
    const summary = await s.scenes.create(scene)
    const other = sceneWithBackdrop()
    await storeMap(s, other)
    await s.scenes.create(other)
    await deleteScene(s, summary)
    expect(s.assets.calls).toContain(`delete ${scene.id}`)
    expect(s.assets.blobs.has(`${scene.id}/old-map`)).toBe(false)
    expect(s.assets.blobs.has(`${scene.id}/map1`)).toBe(false)
    expect(s.assets.blobs.has(`${other.id}/map1`)).toBe(true)
  })

  it("deletes the scene and keeps its images when the unused folders can't be determined", async () => {
    const s = await localServices()
    const scene = sceneWithBackdrop()
    await storeMap(s, scene)
    const summary = await s.scenes.create(scene)
    const flaky = { ...s, scenes: { ...s.scenes, imageFoldersToFree: async () => Promise.reject(new Error("offline")) } }
    expect(await deleteScene(flaky, summary)).toEqual({ warnings: [] })
    expect(await s.scenes.get(summary.id)).toBeNull()
    expect(s.assets.blobs.has(`${scene.id}/map1`)).toBe(true)
  })

  it("imports the scene when the image store fails part-way, keeping the images already stored", async () => {
    const s = await localServices()
    const scene = sceneWithBackdrop()
    scene.assets!.map2 = { ...scene.assets!.map1, id: "map2", name: "upper.webp" }
    await storeMap(s, scene)
    await s.assets.putImage(scene.id, new Blob([PNG_BYTES], { type: "image/png" }), {
      id: "map2",
      kind: "image",
      name: "upper.webp",
      mime: "image/png",
      width: 1400,
      height: 1400,
    })
    const file = await exportScene(s, await s.scenes.create(scene))
    const put = s.assets.putImage.bind(s.assets)
    let puts = 0
    s.assets.putImage = async (...args) => {
      if (++puts > 1) throw new Error("quota full")
      return put(...args)
    }
    const imported = await importSceneFile(s, new Blob([file.text]))
    expect(imported.warnings).toEqual(["Map images could not be stored: quota full"])
    const loaded = await s.scenes.load(imported.summary.id)
    if (!loaded.parsed.ok) throw new Error("import did not load")
    // Same document id as the images stored before the failure.
    expect(s.assets.blobs.has(`${loaded.parsed.scene.id}/map1`)).toBe(true)
  })

  it("ends the map's table with it, and its images go too", async () => {
    const s = await localServices()
    const scene = sceneWithBackdrop()
    await storeMap(s, scene)
    const summary = await s.scenes.create(scene)
    const table = await s.sessions.openMap(summary.id)
    await deleteScene(s, summary)
    expect(await s.scenes.get(summary.id)).toBeNull()
    expect((await s.sessions.sessionInfo(table.sessionId))?.status).toBe("ended")
    expect(s.assets.blobs.has(`${scene.id}/map1`)).toBe(false)
  })

  it("an import that fails to create the scene removes the images it stored", async () => {
    const s = await localServices()
    const scene = sceneWithBackdrop()
    await storeMap(s, scene)
    const file = await exportScene(s, await s.scenes.create(scene))
    const failing = { ...s, scenes: { ...s.scenes, create: async () => Promise.reject(new Error("quota")) } }
    const before = new Set(s.assets.blobs.keys())
    await expect(importSceneFile(failing, new Blob([file.text]))).rejects.toThrow("quota")
    expect(new Set(s.assets.blobs.keys())).toEqual(before)
  })

  it("imports a scene whose name is taken under a suffixed name", async () => {
    const s = await localServices()
    const scene = sceneWithBackdrop()
    const file = await exportScene(s, await s.scenes.create(scene))
    const imported = await importSceneFile(s, new Blob([file.text]))
    expect(imported.summary.name).toBe("Vineyard (imported)")
  })
})

describe("sweepUnusedImages", () => {
  const memoryStorage = () => {
    const m = new Map<string, string>()
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("sweeps at most once per interval, on Supabase only, and never throws", async () => {
    vi.stubGlobal("localStorage", memoryStorage())
    const assets = fakeAssets()
    expect(await sweepUnusedImages({ mode: "local", assets }, 1000)).toBeNull()
    expect(assets.calls).toEqual([])
    const remote = { mode: "supabase" as const, assets }
    expect(await sweepUnusedImages(remote, 1000)).toEqual({ removed: 0, bytes: 0 })
    expect(await sweepUnusedImages(remote, 2000)).toBeNull()
    expect(assets.calls).toEqual(["sweep"])
    expect(await sweepUnusedImages(remote, 1000 + IMAGE_SWEEP_INTERVAL_MS)).not.toBeNull()
    expect(assets.calls).toEqual(["sweep", "sweep"])
    assets.sweepUnreferencedImages = async () => Promise.reject(new Error("offline"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(await sweepUnusedImages(remote, 1000 + 2 * IMAGE_SWEEP_INTERVAL_MS)).toBeNull()
    warn.mockRestore()
  })

  it("skips without browser storage", async () => {
    vi.stubGlobal("localStorage", undefined)
    const assets = fakeAssets()
    expect(await sweepUnusedImages({ mode: "supabase", assets })).toBeNull()
    expect(assets.calls).toEqual([])
  })
})
