/**
 * DEV / TEST ONLY — a small, protocol-faithful stand-in for the real host runner (net/host), used by the
 * player-client tests and browser checks. It drives core/session's TestHost pipeline (reduce → vision →
 * knowledge → filter → diff) and speaks the §6.3 wire protocol on real Transport channels:
 * snapshot on link ready, hello → sync / catch-up patch / snapshot (or snapshot_ready via the repo),
 * move/door → patch with results (or a standalone result).
 *
 * It is NOT the production host: no vision worker, no flush scheduling, no persistence throttling.
 */
import { applyPatchOps, diffViews } from "@/core/session/diff"
import { parseClientMessage } from "@/core/session/protocol"
import type { TestHost } from "@/core/session/test-utils"
import type { ClientToHost, HostToClient, PatchOp, PlayerBackdrop, PlayerView, RequestResult } from "@/core/session/types"

import type { SessionsRepo } from "../sessionsRepo"
import type { HostChannels, SendResult, Transport, Unsubscribe } from "../transport"

export interface FakeHostOptions {
  transport: Transport
  sessionId: string
  /** The simulated game (core/session TestHost). Player ids in it are the real user ids. */
  sim: TestHost
  /** Wire epoch (default random). */
  epoch?: string
  /** DM user id for presence. */
  dmUserId?: string
  /** When set, snapshots go through the database: upsert the row, then snapshot_ready. */
  persist?: { repo: SessionsRepo; hostEpoch: number; always?: boolean }
  /** Tile size announced in PlayerView.backdrops for levels with a backdrop (default 140). */
  tilePx?: number
  /** Push a snapshot whenever a player's link becomes ready (default true, like the real host). */
  snapshotOnReady?: boolean
}

interface LogEntry {
  baseSeq: number
  seq: number
  ops: PatchOp[]
}

export class FakeHost {
  readonly epoch: string
  readonly received: Array<{ userId: string; msg: ClientToHost }> = []
  readonly sent: Array<{ userId: string; msg: HostToClient }> = []
  /** When false, requests and hellos are recorded but not answered (tests script the replies). */
  autoReply = true
  private channels: HostChannels | null = null
  private readonly opts: FakeHostOptions
  private readonly seq = new Map<string, number>()
  private readonly lastSent = new Map<string, PlayerView>()
  private readonly log = new Map<string, LogEntry[]>()
  private readonly offs: Unsubscribe[] = []

  constructor(opts: FakeHostOptions) {
    this.opts = opts
    this.epoch = opts.epoch ?? `ep-${crypto.randomUUID().slice(0, 8)}`
  }

  get hostChannels(): HostChannels | null {
    return this.channels
  }

  /** Open the host channels and one link per player of the sim. */
  start(players: string[] = Object.keys(this.opts.sim.state.players)): void {
    if (this.channels) return
    const ch = this.opts.transport.openHostChannels(this.opts.sessionId, this.epoch, { userId: this.opts.dmUserId })
    this.channels = ch
    for (const uid of players) {
      const link = ch.openPlayer(uid)
      this.offs.push(
        link.onRequest((raw) => void this.onRequest(uid, raw)),
        link.onReady(() => {
          if (this.opts.snapshotOnReady !== false && this.autoReply) void this.pushSnapshot(uid)
        })
      )
    }
  }

  async stop(): Promise<void> {
    for (const off of this.offs.splice(0)) off()
    const ch = this.channels
    this.channels = null
    await ch?.close()
  }

  currentSeq(userId: string): number {
    return this.seq.get(userId) ?? 0
  }

  lastView(userId: string): PlayerView | null {
    return this.lastSent.get(userId) ?? null
  }

  /** Send any message on the player's view topic (scripted tests). */
  async send(userId: string, msg: HostToClient): Promise<SendResult> {
    const link = this.channels?.player(userId)
    if (!link) return { ok: false, reason: "closed" }
    this.sent.push({ userId, msg })
    return link.send(msg)
  }

  async broadcast(msg: Parameters<HostChannels["host"]["broadcast"]>[0]): Promise<SendResult> {
    if (!this.channels) return { ok: false, reason: "closed" }
    return this.channels.host.broadcast(msg)
  }

  /** The player's current filtered view (recomputed), with backdrop placement added. */
  computeView(userId: string): PlayerView {
    const view = this.opts.sim.refresh(userId).view
    return this.withBackdrops(view)
  }

  private withBackdrops(view: PlayerView): PlayerView {
    if (view.backdrops) return view
    const backdrops: Record<string, PlayerBackdrop> = {}
    for (const [levelId, level] of Object.entries(this.opts.sim.state.scene.levels)) {
      const b = level.backdrop
      if (!b || !view.scene.levels[levelId]?.known) continue
      backdrops[levelId] = { rect: { ...b.rect }, opacity: b.opacity, tintWalls: b.tintWalls, tilePx: this.opts.tilePx ?? 140 }
    }
    return Object.keys(backdrops).length ? { ...view, backdrops } : view
  }

  /** Full snapshot (wire, or row + snapshot_ready when persisting). */
  async pushSnapshot(userId: string, nonce?: string, results?: RequestResult[]): Promise<void> {
    const view = this.computeView(userId)
    const prev = this.lastSent.get(userId)
    let seq = this.currentSeq(userId)
    if (prev && diffViews(prev, view).length > 0) seq++
    this.seq.set(userId, seq)
    this.lastSent.set(userId, view)
    this.log.set(userId, [])
    const persist = this.opts.persist
    if (persist) {
      await persist.repo.upsertPlayerView({ sessionId: this.opts.sessionId, userId, hostEpoch: persist.hostEpoch, epoch: this.epoch, seq, view })
      if (persist.always) {
        await this.send(userId, nonce ? { t: "snapshot_ready", epoch: this.epoch, seq, nonce } : { t: "snapshot_ready", epoch: this.epoch, seq })
        if (results?.length) for (const r of results) await this.send(userId, { t: "result", epoch: this.epoch, seq, result: r })
        return
      }
    }
    const msg: HostToClient = { t: "snapshot", epoch: this.epoch, seq, view }
    if (nonce) msg.nonce = nonce
    if (results?.length) msg.results = results
    const res = await this.send(userId, msg)
    if (!res.ok && res.reason === "too-large" && persist) {
      await this.send(userId, nonce ? { t: "snapshot_ready", epoch: this.epoch, seq, nonce } : { t: "snapshot_ready", epoch: this.epoch, seq })
    }
  }

  /** Recompute and send the diff (with results); a standalone result when nothing changed. */
  async flush(userId: string, results: RequestResult[] = []): Promise<PatchOp[]> {
    const prev = this.lastSent.get(userId)
    if (!prev) {
      await this.pushSnapshot(userId, undefined, results)
      return []
    }
    const view = this.computeView(userId)
    const ops = diffViews(prev, view)
    const baseSeq = this.currentSeq(userId)
    if (ops.length === 0) {
      for (const result of results) await this.send(userId, { t: "result", epoch: this.epoch, seq: baseSeq, result })
      return ops
    }
    const seq = baseSeq + 1
    this.seq.set(userId, seq)
    this.lastSent.set(userId, applyPatchOps(prev, ops))
    const entries = this.log.get(userId) ?? []
    entries.push({ baseSeq, seq, ops })
    this.log.set(userId, entries.slice(-50))
    const msg: HostToClient = { t: "patch", epoch: this.epoch, baseSeq, seq, ops }
    if (results.length) msg.results = results
    await this.send(userId, msg)
    return ops
  }

  private async onRequest(userId: string, raw: unknown): Promise<void> {
    const msg = parseClientMessage(raw)
    if (!msg) return
    this.received.push({ userId, msg })
    if (!this.autoReply) return
    if (msg.t === "hello") {
      await this.answerHello(userId, msg)
      return
    }
    // Pings are never answered (tests read them from `received`).
    if (msg.t === "ping") return
    const outcome = this.opts.sim.request(userId, msg)
    await this.flush(userId, [outcome.result])
  }

  async answerHello(userId: string, msg: Extract<ClientToHost, { t: "hello" }>): Promise<void> {
    const seq = this.currentSeq(userId)
    const have = this.lastSent.has(userId)
    if (have && msg.epoch === this.epoch && msg.lastSeq === seq) {
      await this.send(userId, { t: "sync", epoch: this.epoch, seq })
      return
    }
    if (have && msg.epoch === this.epoch && msg.lastSeq !== null && msg.lastSeq < seq) {
      const entries = (this.log.get(userId) ?? []).filter((e) => e.baseSeq >= (msg.lastSeq as number))
      if (entries.length && entries[0].baseSeq === msg.lastSeq) {
        await this.send(userId, { t: "patch", epoch: this.epoch, baseSeq: msg.lastSeq, seq, ops: entries.flatMap((e) => e.ops), nonce: msg.nonce })
        return
      }
    }
    await this.pushSnapshot(userId, msg.nonce)
  }
}
