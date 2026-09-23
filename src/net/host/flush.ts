/**
 * Per-player sync bookkeeping of the host (ARCHITECTURE §6.3): the recent-patch log used for hello
 * catch-ups, the request rate limiter (≤ 8 req/s, burst 16) and the wire epoch format.
 *
 * Pure logic (no timers, no I/O) so it is unit-tested directly; hostRunner.ts drives it.
 */
import type { PatchOp } from "@/core/session/types"

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
  /** player_views upsert throttle per player. */
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
