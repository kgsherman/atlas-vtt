import { afterEach, describe, expect, it, vi } from "vitest"

import { createMemoryStore, saveDraft, type LocalStore } from "../localStore"
import type { AtlasClient } from "../supabase"
import { createAssetStore, createTileSource } from "./index"
import { LOCAL_ASSET_STORE, localAssetKey } from "./localAssets"
import { chunkPath } from "./chunks"
import { assetPath, removeSessionTiles, storageStatus } from "./supabaseAssets"

const SID = "0b0e9c1c-43b1-4e1b-9a53-0d1f5a0f0c11"
const UID = "5f7e3c1a-2b4d-4c6e-8f10-1a2b3c4d5e6f"

describe("local asset store", () => {
  it("puts, gets, copies and deletes images per scene", async () => {
    const store = createMemoryStore()
    const assets = createAssetStore({ client: null, store, userId: "local-user" })
    expect(assets.mode).toBe("local")
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/webp" })
    const meta = await assets.putImage("sceneA", blob, { name: "Cellar.webp", kind: "image", mime: "image/webp", width: 10, height: 20 })
    expect(meta).toMatchObject({ kind: "image", name: "Cellar.webp", mime: "image/webp", width: 10, height: 20, bytes: 4 })
    expect(meta.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    const back = await assets.getImage("sceneA", meta.id)
    expect(back?.type).toBe("image/webp")
    expect([...new Uint8Array(await back!.arrayBuffer())]).toEqual([1, 2, 3, 4])
    // Stored under the asset prefix of the sessions object store (not visible to the session repo's prefixes).
    expect(await store.keys(LOCAL_ASSET_STORE, "asset:")).toEqual([localAssetKey("sceneA", meta.id)])

    await assets.copyImages("sceneA", "sceneB", [meta.id])
    expect(await assets.getImage("sceneB", meta.id)).not.toBeNull()
    await assets.deleteImage("sceneA", meta.id)
    expect(await assets.getImage("sceneA", meta.id)).toBeNull()
    await expect(assets.copyImages("sceneA", "sceneC", [meta.id])).rejects.toMatchObject({ code: "not_found" })
  })

  it("keeps a given id and rejects unsafe ids", async () => {
    const assets = createAssetStore({ client: null, store: createMemoryStore(), userId: "u" })
    const blob = new Blob([new Uint8Array([9])], { type: "image/png" })
    expect((await assets.putImage("s1", blob, { id: "fixed_ID-1", name: "a", kind: "image", mime: "image/png", width: 1, height: 1 })).id).toBe("fixed_ID-1")
    await expect(assets.putImage("../evil", blob, { name: "a", kind: "image", mime: "image/png", width: 1, height: 1 })).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(assets.putImage("s1", blob, { id: "a/b", name: "a", kind: "image", mime: "image/png", width: 1, height: 1 })).rejects.toMatchObject({ code: "invalid_argument" })
  })

  it("treats tile chunks as no-ops (players crop locally)", async () => {
    const assets = createAssetStore({ client: null, store: createMemoryStore(), userId: "u" })
    await expect(assets.putTileChunk(SID, UID, "L1", 0, 0, new Blob([]))).resolves.toBeUndefined()
    expect(await assets.removeSessionTiles(SID)).toBe(0)
  })

  it("deletes a scene's image folder and sweeps images nothing references", async () => {
    const store = createMemoryStore()
    const assets = createAssetStore({ client: null, store, userId: "u" })
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" })
    const put = (doc: string, id: string) => assets.putImage(doc, blob, { id, name: id, kind: "image", mime: "image/webp", width: 1, height: 1 })
    for (const [doc, id] of [["docA", "a1"], ["docA", "a2"], ["docB", "b1"], ["docC", "c1"], ["docD", "d1"], ["docE", "e1"]]) await put(doc, id)
    // docA v1 uses a1 (a2 is an orphan); docB is in an active session; docC only in an ended one;
    // docD only in an editor draft; docE nowhere.
    await store.put("sceneVersions", "row1:000000001", { version: 1, schemaVersion: 1, createdAt: "", data: { id: "docA", assets: { a1: {} } } })
    await store.put("sessions", "s:sess1", { id: "sess1", status: "active", sceneId: "row2" })
    await store.put("sessions", "state:sess1", { epoch: 0, state: { kind: "seed", scene: { id: "docB", assets: { b1: {} } } } })
    await store.put("sessions", "s:sess2", { id: "sess2", status: "ended", sceneId: "row3" })
    await store.put("sessions", "state:sess2", { epoch: 0, state: { scene: { id: "docC", assets: { c1: {} } } } })
    await saveDraft(store, "editor:unsaved:docD", { scene: { id: "docD", assets: {} }, libraryId: null, baseVersion: null })
    expect(await assets.sweepUnreferencedImages!()).toEqual({ removed: 3, bytes: 9 })
    const left = async (s: LocalStore) => (await s.keys(LOCAL_ASSET_STORE, "asset:")).map((k) => k.slice(6)).sort()
    expect(await left(store)).toEqual(["docA:a1", "docB:b1", "docD:d1"])
    expect(await assets.deleteSceneImages!("docA")).toBe(1)
    expect(await left(store)).toEqual(["docB:b1", "docD:d1"])
    await expect(assets.deleteSceneImages!("../x")).rejects.toMatchObject({ code: "invalid_argument" })
  })

  it("local tile source returns null without a session state", async () => {
    const tiles = createTileSource({ sessionId: SID, userId: UID, client: null, store: createMemoryStore() })
    expect(await tiles.getTile("L1", { i: 0, j: 0 })).toBeNull()
    tiles.dispose()
  })
})

// ---------------------------------------------------------------------------
// Supabase store against a fake client
// ---------------------------------------------------------------------------

interface Call {
  bucket: string
  op: string
  args: unknown[]
}

function fakeClient(objects: Map<string, Blob>, opts: { rpcError?: unknown; rpcData?: (fn: string, args: Record<string, unknown>) => unknown; uploadError?: unknown } = {}) {
  const calls: Call[] = []
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = []
  const missing = { status: 400, statusCode: "404", message: "Object not found", __isStorageError: true }
  const client = {
    storage: {
      from(bucket: string) {
        const key = (p: string) => `${bucket}:${p}`
        return {
          async upload(path: string, blob: Blob, o: unknown) {
            calls.push({ bucket, op: "upload", args: [path, o] })
            if (opts.uploadError) return { data: null, error: opts.uploadError }
            objects.set(key(path), blob)
            return { data: { path }, error: null }
          },
          async list(folder: string, o?: { limit?: number; offset?: number }) {
            calls.push({ bucket, op: "list", args: [folder] })
            const prefix = `${bucket}:${folder}/`
            const names = new Map<string, number | null>()
            for (const [k, b] of objects) {
              if (!k.startsWith(prefix)) continue
              const rest = k.slice(prefix.length)
              const slash = rest.indexOf("/")
              if (slash < 0) names.set(rest, b.size)
              else names.set(rest.slice(0, slash), null)
            }
            const all = [...names].map(([name, size]) => (size === null ? { name, id: null, metadata: null } : { name, id: `id-${name}`, metadata: { size } }))
            const from = o?.offset ?? 0
            return { data: all.slice(from, from + (o?.limit ?? 100)), error: null }
          },
          async download(path: string, o?: unknown) {
            calls.push({ bucket, op: "download", args: [path, o] })
            const b = objects.get(key(path))
            return b ? { data: b, error: null } : { data: null, error: missing }
          },
          async remove(paths: string[]) {
            calls.push({ bucket, op: "remove", args: [paths] })
            for (const p of paths) objects.delete(key(p))
            return { data: [], error: null }
          },
          async copy(from: string, to: string) {
            calls.push({ bucket, op: "copy", args: [from, to] })
            const b = objects.get(key(from))
            if (!b) return { data: null, error: missing }
            objects.set(key(to), b)
            return { data: { path: to }, error: null }
          },
        }
      },
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args })
      return opts.rpcError ? { data: null, error: opts.rpcError } : { data: opts.rpcData?.(fn, args) ?? null, error: null }
    },
  }
  return { client: client as unknown as AtlasClient, calls, rpcCalls }
}

describe("supabase asset store", () => {
  it("stores images in the owner's folder and finds them by extension", async () => {
    const objects = new Map<string, Blob>()
    const { client, calls } = fakeClient(objects)
    const assets = createAssetStore({ client, store: createMemoryStore(), userId: UID })
    expect(assets.mode).toBe("supabase")
    const png = new Blob([new Uint8Array([7, 7])], { type: "image/png" })
    const meta = await assets.putImage("scene1", png, { id: "img1", name: "Basement.png", kind: "image", mime: "image/png", width: 3780, height: 6580 })
    expect(meta.bytes).toBe(2)
    expect(calls[0]).toMatchObject({ bucket: "scene-assets", op: "upload", args: [`${UID}/scene1/img1.png`, { contentType: "image/png", upsert: true }] })
    // getImage tries .webp first, then .png.
    const back = await assets.getImage("scene1", "img1")
    expect(back).not.toBeNull()
    expect(calls.filter((c) => c.op === "download").map((c) => c.args[0])).toEqual([`${UID}/scene1/img1.webp`, `${UID}/scene1/img1.png`])
    expect(await assets.getImage("scene1", "nope")).toBeNull()
    await assets.copyImages("scene1", "scene2", ["img1"])
    expect(objects.has(`scene-assets:${assetPath(UID, "scene2", "img1", "image/png")}`)).toBe(true)
    await assets.deleteImage("scene1", "img1")
    expect(objects.has(`scene-assets:${UID}/scene1/img1.png`)).toBe(false)
  })

  it("deletes a document's image folder in pages", async () => {
    const objects = new Map<string, Blob>()
    for (let k = 0; k < 1003; k++) objects.set(`scene-assets:${UID}/docA/img${k}.webp`, new Blob([new Uint8Array([k % 7])]))
    objects.set(`scene-assets:${UID}/docB/keep.webp`, new Blob([new Uint8Array([1])]))
    const { client, calls } = fakeClient(objects)
    const assets = createAssetStore({ client, store: createMemoryStore(), userId: UID })
    expect(await assets.deleteSceneImages!("docA")).toBe(1003)
    expect([...objects.keys()]).toEqual([`scene-assets:${UID}/docB/keep.webp`])
    expect(calls.filter((c) => c.op === "remove").map((c) => (c.args[0] as string[]).length)).toEqual([1000, 3])
  })

  it("sweeps the images the server names, except this browser's drafts, and reports their size", async () => {
    const objects = new Map<string, Blob>([
      [`scene-assets:${UID}/docA/old.webp`, new Blob([new Uint8Array(5)])],
      [`scene-assets:${UID}/docA/used.webp`, new Blob([new Uint8Array(7)])],
      [`scene-assets:${UID}/draft/new.webp`, new Blob([new Uint8Array(9)])],
    ])
    const store = createMemoryStore()
    await saveDraft(store, "editor:unsaved:draft", { scene: { id: "draft", assets: {} }, libraryId: null, baseVersion: null })
    const { client, rpcCalls } = fakeClient(objects, {
      rpcData: (fn) => (fn === "unreferenced_scene_assets" ? [`${UID}/docA/old.webp`, `${UID}/draft/new.webp`, "someone-else/x/y.webp"] : null),
    })
    const assets = createAssetStore({ client, store, userId: UID })
    expect(await assets.sweepUnreferencedImages!({ minAgeMs: 3_600_000 })).toEqual({ removed: 1, bytes: 5 })
    expect(rpcCalls.at(-1)).toEqual({ fn: "unreferenced_scene_assets", args: { p_min_age: "3600 seconds" } })
    expect([...objects.keys()].sort()).toEqual([`scene-assets:${UID}/docA/used.webp`, `scene-assets:${UID}/draft/new.webp`])
  })

  it("reports a refused image upload as the storage quota", async () => {
    const { client } = fakeClient(new Map(), { uploadError: { status: 403, message: "new row violates row-level security policy" } })
    const assets = createAssetStore({ client, store: createMemoryStore(), userId: UID })
    await expect(assets.putImage("scene1", new Blob([new Uint8Array([1])], { type: "image/png" }), { name: "a", kind: "image", mime: "image/png", width: 1, height: 1 })).rejects.toMatchObject({
      code: "quota_exceeded",
    })
    await expect(assets.putTileChunk(SID, UID, "L1", 0, 0, new Blob([new Uint8Array([1])]))).rejects.toMatchObject({ code: "permission_denied" })
  })

  it("tile source returns null for tiles the player may not read", async () => {
    const { client } = fakeClient(new Map())
    const tiles = createTileSource({ sessionId: SID, userId: UID, client, store: createMemoryStore() })
    expect(await tiles.getTile("L1", { i: 0, j: 0 })).toBeNull()
    tiles.dispose()
    expect(await tiles.getTile("L1", { i: 0, j: 0 })).toBeNull()
  })

  it("stores each player's tile chunks under their user id and removes a session's tiles", async () => {
    const objects = new Map<string, Blob>()
    const { client, calls } = fakeClient(objects)
    const assets = createAssetStore({ client, store: createMemoryStore(), userId: UID })
    const chunk = new Blob([new Uint8Array([1])], { type: "image/webp" })
    const P = "7a1f0c2e-9b3d-4e5f-8a6b-7c8d9e0f1a2b"
    await assets.putTileChunk(SID, P, "L1", 2, 3, chunk)
    await assets.putTileChunk(SID, P, "L1", 0, 0, chunk)
    await assets.putTileChunk(SID, UID, "L2", 1, 1, chunk)
    expect(calls.find((c) => c.op === "upload")).toMatchObject({ bucket: "session-tiles", args: [`${SID}/${P}/L1/2_3.webp`, { upsert: true, cacheControl: "0" }] })
    await expect(assets.putTileChunk(SID, "../x", "L1", 0, 0, chunk)).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(assets.putTileChunk(SID, P, "L1", -1, 0, chunk)).rejects.toMatchObject({ code: "invalid_argument" })
    await assets.deleteTileChunks(SID, P, "L1", [{ ci: 0, cj: 0 }])
    expect(objects.has(`session-tiles:${chunkPath(SID, P, "L1", 0, 0)}`)).toBe(false)
    expect(await assets.removeSessionTiles(SID)).toBe(2)
    expect([...objects.keys()].filter((k) => k.startsWith("session-tiles:"))).toEqual([])
  })

  it("retries a session's tile clean-up that Storage rate-limits, but not a refusal", async () => {
    const objects = new Map<string, Blob>([[`session-tiles:${chunkPath(SID, UID, "L1", 0, 0)}`, new Blob([new Uint8Array([1])])]])
    const { client } = fakeClient(objects)
    const from = client.storage.from.bind(client.storage)
    let failures: unknown[] = []
    ;(client.storage as { from: unknown }).from = (bucket: string) => {
      const b = from(bucket)
      return {
        ...b,
        list: async (...args: Parameters<typeof b.list>) => (failures.length > 0 ? { data: null, error: failures.shift() } : b.list(...args)),
      }
    }
    // Two 429s and a 503, then the listing works: the clean-up still removes the chunk.
    failures = [
      { status: 429, message: "Too Many Requests" },
      { statusCode: "429", message: "rate limited" },
      { status: 503, message: "unavailable" },
    ]
    expect(await removeSessionTiles(client, SID, [0, 0, 0, 0])).toBe(1)
    expect(objects.size).toBe(0)
    // More failures than retries: the last error is reported.
    failures = [
      { status: 429, message: "a" },
      { status: 429, message: "b" },
    ]
    await expect(removeSessionTiles(client, SID, [0])).rejects.toMatchObject({ code: "unknown" })
    // A permission refusal is not retried.
    failures = [
      { status: 403, message: "denied" },
      { status: 403, message: "denied" },
    ]
    await expect(removeSessionTiles(client, SID, [0, 0])).rejects.toMatchObject({ code: "permission_denied" })
    expect(failures).toHaveLength(1)
  })

  describe("chunk tile source", () => {
    afterEach(() => vi.unstubAllGlobals())

    it("crops cells from the announced chunk, fetching each chunk version once", async () => {
      const decoded: unknown[][] = []
      vi.stubGlobal("createImageBitmap", async (...args: unknown[]) => {
        decoded.push(args)
        return { width: args.length > 1 ? (args[3] as number) : 560, height: args.length > 1 ? (args[4] as number) : 560, close() {} }
      })
      const objects = new Map<string, Blob>([[`session-tiles:${chunkPath(SID, UID, "L1", 1, 2)}`, new Blob([new Uint8Array([5])])]])
      const { client, calls } = fakeClient(objects)
      const tiles = createTileSource({ sessionId: SID, userId: UID, client, store: createMemoryStore() })
      // Cell (5, 9) is bit (9 - 8)·4 + (5 - 4) = 5 of chunk (1, 2): unknown until announced.
      expect(await tiles.getTile("L1", { i: 5, j: 9 })).toBeNull()
      expect(calls.filter((c) => c.op === "download")).toHaveLength(0)
      tiles.setChunks?.("L1", [[1, 2, 1 << 5]], false)
      expect(await tiles.getTile("L1", { i: 4, j: 8 })).toBeNull()
      const tile = await tiles.getTile("L1", { i: 5, j: 9 })
      expect(tile).toMatchObject({ width: 140, height: 140 })
      // The crop of cell (1, 1) inside the 560-px chunk.
      expect(decoded.at(-1)?.slice(1)).toEqual([140, 140, 140, 140])
      const downloads = calls.filter((c) => c.op === "download")
      expect(downloads).toHaveLength(1)
      expect(downloads[0].args).toEqual([chunkPath(SID, UID, "L1", 1, 2), { cacheNonce: `${1 << 5}.0` }])
      // More cells in the same chunk: a new version (new nonce) is downloaded once.
      tiles.setChunks?.("L1", [[1, 2, (1 << 5) | 1]], false)
      await tiles.getTile("L1", { i: 4, j: 8 })
      await tiles.getTile("L1", { i: 5, j: 9 })
      expect(calls.filter((c) => c.op === "download")).toHaveLength(2)
      // A reset forgets the level's chunks.
      tiles.setChunks?.("L1", [], true)
      expect(await tiles.getTile("L1", { i: 5, j: 9 })).toBeNull()
      tiles.dispose()
    })

    it("downloads a re-cut chunk (new rev) under a new nonce and reports the cells whose tile changed", async () => {
      vi.stubGlobal("createImageBitmap", async (...args: unknown[]) => ({ width: args.length > 1 ? (args[3] as number) : 560, height: args.length > 1 ? (args[4] as number) : 560, close() {} }))
      const objects = new Map<string, Blob>([[`session-tiles:${chunkPath(SID, UID, "L1", 1, 2)}`, new Blob([new Uint8Array([5])])]])
      const { client, calls } = fakeClient(objects)
      const tiles = createTileSource({ sessionId: SID, userId: UID, client, store: createMemoryStore() })
      const nonces = () => calls.filter((c) => c.op === "download").map((c) => (c.args[1] as { cacheNonce: string }).cacheNonce)
      expect(tiles.setChunks?.("L1", [[1, 2, 1 << 5, 111]], false)).toEqual([])
      await tiles.getTile("L1", { i: 5, j: 9 })
      expect(nonces()).toEqual([`${1 << 5}.111`])
      // Same cells, new content (a partly explored cell grew): new nonce, and cell (5, 9) is reported.
      expect(tiles.setChunks?.("L1", [[1, 2, 1 << 5, 222]], false)).toEqual([{ i: 5, j: 9 }])
      await tiles.getTile("L1", { i: 5, j: 9 })
      expect(nonces()).toEqual([`${1 << 5}.111`, `${1 << 5}.222`])
      // A cell added to the chunk: only the cells that were already in it are reported.
      expect(tiles.setChunks?.("L1", [[1, 2, (1 << 5) | 1, 333]], false)).toEqual([{ i: 5, j: 9 }])
      // The same version again (e.g. the table after a snapshot): nothing to redraw.
      expect(tiles.setChunks?.("L1", [[1, 2, (1 << 5) | 1, 333]], true)).toEqual([])
      // A removal reports nothing (the compositor clears cells that stop being explored itself).
      expect(tiles.setChunks?.("L1", [[1, 2, 0]], false)).toEqual([])
      tiles.dispose()
    })
  })

  it("reads storage error statuses", () => {
    expect(storageStatus({ status: 403 })).toBe(403)
    expect(storageStatus({ statusCode: "404" })).toBe(404)
    expect(storageStatus({ originalError: { status: 400 } })).toBe(400)
    expect(storageStatus(new Error("x"))).toBeNull()
  })
})
