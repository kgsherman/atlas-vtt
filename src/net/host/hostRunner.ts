/**
 * The DM-side authoritative host (ARCHITECTURE §6.1–§6.3, §9). One HostRunner per hosted session:
 *
 *   start: navigator.locks `atlas-host:{sid}` (ifAvailable; taken → "standby") → claim_host (fencing
 *   epoch) → random wire epoch → load/seed the GameState → main-thread OcclusionWorld + vision Worker →
 *   host channels (DM presence, status broadcast) → one player link per active member.
 *
 *   request (req:{uid}) → parseClientMessage → rate limit (hellos: own budget, coalesced) →
 *   reduceRequest(world = main-thread world of the CURRENT scene) → vision update → dirty players →
 *   low-priority vision probes for a move's intermediate steps (their exploration follows in a later
 *   patch; the move's result never waits for them, and a probe resolved after anything else changed
 *   the scene or reduced visibility is discarded).
 *   DM command → reduceDm → vision update → dirty players (+ urgent save when it hides things).
 *   Table requests (say, roll, initiative, end-turn) take the same path with their own rate on top
 *   (dice rolled here, never by the player); pings are fanned out at once through filter.ts
 *   pingForPlayer, outside the seq order, and never stored.
 *
 *   flush (per player, ≤ 10 Hz, event-driven): vision compute for the player's viewers (tag-checked:
 *   a result is only ever paired with the scene revision it was computed on) → updateKnowledge →
 *   backdrop tiles published + granted → filterForPlayer → diffViews → patch{epoch, baseSeq, seq}.
 *
 * All per-player sends go through one promise chain per player (flush, hello replies, snapshots), so
 * messages leave in seq order. Every async continuation checks the run generation (`gen`), so nothing
 * from a stopped/superseded run is ever sent.
 *
 * A host-side channel rejoin of a player the host already sent a view to answers with `sync` (plus
 * the tile table), not a full snapshot: a client that missed patches asks for a catch-up. Results
 * whose send failed while the link was down are sent again once it is back, and the last results
 * sent ride along with hello catch-ups (a lost patch no longer means "DM not responding").
 */
import type { Patch } from "immer"

import { cryptoDiceRng, type DiceRng } from "@/core/dice/dice"
import { buildOcclusionWorld, heightmapDiffRect } from "@/core/occlusion"
import type { OcclusionWorld } from "@/core/occlusion/types"
import { newId } from "@/core/scene/factory"
import { parseScene } from "@/core/scene/schema"
import type { Id, Scene, Vec2 } from "@/core/scene/types"
import {
  diffViews,
  filterForPlayer,
  DM_COLOR,
  DM_NAME,
  levelKnown,
  onlyTerrainEdits,
  parseClientMessage,
  perceivedCellLookup,
  pingForPlayer,
  reduceDm,
  reduceRequest,
  sceneWithTokenAt,
  updateKnowledge,
  viewerTokenIds,
  type ClientToHost,
  type DmCommand,
  type GameState,
  type HostBroadcast,
  type HostToClient,
  type PlayerView,
  type ReduceResult,
  type RequestOutcome,
  type RequestResult,
  type SceneDelta,
  type StateRequest,
  type TablePing,
} from "@/core/session"
import { parseGameStateDetailed } from "@/core/session/persist"
import { createGameState, isEmptyDelta, ownsToken } from "@/core/session/state"
import type { VisibilityResult } from "@/core/vision/types"

import type { ChunkEntry } from "../assets/chunks"
import { isNetError, NetError } from "../supabase"
import type { SessionMember } from "../sessionsRepo"
import { encodePayload, MAX_BROADCAST_BYTES, sendFailure, utf8Length, type HostChannels, type HostPlayerLink, type PresenceEntry, type SendResult, type Unsubscribe } from "../transport"
import {
  HELLO_RATE,
  hostEpochOfWire,
  HOST_TIMING,
  makeWireEpoch,
  MAX_PENDING_RESULTS,
  OpLog,
  PING_RATE,
  REJECT_REPLY_RATE,
  REQUEST_RATE,
  RequestLimiter,
  ResultLog,
  TABLE_RATE,
  viewSaveUrgency,
} from "./flush"
import { fencingFailure, ThrottledTask } from "./persistence"
import { BackdropTiler, createCanvasTileCodec, type TileCodec } from "./tiles"
import { createHostTimers, type HostTimers } from "./timers"
import type { HostMember, HostPingEvent, HostRunner, HostRunnerOptions, HostSnapshot, HostStats, HostStatus, VisionClient } from "./types"
import { createDefaultVisionClient, createInThreadVisionClient, type VisionClientExt } from "./visionClient"

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** The subset of the Web Locks API used for the same-browser host lock. */
export interface LockManagerLike {
  request(name: string, options: { ifAvailable?: boolean; steal?: boolean }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>
}

export interface HostRunnerInternalOptions {
  /** Web Locks (default: navigator.locks when available); null disables the same-browser lock. */
  locks?: LockManagerLike | null
  now?: () => number
  /** Backdrop tile codec (default: OffscreenCanvas + createImageBitmap when available, else none). */
  tileCodec?: TileCodec | null
  /** Timing overrides (tests). */
  timing?: Partial<HostTiming>
  /** Timer source (default: a timer worker in browsers — unthrottled in hidden tabs — else global timers). */
  createTimers?: () => HostTimers
  /** Snapshots above this size go through the database (snapshot_ready). Default MAX_BROADCAST_BYTES. */
  maxSnapshotBytes?: number
  /** Save on `visibilitychange → hidden` / `pagehide` (default: when a document exists). */
  watchVisibility?: boolean
  /** Dice for players' rolls (default: crypto, unbiased). */
  diceRng?: DiceRng
  /** Wall clock for table message times (default Date.now; `now` may be a monotonic clock). */
  wallClock?: () => number
  log?: (msg: string, err?: unknown) => void
}

export type CreateHostRunnerOptions = HostRunnerOptions & HostRunnerInternalOptions

export type HostTiming = Record<keyof typeof HOST_TIMING, number>

// ---------------------------------------------------------------------------
// Per-player connection
// ---------------------------------------------------------------------------

class PlayerConn {
  link: HostPlayerLink | null = null
  offs: Unsubscribe[] = []
  /** The view the client holds (as far as the host knows). */
  lastSent: PlayerView | null = null
  seq = 0
  readonly log = new OpLog()
  /** The player's view may have changed since lastSent. */
  dirty = true
  needsSnapshot = true
  /**
   * A send failed because the link was (re)joining after lastSent was delivered: on the rejoin the
   * client gets `sync` + the tile table (it asks for a catch-up if it missed patches), not a snapshot.
   */
  needsResume = false
  chain: Promise<void> = Promise.resolve()
  flushQueued = false
  timer: number | "micro" | null = null
  lastFlushAt = -Infinity
  lastMessageAt = 0
  pendingResults: RequestResult[] = []
  /** Results sent recently, with their seq (re-delivered with hello catch-ups). */
  readonly resultLog = new ResultLog()
  readonly limiter: RequestLimiter
  /** Hellos have their own budget (each may cost a snapshot) … */
  readonly helloLimiter: RequestLimiter
  /** … and so do "rate-limited" replies (beyond it, over-budget requests are dropped silently). */
  readonly rejectLimiter: RequestLimiter
  /** Chat and rolls (on top of `limiter`), and pings (on their own). */
  readonly tableLimiter: RequestLimiter
  readonly pingLimiter: RequestLimiter
  /** The latest hello not handled yet (coalesced: at most one queued per player). */
  pendingHello: Extract<ClientToHost, { t: "hello" }> | null = null
  lastVis: VisibilityResult | null = null
  lastVisTag = -1
  lastVisKey = ""
  viewSaver: ThrottledTask | null = null
  /** (epoch, seq) of the last stored player_views row. */
  savedSeq = -1
  /** Time of the last filterForPlayer (ms), reported with the diff time as HostStats.flushMs. */
  buildMs = 0
  /** Backdrop chunk announcements not sent yet: levelId → reset flag + chunk key → [ci, cj, mask]. */
  pendingTiles = new Map<Id, { reset: boolean; chunks: Map<string, ChunkEntry> }>()
  tileNoticeQueued = false
  closed = false
  readonly userId: string

  constructor(userId: string, now: () => number) {
    this.userId = userId
    this.limiter = new RequestLimiter(REQUEST_RATE, now)
    this.helloLimiter = new RequestLimiter(HELLO_RATE, now)
    this.rejectLimiter = new RequestLimiter(REJECT_REPLY_RATE, now)
    this.tableLimiter = new RequestLimiter(TABLE_RATE, now)
    this.pingLimiter = new RequestLimiter(PING_RATE, now)
  }

  takeResults(): RequestResult[] {
    const out = this.pendingResults
    this.pendingResults = []
    return out
  }
}

const EMPTY_STATS: HostStats = { visionMs: 0, flushMs: 0, messagesSent: 0, bytesSent: 0, pendingSends: 0, lastSaveAt: null }

function emptyVisibility(): VisibilityResult {
  return { perception: {}, sunlit: {}, visibleTokenIds: new Set(), observedObjectIds: new Set(), illuminatingLightIds: new Set() }
}

function jsonBytes(value: unknown): number {
  return utf8Length(JSON.stringify(value))
}

/** DM commands after which the saved state must not lag (it would re-reveal things after a crash). */
function reducesVisibility(cmd: DmCommand): boolean {
  switch (cmd.t) {
    case "apply-scene-patches":
      // DM-only terrain editing data (shapes, painted base) changes nothing players see or know.
      return !onlyTerrainEdits(cmd.patches)
    case "reset-fog":
    case "remove-player":
    case "load-scene":
    case "rebind-player":
      return true
    case "assign-token":
      return !cmd.assigned
    default:
      return false
  }
}

const own = <T>(rec: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(rec, key) ? rec[key] : undefined)

/**
 * Two revisions' levels describe the same world for vision and knowledge: the same record, or the same
 * levels where each one is identical or differs only in its DM-only terrain editing data (terrainEdits;
 * the baked heightmap, which is what vision reads, is the same object). An edit of a shape's name or of
 * the painted base under a shape changes the levels' identity without changing anything a player sees.
 */
export function sameVisionLevels(a: Scene["levels"], b: Scene["levels"]): boolean {
  if (a === b) return true
  const ids = Object.keys(a)
  if (ids.length !== Object.keys(b).length) return false
  for (const id of ids) {
    if (!Object.hasOwn(b, id)) return false
    if (a[id] === b[id]) continue
    const la = a[id] as unknown as Readonly<Record<string, unknown>>
    const lb = b[id] as unknown as Readonly<Record<string, unknown>>
    for (const k of new Set([...Object.keys(la), ...Object.keys(lb)])) if (k !== "terrainEdits" && la[k] !== lb[k]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export class HostRunnerImpl implements HostRunner {
  private readonly o: CreateHostRunnerOptions
  private readonly t: HostTiming
  private readonly now: () => number
  private readonly log: (msg: string, err?: unknown) => void
  private readonly maxSnapshotBytes: number

  private status: HostStatus = "starting"
  private error: string | null = null
  private gen = 0
  private starting: Promise<void> | null = null

  private hostEpoch: number | null = null
  private wireEpoch: string | null = null
  private roomCode = ""
  private state: GameState | null = null
  /** Scene row id from the seed (asset lookups may key by it). */
  private sceneRowId: string | null = null

  private channels: HostChannels | null = null
  private channelOffs: Unsubscribe[] = []
  private vision: VisionClient | null = null
  private visionOff: (() => void) | null = null
  private world: OcclusionWorld | null = null
  /** Levels each occlusion world was last brought up to date with (terrain updates rebuild only what changed). */
  private readonly worldLevels = new WeakMap<OcclusionWorld, Scene["levels"]>()
  /** Tag of the last revision posted to the vision client, and of the revision = state.scene. */
  private visionTag = 0
  private sceneTag = 0
  /**
   * Bumped by every change after which a move's pending step probes no longer describe what the token
   * could see then (objects, terrain or structure changed; visibility-reducing DM commands): their
   * results are discarded instead of adding exploration.
   */
  private knowledgeRev = 0
  /** Editor edits applied so far (tells a library save whether the map changed while it ran). */
  private sceneEdits = 0

  private readonly conns = new Map<string, PlayerConn>()
  private members: SessionMember[] = []
  private readonly inFlightMoves = new Map<Id, { uid: string; reqId: string; at: number }>()
  private tiler: BackdropTiler | null = null
  private stateSaver: ThrottledTask | null = null
  private memberRefresh: Promise<void> | null = null
  private memberRefreshAgain = false

  private lockRelease: (() => void) | null = null
  /** Timer source of the current run (worker-driven in browsers). */
  private clock: HostTimers | null = null
  private intervals: number[] = []
  private lobbyTimer: number | null = null
  private visibilityOff: (() => void) | null = null

  private readonly stats: HostStats = { ...EMPTY_STATS }
  private readonly listeners = new Set<() => void>()
  private readonly pingListeners = new Set<(ev: HostPingEvent) => void>()
  private readonly diceRng: DiceRng
  private readonly wallClock: () => number
  private snap: HostSnapshot | null = null
  private notifyQueued = false
  private statsTimer: ReturnType<typeof setTimeout> | null = null
  /** Last DmCommand rejection (display only). */
  lastCommandError: string | null = null
  /** Visibility results discarded because the scene changed while they were computed (diagnostics). */
  staleResults = 0

  constructor(opts: CreateHostRunnerOptions) {
    this.o = opts
    this.t = { ...HOST_TIMING, ...opts.timing }
    this.now = opts.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now()))
    this.log = opts.log ?? ((msg, err) => (err === undefined ? console.warn(`[atlas host] ${msg}`) : console.warn(`[atlas host] ${msg}`, err)))
    this.maxSnapshotBytes = Math.min(opts.maxSnapshotBytes ?? MAX_BROADCAST_BYTES, MAX_BROADCAST_BYTES)
    this.diceRng = opts.diceRng ?? cryptoDiceRng()
    this.wallClock = opts.wallClock ?? Date.now
  }

  // =========================================================================
  // Snapshot for React
  // =========================================================================

  getSnapshot(): HostSnapshot {
    if (!this.snap) {
      const online = new Set((this.channels?.lobby.presence() ?? []).map((e) => e.key))
      const members: HostMember[] = this.members.map((m) => {
        const conn = this.conns.get(m.userId)
        return {
          userId: m.userId,
          displayName: m.displayName,
          status: m.status,
          online: online.has(m.userId),
          linked: conn?.link?.isReady() ?? false,
          seq: conn?.seq ?? 0,
        }
      })
      this.stats.pendingSends = this.o.transport.pendingSends()
      const origin = this.state?.origin
      this.snap = {
        status: this.status,
        error: this.error,
        sessionId: this.o.sessionId,
        roomCode: this.roomCode,
        epoch: this.wireEpoch,
        state: this.state,
        members,
        stats: { ...this.stats },
        library: origin ? { sceneId: origin.sceneId, version: origin.version, dirty: origin.dirty } : null,
      }
    }
    return this.snap
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    this.snap = null
    if (this.notifyQueued) return
    this.notifyQueued = true
    queueMicrotask(() => {
      this.notifyQueued = false
      for (const l of [...this.listeners]) {
        try {
          l()
        } catch (err) {
          this.log("snapshot listener failed", err)
        }
      }
    })
  }

  /** Stats-only changes reach React at most twice a second. */
  private statsChanged(): void {
    if (this.statsTimer !== null) return
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null
      this.notify()
    }, 500)
  }

  private setStatus(status: HostStatus, error: string | null = null): void {
    this.status = status
    this.error = error
    this.notify()
  }

  private hosting(gen: number): boolean {
    return gen === this.gen && this.status === "hosting"
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  start(): Promise<void> {
    if (this.status === "hosting") return Promise.resolve()
    if (this.status === "ended") return Promise.resolve()
    this.starting ??= this.startRun(false).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async takeOver(): Promise<void> {
    if (this.starting) await this.starting.catch(() => {})
    if (this.status === "hosting" || this.status === "ended") return
    this.starting = this.startRun(true).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async startRun(steal: boolean): Promise<void> {
    await this.teardown()
    const gen = ++this.gen
    this.setStatus("starting")
    const sid = this.o.sessionId
    this.clock = this.o.createTimers ? this.o.createTimers() : createHostTimers()
    const clock = this.clock
    try {
      // 1. One host per browser.
      const lock = await this.acquireLock(steal, gen)
      if (gen !== this.gen) return
      if (lock === "taken") {
        this.setStatus("standby", "This session is already being hosted in another tab.")
        return
      }
      // 2. Session still running? (also gives the room code)
      const info = await this.o.repo.sessionInfo(sid)
      if (gen !== this.gen) return
      if (!info || info.role !== "dm") throw new Error("You are not the DM of this session.")
      if (info.status !== "active") {
        this.releaseLock()
        this.setStatus("ended", null)
        return
      }
      this.roomCode = info.roomCode
      // 3. Fencing epoch + wire epoch.
      const hostEpoch = await this.o.repo.claimHost(sid)
      if (gen !== this.gen) return
      this.hostEpoch = hostEpoch
      this.wireEpoch = makeWireEpoch(hostEpoch)
      // 4. Load the game (or seed it from the scene).
      const loaded = await this.loadState(info.roomCode)
      let state = loaded.state
      const seeded = loaded.seeded
      if (gen !== this.gen) return
      const needsOrigin = state.origin === undefined
      if (!this.sceneRowId && (needsOrigin || Object.values(state.scene.levels).some((l) => l.backdrop))) {
        // Backdrop images may be stored under the scene's library id (only the seed carries it), and
        // games saved before the library link was recorded learn it here.
        try {
          const sceneId = (await this.o.repo.listMySessions()).find((s) => s.id === sid)?.sceneId ?? null
          this.sceneRowId = sceneId
          if (needsOrigin) state = { ...state, origin: sceneId ? { sceneId, version: null, dirty: false } : null }
        } catch (err) {
          this.log("looking up the session's scene failed", err)
        }
        if (gen !== this.gen) return
      }
      this.state = state
      // 5. Simulation: main-thread occlusion world (move validation) + vision client.
      this.world = buildOcclusionWorld(state.scene)
      this.installVision(this.o.createVisionClient ? this.o.createVisionClient() : createDefaultVisionClient(), gen)
      // 6. Persistence + tiles.
      this.stateSaver = new ThrottledTask({
        run: () => this.saveState(gen),
        intervalMs: this.t.saveIntervalMs,
        urgentGapMs: this.t.urgentSaveGapMs,
        soonGapMs: this.t.moveSaveGapMs,
        onError: (err) => this.onPersistError(err, gen, "saving the session"),
        now: this.now,
        timers: clock,
      })
      this.tiler = new BackdropTiler({
        assets: this.o.assets,
        sessionId: sid,
        codec: this.o.tileCodec === undefined ? createCanvasTileCodec() : this.o.tileCodec,
        assetSceneIds: () => [this.state?.scene.id, this.sceneRowId, this.state?.origin?.sceneId].filter((s): s is string => typeof s === "string"),
        onChunks: (uid, levelId, entries, reset) => this.queueTileNotice(uid, levelId, entries, reset, gen),
        now: () => Date.now(),
        timers: { setTimeout: (fn, ms) => clock.setTimeout(fn, ms), clearTimeout: (h) => clock.clearTimeout(h as number) },
        log: this.log,
      })
      this.tiler.setScene(state.scene)
      // 7. Channels.
      this.openChannels(gen)
      this.setStatus("hosting")
      if (seeded) this.stateSaver.request(true)
      // 8. Members (links), then periodic re-reads, idle syncs and page-hide saves.
      await this.refreshMembers(gen)
      if (!this.hosting(gen)) return
      this.intervals.push(clock.setInterval(() => void this.refreshMembers(gen), this.t.memberPollMs))
      this.intervals.push(clock.setInterval(() => this.idleSync(gen), Math.max(250, Math.min(1000, this.t.idleSyncMs / 4))))
      this.watchVisibility(gen)
    } catch (err) {
      if (gen !== this.gen) return
      const fence = fencingFailure(err)
      await this.teardown()
      if (fence === "ended") this.setStatus("ended", null)
      else if (fence === "stale") this.setStatus("standby", "Another tab or device took over hosting this session.")
      else this.setStatus("error", err instanceof Error ? err.message : String(err))
    }
  }

  async stop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => {})
    if (this.status === "hosting") {
      // Best effort: persist the latest state and views before leaving.
      await this.persistAll(3000)
    }
    this.gen++
    await this.teardown()
    if (this.status !== "ended") this.setStatus("standby", null)
  }

  async endSession(): Promise<void> {
    if (this.channels && this.status === "hosting") {
      await this.channels.host.broadcast({ t: "ended" }).catch(() => undefined)
    }
    await this.o.repo.endSession(this.o.sessionId)
    this.gen++
    await this.teardown()
    this.setStatus("ended", null)
    // Players' tile chunks are unreadable once the session ended; delete them (best effort).
    if (this.o.assets.mode === "supabase") void this.o.assets.removeSessionTiles(this.o.sessionId).catch((err) => this.log("removing session tiles failed", err))
  }

  async save(): Promise<void> {
    if (!this.stateSaver || this.status !== "hosting") throw new Error("not hosting")
    await this.stateSaver.flush(true)
  }

  /**
   * Save the live map as a new version of the library scene the session was started from (edits made
   * in "Edit map" during the session are otherwise lost for the next one). Optimistic: fails with
   * NetError("version_conflict") when the library scene got a version since the one the session is
   * based on (unless `force`). Also works right after endSession(), while the state is still here.
   * Returns the new version.
   */
  async saveMapToLibrary(opts: { force?: boolean } = {}): Promise<number> {
    const scenes = this.o.scenes
    if (!scenes) throw new Error("No scene library is available here.")
    const state = this.state
    const origin = state?.origin
    if (!state || !origin?.sceneId) throw new NetError("not_found", "The library scene this session was started from no longer exists.")
    const summary = await scenes.get(origin.sceneId)
    if (!summary) throw new NetError("not_found", "The library scene this session was started from no longer exists.")
    const edits = this.sceneEdits
    const doc = { ...state.scene, updatedAt: new Date().toISOString() }
    const base = opts.force || origin.version === null ? {} : { baseVersion: origin.version }
    // Keep the library entry's own name (it may have been renamed since the session started).
    const version = await scenes.saveVersion(origin.sceneId, doc, { ...base, name: summary.name })
    const cur = this.state
    if (cur) {
      // Edits made while the save was on its way are not in the saved version.
      this.state = { ...cur, origin: { sceneId: origin.sceneId, version, dirty: this.sceneEdits !== edits }, seq: cur.seq + 1 }
      this.notify()
      if (this.stateSaver && this.status === "hosting") {
        try {
          await this.stateSaver.flush(true)
        } catch (err) {
          this.log("saving the session after the library save failed", err)
        }
      }
    }
    return version
  }

  /** Flush the state save and every player's view upsert (bounded wait). */
  private async persistAll(timeoutMs: number): Promise<void> {
    const work = Promise.allSettled([this.stateSaver?.flush() ?? Promise.resolve(), ...[...this.conns.values()].map((c) => c.viewSaver?.flush() ?? Promise.resolve())])
    await Promise.race([work, new Promise((r) => setTimeout(r, timeoutMs))])
  }

  /** Stop hosting after a fencing failure / newer host (keeps the last state for display). */
  private async standDown(message: string, status: HostStatus = "standby"): Promise<void> {
    if (this.status !== "hosting" && this.status !== "starting") return
    this.gen++
    this.status = status
    this.error = message
    // Ended elsewhere (library, another device): tell the players now rather than leaving them to find
    // out through their membership checks.
    if (status === "ended" && this.channels) await this.channels.host.broadcast({ t: "ended" }).catch(() => undefined)
    await this.teardown()
    this.notify()
  }

  private async teardown(): Promise<void> {
    for (const t of this.intervals) this.clock?.clearInterval(t)
    this.intervals = []
    if (this.lobbyTimer !== null) this.clock?.clearTimeout(this.lobbyTimer)
    this.lobbyTimer = null
    this.visibilityOff?.()
    this.visibilityOff = null
    this.stateSaver?.cancel()
    this.stateSaver = null
    for (const conn of this.conns.values()) this.disposeConn(conn)
    this.conns.clear()
    this.inFlightMoves.clear()
    for (const off of this.channelOffs) off()
    this.channelOffs = []
    const channels = this.channels
    this.channels = null
    this.visionOff?.()
    this.visionOff = null
    this.vision?.dispose()
    this.vision = null
    this.world = null
    this.tiler?.dispose()
    this.tiler = null
    this.hostEpoch = null
    this.wireEpoch = null
    this.releaseLock()
    this.clock?.dispose()
    this.clock = null
    if (channels) await channels.close().catch((err) => this.log("closing channels failed", err))
  }

  private disposeConn(conn: PlayerConn): void {
    conn.closed = true
    if (conn.timer !== null && conn.timer !== "micro") this.clock?.clearTimeout(conn.timer)
    conn.timer = null
    conn.viewSaver?.cancel()
    for (const off of conn.offs) off()
    conn.offs = []
  }

  // ---- lock ------------------------------------------------------------------------------

  private async acquireLock(steal: boolean, gen: number): Promise<"held" | "taken" | "none"> {
    const locks = this.o.locks === undefined ? ((globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks ?? null) : this.o.locks
    if (!locks) return "none"
    return new Promise((resolve) => {
      let granted = false
      let release!: () => void
      const held = new Promise<void>((r) => (release = r))
      locks
        .request(`atlas-host:${this.o.sessionId}`, steal ? { steal: true } : { ifAvailable: true }, async (lock) => {
          if (!lock) {
            resolve("taken")
            return
          }
          granted = true
          this.lockRelease = release
          resolve("held")
          await held
        })
        .catch((err: unknown) => {
          if (!granted) {
            this.log("host lock unavailable", err)
            resolve("none")
            return
          }
          // AbortError: another tab of this browser took the lock over.
          if (gen === this.gen) void this.standDown("Hosting moved to another tab of this browser.")
        })
    })
  }

  private releaseLock(): void {
    const release = this.lockRelease
    this.lockRelease = null
    release?.()
  }

  // ---- state -------------------------------------------------------------------------------

  private async loadState(roomCode: string): Promise<{ state: GameState; seeded: boolean }> {
    const sid = this.o.sessionId
    this.sceneRowId = null
    const row = await this.o.repo.loadSessionState(sid)
    if (!row) throw new Error("The session's saved state was not found.")
    const content = row.content
    if (content.kind === "seed") {
      this.sceneRowId = content.sceneId
      const parsed = parseScene(content.scene)
      if (!parsed.ok) throw new Error(`The session's map cannot be loaded (${parsed.error}${parsed.issues[0] ? `: ${parsed.issues[0]}` : ""}).`)
      const origin = content.sceneId ? { sceneId: content.sceneId, version: content.sceneVersion, dirty: false } : null
      return { state: createGameState({ sessionId: sid, roomCode, scene: parsed.scene, origin, freeAssets: content.freeAssets ?? [] }), seeded: true }
    }
    const parsed = parseGameStateDetailed(content.state)
    if (!parsed.ok) throw new Error(`The saved game cannot be loaded (${parsed.issues[0] ?? "invalid"}).`)
    if (parsed.state.sessionId !== sid) throw new Error("The saved game belongs to another session.")
    return { state: { ...parsed.state, roomCode }, seeded: false }
  }

  private async saveState(gen: number): Promise<void> {
    const state = this.state
    const hostEpoch = this.hostEpoch
    if (!state || hostEpoch === null || gen !== this.gen) return
    await this.o.repo.saveSessionState(this.o.sessionId, hostEpoch, state)
    if (gen !== this.gen) return
    this.stats.lastSaveAt = Date.now()
    this.statsChanged()
  }

  private onPersistError(err: unknown, gen: number, what: string): void {
    if (gen !== this.gen) return
    const fence = fencingFailure(err)
    if (fence === "stale") void this.standDown("Another tab or device took over hosting this session.")
    else if (fence === "ended") void this.standDown("The session has ended.", "ended")
    else this.log(`${what} failed (will retry)`, err)
  }

  // ---- vision ----------------------------------------------------------------------------

  private installVision(client: VisionClient, gen: number): void {
    this.visionOff?.()
    this.vision?.dispose()
    this.vision = client
    const ext = client as Partial<VisionClientExt>
    this.visionOff = typeof ext.onFailure === "function" ? ext.onFailure((err) => this.onVisionFailure(err, gen)) : null
    const tag = ++this.visionTag
    this.sceneTag = tag
    if (this.state) void client.setScene(this.state.scene, tag).catch((err) => this.log("vision setScene failed", err))
  }

  /** The worker crashed: continue on the main thread (slower, but the game goes on). */
  private onVisionFailure(err: Error, gen: number): void {
    if (gen !== this.gen || this.status !== "hosting") return
    this.log("vision worker failed; falling back to main-thread vision", err)
    this.installVision(createInThreadVisionClient(), gen)
    this.markDirty("all")
  }

  private async computeVision(viewers: Id[], tag: number): Promise<{ stateSeq: number; result: VisibilityResult } | null> {
    if (viewers.length === 0) return { stateSeq: tag, result: emptyVisibility() }
    const vision = this.vision
    if (!vision) return null
    const t0 = this.now()
    try {
      const r = await vision.compute(viewers, tag)
      const ext = vision as Partial<VisionClientExt>
      this.stats.visionMs = typeof ext.lastComputeMs === "number" ? ext.lastComputeMs : this.now() - t0
      this.statsChanged()
      return r
    } catch (err) {
      if (vision === this.vision) this.log("vision compute failed", err)
      return null
    }
  }

  /**
   * Bring the occlusion world, vision and tiles to the current state.scene. `fromMove`: a player's
   * token move (its attached lights travel with it), which does not invalidate that move's own step
   * probes; any other change of objects, terrain or structure does.
   */
  private applyDelta(delta: SceneDelta, fullRebuild = false, fromMove = false): void {
    const state = this.state
    if (!state || !this.vision) return
    const scene = state.scene
    if (fullRebuild || (!fromMove && (delta.objects.length > 0 || delta.terrain.length > 0 || delta.structure))) this.knowledgeRev++
    if (fullRebuild) {
      const tag = ++this.visionTag
      this.world = buildOcclusionWorld(scene)
      this.worldLevels.set(this.world, scene.levels)
      this.sceneTag = tag
      void this.vision.setScene(scene, tag).catch((err) => this.log("vision setScene failed", err))
      this.tiler?.setScene(scene)
      return
    }
    if (isEmptyDelta(delta)) return
    const tag = ++this.visionTag
    const world = this.world
    if (world) {
      // world.update rebuilds everything by itself when levels/grid changed.
      if (delta.objects.length > 0 || delta.structure) world.update(scene, delta.objects)
      // Terrain edits rebuild what the changed heightmap chunks reach (like the render engine); the whole
      // grid when the world's previous levels are unknown.
      const before = this.worldLevels.get(world)
      const full = { x: 0, z: 0, w: scene.grid.width * scene.grid.cellSize, d: scene.grid.depth * scene.grid.cellSize }
      for (const levelId of delta.terrain) {
        if (!Object.hasOwn(scene.levels, levelId)) continue
        const prev = before && Object.hasOwn(before, levelId) ? before[levelId].heightmap : null
        const rect = before ? heightmapDiffRect(prev, scene.levels[levelId].heightmap, scene.grid) : full
        if (rect) world.updateTerrain(scene, levelId, rect)
      }
      this.worldLevels.set(world, scene.levels)
    }
    this.sceneTag = tag
    void this.vision.update(scene, { objects: delta.objects, tokens: delta.tokens, terrain: delta.terrain, structure: delta.structure }, tag).catch((err) => this.log("vision update failed", err))
    if (delta.structure) this.tiler?.setScene(scene)
  }

  /**
   * explored |= perceived, memory refresh (§5.4) for `vis` computed on `scene`. A result computed on an
   * intermediate revision (a move's step) is applied against THAT revision (never paired with another
   * scene), unless levels/grid changed since (a change of DM-only terrain editing data alone does not
   * count: sameVisionLevels).
   */
  private applyKnowledge(uid: string, vis: VisibilityResult, scene: Scene, markDirty: boolean): void {
    const state = this.state
    if (!state || !Object.hasOwn(state.players, uid)) return
    let next: GameState
    if (scene === state.scene) {
      next = updateKnowledge(state, uid, vis)
    } else {
      if (scene.grid !== state.scene.grid || !sameVisionLevels(scene.levels, state.scene.levels)) return
      const tmp: GameState = { ...state, scene }
      const r = updateKnowledge(tmp, uid, vis)
      if (r === tmp) return
      next = { ...state, explored: r.explored, memory: r.memory, revealed: r.revealed }
    }
    if (next === state) return
    this.state = next
    // Exploration follows moves: saved as soon as they are, or a reloaded host would forget the cells
    // walked past (only the current position is seen again).
    this.stateSaver?.request("soon")
    this.notify()
    if (markDirty) this.markDirty([uid])
  }

  // ---- channels --------------------------------------------------------------------------

  private openChannels(gen: number): void {
    const channels = this.o.transport.openHostChannels(this.o.sessionId, this.wireEpoch!, { userId: this.o.identity.userId })
    this.channels = channels
    this.channelOffs.push(
      channels.host.onStatus((ev) => {
        if (ev.status === "SUBSCRIBED" && this.hosting(gen)) this.broadcastStatus()
        this.notify()
      }),
      channels.host.onBroadcast((msg) => this.onHostBroadcast(msg, gen)),
      channels.host.onPresence((entries) => this.checkOtherHosts(entries, gen)),
      channels.lobby.onPresence(() => {
        this.notify()
        if (!this.hosting(gen)) return
        const clock = this.clock
        if (!clock) return
        if (this.lobbyTimer !== null) clock.clearTimeout(this.lobbyTimer)
        this.lobbyTimer = clock.setTimeout(() => {
          this.lobbyTimer = null
          void this.refreshMembers(gen)
          this.broadcastStatus()
        }, this.t.lobbyDebounceMs)
      })
    )
  }

  private broadcastStatus(): void {
    const channels = this.channels
    if (!channels || !this.state || !this.wireEpoch) return
    void channels.host.broadcast({ t: "status", epoch: this.wireEpoch, sceneName: this.state.scene.name }).catch(() => undefined)
  }

  private onHostBroadcast(msg: HostBroadcast, gen: number): void {
    if (gen !== this.gen) return
    if (msg.t === "status") {
      const other = hostEpochOfWire(msg.epoch)
      if (other !== null && this.hostEpoch !== null && other > this.hostEpoch) void this.standDown("Another tab or device took over hosting this session.")
    } else if (msg.t === "ended") {
      void this.standDown("The session was ended from another tab.", "ended")
    }
  }

  private checkOtherHosts(entries: PresenceEntry[], gen: number): void {
    if (gen !== this.gen || this.hostEpoch === null) return
    for (const e of entries) {
      for (const meta of e.metas) {
        if (meta.role !== "host" || meta.epoch === this.wireEpoch) continue
        const other = hostEpochOfWire(meta.epoch)
        if (other !== null && other > this.hostEpoch) {
          void this.standDown("Another tab or device took over hosting this session.")
          return
        }
      }
    }
  }

  private watchVisibility(gen: number): void {
    const enabled = this.o.watchVisibility ?? typeof document !== "undefined"
    if (!enabled || typeof document === "undefined") return
    const onHide = () => {
      if (!this.hosting(gen)) return
      if (document.visibilityState === "hidden") void this.persistAll(2000)
    }
    const onPageHide = () => {
      if (this.hosting(gen)) void this.persistAll(2000)
    }
    document.addEventListener("visibilitychange", onHide)
    window.addEventListener("pagehide", onPageHide)
    this.visibilityOff = () => {
      document.removeEventListener("visibilitychange", onHide)
      window.removeEventListener("pagehide", onPageHide)
    }
  }

  // ---- members -----------------------------------------------------------------------------

  private refreshMembers(gen: number): Promise<void> {
    if (this.memberRefresh) {
      this.memberRefreshAgain = true
      return this.memberRefresh
    }
    const run = async () => {
      do {
        this.memberRefreshAgain = false
        let list: SessionMember[]
        try {
          list = await this.o.repo.listSessionMembers(this.o.sessionId)
        } catch (err) {
          if (this.hosting(gen)) this.log("reading session members failed", err)
          return
        }
        if (!this.hosting(gen)) return
        this.members = list
        for (const m of list) {
          if (m.status === "active") this.ensureMember(m, gen)
          else await this.expel(m.userId, true)
          if (!this.hosting(gen)) return
        }
        this.notify()
      } while (this.memberRefreshAgain && this.hosting(gen))
    }
    this.memberRefresh = run().finally(() => {
      this.memberRefresh = null
    })
    return this.memberRefresh
  }

  private ensureMember(m: SessionMember, gen: number): void {
    const state = this.state!
    const p = own(state.players, m.userId)
    if (!p || p.displayName !== m.displayName) this.dispatch({ t: "add-player", userId: m.userId, displayName: m.displayName })
    if (!this.conns.has(m.userId)) this.openConn(m.userId, gen)
  }

  private openConn(uid: string, gen: number): void {
    const channels = this.channels
    if (!channels) return
    const conn = new PlayerConn(uid, this.now)
    this.conns.set(uid, conn)
    conn.viewSaver = new ThrottledTask({
      run: () => this.saveView(conn, gen),
      intervalMs: this.t.viewSaveIntervalMs,
      // The player's own tokens / exploration changed: stored as soon as the state is (viewSaveUrgency).
      soonGapMs: this.t.moveSaveGapMs,
      urgentGapMs: this.t.urgentSaveGapMs,
      onError: (err) => this.onPersistError(err, gen, "storing a player view"),
      now: this.now,
      timers: this.clock ?? undefined,
    })
    const link = channels.openPlayer(uid)
    conn.link = link
    conn.offs.push(
      link.onRequest((raw) => this.onRequest(conn, raw, gen)),
      link.onReady(() => this.onLinkReady(conn, gen)),
      link.view.onStatus(() => this.notify()),
      link.req.onStatus(() => this.notify())
    )
    if (link.isReady()) this.onLinkReady(conn, gen)
  }

  /** Close a member's link (optionally telling them they were kicked) and forget them. */
  private async expel(uid: string, kicked: boolean): Promise<void> {
    const conn = this.conns.get(uid)
    if (conn) {
      this.conns.delete(uid)
      this.disposeConn(conn)
      const link = conn.link
      conn.link = null
      if (kicked && link) {
        await link.send({ t: "kicked", reason: "You were removed from this session by the DM." }).catch(() => undefined)
      }
      await this.channels?.closePlayer(uid).catch(() => undefined)
    }
    for (const [tokenId, f] of this.inFlightMoves) if (f.uid === uid) this.inFlightMoves.delete(tokenId)
    this.tiler?.forgetPlayer(uid)
    if (this.state && Object.hasOwn(this.state.players, uid) && kicked) this.dispatch({ t: "remove-player", userId: uid })
  }

  async kick(userId: string): Promise<void> {
    await this.o.repo.setMemberStatus(this.o.sessionId, userId, "kicked")
    this.members = this.members.map((m) => (m.userId === userId ? { ...m, status: "kicked" } : m))
    await this.expel(userId, true)
    this.notify()
  }

  // =========================================================================
  // DM commands
  // =========================================================================

  dispatch(cmd: DmCommand): ReduceResult | null {
    const state = this.state
    if (!state || this.status !== "hosting") {
      this.lastCommandError = "not hosting"
      return null
    }
    const r = reduceDm(state, cmd)
    this.lastCommandError = r.error ?? null
    if (r.error) this.log(`DM command ${cmd.t} not applied: ${r.error}`)
    if (r.state === state) return r
    const prevName = state.scene.name
    this.state = r.state
    // Step probes of earlier moves must not add what the token saw before this change.
    if (reducesVisibility(cmd)) this.knowledgeRev++
    if (cmd.t === "apply-scene-patches") this.sceneEdits++
    if (cmd.t === "load-scene") {
      this.applyDelta(r.delta, true)
      for (const conn of this.conns.values()) conn.lastVis = null
    } else {
      this.applyDelta(r.delta)
    }
    this.markDirty(r.dirtyPlayers)
    this.stateSaver?.request(reducesVisibility(cmd) ? true : cmd.t === "move-token" ? "soon" : false)
    if (this.state.scene.name !== prevName) this.broadcastStatus()
    this.notify()
    return r
  }

  applyScenePatches(patches: Patch[]): void {
    this.dispatch({ t: "apply-scene-patches", patches })
  }

  /**
   * The occlusion world of the live scene (null while not hosting). The DM's UI tests areas of effect
   * against it (core/area); callers must not change it.
   */
  occlusion(): OcclusionWorld | null {
    return this.world
  }

  async previewVisibility(tokenIds: Id[]): Promise<VisibilityResult> {
    const vision = this.vision
    if (!vision) throw new Error("not hosting")
    return (await vision.compute([...tokenIds], this.sceneTag)).result
  }

  // =========================================================================
  // Player requests
  // =========================================================================

  private onRequest(conn: PlayerConn, raw: unknown, gen: number): void {
    if (!this.hosting(gen) || conn.closed) return
    const msg = parseClientMessage(raw)
    if (!msg) return
    if (msg.t === "hello") {
      // Each hello may cost a full snapshot (+ a tile table per backdrop level): its own budget, and at
      // most one queued per player (latest wins). A dropped hello is retried by the client (2.5 s → 15 s).
      if (!conn.helloLimiter.tryTake()) return
      const queued = conn.pendingHello !== null
      conn.pendingHello = msg
      if (!queued) {
        this.enqueue(conn, gen, () => {
          const h = conn.pendingHello
          conn.pendingHello = null
          return h ? this.handleHello(conn, h, gen) : Promise.resolve()
        })
      }
      return
    }
    if (msg.t === "ping") {
      // Never answered: over budget, it is simply dropped.
      if (conn.pingLimiter.tryTake()) this.handlePing(conn, msg)
      return
    }
    // Chat, rolls and templates share the table's own rate on top of the request rate.
    const table = msg.t === "say" || msg.t === "roll" || msg.t === "template"
    if (!conn.limiter.tryTake() || (table && !conn.tableLimiter.tryTake())) {
      // Replies to a flood are rate-limited too; the rest is dropped without a word.
      if (conn.rejectLimiter.tryTake()) this.pushResult(conn, { reqId: msg.reqId, ok: false, reason: "rate-limited" })
      return
    }
    this.handleRequest(conn, msg, gen)
  }

  /** A player's ping: to everyone else who knows its level (filter.ts pingForPlayer), and to the DM. */
  private handlePing(conn: PlayerConn, msg: Extract<ClientToHost, { t: "ping" }>): void {
    const player = this.state && Object.hasOwn(this.state.players, conn.userId) ? this.state.players[conn.userId] : null
    // Only on a level the sender knows (so pings cannot probe for levels).
    if (!player || !levelKnown(conn.lastSent, msg.levelId)) return
    this.firePing({ levelId: msg.levelId, x: msg.x, z: msg.z, name: player.displayName, color: player.color, focus: false }, conn.userId)
  }

  /** Send a ping to every linked player but `except` (best-effort, outside the seq order) and tell the DM's UI. */
  private firePing(ping: TablePing, except: string | null): void {
    const epoch = this.wireEpoch
    if (!epoch || this.status !== "hosting") return
    for (const conn of this.conns.values()) {
      const link = conn.link
      if (conn.closed || conn.userId === except || !link?.isReady()) continue
      const out = pingForPlayer(ping, conn.lastSent)
      if (!out) continue
      // Best-effort and outside the seq order: unlike send(), a ping neither postpones the idle sync
      // (lastMessageAt) nor flags the link for a resume when it fails.
      const msg: HostToClient = { t: "ping", epoch, ping: out }
      void link
        .send(msg)
        .then((res) => {
          if (!res.ok) return
          this.stats.messagesSent++
          this.stats.bytesSent += jsonBytes(msg)
          this.statsChanged()
        })
        .catch(() => undefined)
    }
    const ev: HostPingEvent = { ping, from: except }
    for (const cb of [...this.pingListeners]) {
      try {
        cb(ev)
      } catch (err) {
        this.log("ping listener failed", err)
      }
    }
  }

  ping(levelId: Id, point: Vec2, opts: { focus?: boolean } = {}): void {
    const state = this.state
    if (!state || !Object.hasOwn(state.scene.levels, levelId) || !Number.isFinite(point.x) || !Number.isFinite(point.z)) return
    this.firePing({ levelId, x: point.x, z: point.z, name: DM_NAME, color: DM_COLOR, focus: opts.focus === true }, null)
  }

  onPing(cb: (ev: HostPingEvent) => void): () => void {
    this.pingListeners.add(cb)
    return () => {
      this.pingListeners.delete(cb)
    }
  }

  private handleRequest(conn: PlayerConn, msg: StateRequest, gen: number): void {
    const state = this.state
    const world = this.world
    if (!state || !world || !Object.hasOwn(state.players, conn.userId)) return
    // Only for the token's owners: anyone else gets "not-owner" from reduceRequest, never a hint that
    // someone else's token is moving right now.
    const moves = msg.t === "move" || msg.t === "jump"
    if (moves && ownsToken(state, conn.userId, msg.tokenId)) {
      const busy = this.inFlightMoves.get(msg.tokenId)
      if (busy && this.now() - busy.at < this.t.inFlightMoveTimeoutMs) {
        this.pushResult(conn, { reqId: msg.reqId, ok: false, reason: "rate-limited" })
        return
      }
    }
    const out = reduceRequest(state, conn.userId, msg, {
      world,
      currentView: conn.lastSent,
      perceivedByPlayer: perceivedCellLookup(conn.lastVis),
      table: { now: this.wallClock(), newId, rng: this.diceRng },
      tokenImageBase: this.o.tokenImageBase ?? null,
    })
    if (out.state !== state) {
      this.state = out.state
      const move = moves && out.tokenId ? out.tokenId : null
      // The final revision (and so the flush carrying the result) goes to the vision client first.
      this.applyDelta(out.delta, false, move !== null)
      this.markDirty(out.dirtyPlayers)
      if (move !== null) {
        this.inFlightMoves.set(move, { uid: conn.userId, reqId: msg.reqId, at: this.now() })
        // Then the intermediate steps, as low-priority probes (exploration follows in a later patch).
        if (out.visited.length > 1) this.stepPasses(out, gen)
      }
      // Token moves are saved soon: a reloaded host tab must not put tokens back where they were.
      this.stateSaver?.request(moves ? "soon" : false)
      this.notify()
    }
    this.pushResult(conn, out.result)
  }

  /**
   * ARCHITECTURE §5.2 "Moves": visibility at every intermediate step of an applied path, ORed into the
   * knowledge of every player seeing through the moved token (corridors walked past are explored).
   *
   * One low-priority probe per step for all affected players, posted after the move's final revision:
   * the result and every other player's flush go first, the step exploration arrives in a follow-up
   * patch. A probe resolving after the scene changed in a way that matters (a door opened, fog reset,
   * a map edit…: `knowledgeRev`) is discarded, so a late step can never see through a door opened after
   * the token walked past.
   */
  private stepPasses(out: RequestOutcome, gen: number): void {
    const state = this.state!
    const vision = this.vision!
    const tokenId = out.tokenId!
    const affected = [...this.conns.keys()].filter((uid) => Object.hasOwn(state.players, uid) && viewerTokenIds(state, uid).includes(tokenId))
    if (affected.length === 0) return
    const viewerSets = affected.map((uid) => viewerTokenIds(state, uid))
    const rev = this.knowledgeRev
    for (const step of out.visited.slice(0, -1)) {
      const scene = sceneWithTokenAt(state.scene, tokenId, step)
      vision
        .probe(scene, { tokens: [tokenId], objects: out.delta.objects }, viewerSets)
        .then((r) => {
          if (gen !== this.gen || vision !== this.vision || this.knowledgeRev !== rev) return
          affected.forEach((uid, k) => {
            const vis = r.results[k]
            if (vis) this.applyKnowledge(uid, vis, scene, true)
          })
        })
        .catch((err) => {
          if (gen === this.gen && vision === this.vision) this.log("vision step pass failed", err)
        })
    }
  }

  private pushResult(conn: PlayerConn, result: RequestResult): void {
    if (conn.pendingResults.length < MAX_PENDING_RESULTS) conn.pendingResults.push(result)
    this.scheduleFlush(conn)
  }

  private clearInFlight(results: RequestResult[]): void {
    if (results.length === 0) return
    const done = new Set(results.map((r) => r.reqId))
    for (const [tokenId, f] of this.inFlightMoves) if (done.has(f.reqId)) this.inFlightMoves.delete(tokenId)
  }

  /**
   * After sending `results` at `seq`: delivered → remembered (for catch-ups) and their moves no longer
   * in flight; the link was down → back in the queue, sent once it is up again (not lost).
   */
  private resultsSent(conn: PlayerConn, results: RequestResult[], seq: number, res: SendResult): void {
    if (results.length === 0) return
    if (!res.ok && (res.reason === "not-joined" || res.reason === "closed")) {
      const queued = new Set(conn.pendingResults.map((r) => r.reqId))
      conn.pendingResults = [...results.filter((r) => !queued.has(r.reqId)), ...conn.pendingResults].slice(0, MAX_PENDING_RESULTS)
      return
    }
    conn.resultLog.push(seq, results)
    this.clearInFlight(results)
  }

  /** Standalone `result` messages (no view change), each one requeued if the link is down. */
  private async sendResults(conn: PlayerConn, results: RequestResult[]): Promise<void> {
    const epoch = this.wireEpoch!
    for (const result of results) {
      const res = await this.send(conn, { t: "result", epoch, seq: conn.seq, result })
      this.resultsSent(conn, [result], conn.seq, res)
    }
  }

  // =========================================================================
  // Flush pipeline
  // =========================================================================

  private enqueue(conn: PlayerConn, gen: number, fn: () => Promise<void>): void {
    conn.chain = conn.chain
      .then(() => (gen === this.gen && !conn.closed ? fn() : undefined))
      .catch((err: unknown) => {
        if (gen !== this.gen) return
        const fence = fencingFailure(err)
        if (fence) {
          this.onPersistError(err, gen, "a player update")
          return
        }
        this.log(`updating player ${conn.userId} failed`, err)
        conn.dirty = true
        this.scheduleFlush(conn, this.t.flushIntervalMs * 5)
      })
  }

  private markDirty(which: string[] | "all"): void {
    const uids = which === "all" ? [...this.conns.keys()] : which
    for (const uid of uids) {
      const conn = this.conns.get(uid)
      if (!conn) continue
      conn.dirty = true
      this.scheduleFlush(conn)
    }
  }

  private scheduleFlush(conn: PlayerConn, minDelay = 0): void {
    if (conn.closed || conn.flushQueued || conn.timer !== null) return
    const gen = this.gen
    const delay = Math.max(minDelay, conn.lastFlushAt + this.t.flushIntervalMs - this.now())
    const fire = () => {
      conn.timer = null
      if (conn.closed || gen !== this.gen) return
      conn.flushQueued = true
      this.enqueue(conn, gen, async () => {
        conn.flushQueued = false
        await this.flush(conn, gen)
      })
    }
    // A zero delay must not go through setTimeout (clamped to ≥ 1 s in background tabs).
    const clock = this.clock
    if (delay <= 0 || !clock) {
      conn.timer = "micro"
      queueMicrotask(fire)
    } else {
      conn.timer = clock.setTimeout(fire, delay)
    }
  }

  private async flush(conn: PlayerConn, gen: number): Promise<void> {
    if (!this.hosting(gen) || conn.closed) return
    const link = conn.link
    // Not linked yet: onReady pushes a snapshot, which carries everything.
    if (!link || !link.isReady()) return
    if (conn.needsSnapshot || conn.lastSent === null) {
      await this.pushSnapshot(conn, gen)
      return
    }
    if (conn.needsResume) {
      await this.resumeLink(conn, gen)
      if (!this.hosting(gen) || conn.closed || !conn.link?.isReady()) return
    }
    conn.lastFlushAt = this.now()
    let view: PlayerView | null = null
    if (conn.dirty) {
      view = await this.refreshView(conn, gen)
      if (!this.hosting(gen) || conn.closed) return
      if (!view) {
        this.scheduleFlush(conn)
        return
      }
    }
    await this.sendUpdate(conn, view, gen)
    if (conn.dirty || conn.pendingResults.length > 0) this.scheduleFlush(conn)
  }

  /**
   * Vision → knowledge → tiles → filtered view for one player. null when the state kept changing
   * under it (the caller retries); never pairs a visibility result with another scene revision.
   */
  private async refreshView(conn: PlayerConn, gen: number): Promise<PlayerView | null> {
    const uid = conn.userId
    for (let attempt = 0; attempt < 4; attempt++) {
      conn.dirty = false
      const viewers = viewerTokenIds(this.state!, uid)
      const key = viewers.join(",")
      let vis = conn.lastVis
      if (!vis || conn.lastVisTag !== this.sceneTag || conn.lastVisKey !== key) {
        const tag = this.sceneTag
        const r = await this.computeVision(viewers, tag)
        if (!this.hosting(gen) || conn.closed) return null
        if (!r || r.stateSeq !== tag || tag !== this.sceneTag || viewerTokenIds(this.state!, uid).join(",") !== key) {
          this.staleResults++
          conn.dirty = true
          continue
        }
        vis = r.result
        conn.lastVis = vis
        conn.lastVisTag = tag
        conn.lastVisKey = key
      }
      // Always re-applied: cheap when nothing changed, and it refills explored after a fog reset.
      this.applyKnowledge(uid, vis, this.state!.scene, false)
      const tiler = this.tiler
      if (tiler?.publishing) {
        // Backdrop chunks of newly explored cells upload in the background; wait a little so they are
        // usually announced before the view revealing their cells, but never hold the game up for them.
        const uploads = tiler.sync(uid, own(this.state!.explored, uid) ?? {}, this.focusPoints(uid))
        await this.within(uploads, this.t.tileWaitMs)
        if (!this.hosting(gen) || conn.closed) return null
        if (conn.lastVisTag !== this.sceneTag || viewerTokenIds(this.state!, uid).join(",") !== key) {
          conn.dirty = true
          continue
        }
        await this.sendTileNotices(conn, gen)
      }
      const t0 = this.now()
      const view = this.buildView(uid, vis)
      conn.buildMs = this.now() - t0
      return view
    }
    conn.dirty = true
    return null
  }

  /** Where a player's tokens are (their nearest backdrop chunks upload first). */
  private focusPoints(uid: string): Vec2[] {
    const scene = this.state!.scene
    return viewerTokenIds(this.state!, uid)
      .map((id) => (Object.hasOwn(scene.tokens, id) ? scene.tokens[id].position : null))
      .filter((p): p is Vec2 => p !== null)
  }

  /** Resolve when `work` settles or after `ms`, whichever comes first. */
  private within(work: Promise<void>, ms: number): Promise<void> {
    const clock = this.clock
    if (ms <= 0 || !clock) return Promise.resolve()
    return new Promise((resolve) => {
      const h = clock.setTimeout(resolve, ms)
      void work.then(
        () => {
          clock.clearTimeout(h)
          resolve()
        },
        () => resolve()
      )
    })
  }

  /** Queue a backdrop chunk announcement for a player (sent in order with their other messages). */
  private queueTileNotice(uid: string, levelId: Id, entries: ChunkEntry[], reset: boolean, gen: number): void {
    const conn = this.conns.get(uid)
    if (!conn || conn.closed || gen !== this.gen) return
    let pending = conn.pendingTiles.get(levelId)
    if (!pending || reset) conn.pendingTiles.set(levelId, (pending = { reset: reset || (pending?.reset ?? false), chunks: new Map() }))
    for (const e of entries) pending.chunks.set(`${e[0]},${e[1]}`, e)
    if (conn.tileNoticeQueued) return
    conn.tileNoticeQueued = true
    this.enqueue(conn, gen, () => this.sendTileNotices(conn, gen))
  }

  /** Send a player's pending chunk announcements (one message per level). */
  private async sendTileNotices(conn: PlayerConn, gen: number): Promise<void> {
    conn.tileNoticeQueued = false
    if (!this.hosting(gen) || conn.closed || conn.pendingTiles.size === 0) return
    // Before the first snapshot the table sent with it covers everything.
    if (conn.lastSent === null) return
    const pending = conn.pendingTiles
    conn.pendingTiles = new Map()
    const epoch = this.wireEpoch!
    for (const [levelId, p] of pending) {
      const msg: Extract<HostToClient, { t: "tiles" }> = { t: "tiles", epoch, levelId, chunks: [...p.chunks.values()] }
      if (p.reset) msg.reset = true
      await this.send(conn, msg)
    }
  }

  /** With a snapshot: everything uploaded for the player, so a (re)loaded client knows its chunks. */
  private async sendTileTable(conn: PlayerConn, gen: number): Promise<void> {
    const tiler = this.tiler
    if (!tiler?.publishing || !this.hosting(gen) || conn.closed) return
    conn.pendingTiles.clear()
    const epoch = this.wireEpoch!
    for (const { levelId, entries } of tiler.table(conn.userId)) {
      await this.send(conn, { t: "tiles", epoch, levelId, chunks: entries, reset: true })
    }
  }

  /** filterForPlayer (THE path to a player) + backdrop placements of known levels. */
  private buildView(uid: string, vis: VisibilityResult): PlayerView {
    const view = filterForPlayer(this.state!, uid, vis)
    if (view.backdrops === undefined && this.tiler) {
      const known = Object.values(view.scene.levels)
        .filter((l) => l.known)
        .map((l) => l.id)
      const backdrops = this.tiler.backdrops(known)
      if (backdrops) view.backdrops = backdrops
    }
    return view
  }

  /** Send the diff to `view` (with pending results), or the results alone when nothing changed. */
  private async sendUpdate(conn: PlayerConn, view: PlayerView | null, gen: number): Promise<void> {
    const epoch = this.wireEpoch!
    const t0 = this.now()
    const prev = conn.lastSent
    const ops = view && prev ? diffViews(prev, view) : []
    if (view) this.stats.flushMs = conn.buildMs + (this.now() - t0)
    const results = conn.takeResults()
    if (ops.length === 0 || !view) {
      await this.sendResults(conn, results)
      return
    }
    const baseSeq = conn.seq
    const msg: Extract<HostToClient, { t: "patch" }> = { t: "patch", epoch, baseSeq, seq: baseSeq + 1, ops }
    if (results.length > 0) msg.results = results
    const enc = encodePayload(msg)
    conn.seq = baseSeq + 1
    conn.lastSent = view
    if (enc.ok) {
      conn.log.push({ baseSeq, seq: conn.seq, ops, bytes: enc.bytes, at: this.now() })
      const res = await this.send(conn, msg, enc.bytes)
      this.resultsSent(conn, results, conn.seq, res)
    } else {
      // Too large for one broadcast: store the view, then point the client at the database.
      conn.log.clear()
      await this.snapshotViaDatabase(conn, gen, undefined)
      await this.sendResults(conn, results)
    }
    conn.viewSaver?.request(viewSaveUrgency(prev, view))
  }

  /**
   * A full view for a (re)joined or resyncing client: snapshot, or snapshot_ready via the database.
   * `since` (answering a hello): also re-deliver the results sent after that seq (null: all remembered).
   */
  private async pushSnapshot(conn: PlayerConn, gen: number, nonce?: string, since?: number | null): Promise<void> {
    const link = conn.link
    if (!this.hosting(gen) || conn.closed || !link) return
    if (!link.isReady()) {
      conn.needsSnapshot = true
      return
    }
    let view = await this.refreshView(conn, gen)
    if (!this.hosting(gen) || conn.closed) return
    if (!view) {
      if (!conn.lastSent) {
        conn.needsSnapshot = true
        this.scheduleFlush(conn, this.t.flushIntervalMs)
        return
      }
      view = conn.lastSent
      conn.dirty = true
    }
    conn.lastFlushAt = this.now()
    if (conn.lastSent === null) {
      conn.lastSent = view
      conn.log.clear()
    } else if (view !== conn.lastSent) {
      const ops = diffViews(conn.lastSent, view)
      if (ops.length > 0) {
        // Logged like a patch, so other tabs still at the previous seq can catch up.
        conn.log.push({ baseSeq: conn.seq, seq: conn.seq + 1, ops, bytes: jsonBytes(ops), at: this.now() })
        conn.seq++
        conn.lastSent = view
      }
    }
    conn.needsSnapshot = false
    conn.needsResume = false
    const epoch = this.wireEpoch!
    const results = conn.takeResults()
    const fresh = new Set(results.map((r) => r.reqId))
    const earlier = since === undefined ? [] : conn.resultLog.since(since).filter((r) => !fresh.has(r.reqId))
    const msg: Extract<HostToClient, { t: "snapshot" }> = { t: "snapshot", epoch, seq: conn.seq, view: conn.lastSent }
    if (nonce !== undefined) msg.nonce = nonce
    if (results.length + earlier.length > 0) msg.results = [...earlier, ...results]
    const enc = encodePayload(msg)
    // The client learns its backdrop chunks first, so it fetches them as soon as the view lands.
    await this.sendTileTable(conn, gen)
    if (enc.ok && enc.bytes <= this.maxSnapshotBytes) {
      const res = await this.send(conn, msg, enc.bytes)
      this.resultsSent(conn, results, conn.seq, res)
    } else {
      await this.snapshotViaDatabase(conn, gen, nonce)
      for (const result of earlier) await this.send(conn, { t: "result", epoch, seq: conn.seq, result })
      await this.sendResults(conn, results)
    }
    // A view with the player's own tokens (e.g. the first after an assignment) is stored soon.
    conn.viewSaver?.request(conn.lastSent.controlledTokenIds.length > 0 && conn.savedSeq < conn.seq ? "soon" : false)
    if (conn.dirty) this.scheduleFlush(conn)
  }

  /** Awaited player_views upsert, then snapshot_ready (the client reloads its row). */
  private async snapshotViaDatabase(conn: PlayerConn, gen: number, nonce: string | undefined): Promise<void> {
    // The row may already hold this (epoch, seq): no second upload of a large view.
    if (conn.savedSeq !== conn.seq) {
      try {
        await conn.viewSaver?.flush(true)
      } catch {
        // Reported (and fencing handled) by the saver's onError; savedSeq tells whether it worked.
      }
    }
    if (!this.hosting(gen) || conn.closed) return
    if (conn.savedSeq !== conn.seq) {
      // The row could not be written: try again shortly (the client keeps waiting for us).
      conn.needsSnapshot = true
      this.scheduleFlush(conn, this.t.flushIntervalMs * 10)
      return
    }
    const msg: Extract<HostToClient, { t: "snapshot_ready" }> = { t: "snapshot_ready", epoch: this.wireEpoch!, seq: conn.seq }
    if (nonce !== undefined) msg.nonce = nonce
    await this.send(conn, msg)
  }

  /** upsert_player_view of the player's current view (throttled via conn.viewSaver). */
  private async saveView(conn: PlayerConn, gen: number): Promise<void> {
    const view = conn.lastSent
    const hostEpoch = this.hostEpoch
    const epoch = this.wireEpoch
    if (!view || hostEpoch === null || !epoch || gen !== this.gen || conn.closed) return
    const seq = conn.seq
    try {
      await this.o.repo.upsertPlayerView({ sessionId: this.o.sessionId, userId: conn.userId, hostEpoch, epoch, seq, view })
    } catch (err) {
      // A member kicked meanwhile: nothing to store.
      if (isNetError(err, "not_member")) return
      throw err
    }
    if (gen === this.gen) conn.savedSeq = seq
  }

  private async handleHello(conn: PlayerConn, msg: Extract<ClientToHost, { t: "hello" }>, gen: number): Promise<void> {
    if (!this.hosting(gen) || conn.closed || !conn.link) return
    const epoch = this.wireEpoch!
    if (conn.lastSent !== null && msg.epoch === epoch && msg.lastSeq !== null) {
      if (msg.lastSeq === conn.seq) {
        // Within one wire epoch a seq identifies a view: the client provably holds lastSent.
        conn.needsSnapshot = false
        await this.send(conn, { t: "sync", epoch, seq: conn.seq })
        return
      }
      if (!conn.needsSnapshot) {
        const ops = conn.log.since(msg.lastSeq, conn.seq)
        if (ops && ops.length > 0) {
          const patch: Extract<HostToClient, { t: "patch" }> = { t: "patch", epoch, baseSeq: msg.lastSeq, seq: conn.seq, ops, nonce: msg.nonce }
          // Results that went out with the patches the client missed (it ignores ones it already has).
          const results = conn.resultLog.since(msg.lastSeq)
          if (results.length > 0) patch.results = results
          let enc = encodePayload(patch)
          if (!enc.ok && patch.results) {
            delete patch.results
            enc = encodePayload(patch)
          }
          if (enc.ok) {
            await this.send(conn, patch, enc.bytes)
            return
          }
        }
      }
    }
    await this.pushSnapshot(conn, gen, msg.nonce, msg.epoch === epoch ? msg.lastSeq : null)
  }

  private onLinkReady(conn: PlayerConn, gen: number): void {
    if (!this.hosting(gen) || conn.closed) return
    this.notify()
    if (conn.lastSent === null) {
      conn.needsSnapshot = true
      // Skipped when a flush queued before this already pushed the snapshot.
      this.enqueue(conn, gen, () => (conn.needsSnapshot ? this.pushSnapshot(conn, gen) : Promise.resolve()))
      return
    }
    // A rejoin (Realtime error, JWT refresh, network blip): the client most likely still holds its view.
    conn.needsResume = true
    this.enqueue(conn, gen, () => this.resumeLink(conn, gen))
  }

  /**
   * After a host-side rejoin of a linked player: the tile table (replacing chunk notices lost while the
   * link was down; the client has the blobs cached) and `sync` at the current seq — a client that missed
   * patches answers with hello and gets a catch-up (or a snapshot if the log no longer covers it).
   * Results whose send failed meanwhile go out with the next flush.
   */
  private async resumeLink(conn: PlayerConn, gen: number): Promise<void> {
    if (!this.hosting(gen) || conn.closed || !conn.link?.isReady() || !conn.needsResume) return
    if (conn.lastSent === null || conn.needsSnapshot) {
      conn.needsResume = false
      await this.pushSnapshot(conn, gen)
      return
    }
    await this.sendTileTable(conn, gen)
    if (!this.hosting(gen) || conn.closed || !conn.link?.isReady()) return
    conn.needsResume = false
    const res = await this.send(conn, { t: "sync", epoch: this.wireEpoch!, seq: conn.seq })
    if (!res.ok) return
    if (conn.dirty || conn.pendingResults.length > 0) this.scheduleFlush(conn)
  }

  /** `sync` to players that heard nothing for a while (a lost final patch is then detected). */
  private idleSync(gen: number): void {
    if (!this.hosting(gen)) return
    const now = this.now()
    for (const conn of this.conns.values()) {
      if (conn.closed || !conn.link?.isReady() || conn.lastSent === null || conn.needsSnapshot || conn.needsResume) continue
      if (now - conn.lastMessageAt < this.t.idleSyncMs) continue
      conn.lastMessageAt = now
      this.enqueue(conn, gen, async () => {
        await this.send(conn, { t: "sync", epoch: this.wireEpoch!, seq: conn.seq })
      })
    }
    // Moves whose result never went out stop blocking their token.
    for (const [tokenId, f] of this.inFlightMoves) if (now - f.at > this.t.inFlightMoveTimeoutMs) this.inFlightMoves.delete(tokenId)
  }

  private async send(conn: PlayerConn, msg: HostToClient, bytes?: number): Promise<SendResult> {
    const link = conn.link
    if (!link || conn.closed) return sendFailure("closed")
    const res = await link.send(msg)
    if (res.ok) {
      this.stats.messagesSent++
      this.stats.bytesSent += bytes ?? jsonBytes(msg)
      conn.lastMessageAt = this.now()
    } else if (res.reason === "not-joined" || res.reason === "closed") {
      // The link is (re)joining: its onReady resyncs the client (a snapshot if it never got a view).
      if (conn.lastSent === null) conn.needsSnapshot = true
      else conn.needsResume = true
    } else if (res.reason === "too-large") {
      conn.needsSnapshot = true
      this.log(`message to ${conn.userId} too large (${res.detail ?? ""})`)
    }
    this.statsChanged()
    return res
  }

  // =========================================================================
  // Test / debug accessors
  // =========================================================================

  /** The view the host believes a player holds, and its seq (tests). */
  debugPlayer(userId: string): { seq: number; view: PlayerView | null; logSize: number } | null {
    const c = this.conns.get(userId)
    return c ? { seq: c.seq, view: c.lastSent, logSize: c.log.size } : null
  }

  /** Whether every player is idle (nothing dirty, queued or pending, no step probe outstanding) (tests). */
  debugIdle(): boolean {
    if ((this.vision?.pendingProbes ?? 0) > 0) return false
    for (const c of this.conns.values()) {
      if (c.dirty || c.flushQueued || c.timer !== null || c.pendingResults.length > 0 || c.needsSnapshot || c.needsResume || c.pendingHello !== null) return false
    }
    return true
  }

  get debugHostEpoch(): number | null {
    return this.hostEpoch
  }
}
