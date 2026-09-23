/**
 * LIVE integration test against the configured Supabase project (.env.local). Skipped unless
 * ATLAS_LIVE_SUPABASE=1:
 *
 *   ATLAS_LIVE_SUPABASE=1 npx vitest run src/net/live.supabase.test.ts
 *
 * It signs in four anonymous users (DM, two players, an outsider), runs the RPCs, and exchanges
 * messages over private Realtime channels through SupabaseTransport, checking the RLS topic rules
 * end to end. It cleans up its scene and session; the anonymous auth users it created are printed
 * so they can be deleted (auth.users is not reachable with the publishable key).
 */
import { afterAll, describe, expect, it, vi } from "vitest"

import { createScene } from "@/core/scene/factory"
import type { GameState, HostToClient, PlayerView } from "@/core/session/types"

import { ensureSession, setDisplayName } from "./auth"
import { createPrivateChannel, topics } from "./channels"
import { readSupabaseEnv } from "./env"
import { createRemoteScenesRepo } from "./scenesRepo"
import { createRemoteSessionsRepo } from "./sessionsRepo"
import { createAtlasClient, isNetError, type AtlasClient } from "./supabase"
import { SupabaseTransport } from "./supabaseTransport"
import { MAX_BROADCAST_BYTES } from "./transport"

vi.mock("@/core/scene/schema", () => ({
  parseScene: (json: unknown) => ({ ok: true, scene: json, migratedFrom: null }),
  serializeScene: (scene: unknown) => JSON.stringify(scene),
}))

const env = readSupabaseEnv()
// Read through globalThis: the app tsconfig has no Node typings.
const nodeEnv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}
const enabled = nodeEnv.ATLAS_LIVE_SUPABASE === "1" && env !== null

async function waitFor(predicate: () => boolean, timeoutMs = 15_000, what = "condition"): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** Subscribe a raw private channel and report the first terminal subscribe status. */
function trySubscribe(client: AtlasClient, topic: string): Promise<{ status: string; error?: string; remove: () => Promise<unknown> }> {
  const ch = createPrivateChannel(client, topic)
  return new Promise((resolve) => {
    ch.subscribe((status, err) => {
      if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        resolve({ status, error: err?.message, remove: () => client.removeChannel(ch) })
      }
    })
  })
}

const view = (userId: string, sessionId: string, marker: string): PlayerView =>
  ({ viewVersion: 1, sessionId, userId, marker }) as unknown as PlayerView

describe.skipIf(!enabled)("live Supabase: RPCs + private channels under RLS", () => {
  const clients: AtlasClient[] = []
  const transports: SupabaseTransport[] = []
  const createdUsers: string[] = []
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
    console.info(`[live test] anonymous users created: ${createdUsers.join(", ")}`)
  })

  it("runs a DM ↔ player session end to end", { timeout: 90_000 }, async () => {
    const [dmC, p1C, p2C, xC] = [newClient(), newClient(), newClient(), newClient()]
    const [dm, p1, p2, x] = await Promise.all([dmC, p1C, p2C, xC].map((c) => ensureSession(c)))
    createdUsers.push(dm.userId, p1.userId, p2.userId, x.userId)
    expect(dm.isAnonymous).toBe(true)
    expect(await setDisplayName("Live DM", dmC)).toBe("Live DM")

    // --- scene library (owner-only) + session creation
    const scenes = createRemoteScenesRepo(dmC)
    const scene = createScene({ name: "Live test scene", width: 4, depth: 4 })
    const summary = await scenes.create(scene)
    cleanups.push(() => scenes.remove(summary.id))
    expect(await scenes.saveVersion(summary.id, scene)).toBe(2)
    expect(await createRemoteScenesRepo(p1C).get(summary.id)).toBeNull()

    const dmRepo = createRemoteSessionsRepo(dmC)
    const { sessionId: sid, roomCode } = await dmRepo.createSession(summary.id)
    cleanups.push(() => dmRepo.endSession(sid))
    const seed = await dmRepo.loadSessionState(sid)
    expect(seed?.content).toMatchObject({ kind: "seed", sceneVersion: 2 })

    const p1Repo = createRemoteSessionsRepo(p1C)
    const p2Repo = createRemoteSessionsRepo(p2C)
    expect(await p1Repo.joinSession(roomCode, "Alice")).toBe(sid)
    expect(await p2Repo.joinSession(roomCode.toLowerCase(), "Bob")).toBe(sid)
    expect(await p1Repo.loadSessionState(sid)).toBeNull()
    expect((await p1Repo.sessionInfo(sid))?.dmDisplayName).toBe("Live DM")

    // --- channels: host (DM) and player 1 through SupabaseTransport
    const dmT = new SupabaseTransport(dmC)
    const p1T = new SupabaseTransport(p1C)
    transports.push(dmT, p1T)
    const host = dmT.openHostChannels(sid, "wire-1", { userId: dm.userId })
    const link = host.openPlayer(p1.userId)
    const requests: unknown[] = []
    link.onRequest((m) => requests.push(m))

    const player = p1T.openPlayerChannels(sid, p1.userId, { displayName: "Alice" })
    const received: HostToClient[] = []
    player.view.onMessage((m) => received.push(m))
    player.onReady(() => void player.req.send({ t: "hello", nonce: "n1", epoch: null, lastSeq: null }))

    await waitFor(() => link.isReady(), 20_000, "host link ready")
    await waitFor(() => player.isReady(), 20_000, "player ready")
    await waitFor(() => requests.length >= 1, 10_000, "hello at host")
    expect(requests[0]).toEqual({ t: "hello", nonce: "n1", epoch: null, lastSeq: null })

    const snapshot: HostToClient = { t: "snapshot", epoch: "wire-1", seq: 0, view: view(p1.userId, sid, "snap"), nonce: "n1" }
    expect(await link.send(snapshot)).toEqual({ ok: true }) // acknowledged broadcast
    await waitFor(() => received.length >= 1, 10_000, "snapshot at player")
    expect(received[0]).toEqual(snapshot)

    // A PUBLIC channel with the same topic name (possible while the dashboard's "Allow public
    // access" is on) must neither see private traffic nor inject into it.
    const spy = xC.channel(topics.view(sid, p1.userId), { config: { private: false, broadcast: { ack: true, self: false } } })
    const spied: unknown[] = []
    spy.on("broadcast", { event: "view" }, (m: { payload?: unknown }) => spied.push(m.payload))
    const spyStatus = await new Promise<string>((resolve) => spy.subscribe((s) => s !== "CLOSED" && resolve(s)))
    cleanups.push(() => xC.removeChannel(spy))
    // SUBSCRIBED while public access is allowed; CHANNEL_ERROR once the project is private-only.
    console.info(`[live test] public channel on a session topic: ${spyStatus}`)
    expect(["SUBSCRIBED", "CHANNEL_ERROR"]).toContain(spyStatus)
    if (spyStatus === "SUBSCRIBED") {
      await spy.send({ type: "broadcast", event: "view", payload: { t: "kicked", reason: "forged" } })
      expect(await link.send({ t: "sync", epoch: "wire-1", seq: 0 })).toEqual({ ok: true })
      await waitFor(() => received.length >= 2, 10_000, "sync at player")
      await new Promise((r) => setTimeout(r, 1500))
      expect(spied).toEqual([])
      expect(received.slice(1)).toEqual([{ t: "sync", epoch: "wire-1", seq: 0 }])
    }

    await waitFor(() => player.host.hostOnline(), 10_000, "DM presence")
    expect(await host.host.broadcast({ t: "status", epoch: "wire-1", sceneName: "Live" })).toEqual({ ok: true })

    // Size guard: never hits the wire.
    const huge = { t: "snapshot", epoch: "wire-1", seq: 1, view: { blob: "x".repeat(MAX_BROADCAST_BYTES) } } as unknown as HostToClient
    expect(await link.send(huge)).toMatchObject({ ok: false, reason: "too-large" })

    // --- RLS on topics
    // Another member cannot listen to player 1's view; an outsider cannot join the host topic.
    const p2OnP1View = await trySubscribe(p2C, topics.view(sid, p1.userId))
    cleanups.push(p2OnP1View.remove)
    expect(p2OnP1View.status).toBe("CHANNEL_ERROR")
    const xOnHost = await trySubscribe(xC, topics.host(sid))
    cleanups.push(xOnHost.remove)
    expect(xOnHost.status).toBe("CHANNEL_ERROR")
    // Another member may listen on the host topic and the lobby.
    const p2OnHost = await trySubscribe(p2C, topics.host(sid))
    cleanups.push(p2OnHost.remove)
    expect(p2OnHost.status).toBe("SUBSCRIBED")

    // --- fenced persistence
    const epoch = await dmRepo.claimHost(sid)
    expect(epoch).toBe(1)
    await dmRepo.saveSessionState(sid, epoch, { stateVersion: 1 } as unknown as GameState)
    expect(await dmRepo.upsertPlayerView({ sessionId: sid, userId: p1.userId, hostEpoch: epoch, epoch: "wire-1", seq: 3, view: view(p1.userId, sid, "row") })).toBe(true)
    expect(await p1Repo.loadPlayerView(sid, p1.userId)).toMatchObject({ epoch: "wire-1", seq: 3 })
    expect(await p2Repo.loadPlayerView(sid, p1.userId)).toBeNull()
    expect(await dmRepo.claimHost(sid)).toBe(2)
    const stale = await dmRepo.saveSessionState(sid, epoch, { stateVersion: 1 } as unknown as GameState).catch((e: unknown) => e)
    expect(isNetError(stale, "stale_epoch")).toBe(true)

    // --- kick: the kicked member can neither rejoin nor join a session topic afresh
    expect(await dmRepo.setMemberStatus(sid, p2.userId, "kicked")).toBe(true)
    const rejoin = await p2Repo.joinSession(roomCode, "Bob").catch((e: unknown) => e)
    expect(isNetError(rejoin, "kicked")).toBe(true)
    await p2OnHost.remove()
    const kickedOnLobby = await trySubscribe(p2C, topics.lobby(sid))
    cleanups.push(kickedOnLobby.remove)
    expect(kickedOnLobby.status).toBe("CHANNEL_ERROR")

    await player.close()
    await host.close()
  })
})
