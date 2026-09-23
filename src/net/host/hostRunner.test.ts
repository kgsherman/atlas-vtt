/**
 * Host ↔ player simulation over LocalTransport (Node BroadcastChannel) with the local SessionsRepo
 * and an in-thread vision client: joins and snapshots, moves (legal prefix, masked reasons, per-step
 * exploration), doors, clean patch application on mirrors, hello catch-up, snapshot_ready, host
 * restart, kicks, stale-epoch stand-down, the same-browser lock, rate limiting, backdrop tile grants
 * before the patches that reveal them, and the leak test on The Crooked Lantern.
 */
import { afterEach, describe, expect, it } from "vitest"

import type { PathStep } from "@/core/movement/types"
import { createDoor, createWall } from "@/core/scene/factory"
import { sampleById } from "@/core/scene/samples"
import type { Id, Scene } from "@/core/scene/types"
import { playerViewSchema } from "@/core/session"
import { add, addToken, flatScene } from "@/core/session/test-utils"
import type { PlayerDoor, PlayerView } from "@/core/session/types"
import { deepEqual } from "@/core/session/util"
import { cellTouched, decodeMask } from "@/core/vision/mask"

import { createLocalScenesRepo } from "../scenesRepo"
import { NetError } from "../supabase"
import type { HostRunnerImpl } from "./hostRunner"
import { createSessionFixture, DM, FakeWorker, Mirror, P1, P2, P3, recordingAssets, sleep, startHost, TEST_TIMING, waitFor, type SessionFixture } from "./test-utils"
import type { TileCodec } from "./tiles"
import { createInThreadVisionClient, createWorkerVisionClient, type WorkerLike } from "./visionClient"
import { responseTransferables, VisionWorkerCore, type VisionRequest } from "./visionProtocol"

const walk = (levelId: Id, cells: Array<[number, number]>): PathStep[] => cells.map(([i, j]) => ({ cell: { i, j }, levelId }))
const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function fixture(scene: Scene, players: string[]): Promise<SessionFixture> {
  const fx = await createSessionFixture(scene, players)
  cleanups.push(() => fx.dispose())
  return fx
}

function host(fx: SessionFixture, extra: Parameters<typeof startHost>[1] = {}) {
  const h = startHost(fx, extra)
  cleanups.push(() => h.host.stop())
  return h
}

function mirror(fx: SessionFixture, uid: string, opts: ConstructorParameters<typeof Mirror>[4] = {}): Mirror {
  const m = new Mirror(fx.newTransport(), fx.sessionId, uid, fx.repoOf(uid), opts)
  cleanups.push(() => m.close())
  return m
}

/** Wait until the host is idle and every mirror holds exactly the view the host believes it holds. */
async function settle(h: HostRunnerImpl, mirrors: Array<[string, Mirror]>, what = "settle"): Promise<void> {
  let stable = 0
  await waitFor(
    () => {
      const epoch = h.getSnapshot().epoch
      const ok =
        h.debugIdle() &&
        mirrors.every(([uid, m]) => {
          const p = h.debugPlayer(uid)
          return p !== null && p.view !== null && m.epoch === epoch && m.seq === p.seq && deepEqual(m.view, json(p.view))
        })
      stable = ok ? stable + 1 : 0
      return stable >= 6
    },
    what,
    8000
  )
}

/** Bright keep: a wall at x = 35 with a door (z 17.5) and a locked door (z 22); a corner stub near (1, 1). */
function keep() {
  const { scene, ground } = flatScene(14, 8, "bright")
  scene.name = "The Keep"
  const wall = add(scene, createWall(ground, { x: 35, z: 0 }, { x: 35, z: 40 }, { name: "SENTINEL_WALL_NAME", dmNotes: "SENTINEL_WALL_NOTES" }))
  const door = add(scene, createDoor(wall, 17.5, { name: "SENTINEL_DOOR_NAME", dmNotes: "SENTINEL_DOOR_NOTES" }))
  const locked = add(scene, createDoor(wall, 22, { state: "locked", style: "iron" }))
  add(scene, createWall(ground, { x: 10, z: 5 }, { x: 10, z: 5.8 }))
  const ada = addToken(scene, ground, 27.5, 17.5, { name: "Ada Lovelace", label: "Ada" })
  const bo = addToken(scene, ground, 7.5, 7.5, { name: "Bo Diddley", label: "Bo" })
  const goblin = addToken(scene, ground, 52.5, 17.5, { name: "SENTINEL_GOBLIN_NAME", label: "Goblin", kind: "monster", dmNotes: "SENTINEL_GOBLIN_NOTES" })
  const assassin = addToken(scene, ground, 17.5, 27.5, { name: "SENTINEL_ASSASSIN", label: "SENTINEL_ASSASSIN_LABEL", kind: "monster", hidden: true })
  return { scene, ground, wall, door, locked, ada, bo, goblin, assassin }
}

/** Dark corridor 16×3: Eve (darkvision 10 ft) at (1, 1), a wall at x = 45; Fay (no darkvision) at (12, 1) by a stub. */
function corridor() {
  const { scene, ground } = flatScene(16, 3, "dark")
  add(scene, createWall(ground, { x: 45, z: 0 }, { x: 45, z: 15 }))
  add(scene, createWall(ground, { x: 65, z: 5 }, { x: 65, z: 5.8 }))
  const eve = addToken(scene, ground, 7.5, 7.5, { name: "Eve", vision: { darkvision: 10, blindsight: 0, blind: false } })
  const fay = addToken(scene, ground, 62.5, 7.5, { name: "Fay" })
  return { scene, ground, eve, fay }
}

/**
 * In-thread vision whose computes resolve `delay()` ms late (to hold requests "in flight"), and whose
 * step probes take `probeDelay()` ms (while they run, the foreground lane is blocked like a busy worker).
 */
function slowVision(delay: () => number, probeDelay: () => number = () => 0, log?: string[]) {
  return () => {
    const inner = createInThreadVisionClient()
    return {
      kind: inner.kind,
      get lastComputeMs() {
        return inner.lastComputeMs
      },
      get pendingProbes() {
        return inner.pendingProbes
      },
      onFailure: inner.onFailure,
      setScene: inner.setScene,
      update: inner.update,
      dispose: inner.dispose,
      compute: async (ids: Id[], tag: number) => {
        log?.push(`compute ${ids.join(",")}`)
        const r = await inner.compute(ids, tag)
        const ms = delay()
        if (ms > 0) await sleep(ms)
        return r
      },
      probe: async (scene: Scene, change: { objects?: Id[]; tokens?: Id[] }, sets: Id[][]) => {
        log?.push("probe")
        const r = await inner.probe(scene, change, sets)
        const ms = probeDelay()
        if (ms > 0) await sleep(ms)
        log?.push("probe done")
        return r
      },
    }
  }
}

/**
 * A vision "worker" that handles messages strictly one after another (like a real worker) and spends
 * `probeMs` on each step probe; records the ops in posting order.
 */
class SerialWorker implements WorkerLike {
  private readonly core = new VisionWorkerCore()
  private readonly listeners = new Map<string, Set<(ev: Event) => void>>()
  private readonly queue: VisionRequest[] = []
  private busy = false
  private readonly probeMs: number
  readonly ops: string[] = []
  probesDone = 0

  constructor(probeMs: number) {
    this.probeMs = probeMs
  }

  postMessage(message: unknown): void {
    const req = structuredClone(message) as VisionRequest
    this.ops.push(req.op)
    this.queue.push(req)
    this.pump()
  }

  private pump(): void {
    if (this.busy) return
    const req = this.queue.shift()
    if (!req) return
    this.busy = true
    setTimeout(
      () => {
        const res = this.core.handle(req)
        if (req.op === "probe") this.probesDone++
        const data = structuredClone(res, { transfer: responseTransferables(res) })
        for (const l of [...(this.listeners.get("message") ?? [])]) l({ data } as unknown as Event)
        this.busy = false
        this.pump()
      },
      req.op === "probe" ? this.probeMs : 0
    )
  }

  addEventListener(type: string, listener: (ev: Event) => void): void {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(listener)
  }

  removeEventListener(type: string, listener: (ev: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  terminate(): void {}
}

/** Dark 12×5 hall: a wall along z = 10 with a closed door at x = 27.5; Eve (darkvision 10 ft) in row 2, Fay far east. */
function hall() {
  const { scene, ground } = flatScene(12, 5, "dark")
  const wall = add(scene, createWall(ground, { x: 0, z: 10 }, { x: 60, z: 10 }))
  const door = add(scene, createDoor(wall, 27.5))
  const eve = addToken(scene, ground, 7.5, 12.5, { name: "Eve", vision: { darkvision: 10, blindsight: 0, blind: false } })
  const fay = addToken(scene, ground, 57.5, 22.5, { name: "Fay" })
  return { scene, ground, door, eve, fay }
}

async function hosted(scene: Scene, players: string[], extra: Parameters<typeof startHost>[1] = {}) {
  const fx = await fixture(scene, players)
  const { host: h, logs } = host(fx, extra)
  await h.start()
  expect(h.getSnapshot().status).toBe("hosting")
  return { fx, h, logs }
}

describe("host runner — joining and syncing", () => {
  it("links every member, pushes snapshots, and patches that apply cleanly", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1, P2])
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    h.dispatch({ t: "assign-token", tokenId: k.bo.id, userId: P2, assigned: true })
    const m1 = mirror(fx, P1)
    const m2 = mirror(fx, P2)
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
    const snap = h.getSnapshot()
    expect(snap.members.map((m) => [m.userId, m.status, m.linked])).toEqual([
      [P1, "active", true],
      [P2, "active", true],
    ])
    expect(Object.keys(snap.state!.players).sort()).toEqual([P1, P2].sort())
    expect(m1.view!.controlledTokenIds).toEqual([k.ada.id])
    expect(m1.view!.tokens[k.ada.id].name).toBe("Ada Lovelace")
    // Other players' tokens: label only.
    expect(m1.view!.tokens[k.bo.id]).toMatchObject({ label: "Bo" })
    expect(m1.view!.tokens[k.bo.id].name).toBeUndefined()
    expect(playerViewSchema.parse(m1.view)).toEqual(m1.view)
    expect(m1.applyErrors).toEqual([])
    // The host broadcasts its status (epoch + scene name) on the host topic.
    await waitFor(() => m1.broadcasts.some((b) => b.t === "status" && b.epoch === snap.epoch && b.sceneName === "The Keep"), "status broadcast")

    // DM moves a token: both mirrors apply patches (baseSeq chain) and stay identical to the host.
    const seq0 = m1.seq
    h.dispatch({ t: "move-token", tokenId: k.bo.id, levelId: k.ground, x: 12.5, z: 22.5 })
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
    expect(m1.seq).toBeGreaterThan(seq0)
    expect(m1.view!.tokens[k.bo.id].position).toEqual({ x: 12.5, z: 22.5 })
    expect(m1.messages.filter((m) => m.t === "snapshot").length).toBeGreaterThanOrEqual(1)
    expect(m1.applyErrors).toEqual([])
  })

  it("answers hello: sync when in step, one concatenated catch-up patch after losses", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1])
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])

    const before = m.messages.length
    await m.hello()
    await waitFor(() => m.messages.slice(before).some((x) => x.t === "sync"), "sync reply")

    // Lose two patches, then say hello with the old seq.
    m.dropPatches = 2
    const lostFrom = m.seq
    h.dispatch({ t: "move-token", tokenId: k.bo.id, levelId: k.ground, x: 12.5, z: 12.5 })
    await waitFor(() => h.debugPlayer(P1)!.seq === lostFrom + 1 && h.debugIdle(), "first patch")
    h.dispatch({ t: "move-token", tokenId: k.ada.id, levelId: k.ground, x: 22.5, z: 17.5 })
    await waitFor(() => h.debugPlayer(P1)!.seq === lostFrom + 2 && h.debugIdle(), "second patch")
    await sleep(30)
    expect(m.seq).toBe(lostFrom)
    const mark = m.messages.length
    await m.hello()
    await settle(h, [[P1, m]])
    const replies = m.messages.slice(mark)
    const catchUp = replies.find((x) => x.t === "patch" && x.baseSeq === lostFrom)
    expect(catchUp).toMatchObject({ t: "patch", baseSeq: lostFrom, seq: lostFrom + 2 })
    expect(replies.some((x) => x.t === "snapshot")).toBe(false)
    expect(m.view!.tokens[k.ada.id].position).toEqual({ x: 22.5, z: 17.5 })
  })

  it("sends big snapshots through the database (snapshot_ready)", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1], { maxSnapshotBytes: 600 })
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    expect(m.messages.some((x) => x.t === "snapshot_ready")).toBe(true)
    expect(m.messages.some((x) => x.t === "snapshot")).toBe(false)
    const row = await fx.repoOf(P1).loadPlayerView(fx.sessionId, P1)
    expect(row?.epoch).toBe(h.getSnapshot().epoch)
    expect(row?.view).toEqual(m.view)
  })

  it("persists state and views; a restarted host resyncs players under a new epoch", async () => {
    const c = corridor()
    const fx = await fixture(c.scene, [P1])
    const a = host(fx).host
    await a.start()
    a.dispatch({ t: "assign-token", tokenId: c.eve.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(a, [[P1, m]])
    const reqId = m.move(c.eve.id, walk(c.ground, [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1]]))
    await waitFor(() => m.result(reqId) !== undefined, "move result")
    await settle(a, [[P1, m]])
    expect(m.explored(c.ground, 3, 1)).toBe(true)
    const epochA = a.getSnapshot().epoch!
    await a.stop()
    expect(a.getSnapshot().status).toBe("standby")

    const b = host(fx).host
    await b.start()
    expect(b.getSnapshot().status).toBe("hosting")
    const epochB = b.getSnapshot().epoch!
    expect(epochB).not.toBe(epochA)
    expect(b.debugHostEpoch).toBeGreaterThan(Number(epochA.split(".")[0]))
    // The restored game: ownership, position and exploration survive.
    expect(b.getSnapshot().state!.owners[c.eve.id]).toEqual([P1])
    await settle(b, [[P1, m]])
    expect(m.epoch).toBe(epochB)
    expect(m.view!.tokens[c.eve.id].position).toEqual({ x: 27.5, z: 7.5 })
    expect(m.explored(c.ground, 3, 1)).toBe(true)
    expect(m.applyErrors).toEqual([])
  })
})

describe("host runner — requests", () => {
  it("moves: legal prefix, per-step exploration, masked reasons, ownership", async () => {
    const c = corridor()
    const { fx, h } = await hosted(c.scene, [P1, P2])
    h.dispatch({ t: "assign-token", tokenId: c.eve.id, userId: P1, assigned: true })
    h.dispatch({ t: "assign-token", tokenId: c.fay.id, userId: P2, assigned: true })
    const m1 = mirror(fx, P1)
    const m2 = mirror(fx, P2)
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
    // From (1, 1) with 10 ft darkvision, (4, 1) is 15 ft away: not perceived at the start.
    expect(m1.explored(c.ground, 4, 1)).toBe(false)

    // Walk east into the wall at x = 45: the legal prefix (to (8, 1)) is applied.
    const path = walk(c.ground, [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1]])
    const r1 = m1.move(c.eve.id, path)
    await waitFor(() => m1.result(r1) !== undefined, "move result")
    expect(m1.result(r1)).toEqual({ reqId: r1, ok: false, applied: 7, reason: "blocked" })
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
    expect(m1.view!.tokens[c.eve.id].position).toEqual({ x: 42.5, z: 7.5 })
    // The result travelled in the same patch as the move.
    const withResult = m1.messages.find((x) => x.t === "patch" && x.results?.some((r) => r.reqId === r1))
    expect(withResult && withResult.t === "patch" && withResult.ops.some((op) => op.path[0] === "tokens")).toBe(true)
    // Cells seen only from intermediate steps are explored (15+ ft from both ends).
    expect(m1.explored(c.ground, 4, 1)).toBe(true)
    expect(m1.explored(c.ground, 5, 1)).toBe(true)
    // Fay's player never learns about Eve's corridor.
    expect(m2.explored(c.ground, 4, 1)).toBe(false)

    // Corner cutting in the dark, unperceived: reported as "blocked".
    const r2 = m2.move(c.fay.id, walk(c.ground, [[12, 1], [13, 2]]))
    await waitFor(() => m2.result(r2) !== undefined, "corner result")
    expect(m2.result(r2)).toEqual({ reqId: r2, ok: false, applied: 0, reason: "blocked" })
    // Not the player's token.
    const r3 = m2.move(c.eve.id, walk(c.ground, [[8, 1], [7, 1]]))
    await waitFor(() => m2.result(r3) !== undefined, "not-owner result")
    expect(m2.result(r3)).toEqual({ reqId: r3, ok: false, reason: "not-owner" })
    // Garbage and forged payloads are dropped silently.
    await m2.ch.req.send({ t: "move", reqId: "x", tokenId: c.fay.id, path: [], userId: P1 } as never)
    await m2.ch.req.send({ t: "teleport" } as never)
    await sleep(50)
    expect(m2.results.map((r) => r.reqId).includes("x")).toBe(false)
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
  })

  it("moves in the light report precise reasons", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1])
    h.dispatch({ t: "assign-token", tokenId: k.bo.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    const r = m.move(k.bo.id, walk(k.ground, [[1, 1], [2, 2]]))
    await waitFor(() => m.result(r) !== undefined, "result")
    expect(m.result(r)).toEqual({ reqId: r, ok: false, applied: 0, reason: "corner-cutting" })
    const ok = m.move(k.bo.id, walk(k.ground, [[1, 1], [1, 2], [2, 2], [3, 2]]))
    await waitFor(() => m.result(ok) !== undefined, "result")
    expect(m.result(ok)).toEqual({ reqId: ok, ok: true, applied: 3 })
    await settle(h, [[P1, m]])
    expect(m.view!.tokens[k.bo.id].position).toEqual({ x: 17.5, z: 12.5 })
  })

  it("doors: open when adjacent, locked stays locked, far ones cannot; the view follows", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1, P2])
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    h.dispatch({ t: "assign-token", tokenId: k.bo.id, userId: P2, assigned: true })
    const m1 = mirror(fx, P1)
    const m2 = mirror(fx, P2)
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
    expect((m1.view!.objects[k.door.id] as PlayerDoor).state).toBe("closed")
    expect(m1.view!.tokens[k.goblin.id]).toBeUndefined()

    const locked = m1.door(k.locked.id, "open")
    const far = m2.door(k.door.id, "open")
    await waitFor(() => m1.result(locked) !== undefined && m2.result(far) !== undefined, "door results")
    expect(m1.result(locked)).toEqual({ reqId: locked, ok: false, reason: "locked" })
    expect(m2.result(far)).toEqual({ reqId: far, ok: false, reason: "cannot" })

    const open = m1.door(k.door.id, "open")
    await waitFor(() => m1.result(open) !== undefined, "open result")
    expect(m1.result(open)).toEqual({ reqId: open, ok: true })
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
    expect((m1.view!.objects[k.door.id] as PlayerDoor).state).toBe("open")
    expect(h.getSnapshot().state!.scene.objects[k.door.id]).toMatchObject({ state: "open" })
    // Through the open door Ada sees the goblin — by label only.
    expect(m1.view!.tokens[k.goblin.id]).toMatchObject({ label: "Goblin" })
    // Through it she walks.
    const walkThrough = m1.move(k.ada.id, walk(k.ground, [[5, 3], [6, 3], [7, 3], [8, 3]]))
    await waitFor(() => m1.result(walkThrough) !== undefined, "walk result")
    expect(m1.result(walkThrough)).toEqual({ reqId: walkThrough, ok: true, applied: 3 })
  })

  it("rate-limits request floods", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1])
    h.dispatch({ t: "assign-token", tokenId: k.bo.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    for (let n = 0; n < 40; n++) m.door(k.door.id, "open")
    let last = -1
    let stableSince = Date.now()
    await waitFor(() => {
      if (m.results.length !== last) {
        last = m.results.length
        stableSince = Date.now()
      }
      return Date.now() - stableSince > 150
    }, "results settle")
    const limited = m.results.filter((r) => r.reason === "rate-limited").length
    const handled = m.results.filter((r) => r.reason === "cannot").length
    // Burst 16 (hellos have their own budget; a little refill while the flood arrives); the rest is
    // refused, and only a few refusals are answered (2/s, burst 4): the others are dropped silently.
    expect(handled).toBeGreaterThanOrEqual(15)
    expect(handled).toBeLessThanOrEqual(19)
    expect(limited).toBeGreaterThanOrEqual(1)
    expect(limited).toBeLessThanOrEqual(6)
    expect(m.results.length).toBeLessThanOrEqual(handled + 6)
  })

  it("bounds hello floods: at most a few snapshots, no backlog, later hellos still answered", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1])
    h.dispatch({ t: "assign-token", tokenId: k.bo.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    const snapshots = () => m.messages.filter((x) => x.t === "snapshot").length
    const before = snapshots()
    for (let n = 0; n < 40; n++) void m.ch.req.send({ t: "hello", nonce: `flood-${n}`, epoch: null, lastSeq: null })
    await sleep(300)
    const during = snapshots() - before
    // Burst 4 of the hello budget; the queued one coalesces the rest (latest wins).
    expect(during).toBeGreaterThanOrEqual(1)
    expect(during).toBeLessThanOrEqual(5)
    // Nothing trickles in afterwards (no queue of 40 snapshots behind the flood).
    await sleep(700)
    expect(snapshots() - before).toBe(during)
    // Refilled: a hello 2 s later is answered.
    await sleep(1000)
    const mark = m.messages.length
    await m.hello()
    await waitFor(() => m.messages.slice(mark).some((x) => x.t === "sync" || x.t === "snapshot"), "answer after the flood")
  })

  it("allows one in-flight move per token", async () => {
    const k = keep()
    let delay = 0
    const { fx, h } = await hosted(k.scene, [P1], { createVisionClient: slowVision(() => delay) })
    h.dispatch({ t: "assign-token", tokenId: k.bo.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    delay = 150
    const a = m.move(k.bo.id, walk(k.ground, [[1, 1], [1, 2]]))
    await sleep(30)
    // The first move's result is still on its way (its vision pass is slow): refused.
    const b = m.move(k.bo.id, walk(k.ground, [[1, 2], [1, 3]]))
    await waitFor(() => m.result(a) !== undefined && m.result(b) !== undefined, "move results")
    expect(m.result(a)).toMatchObject({ ok: true, applied: 1 })
    expect(m.result(b)).toMatchObject({ ok: false, reason: "rate-limited" })
    delay = 0
    await settle(h, [[P1, m]])
    const c = m.move(k.bo.id, walk(k.ground, [[1, 2], [1, 3]]))
    await waitFor(() => m.result(c) !== undefined, "third move")
    expect(m.result(c)).toMatchObject({ ok: true, applied: 1 })
  })
})

describe("host runner — step probes", () => {
  it("answers a long move before evaluating its intermediate steps; their exploration follows", async () => {
    const c = corridor()
    const worker = new SerialWorker(60)
    const { fx, h } = await hosted(c.scene, [P1], { createVisionClient: () => createWorkerVisionClient(worker) })
    h.dispatch({ t: "assign-token", tokenId: c.eve.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    const mark = worker.ops.length
    const r = m.move(c.eve.id, walk(c.ground, [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1]]))
    await waitFor(() => m.result(r) !== undefined, "move result")
    // The result did not wait for the six step probes (60 ms each).
    expect(worker.probesDone).toBeLessThan(6)
    expect(m.result(r)).toMatchObject({ ok: true, applied: 7 })
    await settle(h, [[P1, m]])
    const ops = worker.ops.slice(mark)
    const probes = ops.flatMap((op, k) => (op === "probe" ? [k] : []))
    expect(probes).toHaveLength(6)
    // The mover's final-view compute went to the worker before the second probe.
    expect(ops.indexOf("compute")).toBeGreaterThanOrEqual(0)
    expect(ops.indexOf("compute")).toBeLessThan(probes[1])
    // Exploration from the intermediate steps arrived in a follow-up patch.
    expect(m.explored(c.ground, 4, 1)).toBe(true)
    expect(m.explored(c.ground, 5, 1)).toBe(true)
  })

  it("another player's short move does not wait for a long move's step backlog", async () => {
    const c = corridor()
    const worker = new SerialWorker(150)
    const { fx, h } = await hosted(c.scene, [P1, P2], { createVisionClient: () => createWorkerVisionClient(worker) })
    h.dispatch({ t: "assign-token", tokenId: c.eve.id, userId: P1, assigned: true })
    h.dispatch({ t: "assign-token", tokenId: c.fay.id, userId: P2, assigned: true })
    const m1 = mirror(fx, P1)
    const m2 = mirror(fx, P2)
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
    const long = m1.move(c.eve.id, walk(c.ground, [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1]]))
    await waitFor(() => m1.result(long) !== undefined, "long move result")
    const t0 = Date.now()
    const short = m2.move(c.fay.id, walk(c.ground, [[12, 1], [11, 1]]))
    await waitFor(() => m2.result(short) !== undefined, "short move result")
    // Six probes × 150 ms are queued; the short move waited for at most the one in flight.
    expect(Date.now() - t0).toBeLessThan(500)
    expect(m2.result(short)).toMatchObject({ ok: true, applied: 1 })
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
  })

  it("discards steps evaluated after a door opened or the fog was reset", async () => {
    const hl = hall()
    const worker = new SerialWorker(80)
    const { fx, h } = await hosted(hl.scene, [P1], { createVisionClient: () => createWorkerVisionClient(worker) })
    h.dispatch({ t: "assign-token", tokenId: hl.eve.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    const path = walk(hl.ground, [[1, 2], [2, 2], [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [9, 2], [10, 2]])
    // Past the closed door; the DM opens it while the steps are still being evaluated.
    const r = m.move(hl.eve.id, path)
    await waitFor(() => m.result(r) !== undefined, "move result")
    expect(worker.probesDone).toBeLessThan(4)
    h.dispatch({ t: "set-door", doorId: hl.door.id, state: "open" })
    await settle(h, [[P1, m]])
    // Cell (5, 1), behind the door, would only have been seen from the step next to the door — with
    // the door open, which it was not when Eve walked past.
    expect(m.explored(hl.ground, 5, 1)).toBe(false)
    expect(m.explored(hl.ground, 10, 2)).toBe(true)

    // Walk back past the (now open) door, then reset the fog while the steps are evaluated.
    const back = m.move(hl.eve.id, [...path].reverse())
    await waitFor(() => m.result(back) !== undefined, "move back")
    h.dispatch({ t: "reset-fog", userId: P1 })
    await settle(h, [[P1, m]])
    // Refilled from what Eve sees now only; nothing from the steps before the reset.
    expect(m.explored(hl.ground, 5, 2)).toBe(false)
    expect(m.explored(hl.ground, 5, 1)).toBe(false)
    expect(m.explored(hl.ground, 1, 2)).toBe(true)
  })
})

describe("host runner — in-flight moves", () => {
  it("a player moving someone else's token learns nothing about its owner's move in flight", async () => {
    const k = keep()
    let delay = 0
    const { fx, h } = await hosted(k.scene, [P1, P2], { createVisionClient: slowVision(() => delay) })
    h.dispatch({ t: "assign-token", tokenId: k.bo.id, userId: P1, assigned: true })
    const m1 = mirror(fx, P1)
    const m2 = mirror(fx, P2)
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
    delay = 150
    const own = m1.move(k.bo.id, walk(k.ground, [[1, 1], [1, 2]]))
    await sleep(30)
    // Bo's move is in flight: the owner is told to wait, anyone else only that it is not theirs.
    const probe = m2.move(k.bo.id, walk(k.ground, [[1, 2], [1, 3]]))
    const again = m1.move(k.bo.id, walk(k.ground, [[1, 2], [1, 3]]))
    await waitFor(() => [own, again].every((r) => m1.result(r) !== undefined) && m2.result(probe) !== undefined, "results")
    expect(m2.result(probe)).toEqual({ reqId: probe, ok: false, reason: "not-owner" })
    expect(m1.result(again)).toMatchObject({ ok: false, reason: "rate-limited" })
    delay = 0
  })
})

describe("host runner — saving the map to the library", () => {
  async function librarySession() {
    const k = keep()
    const fx = await fixture(k.scene, [P1])
    const scenes = createLocalScenesRepo(fx.store)
    const sceneId = (await fx.dmRepo.listMySessions()).find((s) => s.id === fx.sessionId)!.sceneId!
    const { host: h } = host(fx, { scenes })
    await h.start()
    return { k, fx, h, scenes, sceneId }
  }

  it("seeds the origin, saves a new version and clears the dirty flag", async () => {
    const { k, h, scenes, sceneId } = await librarySession()
    expect(h.getSnapshot().library).toEqual({ sceneId, version: 1, dirty: false })
    // An edit in "Edit map" marks the live map as changed.
    h.applyScenePatches([{ op: "replace", path: ["objects", k.door.id, "state"], value: "open" }])
    await waitFor(() => h.getSnapshot().library?.dirty === true, "dirty")
    const v = await h.saveMapToLibrary()
    expect(v).toBe(2)
    expect(h.getSnapshot().library).toEqual({ sceneId, version: 2, dirty: false })
    const saved = await scenes.load(sceneId)
    expect(saved.version).toBe(2)
    expect(saved.parsed.ok && saved.parsed.scene.objects[k.door.id]).toMatchObject({ state: "open" })
    // The origin is part of the saved game (a reloaded host keeps it).
    await h.save()
    await h.stop()
  })

  it("refuses to overwrite a newer library version unless forced; works after the session ended", async () => {
    const { h, scenes, sceneId, fx } = await librarySession()
    // The DM saved the scene from the editor meanwhile.
    const loaded = await scenes.load(sceneId)
    if (!loaded.parsed.ok) throw new Error("fixture")
    await scenes.saveVersion(sceneId, loaded.parsed.scene)
    await expect(h.saveMapToLibrary()).rejects.toMatchObject({ code: "version_conflict" })
    await h.endSession()
    expect(h.getSnapshot().status).toBe("ended")
    expect(await h.saveMapToLibrary({ force: true })).toBe(3)
    expect(h.getSnapshot().library).toMatchObject({ version: 3, dirty: false })
    // A deleted library scene: nothing to save to.
    await scenes.remove(sceneId)
    await expect(h.saveMapToLibrary({ force: true })).rejects.toMatchObject({ code: "not_found" })
    void fx
  })
})

describe("host runner — stored player views", () => {
  it("stores the view soon after an assignment or a move, not on the 5 s throttle", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1, P2], { timing: { ...TEST_TIMING, viewSaveIntervalMs: 5000, moveSaveGapMs: 50 } })
    const m1 = mirror(fx, P1)
    const m2 = mirror(fx, P2)
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
    const row = () => fx.repoOf(P1).loadPlayerView(fx.sessionId, P1)
    const t0 = Date.now()
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
    let stored = await row()
    for (let n = 0; n < 100 && (!stored || stored.seq !== m1.seq); n++) {
      await sleep(10)
      stored = await row()
    }
    expect(stored?.seq).toBe(m1.seq)
    expect(stored?.view.controlledTokenIds).toEqual([k.ada.id])
    expect(Date.now() - t0).toBeLessThan(1000)
    // The player's own move: stored soon as well.
    const r = m1.move(k.ada.id, walk(k.ground, [[5, 3], [4, 3]]))
    await waitFor(() => m1.result(r) !== undefined, "move")
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
    for (let n = 0; n < 100 && (!stored || stored.seq !== m1.seq); n++) {
      await sleep(10)
      stored = await row()
    }
    expect(stored?.seq).toBe(m1.seq)
    expect(stored?.view.tokens[k.ada.id].position).toEqual({ x: 22.5, z: 17.5 })
    // Only another token moving in view (Bo, P2's): no early save.
    h.dispatch({ t: "assign-token", tokenId: k.bo.id, userId: P2, assigned: true })
    await sleep(200)
    const before = (await row())!.seq
    h.dispatch({ t: "move-token", tokenId: k.bo.id, levelId: k.ground, x: 12.5, z: 12.5 })
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
    expect(m1.view!.tokens[k.bo.id].position).toEqual({ x: 12.5, z: 12.5 })
    await sleep(300)
    expect((await row())!.seq).toBe(before)
  })
})

describe("host runner — link rejoins and lost results", () => {
  async function linked() {
    const k = keep()
    const fx = await fixture(k.scene, [P1])
    const ht = fx.newTransport()
    const { host: h } = host(fx, { transport: ht })
    await h.start()
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    const dropLink = (rejoinMs: number, which: RegExp = new RegExp(`:(view|req):${P1}$`)) => ht.simulateDrop((topic) => which.test(topic), rejoinMs)
    return { k, fx, h, m, dropLink }
  }

  it("a host-side rejoin with nothing changed sends sync, not a snapshot", async () => {
    const { h, m, dropLink } = await linked()
    const view = m.view
    const mark = m.messages.length
    dropLink(80)
    await sleep(200)
    await settle(h, [[P1, m]])
    const after = m.messages.slice(mark).map((x) => x.t)
    expect(after).toContain("sync")
    expect(after).not.toContain("snapshot")
    expect(m.view).toBe(view)
  })

  it("changes made while the link was down arrive as one catch-up patch", async () => {
    const { k, h, m, dropLink } = await linked()
    const mark = m.messages.length
    dropLink(150)
    await sleep(20)
    h.dispatch({ t: "move-token", tokenId: k.ada.id, levelId: k.ground, x: 22.5, z: 17.5 })
    await sleep(250)
    await settle(h, [[P1, m]])
    const after = m.messages.slice(mark)
    expect(after.some((x) => x.t === "snapshot")).toBe(false)
    expect(after.filter((x) => x.t === "patch")).toHaveLength(1)
    expect(m.view!.tokens[k.ada.id].position).toEqual({ x: 22.5, z: 17.5 })
  })

  it("a move whose result could not be sent is still answered after the rejoin", async () => {
    const { k, h, m, dropLink } = await linked()
    // The view channel drops; the request still reaches the host.
    dropLink(150, new RegExp(`:view:${P1}$`))
    await sleep(20)
    const r = m.move(k.ada.id, walk(k.ground, [[5, 3], [4, 3]]))
    await waitFor(() => m.result(r) !== undefined, "result after the rejoin", 3000)
    expect(m.result(r)).toMatchObject({ ok: true, applied: 1 })
    await settle(h, [[P1, m]])
    expect(m.view!.tokens[k.ada.id].position).toEqual({ x: 22.5, z: 17.5 })
  })

  it("re-delivers the results of a lost patch with the catch-up", async () => {
    const { k, h, m } = await linked()
    m.dropPatches = 1
    const r = m.move(k.ada.id, walk(k.ground, [[5, 3], [4, 3]]))
    await waitFor(() => h.debugIdle() && h.debugPlayer(P1)!.seq === m.seq + 1, "patch sent (and lost)")
    expect(m.result(r)).toBeUndefined()
    // The client's pending timeout → hello with its old seq.
    const mark = m.messages.length
    await m.hello()
    await settle(h, [[P1, m]])
    const catchUp = m.messages.slice(mark).find((x) => x.t === "patch")
    expect(catchUp && catchUp.t === "patch" && catchUp.results?.map((x) => x.reqId)).toEqual([r])
    expect(m.result(r)).toMatchObject({ ok: true, applied: 1 })
  })
})

describe("host runner — membership and hosting", () => {
  it("a kicked player gets {t:'kicked'} and nothing further", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1, P2])
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    h.dispatch({ t: "assign-token", tokenId: k.bo.id, userId: P2, assigned: true })
    const m1 = mirror(fx, P1)
    const m2 = mirror(fx, P2)
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
    await h.kick(P2)
    await waitFor(() => m2.kicked, "kicked message")
    const count = m2.messages.length
    expect(h.getSnapshot().members.find((m) => m.userId === P2)?.status).toBe("kicked")
    expect(h.getSnapshot().state!.players[P2]).toBeUndefined()
    // Later changes and requests: P1 keeps playing, P2 hears nothing.
    h.dispatch({ t: "move-token", tokenId: k.ada.id, levelId: k.ground, x: 22.5, z: 22.5 })
    await m2.hello()
    m2.move(k.bo.id, walk(k.ground, [[1, 1], [1, 2]]))
    await settle(h, [[P1, m1]])
    await sleep(100)
    expect(m2.messages.length).toBe(count)
    expect(m1.view!.tokens[k.ada.id].position).toEqual({ x: 22.5, z: 22.5 })
    // The session repo agrees (re-joining is refused).
    await expect(fx.repoOf(P2).joinSession(fx.roomCode, "Again")).rejects.toThrow(/kicked/)
  })

  it("links members who join later (lobby presence triggers a re-read)", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1])
    const m1 = mirror(fx, P1)
    await settle(h, [[P1, m1]])
    await fx.repoOf(P3).joinSession(fx.roomCode, "Late Larry")
    const m3 = mirror(fx, P3)
    await waitFor(() => h.getSnapshot().members.some((m) => m.userId === P3 && m.linked), "late member linked")
    await settle(h, [
      [P1, m1],
      [P3, m3],
    ])
    expect(h.getSnapshot().state!.players[P3]).toMatchObject({ displayName: "Late Larry" })
    await waitFor(() => h.getSnapshot().members.find((m) => m.userId === P3)?.online === true, "presence")
  })

  it("a host that sees a newer epoch stands down; players follow the new host", async () => {
    const k = keep()
    const fx = await fixture(k.scene, [P1])
    const a = host(fx).host
    await a.start()
    a.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(a, [[P1, m]])
    await a.save()
    // Another device starts hosting (no shared browser lock): claim_host bumps the epoch.
    const b = host(fx).host
    await b.start()
    await waitFor(() => a.getSnapshot().status === "standby", "old host stands down")
    expect(a.getSnapshot().error).toMatch(/took over/)
    await settle(b, [[P1, m]])
    expect(m.epoch).toBe(b.getSnapshot().epoch)
    // The stale host's writes are refused by the fence.
    await expect(fx.dmRepo.saveSessionState(fx.sessionId, 1, a.getSnapshot().state!)).rejects.toThrow(/stale_epoch/)
  })

  it("a failed fenced write stops hosting and offers takeOver()", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1])
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    // Someone claims the session without being seen on the host topic.
    await fx.dmRepo.claimHost(fx.sessionId)
    await expect(h.save()).rejects.toBeInstanceOf(NetError)
    await waitFor(() => h.getSnapshot().status === "standby", "standby after stale write")
    // Players see the DM go away (host presence) — and come back after takeOver.
    await waitFor(() => !m.ch.host.hostOnline(), "host offline")
    await h.takeOver()
    expect(h.getSnapshot().status).toBe("hosting")
    await settle(h, [[P1, m]])
    await waitFor(() => m.ch.host.hostOnline(), "host online again")
  })

  it("one host per browser: a second tab waits in standby until it takes over", async () => {
    const k = keep()
    const fx = await fixture(k.scene, [P1])
    const a = host(fx, { locks: undefined }).host
    await a.start()
    expect(a.getSnapshot().status).toBe("hosting")
    const b = host(fx, { locks: undefined }).host
    await b.start()
    expect(b.getSnapshot().status).toBe("standby")
    expect(b.getSnapshot().error).toMatch(/another tab/)
    await b.takeOver()
    expect(b.getSnapshot().status).toBe("hosting")
    await waitFor(() => a.getSnapshot().status === "standby", "first tab stands down")
    const m = mirror(fx, P1)
    await settle(b, [[P1, m]])
  })

  it("ending the session tells everyone", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1])
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    await h.endSession()
    expect(h.getSnapshot().status).toBe("ended")
    await waitFor(() => m.broadcasts.some((b) => b.t === "ended"), "ended broadcast")
    expect(await fx.dmRepo.sessionInfo(fx.sessionId)).toMatchObject({ status: "ended" })
  })

  it("DM commands flow to players; urgent saves after visibility-reducing edits", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1], { timing: { saveIntervalMs: 60_000, urgentSaveGapMs: 10 } })
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    h.dispatch({ t: "set-movement-locked", locked: true })
    await settle(h, [[P1, m]])
    expect(m.view!.flags.movementLocked).toBe(true)
    const r = m.move(k.ada.id, walk(k.ground, [[5, 3], [4, 3]]))
    await waitFor(() => m.result(r) !== undefined, "locked move")
    expect(m.result(r)).toMatchObject({ ok: false, reason: "movement-locked" })
    // Hide Bo through an editor patch: saved right away (despite the 60 s throttle) and gone for P1.
    const lastSave = h.getSnapshot().stats.lastSaveAt
    h.applyScenePatches([{ op: "replace", path: ["tokens", k.bo.id, "hidden"], value: true }])
    await settle(h, [[P1, m]])
    expect(m.view!.tokens[k.bo.id]).toBeUndefined()
    await waitFor(() => h.getSnapshot().stats.lastSaveAt !== lastSave, "urgent save")
    const saved = await fx.dmRepo.loadSessionState(fx.sessionId)
    expect(saved?.content.kind).toBe("game")
    const savedState = saved?.content.kind === "game" ? (saved.content.state as { scene: Scene }) : null
    expect(savedState?.scene.tokens[k.bo.id].hidden).toBe(true)
    // Unknown targets are no-ops with an error.
    expect(h.dispatch({ t: "set-door", doorId: "nope", state: "open" })?.error).toBeTruthy()
    // Preview vision for the DM (no knowledge update).
    const vis = await h.previewVisibility([k.goblin.id])
    expect(Object.keys(vis.perception)).toEqual([k.ground])
  })
})

describe("host runner — backdrop tiles", () => {
  const withBackdrop = () => {
    const k = keep()
    k.scene.assets = { map: { id: "map", kind: "image", name: "Keep map", mime: "image/webp", width: 140, height: 80, bytes: 1234 } }
    k.scene.levels[k.ground].backdrop = { assetId: "map", rect: { x: 0, z: 0, w: 70, d: 40 }, opacity: 0.9, tintWalls: true }
    return k
  }
  const codec: TileCodec = {
    decode: async () => ({ width: 140, height: 80 }),
    encodeChunk: async (_i, parts, size) => new Blob([`${size}:${parts.length}`]),
    release: () => {},
  }
  /** Explored backdrop cells of a view that no announced chunk holds yet. */
  const unannounced = (m: Mirror, view: PlayerView, levelId: string): string[] => {
    const out: string[] = []
    const ex = view.masks[levelId]?.explored
    if (!ex) return out
    const mask = decodeMask(ex)
    // The backdrop covers cells 0..13 × 0..7.
    for (let j = 0; j < 8; j++) for (let i = 0; i < 14; i++) if (cellTouched(mask, j * ex.width + i) && !m.hasTile(levelId, i, j)) out.push(`${i},${j}`)
    return out
  }

  it("uploads each player's explored cells in chunks and announces them before the views revealing them", async () => {
    const k = withBackdrop()
    const assets = recordingAssets("supabase")
    const late: string[] = []
    let checkedViews = 0
    const fx = await fixture(k.scene, [P1])
    const { host: h } = host(fx, { assets: assets.store, tileCodec: codec })
    await h.start()
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    const m: Mirror = mirror(fx, P1, {
      onView: (view) => {
        checkedViews++
        late.push(...unannounced(m, view, k.ground))
      },
    })
    await settle(h, [[P1, m]])
    expect(m.view!.backdrops).toEqual({ [k.ground]: { rect: { x: 0, z: 0, w: 70, d: 40 }, opacity: 0.9, tintWalls: true, tilePx: 10 } })
    const first = assets.uploads.length
    expect(first).toBeGreaterThan(0)
    // Every chunk object belongs to P1 and holds exactly the cells announced for it.
    for (const [key, text] of assets.chunks) {
      const [uid, levelId, at] = key.split("|")
      expect(uid).toBe(P1)
      const mask = m.tiles.get(levelId)?.get(at) ?? 0
      expect(text).toBe(`40:${mask.toString(2).split("").filter((b) => b === "1").length}`)
    }
    // Open the door and walk through: new cells, new chunks, still announced in time.
    const open = m.door(k.door.id, "open")
    await waitFor(() => m.result(open) !== undefined, "door")
    await settle(h, [[P1, m]])
    const r = m.move(k.ada.id, walk(k.ground, [[5, 3], [6, 3], [7, 3], [8, 3], [9, 3]]))
    await waitFor(() => m.result(r) !== undefined, "walk")
    await settle(h, [[P1, m]])
    expect(assets.uploads.length).toBeGreaterThan(first)
    expect(checkedViews).toBeGreaterThan(2)
    expect(late).toEqual([])
    // A new client instance (reload) learns every chunk from the table sent with its snapshot.
    const m2 = mirror(fx, P1)
    await waitFor(() => m2.view !== null && m2.tiles.size > 0, "reloaded client")
    expect(unannounced(m2, m2.view!, k.ground)).toEqual([])
    // Ending the session removes the players' chunks.
    await h.endSession()
    await waitFor(() => assets.cleaned() === 1, "tiles removed")
  })

  it("never holds a view back for slow uploads: the chunks are announced when they land", async () => {
    const k = withBackdrop()
    const assets = recordingAssets("supabase", { delayMs: 300 })
    const fx = await fixture(k.scene, [P1])
    const { host: h } = host(fx, { assets: assets.store, tileCodec: codec, timing: { ...TEST_TIMING, tileWaitMs: 50 } })
    await h.start()
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    const t0 = Date.now()
    await waitFor(() => m.view?.controlledTokenIds.includes(k.ada.id) === true, "view")
    expect(Date.now() - t0).toBeLessThan(250)
    expect(m.tiles.get(k.ground)?.size ?? 0).toBe(0)
    await waitFor(() => (m.tiles.get(k.ground)?.size ?? 0) > 0 && unannounced(m, m.view!, k.ground).length === 0, "chunks announced", 5000)
    await h.stop()
  })
})

describe("host runner — leak test (The Crooked Lantern)", () => {
  it("players never receive hidden tokens, secret doors, DM names or notes", async () => {
    const scene = sampleById("crooked-lantern")!.build()
    const byName = (name: string) => Object.values(scene.objects).find((o) => o.name === name)!
    const tokenByName = (name: string) => Object.values(scene.tokens).find((t) => t.name === name)!
    const brunhild = tokenByName("Brunhild Ironvein")
    const pip = tokenByName("Pip Thistledown")
    const bandit = tokenByName("Bandit Lookout")
    const torch = byName("Bandit's torch")
    const secret = byName("Secret door (loose stones)")
    const { fx, h } = await hosted(scene, [P1, P2])
    h.dispatch({ t: "assign-token", tokenId: brunhild.id, userId: P1, assigned: true })
    h.dispatch({ t: "assign-token", tokenId: pip.id, userId: P2, assigned: true })
    const m1 = mirror(fx, P1)
    const m2 = mirror(fx, P2)
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
    // Brunhild steps out from behind the pillar and walks around the common room; Pip scouts.
    const g = brunhild.levelId
    const moves = [
      m1.move(brunhild.id, walk(g, [[14, 13], [14, 12], [15, 12], [16, 12]])),
      m2.move(pip.id, walk(pip.levelId, [[30, 9], [29, 9], [28, 9], [27, 9]])),
    ]
    await waitFor(() => m1.result(moves[0]) !== undefined && m2.result(moves[1]) !== undefined, "moves")
    const back = m1.move(brunhild.id, walk(g, [[16, 12], [15, 12], [14, 12], [13, 12], [12, 12]]))
    await waitFor(() => m1.result(back) !== undefined, "move back")
    // The DM moves the hidden bandit around and toggles its torch: still nothing for players.
    h.dispatch({ t: "move-token", tokenId: bandit.id, levelId: g, x: 77.5, z: 62.5 })
    h.dispatch({ t: "set-light", lightId: torch.id, on: false })
    h.dispatch({ t: "set-light", lightId: torch.id, on: true })
    h.dispatch({ t: "set-shared-vision", enabled: true })
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
    await h.save()
    const rows = await Promise.all([fx.repoOf(P1).loadPlayerView(fx.sessionId, P1), fx.repoOf(P2).loadPlayerView(fx.sessionId, P2)])
    for (const [m, row] of [
      [m1, rows[0]],
      [m2, rows[1]],
    ] as const) {
      const all = [...m.raw, JSON.stringify(row?.view ?? null)].join("\n")
      expect(m.raw.length).toBeGreaterThan(2)
      for (const id of [bandit.id, torch.id, secret.id]) expect(all).not.toContain(id)
      for (const s of ["dmNotes", "Old Moss", "Bandit", "barkeep has the key", "Pantry door", "Contraband", "secret", "loose stones", "attachedTokenId", "hidden", "blocksMovement"]) {
        expect(all, s).not.toContain(s)
      }
      expect(playerViewSchema.parse(m.view)).toEqual(m.view)
    }
    // Without shared vision earlier, P1 never learned Pip's name; with it on, it is allowed.
    const beforeShared = m1.raw.slice(0, m1.raw.findIndex((r) => r.includes('"sharedVision":true')))
    expect(beforeShared.join("\n")).not.toContain("Pip Thistledown")

    // Revealing the secret door to P1: sent as a wooden door, never as "secret".
    h.dispatch({ t: "reveal-object", objectId: secret.id, userId: P1 })
    await settle(h, [
      [P1, m1],
      [P2, m2],
    ])
    expect(m2.raw.join("\n")).not.toContain(secret.id)
    expect(m1.raw.join("\n")).not.toContain("secret")
  })
})

describe("host runner — stale visibility", () => {
  it("never pairs a visibility result with a newer scene revision", async () => {
    const k = keep()
    let delay = 0
    const { fx, h } = await hosted(k.scene, [P1], { createVisionClient: slowVision(() => delay) })
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    // A closed door with the goblin behind it in view would mean an open-door result was paired with
    // a closed-door state.
    const violations: string[] = []
    const m = mirror(fx, P1, {
      onView: (view) => {
        const door = view.objects[k.door.id] as PlayerDoor | undefined
        if (door?.state === "closed" && view.tokens[k.goblin.id]) violations.push(`seq ${JSON.stringify(door)}`)
      },
    })
    await settle(h, [[P1, m]])
    expect(m.view!.tokens[k.goblin.id]).toBeUndefined()
    for (let round = 0; round < 3; round++) {
      delay = 60
      h.dispatch({ t: "set-door", doorId: k.door.id, state: "open" })
      await sleep(25)
      // While the open-door compute is in flight, the door closes again.
      h.dispatch({ t: "set-door", doorId: k.door.id, state: "closed" })
      await sleep(90)
      delay = 0
      await settle(h, [[P1, m]])
      expect((m.view!.objects[k.door.id] as PlayerDoor).state).toBe("closed")
      expect(m.view!.tokens[k.goblin.id]).toBeUndefined()
    }
    // With time to look, the open door does show the goblin.
    h.dispatch({ t: "set-door", doorId: k.door.id, state: "open" })
    await settle(h, [[P1, m]])
    expect(m.view!.tokens[k.goblin.id]).toMatchObject({ label: "Goblin" })
    expect(violations).toEqual([])
    // The scenario did produce results for superseded revisions, and they were discarded.
    expect(h.staleResults).toBeGreaterThan(0)
  })
})

describe("host runner — live changes", () => {
  it("survives a vision worker crash by falling back to main-thread vision", async () => {
    const k = keep()
    const worker = new FakeWorker()
    const { fx, h, logs } = await hosted(k.scene, [P1], { createVisionClient: () => createWorkerVisionClient(worker) })
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    expect(worker.posted).toBeGreaterThan(0)
    worker.emit("error", { type: "error", message: "worker OOM" } as unknown as Event)
    expect(worker.terminated).toBe(true)
    h.dispatch({ t: "set-door", doorId: k.door.id, state: "open" })
    await settle(h, [[P1, m]])
    expect(m.view!.tokens[k.goblin.id]).toMatchObject({ label: "Goblin" })
    expect(logs.some((l) => l.includes("falling back"))).toBe(true)
  })

  it("reset-fog forgets exploration (refilled from what is perceived now)", async () => {
    const c = corridor()
    const { fx, h } = await hosted(c.scene, [P1])
    h.dispatch({ t: "assign-token", tokenId: c.eve.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    const r = m.move(c.eve.id, walk(c.ground, [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1]]))
    await waitFor(() => m.result(r) !== undefined, "move")
    await settle(h, [[P1, m]])
    expect(m.explored(c.ground, 2, 1)).toBe(true)
    h.dispatch({ t: "reset-fog", userId: P1 })
    await settle(h, [[P1, m]])
    expect(m.explored(c.ground, 2, 1)).toBe(false)
    expect(m.explored(c.ground, 8, 1)).toBe(true)
  })

  it("grid resizes and map switches reach players as clean patches", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1])
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    h.applyScenePatches([{ op: "replace", path: ["grid", "width"], value: 16 }])
    await settle(h, [[P1, m]])
    expect(m.view!.scene.grid.width).toBe(16)
    expect(m.view!.masks[k.ground].explored.width).toBe(16)
    expect(m.explored(k.ground, 5, 3)).toBe(true)

    const c = corridor()
    c.scene.name = "The Corridor"
    h.dispatch({ t: "load-scene", scene: c.scene })
    h.dispatch({ t: "assign-token", tokenId: c.eve.id, userId: P1, assigned: true })
    await settle(h, [[P1, m]])
    expect(m.view!.scene.name).toBe("The Corridor")
    expect(m.view!.controlledTokenIds).toEqual([c.eve.id])
    expect(Object.keys(m.view!.scene.levels)).toEqual([c.ground])
    expect(m.view!.tokens[k.ada.id]).toBeUndefined()
    await waitFor(() => m.broadcasts.some((b) => b.t === "status" && b.sceneName === "The Corridor"), "status with the new map name")
    // Moves validate against the new map's occlusion world.
    const r = m.move(c.eve.id, walk(c.ground, [[1, 1], [2, 1]]))
    await waitFor(() => m.result(r) !== undefined, "move on the new map")
    expect(m.result(r)).toMatchObject({ ok: true, applied: 1 })
    expect(m.applyErrors).toEqual([])
  })
})

// Keep the DM id referenced (fixture identity).
void DM
