import { afterEach, describe, expect, it, vi } from "vitest"

import { createMemoryStore } from "../localStore"
import type { AtlasClient } from "../supabase"
import { createAssetStore, createTileSource } from "./index"
import { LOCAL_ASSET_STORE, localAssetKey } from "./localAssets"
import { chunkPath } from "./chunks"
import { assetPath, GRANT_BATCH, storageStatus, tilePath } from "./supabaseAssets"

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

  it("treats tile publishing and grants as no-ops (players crop locally)", async () => {
    const assets = createAssetStore({ client: null, store: createMemoryStore(), userId: "u" })
    await expect(assets.publishTiles(SID, "L1", [{ cell: { i: 0, j: 0 }, blob: new Blob([]) }])).resolves.toBeUndefined()
    await expect(assets.grantTiles(SID, 1, UID, "L1", [{ i: 0, j: 0 }])).resolves.toBeUndefined()
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

function fakeClient(objects: Map<string, Blob>, opts: { rpcError?: unknown } = {}) {
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
            objects.set(key(path), blob)
            return { data: { path }, error: null }
          },
          async list(folder: string) {
            calls.push({ bucket, op: "list", args: [folder] })
            const prefix = `${bucket}:${folder}/`
            const names = new Map<string, boolean>()
            for (const k of objects.keys()) {
              if (!k.startsWith(prefix)) continue
              const rest = k.slice(prefix.length)
              const slash = rest.indexOf("/")
              if (slash < 0) names.set(rest, true)
              else names.set(rest.slice(0, slash), false)
            }
            return { data: [...names].map(([name, file]) => ({ name, id: file ? `id-${name}` : null })), error: null }
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
      return opts.rpcError ? { data: null, error: opts.rpcError } : { data: null, error: null }
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

  it("publishes each tile once per session and batches grants", async () => {
    const objects = new Map<string, Blob>()
    const { client, calls, rpcCalls } = fakeClient(objects)
    const assets = createAssetStore({ client, store: createMemoryStore(), userId: UID })
    const tile = new Blob([new Uint8Array([1])], { type: "image/webp" })
    await assets.publishTiles(SID, "L1", [
      { cell: { i: 1, j: 2 }, blob: tile },
      { cell: { i: 3, j: 4 }, blob: tile },
    ])
    await assets.publishTiles(SID, "L1", [{ cell: { i: 1, j: 2 }, blob: tile }])
    const uploads = calls.filter((c) => c.op === "upload").map((c) => c.args[0])
    expect(uploads.sort()).toEqual([tilePath(SID, "L1", { i: 1, j: 2 }), tilePath(SID, "L1", { i: 3, j: 4 })].sort())
    expect(uploads[0]).toMatch(new RegExp(`^${SID}/L1/\\d+_\\d+\\.webp$`))

    const cells = Array.from({ length: GRANT_BATCH + 5 }, (_, k) => ({ i: k % 200, j: Math.floor(k / 200) }))
    await assets.grantTiles(SID, 7, UID, "L1", cells)
    expect(rpcCalls).toHaveLength(2)
    expect(rpcCalls[0]).toMatchObject({ fn: "grant_tiles", args: { p_session_id: SID, p_host_epoch: 7, p_user_id: UID, p_level_id: "L1" } })
    expect((rpcCalls[0].args.p_cells as unknown[]).length).toBe(GRANT_BATCH)
    expect(rpcCalls[1].args.p_cells).toEqual(cells.slice(GRANT_BATCH).map((c) => [c.i, c.j]))
  })

  it("maps a fenced grant failure to a NetError", async () => {
    const { client } = fakeClient(new Map(), { rpcError: { message: "stale_epoch", code: "P0001" } })
    const assets = createAssetStore({ client, store: createMemoryStore(), userId: UID })
    await expect(assets.grantTiles(SID, 1, UID, "L1", [{ i: 0, j: 0 }])).rejects.toMatchObject({ code: "stale_epoch" })
    await expect(assets.grantTiles("not-a-uuid", 1, UID, "L1", [])).rejects.toMatchObject({ code: "invalid_argument" })
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
      expect(downloads[0].args).toEqual([chunkPath(SID, UID, "L1", 1, 2), { cacheNonce: String(1 << 5) }])
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
  })

  it("reads storage error statuses", () => {
    expect(storageStatus({ status: 403 })).toBe(403)
    expect(storageStatus({ statusCode: "404" })).toBe(404)
    expect(storageStatus({ originalError: { status: 400 } })).toBe(400)
    expect(storageStatus(new Error("x"))).toBeNull()
  })
})
