/**
 * LIVE integration test of map image storage against the configured Supabase project (.env.local).
 * Skipped unless ATLAS_LIVE_SUPABASE=1:
 *
 *   ATLAS_LIVE_SUPABASE=1 npx vitest run src/net/assets/live.assets.supabase.test.ts
 *
 * Anonymous DM, player and outsider: the DM stores an image (scene-assets, owner-only), publishes two
 * tiles and grants one to the player (fenced grant_tiles); the player can download exactly the granted
 * tile; revoke_tiles and a stale epoch behave; everything created is removed again (the anonymous auth
 * users are printed, auth.users is not reachable with the publishable key).
 */
import { afterAll, describe, expect, it, vi } from "vitest"

import { createScene } from "@/core/scene/factory"

import { ensureSession } from "../auth"
import { readSupabaseEnv } from "../env"
import { createMemoryStore } from "../localStore"
import { createRemoteScenesRepo } from "../scenesRepo"
import { createRemoteSessionsRepo } from "../sessionsRepo"
import { createAtlasClient, type AtlasClient } from "../supabase"
import { createAssetStore } from "./index"
import { downloadTile, removeSessionTiles, revokeTiles } from "./supabaseAssets"

vi.mock("@/core/scene/schema", async (orig) => ({
  ...(await orig<typeof import("@/core/scene/schema")>()),
  parseScene: (json: unknown) => ({ ok: true, scene: json, migratedFrom: null }),
}))

const env = readSupabaseEnv()
const nodeEnv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const enabled = nodeEnv.ATLAS_LIVE_SUPABASE === "1" && env !== null

describe.skipIf(!enabled)("live Supabase: map image storage under RLS", () => {
  const clients: AtlasClient[] = []
  const createdUsers: string[] = []
  const cleanups: Array<() => Promise<unknown>> = []
  const newClient = () => {
    const c = createAtlasClient(env!, { worker: false, persistSession: false })
    clients.push(c)
    return c
  }

  afterAll(async () => {
    for (const fn of cleanups.reverse()) await fn().catch((e) => console.warn("[live cleanup]", e))
    for (const c of clients) c.realtime.disconnect()
    console.info(`[live test] anonymous users created: ${createdUsers.join(", ")}`)
  })

  it("stores DM images privately and serves only granted tiles", { timeout: 90_000 }, async () => {
    const [dmC, pC, xC] = [newClient(), newClient(), newClient()]
    const [dm, p, x] = await Promise.all([dmC, pC, xC].map((c) => ensureSession(c)))
    createdUsers.push(dm.userId, p.userId, x.userId)

    // --- DM image (scene-assets): owner only
    const store = createMemoryStore()
    const dmAssets = createAssetStore({ client: dmC, store, userId: dm.userId })
    const pAssets = createAssetStore({ client: pC, store, userId: dm.userId })
    const docScene = createScene({ name: "Live assets", width: 4, depth: 4 })
    const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])], { type: "image/png" })
    const meta = await dmAssets.putImage(docScene.id, png, { name: "map.png", kind: "image", mime: "image/png", width: 2, height: 2 })
    cleanups.push(() => dmAssets.deleteImage(docScene.id, meta.id))
    expect((await dmAssets.getImage(docScene.id, meta.id))?.size).toBe(png.size)
    // The player uses the DM's folder path but RLS hides it.
    expect(await pAssets.getImage(docScene.id, meta.id)).toBeNull()
    await expect(pAssets.putImage(docScene.id, png, { name: "x.png", kind: "image", mime: "image/png", width: 2, height: 2 })).rejects.toBeTruthy()

    // --- session with one player
    const scenes = createRemoteScenesRepo(dmC)
    const summary = await scenes.create(docScene)
    cleanups.push(() => scenes.remove(summary.id))
    const dmRepo = createRemoteSessionsRepo(dmC)
    const { sessionId: sid, roomCode } = await dmRepo.createSession(summary.id)
    cleanups.push(() => dmRepo.endSession(sid))
    expect(await createRemoteSessionsRepo(pC).joinSession(roomCode, "Tiles")).toBe(sid)
    const epoch = await dmRepo.claimHost(sid)

    // --- tiles: publish two, grant one
    const levelId = Object.keys(docScene.levels)[0]
    const tile = (n: number) => new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, n])], { type: "image/webp" })
    await dmAssets.publishTiles(sid, levelId, [
      { cell: { i: 0, j: 0 }, blob: tile(1) },
      { cell: { i: 1, j: 0 }, blob: tile(2) },
    ])
    cleanups.push(() => removeSessionTiles(dmC, sid))
    await dmAssets.grantTiles(sid, epoch, p.userId, levelId, [{ i: 0, j: 0 }])
    expect((await downloadTile(pC, sid, levelId, { i: 0, j: 0 }))?.size).toBe(5)
    expect(await downloadTile(pC, sid, levelId, { i: 1, j: 0 })).toBeNull()
    expect(await downloadTile(xC, sid, levelId, { i: 0, j: 0 })).toBeNull()
    expect((await downloadTile(dmC, sid, levelId, { i: 1, j: 0 }))?.size).toBe(5)
    // Players cannot publish, grant or revoke.
    await expect(pAssets.publishTiles(sid, levelId, [{ cell: { i: 2, j: 0 }, blob: tile(3) }])).rejects.toBeTruthy()
    await expect(pAssets.grantTiles(sid, epoch, p.userId, levelId, [{ i: 1, j: 0 }])).rejects.toMatchObject({ code: "not_found" })
    // Stale host epoch is fenced.
    await expect(dmAssets.grantTiles(sid, epoch - 1, p.userId, levelId, [{ i: 1, j: 0 }])).rejects.toMatchObject({ code: "stale_epoch" })
    // Revoke (fog reset) removes access. The CDN may keep serving the copy this player already fetched
    // (cached per requester for the tile's 60 s cache time), so check with a fresh URL.
    expect(await revokeTiles(dmC, sid, epoch, p.userId)).toBe(1)
    expect(await downloadTile(pC, sid, levelId, { i: 0, j: 0 }, undefined, `revoked-${Date.now()}`)).toBeNull()
    await expect(revokeTiles(dmC, sid, epoch - 1)).rejects.toMatchObject({ code: "stale_epoch" })
  })
})
