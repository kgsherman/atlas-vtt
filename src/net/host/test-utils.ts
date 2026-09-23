/**
 * Test harness for net/host: a local session (in-memory LocalStore, LocalSessionsRepo, LocalTransport
 * over Node's BroadcastChannel), a host runner with an in-thread vision client, and "mirror" players
 * that implement the client sync rules of ARCHITECTURE §6.3 (apply a patch iff epoch and baseSeq
 * match, else hello; snapshot_ready → reload the player_views row).
 *
 * Test-only (imported by *.test.ts).
 */
import type { PathStep } from "@/core/movement/types"
import type { Id, Scene } from "@/core/scene/types"
import { applyPatchOps } from "@/core/session"
import type { ClientToHost, HostBroadcast, HostToClient, PlayerView, RequestResult } from "@/core/session/types"
import { decodeMask, getCell } from "@/core/vision/mask"

import type { AssetStore } from "../assets/types"
import type { AtlasIdentity } from "../auth"
import { createMemoryStore, type LocalStore } from "../localStore"
import { LocalTransport } from "../localTransport"
import { createLocalScenesRepo } from "../scenesRepo"
import { createLocalSessionsRepo, type SessionsRepo } from "../sessionsRepo"
import type { PlayerChannels, Transport } from "../transport"
import { createHostRunner } from "./index"
import type { CreateHostRunnerOptions } from "./hostRunner"
import { createInThreadVisionClient, type WorkerLike } from "./visionClient"
import { resultTransferables, VisionWorkerCore, type VisionRequest } from "./visionProtocol"

export const DM = "d0000000-0000-4000-8000-00000000000d"
export const P1 = "a1000000-0000-4000-8000-000000000001"
export const P2 = "a2000000-0000-4000-8000-000000000002"
export const P3 = "a3000000-0000-4000-8000-000000000003"

/** An in-process "worker": messages are structured-cloned and answered asynchronously, in order. */
export class FakeWorker implements WorkerLike {
  private readonly core = new VisionWorkerCore()
  private readonly listeners = new Map<string, Set<(ev: Event) => void>>()
  terminated = false
  posted = 0
  bytes = 0

  postMessage(message: unknown): void {
    if (this.terminated) return
    this.posted++
    this.bytes += JSON.stringify(message).length
    const req = structuredClone(message) as VisionRequest
    setTimeout(() => {
      if (this.terminated) return
      const res = this.core.handle(req)
      const transfer = res.ok && res.result ? resultTransferables(res.result) : []
      const data = structuredClone(res, { transfer })
      this.emit("message", { data } as unknown as Event)
    }, 0)
  }

  addEventListener(type: string, listener: (ev: Event) => void): void {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(listener)
  }

  removeEventListener(type: string, listener: (ev: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  terminate(): void {
    this.terminated = true
  }

  emit(type: string, ev: Event): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l(ev)
  }
}

export async function waitFor(predicate: () => boolean, what = "condition", timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** An AssetStore that records calls (no pixels). */
/**
 * An AssetStore recording the host's tile chunk uploads (`chunks`: "uid|levelId|ci,cj" → encoded
 * blob text) and removals; `delayMs` slows every upload down.
 */
export function recordingAssets(mode: "supabase" | "local" = "local", opts: { delayMs?: number } = {}) {
  const chunks = new Map<string, string>()
  const uploads: string[] = []
  const removed: string[] = []
  let sessionsCleaned = 0
  const store: AssetStore = {
    mode,
    putImage: async () => {
      throw new Error("not used by the host")
    },
    getImage: async () => new Blob(["image"]),
    deleteImage: async () => {},
    copyImages: async () => {},
    putTileChunk: async (_sid, uid, levelId, ci, cj, blob) => {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
      const key = `${uid}|${levelId}|${ci},${cj}`
      chunks.set(key, await blob.text())
      uploads.push(key)
    },
    deleteTileChunks: async (_sid, uid, levelId, list) => {
      for (const c of list) {
        const key = `${uid}|${levelId}|${c.ci},${c.cj}`
        chunks.delete(key)
        removed.push(key)
      }
    },
    removeSessionTiles: async () => {
      sessionsCleaned++
      const n = chunks.size
      chunks.clear()
      return n
    },
    publishTiles: async () => {
      throw new Error("the host uploads per-player chunks")
    },
    grantTiles: async () => {
      throw new Error("the host uploads per-player chunks")
    },
  }
  return { store, chunks, uploads, removed, cleaned: () => sessionsCleaned }
}

export interface MirrorOptions {
  /** Called with every accepted view (after it is applied). */
  onView?: (view: PlayerView, msg: HostToClient) => void
}

/** A player that follows the client sync rules and records everything it receives. */
export class Mirror {
  readonly ch: PlayerChannels
  view: PlayerView | null = null
  epoch: string | null = null
  seq = 0
  /** JSON of every message received on view:{uid} (for leak checks). */
  readonly raw: string[] = []
  readonly messages: HostToClient[] = []
  readonly results: RequestResult[] = []
  readonly broadcasts: HostBroadcast[] = []
  kicked = false
  hellos = 0
  /** Announced backdrop chunks: levelId → "ci,cj" → cell mask. */
  readonly tiles = new Map<Id, Map<string, number>>()
  /** Test hook: ignore the next N patches (simulated loss). */
  dropPatches = 0
  applyErrors: string[] = []
  private nonce = ""
  private reqCounter = 0
  private readonly sessionId: string
  private readonly userId: string
  private readonly repo: Pick<SessionsRepo, "loadPlayerView">
  private readonly opts: MirrorOptions

  constructor(transport: Transport, sessionId: string, userId: string, repo: Pick<SessionsRepo, "loadPlayerView">, opts: MirrorOptions = {}) {
    this.sessionId = sessionId
    this.userId = userId
    this.repo = repo
    this.opts = opts
    this.ch = transport.openPlayerChannels(sessionId, userId, { displayName: userId.slice(0, 8) })
    this.ch.view.onMessage((m) => void this.onMessage(m))
    this.ch.host.onBroadcast((m) => this.broadcasts.push(m))
    this.ch.onReady(() => void this.hello())
  }

  async hello(): Promise<void> {
    this.hellos++
    this.nonce = `n${this.hellos}-${Math.random().toString(36).slice(2, 10)}`
    await this.ch.req.send({ t: "hello", nonce: this.nonce, epoch: this.epoch, lastSeq: this.view ? this.seq : null })
  }

  private accept(view: PlayerView, epoch: string, seq: number, msg: HostToClient): void {
    this.view = view
    this.epoch = epoch
    this.seq = seq
    this.opts.onView?.(view, msg)
  }

  private async onMessage(m: HostToClient): Promise<void> {
    this.raw.push(JSON.stringify(m))
    this.messages.push(m)
    if ((m.t === "snapshot" || m.t === "patch") && m.results) this.results.push(...m.results)
    switch (m.t) {
      case "snapshot":
        if (m.nonce !== undefined && m.nonce !== this.nonce) return
        this.accept(m.view, m.epoch, m.seq, m)
        return
      case "snapshot_ready": {
        if (m.nonce !== undefined && m.nonce !== this.nonce) return
        const row = await this.repo.loadPlayerView(this.sessionId, this.userId)
        this.raw.push(JSON.stringify(row?.view ?? null))
        if (row && row.epoch === m.epoch && row.seq >= m.seq) this.accept(row.view, row.epoch, row.seq, m)
        else void this.hello()
        return
      }
      case "patch": {
        if (m.nonce !== undefined && m.nonce !== this.nonce) return
        if (this.dropPatches > 0) {
          this.dropPatches--
          return
        }
        if (this.view && m.epoch === this.epoch && m.baseSeq === this.seq) {
          try {
            this.accept(applyPatchOps(this.view, m.ops), m.epoch, m.seq, m)
          } catch (err) {
            this.applyErrors.push(String(err))
            void this.hello()
          }
        } else {
          void this.hello()
        }
        return
      }
      case "sync":
        if (m.epoch !== this.epoch || m.seq !== this.seq) void this.hello()
        return
      case "result":
        this.results.push(m.result)
        return
      case "tiles": {
        let level = this.tiles.get(m.levelId)
        if (!level || m.reset) this.tiles.set(m.levelId, (level = new Map()))
        for (const [ci, cj, mask] of m.chunks) level.set(`${ci},${cj}`, mask)
        return
      }
      case "kicked":
        this.kicked = true
        return
    }
  }

  /** Whether an announced chunk holds cell (i, j) of a level. */
  hasTile(levelId: Id, i: number, j: number): boolean {
    const mask = this.tiles.get(levelId)?.get(`${Math.floor(i / 4)},${Math.floor(j / 4)}`) ?? 0
    return (mask & (1 << ((j % 4) * 4 + (i % 4)))) !== 0
  }

  private nextReq(): string {
    return `${this.userId.slice(0, 2)}-r${++this.reqCounter}`
  }

  async send(msg: ClientToHost): Promise<void> {
    await this.ch.req.send(msg)
  }

  move(tokenId: Id, path: PathStep[]): string {
    const reqId = this.nextReq()
    void this.send({ t: "move", reqId, tokenId, path })
    return reqId
  }

  door(doorId: Id, action: "open" | "close"): string {
    const reqId = this.nextReq()
    void this.send({ t: "door", reqId, doorId, action })
    return reqId
  }

  result(reqId: string): RequestResult | undefined {
    return this.results.find((r) => r.reqId === reqId)
  }

  /** Whether a cell is explored on a level in the current view. */
  explored(levelId: Id, i: number, j: number): boolean {
    const m = this.view?.masks[levelId]?.explored
    if (!m) return false
    return getCell(decodeMask(m), j * m.width + i)
  }

  async close(): Promise<void> {
    await this.ch.close()
  }
}

export interface SessionFixture {
  store: LocalStore
  sessionId: string
  roomCode: string
  dmRepo: SessionsRepo
  repoOf(uid: string): SessionsRepo
  namespace: string
  newTransport(): LocalTransport
  identity: AtlasIdentity
  transports: LocalTransport[]
  dispose(): Promise<void>
}

/** A session for `scene` with the given players joined (local repositories, shared store). */
export async function createSessionFixture(scene: Scene, players: string[]): Promise<SessionFixture> {
  const store = createMemoryStore()
  const dmRepo = createLocalSessionsRepo({ store, userId: () => DM })
  const scenes = createLocalScenesRepo(store)
  const summary = await scenes.create(scene)
  const { sessionId, roomCode } = await dmRepo.createSession(summary.id)
  const repos = new Map<string, SessionsRepo>()
  for (const uid of players) {
    const repo = createLocalSessionsRepo({ store, userId: () => uid })
    await repo.joinSession(roomCode, `Player ${uid.slice(0, 2)}`)
    repos.set(uid, repo)
  }
  const namespace = `atlas-host-test-${crypto.randomUUID()}`
  const transports: LocalTransport[] = []
  return {
    store,
    sessionId,
    roomCode,
    dmRepo,
    repoOf: (uid) => {
      let r = repos.get(uid)
      if (!r) repos.set(uid, (r = createLocalSessionsRepo({ store, userId: () => uid })))
      return r
    },
    namespace,
    newTransport: () => {
      const t = new LocalTransport({ namespace, rate: null, presenceHeartbeatMs: 1000, presenceTimeoutMs: 3000 })
      transports.push(t)
      return t
    },
    identity: { userId: DM, isAnonymous: true, displayName: "DM", mode: "local" },
    transports,
    dispose: async () => {
      await Promise.all(transports.splice(0).map((t) => t.dispose()))
    },
  }
}

/** Fast timings for tests. */
export const TEST_TIMING = {
  flushIntervalMs: 10,
  idleSyncMs: 60_000,
  saveIntervalMs: 50,
  urgentSaveGapMs: 10,
  viewSaveIntervalMs: 50,
  memberPollMs: 60_000,
  lobbyDebounceMs: 20,
}

export function startHost(fx: SessionFixture, extra: Partial<CreateHostRunnerOptions> = {}) {
  const logs: string[] = []
  const host = createHostRunner({
    sessionId: fx.sessionId,
    transport: fx.newTransport(),
    repo: fx.dmRepo,
    identity: fx.identity,
    assets: recordingAssets().store,
    createVisionClient: createInThreadVisionClient,
    locks: null,
    tileCodec: null,
    timing: TEST_TIMING,
    watchVisibility: false,
    log: (msg, err) => logs.push(err === undefined ? msg : `${msg}: ${String(err)}`),
    ...extra,
  })
  return { host, logs }
}
