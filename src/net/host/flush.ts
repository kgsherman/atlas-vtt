/**
 * Per-player sync bookkeeping of the host (ARCHITECTURE §6.3): the recent-patch log used for hello
 * catch-ups, the recent-result log (results re-delivered with catch-ups), the request rate limiters
 * (≤ 8 req/s, burst 16; hellos ≤ 1/s, burst 4) and the wire epoch format.
 *
 * Pure logic (no timers, no I/O) so it is unit-tested directly; hostRunner.ts drives it.
 */
import type { PatchOp, PlayerView, RequestResult } from "@/core/session/types"

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const HOST_TIMING = {
  /** Minimum interval between two flushes of one player (≤ 10 patches/s). */
  flushIntervalMs: 100,
  /** A player that received nothing for this long gets a `sync` (detects a lost final patch). */
  idleSyncMs: 10_000,
  /** session_state save throttle. */
  saveIntervalMs: 5_000,
  /** Minimum gap between two "urgent" saves (after visibility-reducing DM commands). */
  urgentSaveGapMs: 500,
  /** Save gap after token moves and exploration: what a reload of the host tab may lose. */
  moveSaveGapMs: 1_000,
  /**
   * player_views upsert throttle per player for ordinary changes (other tokens moving, doors, lights).
   * Changes a reload while the DM is away must not lose — the player's own tokens assigned or moved,
   * exploration — are stored after `moveSaveGapMs` instead (see viewSaveUrgency).
   */
  viewSaveIntervalMs: 5_000,
  /** session_members re-read period. */
  memberPollMs: 10_000,
  /** Debounce of member re-reads triggered by lobby presence changes. */
  lobbyDebounceMs: 400,
  /** A move whose result was never delivered stops blocking its token after this long. */
  inFlightMoveTimeoutMs: 10_000,
  /**
   * How long a view waits for the backdrop chunks of the cells it reveals (Supabase): usually enough
   * for a move's few chunks, so the art arrives with the fog; a big first reveal is sent without them.
   */
  tileWaitMs: 250,
} as const

export const REQUEST_RATE = { ratePerSecond: 8, burst: 16 } as const

/**
 * Hellos per player (a separate budget: each one may cost a full snapshot plus a tile table per
 * backdrop level). Honest clients coalesce hellos and retry with backoff (2.5 s → 15 s).
 */
export const HELLO_RATE = { ratePerSecond: 1, burst: 4 } as const

/** "rate-limited" replies per player; over-budget requests beyond this are dropped silently. */
export const REJECT_REPLY_RATE = { ratePerSecond: 2, burst: 4 } as const

/** Results remembered per player for re-delivery with hello catch-ups. */
export const RESULT_LOG_SIZE = 32

/** Pending request results kept per player (beyond this, results of a flooding client are dropped). */
export const MAX_PENDING_RESULTS = 32

// ---------------------------------------------------------------------------
// Op log
// ---------------------------------------------------------------------------

export interface LogEntry {
  baseSeq: number
  seq: number
  ops: PatchOp[]
  /** Serialised size of the ops (JSON bytes). */
  bytes: number
  at: number
}

export interface OpLogOptions {
  /** Total size cap (the whole catch-up must fit one broadcast). Default 200 KB. */
  maxBytes?: number
  /** Entries younger than this are kept unless the size cap forces them out. Default 90 s. */
  minAgeMs?: number
  /** Entries older than this are dropped even under the size cap. Default 10 min. */
  maxAgeMs?: number
}

/**
 * Recent patches of one player (≥ 90 s of history while it fits in 200 KB). A client that missed
 * patches sends hello{lastSeq}; `since(lastSeq)` returns the ops of every later patch, in order, when
 * the log still covers them without a gap.
 */
export class OpLog {
  private entries: LogEntry[] = []
  private total = 0
  private readonly maxBytes: number
  private readonly maxAgeMs: number

  constructor(opts: OpLogOptions = {}) {
    this.maxBytes = opts.maxBytes ?? 200 * 1024
    this.maxAgeMs = Math.max(opts.maxAgeMs ?? 10 * 60_000, opts.minAgeMs ?? 90_000)
  }

  get size(): number {
    return this.entries.length
  }

  get bytes(): number {
    return this.total
  }

  /** Append a patch. Entries must chain (baseSeq = previous seq); a gap clears the log first. */
  push(entry: LogEntry): void {
    const last = this.entries[this.entries.length - 1]
    if (last && last.seq !== entry.baseSeq) this.clear()
    this.entries.push(entry)
    this.total += entry.bytes
    this.trim(entry.at)
  }

  clear(): void {
    this.entries = []
    this.total = 0
  }

  /** Drop old entries: over the size cap, or older than maxAge. */
  trim(now: number): void {
    let k = 0
    while (k < this.entries.length && (this.total > this.maxBytes || now - this.entries[k].at > this.maxAgeMs)) {
      this.total -= this.entries[k].bytes
      k++
    }
    if (k > 0) this.entries = this.entries.slice(k)
  }

  /** Ops taking a client at `fromSeq` to `toSeq`, or null when the log does not cover that range. */
  since(fromSeq: number, toSeq: number): PatchOp[] | null {
    if (fromSeq === toSeq) return []
    if (fromSeq > toSeq) return null
    const start = this.entries.findIndex((e) => e.baseSeq === fromSeq)
    if (start < 0) return null
    const ops: PatchOp[] = []
    let seq = fromSeq
    for (let k = start; k < this.entries.length && seq < toSeq; k++) {
      const e = this.entries[k]
      if (e.baseSeq !== seq) return null
      for (const op of e.ops) ops.push(op)
      seq = e.seq
    }
    return seq === toSeq ? ops : null
  }
}

// ---------------------------------------------------------------------------
// Result log
// ---------------------------------------------------------------------------

/**
 * The last RESULT_LOG_SIZE results sent to one player, with the view seq they went out at. A patch
 * carrying a move's result can be lost on the wire; the catch-up answering the client's hello then
 * carries the results sent after the client's seq (the client ignores reqIds it has settled already).
 */
export class ResultLog {
  private entries: Array<{ seq: number; result: RequestResult }> = []
  private readonly max: number

  constructor(max = RESULT_LOG_SIZE) {
    this.max = max
  }

  push(seq: number, results: readonly RequestResult[]): void {
    for (const result of results) this.entries.push({ seq, result })
    if (this.entries.length > this.max) this.entries = this.entries.slice(this.entries.length - this.max)
  }

  /** Results sent at a seq after `seq` (every remembered one for null: a client of another run). */
  since(seq: number | null): RequestResult[] {
    return this.entries.filter((e) => seq === null || e.seq > seq).map((e) => e.result)
  }

  get size(): number {
    return this.entries.length
  }
}

/**
 * How soon a player's stored view (player_views) must follow a new view: "soon" when the player's own
 * situation changed — which tokens they control or see through (e.g. the first assignment after
 * joining), where their tokens stand, what they explored — since a reload while the DM is away shows
 * that row; false (the normal throttle) otherwise.
 */
export function viewSaveUrgency(prev: PlayerView | null, next: PlayerView): "soon" | false {
  if (!prev) return next.controlledTokenIds.length > 0 ? "soon" : false
  const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, k) => x === b[k])
  if (!sameList(prev.controlledTokenIds, next.controlledTokenIds) || !sameList(prev.visionTokenIds, next.visionTokenIds)) return "soon"
  for (const id of next.controlledTokenIds) {
    const a = Object.hasOwn(prev.tokens, id) ? prev.tokens[id] : undefined
    const b = Object.hasOwn(next.tokens, id) ? next.tokens[id] : undefined
    if (!a || !b) {
      if (a !== b) return "soon"
      continue
    }
    if (a.levelId !== b.levelId || a.position.x !== b.position.x || a.position.z !== b.position.z) return "soon"
  }
  const levels = new Set([...Object.keys(prev.masks), ...Object.keys(next.masks)])
  for (const l of levels) {
    const a = Object.hasOwn(prev.masks, l) ? prev.masks[l].explored : undefined
    const b = Object.hasOwn(next.masks, l) ? next.masks[l].explored : undefined
    if (a === b) continue
    if (!a || !b || a.width !== b.width || a.depth !== b.depth || a.b64 !== b.b64 || (a.partial ?? "") !== (b.partial ?? "")) return "soon"
  }
  return false
}

// ---------------------------------------------------------------------------
// Request rate limiting
// ---------------------------------------------------------------------------

/** Non-queueing token bucket: `tryTake()` is false when the player is over ≈ 8 req/s (burst 16). */
export class RequestLimiter {
  private tokens: number
  private last: number
  private readonly rate: number
  private readonly burst: number
  private readonly now: () => number

  constructor(opts: { ratePerSecond: number; burst: number }, now: () => number) {
    this.rate = opts.ratePerSecond / 1000
    this.burst = opts.burst
    this.now = now
    this.tokens = opts.burst
    this.last = now()
  }

  tryTake(): boolean {
    const t = this.now()
    this.tokens = Math.min(this.burst, this.tokens + Math.max(0, t - this.last) * this.rate)
    this.last = t
    if (this.tokens < 1) return false
    this.tokens -= 1
    return true
  }
}

// ---------------------------------------------------------------------------
// Wire epoch
// ---------------------------------------------------------------------------

/**
 * The wire epoch of one host run: `${hostEpoch}.${uuid}`. Random per start (clients compare it for
 * equality only), and it carries the database fencing epoch so a host that sees another host's
 * status/presence can tell which of them is newer.
 */
export function makeWireEpoch(hostEpoch: number, uuid: string = crypto.randomUUID()): string {
  return `${hostEpoch}.${uuid}`
}

/** The fencing epoch encoded in a wire epoch, or null for a foreign/garbled value. */
export function hostEpochOfWire(wire: unknown): number | null {
  if (typeof wire !== "string") return null
  const m = /^(\d{1,15})\.[0-9A-Za-z-]{1,64}$/.exec(wire)
  return m ? Number(m[1]) : null
}
