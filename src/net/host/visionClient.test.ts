/**
 * Vision clients: the worker path (scene diffs over a structured-clone boundary) must give exactly the
 * results of the in-thread path and of a fresh engine on the final scene; tags report the revision a
 * compute ran on; a crashed worker fails every pending call and notifies once.
 */
import { produceWithPatches, type Patch } from "immer"
import { describe, expect, it } from "vitest"

import { createWall } from "@/core/scene/factory"
import { sampleById } from "@/core/scene/samples"
import type { Scene } from "@/core/scene/types"
import { deltaFromPatches, reduceDm, sceneWithTokenAt } from "@/core/session"
import { createGameState, type SceneDelta } from "@/core/session/state"
import type { GameState } from "@/core/session/types"
import { createVisionEngine } from "@/core/vision"

import { FakeWorker } from "./test-utils"
import { createInThreadVisionClient, createWorkerVisionClient } from "./visionClient"
import { applySceneDiff, diffForChange } from "./visionProtocol"

function lantern() {
  const scene = sampleById("crooked-lantern")!.build()
  const tokenByName = (name: string) => Object.values(scene.tokens).find((t) => t.name === name)!
  const doorByName = (name: string) => Object.values(scene.objects).find((o) => o.name === name)!
  return { scene, brunhild: tokenByName("Brunhild Ironvein"), aldric: tokenByName("Ser Aldric Vane"), pip: tokenByName("Pip Thistledown"), doorByName }
}

describe("scene diffs", () => {
  it("rebuild the next revision and keep the identity of unchanged entries", () => {
    const { scene, brunhild } = lantern()
    let state: GameState = createGameState({ sessionId: "s", roomCode: "R", scene })
    const r = reduceDm(state, { t: "move-token", tokenId: brunhild.id, levelId: brunhild.levelId, x: 72.5, z: 62.5 })
    state = r.state
    const diff = diffForChange(state.scene, r.delta)
    expect(diff.tokens).toEqual([[brunhild.id, state.scene.tokens[brunhild.id]]])
    expect(diff.levels).toBeUndefined()
    const next = applySceneDiff(scene, structuredClone(diff))
    expect(next.tokens[brunhild.id]).toEqual(state.scene.tokens[brunhild.id])
    expect(next.objects).toBe(scene.objects)
    for (const id of Object.keys(scene.tokens)) if (id !== brunhild.id) expect(next.tokens[id]).toBe(scene.tokens[id])
  })

  it("delete removed entries and replace levels on structure changes", () => {
    const { scene } = lantern()
    const wallId = Object.values(scene.objects).find((o) => o.type === "wall")!.id
    const [next, patches] = produceWithPatches(scene, (d) => {
      delete d.objects[wallId]
      d.environment.ambientLevel = "bright"
    })
    const delta = deltaFromPatches(scene, next, patches)
    const rebuilt = applySceneDiff(scene, structuredClone(diffForChange(next, delta)))
    expect(Object.hasOwn(rebuilt.objects, wallId)).toBe(false)
    expect(rebuilt.environment.ambientLevel).toBe("bright")
    // Unchanged levels keep their identity.
    for (const id of Object.keys(scene.levels)) expect(rebuilt.levels[id]).toBe(scene.levels[id])
  })
})

describe("vision clients", () => {
  it("worker diffs, in-thread and a fresh engine agree through a series of edits", async () => {
    const { scene, brunhild, aldric, pip, doorByName } = lantern()
    const fake = new FakeWorker()
    const worker = createWorkerVisionClient(fake)
    const local = createInThreadVisionClient()
    let state: GameState = createGameState({ sessionId: "s", roomCode: "R", scene })
    let tag = 1
    await Promise.all([worker.setScene(state.scene, tag), local.setScene(state.scene, tag)])
    const viewers = [brunhild.id, aldric.id, pip.id]

    const apply = async (delta: SceneDelta) => {
      tag++
      const change = { objects: delta.objects, tokens: delta.tokens, terrain: delta.terrain, structure: delta.structure }
      await Promise.all([worker.update(state.scene, change, tag), local.update(state.scene, change, tag)])
    }
    const check = async () => {
      const [a, b] = await Promise.all([worker.compute(viewers, tag), local.compute(viewers, tag)])
      expect(a.stateSeq).toBe(tag)
      expect(b.stateSeq).toBe(tag)
      const fresh = createVisionEngine(state.scene)
      const expected = fresh.compute(viewers.map((id) => fresh.viewerFor(state.scene.tokens[id])))
      expect(a.result).toEqual(expected)
      expect(b.result).toEqual(expected)
    }

    await check()
    // Token move (carried light follows).
    let r = reduceDm(state, { t: "move-token", tokenId: aldric.id, levelId: aldric.levelId, x: 117.5, z: 57.5 })
    state = r.state
    await apply(r.delta)
    await check()
    // Door toggle.
    r = reduceDm(state, { t: "set-door", doorId: doorByName("Pantry door").id, state: "open" })
    state = r.state
    await apply(r.delta)
    await check()
    // Editor patches: a new wall and an environment change (structure).
    const [nextScene, patches] = produceWithPatches(state.scene, (d: Scene) => {
      const w = createWall(brunhild.levelId, { x: 60, z: 60 }, { x: 60, z: 75 })
      d.objects[w.id] = w
      d.environment.skyLevel = "bright"
    })
    r = reduceDm(state, { t: "apply-scene-patches", patches: patches as Patch[] })
    expect(r.state.scene).toEqual(nextScene)
    state = r.state
    await apply(r.delta)
    await check()
    // Diffs are small compared with the scene.
    expect(fake.bytes).toBeLessThan(JSON.stringify(scene).length * 1.5)
    worker.dispose()
    local.dispose()
    expect(fake.terminated).toBe(true)
  })

  it("a compute reports the tag of the revision it ran on", async () => {
    const { scene, brunhild } = lantern()
    const client = createWorkerVisionClient(new FakeWorker())
    await client.setScene(scene, 5)
    const moved = reduceDm(createGameState({ sessionId: "s", roomCode: "R", scene }), { t: "move-token", tokenId: brunhild.id, levelId: brunhild.levelId, x: 72.5, z: 62.5 })
    // Posted in order: compute(before) → update(6) → compute(after).
    const before = client.compute([brunhild.id], 5)
    void client.update(moved.state.scene, moved.delta, 6)
    const after = client.compute([brunhild.id], 6)
    expect((await before).stateSeq).toBe(5)
    expect((await after).stateSeq).toBe(6)
    client.dispose()
  })

  it("a crashed worker rejects pending calls and reports the failure once", async () => {
    const { scene, brunhild } = lantern()
    const fake = new FakeWorker()
    const client = createWorkerVisionClient(fake)
    const failures: Error[] = []
    client.onFailure((e) => failures.push(e))
    await client.setScene(scene, 1)
    const pending = client.compute([brunhild.id], 1)
    fake.emit("error", { type: "error", message: "boom" } as unknown as Event)
    await expect(pending).rejects.toThrow(/boom/)
    await expect(client.compute([brunhild.id], 1)).rejects.toThrow(/boom/)
    expect(failures).toHaveLength(1)
    expect(fake.terminated).toBe(true)
  })

  it("a probe evaluates a step without changing the client's revision (worker and in-thread)", async () => {
    const { scene, brunhild, aldric } = lantern()
    const state = createGameState({ sessionId: "s", roomCode: "R", scene })
    const step = sceneWithTokenAt(state.scene, aldric.id, { cell: { i: 23, j: 11 }, levelId: aldric.levelId })
    const fresh = createVisionEngine(step)
    const expected = fresh.compute([fresh.viewerFor(step.tokens[aldric.id])])
    for (const client of [createWorkerVisionClient(new FakeWorker()), createInThreadVisionClient()]) {
      await client.setScene(state.scene, 7)
      const before = await client.compute([aldric.id, brunhild.id], 7)
      const probe = await client.probe(step, { tokens: [aldric.id] }, [[aldric.id], [aldric.id, brunhild.id]])
      expect(probe.stateSeq).toBe(7)
      expect(probe.results).toHaveLength(2)
      // The step's visibility, as a fresh engine on the step scene sees it.
      expect(probe.results[0]).toEqual(expected)
      // Afterwards everything is as before the probe: same tag, same result.
      const after = await client.compute([aldric.id, brunhild.id], 7)
      expect(after.stateSeq).toBe(7)
      expect(after.result).toEqual(before.result)
      expect(client.pendingProbes).toBe(0)
      client.dispose()
    }
  })

  it("probes wait for idle foreground work and run one at a time", async () => {
    const { scene, aldric } = lantern()
    const fake = new FakeWorker()
    const ops: string[] = []
    const post = fake.postMessage.bind(fake)
    fake.postMessage = (message: unknown) => {
      ops.push((message as { op: string }).op)
      post(message)
    }
    const client = createWorkerVisionClient(fake)
    const state = createGameState({ sessionId: "s", roomCode: "R", scene })
    const step = (i: number) => sceneWithTokenAt(state.scene, aldric.id, { cell: { i, j: 11 }, levelId: aldric.levelId })
    void client.setScene(state.scene, 1)
    const c1 = client.compute([aldric.id], 1)
    const p1 = client.probe(step(22), { tokens: [aldric.id] }, [[aldric.id]])
    const p2 = client.probe(step(23), { tokens: [aldric.id] }, [[aldric.id]])
    // Queued behind the foreground calls: nothing posted for them yet.
    expect(ops).toEqual(["setScene", "compute"])
    expect(client.pendingProbes).toBe(2)
    await c1
    await Promise.resolve()
    // Foreground idle: the first probe is posted, the second waits for it.
    expect(ops).toEqual(["setScene", "compute", "probe"])
    // A foreground call now waits for at most that one probe; the second probe goes after it.
    const c2 = client.compute([aldric.id], 1)
    expect(ops).toEqual(["setScene", "compute", "probe", "compute"])
    await Promise.all([p1, p2, c2])
    expect(ops).toEqual(["setScene", "compute", "probe", "compute", "probe"])
    expect(client.pendingProbes).toBe(0)
    // Disposing rejects queued probes.
    const busy = client.compute([aldric.id], 1).catch(() => "rejected")
    const queued = client.probe(step(24), { tokens: [aldric.id] }, [[aldric.id]])
    client.dispose()
    await expect(queued).rejects.toThrow(/disposed/)
    expect(await busy).toBe("rejected")
  })

  it("in-thread errors reject the call without breaking later ones", async () => {
    const client = createInThreadVisionClient()
    await expect(client.compute(["x"], 0)).rejects.toThrow(/before setScene/)
    const { scene, brunhild } = lantern()
    await client.setScene(scene, 1)
    const r = await client.compute([brunhild.id, "unknown-token"], 1)
    expect(r.stateSeq).toBe(1)
    expect(Object.keys(r.result.perception).length).toBeGreaterThan(0)
  })
})
