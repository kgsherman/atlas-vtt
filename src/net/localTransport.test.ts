import { afterEach, describe, expect, it } from "vitest"

import type { ClientToHost, HostToClient, PlayerView } from "@/core/session/types"

import { LocalTransport, type BroadcastChannelLike, type LocalTransportOptions } from "./localTransport"
import { MAX_BROADCAST_BYTES, type PlayerChannels, type SendResult } from "./transport"

const SID = "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const DM = "d0000000-0000-4000-8000-000000000001"
const P1 = "a1000000-0000-4000-8000-000000000001"
const P2 = "a2000000-0000-4000-8000-000000000002"

const transports: LocalTransport[] = []
afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.dispose()))
})

/** Each test gets its own BroadcastChannel namespace; transports in one test share it (like tabs). */
function tabs(extra: LocalTransportOptions = {}) {
  const namespace = `atlas-test-${crypto.randomUUID()}`
  const newTab = (more: LocalTransportOptions = {}) => {
    const t = new LocalTransport({ namespace, rate: null, ...extra, ...more })
    transports.push(t)
    return t
  }
  return newTab
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await new Promise((r) => setTimeout(r, 5))
  }
}

const fakeView = (userId: string): PlayerView => ({
  viewVersion: 1,
  sessionId: SID,
  userId,
  scene: { name: "Keep", grid: { cellSize: 5, width: 4, depth: 4, diagonalRule: "5-5-5", visionOrigin: "square" }, environment: {} as PlayerView["scene"]["environment"], levels: {} },
  objects: {},
  tokens: {},
  terrain: {},
  masks: {},
  controlledTokenIds: [],
  visionTokenIds: [],
  flags: { movementLocked: false, sharedVision: false, enforceSpeed: false },
})

describe("LocalTransport host ↔ player", () => {
  it("follows the §6.3 join order and completes hello → snapshot → request → result", async () => {
    const opened: string[] = []
    // View status at the moment each req channel is opened (req must wait for view SUBSCRIBED).
    const viewStatusWhenReqOpened: string[] = []
    let player: PlayerChannels | null = null
    const newTab = tabs()
    const hostT = newTab()
    const playerT = newTab({
      createChannel: (name) => {
        const topic = name.slice(name.indexOf(":session:") + 1)
        opened.push(topic)
        if (topic.includes(":req:")) viewStatusWhenReqOpened.push(player?.view.status() ?? "not created")
        return new BroadcastChannel(name) as BroadcastChannelLike
      },
    })

    const host = hostT.openHostChannels(SID, "epoch-1", { userId: DM })
    const link = host.openPlayer(P1)
    const requests: unknown[] = []
    let hostReady = 0
    link.onRequest((raw) => requests.push(raw))
    link.onReady(() => {
      hostReady++
    })

    player = playerT.openPlayerChannels(SID, P1, { displayName: "Alice" })
    // Synchronously after opening: view/host/lobby are joining, req has not even been opened.
    expect(opened).toEqual([`session:${SID}:view:${P1}`, `session:${SID}:host`, `session:${SID}:lobby`])
    const received: HostToClient[] = []
    player.view.onMessage((msg) => received.push(msg))
    const hello: ClientToHost = { t: "hello", nonce: "n1", epoch: null, lastSeq: null }
    const helloSent: SendResult[] = []
    const p = player
    player.onReady(() => {
      void p.req.send(hello).then((r) => helloSent.push(r))
    })

    await waitFor(() => requests.length === 1)
    expect(helloSent).toEqual([{ ok: true }])
    expect(requests[0]).toEqual(hello)
    expect(hostReady).toBeGreaterThanOrEqual(1)

    expect(viewStatusWhenReqOpened).toEqual(["SUBSCRIBED"])

    const snapshot: HostToClient = { t: "snapshot", epoch: "epoch-1", seq: 0, view: fakeView(P1), nonce: "n1" }
    expect(await link.send(snapshot)).toEqual({ ok: true })
    await waitFor(() => received.length === 1)
    expect(received[0]).toEqual(snapshot)

    const move: ClientToHost = { t: "move", reqId: "r1", tokenId: "tok", path: [{ cell: { i: 1, j: 1 }, levelId: "L" }] }
    expect(await player.req.send(move)).toEqual({ ok: true })
    await waitFor(() => requests.length === 2)
    expect(requests[1]).toEqual(move)

    const result: HostToClient = { t: "result", epoch: "epoch-1", seq: 0, result: { reqId: "r1", ok: true, applied: 1 } }
    await link.send(result)
    await waitFor(() => received.length === 2)
    expect(received[1]).toEqual(result)
  })

  it("routes each player's requests only to that player's link (sender = topic uid)", async () => {
    const newTab = tabs()
    const host = newTab().openHostChannels(SID, "e", { userId: DM })
    const fromP1: unknown[] = []
    const fromP2: unknown[] = []
    host.openPlayer(P1).onRequest((m) => fromP1.push(m))
    host.openPlayer(P2).onRequest((m) => fromP2.push(m))
    const p2 = newTab().openPlayerChannels(SID, P2)
    await waitFor(() => p2.isReady())
    // A payload claiming another identity changes nothing: the link, i.e. the topic, is the sender.
    await p2.req.send({ t: "door", reqId: "x", doorId: "d", action: "open", userId: P1 } as unknown as ClientToHost)
    await waitFor(() => fromP2.length === 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(fromP1).toEqual([])
    expect(host.players().sort()).toEqual([P1, P2].sort())
  })

  it("does not deliver a player's view to another player", async () => {
    const newTab = tabs()
    const host = newTab().openHostChannels(SID, "e", { userId: DM })
    const l1 = host.openPlayer(P1)
    host.openPlayer(P2)
    const p1 = newTab().openPlayerChannels(SID, P1)
    const p2 = newTab().openPlayerChannels(SID, P2)
    const got1: HostToClient[] = []
    const got2: HostToClient[] = []
    p1.view.onMessage((m) => got1.push(m))
    p2.view.onMessage((m) => got2.push(m))
    await waitFor(() => p1.isReady() && p2.isReady() && l1.isReady())
    await l1.send({ t: "sync", epoch: "e", seq: 3 })
    await waitFor(() => got1.length === 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(got2).toEqual([])
  })

  it("emulates presence: DM online on the host topic, members in the lobby", async () => {
    const newTab = tabs({ presenceHeartbeatMs: 50, presenceTimeoutMs: 200 })
    const hostT = newTab()
    const player = newTab().openPlayerChannels(SID, P1, { displayName: "Alice" })
    const online: boolean[] = []
    player.host.onHostPresence((v) => online.push(v))
    await waitFor(() => player.isReady())
    expect(player.host.hostOnline()).toBe(false)

    const host = hostT.openHostChannels(SID, "epoch-7", { userId: DM })
    await waitFor(() => player.host.hostOnline())
    expect(player.host.presence()).toEqual([{ key: DM, metas: [expect.objectContaining({ role: "host", epoch: "epoch-7" })] }])

    // The host sees the player in the lobby (display only).
    await waitFor(() => host.lobby.presence().some((e) => e.key === P1))
    expect(host.lobby.presence().find((e) => e.key === P1)?.metas[0]).toMatchObject({ role: "player", displayName: "Alice" })

    await host.close()
    await waitFor(() => !player.host.hostOnline())
    expect(online).toEqual([true, false])
  })

  it("expires the presence of a tab that vanished without saying goodbye", async () => {
    const newTab = tabs({ presenceHeartbeatMs: 20, presenceTimeoutMs: 80 })
    const hostT = newTab()
    const player = newTab().openPlayerChannels(SID, P1)
    hostT.openHostChannels(SID, "e", { userId: DM })
    await waitFor(() => player.host.hostOnline())
    // Simulate a crash: stop heartbeats without an untrack frame.
    const ch = [...(hostT as unknown as { channels: Set<{ topic: string; leave(): void }> }).channels].find((c) => c.topic.endsWith(":host"))
    ch?.leave()
    await waitFor(() => !player.host.hostOnline(), 1000)
  })

  it("forwards HostBroadcast to players and to other host instances", async () => {
    const newTab = tabs()
    const host = newTab().openHostChannels(SID, "epoch-1", { userId: DM })
    const otherHost = newTab().openHostChannels(SID, "epoch-2", { userId: DM })
    const player = newTab().openPlayerChannels(SID, P1)
    const atPlayer: unknown[] = []
    const atOtherHost: unknown[] = []
    player.host.onBroadcast((m) => atPlayer.push(m))
    otherHost.host.onBroadcast((m) => atOtherHost.push(m))
    await waitFor(() => host.host.status() === "SUBSCRIBED" && otherHost.host.status() === "SUBSCRIBED" && player.host.status() === "SUBSCRIBED")
    expect(await host.host.broadcast({ t: "status", epoch: "epoch-1", sceneName: "Keep" })).toEqual({ ok: true })
    await waitFor(() => atPlayer.length === 1 && atOtherHost.length === 1)
    expect(atPlayer[0]).toEqual({ t: "status", epoch: "epoch-1", sceneName: "Keep" })
  })

  it("refuses to send before joining, and payloads over 200 KB", async () => {
    const newTab = tabs()
    const host = newTab().openHostChannels(SID, "e", { userId: DM })
    const link = host.openPlayer(P1)
    const player = newTab().openPlayerChannels(SID, P1)
    // Synchronously after opening nothing is joined yet: fail instead of queueing.
    expect(await player.req.send({ t: "hello", nonce: "n", epoch: null, lastSeq: null })).toEqual({ ok: false, reason: "not-joined" })
    const got: HostToClient[] = []
    player.view.onMessage((m) => got.push(m))
    await waitFor(() => link.isReady() && player.isReady())
    const huge = fakeView(P1)
    huge.terrain = { L: { "0,0": "A".repeat(MAX_BROADCAST_BYTES) } }
    const res = await link.send({ t: "snapshot", epoch: "e", seq: 1, view: huge })
    expect(res).toMatchObject({ ok: false, reason: "too-large" })
    await new Promise((r) => setTimeout(r, 20))
    expect(got).toEqual([])
  })

  it("fires onReady again after a dropped connection (push snapshot / send hello again)", async () => {
    const newTab = tabs()
    const hostT = newTab()
    const playerT = newTab()
    const link = hostT.openHostChannels(SID, "e", { userId: DM }).openPlayer(P1)
    const player = playerT.openPlayerChannels(SID, P1)
    let hostReady = 0
    let playerReady = 0
    link.onReady(() => hostReady++)
    player.onReady(() => playerReady++)
    await waitFor(() => hostReady === 1 && playerReady === 1)

    const reqStatuses: string[] = []
    link.req.onStatus((ev) => reqStatuses.push(ev.status))
    hostT.simulateDrop((topic) => topic.includes(":req:"), 10)
    await waitFor(() => hostReady === 2)
    expect(reqStatuses).toEqual(["CHANNEL_ERROR", "JOINING", "SUBSCRIBED"])

    playerT.simulateDrop(() => true, 10)
    await waitFor(() => playerReady === 2)
    expect(player.isReady()).toBe(true)
  })

  it("closing reports CLOSED without retry and stops delivery", async () => {
    const newTab = tabs()
    const link = newTab().openHostChannels(SID, "e", { userId: DM }).openPlayer(P1)
    const player = newTab().openPlayerChannels(SID, P1)
    await waitFor(() => link.isReady() && player.isReady())
    const statuses: Array<{ status: string; willRetry?: boolean }> = []
    player.view.onStatus((ev) => statuses.push({ status: ev.status, willRetry: ev.willRetry }))
    await player.close()
    expect(statuses).toEqual([{ status: "CLOSED", willRetry: false }])
    expect(await player.req.send({ t: "hello", nonce: "n", epoch: null, lastSeq: null })).toEqual({ ok: false, reason: "closed" })
  })

  it("rate-limits sends like the Supabase transport, preserving order", async () => {
    const newTab = tabs({ rate: { ratePerSecond: 100, burst: 2 } })
    const hostT = newTab()
    const link = hostT.openHostChannels(SID, "e", { userId: DM }).openPlayer(P1)
    const player = newTab().openPlayerChannels(SID, P1)
    const seqs: number[] = []
    player.view.onMessage((m) => {
      if (m.t === "sync") seqs.push(m.seq)
    })
    await waitFor(() => link.isReady() && player.isReady())
    const sends = Array.from({ length: 8 }, (_, i) => link.send({ t: "sync", epoch: "e", seq: i }))
    await new Promise((r) => setTimeout(r, 0))
    expect(hostT.pendingSends()).toBeGreaterThan(0)
    const results = await Promise.all(sends)
    expect(results.every((r) => r.ok)).toBe(true)
    await waitFor(() => seqs.length === 8)
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(hostT.pendingSends()).toBe(0)
  })
})
