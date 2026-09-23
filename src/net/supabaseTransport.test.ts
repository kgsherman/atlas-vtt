import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AtlasClient } from "./supabase"
import { NetworkMonitor, SupabaseTransport } from "./supabaseTransport"
import { MAX_BROADCAST_BYTES } from "./transport"

const SID = "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const DM = "d0000000-0000-4000-8000-000000000001"
const P1 = "a1000000-0000-4000-8000-000000000001"

type Status = "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED"

/** Just enough of supabase-js RealtimeChannel for the transport. */
class FakeChannel {
  readonly topic: string
  readonly params: { config: { private?: boolean; broadcast?: { ack?: boolean; self?: boolean }; presence?: { key?: string; enabled?: boolean } } }
  readonly private: boolean
  state = "closed"
  sendResult = "ok"
  readonly sent: unknown[] = []
  readonly tracked: unknown[] = []
  presence: Record<string, Array<Record<string, unknown>>> = {}
  private readonly bindings: Array<{ type: string; filter: { event?: string }; cb: (payload: unknown) => void }> = []
  private subscribeCb: ((status: Status, err?: Error) => void) | null = null

  constructor(topic: string, params: FakeChannel["params"]) {
    this.topic = `realtime:${topic}`
    this.params = structuredClone(params)
    this.private = params.config.private === true
  }

  on(type: string, filter: { event?: string }, cb: (payload: unknown) => void) {
    this.bindings.push({ type, filter, cb })
    return this
  }

  subscribe(cb: (status: Status, err?: Error) => void) {
    this.subscribeCb = cb
    this.state = "joining"
    return this
  }

  async send(msg: unknown) {
    this.sent.push(msg)
    return this.sendResult
  }

  async track(meta: unknown) {
    this.tracked.push(meta)
    return "ok"
  }

  presenceState() {
    return this.presence
  }

  // --- test controls
  get subscribed() {
    return this.subscribeCb !== null
  }

  emit(status: Status, err?: Error) {
    this.state = status === "SUBSCRIBED" ? "joined" : status === "CLOSED" ? "closed" : "errored"
    this.subscribeCb?.(status, err)
  }

  deliver(event: string, payload: unknown) {
    for (const b of this.bindings) if (b.type === "broadcast" && b.filter.event === event) b.cb({ type: "broadcast", event, payload })
  }

  syncPresence(state: FakeChannel["presence"]) {
    this.presence = state
    for (const b of this.bindings) if (b.type === "presence" && b.filter.event === "sync") b.cb(undefined)
  }
}

class FakeClient {
  readonly all: FakeChannel[] = []
  readonly removed = new Set<FakeChannel>()
  connected = true
  setAuthCalls = 0
  readonly realtime = {
    isConnected: () => this.connected,
    setAuth: async () => {
      this.setAuthCalls++
    },
  }

  channel(topic: string, params: FakeChannel["params"]) {
    const ch = new FakeChannel(topic, params)
    this.all.push(ch)
    return ch
  }

  getChannels() {
    return this.all.filter((c) => !this.removed.has(c))
  }

  async removeChannel(ch: FakeChannel) {
    this.removed.add(ch)
    ch.state = "closed"
    return "ok"
  }

  live(suffix: string): FakeChannel {
    const found = this.getChannels().filter((c) => c.topic.endsWith(suffix))
    if (found.length !== 1) throw new Error(`expected one live channel *${suffix}, found ${found.length}`)
    return found[0]
  }
}

describe("SupabaseTransport", () => {
  let fake: FakeClient
  let transport: SupabaseTransport

  beforeEach(() => {
    vi.useFakeTimers()
    fake = new FakeClient()
    transport = new SupabaseTransport(fake as unknown as AtlasClient, { rate: { ratePerSecond: 1000, burst: 100 }, backoff: (n) => 1000 * (n + 1) })
  })
  afterEach(async () => {
    await transport.dispose()
    vi.useRealTimers()
  })

  it("creates only private channels, view channels acknowledged on the host", () => {
    const host = transport.openHostChannels(SID, "e", { userId: DM })
    host.openPlayer(P1)
    expect(fake.all.map((c) => c.topic.replace(`realtime:session:${SID}:`, "")).sort()).toEqual(["host", "lobby", `req:${P1}`, `view:${P1}`])
    for (const ch of fake.all) {
      expect(ch.private).toBe(true)
      expect(ch.params.config.private).toBe(true)
    }
    expect(fake.live(`:view:${P1}`).params.config.broadcast).toEqual({ ack: true, self: false })
    expect(fake.live(`:req:${P1}`).params.config.broadcast).toEqual({ ack: false, self: false })
    expect(fake.live(":host").params.config.presence).toEqual({ key: DM, enabled: true })
  })

  it("player joins view first and req only after view is SUBSCRIBED", () => {
    const player = transport.openPlayerChannels(SID, P1)
    expect(fake.getChannels().some((c) => c.topic.includes(":req:"))).toBe(false)
    const view = fake.live(`:view:${P1}`)
    expect(view.subscribed).toBe(true)
    view.emit("SUBSCRIBED")
    const req = fake.live(`:req:${P1}`)
    expect(req.subscribed).toBe(true)
    const ready = vi.fn()
    player.onReady(ready)
    req.emit("SUBSCRIBED")
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it("never sends while not joined (no REST fallback) and maps ack results", async () => {
    const link = transport.openHostChannels(SID, "e", { userId: DM }).openPlayer(P1)
    const view = fake.live(`:view:${P1}`)
    const msg = { t: "sync" as const, epoch: "e", seq: 1 }
    expect(await link.send(msg)).toEqual({ ok: false, reason: "not-joined" })
    view.emit("SUBSCRIBED")
    fake.connected = false
    expect(await link.send(msg)).toEqual({ ok: false, reason: "not-joined" })
    expect(view.sent).toEqual([])
    fake.connected = true
    expect(await link.send(msg)).toEqual({ ok: true })
    expect(view.sent).toEqual([{ type: "broadcast", event: "view", payload: msg }])
    view.sendResult = "timed out"
    expect(await link.send(msg)).toEqual({ ok: false, reason: "timed-out" })
    view.sendResult = "error"
    expect(await link.send(msg)).toMatchObject({ ok: false, reason: "error" })
  })

  it("rejects payloads over 200 KB before they reach the channel", async () => {
    const link = transport.openHostChannels(SID, "e", { userId: DM }).openPlayer(P1)
    const view = fake.live(`:view:${P1}`)
    view.emit("SUBSCRIBED")
    const res = await link.send({ t: "kicked", reason: "x".repeat(MAX_BROADCAST_BYTES) })
    expect(res).toMatchObject({ ok: false, reason: "too-large" })
    expect(view.sent).toEqual([])
  })

  it("delivers requests from req:{uid} to that link only", () => {
    const link = transport.openHostChannels(SID, "e", { userId: DM }).openPlayer(P1)
    const got: unknown[] = []
    link.onRequest((m) => got.push(m))
    fake.live(`:req:${P1}`).deliver("req", { t: "hello", nonce: "n", epoch: null, lastSeq: null })
    fake.live(`:req:${P1}`).deliver("other-event", { t: "hello" })
    expect(got).toEqual([{ t: "hello", nonce: "n", epoch: null, lastSeq: null }])
  })

  it("CHANNEL_ERROR / TIMED_OUT refresh auth and leave rejoining to phoenix", () => {
    const host = transport.openHostChannels(SID, "e", { userId: DM })
    const ch = fake.live(":host")
    const statuses: string[] = []
    host.host.onStatus((ev) => statuses.push(`${ev.status}${ev.error ? `:${ev.error.message}` : ""}`))
    ch.emit("CHANNEL_ERROR", new Error("Unauthorized"))
    ch.emit("TIMED_OUT")
    expect(statuses).toEqual(["CHANNEL_ERROR:Unauthorized", "TIMED_OUT"])
    expect(fake.setAuthCalls).toBe(2)
    expect(fake.removed.size).toBe(0)
    ch.emit("SUBSCRIBED")
    expect(host.host.status()).toBe("SUBSCRIBED")
  })

  it("recreates a channel after an unexpected CLOSED, with backoff, and re-tracks presence", async () => {
    const host = transport.openHostChannels(SID, "epoch-9", { userId: DM })
    const first = fake.live(":host")
    first.emit("SUBSCRIBED")
    await vi.advanceTimersByTimeAsync(0)
    expect(first.tracked).toEqual([expect.objectContaining({ role: "host", epoch: "epoch-9" })])

    const events: Array<{ status: string; willRetry?: boolean }> = []
    host.host.onStatus((ev) => events.push({ status: ev.status, willRetry: ev.willRetry }))
    first.emit("CLOSED")
    expect(events).toEqual([{ status: "CLOSED", willRetry: true }])
    await vi.advanceTimersByTimeAsync(999)
    expect(fake.all).toHaveLength(2) // host + lobby, nothing recreated yet
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.removed.has(first)).toBe(true)
    const second = fake.live(":host")
    expect(second).not.toBe(first)
    expect(second.private).toBe(true)
    expect(events.at(-1)).toEqual({ status: "JOINING", willRetry: undefined })

    // Callbacks from the replaced channel are ignored.
    first.emit("SUBSCRIBED")
    expect(host.host.status()).toBe("JOINING")

    second.emit("SUBSCRIBED")
    await vi.advanceTimersByTimeAsync(0)
    expect(second.tracked).toEqual([expect.objectContaining({ role: "host", epoch: "epoch-9" })])

    // Backoff grows with consecutive failures and resets after SUBSCRIBED.
    second.emit("CLOSED")
    await vi.advanceTimersByTimeAsync(1000)
    expect(fake.live(":host")).not.toBe(second)
  })

  it("close() is final: CLOSED without retry, channel removed, late callbacks ignored", async () => {
    const player = transport.openPlayerChannels(SID, P1)
    const view = fake.live(`:view:${P1}`)
    view.emit("SUBSCRIBED")
    const events: Array<{ status: string; willRetry?: boolean }> = []
    player.view.onStatus((ev) => events.push({ status: ev.status, willRetry: ev.willRetry }))
    await player.close()
    expect(events).toEqual([{ status: "CLOSED", willRetry: false }])
    expect(fake.removed.has(view)).toBe(true)
    view.emit("CLOSED")
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.getChannels()).toEqual([])
    expect(await player.req.send({ t: "hello", nonce: "n", epoch: null, lastSeq: null })).toEqual({ ok: false, reason: "closed" })
  })

  it("maps presence state and reports DM presence to the player", () => {
    const player = transport.openPlayerChannels(SID, P1)
    const host = fake.live(":host")
    host.emit("SUBSCRIBED")
    const online: boolean[] = []
    player.host.onHostPresence((v) => online.push(v))
    host.syncPresence({ [DM]: [{ presence_ref: "r1", role: "host", epoch: "e" }] })
    expect(player.host.presence()).toEqual([{ key: DM, metas: [{ role: "host", epoch: "e" }] }])
    expect(player.host.hostOnline()).toBe(true)
    host.syncPresence({})
    expect(online).toEqual([true, false])
  })

  it("dispose() closes every channel", async () => {
    transport.openHostChannels(SID, "e", { userId: DM }).openPlayer(P1)
    for (const ch of fake.all) ch.emit("SUBSCRIBED")
    await transport.dispose()
    expect(fake.getChannels()).toEqual([])
  })
})

describe("NetworkMonitor", () => {
  it("reports this device offline from navigator.onLine at once and from the socket after two failed polls", () => {
    let navOnline = true
    let socket = false
    const handlers = new Map<string, () => void>()
    const events = {
      addEventListener: (type: "online" | "offline", cb: () => void) => void handlers.set(type, cb),
      removeEventListener: (type: "online" | "offline") => void handlers.delete(type),
    }
    const mon = new NetworkMonitor(() => socket, { pollMs: 60_000, navigatorOnline: () => navOnline, events })
    const seen: boolean[] = []
    const off = mon.onChange((online) => seen.push(online))
    // Not connected yet (still joining): that is not "offline".
    mon.poll()
    expect(mon.online()).toBe(true)
    socket = true
    mon.poll()
    // The socket drops: one failed poll may be a quick reconnect, two are an outage.
    socket = false
    mon.poll()
    expect(mon.online()).toBe(true)
    mon.poll()
    expect(mon.online()).toBe(false)
    socket = true
    mon.poll()
    expect(mon.online()).toBe(true)
    // The browser says offline: reported on its event, no poll needed.
    navOnline = false
    handlers.get("offline")?.()
    expect(mon.online()).toBe(false)
    navOnline = true
    handlers.get("online")?.()
    expect(seen).toEqual([false, true, false, true])
    off()
    expect(handlers.size).toBe(0)
  })
})
