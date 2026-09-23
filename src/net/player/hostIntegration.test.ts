/**
 * The player client against the REAL host runner (net/host) over LocalTransport + the local sessions
 * repo: join → live, moves through the authoritative pipeline, DM away → stored view, DM back → live.
 */
import { afterEach, describe, expect, it } from "vitest"

import { createScene, createToken } from "@/core/scene/factory"
import type { AssetStore } from "@/net/assets/types"
import { createHostRunner, createInThreadVisionClient } from "@/net/host"

import type { AtlasIdentity } from "../auth"
import { createMemoryStore } from "../localStore"
import { LocalTransport } from "../localTransport"
import { createLocalScenesRepo } from "../scenesRepo"
import { createLocalSessionsRepo } from "../sessionsRepo"
import type { BackdropCanvas } from "./backdropCanvas"
import { createPlayerClient } from "./index"

const DM = "d0000000-0000-4000-8000-000000000001"
const P1 = "a1000000-0000-4000-8000-000000000001"

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const assets = {
  mode: "local",
  publishTiles: async () => {},
  grantTiles: async () => {},
  getImage: async () => null,
  putImage: async () => {
    throw new Error("unused")
  },
  deleteImage: async () => {},
  copyImages: async () => {},
} as unknown as AssetStore

function fakeCanvas(width: number, height: number): BackdropCanvas {
  const ctx = { clearRect() {}, drawImage() {}, imageSmoothingEnabled: true, imageSmoothingQuality: "low" }
  return { width, height, getContext: () => ctx } as unknown as BackdropCanvas
}

describe("player client ↔ real host runner", () => {
  it("joins, moves, survives the DM leaving and coming back", async () => {
    const store = createMemoryStore()
    let as = DM
    const dmRepo = createLocalSessionsRepo({ store, userId: () => as })
    const playerRepo = createLocalSessionsRepo({ store, userId: () => P1 })
    const scene = createScene({ name: "Keep", width: 10, depth: 10 })
    scene.environment.skyLevel = "bright"
    scene.environment.ambientLevel = "bright"
    const ground = Object.keys(scene.levels)[0]
    const token = createToken(ground, { x: 12.5, z: 12.5 }, { name: "Brunhild" })
    scene.tokens[token.id] = token
    const summary = await createLocalScenesRepo(store).create(scene)
    const { sessionId, roomCode } = await dmRepo.createSession(summary.id)
    as = P1
    await dmRepo.joinSession(roomCode, "Alice")
    as = DM

    const namespace = `atlas-int-${crypto.randomUUID()}`
    const transport = () => {
      const t = new LocalTransport({ namespace, rate: null })
      cleanups.push(() => t.dispose())
      return t
    }
    const dmIdentity: AtlasIdentity = { userId: DM, isAnonymous: false, displayName: "DM", mode: "local" }
    const newHost = () => {
      const h = createHostRunner({
        sessionId,
        transport: transport(),
        repo: dmRepo,
        identity: dmIdentity,
        assets,
        createVisionClient: createInThreadVisionClient,
        locks: null,
        tileCodec: null,
        watchVisibility: false,
      })
      cleanups.push(() => h.stop())
      return h
    }
    const host = newHost()
    await host.start()
    await waitFor(() => host.getSnapshot().status === "hosting", "hosting")
    const hostTokenId = Object.keys(host.getSnapshot().state!.scene.tokens)[0]
    host.dispatch({ t: "assign-token", tokenId: hostTokenId, userId: P1, assigned: true })

    const client = createPlayerClient({
      sessionId,
      transport: transport(),
      repo: playerRepo,
      identity: { userId: P1, isAnonymous: true, displayName: "Alice", mode: "local" },
      tiles: { getTile: async () => null, dispose() {} },
      timings: { hostPresenceGraceMs: 150, pendingTimeoutMs: 2000 },
      backdrop: { createCanvas: fakeCanvas },
    })
    cleanups.push(() => client.stop())
    await client.start()
    await waitFor(() => client.getSnapshot().status === "live" && (client.getSnapshot().view?.controlledTokenIds.length ?? 0) > 0, "live with a token")
    const tokenId = client.getSnapshot().view!.controlledTokenIds[0]
    expect(tokenId).toBe(hostTokenId)

    const reqId = client.requestMove(tokenId, [
      { cell: { i: 2, j: 2 }, levelId: ground },
      { cell: { i: 3, j: 2 }, levelId: ground },
      { cell: { i: 4, j: 3 }, levelId: ground },
    ])
    await waitFor(() => client.getSnapshot().pending.length === 0, "move settled")
    expect(client.getSnapshot().results.find((r) => r.reqId === reqId)).toMatchObject({ ok: true })
    await waitFor(() => client.getSnapshot().scene?.tokens[tokenId]?.position.x === 22.5, "token moved")
    expect(client.getSnapshot().scene?.tokens[tokenId].position).toEqual({ x: 22.5, z: 17.5 })

    // The DM leaves: the stored view keeps the game on screen, input is disabled.
    await host.stop()
    await waitFor(() => client.getSnapshot().status === "host-offline", "host offline")
    expect(client.getSnapshot().view).not.toBeNull()
    const blocked = client.requestMove(tokenId, [{ cell: { i: 4, j: 3 }, levelId: ground }])
    expect(client.getSnapshot().results.at(-1)).toEqual({ reqId: blocked, ok: false, local: "host-offline" })

    // The DM comes back (new host run, new wire epoch).
    const epochBefore = client.getSnapshot().epoch
    const again = newHost()
    await again.start()
    await waitFor(() => client.getSnapshot().status === "live" && client.getSnapshot().epoch !== epochBefore, "live with the new host run")
    expect(client.getSnapshot().scene?.tokens[tokenId].position).toEqual({ x: 22.5, z: 17.5 })
  }, 20_000)
})
