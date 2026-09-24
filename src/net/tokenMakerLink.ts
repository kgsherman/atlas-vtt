/**
 * The Token Maker ↔ game tab link (ARCHITECTURE §11). The Token Maker lives in its own browser tab, and
 * the game keeps running in another: game tabs (the DM's host console, a player's table) announce
 * themselves on a same-origin BroadcastChannel with the tokens their user may re-skin, and apply a
 * finished token on request, through the game's own path (DM: a scene edit; player: a `token-image`
 * request the host authorises). Nothing here grants anything: the host still checks every request.
 *
 * Game tabs re-announce every HEARTBEAT_MS and say "gone" when they close; the Token Maker forgets tabs
 * it has not heard from for STALE_MS (a crashed tab says nothing).
 */
import { z } from "zod"

export const TOKEN_MAKER_CHANNEL = "atlas-vtt:token-maker:v1"
export const HEARTBEAT_MS = 10_000
export const STALE_MS = 25_000
export const APPLY_TIMEOUT_MS = 15_000

export interface LinkedToken {
  id: string
  name: string
  color: string
  imageUrl: string | null
}

export interface LinkedGame {
  /** This browser tab (random per page load). */
  tabId: string
  sessionId: string
  role: "dm" | "player"
  /** Scene name. */
  title: string
  userId: string
  /** The tab can apply tokens right now (hosting / live). */
  ready: boolean
  /** Tokens the user may put an image on (DM: all; player: their own). */
  tokens: LinkedToken[]
}

export type LinkMessage =
  | { t: "discover" }
  | { t: "game"; game: LinkedGame }
  | { t: "gone"; tabId: string }
  | { t: "apply"; reqId: string; tabId: string; tokenId: string; imageUrl: string }
  | { t: "applied"; reqId: string; ok: boolean; error: string | null }

export interface ApplyResult {
  ok: boolean
  error: string | null
}

/** The subset of BroadcastChannel the link uses (injectable for tests). */
export interface ChannelLike {
  postMessage(message: unknown): void
  addEventListener(type: "message", listener: (ev: MessageEvent) => void): void
  removeEventListener(type: "message", listener: (ev: MessageEvent) => void): void
  close(): void
}

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const tokenSchema = z.strictObject({
  id,
  name: z.string().max(200),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  imageUrl: z.string().max(2000).nullable(),
})
const gameSchema = z.strictObject({
  tabId: id,
  sessionId: z.string().min(1).max(64),
  role: z.enum(["dm", "player"]),
  title: z.string().max(200),
  userId: z.string().min(1).max(64),
  ready: z.boolean(),
  tokens: z.array(tokenSchema).max(1000),
})
const messageSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("discover") }),
  z.strictObject({ t: z.literal("game"), game: gameSchema }),
  z.strictObject({ t: z.literal("gone"), tabId: id }),
  z.strictObject({ t: z.literal("apply"), reqId: id, tabId: id, tokenId: id, imageUrl: z.string().min(1).max(2000) }),
  z.strictObject({ t: z.literal("applied"), reqId: id, ok: z.boolean(), error: z.string().max(500).nullable() }),
])

/** A link message, or null for anything else (other versions, garbage). */
export function parseLinkMessage(raw: unknown): LinkMessage | null {
  try {
    const r = messageSchema.safeParse(raw)
    return r.success ? (r.data as LinkMessage) : null
  } catch {
    return null
  }
}

function openChannel(): ChannelLike | null {
  try {
    return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(TOKEN_MAKER_CHANNEL)
  } catch {
    return null
  }
}

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 24)

interface Timers {
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  now(): number
}

const defaultTimers: Timers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
}

// ---------------------------------------------------------------------------
// Game side
// ---------------------------------------------------------------------------

export type GameInfo = Omit<LinkedGame, "tabId">

/** A game tab's end of the link: announces the game, applies tokens it is asked to. */
export class GameLink {
  readonly tabId = newId()
  private game: GameInfo | null = null
  private readonly apply: (tokenId: string, imageUrl: string) => Promise<ApplyResult>
  private readonly channel: ChannelLike | null
  private readonly timers: Timers
  private readonly heartbeat: unknown
  private readonly onMessage = (ev: MessageEvent) => this.handle(parseLinkMessage(ev.data))

  constructor(apply: (tokenId: string, imageUrl: string) => Promise<ApplyResult>, opts: { channel?: ChannelLike | null; timers?: Timers } = {}) {
    this.apply = apply
    this.channel = opts.channel === undefined ? openChannel() : opts.channel
    this.timers = opts.timers ?? defaultTimers
    this.channel?.addEventListener("message", this.onMessage)
    this.heartbeat = this.timers.setInterval(() => this.announce(), HEARTBEAT_MS)
  }

  /** Publish (or update) what this tab offers; null withdraws it. */
  update(game: GameInfo | null): void {
    const was = this.game
    this.game = game
    if (game) this.announce()
    else if (was) this.post({ t: "gone", tabId: this.tabId })
  }

  dispose(): void {
    this.timers.clearInterval(this.heartbeat)
    if (this.game) this.post({ t: "gone", tabId: this.tabId })
    this.game = null
    this.channel?.removeEventListener("message", this.onMessage)
    this.channel?.close()
  }

  private announce(): void {
    if (this.game) this.post({ t: "game", game: { ...this.game, tabId: this.tabId } })
  }

  private post(msg: LinkMessage): void {
    try {
      this.channel?.postMessage(msg)
    } catch {
      // Closed channel: nothing to tell.
    }
  }

  private handle(msg: LinkMessage | null): void {
    if (!msg) return
    if (msg.t === "discover") this.announce()
    else if (msg.t === "apply" && msg.tabId === this.tabId) {
      const reqId = msg.reqId
      const fail = (error: string) => this.post({ t: "applied", reqId, ok: false, error })
      if (!this.game?.ready) return fail("The game isn't connected right now.")
      if (!this.game.tokens.some((t) => t.id === msg.tokenId)) return fail("That token isn't yours to change.")
      this.apply(msg.tokenId, msg.imageUrl).then(
        (r) => this.post({ t: "applied", reqId, ok: r.ok, error: r.ok ? null : (r.error ?? "The game refused the image.") }),
        (err: unknown) => fail(err instanceof Error ? err.message : "The game refused the image.")
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Token Maker side
// ---------------------------------------------------------------------------

/** The Token Maker's end of the link: which games are open, and applying tokens through them. */
export class MakerLink {
  private readonly games = new Map<string, { game: LinkedGame; seenAt: number }>()
  private readonly waiting = new Map<string, { resolve: (r: ApplyResult) => void; timer: unknown }>()
  private readonly listeners = new Set<() => void>()
  private readonly channel: ChannelLike | null
  private readonly timers: Timers
  private readonly sweep: unknown
  private list: LinkedGame[] = []
  private readonly onMessage = (ev: MessageEvent) => this.handle(parseLinkMessage(ev.data))

  constructor(opts: { channel?: ChannelLike | null; timers?: Timers } = {}) {
    this.channel = opts.channel === undefined ? openChannel() : opts.channel
    this.timers = opts.timers ?? defaultTimers
    this.channel?.addEventListener("message", this.onMessage)
    this.sweep = this.timers.setInterval(() => this.dropStale(), HEARTBEAT_MS / 2)
    this.post({ t: "discover" })
  }

  /** False when this browser has no BroadcastChannel (no game can be reached). */
  get supported(): boolean {
    return this.channel !== null
  }

  /** Open games, newest announcement first (stable identity until something changes). */
  getGames = (): LinkedGame[] => this.list

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Put `imageUrl` on a token through the game tab `tabId`. */
  apply(tabId: string, tokenId: string, imageUrl: string, timeoutMs = APPLY_TIMEOUT_MS): Promise<ApplyResult> {
    if (!this.games.has(tabId)) return Promise.resolve({ ok: false, error: "That game tab is closed." })
    const reqId = newId()
    return new Promise<ApplyResult>((resolve) => {
      const timer = this.timers.setTimeout(() => {
        this.waiting.delete(reqId)
        resolve({ ok: false, error: "The game tab didn't answer." })
      }, timeoutMs)
      this.waiting.set(reqId, { resolve, timer })
      this.post({ t: "apply", reqId, tabId, tokenId, imageUrl })
    })
  }

  dispose(): void {
    this.timers.clearInterval(this.sweep)
    for (const [, w] of this.waiting) {
      this.timers.clearTimeout(w.timer)
      w.resolve({ ok: false, error: "Closed." })
    }
    this.waiting.clear()
    this.channel?.removeEventListener("message", this.onMessage)
    this.channel?.close()
    this.listeners.clear()
  }

  private post(msg: LinkMessage): void {
    try {
      this.channel?.postMessage(msg)
    } catch {
      // Closed channel.
    }
  }

  private changed(): void {
    this.list = [...this.games.values()].sort((a, b) => b.seenAt - a.seenAt).map((e) => e.game)
    for (const l of this.listeners) l()
  }

  private dropStale(): void {
    const cutoff = this.timers.now() - STALE_MS
    let dropped = false
    for (const [tabId, e] of this.games) {
      if (e.seenAt < cutoff) {
        this.games.delete(tabId)
        dropped = true
      }
    }
    if (dropped) this.changed()
  }

  private handle(msg: LinkMessage | null): void {
    if (!msg) return
    if (msg.t === "game") {
      const prev = this.games.get(msg.game.tabId)
      this.games.set(msg.game.tabId, { game: msg.game, seenAt: this.timers.now() })
      // Heartbeats that change nothing do not re-render.
      if (!prev || JSON.stringify(prev.game) !== JSON.stringify(msg.game)) this.changed()
    } else if (msg.t === "gone") {
      if (this.games.delete(msg.tabId)) this.changed()
    } else if (msg.t === "applied") {
      const w = this.waiting.get(msg.reqId)
      if (!w) return
      this.waiting.delete(msg.reqId)
      this.timers.clearTimeout(w.timer)
      w.resolve({ ok: msg.ok, error: msg.error })
    }
  }
}
