/**
 * `.atlas.json` files with embedded map images (ARCHITECTURE §9 "Export").
 */
import { describe, expect, it } from "vitest"

import { createScene } from "@/core/scene/factory"
import type { Scene } from "@/core/scene/types"

import { createAssetStore } from "./assets"
import { createMemoryStore } from "./localStore"
import { exportSceneFile, exportSceneFileWithAssets, importSceneFile, importSceneFileWithAssets, readSceneFile } from "./scenesRepo"

const BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 5, 250, 251, 252])

async function sceneWithImage() {
  const assets = createAssetStore({ client: null, store: createMemoryStore(), userId: "dm" })
  const scene = createScene({ name: "Vineyard", width: 27, depth: 47 })
  const levelId = Object.keys(scene.levels)[0]
  const meta = await assets.putImage(scene.id, new Blob([BYTES], { type: "image/webp" }), { name: "First floor.webp", kind: "image", mime: "image/webp", width: 3780, height: 6580 })
  scene.assets = { [meta.id]: meta }
  scene.levels[levelId].backdrop = { assetId: meta.id, rect: { x: 0, z: 0, w: 135, d: 235 }, opacity: 1, tintWalls: false }
  return { assets, scene, meta, levelId }
}

describe(".atlas.json with embedded images", () => {
  it("embeds every image as a data URL and restores it under the fresh scene id", async () => {
    const { assets, scene, meta } = await sceneWithImage()
    const file = await exportSceneFileWithAssets(scene, assets)
    expect(file.missing).toEqual([])
    expect(JSON.parse(file.text).assetsData[meta.id]).toMatch(/^data:image\/webp;base64,/)

    const target = createAssetStore({ client: null, store: createMemoryStore(), userId: "someone-else" })
    const { parsed, restored, missing } = await importSceneFileWithAssets(file.text, target)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.scene.id).not.toBe(scene.id)
    expect(restored).toEqual([meta.id])
    expect(missing).toEqual([])
    expect(parsed.scene.assets).toEqual(scene.assets)
    const blob = await target.getImage(parsed.scene.id, meta.id)
    expect(blob?.type).toBe("image/webp")
    expect([...new Uint8Array(await blob!.arrayBuffer())]).toEqual([...BYTES])
    // Everything but the id round-trips.
    expect({ ...parsed.scene, id: scene.id }).toEqual(JSON.parse(JSON.stringify(scene)) as Scene)
  })

  it("reports images whose bytes are unavailable and keeps their metadata", async () => {
    const { assets, scene, meta } = await sceneWithImage()
    await assets.deleteImage(scene.id, meta.id)
    const file = await exportSceneFileWithAssets(scene, assets)
    expect(file.missing).toEqual([meta.id])
    const res = await importSceneFileWithAssets(file.text, createAssetStore({ client: null, store: createMemoryStore(), userId: "u" }))
    expect(res.parsed.ok).toBe(true)
    expect(res.missing).toEqual([meta.id])
    if (res.parsed.ok) expect(res.parsed.scene.assets?.[meta.id]).toEqual(meta)
  })

  it("stays compatible with files without images (both directions)", async () => {
    const plain = createScene({ name: "Plain" })
    const text = exportSceneFile(plain).text
    expect(JSON.parse(text).assetsData).toBeUndefined()
    const res = await importSceneFileWithAssets(text, createAssetStore({ client: null, store: createMemoryStore(), userId: "u" }))
    expect(res).toMatchObject({ parsed: { ok: true }, restored: [], missing: [] })
    // The synchronous importer accepts files WITH images too (they are ignored).
    const { assets, scene } = await sceneWithImage()
    const withImages = (await exportSceneFileWithAssets(scene, assets)).text
    expect(importSceneFile(withImages).ok).toBe(true)
  })

  it("drops embedded data that is not a referenced, well-formed image", async () => {
    const { assets, scene, meta } = await sceneWithImage()
    const doc = JSON.parse((await exportSceneFileWithAssets(scene, assets)).text)
    doc.assetsData.unreferenced = doc.assetsData[meta.id]
    doc.assetsData.script = "data:text/html;base64,PHNjcmlwdD4="
    const { parsed, assetsData } = readSceneFile(JSON.stringify(doc))
    expect(parsed.ok).toBe(true)
    expect(Object.keys(assetsData)).toEqual([meta.id])
    // A non-image under a referenced id is treated as missing.
    doc.assetsData[meta.id] = "data:image/svg+xml;base64,PHN2Zz4="
    const res = await importSceneFileWithAssets(JSON.stringify(doc), createAssetStore({ client: null, store: createMemoryStore(), userId: "u" }))
    expect(res.missing).toEqual([meta.id])
  })

  it("still rejects invalid documents", async () => {
    expect(readSceneFile('{"assetsData": {}}').parsed.ok).toBe(false)
    const res = await importSceneFileWithAssets("{not json", createAssetStore({ client: null, store: createMemoryStore(), userId: "u" }))
    expect(res.parsed).toMatchObject({ ok: false, error: "invalid" })
  })
})
