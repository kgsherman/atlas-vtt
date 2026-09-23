/**
 * Transport abstraction shared by the host runner (DM tab) and the player client (ARCHITECTURE §6.1,
 * §6.3). Two implementations:
 *  - SupabaseTransport (supabaseTransport.ts): private Realtime channels authorised by RLS.
 *  - LocalTransport (localTransport.ts): BroadcastChannel between tabs of one browser. Dev/test
 *    only, NOT secure (no authorisation at all).
 *
 * Topics (`channels.ts#topics`):
 *   session:{sid}:req:{uid}   player → host   ClientToHost   (sender = {uid}, enforced by RLS)
 *   session:{sid}:view:{uid}  host → player   HostToClient   (acknowledged broadcasts)
 *   session:{sid}:host        host → all      HostBroadcast  + DM presence (= host online)
 *   session:{sid}:lobby       members         presence only  (display only)
 *
 * Both transports implement the small `RawChannel` primitive; the role-specific wiring (join order,
 * ready events, presence) lives here once, in `buildHostChannels` / `buildPlayerChannels`.
 */
import type { ClientToHost, HostBroadcast, HostToClient } from "@/core/session/types"

import { BROADCAST_EVENTS, topics } from "./channels"

// ---------------------------------------------------------------------------
// Primitive types
// ---------------------------------------------------------------------------

/** Mirrors supabase-js REALTIME_SUBSCRIBE_STATES, plus JOINING before the first reply. */
export type ChannelStatus = "JOINING" | "SUBSCRIBED" | "CHANNEL_ERROR" | "TIMED_OUT" | "CLOSED"

export interface StatusEvent {
  status: ChannelStatus
  error?: Error
  /**
   * CLOSED only: true when the close was unexpected and the transport will recreate the channel
   * (with backoff); false when it was closed on purpose.
   */
  willRetry?: boolean
}

export type SendFailure =
  /** The channel is not joined (never falls back to REST): retry after SUBSCRIBED. */
  | "not-joined"
  /** Payload over MAX_BROADCAST_BYTES: use the database (player_views + snapshot_ready) instead. */
  | "too-large"
  /** No server acknowledgement in time (acknowledged channels only). */
  | "timed-out"
  /** The server rejected the message. */
  | "error"
  /** The channel or transport was closed. */
  | "closed"

export type SendResult = { ok: true } | { ok: false; reason: SendFailure; detail?: string }

export const SEND_OK: SendResult = Object.freeze({ ok: true })

export function sendFailure(reason: SendFailure, detail?: string): SendResult {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail }
}

export type Unsubscribe = () => void

/**
 * One presence key with its metas (one per connected tab). UNTRUSTED and display-only: membership
 * always comes from session_members, never from presence.
 */
export interface PresenceEntry {
  key: string
  metas: Array<Record<string, unknown>>
}

/** Size guard: Realtime rejects broadcasts over 256 KB; stay well below with headroom for framing. */
export const MAX_BROADCAST_BYTES = 200 * 1024

/** UTF-8 byte length of a string without allocating an encoded copy. */
export function utf8Length(s: string): number {
  let bytes = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      // surrogate pair → one 4-byte code point
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

/** Serialise a payload for the wire and apply the size guard. */
export function encodePayload(payload: unknown): { ok: true; json: string; bytes: number } | { ok: false; result: SendResult } {
  let json: string | undefined
  try {
    json = JSON.stringify(payload)
  } catch (err) {
    return { ok: false, result: sendFailure("error", `payload is not JSON-serialisable: ${String(err)}`) }
  }
  if (json === undefined) return { ok: false, result: sendFailure("error", "payload is not JSON-serialisable") }
  // Every UTF-16 unit is at least one UTF-8 byte, so only count when the result could matter.
  const bytes = json.length > MAX_BROADCAST_BYTES ? json.length : utf8Length(json)
  if (bytes > MAX_BROADCAST_BYTES) return { ok: false, result: sendFailure("too-large", `${bytes} bytes > ${MAX_BROADCAST_BYTES}`) }
  return { ok: true, json, bytes }
}

// ---------------------------------------------------------------------------
// Raw channel (implemented by each transport)
// ---------------------------------------------------------------------------

export interface RawChannelOptions {
  /** Broadcast event names this channel delivers to onBroadcast listeners. */
  events: readonly string[]
  /** Server-acknowledged broadcasts: send() resolves after the server accepted the message. */
  ack: boolean
  /** Receive presence (and use `key` when tracking). null = presence disabled. */
  presence: { key: string } | null
}

export interface RawChannel {
  readonly topic: string
  status(): ChannelStatus
  onStatus(cb: (ev: StatusEvent) => void): Unsubscribe
  onBroadcast(cb: (event: string, payload: unknown) => void): Unsubscribe
  onPresence(cb: (entries: PresenceEntry[]) => void): Unsubscribe
  presence(): PresenceEntry[]
  /** Rate-limited, size-guarded broadcast. Fails with "not-joined" instead of queueing or using REST. */
  send(event: string, payload: unknown): Promise<SendResult>
  /**
   * Set this client's presence meta. Tracked immediately when joined (the result reflects that) and
   * re-tracked after every rejoin; before the first join it is remembered and "not-joined" returned.
   */
  track(meta: Record<string, unknown>): Promise<SendResult>
  /** Start joining. Kept separate from creation so listeners attach first and joins can be ordered. */
  subscribe(): void
  close(): Promise<void>
}

export type RawChannelFactory = (topic: string, opts: RawChannelOptions) => RawChannel

// ---------------------------------------------------------------------------
// Role-level API
// ---------------------------------------------------------------------------

export interface ChannelView {
  readonly topic: string
  status(): ChannelStatus
  /** Status transitions. SUBSCRIBED fires again after every rejoin/recreation. */
  onStatus(cb: (ev: StatusEvent) => void): Unsubscribe
}

export interface PresenceView {
  presence(): PresenceEntry[]
  onPresence(cb: (entries: PresenceEntry[]) => void): Unsubscribe
}

/** Host side of one player: receives `req:{uid}`, sends on `view:{uid}`. */
export interface HostPlayerLink {
  readonly userId: string
  readonly req: ChannelView
  readonly view: ChannelView
  /**
   * Raw, UNTRUSTED request payloads from `req:{uid}`: validate with core/session parseClientMessage.
   * The sender is `userId` (RLS: only that user can write the topic) — never a payload field.
   */
  onRequest(cb: (raw: unknown) => void): Unsubscribe
  /**
   * Fires every time both channels are SUBSCRIBED after either (re)joined — boot, reconnect,
   * recreated channel, newly opened member. Push a snapshot / snapshot_ready here (§6.3).
   */
  onReady(cb: () => void): Unsubscribe
  isReady(): boolean
  /** Acknowledged send on `view:{uid}`. */
  send(msg: HostToClient): Promise<SendResult>
  close(): Promise<void>
}

export interface HostChannels {
  readonly sessionId: string
  readonly epoch: string
  /** `session:{sid}:host`: HostBroadcast out + DM presence (tracked automatically: { role: "host", epoch }). */
  readonly host: ChannelView &
    PresenceView & {
      broadcast(msg: HostBroadcast): Promise<SendResult>
      /** Broadcasts from OTHER host instances (e.g. another DM tab/device with a newer epoch). */
      onBroadcast(cb: (msg: HostBroadcast) => void): Unsubscribe
    }
  /** `session:{sid}:lobby`: members' presence (display only; re-read session_members on change). */
  readonly lobby: ChannelView & PresenceView
  /** Open (idempotent) the link to one member. */
  openPlayer(userId: string): HostPlayerLink
  player(userId: string): HostPlayerLink | undefined
  players(): string[]
  closePlayer(userId: string): Promise<void>
  close(): Promise<void>
}

export interface PlayerChannels {
  readonly sessionId: string
  readonly userId: string
  /** `session:{sid}:view:{uid}`: subscribed FIRST (§6.3 join order). */
  readonly view: ChannelView & {
    onMessage(cb: (msg: HostToClient) => void): Unsubscribe
  }
  /** `session:{sid}:req:{uid}`: subscribed only once view reported SUBSCRIBED. */
  readonly req: ChannelView & {
    send(msg: ClientToHost): Promise<SendResult>
  }
  /** Fires on every (re)join where both view and req are SUBSCRIBED: send `hello` here. */
  onReady(cb: () => void): Unsubscribe
  isReady(): boolean
  /** `session:{sid}:host`: HostBroadcast in + DM presence. */
  readonly host: ChannelView &
    PresenceView & {
      onBroadcast(cb: (msg: HostBroadcast) => void): Unsubscribe
      /** DM presence on the host topic (only the DM can track there). */
      hostOnline(): boolean
      onHostPresence(cb: (online: boolean) => void): Unsubscribe
    }
  /** `session:{sid}:lobby`: own presence tracked automatically ({ role: "player", displayName }). */
  readonly lobby: ChannelView & PresenceView
  close(): Promise<void>
}

export interface HostChannelOptions {
  /** The DM's user id, used as the presence key (default "host"; only the DM can track there anyway). */
  userId?: string
}

export interface PlayerChannelOptions {
  /** Shown in the lobby presence (display only). */
  displayName?: string
}

export interface Transport {
  readonly kind: "supabase" | "local"
  /** Host: host + lobby channels now, per-player channels via openPlayer(uid). */
  openHostChannels(sessionId: string, epoch: string, opts?: HostChannelOptions): HostChannels
  /** Player: view → (SUBSCRIBED) → req, plus host and lobby. */
  openPlayerChannels(sessionId: string, userId: string, opts?: PlayerChannelOptions): PlayerChannels
  /** Messages currently waiting for a rate-limit token (lets the host coalesce patches). */
  pendingSends(): number
  /** Close every channel and release resources. */
  dispose(): Promise<void>
}

// ---------------------------------------------------------------------------
// Shared wiring
// ---------------------------------------------------------------------------

/** Minimal shape check for messages from the host (trusted sender, but never crash on garbage). */
function isTagged(value: unknown): value is { t: string } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { t?: unknown }).t === "string"
}

class Listeners<A extends unknown[]> {
  private readonly set = new Set<(...args: A) => void>()

  add(cb: (...args: A) => void): Unsubscribe {
    this.set.add(cb)
    return () => {
      this.set.delete(cb)
    }
  }

  emit(...args: A): void {
    for (const cb of [...this.set]) {
      try {
        cb(...args)
      } catch (err) {
        // A faulty listener must not break the transport or other listeners.
        console.error("[atlas transport] listener failed", err)
      }
    }
  }

  clear(): void {
    this.set.clear()
  }
}

function view(ch: RawChannel): ChannelView {
  return { topic: ch.topic, status: () => ch.status(), onStatus: (cb) => ch.onStatus(cb) }
}

/**
 * "Ready" = every channel SUBSCRIBED. Fires on each SUBSCRIBED event that leaves all of them
 * subscribed, i.e. after every (re)join of either channel.
 */
function readiness(channels: RawChannel[]): { onReady(cb: () => void): Unsubscribe; isReady(): boolean; dispose(): void } {
  const listeners = new Listeners<[]>()
  const isReady = () => channels.every((c) => c.status() === "SUBSCRIBED")
  const offs = channels.map((c) =>
    c.onStatus((ev) => {
      if (ev.status === "SUBSCRIBED" && isReady()) listeners.emit()
    })
  )
  return {
    onReady: (cb) => listeners.add(cb),
    isReady,
    dispose: () => {
      for (const off of offs) off()
      listeners.clear()
    },
  }
}

export function buildHostChannels(factory: RawChannelFactory, sessionId: string, epoch: string, opts: HostChannelOptions = {}): HostChannels {
  const presenceKey = opts.userId ?? "host"
  const hostCh = factory(topics.host(sessionId), { events: [BROADCAST_EVENTS.host], ack: false, presence: { key: presenceKey } })
  const lobbyCh = factory(topics.lobby(sessionId), { events: [], ack: false, presence: { key: presenceKey } })
  const links = new Map<string, { link: HostPlayerLink; close: () => Promise<void> }>()
  let closed = false

  void hostCh.track({ role: "host", epoch, since: new Date().toISOString() })
  hostCh.subscribe()
  lobbyCh.subscribe()

  const openPlayer = (userId: string): HostPlayerLink => {
    if (closed) throw new Error("host channels are closed")
    const existing = links.get(userId)
    if (existing) return existing.link
    const viewCh = factory(topics.view(sessionId, userId), { events: [], ack: true, presence: null })
    const reqCh = factory(topics.req(sessionId, userId), { events: [BROADCAST_EVENTS.req], ack: false, presence: null })
    const ready = readiness([viewCh, reqCh])
    const requests = new Listeners<[unknown]>()
    const offReq = reqCh.onBroadcast((event, payload) => {
      if (event === BROADCAST_EVENTS.req) requests.emit(payload)
    })
    viewCh.subscribe()
    reqCh.subscribe()
    const close = async () => {
      links.delete(userId)
      offReq()
      ready.dispose()
      requests.clear()
      await Promise.all([viewCh.close(), reqCh.close()])
    }
    const link: HostPlayerLink = {
      userId,
      req: view(reqCh),
      view: view(viewCh),
      onRequest: (cb) => requests.add(cb),
      onReady: ready.onReady,
      isReady: ready.isReady,
      send: (msg) => viewCh.send(BROADCAST_EVENTS.view, msg),
      close,
    }
    links.set(userId, { link, close })
    return link
  }

  return {
    sessionId,
    epoch,
    host: {
      ...view(hostCh),
      presence: () => hostCh.presence(),
      onPresence: (cb) => hostCh.onPresence(cb),
      broadcast: (msg) => hostCh.send(BROADCAST_EVENTS.host, msg),
      onBroadcast: (cb) =>
        hostCh.onBroadcast((event, payload) => {
          if (event === BROADCAST_EVENTS.host && isTagged(payload)) cb(payload as HostBroadcast)
        }),
    },
    lobby: { ...view(lobbyCh), presence: () => lobbyCh.presence(), onPresence: (cb) => lobbyCh.onPresence(cb) },
    openPlayer,
    player: (userId) => links.get(userId)?.link,
    players: () => [...links.keys()],
    closePlayer: async (userId) => {
      await links.get(userId)?.close()
    },
    close: async () => {
      if (closed) return
      closed = true
      await Promise.all([...[...links.values()].map((l) => l.close()), hostCh.close(), lobbyCh.close()])
    },
  }
}

function hostIsPresent(entries: PresenceEntry[]): boolean {
  return entries.some((e) => e.metas.some((m) => m.role === "host"))
}

export function buildPlayerChannels(factory: RawChannelFactory, sessionId: string, userId: string, opts: PlayerChannelOptions = {}): PlayerChannels {
  const viewCh = factory(topics.view(sessionId, userId), { events: [BROADCAST_EVENTS.view], ack: false, presence: null })
  const reqCh = factory(topics.req(sessionId, userId), { events: [], ack: false, presence: null })
  const hostCh = factory(topics.host(sessionId), { events: [BROADCAST_EVENTS.host], ack: false, presence: { key: userId } })
  const lobbyCh = factory(topics.lobby(sessionId), { events: [], ack: false, presence: { key: userId } })
  const ready = readiness([viewCh, reqCh])
  const hostPresence = new Listeners<[boolean]>()
  let closed = false

  // §6.3 join order: view first; req only once view is SUBSCRIBED (so no reply can be missed).
  let reqStarted = false
  const offViewStatus = viewCh.onStatus((ev) => {
    if (ev.status === "SUBSCRIBED" && !reqStarted && !closed) {
      reqStarted = true
      reqCh.subscribe()
    }
  })
  let lastOnline = false
  const offHostPresence = hostCh.onPresence((entries) => {
    const online = hostIsPresent(entries)
    if (online !== lastOnline) {
      lastOnline = online
      hostPresence.emit(online)
    }
  })
  // Losing the host channel means we can no longer tell whether the DM is there.
  const offHostStatus = hostCh.onStatus((ev) => {
    if (ev.status !== "SUBSCRIBED" && lastOnline) {
      lastOnline = false
      hostPresence.emit(false)
    }
  })

  void lobbyCh.track({ role: "player", displayName: opts.displayName ?? null, since: new Date().toISOString() })
  viewCh.subscribe()
  hostCh.subscribe()
  lobbyCh.subscribe()

  return {
    sessionId,
    userId,
    view: {
      ...view(viewCh),
      onMessage: (cb) =>
        viewCh.onBroadcast((event, payload) => {
          if (event === BROADCAST_EVENTS.view && isTagged(payload)) cb(payload as HostToClient)
        }),
    },
    req: { ...view(reqCh), send: (msg) => reqCh.send(BROADCAST_EVENTS.req, msg) },
    onReady: ready.onReady,
    isReady: ready.isReady,
    host: {
      ...view(hostCh),
      presence: () => hostCh.presence(),
      onPresence: (cb) => hostCh.onPresence(cb),
      onBroadcast: (cb) =>
        hostCh.onBroadcast((event, payload) => {
          if (event === BROADCAST_EVENTS.host && isTagged(payload)) cb(payload as HostBroadcast)
        }),
      hostOnline: () => hostCh.status() === "SUBSCRIBED" && hostIsPresent(hostCh.presence()),
      onHostPresence: (cb) => hostPresence.add(cb),
    },
    lobby: { ...view(lobbyCh), presence: () => lobbyCh.presence(), onPresence: (cb) => lobbyCh.onPresence(cb) },
    close: async () => {
      if (closed) return
      closed = true
      offViewStatus()
      offHostPresence()
      offHostStatus()
      ready.dispose()
      hostPresence.clear()
      await Promise.all([viewCh.close(), reqCh.close(), hostCh.close(), lobbyCh.close()])
    },
  }
}

/** Resolve once `ch` is SUBSCRIBED (true) or after `timeoutMs` / on CLOSED without retry (false). */
export function whenSubscribed(ch: ChannelView, timeoutMs = 10_000): Promise<boolean> {
  if (ch.status() === "SUBSCRIBED") return Promise.resolve(true)
  return new Promise((resolve) => {
    const finish = (value: boolean) => {
      clearTimeout(timer)
      off()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    const off = ch.onStatus((ev) => {
      if (ev.status === "SUBSCRIBED") finish(true)
      else if (ev.status === "CLOSED" && !ev.willRetry) finish(false)
    })
  })
}

export { Listeners }
