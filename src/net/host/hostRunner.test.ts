/**
 * Host ↔ player simulation over LocalTransport (Node BroadcastChannel) with the local SessionsRepo
 * and an in-thread vision client: joins and snapshots, moves (legal prefix, masked reasons, per-step
 * exploration), doors, clean patch application on mirrors, hello catch-up, snapshot_ready, host
 * restart, kicks, stale-epoch stand-down, the same-browser lock, rate limiting, backdrop tile grants
 * before the patches that reveal them, the leak test on The Crooked Lantern, and DM-only terrain editing
 * data (terrainEdits) that must neither reach nor disturb players.
 */
import { produce, produceWithPatches } from "immer"
import { afterEach, describe, expect, it } from "vitest"

import type { PathStep } from "@/core/movement/types"
import { createDoor, createWall, newId } from "@/core/scene/factory"
import { sampleById } from "@/core/scene/samples"
import { blockShape, writeTerrain } from "@/core/scene/terrainShapes"
import type { Id, Scene } from "@/core/scene/types"
import { dmSayCommand, playerViewSchema } from "@/core/session"
import { parseGameStateDetailed } from "@/core/session/persist"
import { add, addToken, flatScene } from "@/core/session/test-utils"
import type { PlayerDoor, PlayerView } from "@/core/session/types"
import { deepEqual } from "@/core/session/util"
import { cellTouched, decodeMask } from "@/core/vision/mask"

import { createLocalScenesRepo } from "../scenesRepo"
import { NetError } from "../supabase"
import { sameVisionLevels, type HostRunnerImpl } from "./hostRunner"
import {
  createSessionFixture,
  DM,
  fakeLocks,
  FakeWorker,
  Mirror,
  P1,
  P2,
  P3,
  recordingAssets,
  sleep,
  startHost,
  TEST_TIMING,
  waitFor,
  type SessionFixture,
} from "./test-utils"
import type { TileCodec, TileImage } from "./tiles"
import type { HostPingEvent } from "./types"
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

/** Bright 12×6 meadow cut in two by a wall at x = 25; a wolf on the far side. */
function meadow() {
  const { scene, ground } = flatScene(12, 6, "bright")
  scene.name = "The Meadow"
  add(scene, createWall(ground, { x: 25, z: 0 }, { x: 25, z: 30 }))
  const wolf = addToken(scene, ground, 52.5, 22.5, { name: "SENTINEL_WOLF", label: "Wolf", kind: "monster" })
  return { scene, ground, wolf }
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
    const reqId = m.move(
      c.eve.id,
      walk(c.ground, [
        [1, 1],
        [2, 1],
        [3, 1],
        [4, 1],
        [5, 1],
      ])
    )
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
    const path = walk(c.ground, [
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 1],
      [6, 1],
      [7, 1],
      [8, 1],
      [9, 1],
      [10, 1],
    ])
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
    const r2 = m2.move(
      c.fay.id,
      walk(c.ground, [
        [12, 1],
        [13, 2],
      ])
    )
    await waitFor(() => m2.result(r2) !== undefined, "corner result")
    expect(m2.result(r2)).toEqual({ reqId: r2, ok: false, applied: 0, reason: "blocked" })
    // Not the player's token.
    const r3 = m2.move(
      c.eve.id,
      walk(c.ground, [
        [8, 1],
        [7, 1],
      ])
    )
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
    const r = m.move(
      k.bo.id,
      walk(k.ground, [
        [1, 1],
        [2, 2],
      ])
    )
    await waitFor(() => m.result(r) !== undefined, "result")
    expect(m.result(r)).toEqual({ reqId: r, ok: false, applied: 0, reason: "corner-cutting" })
    const ok = m.move(
      k.bo.id,
      walk(k.ground, [
        [1, 1],
        [1, 2],
        [2, 2],
        [3, 2],
      ])
    )
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
    const walkThrough = m1.move(
      k.ada.id,
      walk(k.ground, [
        [5, 3],
        [6, 3],
        [7, 3],
        [8, 3],
      ])
    )
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
    const a = m.move(
      k.bo.id,
      walk(k.ground, [
        [1, 1],
        [1, 2],
      ])
    )
    await sleep(30)
    // The first move's result is still on its way (its vision pass is slow): refused.
    const b = m.move(
      k.bo.id,
      walk(k.ground, [
        [1, 2],
        [1, 3],
      ])
    )
    await waitFor(() => m.result(a) !== undefined && m.result(b) !== undefined, "move results")
    expect(m.result(a)).toMatchObject({ ok: true, applied: 1 })
    expect(m.result(b)).toMatchObject({ ok: false, reason: "rate-limited" })
    delay = 0
    await settle(h, [[P1, m]])
    const c = m.move(
      k.bo.id,
      walk(k.ground, [
        [1, 2],
        [1, 3],
      ])
    )
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
    const r = m.move(
      c.eve.id,
      walk(c.ground, [
        [1, 1],
        [2, 1],
        [3, 1],
        [4, 1],
        [5, 1],
        [6, 1],
        [7, 1],
        [8, 1],
      ])
    )
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
    const long = m1.move(
      c.eve.id,
      walk(c.ground, [
        [1, 1],
        [2, 1],
        [3, 1],
        [4, 1],
        [5, 1],
        [6, 1],
        [7, 1],
        [8, 1],
      ])
    )
    await waitFor(() => m1.result(long) !== undefined, "long move result")
    const t0 = Date.now()
    const short = m2.move(
      c.fay.id,
      walk(c.ground, [
        [12, 1],
        [11, 1],
      ])
    )
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
    const path = walk(hl.ground, [
      [1, 2],
      [2, 2],
      [3, 2],
      [4, 2],
      [5, 2],
      [6, 2],
      [7, 2],
      [8, 2],
      [9, 2],
      [10, 2],
    ])
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
    const own = m1.move(
      k.bo.id,
      walk(k.ground, [
        [1, 1],
        [1, 2],
      ])
    )
    await sleep(30)
    // Bo's move is in flight: the owner is told to wait, anyone else only that it is not theirs.
    const probe = m2.move(
      k.bo.id,
      walk(k.ground, [
        [1, 2],
        [1, 3],
      ])
    )
    const again = m1.move(
      k.bo.id,
      walk(k.ground, [
        [1, 2],
        [1, 3],
      ])
    )
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

  it("a map change landing while a save is on its way keeps the new map's origin", async () => {
    const { k, h, scenes, sceneId } = await librarySession()
    const t = meadow()
    const other = await scenes.create(t.scene)
    const origin = { sceneId: other.id, version: 1, dirty: false }
    const saving = h.saveMapToLibrary()
    const changed = h.changeMap(t.scene, { tokenIds: [], arrival: { levelId: t.ground, x: 7.5, z: 7.5 }, origin })
    expect(await saving).toBe(2)
    expect(await changed).toMatchObject({ ok: true, saved: true })
    // The save wrote the keep to its own library scene, and did not stamp that scene on the meadow.
    expect(h.getSnapshot().library).toEqual(origin)
    const kept = await scenes.load(sceneId)
    expect(kept.version).toBe(2)
    expect(kept.parsed.ok && kept.parsed.scene.id).toBe(k.scene.id)
    // The next save goes to the meadow's library scene.
    expect(await h.saveMapToLibrary()).toBe(2)
    const saved = await scenes.load(other.id)
    expect(saved.parsed.ok && saved.parsed.scene.id).toBe(t.scene.id)
    expect((await scenes.load(sceneId)).version).toBe(2)
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
    const r = m1.move(
      k.ada.id,
      walk(k.ground, [
        [5, 3],
        [4, 3],
      ])
    )
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
    const r = m.move(
      k.ada.id,
      walk(k.ground, [
        [5, 3],
        [4, 3],
      ])
    )
    await waitFor(() => m.result(r) !== undefined, "result after the rejoin", 3000)
    expect(m.result(r)).toMatchObject({ ok: true, applied: 1 })
    await settle(h, [[P1, m]])
    expect(m.view!.tokens[k.ada.id].position).toEqual({ x: 22.5, z: 17.5 })
  })

  it("re-delivers the results of a lost patch with the catch-up", async () => {
    const { k, h, m } = await linked()
    m.dropPatches = 1
    const r = m.move(
      k.ada.id,
      walk(k.ground, [
        [5, 3],
        [4, 3],
      ])
    )
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
    m2.move(
      k.bo.id,
      walk(k.ground, [
        [1, 1],
        [1, 2],
      ])
    )
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
    // navigator.locks (undefined: the runner's default) where the runtime has it (Node 24+), else a fake.
    const locks = (globalThis.navigator as { locks?: unknown } | undefined)?.locks ? undefined : fakeLocks()
    const a = host(fx, { locks }).host
    await a.start()
    expect(a.getSnapshot().status).toBe("hosting")
    const b = host(fx, { locks }).host
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
    const r = m.move(
      k.ada.id,
      walk(k.ground, [
        [5, 3],
        [4, 3],
      ])
    )
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
  /** Explored backdrop cells of a view that no announced chunk holds yet (the backdrop covers cells 0..w-1 × 0..d-1). */
  const unannounced = (m: Mirror, view: PlayerView, levelId: string, w = 14, d = 8): string[] => {
    const out: string[] = []
    const ex = view.masks[levelId]?.explored
    if (!ex) return out
    const mask = decodeMask(ex)
    for (let j = 0; j < d; j++) for (let i = 0; i < w; i++) if (cellTouched(mask, j * ex.width + i) && !m.hasTile(levelId, i, j)) out.push(`${i},${j}`)
    return out
  }
  /** A codec whose chunks say which image they were cut from ("folder/assetId", the recorded image's blob). */
  const tagged: TileCodec = {
    decode: async (blob) => ({ width: 140, height: 80, tag: await blob.text() }) as TileImage,
    encodeChunk: async (image, parts, size) => new Blob([`${(image as TileImage & { tag: string }).tag}:${size}:${parts.length}`]),
    release: () => {},
  }
  /** Every chunk entry announced to a mirror from message `from` on: [levelId, ci, cj, mask, rev?], resets as "reset". */
  const announced = (m: Mirror, levelId: string, from = 0) =>
    m.messages
      .slice(from)
      .filter((x): x is Extract<typeof x, { t: "tiles" }> => x.t === "tiles" && x.levelId === levelId)
      .flatMap((x) => [...(x.reset ? ["reset" as const] : []), ...x.chunks])

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
      expect(text).toBe(
        `40:${
          mask
            .toString(2)
            .split("")
            .filter((b) => b === "1").length
        }`
      )
    }
    // Open the door and walk through: new cells, new chunks, still announced in time.
    const open = m.door(k.door.id, "open")
    await waitFor(() => m.result(open) !== undefined, "door")
    await settle(h, [[P1, m]])
    const r = m.move(
      k.ada.id,
      walk(k.ground, [
        [5, 3],
        [6, 3],
        [7, 3],
        [8, 3],
        [9, 3],
      ])
    )
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

  it("a map switch resets the old map's chunks and publishes the new map's, cut from its own image folder", async () => {
    const k = withBackdrop()
    const t = meadow()
    t.scene.assets = { map2: { id: "map2", kind: "image", name: "Meadow map", mime: "image/webp", width: 120, height: 60, bytes: 999 } }
    t.scene.levels[t.ground].backdrop = { assetId: "map2", rect: { x: 0, z: 0, w: 60, d: 30 }, opacity: 1, tintWalls: false }
    const fx = await fixture(k.scene, [P1])
    const rowA = (await fx.dmRepo.listMySessions()).find((s) => s.id === fx.sessionId)!.sceneId!
    // The meadow's image was uploaded under its library row (not its document id).
    const rowB = (await createLocalScenesRepo(fx.store).create(t.scene)).id
    const assets = recordingAssets("supabase", {
      hasImage: (folder, assetId) => (folder === k.scene.id && assetId === "map") || (folder === rowB && assetId === "map2"),
    })
    const opts = { assets: assets.store, tileCodec: tagged }
    const { host: h } = host(fx, opts)
    await h.start()
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    const late: string[] = []
    const m: Mirror = mirror(fx, P1, {
      onView: (view) => late.push(...(view.scene.mapSerial ? unannounced(m, view, t.ground, 12, 6) : unannounced(m, view, k.ground))),
    })
    await settle(h, [[P1, m]])
    expect(m.tiles.get(k.ground)?.size).toBeGreaterThan(0)
    const uploads = assets.uploads.length
    const lookups = assets.images.length
    const mark = m.messages.length
    const origin = { sceneId: rowB, version: 1, dirty: false }
    expect(await h.changeMap(t.scene, { tokenIds: [k.ada.id], arrival: { levelId: t.ground, x: 7.5, z: 12.5 }, origin })).toMatchObject({ ok: true })
    await settle(h, [[P1, m]])
    await waitFor(() => (m.tiles.get(t.ground)?.size ?? 0) > 0 && unannounced(m, m.view!, t.ground, 12, 6).length === 0, "the meadow's chunks")
    // The keep's chunks were withdrawn; the meadow's were announced before the views revealing them.
    expect(announced(m, k.ground, mark)).toEqual(["reset"])
    expect(m.tiles.get(k.ground)?.size).toBe(0)
    expect(late).toEqual([])
    const fresh = assets.uploads.slice(uploads)
    expect(fresh.length).toBeGreaterThan(0)
    for (const key of fresh) {
      expect(key.split("|")[1]).toBe(t.ground)
      expect(assets.chunks.get(key)).toMatch(new RegExp(`^${rowB}/map2:`))
    }
    // Looked up under the meadow's own folders, never the first map's library row.
    expect(assets.images.slice(lookups)).toEqual([`${t.scene.id}/map2`, `${rowB}/map2`])
    expect(h.getSnapshot().library).toEqual(origin)
    // A reloaded client learns the meadow's chunks only.
    const m2 = mirror(fx, P1)
    await waitFor(() => m2.view?.scene.mapSerial === 1 && m2.tiles.size > 0, "reloaded client")
    expect([...m2.tiles.keys()]).toEqual([t.ground])
    expect(unannounced(m2, m2.view!, t.ground, 12, 6)).toEqual([])
    // A restarted host (the session row still names the keep's library scene) keeps to the meadow's folders.
    const restartLookups = assets.images.length
    await h.stop()
    const b = host(fx, opts).host
    await b.start()
    await settle(b, [
      [P1, m],
      [P1, m2],
    ])
    await waitFor(() => assets.images.length > restartLookups && unannounced(m, m.view!, t.ground, 12, 6).length === 0, "chunks after the restart")
    expect(assets.images.slice(restartLookups).every((f) => f.startsWith(`${t.scene.id}/`) || f.startsWith(`${rowB}/`))).toBe(true)
    expect(assets.images.some((f) => f.startsWith(`${rowA}/`))).toBe(false)
  })

  it("a switch to a duplicated map (same level id, image and placement) re-cuts every chunk from the copy under new revs", async () => {
    const k = withBackdrop()
    const dup = structuredClone(k.scene)
    dup.id = newId()
    dup.name = "The Keep (copy)"
    const assets = recordingAssets("supabase", { hasImage: (folder) => folder === k.scene.id || folder === dup.id })
    const fx = await fixture(k.scene, [P1])
    const { host: h } = host(fx, { assets: assets.store, tileCodec: tagged })
    await h.start()
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    const revs = new Map<string, number>()
    for (const e of announced(m, k.ground)) if (e !== "reset" && e.length === 4) revs.set(`${e[0]},${e[1]},${e[2]}`, e[3])
    expect(revs.size).toBeGreaterThan(0)
    const mark = m.messages.length
    const at = k.scene.tokens[k.ada.id].position
    expect(await h.changeMap(dup, { tokenIds: [k.ada.id], arrival: { levelId: k.ground, ...at }, origin: null })).toMatchObject({ ok: true })
    await settle(h, [[P1, m]])
    await waitFor(() => (m.tiles.get(k.ground)?.size ?? 0) > 0 && unannounced(m, m.view!, k.ground).length === 0, "the copy's chunks")
    const after = announced(m, k.ground, mark)
    // Everything known for the level starts over: announced again under new revs, even for the same cells.
    expect(after[0]).toBe("reset")
    const entries = after.slice(1).filter((e) => e !== "reset")
    expect(entries.length).toBeGreaterThan(0)
    let same = 0
    for (const e of entries) {
      expect(e).toHaveLength(4)
      const before = revs.get(`${e[0]},${e[1]},${e[2]}`)
      if (before !== undefined) same++
      expect(e[3]).not.toBe(before)
    }
    expect(same).toBeGreaterThan(0)
    // Every chunk the player now knows was cut from the copy's image.
    for (const at of m.tiles.get(k.ground)!.keys()) expect(assets.chunks.get(`${P1}|${k.ground}|${at}`)).toMatch(new RegExp(`^${dup.id}/map:`))
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
      m1.move(
        brunhild.id,
        walk(g, [
          [14, 13],
          [14, 12],
          [15, 12],
          [16, 12],
        ])
      ),
      m2.move(
        pip.id,
        walk(pip.levelId, [
          [30, 9],
          [29, 9],
          [28, 9],
          [27, 9],
        ])
      ),
    ]
    await waitFor(() => m1.result(moves[0]) !== undefined && m2.result(moves[1]) !== undefined, "moves")
    const back = m1.move(
      brunhild.id,
      walk(g, [
        [16, 12],
        [15, 12],
        [14, 12],
        [13, 12],
        [12, 12],
      ])
    )
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
      for (const s of [
        "dmNotes",
        "Old Moss",
        "Bandit",
        "barkeep has the key",
        "Pantry door",
        "Contraband",
        "secret",
        "loose stones",
        "attachedTokenId",
        "hidden",
        "blocksMovement",
      ]) {
        expect(all, s).not.toContain(s)
      }
      expect(playerViewSchema.parse(m.view)).toEqual(m.view)
    }
    // Without shared vision earlier, P1 never learned Pip's name; with it on, it is allowed.
    const beforeShared = m1.raw.slice(
      0,
      m1.raw.findIndex((r) => r.includes('"sharedVision":true'))
    )
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
    const r = m.move(
      c.eve.id,
      walk(c.ground, [
        [1, 1],
        [2, 1],
        [3, 1],
        [4, 1],
        [5, 1],
        [6, 1],
        [7, 1],
        [8, 1],
      ])
    )
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
    const r = m.move(
      c.eve.id,
      walk(c.ground, [
        [1, 1],
        [2, 1],
      ])
    )
    await waitFor(() => m.result(r) !== undefined, "move on the new map")
    expect(m.result(r)).toMatchObject({ ok: true, applied: 1 })
    expect(m.applyErrors).toEqual([])
  })
})

describe("host runner — changing the map", () => {
  const texts = (m: Mirror) =>
    Object.values(m.view?.table?.log ?? {})
      .sort((a, b) => a.at - b.at)
      .map((x) => x.text)
  const pings = (m: Mirror) => m.messages.filter((x) => x.t === "ping")
  const cellOf = (h: HostRunnerImpl, tokenId: Id): [number, number] => {
    const p = h.getSnapshot().state!.scene.tokens[tokenId].position
    return [Math.floor(p.x / 5), Math.floor(p.z / 5)]
  }

  /** The keep with Ada (P1) and Bo (P2) wounded, both assigned, both players linked. */
  async function party(extra: Parameters<typeof startHost>[1] = {}) {
    const k = keep()
    k.scene.tokens[k.ada.id].hp = { current: 7, max: 12, temp: 0 }
    k.scene.tokens[k.bo.id].hp = { current: 3, max: 10, temp: 2 }
    const { fx, h } = await hosted(k.scene, [P1, P2], extra)
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    h.dispatch({ t: "assign-token", tokenId: k.bo.id, userId: P2, assigned: true })
    const m1 = mirror(fx, P1)
    const m2 = mirror(fx, P2)
    const both: Array<[string, Mirror]> = [
      [P1, m1],
      [P2, m2],
    ]
    await settle(h, both)
    return { k, fx, h, m1, m2, both }
  }

  it("carries the party: owners kept, exact hit points for their owners only, the log goes on, moves validate on the new map", async () => {
    const { k, h, m1, m2, both } = await party()
    await m1.send({ t: "say", reqId: "s1", text: "Off we go", to: "all" })
    await waitFor(() => texts(m2).includes("Off we go"), "chat")
    expect(m1.view!.scene.mapSerial).toBeUndefined()
    const t = meadow()
    const r = await h.changeMap(t.scene, { tokenIds: [k.ada.id, k.bo.id], arrival: { levelId: t.ground, x: 7.5, z: 12.5 }, origin: null })
    expect(r).toEqual({ ok: true, carried: { [k.ada.id]: k.ada.id, [k.bo.id]: k.bo.id }, saved: true })
    await settle(h, both)
    const state = h.getSnapshot().state!
    // Nobody re-assigned anything: the carried tokens keep their owners, and only they have any.
    expect(state.owners).toEqual({ [k.ada.id]: [P1], [k.bo.id]: [P2] })
    expect(m1.view!.controlledTokenIds).toEqual([k.ada.id])
    expect(m2.view!.controlledTokenIds).toEqual([k.bo.id])
    expect(Object.keys(m1.view!.scene.levels)).toEqual([t.ground])
    expect(m1.view!.tokens[k.ada.id]).toMatchObject({ levelId: t.ground, hp: { current: 7, max: 12, temp: 0 }, name: "Ada Lovelace" })
    // Bo stands next to Ada: P1 sees him, with a band at most (his exact hit points are P2's).
    expect(m1.view!.tokens[k.bo.id]).toMatchObject({ label: "Bo", health: "bloodied" })
    expect(m1.view!.tokens[k.bo.id].hp).toBeUndefined()
    expect(m2.view!.tokens[k.bo.id].hp).toEqual({ current: 3, max: 10, temp: 2 })
    expect(m2.view!.tokens[k.ada.id].hp).toBeUndefined()
    // Left behind: the keep's other tokens; beyond the wall: the wolf.
    for (const id of [k.goblin.id, k.assassin.id, t.wolf.id]) expect(m1.view!.tokens[id]).toBeUndefined()
    // The chat log goes on, with the notice; the view says which map of the game this is.
    expect(texts(m1)).toEqual(["Off we go", "The party travels to The Meadow"])
    expect(texts(m2)).toEqual(["Off we go", "The party travels to The Meadow"])
    expect(state.table!.log.map((x) => x.text)).toEqual(["Off we go", "The party travels to The Meadow"])
    expect(m1.view!.scene.mapSerial).toBe(1)
    expect(m2.view!.scene.mapSerial).toBe(1)
    await waitFor(() => m1.broadcasts.some((b) => b.t === "status" && b.sceneName === "The Meadow"), "status with the new map name")
    // Moves validate against the meadow's walls (the keep had none at x = 25).
    const [i, j] = cellOf(h, k.ada.id)
    const path: Array<[number, number]> = []
    for (let x = i; x <= 7; x++) path.push([x, j])
    const mv = m1.move(k.ada.id, walk(t.ground, path))
    await waitFor(() => m1.result(mv) !== undefined, "move on the new map")
    expect(m1.result(mv)).toEqual({ reqId: mv, ok: false, applied: 4 - i, reason: "blocked" })
    await settle(h, both)
    expect(cellOf(h, k.ada.id)).toEqual([4, j])
    for (const m of [m1, m2]) {
      expect(playerViewSchema.parse(m.view)).toEqual(m.view)
      expect(m.applyErrors).toEqual([])
      expect(m.raw.join("\n")).not.toContain("SENTINEL_")
    }
  })

  it("a duplicated map: only the carried token keeps its owner, the twins left behind are nobody's", async () => {
    const { k, h, m1, m2, both } = await party()
    const dup = structuredClone(k.scene)
    dup.id = newId()
    dup.name = "The Keep (copy)"
    const r = await h.changeMap(dup, { tokenIds: [k.ada.id], arrival: { levelId: k.ground, x: 12.5, z: 12.5 }, origin: null })
    expect(r).toMatchObject({ ok: true, carried: { [k.ada.id]: k.ada.id } })
    await settle(h, both)
    const state = h.getSnapshot().state!
    // Bo's twin stands on the copy, but P2 does not control (or see through) it.
    expect(Object.keys(state.scene.tokens).sort()).toEqual(Object.keys(k.scene.tokens).sort())
    expect(state.owners).toEqual({ [k.ada.id]: [P1] })
    expect(m1.view!.controlledTokenIds).toEqual([k.ada.id])
    expect(cellOf(h, k.ada.id)).toEqual([2, 2])
    expect(m2.view!.controlledTokenIds).toEqual([])
    expect(m2.view!.tokens).toEqual({})
    const mv = m2.move(
      k.bo.id,
      walk(k.ground, [
        [1, 1],
        [1, 2],
      ])
    )
    await waitFor(() => m2.result(mv) !== undefined, "move of a twin")
    expect(m2.result(mv)).toEqual({ reqId: mv, ok: false, reason: "not-owner" })
  })

  it("the swap is saved before it resolves: a restarted host resumes the new map with the carried owners", async () => {
    const k = keep()
    const t = meadow()
    const fx = await fixture(k.scene, [P1])
    const scenes = createLocalScenesRepo(fx.store)
    const row = await scenes.create(t.scene)
    const a = host(fx, { scenes }).host
    await a.start()
    a.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(a, [[P1, m]])
    const origin = { sceneId: row.id, version: 1, dirty: false }
    const r = await a.changeMap(t.scene, { tokenIds: [k.ada.id], arrival: { levelId: t.ground, x: 7.5, z: 12.5 }, origin })
    expect(r).toEqual({ ok: true, carried: { [k.ada.id]: k.ada.id }, saved: true })
    expect(a.getSnapshot().library).toEqual(origin)
    const stored = await fx.dmRepo.loadSessionState(fx.sessionId)
    if (stored?.content.kind !== "game") throw new Error("the game was not saved")
    const parsed = parseGameStateDetailed(stored.content.state)
    if (!parsed.ok) throw new Error("the saved game does not parse")
    expect(parsed.state.scene.id).toBe(t.scene.id)
    expect(parsed.state.origin).toEqual(origin)
    expect(parsed.state.mapSerial).toBe(1)
    await settle(a, [[P1, m]])
    const epochA = a.getSnapshot().epoch
    await a.stop()

    const b = host(fx, { scenes }).host
    await b.start()
    expect(b.getSnapshot().status).toBe("hosting")
    const state = b.getSnapshot().state!
    expect(state.scene.id).toBe(t.scene.id)
    expect(state.owners).toEqual({ [k.ada.id]: [P1] })
    expect(state.table!.log.map((x) => x.text)).toEqual(["The party travels to The Meadow"])
    expect(b.getSnapshot().library).toEqual(origin)
    await settle(b, [[P1, m]])
    expect(m.epoch).not.toBe(epochA)
    expect(m.view!.scene.mapSerial).toBe(1)
    expect(m.view!.controlledTokenIds).toEqual([k.ada.id])
    expect(Object.keys(m.view!.scene.levels)).toEqual([t.ground])
    expect(m.applyErrors).toEqual([])
  })

  it("until a client has the new map's view, its moves are refused and its pings dropped", async () => {
    let delay = 0
    const { k, h, m1, m2, both } = await party({ createVisionClient: slowVision(() => delay) })
    const seen: HostPingEvent[] = []
    h.onPing((ev) => seen.push(ev))
    const t = meadow()
    // Views of the new map take a while (slow vision): the clients still show the keep meanwhile.
    delay = 400
    const changing = h.changeMap(t.scene, { tokenIds: [k.ada.id, k.bo.id], arrival: { levelId: t.ground, x: 7.5, z: 12.5 }, origin: null })
    const [ai, aj] = cellOf(h, k.ada.id)
    const [bi, bj] = cellOf(h, k.bo.id)
    const step = (
      [
        [ai, aj - 1],
        [ai, aj + 1],
        [ai - 1, aj],
        [ai + 1, aj],
      ] as Array<[number, number]>
    ).find(([i, j]) => i >= 0 && j >= 0 && i < 5 && j < 6 && !(i === bi && j === bj))!
    const stale = m1.move(k.ada.id, walk(t.ground, [[ai, aj], step]))
    const door = m1.door(k.door.id, "open")
    // A ping on the keep's level (gone), and one on the meadow's (not in the client's view yet).
    await m1.send({ t: "ping", levelId: k.ground, x: 12, z: 14 })
    await m1.send({ t: "ping", levelId: t.ground, x: 12, z: 14 })
    await waitFor(() => m1.result(stale) !== undefined && m1.result(door) !== undefined, "results")
    expect(m1.result(stale)).toEqual({ reqId: stale, ok: false, reason: "cannot" })
    expect(m1.result(door)).toEqual({ reqId: door, ok: false, reason: "cannot" })
    delay = 0
    expect(await changing).toMatchObject({ ok: true })
    await settle(h, both)
    expect(cellOf(h, k.ada.id)).toEqual([ai, aj])
    expect(seen).toEqual([])
    expect(pings(m2)).toEqual([])
    // With the new view in hand, the same requests go through.
    const fresh = m1.move(k.ada.id, walk(t.ground, [[ai, aj], step]))
    await waitFor(() => m1.result(fresh) !== undefined, "move")
    expect(m1.result(fresh)).toMatchObject({ ok: true, applied: 1 })
    await m1.send({ t: "ping", levelId: t.ground, x: 12, z: 14 })
    await waitFor(() => seen.length === 1 && pings(m2).length === 1, "ping on the new map")
    expect(seen[0]).toMatchObject({ ping: { levelId: t.ground }, from: P1 })
  })

  it("refusals leave the game as it was", async () => {
    const { k, h, m1, both } = await party()
    const before = h.getSnapshot().state!
    const t = meadow()
    const same = await h.changeMap(structuredClone(before.scene), { tokenIds: [k.ada.id], arrival: { levelId: k.ground, x: 7.5, z: 7.5 }, origin: null })
    expect(same).toEqual({ ok: false, error: "same-map", unplaced: [] })
    // One square, two travellers.
    const tiny = flatScene(1, 1, "bright")
    const full = await h.changeMap(tiny.scene, { tokenIds: [k.ada.id, k.bo.id], arrival: { levelId: tiny.ground, x: 2.5, z: 2.5 }, origin: null })
    expect(full).toMatchObject({ ok: false, error: "no-room" })
    expect(!full.ok && full.unplaced.length).toBe(1)
    const lost = await h.changeMap(t.scene, { tokenIds: [k.ada.id], arrival: { levelId: "nowhere", x: 7.5, z: 7.5 }, origin: null })
    expect(lost).toEqual({ ok: false, error: "unknown-level", unplaced: [] })
    await sleep(50)
    await settle(h, both)
    const after = h.getSnapshot().state!
    expect(after.scene).toBe(before.scene)
    expect(after.owners).toBe(before.owners)
    expect(after.table).toBe(before.table)
    expect(after.origin).toEqual(before.origin)
    expect(after.mapSerial).toBeUndefined()
    expect(m1.view!.scene.name).toBe("The Keep")
    expect(m1.view!.scene.mapSerial).toBeUndefined()
  })
})

describe("host runner — terrain editing data", () => {
  /** The keep with a block (terrain shape) in the west room, where Ada stands. */
  function keepWithShape() {
    const k = keep()
    k.scene.levels[k.ground] = produce(k.scene.levels[k.ground], (d) => {
      writeTerrain(d, k.scene.grid, { upsert: [blockShape("hill", { x: 15, z: 5, w: 10, d: 10 }, 0, 3, 0)] })
    })
    return k
  }

  it("an edit touching only terrainEdits marks no player dirty and keeps knowledge current; a baked change reaches players", async () => {
    const k = keepWithShape()
    const { fx, h } = await hosted(k.scene, [P1])
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    const knowledgeRev = () => (h as unknown as { knowledgeRev: number }).knowledgeRev
    const seq = m.seq
    const rev = knowledgeRev()

    // Renaming the shape: DM-only editing data (the heightmap is unchanged).
    const scene = h.getSnapshot().state!.scene
    const [renamed, patches] = produceWithPatches(scene, (d: Scene) => {
      d.levels[k.ground].terrainEdits!.shapes.hill.name = "SENTINEL_HILL"
    })
    expect(patches.length).toBeGreaterThan(0)
    expect(patches.every((p) => p.path[0] === "levels" && p.path[2] === "terrainEdits")).toBe(true)
    const r = h.dispatch({ t: "apply-scene-patches", patches })
    expect(r?.dirtyPlayers).toEqual([])
    expect(knowledgeRev()).toBe(rev)
    expect(h.debugIdle()).toBe(true)
    expect(h.getSnapshot().state!.scene.levels[k.ground].terrainEdits!.shapes.hill.name).toBe("SENTINEL_HILL")
    await sleep(TEST_TIMING.flushIntervalMs * 3)
    await settle(h, [[P1, m]])
    expect(m.seq).toBe(seq)

    // Raising the block changes the baked heightmap too: players are updated, in-flight knowledge is stale.
    const [, raise] = produceWithPatches(renamed, (d: Scene) => {
      const hill = d.levels[k.ground].terrainEdits!.shapes.hill
      writeTerrain(d.levels[k.ground], d.grid, { upsert: [{ ...hill, points: blockShape("hill", { x: 15, z: 5, w: 10, d: 10 }, 0, 5, 0).points }] })
    })
    expect(raise.some((p) => p.path[2] === "heightmap")).toBe(true)
    expect(h.dispatch({ t: "apply-scene-patches", patches: raise })?.dirtyPlayers).toBe("all")
    expect(knowledgeRev()).toBeGreaterThan(rev)
    await settle(h, [[P1, m]])
    expect(m.seq).toBeGreaterThan(seq)
    const json = JSON.stringify(m.view)
    for (const s of ["terrainEdits", "baseChunks", "SENTINEL"]) expect(json).not.toContain(s)
  })

  it("sameVisionLevels: only terrainEdits may differ (same heightmap object)", () => {
    const k = keepWithShape()
    const levels = k.scene.levels
    const level = levels[k.ground]
    const renamed = produce(levels, (d) => {
      d[k.ground].terrainEdits!.shapes.hill.name = "Hill"
    })
    expect(renamed).not.toBe(levels)
    expect(renamed[k.ground].heightmap).toBe(level.heightmap)
    expect(sameVisionLevels(levels, levels)).toBe(true)
    expect(sameVisionLevels(levels, renamed)).toBe(true)
    expect(sameVisionLevels(renamed, levels)).toBe(true)
    // Removing the editing data altogether (the heightmap kept) is still the same world.
    expect(sameVisionLevels(levels, { ...levels, [k.ground]: { ...level, terrainEdits: undefined } })).toBe(true)
    const bare = { ...level }
    delete bare.terrainEdits
    expect(sameVisionLevels(levels, { ...levels, [k.ground]: bare })).toBe(true)
    // Anything a player can see or that vision reads is a different world.
    const heightmap = { ...level.heightmap!, chunks: { ...level.heightmap!.chunks } }
    expect(sameVisionLevels(levels, { ...levels, [k.ground]: { ...level, heightmap } })).toBe(false)
    expect(sameVisionLevels(levels, { ...levels, [k.ground]: { ...level, elevation: 1 } })).toBe(false)
    expect(sameVisionLevels(levels, { ...levels, [k.ground]: { ...level, name: "Other" } })).toBe(false)
    expect(sameVisionLevels(levels, { ...levels, extra: { ...level, id: "extra" } })).toBe(false)
    expect(sameVisionLevels(levels, {})).toBe(false)
  })

  it("a terrainEdits-only edit while a move's steps are evaluated keeps their exploration (critique M7)", async () => {
    const c = corridor()
    // A shape far from the corridor Eve walks along (the level gets a heightmap with the block baked in).
    c.scene.levels[c.ground] = produce(c.scene.levels[c.ground], (d) => {
      writeTerrain(d, c.scene.grid, { upsert: [blockShape("mound", { x: 70, z: 10, w: 5, d: 5 }, 0, 1, 0)] })
    })
    expect(c.scene.levels[c.ground].terrainEdits).toBeDefined()
    const worker = new SerialWorker(60)
    const { fx, h } = await hosted(c.scene, [P1], { createVisionClient: () => createWorkerVisionClient(worker) })
    h.dispatch({ t: "assign-token", tokenId: c.eve.id, userId: P1, assigned: true })
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    const knowledgeRev = () => (h as unknown as { knowledgeRev: number }).knowledgeRev
    const rev = knowledgeRev()
    const r = m.move(
      c.eve.id,
      walk(c.ground, [
        [1, 1],
        [2, 1],
        [3, 1],
        [4, 1],
        [5, 1],
        [6, 1],
        [7, 1],
        [8, 1],
      ])
    )
    await waitFor(() => m.result(r) !== undefined, "move result")
    expect(m.result(r)).toMatchObject({ ok: true, applied: 7 })
    // The DM renames the shape while the six step probes (60 ms each) are still being evaluated: the
    // levels' identity changes, the world players see does not.
    expect(worker.probesDone).toBeLessThan(6)
    const before = h.getSnapshot().state!.scene
    const [, patches] = produceWithPatches(before, (d: Scene) => {
      d.levels[c.ground].terrainEdits!.shapes.mound.name = "Mound"
    })
    expect(h.dispatch({ t: "apply-scene-patches", patches })?.dirtyPlayers).toEqual([])
    const after = h.getSnapshot().state!.scene
    expect(after.levels).not.toBe(before.levels)
    expect(after.levels[c.ground].heightmap).toBe(before.levels[c.ground].heightmap)
    await settle(h, [[P1, m]])
    expect(worker.probesDone).toBe(6)
    expect(knowledgeRev()).toBe(rev)
    // Cells 4 and 5 of the corridor are only seen from the intermediate steps (Eve's darkvision is 10 ft).
    expect(m.explored(c.ground, 4, 1)).toBe(true)
    expect(m.explored(c.ground, 5, 1)).toBe(true)
    expect(JSON.stringify(m.view)).not.toContain("Mound")
  })
})

// Keep the DM id referenced (fixture identity).
void DM

describe("host runner — the table (chat, dice, combat, pings)", () => {
  /** Dice that always show `v`. */
  const always =
    (v: number) =>
    (sides: number): number =>
      Math.min(v, sides)
  const texts = (m: Mirror) =>
    Object.values(m.view?.table?.log ?? {})
      .sort((a, b) => a.at - b.at)
      .map((x) => x.text)

  it("chat, whispers and host-rolled dice reach exactly their readers", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1, P2], { diceRng: always(13) })
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    h.dispatch({ t: "assign-token", tokenId: k.bo.id, userId: P2, assigned: true })
    const m1 = mirror(fx, P1)
    const m2 = mirror(fx, P2)
    const both: Array<[string, Mirror]> = [
      [P1, m1],
      [P2, m2],
    ]
    await settle(h, both)
    await m1.send({ t: "say", reqId: "s1", text: "Hello table", to: "all" })
    await m2.send({ t: "say", reqId: "s2", text: "SENTINEL_WHISPER", to: "dm" })
    await m1.send({ t: "roll", reqId: "s3", formula: "1d20+2 to hit", to: "all" })
    await m1.send({ t: "roll", reqId: "s4", formula: "not dice", to: "all" })
    await waitFor(() => m1.result("s4") !== undefined && texts(m2).length === 3, "player messages")
    const cmd = dmSayCommand("SENTINEL_DM_NOTE", [P1], { now: Date.now(), newId: () => "dmnote1", rng: always(1) })!
    h.dispatch(cmd)
    await waitFor(() => m1.result("s4") !== undefined && texts(m1).length === 3 && texts(m2).length === 3, "table messages")
    await settle(h, both)
    // Players' requests travel on their own channels: only each sender's order is fixed.
    expect(texts(m1)).toEqual(["Hello table", "to hit", "SENTINEL_DM_NOTE"])
    expect(texts(m2).sort()).toEqual(["Hello table", "SENTINEL_WHISPER", "to hit"])
    expect(m1.result("s4")).toEqual({ reqId: "s4", ok: false, reason: "bad-formula" })
    const roll = Object.values(m2.view!.table!.log).find((x) => x.kind === "roll")!
    expect(roll.roll).toMatchObject({ formula: "1d20 + 2", total: 15 })
    // The DM sees everything.
    expect(
      h
        .getSnapshot()
        .state!.table!.log.map((x) => x.text)
        .sort()
    ).toEqual(["Hello table", "SENTINEL_DM_NOTE", "SENTINEL_WHISPER", "to hit"])
    expect(m1.raw.join("\n")).not.toContain("SENTINEL_WHISPER")
    expect(m2.raw.join("\n")).not.toContain("SENTINEL_DM_NOTE")
    expect(playerViewSchema.parse(m1.view)).toEqual(m1.view)
    expect(m1.applyErrors).toEqual([])
  })

  it("rate-limits chat floods separately from moves", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1])
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    for (let n = 0; n < 20; n++) void m.send({ t: "say", reqId: `c${n}`, text: `spam ${n}`, to: "all" })
    await waitFor(() => m.results.length >= 8, "chat results")
    await sleep(150)
    const ok = m.results.filter((r) => r.ok).length
    // Burst 6 (plus a little refill while the flood arrives).
    expect(ok).toBeGreaterThanOrEqual(6)
    expect(ok).toBeLessThanOrEqual(8)
    expect(h.getSnapshot().state!.table!.log.length).toBe(ok)
  })

  it("pings reach the others who know the level, and the DM; never the sender", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1, P2, P3])
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    h.dispatch({ t: "assign-token", tokenId: k.bo.id, userId: P2, assigned: true })
    const m1 = mirror(fx, P1)
    const m2 = mirror(fx, P2)
    // P3 controls nothing: it knows no level.
    const m3 = mirror(fx, P3)
    await settle(h, [
      [P1, m1],
      [P2, m2],
      [P3, m3],
    ])
    const seen: HostPingEvent[] = []
    h.onPing((ev) => seen.push(ev))
    const pings = (m: Mirror) => m.messages.filter((x) => x.t === "ping").map((x) => (x as Extract<typeof x, { t: "ping" }>).ping)
    await m1.send({ t: "ping", levelId: k.ground, x: 12, z: 14 })
    await m1.send({ t: "ping", levelId: "no-such-level", x: 12, z: 14 })
    await waitFor(() => pings(m2).length === 1 && seen.length === 1, "ping delivered")
    await sleep(100)
    const name = h.getSnapshot().state!.players[P1].displayName
    expect(pings(m2)).toEqual([{ levelId: k.ground, x: 12, z: 14, name, color: h.getSnapshot().state!.players[P1].color, focus: false }])
    expect(pings(m1)).toEqual([])
    expect(pings(m3)).toEqual([])
    expect(seen).toEqual([{ ping: { levelId: k.ground, x: 12, z: 14, name, color: expect.any(String), focus: false }, from: P1 }])

    h.ping(k.ground, { x: 30, z: 5 }, { focus: true })
    await waitFor(() => pings(m1).length === 1 && pings(m2).length === 2, "DM ping")
    expect(pings(m1)[0]).toMatchObject({ name: "DM", focus: true, x: 30, z: 5 })
    expect(seen[1].from).toBeNull()

    // A flood: 1/s, burst 3.
    for (let n = 0; n < 10; n++) void m2.send({ t: "ping", levelId: k.ground, x: n, z: 1 })
    await sleep(200)
    expect(pings(m1).length - 1).toBeLessThanOrEqual(4)
    expect(pings(m1).length - 1).toBeGreaterThanOrEqual(3)
  })

  it("combat: players see only entries they may; they roll initiative and end their own turn", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1, P2], { diceRng: always(9) })
    h.dispatch({ t: "assign-token", tokenId: k.ada.id, userId: P1, assigned: true })
    h.dispatch({ t: "assign-token", tokenId: k.bo.id, userId: P2, assigned: true })
    const m1 = mirror(fx, P1)
    const m2 = mirror(fx, P2)
    const both: Array<[string, Mirror]> = [
      [P1, m1],
      [P2, m2],
    ]
    await settle(h, both)
    // Ada cannot see the goblin behind the closed door; the assassin is hidden.
    expect(m1.view!.tokens[k.goblin.id]).toBeUndefined()
    const entry = (id: Id, tokenId: Id, initiative: number | null) => ({ id, tokenId, name: "", initiative, modifier: 0, hidden: false })
    h.dispatch({
      t: "combat-start",
      entries: [entry("e-ada", k.ada.id, null), entry("e-bo", k.bo.id, 11), entry("e-gob", k.goblin.id, 18), entry("e-ass", k.assassin.id, 25)],
      stamp: { id: "start1", at: Date.now() },
    })
    await settle(h, both)
    expect(m1.view!.table!.combat!.entries.map((e) => e.id)).toEqual(["e-bo", "e-ada"])
    const r = "i1"
    await m1.send({ t: "initiative", reqId: r, tokenId: k.ada.id, bonus: 4 })
    await waitFor(() => m1.result(r) !== undefined, "initiative result")
    expect(m1.result(r)).toEqual({ reqId: r, ok: true })
    await settle(h, both)
    expect(m1.view!.table!.combat!.entries.map((e) => [e.id, e.initiative])).toEqual([
      ["e-ada", 13],
      ["e-bo", 11],
    ])
    // The assassin acts first: nobody sees whose turn it is.
    h.dispatch({ t: "combat-turn", delta: 1, stamp: { id: "t1", at: Date.now() } })
    await settle(h, both)
    expect(m1.view!.table!.combat!.activeId).toBeNull()
    await m1.send({ t: "end-turn", reqId: "x1", entryId: "e-ada" })
    await waitFor(() => m1.result("x1") !== undefined, "end-turn refused")
    expect(m1.result("x1")).toMatchObject({ ok: false, reason: "cannot" })
    h.dispatch({ t: "combat-set-active", entryId: "e-ada" })
    await settle(h, both)
    expect(m2.view!.table!.combat!.activeId).toBe("e-ada")
    await m1.send({ t: "end-turn", reqId: "x2", entryId: "e-ada" })
    await waitFor(() => m1.result("x2") !== undefined, "end-turn")
    expect(m1.result("x2")).toEqual({ reqId: "x2", ok: true })
    await settle(h, both)
    expect(m1.view!.table!.combat!.activeId).toBe("e-bo")
    for (const m of [m1, m2]) {
      const raw = m.raw.join("\n")
      expect(raw).not.toContain("SENTINEL_ASSASSIN")
      expect(raw).not.toContain("e-ass")
      expect(raw).not.toContain(k.assassin.id)
    }
    expect(m1.raw.join("\n")).not.toContain(k.goblin.id)
  })

  it("the table survives a host restart", async () => {
    const k = keep()
    const { fx, h } = await hosted(k.scene, [P1])
    const m = mirror(fx, P1)
    await settle(h, [[P1, m]])
    await m.send({ t: "say", reqId: "s1", text: "remember me", to: "all" })
    await waitFor(() => texts(m).includes("remember me"), "message")
    await h.save()
    await h.stop()
    const b = host(fx).host
    await b.start()
    expect(b.getSnapshot().state!.table!.log.map((x) => x.text)).toEqual(["remember me"])
    await settle(b, [[P1, m]])
    expect(texts(m)).toEqual(["remember me"])
  })
})
