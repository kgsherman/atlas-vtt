import { afterEach, describe, expect, it } from "vitest"

import { createScene } from "@/core/scene/factory"
import { parseScene } from "@/core/scene/schema"
import type { Scene } from "@/core/scene/types"
import type { AssetMeta, AssetStore } from "@/net/assets/types"
import { createMemoryStore } from "@/net/localStore"
import { readSceneFile } from "@/net/scenesRepo"

import { createServices } from "./createServices"
import { copySharedScene, createFromSample, duplicateScene, exportScene, importSceneFile, LibraryError, nextCopyName, userMessage } from "./library"
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
    async publishTiles() {},
    async grantTiles() {},
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
