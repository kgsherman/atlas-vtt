/**
 * LocalTransport: the Transport interface over BroadcastChannel, between tabs of ONE browser (same
 * origin), or between instances in one process (Vitest/Node).
 *
 * DEV / TEST ONLY — NOT SECURE. There is no authentication or authorisation of any kind: any script
 * in the origin can read every topic (including other players' views, i.e. data they must not see)
 * and write any topic as anyone. It exists so local-only mode, demos and tests exercise the real
 * host/player code paths. Online play must use SupabaseTransport (RLS-enforced private channels).
 *
 * Emulated semantics (kept close to Supabase Realtime):
 *  - status JOINING → SUBSCRIBED asynchronously after subscribe(); CLOSED on close().
 *  - broadcast with self = false; payloads travel as JSON (so non-JSON values fail like they would
 *    on the wire) through the same 200 KB size guard and token bucket as the Supabase transport.
 *  - presence: tracked metas are announced on join, re-announced when another instance joins, kept
 *    alive by heartbeats and expired after a timeout (a crashed tab disappears); presence state
 *    includes this instance's own entry, like Supabase.
 */
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

/** The subset of BroadcastChannel used here (injectable for tests). */
export interface BroadcastChannelLike {
  postMessage(message: unknown): void
  close(): void
  onmessage: ((ev: MessageEvent) => void) | null
}

type Frame =
  | { k: "b"; from: string; event: string; json: string }
  | { k: "track"; from: string; key: string; meta: Record<string, unknown> }
  | { k: "untrack"; from: string }
  /** A newly joined instance asks everyone to announce their presence. */
  | { k: "hello"; from: string }

export interface LocalTransportOptions {
  /** BroadcastChannel name prefix; isolates unrelated apps/tests. Default "atlas-vtt". */
  namespace?: string
  /** Send budget; null disables rate limiting. Default REALTIME_SEND_RATE (parity with Supabase). */
  rate?: TokenBucketOptions | null
  /** Presence heartbeat interval. Default 5 s. */
  presenceHeartbeatMs?: number
  /** Presence entries not refreshed for this long are dropped. Default 15 s. */
  presenceTimeoutMs?: number
  /** Simulated join latency. Default 0 (next macrotask). */
  joinDelayMs?: number
  createChannel?: (name: string) => BroadcastChannelLike
}

interface Ctx {
  namespace: string
  bucket: TokenBucket | null
  heartbeatMs: number
  timeoutMs: number
  joinDelayMs: number
  createChannel: (name: string) => BroadcastChannelLike
}

interface RemotePresence {
  key: string
  meta: Record<string, unknown>
  seen: number
}

function isFrame(value: unknown): value is Frame {
  return typeof value === "object" && value !== null && typeof (value as { k?: unknown }).k === "string" && typeof (value as { from?: unknown }).from === "string"
}

class LocalChannel implements RawChannel {
  private readonly id = crypto.randomUUID()
  private bc: BroadcastChannelLike | null = null
  private current: ChannelStatus = "JOINING"
  private readonly statusListeners = new Listeners<[StatusEvent]>()
  private readonly broadcastListeners = new Listeners<[string, unknown]>()
  private readonly presenceListeners = new Listeners<[PresenceEntry[]]>()
  private readonly remote = new Map<string, RemotePresence>()
  private trackMeta: Record<string, unknown> | null = null
  private started = false
  private closed = false
  private joinTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null

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
    if (!this.opts.presence) return []
    const byKey = new Map<string, Array<Record<string, unknown>>>()
    const add = (key: string, meta: Record<string, unknown>) => {
      const metas = byKey.get(key) ?? []
      metas.push({ ...meta })
      byKey.set(key, metas)
    }
    if (this.trackMeta && this.current === "SUBSCRIBED") add(this.opts.presence.key, this.trackMeta)
    for (const p of this.remote.values()) add(p.key, p.meta)
    return [...byKey.keys()].sort().map((key) => ({ key, metas: byKey.get(key) ?? [] }))
  }

  subscribe(): void {
    if (this.started || this.closed) return
    this.started = true
    this.join()
  }

  async send(event: string, payload: unknown): Promise<SendResult> {
    if (this.closed) return sendFailure("closed")
    const encoded = encodePayload(payload)
    if (!encoded.ok) return encoded.result
    if (this.current !== "SUBSCRIBED") return sendFailure("not-joined")
    if (this.ctx.bucket) {
      const granted = await this.ctx.bucket.take()
      if (!granted || this.closed) return sendFailure("closed")
      if (this.current !== "SUBSCRIBED") return sendFailure("not-joined")
    }
    this.post({ k: "b", from: this.id, event, json: encoded.json })
    return SEND_OK
  }

  async track(meta: Record<string, unknown>): Promise<SendResult> {
    this.trackMeta = { ...meta }
    if (this.closed) return sendFailure("closed")
    if (this.current !== "SUBSCRIBED") return sendFailure("not-joined")
    this.announce()
    this.emitPresence()
    return SEND_OK
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.trackMeta && this.current === "SUBSCRIBED") this.post({ k: "untrack", from: this.id })
    this.leave()
    this.setStatus({ status: "CLOSED", willRetry: false })
    this.statusListeners.clear()
    this.broadcastListeners.clear()
    this.presenceListeners.clear()
    this.onDisposed()
  }

  /** Test hook: behave like a dropped socket (CHANNEL_ERROR), then rejoin after `rejoinMs`. */
  simulateDrop(rejoinMs = 0): void {
    if (this.closed || !this.started) return
    // Supabase reports a dropped socket's presence as a leave to everyone else.
    if (this.trackMeta && this.current === "SUBSCRIBED") this.post({ k: "untrack", from: this.id })
    this.leave()
    this.remote.clear()
    this.setStatus({ status: "CHANNEL_ERROR", error: new Error("simulated connection loss") })
    this.joinTimer = setTimeout(() => {
      this.joinTimer = null
      if (!this.closed) this.join()
    }, rejoinMs)
  }

  /** Best-effort goodbye when the page is being unloaded. */
  goodbye(): void {
    if (!this.closed && this.trackMeta && this.current === "SUBSCRIBED") this.post({ k: "untrack", from: this.id })
  }

  private join(): void {
    const bc = this.ctx.createChannel(`${this.ctx.namespace}:${this.topic}`)
    bc.onmessage = (ev) => this.receive(ev.data)
    this.bc = bc
    if (this.current !== "JOINING") this.setStatus({ status: "JOINING" })
    this.joinTimer = setTimeout(() => {
      this.joinTimer = null
      if (this.closed || this.bc !== bc) return
      this.setStatus({ status: "SUBSCRIBED" })
      if (this.opts.presence) {
        this.post({ k: "hello", from: this.id })
        this.announce()
        this.emitPresence()
        this.heartbeat = setInterval(() => this.tick(), this.ctx.heartbeatMs)
      }
    }, this.ctx.joinDelayMs)
  }

  private leave(): void {
    if (this.joinTimer !== null) clearTimeout(this.joinTimer)
    if (this.heartbeat !== null) clearInterval(this.heartbeat)
    this.joinTimer = null
    this.heartbeat = null
    if (this.bc) {
      this.bc.onmessage = null
      this.bc.close()
      this.bc = null
    }
  }

  private post(frame: Frame): void {
    this.bc?.postMessage(frame)
  }

  private announce(): void {
    if (this.trackMeta && this.opts.presence && this.current === "SUBSCRIBED") {
      this.post({ k: "track", from: this.id, key: this.opts.presence.key, meta: this.trackMeta })
    }
  }

  private tick(): void {
    this.announce()
    const cutoff = Date.now() - this.ctx.timeoutMs
    let changed = false
    for (const [id, p] of this.remote) {
      if (p.seen < cutoff) {
        this.remote.delete(id)
        changed = true
      }
    }
    if (changed) this.emitPresence()
  }

  private emitPresence(): void {
    if (this.opts.presence) this.presenceListeners.emit(this.presence())
  }

  private setStatus(ev: StatusEvent): void {
    this.current = ev.status
    this.statusListeners.emit(ev)
  }

  private receive(data: unknown): void {
    // Frames only count once this instance has "joined", like server-side delivery.
    if (this.closed || this.current !== "SUBSCRIBED" || !isFrame(data) || data.from === this.id) return
    switch (data.k) {
      case "b": {
        if (!this.opts.events.includes(data.event)) return
        let payload: unknown
        try {
          payload = JSON.parse(data.json)
        } catch {
          return
        }
        this.broadcastListeners.emit(data.event, payload)
        return
      }
      case "track": {
        if (!this.opts.presence) return
        const prev = this.remote.get(data.from)
        this.remote.set(data.from, { key: data.key, meta: data.meta, seen: Date.now() })
        if (!prev || JSON.stringify(prev.meta) !== JSON.stringify(data.meta) || prev.key !== data.key) this.emitPresence()
        return
      }
      case "untrack":
        if (this.remote.delete(data.from)) this.emitPresence()
        return
      case "hello":
        this.announce()
        return
    }
  }
}

export class LocalTransport implements Transport {
  readonly kind = "local" as const
  private readonly ctx: Ctx
  private readonly channels = new Set<LocalChannel>()
  private readonly onPageHide: (() => void) | null = null
  private disposed = false

  constructor(opts: LocalTransportOptions = {}) {
    const rate = opts.rate === undefined ? REALTIME_SEND_RATE : opts.rate
    this.ctx = {
      namespace: opts.namespace ?? "atlas-vtt",
      bucket: rate ? new TokenBucket(rate) : null,
      heartbeatMs: opts.presenceHeartbeatMs ?? 5000,
      timeoutMs: opts.presenceTimeoutMs ?? 15_000,
      joinDelayMs: opts.joinDelayMs ?? 0,
      createChannel: opts.createChannel ?? ((name) => new BroadcastChannel(name) as BroadcastChannelLike),
    }
    if (typeof globalThis.addEventListener === "function" && typeof window !== "undefined") {
      this.onPageHide = () => {
        for (const ch of this.channels) ch.goodbye()
      }
      globalThis.addEventListener("pagehide", this.onPageHide)
    }
  }

  private readonly factory: RawChannelFactory = (topic, opts) => {
    if (this.disposed) throw new Error("transport disposed")
    const ch: LocalChannel = new LocalChannel(this.ctx, topic, opts, () => this.channels.delete(ch))
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
    return this.ctx.bucket?.pending ?? 0
  }

  /**
   * Test hook: every open channel whose topic matches drops (CHANNEL_ERROR) and rejoins after
   * `rejoinMs`, re-announcing presence — exercises reconnection paths without a network.
   */
  simulateDrop(match: (topic: string) => boolean = () => true, rejoinMs = 0): void {
    for (const ch of this.channels) if (match(ch.topic)) ch.simulateDrop(rejoinMs)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.onPageHide) globalThis.removeEventListener("pagehide", this.onPageHide)
    this.ctx.bucket?.dispose()
    await Promise.all([...this.channels].map((c) => c.close()))
  }
}

export function createLocalTransport(opts?: LocalTransportOptions): LocalTransport {
  return new LocalTransport(opts)
}
