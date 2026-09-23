/**
 * Transport over Supabase Realtime private channels (ARCHITECTURE §6.1, §6.3).
 *
 * - Every channel is created through channels.ts#createPrivateChannel (config.private = true); RLS
 *   policies on realtime.messages decide who may join, send and receive per topic.
 * - View channels use acknowledged broadcasts; a send resolving 'error'/'timed out' is a failure.
 * - Never sends while the channel is not joined: send() fails with "not-joined" rather than letting
 *   supabase-js silently fall back to the REST broadcast endpoint.
 * - One token bucket per transport (≈ 25 msg/s) delays sends (FIFO, never drops); the size guard
 *   rejects payloads over 200 KB so callers switch to player_views + snapshot_ready.
 * - Channel supervisor: CHANNEL_ERROR / TIMED_OUT → realtime.setAuth() (usually a stale JWT), then
 *   phoenix's built-in rejoin retries; an unexpected CLOSED → removeChannel + recreate with backoff.
 */
import type { RealtimeChannel } from "@supabase/supabase-js"

import { createPrivateChannel } from "./channels"
import { getSupabase, type AtlasClient } from "./supabase"
import { REALTIME_SEND_RATE, TokenBucket, type TokenBucketOptions } from "./tokenBucket"
import {
  buildHostChannels,
  buildPlayerChannels,
  encodePayload,
  Listeners,
  SEND_OK,
  sendFailure,
  type ChannelStatus,
  type HostChannelOptions,
  type HostChannels,
  type PlayerChannelOptions,
  type PlayerChannels,
  type PresenceEntry,
  type RawChannel,
  type RawChannelFactory,
  type RawChannelOptions,
  type SendResult,
  type StatusEvent,
  type Transport,
  type Unsubscribe,
} from "./transport"

export interface SupabaseTransportOptions {
  /** Send budget for this client connection. Default REALTIME_SEND_RATE (25 msg/s, burst 10). */
  rate?: TokenBucketOptions
  /** Delay before recreating the n-th consecutive unexpectedly closed channel (n from 0). */
  backoff?: (attempt: number) => number
}

/** 1 s, 2 s, 4 s … capped at 30 s, ±25 % jitter so many clients do not reconnect in lockstep. */
export function defaultBackoff(attempt: number): number {
  const base = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))
  return Math.round(base * (0.75 + Math.random() * 0.5))
}

interface Ctx {
  client: AtlasClient
  bucket: TokenBucket
  backoff: (attempt: number) => number
}

type SubscribeState = "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR"

function mapResponse(res: string): SendResult {
  if (res === "ok") return SEND_OK
  if (res === "timed out") return sendFailure("timed-out")
  return sendFailure("error", res)
}

/** A RawChannel backed by (a succession of) supabase-js channels on one topic. */
class SupervisedChannel implements RawChannel {
  private channel: RealtimeChannel | null = null
  private current: ChannelStatus = "JOINING"
  private readonly statusListeners = new Listeners<[StatusEvent]>()
  private readonly broadcastListeners = new Listeners<[string, unknown]>()
  private readonly presenceListeners = new Listeners<[PresenceEntry[]]>()
  private trackMeta: Record<string, unknown> | null = null
  private started = false
  private closed = false
  private recreateAttempt = 0
  private recreateTimer: ReturnType<typeof setTimeout> | null = null

  private readonly ctx: Ctx
  readonly topic: string
  private readonly opts: RawChannelOptions
  private readonly onDisposed: () => void

  constructor(ctx: Ctx, topic: string, opts: RawChannelOptions, onDisposed: () => void) {
    this.ctx = ctx
    this.topic = topic
    this.opts = opts
    this.onDisposed = onDisposed
  }

  status(): ChannelStatus {
    return this.current
  }

  onStatus(cb: (ev: StatusEvent) => void): Unsubscribe {
    return this.statusListeners.add(cb)
  }

  onBroadcast(cb: (event: string, payload: unknown) => void): Unsubscribe {
    return this.broadcastListeners.add(cb)
  }

  onPresence(cb: (entries: PresenceEntry[]) => void): Unsubscribe {
    return this.presenceListeners.add(cb)
  }

  presence(): PresenceEntry[] {
    const ch = this.channel
    if (!ch || !this.opts.presence) return []
    const state = ch.presenceState() as Record<string, Array<Record<string, unknown>>>
    return Object.keys(state)
      .sort()
      .map((key) => ({
        key,
        metas: state[key].map((meta) => {
          const copy = { ...meta }
          delete copy.presence_ref
          return copy
        }),
      }))
  }

  subscribe(): void {
    if (this.started || this.closed) return
    this.started = true
    this.create()
  }

  async send(event: string, payload: unknown): Promise<SendResult> {
    if (this.closed) return sendFailure("closed")
    const encoded = encodePayload(payload)
    if (!encoded.ok) return encoded.result
    if (!this.isJoined()) return sendFailure("not-joined")
    const granted = await this.ctx.bucket.take()
    if (!granted || this.closed) return sendFailure("closed")
    // The channel may have dropped while we waited for a token: re-check right before sending, in
    // the same synchronous step as the send, so supabase-js never takes its REST fallback path.
    const ch = this.channel
    if (!ch || !this.isJoined()) return sendFailure("not-joined")
    try {
      return mapResponse(await ch.send({ type: "broadcast", event, payload }))
    } catch (err) {
      return sendFailure("error", String(err))
    }
  }

  async track(meta: Record<string, unknown>): Promise<SendResult> {
    this.trackMeta = meta
    if (this.closed) return sendFailure("closed")
    if (!this.isJoined()) return sendFailure("not-joined")
    return this.trackNow()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.recreateTimer !== null) clearTimeout(this.recreateTimer)
    this.recreateTimer = null
    const ch = this.channel
    this.channel = null
    this.setStatus({ status: "CLOSED", willRetry: false })
    this.statusListeners.clear()
    this.broadcastListeners.clear()
    this.presenceListeners.clear()
    this.onDisposed()
    if (ch) await this.ctx.client.removeChannel(ch).catch(() => "error")
  }

  private isJoined(): boolean {
    const ch = this.channel
    return ch !== null && ch.state === "joined" && this.ctx.client.realtime.isConnected()
  }

  private setStatus(ev: StatusEvent): void {
    this.current = ev.status
    this.statusListeners.emit(ev)
  }

  private create(): void {
    let ch: RealtimeChannel
    try {
      ch = createPrivateChannel(this.ctx.client, this.topic, { ack: this.opts.ack, presenceKey: this.opts.presence?.key ?? null })
    } catch (err) {
      // e.g. the previous channel object has not been released yet: try again later.
      this.setStatus({ status: "CHANNEL_ERROR", error: err instanceof Error ? err : new Error(String(err)) })
      this.scheduleRecreate()
      return
    }
    for (const event of this.opts.events) {
      ch.on("broadcast", { event }, (msg: { payload?: unknown }) => {
        if (ch === this.channel) this.broadcastListeners.emit(event, msg.payload)
      })
    }
    if (this.opts.presence) {
      ch.on("presence", { event: "sync" }, () => {
        if (ch === this.channel) this.presenceListeners.emit(this.presence())
      })
    }
    this.channel = ch
    if (this.current !== "JOINING") this.setStatus({ status: "JOINING" })
    ch.subscribe((status: SubscribeState, err?: Error) => this.handleStatus(ch, status, err))
  }

  private handleStatus(ch: RealtimeChannel, status: SubscribeState, err?: Error): void {
    // Callbacks from a channel we already replaced or closed are stale.
    if (ch !== this.channel || this.closed) return
    switch (status) {
      case "SUBSCRIBED":
        this.recreateAttempt = 0
        this.setStatus({ status: "SUBSCRIBED" })
        // Presence does not survive a rejoin on the server: track again.
        if (this.trackMeta) void this.trackNow()
        break
      case "CHANNEL_ERROR":
      case "TIMED_OUT":
        this.setStatus(err ? { status, error: err } : { status })
        // The usual cause is an expired/rotated JWT: push the current token to the socket; phoenix's
        // rejoin timer then retries the join with it.
        void this.ctx.client.realtime.setAuth().catch(() => undefined)
        break
      case "CLOSED":
        // We only get here for closes we did not ask for (ours detach the channel first).
        this.setStatus({ status: "CLOSED", willRetry: true })
        this.scheduleRecreate()
        break
    }
  }

  private scheduleRecreate(): void {
    if (this.closed || this.recreateTimer !== null) return
    const old = this.channel
    this.channel = null
    const delay = this.ctx.backoff(this.recreateAttempt++)
    this.recreateTimer = setTimeout(() => {
      this.recreateTimer = null
      void (async () => {
        if (old) await this.ctx.client.removeChannel(old).catch(() => "error")
        if (!this.closed) this.create()
      })()
    }, delay)
  }

  private async trackNow(): Promise<SendResult> {
    const ch = this.channel
    const meta = this.trackMeta
    if (!ch || !meta) return sendFailure("not-joined")
    const granted = await this.ctx.bucket.take()
    if (!granted || this.closed) return sendFailure("closed")
    if (ch !== this.channel || !this.isJoined()) return sendFailure("not-joined")
    try {
      return mapResponse(await ch.track(meta))
    } catch (err) {
      return sendFailure("error", String(err))
    }
  }
}

/** Browser event target for online/offline (absent under Node). */
export interface OnlineEvents {
  addEventListener(type: "online" | "offline", cb: () => void): void
  removeEventListener(type: "online" | "offline", cb: () => void): void
}

/**
 * This device's connection: `navigator.onLine` (instant, via the online/offline events) and the
 * Realtime socket (polled; lost = it was connected and has been down for two polls in a row, so a
 * quick reconnect does not flap). Polling only runs while someone listens.
 */
export class NetworkMonitor {
  private readonly listeners = new Listeners<[boolean]>()
  private last = true
  private socketSeen = false
  private socketDownPolls = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private listenerCount = 0
  private readonly socketConnected: () => boolean
  private readonly pollMs: number
  private readonly navigatorOnline: () => boolean
  private readonly events: OnlineEvents | null
  private readonly onEvent = () => this.check()

  constructor(
    socketConnected: () => boolean,
    opts: { pollMs?: number; navigatorOnline?: () => boolean; events?: OnlineEvents | null } = {}
  ) {
    this.socketConnected = socketConnected
    this.pollMs = opts.pollMs ?? 1000
    this.navigatorOnline = opts.navigatorOnline ?? (() => typeof navigator === "undefined" || navigator.onLine !== false)
    this.events = opts.events !== undefined ? opts.events : typeof window !== "undefined" && typeof window.addEventListener === "function" ? window : null
  }

  online(): boolean {
    return this.navigatorOnline() && !(this.socketSeen && this.socketDownPolls >= 2)
  }

  onChange(cb: (online: boolean) => void): Unsubscribe {
    const off = this.listeners.add(cb)
    if (this.timer === null) {
      this.last = this.online()
      this.events?.addEventListener("online", this.onEvent)
      this.events?.addEventListener("offline", this.onEvent)
      this.timer = setInterval(() => this.poll(), this.pollMs)
    }
    this.listenerCount++
    let done = false
    return () => {
      if (done) return
      done = true
      off()
      if (--this.listenerCount === 0) this.stop()
    }
  }

  /** One socket poll (exposed for tests). */
  poll(): void {
    let connected: boolean
    try {
      connected = this.socketConnected()
    } catch {
      connected = true
    }
    if (connected) {
      this.socketSeen = true
      this.socketDownPolls = 0
    } else if (this.socketSeen) {
      this.socketDownPolls++
    }
    this.check()
  }

  private check(): void {
    const now = this.online()
    if (now === this.last) return
    this.last = now
    this.listeners.emit(now)
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.events?.removeEventListener("online", this.onEvent)
    this.events?.removeEventListener("offline", this.onEvent)
  }
}

export class SupabaseTransport implements Transport {
  readonly kind = "supabase" as const
  private readonly ctx: Ctx
  private readonly channels = new Set<SupervisedChannel>()
  private disposed = false
  private readonly network: NetworkMonitor

  constructor(client: AtlasClient = getSupabase(), opts: SupabaseTransportOptions = {}) {
    this.ctx = { client, bucket: new TokenBucket(opts.rate ?? REALTIME_SEND_RATE), backoff: opts.backoff ?? defaultBackoff }
    this.network = new NetworkMonitor(() => client.realtime.isConnected())
  }

  networkOnline(): boolean {
    return this.network.online()
  }

  onNetworkChange(cb: (online: boolean) => void): Unsubscribe {
    return this.network.onChange(cb)
  }

  private readonly factory: RawChannelFactory = (topic, opts) => {
    if (this.disposed) throw new Error("transport disposed")
    const ch: SupervisedChannel = new SupervisedChannel(this.ctx, topic, opts, () => this.channels.delete(ch))
    this.channels.add(ch)
    return ch
  }

  openHostChannels(sessionId: string, epoch: string, opts?: HostChannelOptions): HostChannels {
    return buildHostChannels(this.factory, sessionId, epoch, opts)
  }

  openPlayerChannels(sessionId: string, userId: string, opts?: PlayerChannelOptions): PlayerChannels {
    return buildPlayerChannels(this.factory, sessionId, userId, opts)
  }

  pendingSends(): number {
    return this.ctx.bucket.pending
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.network.stop()
    this.ctx.bucket.dispose()
    await Promise.all([...this.channels].map((c) => c.close()))
  }
}

export function createSupabaseTransport(client: AtlasClient = getSupabase(), opts?: SupabaseTransportOptions): SupabaseTransport {
  return new SupabaseTransport(client, opts)
}
