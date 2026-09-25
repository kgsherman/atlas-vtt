/**
 * The player-side client (ARCHITECTURE §6.3, §9): joins the player's channels, keeps the PlayerView in
 * sync with the host (snapshots, sequenced patches, hello resynchronisation), falls back to the
 * persisted `player_views` row while the DM is away, sends move/door/token-image requests and composites the
 * battlemap tiles of explored cells into per-level canvases.
 *
 * Sync rules (the host side lives in net/host):
 *  - Join: view:{uid} → SUBSCRIBED → req:{uid} (PlayerChannels does this) → on every ready: hello{nonce, epoch, lastSeq}.
 *  - patch: applied iff epoch === local.epoch && baseSeq === local.seq; otherwise hello.
 *  - snapshot: replaces the view. snapshot_ready: reload the row; accepted only for the announced epoch
 *    with seq ≥ the announced seq and newer than ours, otherwise hello again (only when no later
 *    snapshot_ready is being loaded). A later snapshot_ready does not throw a load in flight away, and a
 *    result / patch / sync at a seq the row being loaded brings needs no hello (a slow row load would
 *    otherwise never land: every hello is answered with another snapshot_ready).
 *  - sync: seq > local (or another epoch) → hello.
 *  - Replies carrying a nonce that is not ours (another tab of the same user) are dropped.
 *  - Epochs superseded by a HostBroadcast `status` from a newer host are ignored for good.
 *  - snapshot at the (epoch, seq) we already hold (the host re-linked us after a channel rejoin): keeps
 *    the view, scene and pending overlays, only applies the results it carries.
 *  - Host liveness = DM presence on the host topic. Offline: load our own row, status "host-offline",
 *    requests are rejected locally. Back online: hello.
 *  - While not live (connecting, syncing, host offline) the client re-checks session_info every
 *    membershipCheckMs, so a session ended from the library (no host to broadcast `ended`) or a kick
 *    that the channels cannot report still reaches the player.
 *  - Our own network (transport.networkOnline, e.g. navigator.onLine) down: requests are refused locally
 *    as "not-connected" and expiring requests are not blamed on the DM (`networkOffline` in the snapshot).
 *  - Pending requests are overlays only: cleared by their result, by a snapshot / epoch change, or
 *    after 5 s ("DM not responding"). Results ahead of our view (a `result`, or a patch we cannot apply,
 *    at a later seq of this run) wait for a view at or past their seq: they report on an update we do not
 *    show yet (e.g. a map change still loading).
 *  - Another map (the view's scene.mapSerial changed: the DM moved the game): the scene is replaced,
 *    requests about the old map's places are dropped and their verdicts ignored, `mapChanges` counts it.
 *    Those requests (move, jump, door, template) name the map they were made on (`map`): the host refuses
 *    them once the game is on another one.
 */
import type { PathStep } from "@/core/movement/types"
import { HP_LIMITS, isTokenCondition, type TokenStatusChange } from "@/core/scene/tokenStatus"
import type { Cell, Id, Level, SceneLike, Vec2 } from "@/core/scene/types"
import { applyPatchOps } from "@/core/session/diff"
import { parsePlayerView, playerPingSchema } from "@/core/session/playerViewSchema"
import type {
  AreaTemplateInput,
  ClientToHost,
  HostBroadcast,
  HostToClient,
  PatchOp,
  PlayerBackdrop,
  PlayerPing,
  PlayerView,
  RejectReason,
  RequestResult,
} from "@/core/session/types"
import { PROTOCOL_LIMITS } from "@/core/session/protocol"
import { TABLE_LIMITS } from "@/core/session/table"
import { viewToScene } from "@/core/session/viewToScene"
import type { Engine, SceneChange } from "@/render/contracts"

import { isChunkEntry } from "../assets/chunks"
import type { PlayerViewRow } from "../sessionsRepo"
import type { PlayerChannels, Unsubscribe } from "../transport"
import {
  BackdropCompositor,
  defaultClock,
  type BackdropCanvas,
  type BackdropCompositorOptions,
  type BackdropEvent,
  type BackdropLayer,
  type CompositorClock,
} from "./backdropCanvas"
import type { PendingRequest, PlayerClient, PlayerClientOptions, PlayerSnapshot, PlayerStatus } from "./types"

// ---------------------------------------------------------------------------
// Public additions to the PlayerClient contract
// ---------------------------------------------------------------------------

/** Why the client itself settled a request (it never reached the host, or the host did not answer). */
export type LocalRejectReason =
  /** Over the client-side budget (≤ 8 requests per second). */
  | "rate-limited"
  /** The DM is not connected: input is disabled. */
  | "host-offline"
  /** Our channels are (re)connecting. */
  | "not-connected"
  /** No answer within the pending timeout ("DM not responding"). */
  | "timeout"
  /** The transport refused the message. */
  | "send-failed"
  /** Obviously invalid before sending (empty or over-long path). */
  | "invalid"
  /** The client was stopped, kicked or the session ended. */
  | "closed"

export interface ClientRequestResult extends RequestResult {
  /** Set when the client settled the request itself (no host verdict). */
  local?: LocalRejectReason
  /** What was asked (known for the requests this client sent). */
  kind?: PendingRequest["kind"]
}

/** A ping to draw: from the host (someone else's), or this player's own (`mine`, drawn at once). */
export interface PingEvent extends PlayerPing {
  mine: boolean
}

export interface PlayerClientSnapshot extends PlayerSnapshot {
  results: ClientRequestResult[]
  /** A request expired without an answer and nothing has arrived from the host since. */
  hostUnresponsive: boolean
  /** Where the current view came from: live messages, or the persisted row (host offline / snapshot_ready). */
  viewSource: "live" | "row" | null
  /**
   * This device lost its own network connection (the transport says so, e.g. `navigator.onLine`): show
   * "You're offline, reconnecting…" rather than blaming the DM. Requests are refused as "not-connected".
   */
  networkOffline: boolean
  /**
   * Views of another map adopted since start (the DM moved the game: `isOtherMap`), by patch or snapshot.
   * Never counts the first view or a resync onto the same map; the play page greets each new map once.
   */
  mapChanges: number
}

export type ClientClock = CompositorClock

export interface PlayerClientTimings {
  /** Pending requests expire after this long without a result (default 5 s). */
  pendingTimeoutMs: number
  /** First hello retry when unanswered (doubles up to helloRetryMaxMs). */
  helloRetryMs: number
  helloRetryMaxMs: number
  /** After the host channel joins, how long to wait for DM presence before declaring the host offline. */
  hostPresenceGraceMs: number
  /** Client-side request budget: at most `max` move/door requests per `windowMs`. */
  requestRate: { max: number; windowMs: number }
  /** Retry delays for loading our row while the host is offline. */
  rowRetryMs: readonly number[]
  /** While not live (connecting, syncing, host offline), re-check membership this often (kicked/ended). */
  membershipCheckMs: number
  /** Results kept in the snapshot (newest last). */
  maxResults: number
}

export const PLAYER_CLIENT_TIMINGS: PlayerClientTimings = {
  pendingTimeoutMs: 5000,
  helloRetryMs: 2500,
  helloRetryMaxMs: 15_000,
  hostPresenceGraceMs: 1500,
  requestRate: { max: 8, windowMs: 1000 },
  rowRetryMs: [2000, 5000, 10_000],
  membershipCheckMs: 10_000,
  maxResults: 20,
}

export interface PlayerClientRuntimeOptions extends PlayerClientOptions {
  timings?: Partial<PlayerClientTimings>
  clock?: ClientClock
  /** Backdrop compositing knobs (canvas factory, size budget, concurrency…). */
  backdrop?: Omit<BackdropCompositorOptions, "tiles" | "onEvent" | "clock">
  /** Dispose `tiles` on stop() (default true: the client owns the tile source it was given). */
  disposeTiles?: boolean
  /** Request ids / nonces (default crypto.randomUUID). */
  newId?: () => string
}

/** PlayerClient plus the backdrop and engine-integration helpers. */
export interface AtlasPlayerClient extends PlayerClient {
  getSnapshot(): PlayerClientSnapshot
  /**
   * Scene change hint for Engine.updateScene between an earlier snapshot's `scene` and the current
   * one; null = replaced or unknown (call Engine.setScene). `scene` keeps its identity while only
   * masks/flags/results change, so compare identities before calling.
   */
  sceneChangeSince(previous: SceneLike | null): SceneChange | null
  /** Backdrop canvas events (see BackdropEvent); `bindBackdropsToEngine` wires them to an Engine. */
  onBackdrop(cb: (ev: BackdropEvent) => void): Unsubscribe
  /** Current backdrop layers (announced or still waiting for their first tile). */
  backdropLayers(): BackdropLayer[]
  /** The composited canvas of a level (null when it has no backdrop). */
  backdropCanvas(levelId: Id): BackdropCanvas | null
  /** Retry backdrop tiles that were given up on. */
  retryBackdropTiles(): void
  /** Chat to everyone, or whisper to the DM. Returns the reqId. */
  say(text: string, to: "all" | "dm"): string
  /** Ask the host to roll "formula [label]" (e.g. "1d20+5 to hit"). Returns the reqId. */
  roll(formula: string, to: "all" | "dm"): string
  /** Roll initiative (1d20 + `bonus`, rolled by the host) for one of our tokens in combat. */
  rollInitiative(tokenId: Id, bonus: number): string
  /** End the turn of `entryId` (one of our tokens, acting now). */
  endTurn(entryId: Id): string
  /**
   * Change one of our tokens: damage, healing or temporary hit points (when the DM tracks them; `max`
   * and `set` changes are the DM's and are not sent) and/or conditions to add and remove. Relative, so it
   * never overwrites a change the DM (or an earlier click) made meanwhile.
   */
  changeTokenStatus(tokenId: Id, change: TokenStatusChange): string
  /**
   * Point at a spot for the table (only on levels we know; the host drops the rest). Emitted to onPing
   * at once as `mine`. false when it could not be sent (not live, or more than one per PING_GAP_MS).
   */
  ping(levelId: Id, point: Vec2): boolean
  /** Pings to draw (others' from the host, and our own). */
  onPing(cb: (ev: PingEvent) => void): Unsubscribe
  /**
   * Place an area of effect (on a level we know, or carried by one of our tokens), or with `id` move /
   * change one of our own. Returns the reqId.
   */
  placeTemplate(template: AreaTemplateInput, id?: Id): string
  /** Remove one of our templates. Returns the reqId. */
  removeTemplate(id: Id): string
  /**
   * Pixel budget of a level's full backdrop canvas (default 32 MP). Pass the engine's texel budget
   * (`backdropTexelBudget(engine.getQualityCeiling())`) so each canvas is uploaded as is; layers whose
   * scale changes are redrawn and announced again with a "set" event.
   */
  setBackdropBudget(maxPixels: number): void
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Our own pings: at most one per this long (the host allows 1/s, burst 3). */
export const PING_GAP_MS = 400

const MAX_NONCES = 8
const MAX_REQ_IDS = 256
/** Result batches kept while ahead of our view (a `result` message holds one). */
const MAX_HELD = 64
const MAX_SCENE_HISTORY = 64

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/** Cheap structural check for views from the (trusted, RLS-guarded) host channel. */
export function looksLikeView(v: unknown): v is PlayerView {
  if (!isRecord(v) || v.viewVersion !== 1 || !isRecord(v.scene)) return false
  const s = v.scene
  return (
    isRecord(s.grid) &&
    isRecord(s.environment) &&
    isRecord(s.levels) &&
    isRecord(v.objects) &&
    isRecord(v.tokens) &&
    isRecord(v.terrain) &&
    isRecord(v.masks) &&
    Array.isArray(v.controlledTokenIds) &&
    Array.isArray(v.visionTokenIds) &&
    isRecord(v.flags) &&
    (v.backdrops === undefined || isRecord(v.backdrops))
  )
}

const isFiniteNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)

function validBackdrop(b: unknown): b is PlayerBackdrop {
  if (!isRecord(b) || !isRecord(b.rect)) return false
  const r = b.rect
  return (
    isFiniteNum(r.x) &&
    isFiniteNum(r.z) &&
    isFiniteNum(r.w) &&
    isFiniteNum(r.d) &&
    r.w > 0 &&
    r.d > 0 &&
    isFiniteNum(b.opacity) &&
    b.opacity >= 0 &&
    b.opacity <= 1 &&
    typeof b.tintWalls === "boolean" &&
    Number.isInteger(b.tilePx) &&
    (b.tilePx as number) >= 1 &&
    (b.tilePx as number) <= 1024
  )
}

/**
 * Strictly validate a stored view (player_views row) with the shared schema. Fallback for a schema
 * without `backdrops`: validate the rest strictly, check the placements here and re-attach them.
 */
export function parseStoredView(json: unknown): PlayerView | null {
  if (!isRecord(json)) return null
  const full = parsePlayerView(json)
  if (full || json.backdrops === undefined) return full
  const { backdrops, ...rest } = json
  const view = parsePlayerView(rest)
  if (!view) return null
  if (backdrops === undefined) return view
  if (!isRecord(backdrops)) return null
  const out: Record<Id, PlayerBackdrop> = {}
  for (const [levelId, b] of Object.entries(backdrops)) {
    if (levelId === "__proto__" || !validBackdrop(b)) return null
    out[levelId] = { rect: { x: b.rect.x, z: b.rect.z, w: b.rect.w, d: b.rect.d }, opacity: b.opacity, tintWalls: b.tintWalls, tilePx: b.tilePx }
  }
  return { ...view, backdrops: out }
}

/** Scene reconstruction + backdrop placement on the levels (opacity / tint for the engine). */
export function buildPlayerScene(view: PlayerView): SceneLike {
  const scene = viewToScene(view)
  const backdrops = view.backdrops
  if (!backdrops) return scene
  let levels: Record<Id, Level> | null = null
  for (const levelId of Object.keys(backdrops)) {
    const level = Object.hasOwn(scene.levels, levelId) ? scene.levels[levelId] : undefined
    const b = backdrops[levelId]
    if (!level || level.backdrop || !validBackdrop(b)) continue
    levels ??= { ...scene.levels }
    // The pixels arrive separately (tiles → canvas → Engine.setLevelImage); the id is a placeholder.
    levels[levelId] = { ...level, backdrop: { assetId: `tiles-${levelId}`.slice(0, 64), rect: { ...b.rect }, opacity: b.opacity, tintWalls: b.tintWalls } }
  }
  return levels ? { ...scene, levels } : scene
}

/**
 * `next` shows another map than `prev`: the DM moved the game (load-scene), even to a duplicated map that
 * shares level and token ids. The host's map marker says so (scene.mapSerial, absent on the first map).
 */
export function isOtherMap(prev: Pick<PlayerView, "scene">, next: Pick<PlayerView, "scene">): boolean {
  return (prev.scene.mapSerial ?? 0) !== (next.scene.mapSerial ?? 0)
}

/** Requests about places of the map: meaningless once the game moved to another one. */
const MAP_BOUND: ReadonlySet<PendingRequest["kind"]> = new Set(["move", "jump", "door", "template", "template-remove"])

/**
 * What a patch changes in the reconstructed scene: a SceneChange, "none" (masks/flags only), or
 * null (replace everything, e.g. another map: nothing of the old one animates into it).
 */
export function sceneChangeFromOps(ops: readonly PatchOp[], prev: PlayerView, next: PlayerView): SceneChange | "none" | null {
  if (isOtherMap(prev, next)) return null
  const objects = new Set<Id>()
  const tokens = new Set<Id>()
  const terrain = new Set<Id>()
  let structure = false
  for (const op of ops) {
    const path = op.path
    if (path.length === 0) return null
    const [head, key] = path
    switch (head) {
      case "objects":
        if (key === undefined) return null
        objects.add(key)
        break
      case "tokens":
        if (key === undefined) return null
        tokens.add(key)
        break
      case "terrain":
        if (key === undefined) structure = true
        else terrain.add(key)
        break
      case "scene":
        if (key !== "name") structure = true
        break
      case "backdrops":
        structure = true
        break
      case "controlledTokenIds":
      case "visionTokenIds":
        // Token kind (pc/npc) and optional fields depend on these lists.
        for (const id of [...(prev[head] ?? []), ...(next[head] ?? [])]) tokens.add(id)
        break
      default:
        // masks, flags, ids, the table, templates: not part of the scene
        break
    }
  }
  if (!structure && objects.size === 0 && tokens.size === 0 && terrain.size === 0) return "none"
  const change: SceneChange = {}
  if (objects.size) change.objects = [...objects]
  if (tokens.size) change.tokens = [...tokens]
  if (terrain.size) change.terrain = [...terrain]
  if (structure) change.structure = true
  return change
}

function mergeChanges(changes: readonly SceneChange[]): SceneChange {
  const objects = new Set<Id>()
  const tokens = new Set<Id>()
  const terrain = new Set<Id>()
  let structure = false
  for (const c of changes) {
    for (const id of c.objects ?? []) objects.add(id)
    for (const id of c.tokens ?? []) tokens.add(id)
    for (const id of c.terrain ?? []) terrain.add(id)
    structure ||= c.structure === true
  }
  const out: SceneChange = {}
  if (objects.size) out.objects = [...objects]
  if (tokens.size) out.tokens = [...tokens]
  if (terrain.size) out.terrain = [...terrain]
  if (structure) out.structure = true
  return out
}

function validResult(r: unknown): r is RequestResult {
  return isRecord(r) && typeof r.reqId === "string" && typeof r.ok === "boolean"
}

/** Human-readable text for a request result (toasts). null for successes. */
export function describeRequestResult(r: ClientRequestResult): string | null {
  if (r.ok) return null
  switch (r.local && r.local !== "invalid" ? r.local : undefined) {
    case "rate-limited":
      return "Slow down: too many requests"
    case "host-offline":
      return "Waiting for the DM to reconnect"
    case "not-connected":
      return "Reconnecting…"
    case "timeout":
      return "DM not responding"
    case "send-failed":
      return "Couldn't reach the DM"
    case "closed":
      return "Not connected to the session"
    default:
      break
  }
  if (r.kind === "say" || r.kind === "roll" || r.kind === "initiative" || r.kind === "end-turn") {
    switch (r.reason) {
      case "bad-formula":
        return "Those dice can't be read (try 1d20+5)"
      case "cannot":
        return r.kind === "end-turn" ? "It isn't your turn" : "That character can't roll initiative now"
      case "invalid":
        if (r.kind === "initiative") return `Initiative bonuses go from −${TABLE_LIMITS.maxInitiativeBonus} to +${TABLE_LIMITS.maxInitiativeBonus}`
        return r.kind === "say" ? "Your message wasn't sent" : "The DM rejected that request"
      case "not-owner":
        return "You don't control that character"
      case "rate-limited":
        return "Slow down: too many messages"
      default:
        return r.kind === "say" ? "Your message wasn't sent" : "The DM rejected that request"
    }
  }
  if (r.kind === "template" || r.kind === "template-remove") {
    switch (r.reason) {
      case "not-owner":
        return "You don't control that character"
      case "cannot":
        return "That template isn't yours"
      case "rate-limited":
        return "Slow down: too many requests"
      default:
        return r.kind === "template" ? "The DM rejected that template" : "The DM rejected that request"
    }
  }
  if (r.kind === "token-status") {
    switch (r.reason) {
      case "not-owner":
        return "You don't control that character"
      case "cannot":
        return "The DM doesn't track that character's hit points"
      case "unknown-token":
        return "That character is gone"
      case "rate-limited":
        return "Slow down: too many requests"
      default:
        return "The DM rejected that change"
    }
  }
  const reasons: Partial<Record<RejectReason, string>> = {
    "not-owner": "You don't control that token",
    "movement-locked": "Movement is locked by the DM",
    "unknown-token": "That token is gone",
    "empty-path": "That move isn't possible",
    "path-too-long": "That path is too long",
    "path-start-mismatch": "The token has moved; try again",
    "not-adjacent": "That move isn't possible",
    "out-of-bounds": "That's off the map",
    blocked: "Something blocks the way",
    "corner-cutting": "You can't cut that corner",
    "connector-edge": "Use the top edge of the stairs",
    "no-connector": "There's nothing to climb here",
    "no-ground": "There's no floor there",
    "too-far": "That's farther than the token can move",
    cannot: "You can't reach that door",
    locked: "The door is locked",
    "rate-limited": "Slow down: too many requests",
    invalid: "The DM rejected that request",
  }
  const stopped = r.applied !== undefined && r.applied > 0 ? ` (stopped after ${r.applied} step${r.applied === 1 ? "" : "s"})` : ""
  return (r.reason ? (reasons[r.reason] ?? "Request rejected") : "Request rejected") + stopped
}

/** Pending move paths as the renderer's `OverlayState.pendingMoves` (latest request per token). */
export function pendingMovesOverlay(pending: readonly PendingRequest[]): Record<Id, PathStep[]> {
  const out: Record<Id, PathStep[]> = {}
  for (const p of pending) if (p.kind === "move" && p.tokenId && p.path) out[p.tokenId] = p.path
  return out
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type Terminal = "kicked" | "ended" | "error"

interface HelloInFlight {
  nonce: string
  sentAt: number
  hostOnlineAtSend: boolean
}

class PlayerClientImpl implements AtlasPlayerClient {
  private readonly opts: PlayerClientRuntimeOptions
  private readonly t: PlayerClientTimings
  private readonly clock: ClientClock
  private readonly newId: () => string
  private readonly sessionId: string
  private readonly userId: string

  private channels: PlayerChannels | null = null
  private offs: Unsubscribe[] = []
  private started = false
  private stopped = false
  private frozenStatus: PlayerStatus | null = null
  private terminal: Terminal | null = null
  private error: string | null = null

  // view state
  private view: PlayerView | null = null
  private viewSource: "live" | "row" | null = null
  private epoch: string | null = null
  private seq = 0
  private revision = 0
  private scene: SceneLike | null = null
  private sceneHistory: Array<{ scene: SceneLike; change: SceneChange | null }> = []
  /** Views of another map adopted (PlayerClientSnapshot.mapChanges). */
  private mapChanges = 0
  /** A live reply/patch from the current host run confirmed our state since the last disruption. */
  private synced = false
  private readonly seenEpochs = new Set<string>()
  private readonly retired = new Set<string>()

  // own network (transport.networkOnline)
  private networkOffline = false

  // host liveness
  private hostOnline = false
  private presenceSettled = false
  private graceTimer: unknown = null
  private lastStatus: PlayerStatus = "connecting"

  // hello
  private readonly nonces: string[] = []
  private hello: HelloInFlight | null = null
  private helloWanted = false
  private helloTimer: unknown = null
  private helloBackoff: number

  // requests
  private pending: PendingRequest[] = []
  private pendingTimer: unknown = null
  private results: ClientRequestResult[] = []
  private readonly ourReqIds = new Set<string>()
  /** Requests the host already gave its verdict on (results re-delivered with catch-ups are skipped). */
  private readonly hostSettled = new Set<string>()
  private readonly reqOrder: string[] = []
  private sendTimes: number[] = []
  private hostUnresponsive = false
  /** Results ahead of our view (same run, later seq): reported once a view at or past `seq` is adopted. */
  private held: Array<{ seq: number; results: unknown[] }> = []

  // row loading
  private readyRowToken = 0
  /** What the newest snapshot_ready load in flight brings (epoch, seq): messages up to it need no hello. */
  private readyWant: { epoch: string; seq: number; at: number } | null = null
  private offlineRowToken = 0
  private rowAttempts = 0
  private rowTimer: unknown = null
  private membershipTimer: unknown = null

  // listeners / snapshot
  private readonly listeners = new Set<() => void>()
  private snap: PlayerClientSnapshot | null = null
  private notifyQueued = false

  // backdrops
  private readonly compositor: BackdropCompositor
  private readonly backdropListeners = new Set<(ev: BackdropEvent) => void>()
  /** The map the tile source was last told about (tiles.setMap). */
  private tileMap: number | null = null

  // pings
  private readonly pingListeners = new Set<(ev: PingEvent) => void>()
  private lastPingAt = -Infinity

  constructor(opts: PlayerClientRuntimeOptions) {
    this.opts = opts
    this.t = { ...PLAYER_CLIENT_TIMINGS, ...opts.timings }
    this.clock = opts.clock ?? defaultClock
    this.newId = opts.newId ?? (() => crypto.randomUUID())
    this.sessionId = opts.sessionId
    this.userId = opts.identity.userId
    this.helloBackoff = this.t.helloRetryMs
    // Methods are handed around unbound (useSyncExternalStore(client.subscribe, client.getSnapshot)).
    this.start = this.start.bind(this)
    this.stop = this.stop.bind(this)
    this.getSnapshot = this.getSnapshot.bind(this)
    this.subscribe = this.subscribe.bind(this)
    this.requestMove = this.requestMove.bind(this)
    this.requestDoor = this.requestDoor.bind(this)
    this.requestJump = this.requestJump.bind(this)
    this.requestTokenImage = this.requestTokenImage.bind(this)
    this.sceneChangeSince = this.sceneChangeSince.bind(this)
    this.onBackdrop = this.onBackdrop.bind(this)
    this.backdropLayers = this.backdropLayers.bind(this)
    this.backdropCanvas = this.backdropCanvas.bind(this)
    this.retryBackdropTiles = this.retryBackdropTiles.bind(this)
    this.setBackdropBudget = this.setBackdropBudget.bind(this)
    this.say = this.say.bind(this)
    this.roll = this.roll.bind(this)
    this.rollInitiative = this.rollInitiative.bind(this)
    this.endTurn = this.endTurn.bind(this)
    this.changeTokenStatus = this.changeTokenStatus.bind(this)
    this.ping = this.ping.bind(this)
    this.onPing = this.onPing.bind(this)
    this.compositor = new BackdropCompositor({
      ...opts.backdrop,
      tiles: opts.tiles,
      clock: this.clock,
      onEvent: (ev) => {
        for (const cb of [...this.backdropListeners]) {
          try {
            cb(ev)
          } catch (err) {
            console.error("[atlas player] backdrop listener failed", err)
          }
        }
      },
    })
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started || this.stopped) return
    this.started = true
    let ch: PlayerChannels
    try {
      ch = this.opts.transport.openPlayerChannels(this.sessionId, this.userId, { displayName: this.opts.identity.displayName ?? undefined })
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err))
      return
    }
    this.channels = ch
    this.offs.push(
      ch.view.onMessage((msg) => this.onHostMessage(msg)),
      ch.onReady(() => this.onReady()),
      ch.view.onStatus(() => this.evaluate()),
      ch.req.onStatus(() => this.evaluate()),
      ch.host.onStatus((ev) => this.onHostChannelStatus(ev.status)),
      ch.host.onHostPresence((online) => this.onHostPresence(online)),
      ch.host.onBroadcast((msg) => this.onHostBroadcast(msg))
    )
    const transport = this.opts.transport
    if (typeof transport.networkOnline === "function") {
      this.networkOffline = !transport.networkOnline()
      if (typeof transport.onNetworkChange === "function") this.offs.push(transport.onNetworkChange((online) => this.onNetworkChange(online)))
    }
    this.hostOnline = ch.host.hostOnline()
    if (this.hostOnline) this.presenceSettled = true
    else if (ch.host.status() === "SUBSCRIBED") this.armPresenceGrace()
    if (ch.isReady()) this.onReady()
    // A kicked player's channels may never join (RLS): notice through the membership RPC.
    this.armMembershipCheck()
    this.evaluate()
    this.changed()
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.frozenStatus = this.computeStatus()
    this.stopped = true
    this.clearTimers()
    for (const p of this.pending) this.pushResult({ reqId: p.reqId, ok: false }, "closed", p.kind)
    this.pending = []
    await this.closeChannels()
    this.compositor.dispose()
    if (this.opts.disposeTiles !== false) {
      try {
        this.opts.tiles.dispose()
      } catch (err) {
        console.error("[atlas player] tile source dispose failed", err)
      }
    }
    this.backdropListeners.clear()
    this.changed()
  }

  private async closeChannels(): Promise<void> {
    for (const off of this.offs.splice(0)) off()
    const ch = this.channels
    this.channels = null
    if (ch) {
      try {
        await ch.close()
      } catch (err) {
        console.error("[atlas player] closing channels failed", err)
      }
    }
  }

  private clearTimers(): void {
    for (const h of [this.graceTimer, this.helloTimer, this.pendingTimer, this.rowTimer, this.membershipTimer]) {
      if (h !== null) this.clock.clearTimeout(h)
    }
    this.graceTimer = this.helloTimer = this.pendingTimer = this.rowTimer = this.membershipTimer = null
  }

  private fail(message: string): void {
    this.error = message
    this.enterTerminal("error")
  }

  /** kicked / ended / error: close everything, keep the last view for display. */
  private enterTerminal(kind: Terminal): void {
    if (this.terminal || this.stopped) return
    this.terminal = kind
    this.synced = false
    this.clearTimers()
    for (const p of this.pending) this.pushResult({ reqId: p.reqId, ok: false }, "closed", p.kind)
    this.pending = []
    void this.closeChannels()
    this.changed()
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  private computeStatus(): PlayerStatus {
    if (this.frozenStatus) return this.frozenStatus
    if (this.terminal) return this.terminal
    const ch = this.channels
    if (!ch || !ch.isReady()) return "connecting"
    if (this.hostOnline) return this.synced && this.view ? "live" : "syncing"
    if (!this.presenceSettled) return "syncing"
    return "host-offline"
  }

  /** Re-derive the status and run transition side effects. */
  private evaluate(): void {
    if (this.stopped || this.terminal) return
    const status = this.computeStatus()
    const prev = this.lastStatus
    if (status === prev) return
    this.lastStatus = status
    if (status === "host-offline") this.enterHostOffline()
    if (prev === "host-offline") this.cancelRowLoad()
    // Not live: nothing else would tell us that the session ended (from the library, with no host
    // running to broadcast it) or that we were kicked (local mode: the channels still join).
    if (status !== "live") this.armMembershipCheck()
    else if (this.membershipTimer !== null) {
      this.clock.clearTimeout(this.membershipTimer)
      this.membershipTimer = null
    }
    this.changed()
  }

  /** Our own connection went down / came back (the transport's view: navigator.onLine, socket state). */
  private onNetworkChange(online: boolean): void {
    if (this.stopped || this.terminal) return
    const offline = !online
    if (offline === this.networkOffline) return
    this.networkOffline = offline
    if (offline) {
      // Nothing we send now arrives; the DM is not the one who is unresponsive.
      for (const p of this.pending) this.pushResult({ reqId: p.reqId, ok: false }, "not-connected", p.kind)
      if (this.pending.length) {
        this.pending = []
        this.armPendingTimer()
      }
      this.hostUnresponsive = false
      this.synced = false
    } else {
      // Back: make sure nothing was missed meanwhile.
      this.resync()
      this.compositor.retryMissing()
    }
    this.evaluate()
    this.changed()
  }

  // -------------------------------------------------------------------------
  // Channel events
  // -------------------------------------------------------------------------

  private onReady(): void {
    if (this.stopped || this.terminal) return
    // Every (re)join may have missed messages.
    this.synced = false
    this.evaluate()
    this.sendHello()
  }

  private onHostChannelStatus(status: string): void {
    // Before the first presence information, give it a moment after the join. Later drops are
    // reported by the transport as the host going offline (we can no longer tell).
    if (status === "SUBSCRIBED" && !this.presenceSettled && !this.hostOnline) this.armPresenceGrace()
    this.evaluate()
  }

  private armPresenceGrace(): void {
    if (this.graceTimer !== null) this.clock.clearTimeout(this.graceTimer)
    this.graceTimer = this.clock.setTimeout(() => {
      this.graceTimer = null
      if (this.stopped || this.terminal) return
      this.presenceSettled = true
      this.evaluate()
    }, this.t.hostPresenceGraceMs)
  }

  private onHostPresence(online: boolean): void {
    if (this.stopped || this.terminal) return
    const knewOffline = this.presenceSettled && !this.hostOnline
    this.hostOnline = online
    this.presenceSettled = true
    if (this.graceTimer !== null) this.clock.clearTimeout(this.graceTimer)
    this.graceTimer = null
    if (online) {
      this.synced = false
      this.evaluate()
      this.compositor.retryMissing()
      // Host back: resync. A hello already in flight was sent while we knew the DM was away → resend.
      if (!this.hello || (knewOffline && !this.hello.hostOnlineAtSend)) this.sendHello()
    } else {
      this.synced = false
      this.evaluate()
    }
  }

  private onHostBroadcast(msg: HostBroadcast): void {
    if (this.stopped || this.terminal) return
    if (msg.t === "ended") {
      this.enterTerminal("ended")
      return
    }
    if (msg.t === "status" && typeof msg.epoch === "string") {
      // A host announcing itself supersedes every other epoch we have seen.
      for (const e of this.seenEpochs) if (e !== msg.epoch) this.retired.add(e)
      this.retired.delete(msg.epoch)
      this.seenEpochs.add(msg.epoch)
      if (this.epoch !== null && this.epoch !== msg.epoch) this.resync()
    }
  }

  // -------------------------------------------------------------------------
  // Hello
  // -------------------------------------------------------------------------

  private sendHello(): void {
    const ch = this.channels
    if (!ch || !ch.isReady() || this.stopped || this.terminal) return
    const nonce = this.newId()
    this.nonces.push(nonce)
    if (this.nonces.length > MAX_NONCES) this.nonces.shift()
    this.hello = { nonce, sentAt: this.clock.now(), hostOnlineAtSend: this.hostOnline }
    this.helloWanted = false
    const lastSeq = this.epoch === null ? null : this.seq
    void ch.req.send({ t: "hello", nonce, epoch: this.epoch, lastSeq }).then((res) => {
      if (!res.ok && res.reason !== "not-joined") console.warn("[atlas player] hello not sent:", res.reason, res.detail ?? "")
    })
    this.armHelloTimer()
  }

  private armHelloTimer(): void {
    if (this.helloTimer !== null) this.clock.clearTimeout(this.helloTimer)
    const delay = this.helloBackoff
    this.helloTimer = this.clock.setTimeout(() => {
      this.helloTimer = null
      if (this.stopped || this.terminal || !this.hello) return
      // Unanswered. Keep asking while someone may answer; an offline host is handled by presence.
      if (this.hostOnline || !this.presenceSettled) {
        this.helloBackoff = Math.min(this.helloBackoff * 2, this.t.helloRetryMaxMs)
        this.sendHello()
      } else {
        this.hello = null
      }
    }, delay)
  }

  private helloAnswered(): void {
    this.hello = null
    this.helloBackoff = this.t.helloRetryMs
    if (this.helloTimer !== null) this.clock.clearTimeout(this.helloTimer)
    this.helloTimer = null
    if (this.helloWanted) this.sendHello()
  }

  /** Out of sync: ask the host (coalesced with a hello already in flight). */
  private resync(): void {
    this.synced = false
    if (!this.channels?.isReady()) return
    if (this.hello && this.clock.now() - this.hello.sentAt < this.t.helloRetryMs) {
      this.helloWanted = true
      return
    }
    this.sendHello()
  }

  // -------------------------------------------------------------------------
  // Host → client messages
  // -------------------------------------------------------------------------

  private onHostMessage(msg: HostToClient): void {
    if (this.stopped || this.terminal) return
    if (msg.t === "kicked") {
      this.error = typeof msg.reason === "string" && msg.reason ? msg.reason : null
      this.enterTerminal("kicked")
      return
    }
    const m = msg as HostToClient & { epoch?: unknown; nonce?: unknown }
    if (typeof m.epoch !== "string") return
    // Replies to another tab's hello.
    if (m.nonce != null && (typeof m.nonce !== "string" || !this.nonces.includes(m.nonce))) return
    if (this.retired.has(m.epoch)) return
    this.seenEpochs.add(m.epoch)
    this.hostUnresponsive = false
    const ours = typeof m.nonce === "string"

    switch (msg.t) {
      case "snapshot":
        this.onSnapshot(msg, ours)
        break
      case "snapshot_ready":
        if (ours) this.helloAnswered()
        void this.loadReadyRow(msg.epoch, msg.seq)
        break
      case "patch":
        this.onPatch(msg, ours)
        break
      case "sync":
        this.onSync(msg)
        break
      case "result":
        this.resultsAt(msg.epoch, msg.seq, [msg.result])
        // Ahead of our view, or another run: we missed an update (unless the row being loaded brings it).
        if ((msg.epoch !== this.epoch || (isFiniteNum(msg.seq) && msg.seq > this.seq)) && !this.rowBrings(msg.epoch, msg.seq)) this.resync()
        break
      case "tiles":
        this.onTiles(msg)
        return
      case "ping":
        this.onHostPing(msg)
        return
      default:
        return
    }
    this.evaluate()
    this.changed()
  }

  /**
   * Someone pointed at a spot (only the current host run's pings on a level of the map we show; malformed
   * ones are dropped). Pings travel outside the view's order: one from just before a map change may land
   * after it.
   */
  private onHostPing(msg: Extract<HostToClient, { t: "ping" }>): void {
    if (msg.epoch !== this.epoch) return
    const res = playerPingSchema.safeParse(msg.ping)
    if (!res.success) return
    if (!this.view || !Object.hasOwn(this.view.scene.levels, res.data.levelId)) return
    this.emitPing({ ...res.data, mine: false })
  }

  private emitPing(ev: PingEvent): void {
    for (const cb of [...this.pingListeners]) {
      try {
        cb(ev)
      } catch (err) {
        console.error("[atlas player] ping listener failed", err)
      }
    }
  }

  /** Backdrop tile chunks were uploaded for us: tell the tile source, then fetch the tiles now. */
  private onTiles(msg: Extract<HostToClient, { t: "tiles" }>): void {
    if (typeof msg.levelId !== "string" || !Array.isArray(msg.chunks) || msg.chunks.length > 4096 || !msg.chunks.every(isChunkEntry)) {
      console.warn("[atlas player] malformed tiles message ignored")
      return
    }
    if (!this.opts.tiles.setChunks) return
    const refreshed: Cell[] | void = this.opts.tiles.setChunks(msg.levelId, msg.chunks, msg.reset === true)
    // Chunks re-cut with more of a partly explored cell: draw those cells again over the old pixels.
    if (Array.isArray(refreshed) && refreshed.length > 0) this.compositor.refreshCells(msg.levelId, refreshed)
    this.compositor.retryMissing(msg.levelId)
  }

  private onSnapshot(msg: Extract<HostToClient, { t: "snapshot" }>, ours: boolean): void {
    if (!isFiniteNum(msg.seq) || !looksLikeView(msg.view)) {
      console.warn("[atlas player] malformed snapshot ignored")
      this.resync()
      return
    }
    // Same run, older than what we hold (can only be a late duplicate): keep ours.
    if (msg.epoch === this.epoch && msg.seq < this.seq && this.view) {
      if (ours) this.helloAnswered()
      this.applyResults(msg.results)
      return
    }
    // Same run, same seq: within one wire epoch a seq identifies a view (the rule the host's hello
    // handling uses too), so we already hold it. Keep view, scene and pending overlays (a full
    // replaceView would rebuild the renderer for nothing, e.g. after a DM-side channel rejoin).
    if (msg.epoch === this.epoch && msg.seq === this.seq && this.view) {
      this.viewSource = "live"
      this.synced = true
      this.helloAnswered()
      this.applyResults(msg.results)
      return
    }
    this.replaceView(msg.view, msg.epoch, msg.seq, "live")
    this.synced = true
    this.helloAnswered()
    this.applyResults(msg.results)
  }

  private onPatch(msg: Extract<HostToClient, { t: "patch" }>, ours: boolean): void {
    const view = this.view
    if (view && msg.epoch === this.epoch && msg.baseSeq === this.seq && isFiniteNum(msg.seq) && Array.isArray(msg.ops)) {
      let next: PlayerView
      try {
        next = applyPatchOps(view, msg.ops)
        if (!looksLikeView(next)) throw new Error("patched view is malformed")
      } catch (err) {
        console.warn("[atlas player] patch failed, resyncing", err)
        this.resultsAt(msg.epoch, msg.seq, msg.results)
        this.resync()
        return
      }
      this.view = next
      this.viewSource = "live"
      this.seq = msg.seq
      this.revision++
      this.synced = true
      if (ours) this.helloAnswered()
      // Before its results: verdicts on the old map's places are not the player's business any more.
      if (isOtherMap(view, next)) this.leaveMap()
      this.updateScene(sceneChangeFromOps(msg.ops, view, next))
      this.syncBackdrops(next)
      this.releaseHeld(msg.seq)
      this.applyResults(msg.results)
      return
    }
    this.resultsAt(msg.epoch, msg.seq, msg.results)
    // Already have it (duplicate of a catch-up we applied): nothing to do.
    if (view && msg.epoch === this.epoch && isFiniteNum(msg.seq) && msg.seq <= this.seq) return
    if (msg.epoch !== this.epoch) this.onEpochChange()
    if (this.rowBrings(msg.epoch, msg.seq)) return
    this.resync()
  }

  private onSync(msg: Extract<HostToClient, { t: "sync" }>): void {
    if (this.view && msg.epoch === this.epoch && msg.seq === this.seq) {
      this.synced = true
      // An in-sync answer to our hello.
      if (this.hello) this.helloAnswered()
      return
    }
    if (msg.epoch === this.epoch && isFiniteNum(msg.seq) && msg.seq < this.seq) return
    if (msg.epoch !== this.epoch) this.onEpochChange()
    if (this.rowBrings(msg.epoch, msg.seq)) return
    this.resync()
  }

  /** A different host run: earlier requests will never be answered (their overlays go away). */
  private onEpochChange(): void {
    this.held = []
    if (this.pending.length) {
      this.pending = []
      this.armPendingTimer()
    }
  }

  /**
   * Results that did not come with a view we adopted (a `result` message, or a patch we could not apply):
   * reported now, except verdicts on pending requests about the map's places while they are ahead of our
   * view in this run. Those are held: they may report on an update we do not show yet, e.g. a map change
   * still loading, whose leaveMap must skip the verdicts about the old map. Chat, rolls and token changes
   * never wait for a view.
   */
  private resultsAt(epoch: string, seq: unknown, results: unknown): void {
    if (!(this.view && epoch === this.epoch && isFiniteNum(seq) && seq > this.seq) || !Array.isArray(results)) {
      this.applyResults(results)
      return
    }
    const placed = new Set(this.pending.filter((p) => MAP_BOUND.has(p.kind)).map((p) => p.reqId))
    const held = results.filter((r) => isRecord(r) && typeof r.reqId === "string" && placed.has(r.reqId))
    if (held.length < results.length) this.applyResults(results.filter((r) => !held.includes(r)))
    if (held.length === 0) return
    this.held.push({ seq, results: held })
    if (this.held.length > MAX_HELD) this.held.shift()
  }

  /** A view at `seq` was adopted (after leaveMap): report the results that were waiting for it. */
  private releaseHeld(seq: number): void {
    const due = this.held.filter((h) => h.seq <= seq)
    if (due.length === 0) return
    this.held = this.held.filter((h) => h.seq > seq)
    for (const h of due) this.applyResults(h.results)
  }

  /**
   * The row being loaded (the newest snapshot_ready) brings (epoch, seq): no need to ask the host. A load
   * outstanding for longer than the longest hello back-off no longer counts (a fetch that never settles must
   * not keep us on the old view).
   */
  private rowBrings(epoch: unknown, seq: unknown): boolean {
    const want = this.readyWant
    return want !== null && epoch === want.epoch && isFiniteNum(seq) && seq <= want.seq && this.clock.now() - want.at <= this.t.helloRetryMaxMs
  }

  /**
   * The DM moved the game to another map: count it, and drop the requests about the old map's places
   * (moves, jumps, doors, templates) without a word; their late verdicts are skipped too. Chat, rolls,
   * initiative, turns and token changes stay pending (a snapshot then clears every overlay, as always;
   * their verdicts are still reported).
   */
  private leaveMap(): void {
    this.mapChanges++
    const stale = this.pending.filter((p) => MAP_BOUND.has(p.kind))
    if (stale.length === 0) return
    for (const p of stale) this.hostSettled.add(p.reqId)
    this.pending = this.pending.filter((p) => !MAP_BOUND.has(p.kind))
    this.armPendingTimer()
  }

  private replaceView(view: PlayerView, epoch: string, seq: number, source: "live" | "row"): void {
    if (epoch !== this.epoch) this.onEpochChange()
    // Never on the first view, nor on a resync onto the same map (host restart, snapshot_ready).
    if (this.view && isOtherMap(this.view, view)) this.leaveMap()
    // Before the overlays go, so they settle with their kind.
    this.releaseHeld(seq)
    this.view = view
    this.viewSource = source
    this.epoch = epoch
    this.seq = seq
    this.revision++
    // A snapshot supersedes every optimistic overlay.
    this.pending = []
    this.armPendingTimer()
    this.updateScene(null)
    this.syncBackdrops(view)
  }

  /** Hand a view to the compositor; a tile source that crops from the stored scene learns its map first. */
  private syncBackdrops(view: PlayerView): void {
    const map = view.scene.mapSerial ?? 0
    if (map !== this.tileMap) {
      this.tileMap = map
      this.opts.tiles.setMap?.(map)
    }
    this.compositor.sync(view)
  }

  private updateScene(change: SceneChange | "none" | null): void {
    if (change === "none" && this.scene) return
    const view = this.view
    if (!view) return
    let scene: SceneLike
    try {
      scene = buildPlayerScene(view)
    } catch (err) {
      console.error("[atlas player] cannot rebuild the scene from the view", err)
      this.error = "The map data from the DM could not be displayed"
      return
    }
    this.scene = scene
    this.sceneHistory.push({ scene, change: change === "none" ? {} : change })
    if (this.sceneHistory.length > MAX_SCENE_HISTORY) this.sceneHistory.shift()
  }

  // -------------------------------------------------------------------------
  // Rows (snapshot_ready, host offline)
  // -------------------------------------------------------------------------

  private async loadRow(): Promise<{ row: PlayerViewRow | null; view: PlayerView | null } | "failed"> {
    try {
      const row = await this.opts.repo.loadPlayerView(this.sessionId, this.userId)
      if (!row) return { row: null, view: null }
      let view = parseStoredView(row.view)
      if (!view && looksLikeView(row.view)) {
        // Written by the same trusted host as the wire snapshots (RLS: DM only), which are accepted on
        // this structural check; a schema drift must not lock the player out.
        console.warn("[atlas player] stored view failed strict validation; using it anyway")
        view = row.view
      } else if (!view) {
        console.warn("[atlas player] stored view is malformed")
      }
      return { row, view }
    } catch (err) {
      console.warn("[atlas player] loading the stored view failed", err)
      return "failed"
    }
  }

  private async loadReadyRow(epoch: string, seq: number): Promise<void> {
    // Already there (e.g. pushed because another tab of ours joined).
    if (this.epoch === epoch && this.seq >= seq && this.view && this.synced) return
    const token = ++this.readyRowToken
    // A later announcement of the same run supersedes an earlier one, never the reverse (the same one restarts
    // the wait).
    const want = this.readyWant
    if (!want || want.epoch !== epoch || want.seq <= seq) this.readyWant = { epoch, seq, at: this.clock.now() }
    const res = await this.loadRow()
    if (this.stopped || this.terminal) return
    // The newest load is over: nothing it was to bring is on its way any more.
    const newest = token === this.readyRowToken
    if (newest) this.readyWant = null
    // Something newer (a later snapshot/patch, or another row load) already arrived.
    if (this.epoch === epoch && this.seq >= seq && this.view && this.synced) return
    const row = res === "failed" ? null : res.row
    const view = res === "failed" ? null : res.view
    // What was announced: used even when a later snapshot_ready came meanwhile (on a slow link every load
    // would be thrown away), unless older than what we hold. Only the newest load moves us to another run.
    const announced = row !== null && view !== null && row.epoch === epoch && row.seq >= seq && !this.retired.has(epoch)
    const notOlder = !this.view || (epoch === this.epoch ? announced && row.seq >= this.seq : newest)
    if (announced && notOlder) {
      // Within one wire epoch a seq identifies a view: at our own seq we already hold it.
      if (!this.view || epoch !== this.epoch || row.seq > this.seq) this.replaceView(view, epoch, row.seq, "row")
      this.synced = true
    } else if (newest) {
      this.resync()
    } else {
      // A later load is on its way.
      return
    }
    this.evaluate()
    this.changed()
  }

  private enterHostOffline(): void {
    this.synced = false
    // Nobody will answer these.
    for (const p of this.pending) this.pushResult({ reqId: p.reqId, ok: false }, "host-offline", p.kind)
    if (this.pending.length) {
      this.pending = []
      this.armPendingTimer()
    }
    this.rowAttempts = 0
    void this.loadOfflineRow()
  }

  private cancelRowLoad(): void {
    if (this.rowTimer !== null) this.clock.clearTimeout(this.rowTimer)
    this.rowTimer = null
    this.offlineRowToken++
  }

  private async loadOfflineRow(): Promise<void> {
    const token = ++this.offlineRowToken
    const res = await this.loadRow()
    if (token !== this.offlineRowToken || this.stopped || this.terminal || this.computeStatus() !== "host-offline") return
    if (res === "failed") {
      const delay = this.t.rowRetryMs[this.rowAttempts++]
      if (delay !== undefined) {
        this.rowTimer = this.clock.setTimeout(() => {
          this.rowTimer = null
          void this.loadOfflineRow()
        }, delay)
      }
      return
    }
    if (!res.row) {
      // No row: maybe we were removed or the session is over.
      await this.checkMembership()
      return
    }
    if (!res.view) return
    // Never regress: our in-memory view is at least as new unless the row is ahead in the same run.
    const adopt = !this.view || (res.row.epoch === this.epoch && res.row.seq > this.seq)
    if (adopt) {
      this.replaceView(res.view, res.row.epoch, res.row.seq, "row")
      this.changed()
    }
  }

  private armMembershipCheck(): void {
    if (this.membershipTimer !== null || this.stopped || this.terminal) return
    this.membershipTimer = this.clock.setTimeout(() => {
      this.membershipTimer = null
      if (this.stopped || this.terminal || this.computeStatus() === "live") return
      void this.checkMembership().then(() => {
        if (!this.stopped && !this.terminal && this.computeStatus() !== "live") this.armMembershipCheck()
      })
    }, this.t.membershipCheckMs)
  }

  /** Detect kicked / ended / not-a-member when the channels alone cannot tell. */
  private async checkMembership(): Promise<void> {
    let info
    try {
      info = await this.opts.repo.sessionInfo(this.sessionId)
    } catch {
      return
    }
    if (this.stopped || this.terminal) return
    if (!info) {
      this.fail("You are not a member of this session")
    } else if (info.status === "ended") {
      this.enterTerminal("ended")
    } else if (info.memberStatus === "kicked") {
      this.enterTerminal("kicked")
    }
  }

  // -------------------------------------------------------------------------
  // Requests
  // -------------------------------------------------------------------------

  requestMove(tokenId: Id, path: PathStep[], end?: Vec2 | null): string {
    const reqId = this.newRequestId()
    if (!Array.isArray(path) || path.length === 0) {
      this.pushResult({ reqId, ok: false, reason: "empty-path" }, "invalid", "move")
    } else if (path.length > PROTOCOL_LIMITS.maxPathSteps + 1) {
      this.pushResult({ reqId, ok: false, reason: "path-too-long" }, "invalid", "move")
    } else {
      const copy = path.map((s) => ({ cell: { i: s.cell.i, j: s.cell.j }, levelId: s.levelId }))
      const map = this.currentMap()
      const msg: ClientToHost = end
        ? { t: "move", reqId, tokenId, path: copy, end: { x: end.x, z: end.z }, map }
        : { t: "move", reqId, tokenId, path: copy, map }
      this.submit({ reqId, kind: "move", tokenId, path: copy, sentAt: 0 }, msg)
    }
    this.changed()
    return reqId
  }

  requestJump(tokenId: Id, levelId: Id, position: Vec2): string {
    const reqId = this.newRequestId()
    this.submit({ reqId, kind: "jump", tokenId, sentAt: 0 }, { t: "jump", reqId, tokenId, levelId, x: position.x, z: position.z, map: this.currentMap() })
    this.changed()
    return reqId
  }

  requestDoor(doorId: Id, action: "open" | "close"): string {
    const reqId = this.newRequestId()
    this.submit({ reqId, kind: "door", doorId, sentAt: 0 }, { t: "door", reqId, doorId, action, map: this.currentMap() })
    this.changed()
    return reqId
  }

  requestTokenImage(tokenId: Id, imageUrl: string | null): string {
    const reqId = this.newRequestId()
    this.submit({ reqId, kind: "token-image", tokenId, sentAt: 0 }, { t: "token-image", reqId, tokenId, imageUrl })
    this.changed()
    return reqId
  }

  say(text: string, to: "all" | "dm"): string {
    const reqId = this.newRequestId()
    const t = typeof text === "string" ? text.trim() : ""
    if (!t || t.length > TABLE_LIMITS.maxText * 2) this.pushResult({ reqId, ok: false, reason: "invalid" }, "invalid", "say")
    else this.submit({ reqId, kind: "say", sentAt: 0 }, { t: "say", reqId, text: t, to })
    this.changed()
    return reqId
  }

  roll(formula: string, to: "all" | "dm"): string {
    const reqId = this.newRequestId()
    const f = typeof formula === "string" ? formula.trim() : ""
    if (!f || f.length > TABLE_LIMITS.maxFormulaInput) this.pushResult({ reqId, ok: false, reason: "bad-formula" }, "invalid", "roll")
    else this.submit({ reqId, kind: "roll", sentAt: 0 }, { t: "roll", reqId, formula: f, to })
    this.changed()
    return reqId
  }

  rollInitiative(tokenId: Id, bonus: number): string {
    const reqId = this.newRequestId()
    if (!Number.isInteger(bonus) || Math.abs(bonus) > TABLE_LIMITS.maxInitiativeBonus)
      this.pushResult({ reqId, ok: false, reason: "invalid" }, "invalid", "initiative")
    else this.submit({ reqId, kind: "initiative", tokenId, sentAt: 0 }, { t: "initiative", reqId, tokenId, bonus })
    this.changed()
    return reqId
  }

  endTurn(entryId: Id): string {
    const reqId = this.newRequestId()
    this.submit({ reqId, kind: "end-turn", sentAt: 0 }, { t: "end-turn", reqId, entryId })
    this.changed()
    return reqId
  }

  changeTokenStatus(tokenId: Id, change: TokenStatusChange): string {
    const reqId = this.newRequestId()
    const msg: Extract<ClientToHost, { t: "token-status" }> = { t: "token-status", reqId, tokenId }
    const hp = change.hp
    // Players send amounts only (damage, heal, temp); max and typed values are the DM's.
    if (hp && (hp.kind === "damage" || hp.kind === "heal" || hp.kind === "temp") && Number.isFinite(hp.amount)) {
      const amount = Math.min(HP_LIMITS.max, Math.round(hp.amount))
      if (amount >= 1) msg.hp = { kind: hp.kind, amount }
    }
    const add = (change.conditions?.add ?? []).filter(isTokenCondition)
    const remove = (change.conditions?.remove ?? []).filter(isTokenCondition)
    if (add.length > 0 || remove.length > 0) {
      msg.conditions = {}
      if (add.length > 0) msg.conditions.add = [...new Set(add)]
      if (remove.length > 0) msg.conditions.remove = [...new Set(remove)]
    }
    if (!msg.hp && !msg.conditions) this.pushResult({ reqId, ok: false, reason: "invalid" }, "invalid", "token-status")
    else this.submit({ reqId, kind: "token-status", tokenId, sentAt: 0 }, msg)
    this.changed()
    return reqId
  }

  /** Place an area of effect, or with `id` move / change one of this player's own (host: core/session/templates). */
  placeTemplate(template: AreaTemplateInput, id?: Id): string {
    const reqId = this.newRequestId()
    const msg: Extract<ClientToHost, { t: "template" }> = { t: "template", reqId, template: { ...template }, map: this.currentMap() }
    if (id !== undefined) msg.id = id
    this.submit({ reqId, kind: "template", sentAt: 0 }, msg)
    this.changed()
    return reqId
  }

  removeTemplate(id: Id): string {
    const reqId = this.newRequestId()
    this.submit({ reqId, kind: "template-remove", sentAt: 0 }, { t: "template-remove", reqId, id, map: this.currentMap() })
    this.changed()
    return reqId
  }

  ping(levelId: Id, point: Vec2): boolean {
    const ch = this.channels
    const now = this.clock.now()
    if (!ch || this.stopped || this.terminal || this.networkOffline || this.computeStatus() !== "live") return false
    if (!Number.isFinite(point.x) || !Number.isFinite(point.z) || now - this.lastPingAt < PING_GAP_MS) return false
    const level = this.view && Object.hasOwn(this.view.scene.levels, levelId) ? this.view.scene.levels[levelId] : null
    if (!level?.known) return false
    this.lastPingAt = now
    void ch.req.send({ t: "ping", levelId, x: point.x, z: point.z })
    this.emitPing({ levelId, x: point.x, z: point.z, name: "", color: "", focus: false, mine: true })
    return true
  }

  onPing(cb: (ev: PingEvent) => void): Unsubscribe {
    this.pingListeners.add(cb)
    return () => {
      this.pingListeners.delete(cb)
    }
  }

  /**
   * The map the view shows (scene.mapSerial, 0 for the first). Requests about its places name it, so the
   * host refuses them once the game is on another map (e.g. one whose view is still loading here).
   */
  private currentMap(): number {
    return this.view?.scene.mapSerial ?? 0
  }

  private newRequestId(): string {
    const reqId = this.newId()
    this.ourReqIds.add(reqId)
    this.reqOrder.push(reqId)
    if (this.reqOrder.length > MAX_REQ_IDS) {
      const old = this.reqOrder.shift() as string
      this.ourReqIds.delete(old)
      this.hostSettled.delete(old)
    }
    return reqId
  }

  /** Why a request cannot be sent right now (null = send). */
  private gate(): LocalRejectReason | null {
    if (this.stopped || this.terminal || !this.started) return "closed"
    if (this.networkOffline) return "not-connected"
    const status = this.computeStatus()
    if (status === "connecting") return "not-connected"
    if (status === "host-offline") return "host-offline"
    const now = this.clock.now()
    const windowStart = now - this.t.requestRate.windowMs
    this.sendTimes = this.sendTimes.filter((ts) => ts > windowStart)
    if (this.sendTimes.length >= this.t.requestRate.max) return "rate-limited"
    return null
  }

  private submit(p: PendingRequest, msg: Parameters<PlayerChannels["req"]["send"]>[0]): void {
    const blocked = this.gate()
    if (blocked) {
      this.pushResult({ reqId: p.reqId, ok: false, ...(blocked === "rate-limited" ? { reason: "rate-limited" as const } : {}) }, blocked, p.kind)
      return
    }
    const now = this.clock.now()
    this.sendTimes.push(now)
    p.sentAt = now
    this.pending = [...this.pending, p]
    this.armPendingTimer()
    const ch = this.channels
    if (!ch) return
    void ch.req.send(msg).then((res) => {
      if (res.ok || this.stopped) return
      if (this.settlePending(p.reqId, { reqId: p.reqId, ok: false }, res.reason === "not-joined" ? "not-connected" : "send-failed")) this.changed()
    })
  }

  private settlePending(reqId: string, result: RequestResult, local?: LocalRejectReason): boolean {
    const idx = this.pending.findIndex((p) => p.reqId === reqId)
    if (idx < 0) return false
    const kind = this.pending[idx].kind
    this.pending = this.pending.filter((_, k) => k !== idx)
    this.pushResult(result, local, kind)
    this.armPendingTimer()
    return true
  }

  private applyResults(results: unknown): void {
    if (!Array.isArray(results)) return
    for (const r of results) {
      if (!validResult(r) || !this.ourReqIds.has(r.reqId)) continue
      // The host re-sends recent results with catch-ups (a patch carrying them may have been lost).
      if (this.hostSettled.has(r.reqId)) continue
      this.hostSettled.add(r.reqId)
      const clean: RequestResult = { reqId: r.reqId, ok: r.ok }
      if (typeof r.reason === "string") clean.reason = r.reason
      if (isFiniteNum(r.applied)) clean.applied = r.applied
      if (!this.settlePending(r.reqId, clean)) this.pushResult(clean)
    }
  }

  private pushResult(result: RequestResult, local?: LocalRejectReason, kind?: PendingRequest["kind"]): void {
    const entry: ClientRequestResult = local ? { ...result, local } : { ...result }
    if (kind) entry.kind = kind
    const next = [...this.results, entry]
    this.results = next.length > this.t.maxResults ? next.slice(next.length - this.t.maxResults) : next
  }

  private armPendingTimer(): void {
    if (this.pendingTimer !== null) this.clock.clearTimeout(this.pendingTimer)
    this.pendingTimer = null
    if (this.pending.length === 0 || this.stopped) return
    const oldest = Math.min(...this.pending.map((p) => p.sentAt))
    const wait = Math.max(0, oldest + this.t.pendingTimeoutMs - this.clock.now())
    this.pendingTimer = this.clock.setTimeout(() => {
      this.pendingTimer = null
      this.expirePending()
    }, wait)
  }

  private expirePending(): void {
    if (this.stopped) return
    const now = this.clock.now()
    const expired = this.pending.filter((p) => now - p.sentAt >= this.t.pendingTimeoutMs)
    if (expired.length) {
      this.pending = this.pending.filter((p) => now - p.sentAt < this.t.pendingTimeoutMs)
      // Our own connection is down: that is not the DM's fault.
      for (const p of expired) this.pushResult({ reqId: p.reqId, ok: false }, this.networkOffline ? "not-connected" : "timeout", p.kind)
      if (!this.networkOffline) this.hostUnresponsive = true
      // Maybe we silently lost sync (a dropped patch): make sure.
      this.resync()
      this.changed()
    }
    this.armPendingTimer()
  }

  // -------------------------------------------------------------------------
  // Snapshot / subscription
  // -------------------------------------------------------------------------

  /** Invalidate the snapshot; listeners are notified once per microtask (bursts coalesce). */
  private changed(): void {
    this.snap = null
    if (this.notifyQueued) return
    this.notifyQueued = true
    queueMicrotask(() => {
      this.notifyQueued = false
      for (const cb of [...this.listeners]) {
        try {
          cb()
        } catch (err) {
          console.error("[atlas player] listener failed", err)
        }
      }
    })
  }

  getSnapshot(): PlayerClientSnapshot {
    if (!this.snap) {
      this.snap = Object.freeze({
        status: this.computeStatus(),
        error: this.error,
        sessionId: this.sessionId,
        userId: this.userId,
        view: this.view,
        scene: this.scene,
        revision: this.revision,
        epoch: this.epoch,
        seq: this.seq,
        hostOnline: this.hostOnline,
        pending: this.pending,
        results: this.results,
        hostUnresponsive: this.hostUnresponsive,
        viewSource: this.viewSource,
        networkOffline: this.networkOffline,
        mapChanges: this.mapChanges,
      })
    }
    return this.snap
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  sceneChangeSince(previous: SceneLike | null): SceneChange | null {
    if (!previous || !this.scene) return null
    if (previous === this.scene) return {}
    const idx = this.sceneHistory.findIndex((h) => h.scene === previous)
    if (idx < 0) return null
    const later = this.sceneHistory.slice(idx + 1)
    if (later.some((h) => h.change === null)) return null
    return mergeChanges(later.map((h) => h.change as SceneChange))
  }

  // -------------------------------------------------------------------------
  // Backdrops
  // -------------------------------------------------------------------------

  onBackdrop(cb: (ev: BackdropEvent) => void): Unsubscribe {
    this.backdropListeners.add(cb)
    return () => {
      this.backdropListeners.delete(cb)
    }
  }

  backdropLayers(): BackdropLayer[] {
    return this.compositor.layers()
  }

  backdropCanvas(levelId: Id): BackdropCanvas | null {
    return this.compositor.layer(levelId)?.canvas ?? null
  }

  retryBackdropTiles(): void {
    this.compositor.retryMissing()
  }

  setBackdropBudget(maxPixels: number): void {
    this.compositor.setMaxCanvasPixels(maxPixels)
  }
}

export function createAtlasPlayerClient(opts: PlayerClientRuntimeOptions): AtlasPlayerClient {
  return new PlayerClientImpl(opts)
}

/**
 * Wire a client's backdrop canvases to an engine: replays the layers that already have content, then
 * follows set/update/remove events. Returns an unsubscribe that also removes the images.
 */
export function bindBackdropsToEngine(
  client: Pick<AtlasPlayerClient, "onBackdrop" | "backdropLayers">,
  engine: Pick<Engine, "setLevelImage" | "updateLevelImage">
): () => void {
  const shown = new Set<Id>()
  for (const layer of client.backdropLayers()) {
    if (!layer.announced) continue
    engine.setLevelImage(layer.levelId, layer.canvas, layer.rect)
    shown.add(layer.levelId)
  }
  const off = client.onBackdrop((ev) => {
    if (ev.kind === "remove") {
      if (shown.delete(ev.levelId)) engine.setLevelImage(ev.levelId, null, null)
    } else if (ev.kind === "set" || !shown.has(ev.levelId)) {
      engine.setLevelImage(ev.levelId, ev.layer.canvas, ev.layer.rect)
      shown.add(ev.levelId)
    } else {
      // One region per touched chunk: a box around distant cells would re-upload everything between.
      engine.updateLevelImage(ev.levelId, ev.dirtyRects)
    }
  })
  return () => {
    off()
    for (const levelId of shown) engine.setLevelImage(levelId, null, null)
    shown.clear()
  }
}
