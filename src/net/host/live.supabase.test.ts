/**
 * LIVE host test against the configured Supabase project (.env.local). Skipped unless
 * ATLAS_LIVE_SUPABASE=1:
 *
 *   ATLAS_LIVE_SUPABASE=1 npx vitest run src/net/host/live.supabase.test.ts
 *
 * A real HostRunner over SupabaseTransport (private channels under RLS) and the remote SessionsRepo
 * (fenced RPCs): a player joins, gets a snapshot, moves (the result arrives in the patch), the stored
 * player_views row matches, a second DM device takes over (the first stands down on the higher epoch),
 * and a kick reaches the player. Cleans up its scene and session; prints the anonymous users created.
 */
import { afterAll, describe, expect, it } from "vitest"

import { createDoor, createWall } from "@/core/scene/factory"
import { add, addToken, flatScene } from "@/core/session/test-utils"

import { ensureSession } from "../auth"
import { readSupabaseEnv } from "../env"
import { createRemoteScenesRepo } from "../scenesRepo"
import { createRemoteSessionsRepo } from "../sessionsRepo"
import { createAtlasClient, type AtlasClient } from "../supabase"
import { SupabaseTransport } from "../supabaseTransport"
import { createHostRunner } from "./index"
import { Mirror, recordingAssets, waitFor } from "./test-utils"
import { createInThreadVisionClient } from "./visionClient"

const env = readSupabaseEnv()
const nodeEnv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const enabled = nodeEnv.ATLAS_LIVE_SUPABASE === "1" && env !== null

describe.skipIf(!enabled)("live Supabase: host runner", () => {
  const clients: AtlasClient[] = []
  const transports: SupabaseTransport[] = []
  const users: string[] = []
  const cleanups: Array<() => Promise<unknown>> = []
  const newClient = () => {
    const c = createAtlasClient(env!, { worker: false, persistSession: false })
    clients.push(c)
    return c
  }

  afterAll(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => undefined)
    await Promise.all(transports.map((t) => t.dispose()))
    for (const c of clients) {
      await c.removeAllChannels()
      c.realtime.disconnect()
    }
    console.info(`[live host test] anonymous users created: ${users.join(", ")}`)
  })

  it("hosts a session over private Realtime channels and fenced RPCs", { timeout: 120_000 }, async () => {
    const [dmC, p1C] = [newClient(), newClient()]
    const [dm, p1] = await Promise.all([ensureSession(dmC), ensureSession(p1C)])
    users.push(dm.userId, p1.userId)

    const { scene, ground } = flatScene(10, 6, "bright")
    scene.name = "Live host test"
    const wall = add(scene, createWall(ground, { x: 30, z: 0 }, { x: 30, z: 30 }))
    add(scene, createDoor(wall, 12.5))
    const ada = addToken(scene, ground, 17.5, 12.5, { name: "Ada", label: "Ada" })
    const scenes = createRemoteScenesRepo(dmC)
    const summary = await scenes.create(scene)
    cleanups.push(() => scenes.remove(summary.id))
    const dmRepo = createRemoteSessionsRepo(dmC)
    const { sessionId, roomCode } = await dmRepo.createSession(summary.id)
    cleanups.push(() => dmRepo.endSession(sessionId))
    const p1Repo = createRemoteSessionsRepo(p1C)
    await p1Repo.joinSession(roomCode, "Live Alice")

    const logs: string[] = []
    const dmT = new SupabaseTransport(dmC)
    transports.push(dmT)
    const hostA = createHostRunner({
      sessionId,
      transport: dmT,
      repo: dmRepo,
      identity: dm,
      assets: recordingAssets("local").store,
      createVisionClient: createInThreadVisionClient,
      locks: null,
      tileCodec: null,
      watchVisibility: false,
      timing: { saveIntervalMs: 500, viewSaveIntervalMs: 500 },
      log: (m, e) => logs.push(`${m} ${e ?? ""}`),
    })
    cleanups.push(() => hostA.stop())
    await hostA.start()
    expect(hostA.getSnapshot().status).toBe("hosting")
    hostA.dispatch({ t: "assign-token", tokenId: ada.id, userId: p1.userId, assigned: true })

    const p1T = new SupabaseTransport(p1C)
    transports.push(p1T)
    const m = new Mirror(p1T, sessionId, p1.userId, p1Repo)
    cleanups.push(() => m.close())
    await waitFor(() => m.view !== null && m.epoch === hostA.getSnapshot().epoch, "snapshot over Realtime", 30_000)
    expect(m.view!.controlledTokenIds).toEqual([ada.id])
    await waitFor(() => m.ch.host.hostOnline(), "DM presence", 15_000)

    const reqId = m.move(ada.id, [
      { cell: { i: 3, j: 2 }, levelId: ground },
      { cell: { i: 4, j: 2 }, levelId: ground },
      { cell: { i: 4, j: 3 }, levelId: ground },
    ])
    await waitFor(() => m.result(reqId) !== undefined, "move result", 20_000)
    expect(m.result(reqId)).toMatchObject({ ok: true, applied: 2 })
    await waitFor(() => hostA.debugIdle() && m.seq === hostA.debugPlayer(p1.userId)?.seq, "in step", 20_000)
    expect(m.view!.tokens[ada.id].position).toEqual({ x: 22.5, z: 17.5 })

    // The stored view (upsert_player_view, throttled) catches up with what the player holds.
    await waitFor(() => hostA.getSnapshot().stats.lastSaveAt !== null, "state saved", 20_000)
    let row = await p1Repo.loadPlayerView(sessionId, p1.userId)
    for (let k = 0; k < 40 && row?.seq !== m.seq; k++) {
      await new Promise((r) => setTimeout(r, 250))
      row = await p1Repo.loadPlayerView(sessionId, p1.userId)
    }
    expect(row?.epoch).toBe(m.epoch)
    expect(row?.view).toEqual(m.view)

    // A second DM device (same account) takes over: the first host stands down on the higher epoch.
    const dm2C = newClient()
    const { data } = await dmC.auth.getSession()
    await dm2C.auth.setSession({ access_token: data.session!.access_token, refresh_token: data.session!.refresh_token })
    const dm2T = new SupabaseTransport(dm2C)
    transports.push(dm2T)
    const hostB = createHostRunner({
      sessionId,
      transport: dm2T,
      repo: createRemoteSessionsRepo(dm2C),
      identity: dm,
      assets: recordingAssets("local").store,
      createVisionClient: createInThreadVisionClient,
      locks: null,
      tileCodec: null,
      watchVisibility: false,
    })
    cleanups.push(() => hostB.stop())
    await hostB.start()
    expect(hostB.getSnapshot().status).toBe("hosting")
    await waitFor(() => hostA.getSnapshot().status === "standby", "first host stands down", 20_000)
    await waitFor(() => m.epoch === hostB.getSnapshot().epoch && m.view !== null, "player follows the new host", 30_000)
    expect(m.view!.tokens[ada.id].position).toEqual({ x: 22.5, z: 17.5 })

    // Kick: the player hears it, then nothing more.
    await hostB.kick(p1.userId)
    await waitFor(() => m.kicked, "kicked", 15_000)
    expect((await p1Repo.sessionInfo(sessionId))?.memberStatus).toBe("kicked")
    expect(logs.filter((l) => !l.includes("stale"))).toEqual([])
  })
})
