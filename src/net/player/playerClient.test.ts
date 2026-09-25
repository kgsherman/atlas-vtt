import { afterEach, describe, expect, it, vi } from "vitest"

import { createScene, createWall } from "@/core/scene/factory"
import { createHeightmap, sampleCounts, writeHeights } from "@/core/scene/heightmap"
import type { Scene } from "@/core/scene/types"
import { diffViews } from "@/core/session/diff"
import { add, addToken, flatScene, TestHost } from "@/core/session/test-utils"
import { parseClientMessage } from "@/core/session/protocol"
import type { ClientToHost, HostToClient, PlayerView, PlayerWall, RequestResult } from "@/core/session/types"

import type { AtlasIdentity } from "../auth"
import { HELLO_RATE, RequestLimiter } from "../host/flush"
import { createMemoryStore } from "../localStore"
import { LocalTransport, type BroadcastChannelLike } from "../localTransport"
import { createLocalScenesRepo } from "../scenesRepo"
import { createLocalSessionsRepo, type PlayerViewRow, type SessionsRepo } from "../sessionsRepo"
import type { BackdropCanvas } from "./backdropCanvas"
import { FakeHost } from "./fakeHost"
import { createPlayerClient } from "./index"
import {
  bindBackdropsToEngine,
  buildPlayerScene,
  describeRequestResult,
  isOtherMap,
  looksLikeView,
  parseStoredView,
  pendingMovesOverlay,
  sceneChangeFromOps,
  type PlayerClientRuntimeOptions,
  type PlayerClientTimings,
} from "./playerClient"

const SID = "5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const DM = "d0000000-0000-4000-8000-000000000001"
const P1 = "a1000000-0000-4000-8000-000000000001"

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const FAST: Partial<PlayerClientTimings> = {
  pendingTimeoutMs: 300,
  helloRetryMs: 150,
  helloRetryMaxMs: 300,
  hostPresenceGraceMs: 120,
  rowRetryMs: [40, 80],
  membershipCheckMs: 150,
}

const identity: AtlasIdentity = { userId: P1, isAnonymous: true, displayName: "Alice", mode: "local" }

/** Transports that share one BroadcastChannel namespace (like tabs of one browser). */
function tabs() {
  const namespace = `atlas-player-test-${crypto.randomUUID()}`
  return (extra: ConstructorParameters<typeof LocalTransport>[0] = {}) => {
    const t = new LocalTransport({ namespace, rate: null, presenceHeartbeatMs: 50, presenceTimeoutMs: 400, ...extra })
    cleanups.push(() => t.dispose())
    return t
  }
}

async function waitFor(predicate: () => boolean, what = "condition", timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fakeCanvas(width: number, height: number): BackdropCanvas {
  const ctx = { clearRect() {}, drawImage() {}, imageSmoothingEnabled: true, imageSmoothingQuality: "low" }
  return { width, height, getContext: () => ctx } as unknown as BackdropCanvas
}

function stubRepo(overrides: Partial<SessionsRepo> = {}): SessionsRepo {
  return {
    storage: "local",
    loadPlayerView: async () => null,
    sessionInfo: async () => ({
      sessionId: SID,
      status: "active",
      roomCode: "ABCD1234",
      role: "player",
      memberStatus: "active",
      displayName: "Alice",
      dmDisplayName: null,
      createdAt: new Date().toISOString(),
    }),
    ...overrides,
  } as unknown as SessionsRepo
}

function stubTiles() {
  return { getTile: vi.fn(async () => null as ImageBitmap | null), dispose: vi.fn() }
}

function makeClient(transport: LocalTransport, opts: Partial<PlayerClientRuntimeOptions> = {}) {
  const client = createPlayerClient({
    sessionId: SID,
    transport,
    repo: stubRepo(),
    identity,
    tiles: stubTiles(),
    timings: FAST,
    backdrop: { createCanvas: fakeCanvas },
    ...opts,
  })
  cleanups.push(() => client.stop())
  return client
}

/** A lit 8×8 room with one PC token owned by P1. */
function world() {
  const { scene, ground } = flatScene(8, 8, "bright")
  const token = addToken(scene, ground, 12.5, 12.5)
  const sim = new TestHost(scene, [P1])
  sim.assign(token.id, P1)
  return { scene, ground, token, sim }
}

/** Host channels driven by the test (scripted replies). */
function rawHost(t: LocalTransport, epoch = "e1") {
  const ch = t.openHostChannels(SID, epoch, { userId: DM })
  const link = ch.openPlayer(P1)
  const requests: ClientToHost[] = []
  link.onRequest((raw) => requests.push(raw as ClientToHost))
  cleanups.push(() => ch.close())
  const hellos = () => requests.filter((r): r is Extract<ClientToHost, { t: "hello" }> => r.t === "hello")
  return { ch, link, requests, hellos, send: (msg: HostToClient) => link.send(msg) }
}

function fakeHost(t: LocalTransport, sim: TestHost, extra: Partial<ConstructorParameters<typeof FakeHost>[0]> = {}) {
  const host = new FakeHost({ transport: t, sessionId: SID, sim, dmUserId: DM, ...extra })
  cleanups.push(() => host.stop())
  host.start()
  return host
}

// ---------------------------------------------------------------------------

describe("PlayerClient: joining", () => {
  it("joins view before req, then says hello without an epoch", async () => {
    const newTab = tabs()
    const opened: string[] = []
    const hostT = newTab()
    const playerT = newTab({
      createChannel: (name) => {
        opened.push(name.slice(name.indexOf(":session:") + 1))
        return new BroadcastChannel(name) as BroadcastChannelLike
      },
    })
    const host = rawHost(hostT)
    const client = makeClient(playerT)
    expect(client.getSnapshot().status).toBe("connecting")
    await client.start()
    await waitFor(() => host.hellos().length === 1, "hello")
    const hello = host.hellos()[0]
    expect(hello).toEqual({ t: "hello", nonce: expect.any(String), epoch: null, lastSeq: null })
    const view = opened.findIndex((t) => t.endsWith(`:view:${P1}`))
    const req = opened.findIndex((t) => t.endsWith(`:req:${P1}`))
    expect(view).toBeGreaterThanOrEqual(0)
    expect(req).toBeGreaterThan(view)
    await waitFor(() => client.getSnapshot().hostOnline, "host presence")
    expect(client.getSnapshot().status).toBe("syncing")
  })

  it("goes live on the snapshot answering our hello and memoises the scene", async () => {
    const newTab = tabs()
    const { sim, token } = world()
    const host = fakeHost(newTab(), sim)
    const client = makeClient(newTab())
    let notified = 0
    // Unbound, the way useSyncExternalStore calls them.
    const { subscribe, getSnapshot, start } = client
    subscribe(() => notified++)
    expect(getSnapshot().status).toBe("connecting")
    await start()
    await waitFor(() => client.getSnapshot().status === "live", "live")
    const snap = client.getSnapshot()
    expect(snap.epoch).toBe(host.epoch)
    expect(snap.view).toEqual(host.lastView(P1))
    expect(snap.scene?.tokens[token.id]).toBeTruthy()
    expect(snap.viewSource).toBe("live")
    expect(snap.revision).toBeGreaterThan(0)
    expect(notified).toBeGreaterThan(0)
    // getSnapshot is stable between changes (useSyncExternalStore).
    expect(client.getSnapshot()).toBe(snap)
  })

  it("ignores replies to another tab's hello", async () => {
    const newTab = tabs()
    const { sim } = world()
    const host = rawHost(newTab())
    const client = makeClient(newTab())
    await client.start()
    await waitFor(() => host.hellos().length === 1, "hello")
    const view = sim.refresh(P1).view
    await host.send({ t: "snapshot", epoch: "e1", seq: 4, view, nonce: "someone-elses-nonce" })
    await host.send({ t: "result", epoch: "e1", seq: 4, result: { reqId: "not-mine", ok: false, reason: "blocked" } })
    await sleep(40)
    expect(client.getSnapshot().view).toBeNull()
    expect(client.getSnapshot().results).toEqual([])
    await host.send({ t: "snapshot", epoch: "e1", seq: 4, view, nonce: host.hellos()[0].nonce })
    await waitFor(() => client.getSnapshot().view !== null, "own snapshot")
    expect(client.getSnapshot()).toMatchObject({ epoch: "e1", seq: 4, status: "live" })
  })
})

describe("PlayerClient: sequencing", () => {
  it("applies in-order patches, reports scene changes and catches up after a gap", async () => {
    const newTab = tabs()
    const { sim, token, ground } = world()
    const host = fakeHost(newTab(), sim)
    const client = makeClient(newTab())
    await client.start()
    await waitFor(() => client.getSnapshot().status === "live", "live")
    const before = client.getSnapshot()

    sim.dm({ t: "move-token", tokenId: token.id, levelId: ground, x: 17.5, z: 12.5 })
    await host.flush(P1)
    await waitFor(() => client.getSnapshot().seq === before.seq + 1, "patch applied")
    const after = client.getSnapshot()
    expect(after.scene?.tokens[token.id].position).toEqual({ x: 17.5, z: 12.5 })
    expect(after.scene).not.toBe(before.scene)
    expect(client.sceneChangeSince(before.scene)?.tokens).toContain(token.id)
    expect(client.sceneChangeSince(after.scene)).toEqual({})
    expect(client.sceneChangeSince(null)).toBeNull()

    // Lose the next patch on the wire.
    const send = host.send.bind(host)
    let drop = 1
    host.send = async (uid, msg) => {
      if (msg.t === "patch" && drop > 0) {
        drop--
        return { ok: true }
      }
      return send(uid, msg)
    }
    const hellosBefore = host.received.filter((r) => r.msg.t === "hello").length
    sim.dm({ t: "move-token", tokenId: token.id, levelId: ground, x: 22.5, z: 12.5 })
    await host.flush(P1)
    sim.dm({ t: "move-token", tokenId: token.id, levelId: ground, x: 22.5, z: 17.5 })
    await host.flush(P1)
    await waitFor(() => client.getSnapshot().seq === host.currentSeq(P1), "caught up")
    const hellos = host.received.filter((r) => r.msg.t === "hello").map((r) => r.msg)
    expect(hellos.length).toBe(hellosBefore + 1)
    expect(hellos.at(-1)).toMatchObject({ epoch: host.epoch, lastSeq: after.seq })
    expect(client.getSnapshot().view).toEqual(host.lastView(P1))
    expect(client.getSnapshot().scene?.tokens[token.id].position).toEqual({ x: 22.5, z: 17.5 })
  })

  it("answers sync: quiet when in step, hello when behind", async () => {
    const newTab = tabs()
    const { sim } = world()
    const host = rawHost(newTab())
    const client = makeClient(newTab())
    await client.start()
    await waitFor(() => host.hellos().length === 1, "hello")
    await host.send({ t: "snapshot", epoch: "e1", seq: 2, view: sim.refresh(P1).view, nonce: host.hellos()[0].nonce })
    await waitFor(() => client.getSnapshot().status === "live", "live")
    await host.send({ t: "sync", epoch: "e1", seq: 2 })
    await sleep(40)
    expect(host.hellos().length).toBe(1)
    await host.send({ t: "sync", epoch: "e1", seq: 3 })
    await waitFor(() => host.hellos().length === 2, "hello after newer sync")
    expect(host.hellos()[1]).toMatchObject({ epoch: "e1", lastSeq: 2 })
    expect(client.getSnapshot().status).toBe("syncing")
    await host.send({ t: "sync", epoch: "e1", seq: 2 })
    await waitFor(() => client.getSnapshot().status === "live", "live again")
  })

  it("ignores retired epochs for good and resyncs on unknown ones", async () => {
    const newTab = tabs()
    const { sim, token, ground } = world()
    const host = rawHost(newTab())
    const client = makeClient(newTab())
    await client.start()
    await waitFor(() => host.hellos().length === 1, "hello")
    const v0 = sim.refresh(P1).view
    await host.send({ t: "snapshot", epoch: "e1", seq: 1, view: v0, nonce: host.hellos()[0].nonce })
    await waitFor(() => client.getSnapshot().epoch === "e1", "e1")

    // A newer host announces itself: e1 is retired, we ask the newcomer.
    await host.ch.host.broadcast({ t: "status", epoch: "e2", sceneName: "Keep" })
    await waitFor(() => host.hellos().length === 2, "hello to the new host")
    await host.send({ t: "snapshot", epoch: "e2", seq: 0, view: v0, nonce: host.hellos()[1].nonce })
    await waitFor(() => client.getSnapshot().epoch === "e2", "e2")

    // The stale host keeps talking: ignored, no hello.
    sim.dm({ t: "move-token", tokenId: token.id, levelId: ground, x: 17.5, z: 12.5 })
    const { ops } = sim.refresh(P1)
    await host.send({ t: "patch", epoch: "e1", baseSeq: 1, seq: 2, ops })
    await host.send({ t: "snapshot", epoch: "e1", seq: 2, view: sim.refresh(P1).view })
    await sleep(40)
    expect(client.getSnapshot()).toMatchObject({ epoch: "e2", seq: 0 })
    expect(host.hellos().length).toBe(2)

    // An epoch we have never seen is a new host run: its patch cannot apply → hello.
    await host.send({ t: "patch", epoch: "e3", baseSeq: 5, seq: 6, ops })
    await waitFor(() => host.hellos().length === 3, "hello for unknown epoch")
    expect(host.hellos()[2]).toMatchObject({ epoch: "e2", lastSeq: 0 })
  })

  it("ignores stale-epoch and out-of-order patches without applying them", async () => {
    const newTab = tabs()
    const { sim, token, ground } = world()
    const host = rawHost(newTab())
    const client = makeClient(newTab())
    await client.start()
    await waitFor(() => host.hellos().length === 1, "hello")
    const v0 = sim.refresh(P1).view
    await host.send({ t: "snapshot", epoch: "e1", seq: 3, view: v0, nonce: host.hellos()[0].nonce })
    await waitFor(() => client.getSnapshot().seq === 3, "seq 3")
    sim.dm({ t: "move-token", tokenId: token.id, levelId: ground, x: 17.5, z: 12.5 })
    const { ops } = sim.refresh(P1)
    // Old epoch with a matching baseSeq must not apply.
    await host.send({ t: "patch", epoch: "e0", baseSeq: 3, seq: 4, ops })
    // Duplicate of something we already have: ignored quietly.
    await host.send({ t: "patch", epoch: "e1", baseSeq: 2, seq: 3, ops })
    await waitFor(() => host.hellos().length === 2, "hello for the foreign epoch")
    await sleep(40)
    expect(client.getSnapshot().seq).toBe(3)
    expect(client.getSnapshot().scene?.tokens[token.id].position).toEqual({ x: 12.5, z: 12.5 })
    expect(host.hellos().length).toBe(2)
    // The right one applies.
    await host.send({ t: "patch", epoch: "e1", baseSeq: 3, seq: 4, ops })
    await waitFor(() => client.getSnapshot().seq === 4, "applied")
    expect(client.getSnapshot().scene?.tokens[token.id].position).toEqual({ x: 17.5, z: 12.5 })
  })
})

describe("PlayerClient: stored views", () => {
  async function sessionWithMember() {
    const store = createMemoryStore()
    let as = DM
    const repo = createLocalSessionsRepo({ store, userId: () => as })
    const scenes = createLocalScenesRepo(store)
    const scene: Scene = createScene({ name: "Vineyard", width: 8, depth: 8 })
    const summary = await scenes.create(scene)
    const { sessionId: realSid, roomCode } = await repo.createSession(summary.id)
    as = P1
    await repo.joinSession(roomCode, "Alice")
    as = DM
    const hostEpoch = await repo.claimHost(realSid)
    // The client reads as P1; the DM writes as DM.
    const playerRepo = createLocalSessionsRepo({ store, userId: () => P1 })
    return { repo, playerRepo, realSid, hostEpoch, kick: () => repo.setMemberStatus(realSid, P1, "kicked") }
  }

  function withBackdrop(view: PlayerView): PlayerView {
    const levelId = Object.keys(view.scene.levels)[0]
    return { ...view, backdrops: { [levelId]: { rect: { x: 0, z: 0, w: 40, d: 40 }, opacity: 1, tintWalls: false, tilePx: 140 } } }
  }

  it("parses stored views strictly and re-attaches valid backdrops", () => {
    const { sim } = world()
    const view = withBackdrop(sim.refresh(P1).view)
    expect(parseStoredView(JSON.parse(JSON.stringify(view)))).toEqual(view)
    expect(parseStoredView({ ...view, extra: 1 })).toBeNull()
    expect(parseStoredView({ ...view, backdrops: { x: { rect: { x: 0, z: 0, w: -1, d: 1 }, opacity: 1, tintWalls: false, tilePx: 140 } } })).toBeNull()
  })

  it("accepts views stored before walls had followTerrain (they follow the terrain) and walls with a terrain profile", () => {
    const { scene, ground } = flatScene(8, 8, "bright")
    const { samplesX, samplesZ } = sampleCounts(scene.grid, 2)
    const dense = new Float32Array(samplesX * samplesZ)
    for (let j = 0; j < samplesZ; j++) for (let i = 0; i < samplesX; i++) dense[j * samplesX + i] = 0.25 * i
    scene.levels[ground] = { ...scene.levels[ground], heightmap: writeHeights(createHeightmap(2), scene.grid, dense) }
    const wall = add(scene, createWall(ground, { x: 0, z: 20 }, { x: 40, z: 20 }))
    const token = addToken(scene, ground, 12.5, 12.5)
    const sim = new TestHost(scene, [P1])
    sim.assign(token.id, P1)
    const view = sim.refresh(P1).view
    const pieces = Object.values(view.objects).filter((o): o is PlayerWall => o.type === "wall" && o.id.startsWith(`${wall.id}@`))
    expect(pieces.length).toBeGreaterThan(0)
    // Current views: the profile travels and reaches the rebuilt scene.
    expect(parseStoredView(JSON.parse(JSON.stringify(view)))).toEqual(view)
    for (const p of pieces) {
      expect(p.terrainProfile?.length).toBeGreaterThanOrEqual(2)
      expect(buildPlayerScene(view).objects[p.id]).toMatchObject({ followTerrain: true, terrainProfile: p.terrainProfile })
    }
    // A row written by an older host: no followTerrain, no profile.
    const old = JSON.parse(JSON.stringify(view)) as PlayerView
    for (const p of pieces) {
      delete (old.objects[p.id] as Partial<PlayerWall>).followTerrain
      delete (old.objects[p.id] as Partial<PlayerWall>).terrainProfile
    }
    expect(looksLikeView(old)).toBe(true)
    const parsed = parseStoredView(old)!
    for (const p of pieces) {
      expect(parsed.objects[p.id]).toMatchObject({ followTerrain: true })
      expect(parsed.objects[p.id]).not.toHaveProperty("terrainProfile")
      // Even unparsed (the structural fallback), the rebuilt wall follows the terrain.
      expect(buildPlayerScene(old).objects[p.id]).toMatchObject({ type: "wall", followTerrain: true })
    }
  })

  it("loads the row on snapshot_ready; accepts only the announced epoch with seq ≥", async () => {
    const newTab = tabs()
    const { sim } = world()
    const { repo, playerRepo, realSid, hostEpoch } = await sessionWithMember()
    const view = withBackdrop(sim.refresh(P1).view)
    await repo.upsertPlayerView({ sessionId: realSid, userId: P1, hostEpoch, epoch: "e1", seq: 3, view })
    const hostT = newTab()
    const ch = hostT.openHostChannels(realSid, "e1", { userId: DM })
    cleanups.push(() => ch.close())
    const link = ch.openPlayer(P1)
    const hellos: ClientToHost[] = []
    link.onRequest((raw) => hellos.push(raw as ClientToHost))
    const client = createPlayerClient({
      sessionId: realSid,
      transport: newTab(),
      repo: playerRepo,
      identity,
      tiles: stubTiles(),
      timings: FAST,
      backdrop: { createCanvas: fakeCanvas },
    })
    cleanups.push(() => client.stop())
    await client.start()
    await waitFor(() => hellos.length === 1, "hello")

    await link.send({ t: "snapshot_ready", epoch: "e1", seq: 3, nonce: (hellos[0] as { nonce: string }).nonce })
    await waitFor(() => client.getSnapshot().view !== null, "row loaded")
    expect(client.getSnapshot()).toMatchObject({ epoch: "e1", seq: 3, viewSource: "row", status: "live" })
    expect(client.getSnapshot().view?.backdrops).toEqual(view.backdrops)

    // The announced version is newer than the row: ask again instead of accepting stale data.
    await link.send({ t: "snapshot_ready", epoch: "e1", seq: 5 })
    await waitFor(() => hellos.length === 2, "hello after a stale row")
    expect(hellos[1]).toMatchObject({ t: "hello", epoch: "e1", lastSeq: 3 })
    expect(client.getSnapshot().seq).toBe(3)
    // Wrong epoch in the row: also rejected.
    await link.send({ t: "snapshot_ready", epoch: "e9", seq: 0 })
    await waitFor(() => hellos.length === 3, "hello after a foreign-epoch row")
    expect(client.getSnapshot().epoch).toBe("e1")
  })

  it("gets onto a new map sent through the database even when row loads are slow and the host limits hellos", async () => {
    const newTab = tabs()
    const w = world()
    const host = rawHost(newTab())
    // Like HostRunner: hellos over HELLO_RATE are dropped; an answer after the map change goes through the
    // database (snapshot_ready), followed by the remembered results as `result` messages at the new seq.
    const limiter = new RequestLimiter(HELLO_RATE, () => Date.now())
    const remembered: RequestResult[] = []
    const first = w.sim.refresh(P1).view
    let hostSeq = 1
    let viaDatabase = false
    host.link.onRequest((raw) => {
      const r = raw as ClientToHost
      if (r.t === "say") remembered.push({ reqId: r.reqId, ok: true })
      if (r.t !== "hello" || !limiter.tryTake()) return
      void (async () => {
        await sleep(100)
        if (!viaDatabase) {
          await host.send({ t: "snapshot", epoch: "e1", seq: hostSeq, view: first, nonce: r.nonce })
          return
        }
        await host.send({ t: "snapshot_ready", epoch: "e1", seq: hostSeq, nonce: r.nonce })
        for (const result of remembered) await host.send({ t: "result", epoch: "e1", seq: hostSeq, result })
      })()
    })
    let row: PlayerViewRow | null = null
    let loads = 0
    const client = makeClient(newTab(), {
      // A large row over a slow link: longer than the hello retry (2.5 s).
      repo: stubRepo({
        loadPlayerView: async () => {
          loads++
          await sleep(3000)
          return row
        },
      }),
      timings: { hostPresenceGraceMs: 120 },
    })
    await client.start()
    await waitFor(() => client.getSnapshot().status === "live", "live")
    const hellos = host.hellos().length

    const said = client.say("Coming!", "all")
    await waitFor(() => remembered.length === 1, "chat line at the host")
    const crypt = structuredClone(w.scene)
    crypt.id = "crypt"
    w.sim.dm({ t: "load-scene", scene: crypt, carried: { [w.token.id]: w.token.id } })
    row = { sessionId: SID, userId: P1, hostEpoch: 1, epoch: "e1", seq: 2, view: w.sim.refresh(P1).view, updatedAt: "" }
    hostSeq = 2
    viaDatabase = true
    await host.send({ t: "snapshot_ready", epoch: "e1", seq: 2 })
    await host.send({ t: "result", epoch: "e1", seq: 2, result: { reqId: said, ok: true } })

    await waitFor(() => client.getSnapshot().mapChanges === 1, "on the new map", 7000)
    expect(client.getSnapshot()).toMatchObject({ status: "live", epoch: "e1", seq: 2, viewSource: "row" })
    expect(client.getSnapshot().results).toEqual([{ reqId: said, ok: true, kind: "say" }])
    // The verdict at the new seq was the row's to bring: no hello, one row load.
    expect(host.hellos()).toHaveLength(hellos)
    expect(loads).toBe(1)
  }, 15_000)

  /** A player live on the keep whose host answers hellos with snapshot_ready once the map changed (as HostRunner does for large views). */
  async function viaDatabase(loadMs: (n: number) => number, timings: Partial<PlayerClientTimings>) {
    const newTab = tabs()
    const w = world()
    const host = rawHost(newTab())
    const first = w.sim.refresh(P1).view
    const st = { hostSeq: 1, ready: false, row: null as PlayerViewRow | null, loads: 0 }
    host.link.onRequest((raw) => {
      const r = raw as ClientToHost
      if (r.t !== "hello") return
      void (async () => {
        await sleep(30)
        if (st.ready) await host.send({ t: "snapshot_ready", epoch: "e1", seq: st.hostSeq, nonce: r.nonce })
        else await host.send({ t: "snapshot", epoch: "e1", seq: st.hostSeq, view: first, nonce: r.nonce })
      })()
    })
    const client = makeClient(newTab(), {
      repo: stubRepo({
        loadPlayerView: async () => {
          const ms = loadMs(st.loads++)
          if (ms === Infinity) return new Promise<never>(() => {})
          await sleep(ms)
          return st.row
        },
      }),
      timings: { hostPresenceGraceMs: 120, ...timings },
    })
    await client.start()
    await waitFor(() => client.getSnapshot().status === "live", "live")
    const changeMap = async () => {
      const crypt = structuredClone(w.scene)
      crypt.id = "crypt"
      w.sim.dm({ t: "load-scene", scene: crypt, carried: { [w.token.id]: w.token.id } })
      st.row = { sessionId: SID, userId: P1, hostEpoch: 1, epoch: "e1", seq: 2, view: w.sim.refresh(P1).view, updatedAt: "" }
      st.hostSeq = 2
      st.ready = true
      await host.send({ t: "snapshot_ready", epoch: "e1", seq: 2 })
    }
    return { client, host, st, changeMap }
  }

  it("a stored view load that never settles does not keep the player on the old map: the host's syncs lead to a hello", async () => {
    const { client, host, st, changeMap } = await viaDatabase((n) => (n === 0 ? Infinity : 50), { helloRetryMs: 150, helloRetryMaxMs: 400 })
    const hellos = host.hellos().length
    await changeMap()
    // The host's idle syncs at the new seq: covered by the load at first, then no longer.
    for (let k = 0; k < 8 && client.getSnapshot().mapChanges === 0; k++) {
      await sleep(150)
      await host.send({ t: "sync", epoch: "e1", seq: 2 })
    }
    await waitFor(() => client.getSnapshot().mapChanges === 1, "on the new map")
    expect(client.getSnapshot()).toMatchObject({ status: "live", seq: 2, viewSource: "row" })
    expect(host.hellos().length).toBeGreaterThan(hellos)
    expect(st.loads).toBe(2)
  })

  it("a chat verdict ahead of the view is reported at once, not held behind a slow stored view", async () => {
    const { client, host, changeMap } = await viaDatabase(() => 800, { pendingTimeoutMs: 500 })
    const said = client.say("Coming!", "all")
    await changeMap()
    await host.send({ t: "result", epoch: "e1", seq: 2, result: { reqId: said, ok: true } })
    await waitFor(() => client.getSnapshot().results.length > 0, "the verdict")
    await waitFor(() => client.getSnapshot().mapChanges === 1, "on the new map")
    expect(client.getSnapshot().results).toEqual([{ reqId: said, ok: true, kind: "say" }])
  })

  it("shows the stored view while the DM is away, disables input, and resyncs when the DM returns", async () => {
    const newTab = tabs()
    const { sim, token } = world()
    const { repo, playerRepo, realSid, hostEpoch } = await sessionWithMember()
    const hostT = newTab()
    const first = new FakeHost({ transport: hostT, sessionId: realSid, sim, dmUserId: DM, persist: { repo, hostEpoch } })
    cleanups.push(() => first.stop())
    first.start()
    const client = createPlayerClient({
      sessionId: realSid,
      transport: newTab(),
      repo: playerRepo,
      identity,
      tiles: stubTiles(),
      timings: FAST,
      backdrop: { createCanvas: fakeCanvas },
    })
    cleanups.push(() => client.stop())
    await client.start()
    await waitFor(() => client.getSnapshot().status === "live", "live")

    await first.stop()
    await waitFor(() => client.getSnapshot().status === "host-offline", "host offline")
    expect(client.getSnapshot().hostOnline).toBe(false)
    expect(client.getSnapshot().view).not.toBeNull()
    const reqId = client.requestMove(token.id, [
      { cell: { i: 2, j: 2 }, levelId: token.levelId },
      { cell: { i: 3, j: 2 }, levelId: token.levelId },
    ])
    await Promise.resolve()
    expect(client.getSnapshot().pending).toEqual([])
    expect(client.getSnapshot().results.at(-1)).toEqual({ reqId, ok: false, local: "host-offline", kind: "move" })

    const second = new FakeHost({ transport: newTab(), sessionId: realSid, sim, dmUserId: DM, persist: { repo, hostEpoch } })
    cleanups.push(() => second.stop())
    second.start()
    await waitFor(() => client.getSnapshot().status === "live" && client.getSnapshot().epoch === second.epoch, "live with the new host")
    // Resynced from the new run, either by our hello or by the snapshot the host pushes when our link
    // becomes ready. A hello sent before the new host's link subscribed is lost, and that snapshot
    // answers it, so which of the two happened is timing (asserting the hello was flaky).
    expect(client.getSnapshot().viewSource).toBe("live")
    expect(client.getSnapshot().seq).toBe(second.currentSeq(P1))
  })

  it("starts from the stored view when no DM is connected", async () => {
    const newTab = tabs()
    const { sim } = world()
    const { repo, playerRepo, realSid, hostEpoch } = await sessionWithMember()
    const view = sim.refresh(P1).view
    await repo.upsertPlayerView({ sessionId: realSid, userId: P1, hostEpoch, epoch: "old", seq: 7, view })
    const client = createPlayerClient({
      sessionId: realSid,
      transport: newTab(),
      repo: playerRepo,
      identity,
      tiles: stubTiles(),
      timings: FAST,
      backdrop: { createCanvas: fakeCanvas },
    })
    cleanups.push(() => client.stop())
    await client.start()
    await waitFor(() => client.getSnapshot().status === "host-offline", "host offline")
    await waitFor(() => client.getSnapshot().view !== null, "row")
    expect(client.getSnapshot()).toMatchObject({ epoch: "old", seq: 7, viewSource: "row" })
    expect(client.getSnapshot().scene).not.toBeNull()
  })

  async function liveThenOffline() {
    const newTab = tabs()
    const { sim } = world()
    const session = await sessionWithMember()
    const first = new FakeHost({
      transport: newTab(),
      sessionId: session.realSid,
      sim,
      dmUserId: DM,
      persist: { repo: session.repo, hostEpoch: session.hostEpoch },
    })
    cleanups.push(() => first.stop())
    first.start()
    const client = createPlayerClient({
      sessionId: session.realSid,
      transport: newTab(),
      repo: session.playerRepo,
      identity,
      tiles: stubTiles(),
      timings: FAST,
      backdrop: { createCanvas: fakeCanvas },
    })
    cleanups.push(() => client.stop())
    await client.start()
    await waitFor(() => client.getSnapshot().status === "live", "live")
    await first.stop()
    await waitFor(() => client.getSnapshot().status === "host-offline" && client.getSnapshot().view !== null, "host offline with a view")
    return { ...session, client }
  }

  it("learns that the session ended from the library while the DM is away (no broadcast)", async () => {
    const { repo, realSid, client } = await liveThenOffline()
    await repo.endSession(realSid)
    await waitFor(() => client.getSnapshot().status === "ended", "ended", 2000)
  })

  it("learns about a kick while the DM is away", async () => {
    const { kick, client } = await liveThenOffline()
    await kick()
    await waitFor(() => client.getSnapshot().status === "kicked", "kicked", 2000)
  })

  it("does not poll membership while live", async () => {
    const newTab = tabs()
    const { sim } = world()
    const { repo, playerRepo, realSid, hostEpoch } = await sessionWithMember()
    const host = new FakeHost({ transport: newTab(), sessionId: realSid, sim, dmUserId: DM, persist: { repo, hostEpoch } })
    cleanups.push(() => host.stop())
    host.start()
    const spy = vi.spyOn(playerRepo, "sessionInfo")
    const client = createPlayerClient({
      sessionId: realSid,
      transport: newTab(),
      repo: playerRepo,
      identity,
      tiles: stubTiles(),
      timings: FAST,
      backdrop: { createCanvas: fakeCanvas },
    })
    cleanups.push(() => client.stop())
    await client.start()
    await waitFor(() => client.getSnapshot().status === "live", "live")
    const calls = spy.mock.calls.length
    await sleep(FAST.membershipCheckMs! * 4)
    expect(client.getSnapshot().status).toBe("live")
    expect(spy.mock.calls.length).toBe(calls)
  })

  it("detects being kicked while the DM is away (no row, membership says kicked)", async () => {
    const newTab = tabs()
    const { playerRepo, realSid, kick } = await sessionWithMember()
    await kick()
    const client = createPlayerClient({
      sessionId: realSid,
      transport: newTab(),
      repo: playerRepo,
      identity,
      tiles: stubTiles(),
      timings: FAST,
      backdrop: { createCanvas: fakeCanvas },
    })
    cleanups.push(() => client.stop())
    await client.start()
    await waitFor(() => client.getSnapshot().status === "kicked", "kicked")
  })
})

describe("PlayerClient: membership", () => {
  it("notices a kick while the channels cannot join (RLS keeps refusing)", async () => {
    const newTab = tabs()
    const repo = stubRepo({
      sessionInfo: async () => ({
        sessionId: SID,
        status: "active",
        roomCode: "ABCD1234",
        role: "player",
        memberStatus: "kicked",
        displayName: "Alice",
        dmDisplayName: null,
        createdAt: "",
      }),
    })
    const client = makeClient(newTab({ joinDelayMs: 60_000 }), { repo })
    await client.start()
    // Asked at start: no need to wait for the first periodic check.
    await waitFor(() => client.getSnapshot().status === "kicked", "kicked", 200)
  })

  it("finds a closed table at start (its channels never join) and after the DM closes it", async () => {
    const newTab = tabs()
    let status: "active" | "closed" = "closed"
    const repo = stubRepo({
      sessionInfo: async () => ({
        sessionId: SID,
        status,
        roomCode: "ABCD1234",
        role: "player",
        memberStatus: "active",
        displayName: "Alice",
        dmDisplayName: null,
        createdAt: "",
      }),
    })
    const closed = makeClient(newTab({ joinDelayMs: 60_000 }), { repo })
    await closed.start()
    await waitFor(() => closed.getSnapshot().status === "closed", "closed at start", 200)
    // Open, then closed while connected: the host drops its channels, the membership check finds out.
    status = "active"
    const host = rawHost(newTab())
    const client = makeClient(newTab(), { repo })
    await client.start()
    await waitFor(() => host.hellos().length >= 1, "hello")
    status = "closed"
    await host.ch.close()
    await waitFor(() => client.getSnapshot().status === "closed", "closed later", 3000)
  })

  it("notices a kick while syncing with a host that never answers (local mode: channels still join)", async () => {
    const newTab = tabs()
    let kicked = false
    const repo = stubRepo({
      sessionInfo: async () => ({
        sessionId: SID,
        status: "active",
        roomCode: "ABCD1234",
        role: "player",
        memberStatus: kicked ? "kicked" : "active",
        displayName: "Alice",
        dmDisplayName: null,
        createdAt: "",
      }),
    })
    const host = rawHost(newTab())
    const client = makeClient(newTab(), { repo })
    await client.start()
    await waitFor(() => host.hellos().length >= 1 && client.getSnapshot().status === "syncing", "syncing")
    kicked = true
    await waitFor(() => client.getSnapshot().status === "kicked", "kicked", 2000)
  })

  it("reports an ended session and non-members while stuck connecting", async () => {
    const newTab = tabs()
    const ended = makeClient(newTab({ joinDelayMs: 60_000 }), {
      repo: stubRepo({
        sessionInfo: async () => ({
          sessionId: SID,
          status: "ended",
          roomCode: "X",
          role: "player",
          memberStatus: "active",
          displayName: null,
          dmDisplayName: null,
          createdAt: "",
        }),
      }),
    })
    const stranger = makeClient(newTab({ joinDelayMs: 60_000 }), { repo: stubRepo({ sessionInfo: async () => null }) })
    await Promise.all([ended.start(), stranger.start()])
    await waitFor(() => ended.getSnapshot().status === "ended" && stranger.getSnapshot().status === "error", "terminal states")
    expect(stranger.getSnapshot().error).toMatch(/not a member/)
  })
})

describe("PlayerClient: requests", () => {
  async function live(extra: Partial<PlayerClientRuntimeOptions> = {}) {
    const newTab = tabs()
    const w = world()
    const host = fakeHost(newTab(), w.sim)
    const client = makeClient(newTab(), extra)
    await client.start()
    await waitFor(() => client.getSnapshot().status === "live", "live")
    return { ...w, host, client, newTab }
  }

  it("resolves pending moves from results in patches and standalone results", async () => {
    const { client, token, host } = await live()
    const lvl = token.levelId
    const ok = client.requestMove(token.id, [
      { cell: { i: 2, j: 2 }, levelId: lvl },
      { cell: { i: 3, j: 2 }, levelId: lvl },
    ])
    expect(client.getSnapshot().pending).toEqual([expect.objectContaining({ reqId: ok, kind: "move", tokenId: token.id })])
    expect(pendingMovesOverlay(client.getSnapshot().pending)).toEqual({
      [token.id]: [
        { cell: { i: 2, j: 2 }, levelId: lvl },
        { cell: { i: 3, j: 2 }, levelId: lvl },
      ],
    })
    await waitFor(() => client.getSnapshot().pending.length === 0, "move settled")
    expect(client.getSnapshot().results.at(-1)).toMatchObject({ reqId: ok, ok: true })
    expect(client.getSnapshot().scene?.tokens[token.id].position).toEqual({ x: 17.5, z: 12.5 })
    expect(host.sent.at(-1)?.msg.t).toBe("patch")

    // Wrong start → rejected without a view change → standalone result.
    const bad = client.requestMove(token.id, [
      { cell: { i: 0, j: 0 }, levelId: lvl },
      { cell: { i: 1, j: 0 }, levelId: lvl },
    ])
    await waitFor(() => client.getSnapshot().pending.length === 0, "rejection")
    const res = client.getSnapshot().results.at(-1)
    expect(res).toMatchObject({ reqId: bad, ok: false, reason: "path-start-mismatch" })
    expect(host.sent.at(-1)?.msg.t).toBe("result")
    expect(describeRequestResult(res!)).toBe("The token has moved; try again")
  })

  it("rate-limits to 8 requests per second and validates paths locally", async () => {
    const { client, token, host } = await live()
    host.autoReply = false
    const lvl = token.levelId
    const path = [{ cell: { i: 2, j: 2 }, levelId: lvl }]
    const ids = Array.from({ length: 9 }, () => client.requestMove(token.id, path))
    expect(client.getSnapshot().pending.map((p) => p.reqId)).toEqual(ids.slice(0, 8))
    expect(client.getSnapshot().results.at(-1)).toEqual({ reqId: ids[8], ok: false, reason: "rate-limited", local: "rate-limited", kind: "move" })
    await waitFor(() => host.received.filter((r) => r.msg.t === "move").length === 8, "8 sent")
    const empty = client.requestMove(token.id, [])
    expect(client.getSnapshot().results.at(-1)).toMatchObject({ reqId: empty, ok: false, reason: "empty-path", local: "invalid" })
    const tooLong = client.requestMove(
      token.id,
      Array.from({ length: 300 }, () => path[0])
    )
    expect(client.getSnapshot().results.at(-1)).toMatchObject({ reqId: tooLong, reason: "path-too-long" })
  })

  it("expires unanswered requests after the timeout (DM not responding)", async () => {
    const { client, token, host } = await live()
    host.autoReply = false
    const reqId = client.requestDoor("door-1", "open")
    expect(client.getSnapshot().pending).toHaveLength(1)
    await waitFor(() => client.getSnapshot().pending.length === 0, "expired", 2000)
    const snap = client.getSnapshot()
    expect(snap.results.at(-1)).toEqual({ reqId, ok: false, local: "timeout", kind: "door" })
    expect(snap.hostUnresponsive).toBe(true)
    expect(describeRequestResult(snap.results.at(-1)!)).toBe("DM not responding")
    // Any word from the host clears the flag.
    await host.send(P1, { t: "sync", epoch: host.epoch, seq: host.currentSeq(P1) })
    await waitFor(() => !client.getSnapshot().hostUnresponsive, "responsive again")
    void token
  })

  it("keeps view, scene and pending overlays on a snapshot at the (epoch, seq) it holds", async () => {
    const { client, token, host } = await live()
    host.autoReply = false
    const before = client.getSnapshot()
    const reqId = client.requestMove(token.id, [
      { cell: { i: 2, j: 2 }, levelId: token.levelId },
      { cell: { i: 3, j: 2 }, levelId: token.levelId },
    ])
    const other = client.requestDoor("door-1", "open")
    const view = JSON.parse(JSON.stringify(host.lastView(P1))) as PlayerView
    // E.g. the host re-linked us after a channel rejoin: same view, one result on board.
    await host.send(P1, { t: "snapshot", epoch: before.epoch!, seq: before.seq, view, results: [{ reqId: other, ok: false, reason: "cannot" }] })
    await waitFor(() => client.getSnapshot().results.some((r) => r.reqId === other), "result applied")
    const after = client.getSnapshot()
    expect(after.scene).toBe(before.scene)
    expect(after.view).toBe(before.view)
    expect(after.revision).toBe(before.revision)
    expect(client.sceneChangeSince(before.scene)).toEqual({})
    expect(after.pending.map((p) => p.reqId)).toEqual([reqId])
    expect(after.status).toBe("live")
  })

  it("blames its own network, not the DM, while offline", async () => {
    const newTab = tabs()
    const w = world()
    const host = fakeHost(newTab(), w.sim)
    const transport = newTab()
    let online = true
    const listeners = new Set<(online: boolean) => void>()
    const setOnline = (v: boolean) => {
      online = v
      for (const cb of [...listeners]) cb(v)
    }
    Object.assign(transport, {
      networkOnline: () => online,
      onNetworkChange: (cb: (online: boolean) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    })
    const client = makeClient(transport)
    await client.start()
    await waitFor(() => client.getSnapshot().status === "live", "live")
    host.autoReply = false
    const pending = client.requestMove(w.token.id, [{ cell: { i: 2, j: 2 }, levelId: w.token.levelId }])
    setOnline(false)
    await Promise.resolve()
    let snap = client.getSnapshot()
    expect(snap.networkOffline).toBe(true)
    expect(snap.pending).toEqual([])
    expect(snap.results.at(-1)).toEqual({ reqId: pending, ok: false, local: "not-connected", kind: "move" })
    const refused = client.requestDoor("door-1", "open")
    snap = client.getSnapshot()
    expect(snap.results.at(-1)).toEqual({ reqId: refused, ok: false, local: "not-connected", kind: "door" })
    expect(snap.hostUnresponsive).toBe(false)
    host.autoReply = true
    setOnline(true)
    await waitFor(() => client.getSnapshot().status === "live" && !client.getSnapshot().networkOffline, "back")
    expect(client.getSnapshot().hostUnresponsive).toBe(false)
  })

  it("clears pending overlays on a snapshot from a new host run", async () => {
    const { client, token, host } = await live()
    host.autoReply = false
    client.requestMove(token.id, [{ cell: { i: 2, j: 2 }, levelId: token.levelId }])
    expect(client.getSnapshot().pending).toHaveLength(1)
    await host.send(P1, { t: "snapshot", epoch: "brand-new", seq: 0, view: host.lastView(P1)! })
    await waitFor(() => client.getSnapshot().epoch === "brand-new", "new epoch")
    expect(client.getSnapshot().pending).toEqual([])
  })

  it("follows the DM to another map: the scene is replaced, requests about the old map's places are dropped and their verdicts never reported", async () => {
    const { client, token, host, sim, scene } = await live({ timings: { ...FAST, pendingTimeoutMs: 5000 } })
    host.autoReply = false
    const before = client.getSnapshot()
    expect(before.mapChanges).toBe(0)
    const lvl = token.levelId
    const move = client.requestMove(token.id, [
      { cell: { i: 2, j: 2 }, levelId: lvl },
      { cell: { i: 3, j: 2 }, levelId: lvl },
    ])
    const jump = client.requestJump(token.id, lvl, { x: 32.5, z: 32.5 })
    const door = client.requestDoor("door-1", "open")
    const fireball = {
      shape: "sphere" as const,
      levelId: lvl,
      x: 20,
      z: 20,
      elevation: 0,
      angle: 0,
      size: 20,
      width: 5,
      height: 40,
      label: "Fireball",
      color: "#F97316",
      tokenId: null,
    }
    const template = client.placeTemplate(fireball)
    const unplace = client.removeTemplate("tpl-1")
    const said = client.say("Wait for me!", "all")
    const prone = client.changeTokenStatus(token.id, { conditions: { add: ["prone"] } })
    expect(client.getSnapshot().pending).toHaveLength(7)

    // The DM moves the game to a crypt, bringing the PC along (same token id, on the crypt's level).
    const { scene: crypt, ground: cryptGround } = flatScene(6, 6, "bright")
    crypt.name = "The Sunken Crypt"
    crypt.tokens[token.id] = { ...structuredClone(scene.tokens[token.id]), levelId: cryptGround, position: { x: 7.5, z: 7.5 } }
    sim.dm({ t: "load-scene", scene: crypt, carried: { [token.id]: token.id } })
    await host.flush(P1)
    await waitFor(() => client.getSnapshot().mapChanges === 1, "on the new map")
    const snap = client.getSnapshot()
    expect(host.sent.at(-1)?.msg.t).toBe("patch")
    expect(client.sceneChangeSince(before.scene)).toBeNull()
    expect(snap.view?.scene).toMatchObject({ name: "The Sunken Crypt", mapSerial: 1 })
    expect(snap.scene?.tokens[token.id]).toMatchObject({ levelId: cryptGround, position: { x: 7.5, z: 7.5 } })
    expect(snap.view?.controlledTokenIds).toEqual([token.id])
    expect(snap.pending.map((p) => p.reqId)).toEqual([said, prone])
    expect(snap.results).toEqual([])

    // Late verdicts on the old map's places are not reported; the chat's and the token's are.
    const seq = host.currentSeq(P1)
    const verdicts = [
      { reqId: move, ok: false, reason: "path-start-mismatch" as const },
      { reqId: jump, ok: false, reason: "cannot" as const },
      { reqId: door, ok: false, reason: "cannot" as const },
      { reqId: template, ok: false, reason: "cannot" as const },
      { reqId: unplace, ok: false, reason: "cannot" as const },
      { reqId: said, ok: true },
      { reqId: prone, ok: true },
    ]
    for (const result of verdicts) await host.send(P1, { t: "result", epoch: host.epoch, seq, result })
    await waitFor(() => client.getSnapshot().pending.length === 0, "chat and status settled")
    expect(client.getSnapshot().results).toEqual([
      { reqId: said, ok: true, kind: "say" },
      { reqId: prone, ok: true, kind: "token-status" },
    ])

    // A resync onto the same map (e.g. the host restarted) is no map change.
    await host.send(P1, { t: "snapshot", epoch: "restarted", seq: 0, view: structuredClone(host.lastView(P1)!) })
    await waitFor(() => client.getSnapshot().epoch === "restarted", "new host run")
    expect(client.getSnapshot().mapChanges).toBe(1)
  })

  it("counts another map adopted from a snapshot (not the first view) and ignores late verdicts about the old one", async () => {
    const newTab = tabs()
    const w = world()
    const host = rawHost(newTab())
    const client = makeClient(newTab(), { timings: { ...FAST, pendingTimeoutMs: 5000 } })
    await client.start()
    await waitFor(() => host.hellos().length === 1, "hello")
    const first = w.sim.refresh(P1).view
    await host.send({ t: "snapshot", epoch: "e1", seq: 1, view: first, nonce: host.hellos()[0].nonce })
    await waitFor(() => client.getSnapshot().status === "live", "live")
    expect(client.getSnapshot().mapChanges).toBe(0)

    const onFirst = client.getSnapshot().scene
    const move = client.requestMove(w.token.id, [{ cell: { i: 2, j: 2 }, levelId: w.ground }])
    const said = client.say("Coming!", "all")
    // A duplicated map (same level and token ids) sent whole, e.g. a patch too large for one message.
    const copy = structuredClone(w.scene)
    copy.id = "copy-of-the-keep"
    w.sim.dm({ t: "load-scene", scene: copy, carried: { [w.token.id]: w.token.id } })
    const second = w.sim.refresh(P1).view
    await host.send({ t: "snapshot", epoch: "e1", seq: 2, view: second, results: [{ reqId: move, ok: false, reason: "cannot" }] })
    await waitFor(() => client.getSnapshot().mapChanges === 1, "map change")
    expect(client.sceneChangeSince(onFirst)).toBeNull()
    expect(client.getSnapshot().view?.scene.mapSerial).toBe(1)
    expect(client.getSnapshot().results).toEqual([])
    // The same map again (a later snapshot of it): still one.
    await host.send({ t: "snapshot", epoch: "e1", seq: 3, view: structuredClone(second) })
    await waitFor(() => client.getSnapshot().seq === 3, "resync")
    expect(client.getSnapshot().mapChanges).toBe(1)
    await host.send({ t: "result", epoch: "e1", seq: 3, result: { reqId: move, ok: false, reason: "path-start-mismatch" } })
    await host.send({ t: "result", epoch: "e1", seq: 3, result: { reqId: said, ok: false, reason: "rate-limited" } })
    await waitFor(() => client.getSnapshot().results.length > 0, "chat verdict")
    // (A snapshot clears every overlay: the chat's verdict arrives as a plain result.)
    expect(client.getSnapshot().results).toEqual([{ reqId: said, ok: false, reason: "rate-limited" }])
  })

  it("says which map a request about the map's places was made on", async () => {
    const newTab = tabs()
    const w = world()
    const host = rawHost(newTab())
    const client = makeClient(newTab(), { timings: { ...FAST, pendingTimeoutMs: 5000, requestRate: { max: 100, windowMs: 1000 } } })
    await client.start()
    await waitFor(() => host.hellos().length === 1, "hello")
    await host.send({ t: "snapshot", epoch: "e1", seq: 1, view: w.sim.refresh(P1).view, nonce: host.hellos()[0].nonce })
    await waitFor(() => client.getSnapshot().status === "live", "live")
    const fireball = {
      shape: "sphere" as const,
      levelId: w.ground,
      x: 20,
      z: 20,
      elevation: 0,
      angle: 0,
      size: 20,
      width: 5,
      height: 40,
      label: "Fireball",
      color: "#F97316",
      tokenId: null,
    }
    const ask = () => {
      client.requestMove(w.token.id, [{ cell: { i: 2, j: 2 }, levelId: w.ground }], { x: 12, z: 13 })
      client.requestJump(w.token.id, w.ground, { x: 32.5, z: 32.5 })
      client.requestDoor("door-1", "open")
      client.placeTemplate(fireball)
      client.removeTemplate("tpl-1")
      client.say("On my way", "all")
    }
    const sent = () => host.requests.filter((r) => r.t !== "hello")
    const maps = () => sent().map((r) => [r.t, (r as { map?: number }).map])
    ask()
    await waitFor(() => sent().length === 6, "requests on the first map")
    expect(maps()).toEqual([
      ["move", 0],
      ["jump", 0],
      ["door", 0],
      ["template", 0],
      ["template-remove", 0],
      ["say", undefined],
    ])

    // The DM moves the game to a copy of the map (same level, token and door ids): requests made there say so.
    const copy = structuredClone(w.scene)
    copy.id = "copy-of-the-keep"
    w.sim.dm({ t: "load-scene", scene: copy, carried: { [w.token.id]: w.token.id } })
    await host.send({ t: "snapshot", epoch: "e1", seq: 2, view: w.sim.refresh(P1).view })
    await waitFor(() => client.getSnapshot().mapChanges === 1, "on the copy")
    ask()
    await waitFor(() => sent().length === 12, "requests on the copy")
    expect(maps().slice(6)).toEqual([
      ["move", 1],
      ["jump", 1],
      ["door", 1],
      ["template", 1],
      ["template-remove", 1],
      ["say", undefined],
    ])
    // The host's protocol takes them.
    expect(sent().every((r) => parseClientMessage(r) !== null)).toBe(true)
  })

  it("holds verdicts about the map's places that arrive before the new map lands, then skips those about the old map", async () => {
    const newTab = tabs()
    const w = world()
    const host = rawHost(newTab())
    let row: PlayerViewRow | null = null
    let land: () => void = () => {}
    const landed = new Promise<void>((resolve) => (land = resolve))
    const client = makeClient(newTab(), {
      repo: stubRepo({
        loadPlayerView: async () => {
          await landed
          return row
        },
      }),
      timings: { ...FAST, pendingTimeoutMs: 5000 },
    })
    await client.start()
    await waitFor(() => host.hellos().length === 1, "hello")
    await host.send({ t: "snapshot", epoch: "e1", seq: 1, view: w.sim.refresh(P1).view, nonce: host.hellos()[0].nonce })
    await waitFor(() => client.getSnapshot().status === "live", "live")
    const hellos = host.hellos().length

    const move = client.requestMove(w.token.id, [
      { cell: { i: 2, j: 2 }, levelId: w.ground },
      { cell: { i: 3, j: 2 }, levelId: w.ground },
    ])
    const said = client.say("Coming!", "all")
    // The new map is too big for one broadcast: snapshot_ready, then the host's queued verdicts at the new seq.
    const crypt = structuredClone(w.scene)
    crypt.id = "crypt"
    w.sim.dm({ t: "load-scene", scene: crypt, carried: { [w.token.id]: w.token.id } })
    row = { sessionId: SID, userId: P1, hostEpoch: 1, epoch: "e1", seq: 2, view: w.sim.refresh(P1).view, updatedAt: "" }
    await host.send({ t: "snapshot_ready", epoch: "e1", seq: 2 })
    await host.send({ t: "result", epoch: "e1", seq: 2, result: { reqId: move, ok: false, reason: "cannot" } })
    await host.send({ t: "result", epoch: "e1", seq: 2, result: { reqId: said, ok: false, reason: "rate-limited" } })
    await sleep(60)
    // Still on the old map: the move's verdict waits (its "cannot" would read "You can't reach that door"),
    // the chat's is reported at once, and nothing is asked again (the row being loaded brings that seq).
    const chat = [{ reqId: said, ok: false, reason: "rate-limited", kind: "say" }]
    expect(client.getSnapshot().results).toEqual(chat)
    expect(client.getSnapshot().pending.map((p) => p.reqId)).toEqual([move])
    expect(host.hellos()).toHaveLength(hellos)

    land()
    await waitFor(() => client.getSnapshot().mapChanges === 1, "on the new map")
    expect(client.getSnapshot()).toMatchObject({ epoch: "e1", seq: 2, status: "live", viewSource: "row", pending: [] })
    expect(client.getSnapshot().results).toEqual(chat)
  })

  it("holds a verdict that is ahead of its view until the missed update arrives, and asks for it", async () => {
    const newTab = tabs()
    const w = world()
    const host = rawHost(newTab())
    const client = makeClient(newTab(), { timings: { ...FAST, pendingTimeoutMs: 5000 } })
    await client.start()
    await waitFor(() => host.hellos().length === 1, "hello")
    await host.send({ t: "snapshot", epoch: "e1", seq: 1, view: w.sim.refresh(P1).view, nonce: host.hellos()[0].nonce })
    await waitFor(() => client.getSnapshot().status === "live", "live")
    const lvl = w.ground
    const h = host.hellos().length

    // The patch that moved the token (seq 2, carrying the move's verdict) is lost; the door's verdict follows alone.
    const move = client.requestMove(w.token.id, [
      { cell: { i: 2, j: 2 }, levelId: lvl },
      { cell: { i: 3, j: 2 }, levelId: lvl },
    ])
    const door = client.requestDoor("door-1", "open")
    w.sim.dm({ t: "move-token", tokenId: w.token.id, levelId: lvl, x: 17.5, z: 12.5 })
    const v2 = w.sim.refresh(P1)
    await host.send({ t: "result", epoch: "e1", seq: 2, result: { reqId: door, ok: false, reason: "cannot" } })
    await waitFor(() => host.hellos().length === h + 1, "hello: the verdict shows a missed update")
    expect(host.hellos()[h]).toMatchObject({ epoch: "e1", lastSeq: 1 })
    expect(client.getSnapshot().results).toEqual([])
    expect(client.getSnapshot().pending.map((p) => p.reqId)).toEqual([move, door])
    // The catch-up (with the results sent since) settles both, each reported once.
    const since = [
      { reqId: move, ok: true },
      { reqId: door, ok: false, reason: "cannot" as const },
    ]
    await host.send({ t: "patch", epoch: "e1", baseSeq: 1, seq: 2, ops: v2.ops, nonce: host.hellos()[h].nonce, results: since })
    await waitFor(() => client.getSnapshot().pending.length === 0, "settled")
    expect(client.getSnapshot().results).toEqual([
      { reqId: door, ok: false, reason: "cannot", kind: "door" },
      { reqId: move, ok: true, kind: "move" },
    ])
    expect(client.getSnapshot().scene?.tokens[w.token.id].position).toEqual({ x: 17.5, z: 12.5 })

    // A patch that cannot be applied (the one before it was lost) holds its verdicts the same way.
    const jump = client.requestJump(w.token.id, lvl, { x: 32.5, z: 32.5 })
    w.sim.dm({ t: "move-token", tokenId: w.token.id, levelId: lvl, x: 22.5, z: 12.5 })
    w.sim.refresh(P1)
    w.sim.dm({ t: "move-token", tokenId: w.token.id, levelId: lvl, x: 32.5, z: 32.5 })
    const v4 = w.sim.refresh(P1)
    await host.send({ t: "patch", epoch: "e1", baseSeq: 3, seq: 4, ops: v4.ops, results: [{ reqId: jump, ok: true }] })
    await waitFor(() => host.hellos().length === h + 2, "hello after an unusable patch")
    expect(host.hellos()[h + 1]).toMatchObject({ epoch: "e1", lastSeq: 2 })
    expect(client.getSnapshot().results).toHaveLength(2)
    expect(client.getSnapshot().pending.map((p) => p.reqId)).toEqual([jump])
    await host.send({ t: "patch", epoch: "e1", baseSeq: 2, seq: 4, ops: diffViews(v2.view, v4.view), nonce: host.hellos()[h + 1].nonce })
    await waitFor(() => client.getSnapshot().pending.length === 0, "jump settled")
    expect(client.getSnapshot().results.at(-1)).toEqual({ reqId: jump, ok: true, kind: "jump" })
    expect(client.getSnapshot().seq).toBe(4)
  })

  it("is closed for good after being kicked", async () => {
    const { client, token, host } = await live()
    await host.send(P1, { t: "kicked", reason: "Removed by the DM" })
    await waitFor(() => client.getSnapshot().status === "kicked", "kicked")
    expect(client.getSnapshot().error).toBe("Removed by the DM")
    const reqId = client.requestMove(token.id, [{ cell: { i: 2, j: 2 }, levelId: token.levelId }])
    expect(client.getSnapshot().results.at(-1)).toEqual({ reqId, ok: false, local: "closed", kind: "move" })
    // Channels are closed: the host can no longer reach us.
    const before = client.getSnapshot()
    await host.send(P1, { t: "snapshot", epoch: "x", seq: 9, view: host.lastView(P1)! })
    await sleep(40)
    expect(client.getSnapshot().epoch).toBe(before.epoch)
    expect(client.getSnapshot().status).toBe("kicked")
  })

  it("ends when the DM ends the session", async () => {
    const { client, host } = await live()
    await host.broadcast({ t: "ended" })
    await waitFor(() => client.getSnapshot().status === "ended", "ended")
  })

  it("closes when the DM closes the table, keeping the last view for display", async () => {
    const { client, token, host } = await live()
    const view = client.getSnapshot().view
    await host.broadcast({ t: "closed" })
    await waitFor(() => client.getSnapshot().status === "closed", "closed")
    expect(client.getSnapshot().view).toBe(view)
    const reqId = client.requestMove(token.id, [{ cell: { i: 2, j: 2 }, levelId: token.levelId }])
    expect(client.getSnapshot().results.at(-1)).toEqual({ reqId, ok: false, local: "closed", kind: "move" })
  })

  it("stop() settles pending requests and disposes the tile source", async () => {
    const tiles = stubTiles()
    const { client, token, host } = await live({ tiles })
    host.autoReply = false
    const reqId = client.requestMove(token.id, [{ cell: { i: 2, j: 2 }, levelId: token.levelId }])
    await client.stop()
    expect(client.getSnapshot().pending).toEqual([])
    expect(client.getSnapshot().results.at(-1)).toEqual({ reqId, ok: false, local: "closed", kind: "move" })
    expect(tiles.dispose).toHaveBeenCalledTimes(1)
  })
})

describe("PlayerClient: backdrops", () => {
  it("fetches tiles of explored cells and announces the level canvas", async () => {
    const newTab = tabs()
    const { scene, ground } = flatScene(6, 6, "bright")
    scene.levels[ground].backdrop = { assetId: "map", rect: { x: 0, z: 0, w: 30, d: 30 }, opacity: 0.9, tintWalls: true }
    const token = addToken(scene, ground, 12.5, 12.5)
    const sim = new TestHost(scene, [P1])
    sim.assign(token.id, P1)
    fakeHost(newTab(), sim, { tilePx: 64 })
    const asked: string[] = []
    const tiles = {
      getTile: vi.fn(async (levelId: string, cell: { i: number; j: number }) => {
        asked.push(`${levelId}:${cell.i},${cell.j}`)
        return { width: 64, height: 64, close() {} } as unknown as ImageBitmap
      }),
      dispose: vi.fn(),
    }
    const client = makeClient(newTab(), { tiles })
    const events: string[] = []
    client.onBackdrop((ev) => events.push(ev.kind))
    await client.start()
    await waitFor(() => events.includes("set"), "backdrop announced")
    const snap = client.getSnapshot()
    expect(snap.scene?.levels[ground].backdrop).toMatchObject({ rect: { x: 0, z: 0, w: 30, d: 30 }, opacity: 0.9, tintWalls: true })
    // A bright open room: every cell is explored, so every tile was requested exactly once.
    await waitFor(() => asked.length === 36, "all tiles")
    expect(new Set(asked).size).toBe(36)
    const layer = client.backdropLayers()[0]
    expect(layer).toMatchObject({ levelId: ground, announced: true, pxPerCell: 64 })
    expect(client.backdropCanvas(ground)).toBe(layer.canvas)
    expect([layer.canvas.width, layer.canvas.height]).toEqual([384, 384])

    // An engine bound late gets the current image, then follows updates; unbinding removes it.
    const calls: string[] = []
    const engine = {
      setLevelImage: (levelId: string, image: unknown, rect: unknown) => calls.push(`set ${levelId} ${image ? "canvas" : "null"} ${rect ? "rect" : "null"}`),
      updateLevelImage: (levelId: string) => calls.push(`update ${levelId}`),
    }
    const unbind = bindBackdropsToEngine(client, engine)
    expect(calls).toEqual([`set ${ground} canvas rect`])
    unbind()
    expect(calls.at(-1)).toBe(`set ${ground} null null`)
  })

  it("draws another map's backdrop afresh, even on a duplicate sharing the level id and placement", async () => {
    const newTab = tabs()
    const { scene, ground } = flatScene(6, 6, "bright")
    scene.levels[ground].backdrop = { assetId: "map", rect: { x: 0, z: 0, w: 30, d: 30 }, opacity: 1, tintWalls: false }
    const token = addToken(scene, ground, 12.5, 12.5)
    const sim = new TestHost(scene, [P1])
    sim.assign(token.id, P1)
    const host = fakeHost(newTab(), sim, { tilePx: 64 })
    // A tile source that serves the chunks the host announced (rev = which map's pixels they hold).
    const chunks = new Map<string, number>()
    const chunkOf = (levelId: string, cell: { i: number; j: number }) => `${levelId}:${Math.floor(cell.i / 4)},${Math.floor(cell.j / 4)}`
    for (const c of ["0,0", "1,0", "0,1", "1,1"]) chunks.set(`${ground}:${c}`, 1)
    const drawn: string[] = []
    const tiles = {
      getTile: vi.fn(async (levelId: string, cell: { i: number; j: number }) => {
        const rev = chunks.get(chunkOf(levelId, cell))
        drawn.push(`${rev ?? "none"}:${levelId}:${cell.i},${cell.j}`)
        return rev === undefined ? null : ({ width: 64, height: 64, close() {} } as unknown as ImageBitmap)
      }),
      setChunks: vi.fn((levelId: string, entries: Array<[number, number, number, number?]>, reset: boolean) => {
        if (reset) for (const k of [...chunks.keys()]) if (k.startsWith(`${levelId}:`)) chunks.delete(k)
        for (const [ci, cj, mask, rev] of entries) {
          if (mask) chunks.set(`${levelId}:${ci},${cj}`, rev ?? 0)
          else chunks.delete(`${levelId}:${ci},${cj}`)
        }
        return []
      }),
      dispose: vi.fn(),
    }
    const client = makeClient(newTab(), { tiles })
    const events: string[] = []
    client.onBackdrop((ev) => events.push(`${ev.kind} ${ev.levelId}`))
    await client.start()
    await waitFor(() => events.includes(`set ${ground}`) && drawn.length === 36, "first map drawn")
    expect(drawn.every((d) => d.startsWith("1:"))).toBe(true)
    const calls: string[] = []
    bindBackdropsToEngine(client, {
      setLevelImage: (levelId, image) => calls.push(`set ${levelId} ${image ? "canvas" : "null"}`),
      updateLevelImage: (levelId) => calls.push(`update ${levelId}`),
    })
    const firstCanvas = client.backdropCanvas(ground)

    // The night version of the same map: same level id, same placement, other pixels. As the real host
    // does, the level's chunks are reset and the new map's announced (rev 2) just before the view.
    const night = structuredClone(scene)
    night.id = "night-keep"
    sim.dm({ t: "load-scene", scene: night, carried: { [token.id]: token.id } })
    const full = 0xffff
    await host.send(P1, {
      t: "tiles",
      epoch: host.epoch,
      levelId: ground,
      chunks: [
        [0, 0, full, 2],
        [1, 0, full, 2],
        [0, 1, full, 2],
        [1, 1, full, 2],
      ],
      reset: true,
    })
    await host.flush(P1)
    await waitFor(() => client.getSnapshot().mapChanges === 1, "on the night map")
    await waitFor(() => drawn.filter((d) => d.startsWith("2:")).length === 36 && events.filter((e) => e === `set ${ground}`).length === 2, "night map drawn")
    // Every cell was drawn again from the chunks announced before the view, none from the old map's.
    expect(drawn.slice(36).every((d) => d.startsWith("2:"))).toBe(true)
    const announced = (list: string[]) => list.filter((e) => !e.startsWith("update"))
    expect(announced(events)).toEqual([`set ${ground}`, `remove ${ground}`, `set ${ground}`])
    expect(client.backdropCanvas(ground)).not.toBe(firstCanvas)
    await waitFor(() => client.backdropLayers()[0]?.stats.drawn === 36, "all night tiles drawn")
    expect(announced(calls)).toEqual([`set ${ground} canvas`, `set ${ground} null`, `set ${ground} canvas`])

    // A map without that level: its image goes.
    const { scene: crypt, ground: cryptGround } = flatScene(6, 6, "bright")
    crypt.tokens[token.id] = { ...structuredClone(scene.tokens[token.id]), levelId: cryptGround }
    sim.dm({ t: "load-scene", scene: crypt, carried: { [token.id]: token.id } })
    await host.flush(P1)
    await waitFor(() => client.getSnapshot().mapChanges === 2, "in the crypt")
    expect(events.at(-1)).toBe(`remove ${ground}`)
    expect(client.backdropLayers()).toEqual([])
    expect(calls.at(-1)).toBe(`set ${ground} null`)
  })

  it("tells the tile source which map the view shows before asking for that map's tiles", async () => {
    const newTab = tabs()
    const { scene, ground } = flatScene(6, 6, "bright")
    scene.levels[ground].backdrop = { assetId: "map", rect: { x: 0, z: 0, w: 30, d: 30 }, opacity: 1, tintWalls: false }
    const token = addToken(scene, ground, 12.5, 12.5)
    const sim = new TestHost(scene, [P1])
    sim.assign(token.id, P1)
    const host = fakeHost(newTab(), sim, { tilePx: 64 })
    // A source that crops from the stored scene (local mode) must not cut the new map's cells from the old one.
    const calls: string[] = []
    const tiles = {
      getTile: vi.fn(async () => {
        calls.push("tile")
        return { width: 64, height: 64, close() {} } as unknown as ImageBitmap
      }),
      setMap: vi.fn((map: number) => {
        calls.push(`map ${map}`)
      }),
      dispose: vi.fn(),
    }
    const client = makeClient(newTab(), { tiles })
    await client.start()
    await waitFor(() => calls.filter((c) => c === "tile").length === 36, "first map drawn")
    expect(calls[0]).toBe("map 0")

    const night = structuredClone(scene)
    night.id = "night-keep"
    sim.dm({ t: "load-scene", scene: night, carried: { [token.id]: token.id } })
    const before = calls.length
    await host.flush(P1)
    await waitFor(() => calls.filter((c) => c === "tile").length === 72, "night map drawn")
    expect(calls[before]).toBe("map 1")
    expect(calls.filter((c) => c !== "tile")).toEqual(["map 0", "map 1"])
  })

  it("bindBackdropsToEngine maps set / update / remove events", () => {
    let emit: (ev: Parameters<Parameters<Parameters<typeof bindBackdropsToEngine>[0]["onBackdrop"]>[0]>[0]) => void = () => {}
    const fake = {
      onBackdrop: (cb: typeof emit) => {
        emit = cb
        return () => {}
      },
      backdropLayers: () => [],
    }
    const calls: unknown[][] = []
    bindBackdropsToEngine(fake, { setLevelImage: (...a) => calls.push(["set", ...a]), updateLevelImage: (...a) => calls.push(["update", ...a]) })
    const layer = {
      levelId: "l",
      canvas: fakeCanvas(10, 10),
      rect: { x: 0, z: 0, w: 5, d: 5 },
      opacity: 1,
      tintWalls: false,
      tilePx: 10,
      pxPerCell: 10,
      announced: true,
      stats: { wanted: 1, drawn: 1, pending: 0, missing: 0 },
    }
    const dirty = { x: 0, z: 0, w: 105, d: 205 }
    const dirtyRects = [
      { x: 0, z: 0, w: 5, d: 5 },
      { x: 100, z: 200, w: 5, d: 5 },
    ]
    // An update for a level the engine has not seen yet is promoted to a set.
    emit({ kind: "update", levelId: "l", layer, dirty, dirtyRects })
    // Later updates pass the per-chunk list through (not the bounding box).
    emit({ kind: "update", levelId: "l", layer, dirty, dirtyRects })
    emit({ kind: "remove", levelId: "l" })
    emit({ kind: "remove", levelId: "l" })
    expect(calls).toEqual([
      ["set", "l", layer.canvas, layer.rect],
      ["update", "l", dirtyRects],
      ["set", "l", null, null],
    ])
  })
})

describe("sceneChangeFromOps", () => {
  const { sim, token } = world()
  const view = sim.refresh(P1).view
  it("maps diff paths onto engine hints", () => {
    expect(sceneChangeFromOps([{ op: "set", path: ["masks", "l", "explored"], value: {} }], view, view)).toBe("none")
    expect(sceneChangeFromOps([{ op: "set", path: ["tokens", token.id], value: {} }], view, view)).toEqual({ tokens: [token.id] })
    expect(sceneChangeFromOps([{ op: "del", path: ["objects", "w1@0,0"] }], view, view)).toEqual({ objects: ["w1@0,0"] })
    expect(sceneChangeFromOps([{ op: "set", path: ["terrain", "l1", "0,0"], value: "" }], view, view)).toEqual({ terrain: ["l1"] })
    expect(sceneChangeFromOps([{ op: "set", path: ["scene", "levels", "l2"], value: {} }], view, view)).toEqual({ structure: true })
    expect(sceneChangeFromOps([{ op: "set", path: ["scene", "name"], value: "x" }], view, view)).toBe("none")
    expect(sceneChangeFromOps([{ op: "set", path: [], value: view }], view, view)).toBeNull()
  })

  it("replaces everything on another map, even a duplicate sharing level and token ids", () => {
    const w = world()
    const a = w.sim.refresh(P1).view
    // A duplicated map: same ids, another document; the party carried along.
    const copy = structuredClone(w.scene)
    copy.id = "copy-of-the-keep"
    copy.name = "The Keep (night)"
    copy.tokens[w.token.id].position = { x: 27.5, z: 27.5 }
    w.sim.dm({ t: "load-scene", scene: copy, carried: { [w.token.id]: w.token.id } })
    const b = w.sim.refresh(P1).view
    expect(b.scene.mapSerial).toBe(1)
    expect(Object.keys(b.scene.levels)).toEqual(Object.keys(a.scene.levels))
    expect(isOtherMap(a, b)).toBe(true)
    expect(isOtherMap(b, a)).toBe(true)
    expect(isOtherMap(a, a)).toBe(false)
    expect(isOtherMap(b, structuredClone(b))).toBe(false)
    expect(sceneChangeFromOps(diffViews(a, b), a, b)).toBeNull()
    // The next map again: another marker.
    w.sim.dm({ t: "load-scene", scene: structuredClone(w.scene), carried: { [w.token.id]: w.token.id } })
    const c = w.sim.refresh(P1).view
    expect(isOtherMap(b, c)).toBe(true)
    expect(sceneChangeFromOps(diffViews(b, c), b, c)).toBeNull()

    // In-map changes are not another map: a level added, a rename, a token moving.
    const level = { ...a.scene.levels[w.ground], id: "attic", name: "Attic", elevation: 10 }
    const more = { ...a, scene: { ...a.scene, name: "Renamed", levels: { ...a.scene.levels, attic: level } } }
    expect(isOtherMap(a, more)).toBe(false)
    expect(sceneChangeFromOps(diffViews(a, more), a, more)).toEqual({ structure: true })
  })
})

describe("PlayerClient: the table and pings", () => {
  it("says, rolls and ends turns through the host; results carry their kind", async () => {
    const newTab = tabs()
    const { sim } = world()
    const host = fakeHost(newTab(), sim)
    const client = makeClient(newTab())
    await client.start()
    await waitFor(() => client.getSnapshot().status === "live", "live")
    const said = client.say("  Hello  ", "all")
    const rolled = client.roll("2d6+1 damage", "dm")
    const endTurn = client.endTurn("c1")
    await waitFor(() => client.getSnapshot().results.length === 3, "results")
    expect(host.received.map((r) => r.msg)).toEqual(
      expect.arrayContaining([
        { t: "say", reqId: said, text: "Hello", to: "all" },
        { t: "roll", reqId: rolled, formula: "2d6+1 damage", to: "dm" },
        { t: "end-turn", reqId: endTurn, entryId: "c1" },
      ])
    )
    const results = client.getSnapshot().results
    expect(results.find((r) => r.reqId === said)).toMatchObject({ ok: true, kind: "say" })
    const refused = results.find((r) => r.reqId === endTurn)!
    expect(refused).toMatchObject({ ok: false, reason: "cannot", kind: "end-turn" })
    expect(describeRequestResult(refused)).toBe("It isn't your turn")
    await waitFor(() => Object.keys(client.getSnapshot().view?.table?.log ?? {}).length === 2, "log in the view")
    const log = Object.values(client.getSnapshot().view!.table!.log).sort((a, b) => a.at - b.at)
    expect(log.map((m) => [m.kind, m.text, m.whisper, m.mine])).toEqual([
      ["chat", "Hello", false, true],
      ["roll", "damage", true, true],
    ])
    // Refused locally: nothing to send.
    const empty = client.say("   ", "all")
    const long = client.roll("d".repeat(500), "all")
    const byId = (id: string) => client.getSnapshot().results.find((r) => r.reqId === id)
    expect(byId(empty)).toMatchObject({ ok: false, local: "invalid", kind: "say" })
    expect(describeRequestResult(byId(long)!)).toBe("Those dice can't be read (try 1d20+5)")
  })

  it("sends token status as relative changes, and keeps back what it may not send", async () => {
    const newTab = tabs()
    const { sim, token } = world()
    const host = fakeHost(newTab(), sim)
    const client = makeClient(newTab())
    await client.start()
    await waitFor(() => client.getSnapshot().status === "live", "live")
    const prone = client.changeTokenStatus(token.id, { conditions: { add: ["prone", "prone", "sleepy" as never] } })
    const heal = client.changeTokenStatus(token.id, { hp: { kind: "heal", amount: 4.4 } })
    // Max is the DM's; an empty change says nothing.
    const max = client.changeTokenStatus(token.id, { hp: { kind: "max", max: 30 } })
    const empty = client.changeTokenStatus(token.id, { conditions: { add: [] } })
    await waitFor(() => client.getSnapshot().results.length === 4, "results")
    expect(host.received.map((r) => r.msg).filter((m) => m.t === "token-status")).toEqual([
      { t: "token-status", reqId: prone, tokenId: token.id, conditions: { add: ["prone"] } },
      { t: "token-status", reqId: heal, tokenId: token.id, hp: { kind: "heal", amount: 4 } },
    ])
    const byId = (id: string) => client.getSnapshot().results.find((r) => r.reqId === id)!
    expect(byId(max)).toMatchObject({ ok: false, local: "invalid", kind: "token-status" })
    expect(byId(empty)).toMatchObject({ ok: false, local: "invalid", kind: "token-status" })
    expect(byId(prone)).toMatchObject({ ok: true, kind: "token-status" })
    // The DM does not track this token's hit points.
    expect(byId(heal)).toMatchObject({ ok: false, reason: "cannot", kind: "token-status" })
    expect(describeRequestResult(byId(heal))).toBe("The DM doesn't track that character's hit points")
    await waitFor(() => client.getSnapshot().view?.tokens[token.id]?.conditions?.[0] === "prone", "prone in the view")
  })

  it("sends pings on known levels only, draws its own at once, and takes the host's", async () => {
    const newTab = tabs()
    const { sim, ground } = world()
    const host = rawHost(newTab())
    const client = makeClient(newTab())
    const got: unknown[] = []
    client.onPing((ev) => got.push(ev))
    await client.start()
    await waitFor(() => host.hellos().length === 1, "hello")
    // Nothing known yet (no view): refused.
    expect(client.ping(ground, { x: 1, z: 2 })).toBe(false)
    const view = sim.refresh(P1).view
    expect(view.scene.levels[ground].known).toBe(true)
    await host.send({ t: "snapshot", epoch: "e1", seq: 1, view, nonce: host.hellos()[0].nonce })
    await waitFor(() => client.getSnapshot().status === "live", "live")
    expect(client.ping("elsewhere", { x: 1, z: 2 })).toBe(false)
    expect(client.ping(ground, { x: 1, z: 2 })).toBe(true)
    // At most one per PING_GAP_MS.
    expect(client.ping(ground, { x: 3, z: 4 })).toBe(false)
    await waitFor(() => host.requests.some((r) => r.t === "ping"), "ping sent")
    expect(host.requests.filter((r) => r.t === "ping")).toEqual([{ t: "ping", levelId: ground, x: 1, z: 2 }])
    expect(got).toEqual([{ levelId: ground, x: 1, z: 2, name: "", color: "", focus: false, mine: true }])

    const ping = { levelId: ground, x: 20, z: 5, name: "DM", color: "#e0a526", focus: true }
    await host.send({ t: "ping", epoch: "e1", ping })
    await host.send({ t: "ping", epoch: "other-epoch", ping: { ...ping, x: 99 } })
    await host.send({ t: "ping", epoch: "e1", ping: { ...ping, x: "far" } } as never)
    await host.send({ t: "ping", epoch: "e1", ping: { ...ping, extra: 1 } } as never)
    // On a level of another map (sent just before a map change, arriving after it): not ours to draw.
    await host.send({ t: "ping", epoch: "e1", ping: { ...ping, levelId: "old-map-level" } })
    await waitFor(() => got.length >= 2, "host ping")
    await sleep(40)
    expect(got).toEqual([expect.objectContaining({ mine: true }), { ...ping, mine: false }])
  })
})
