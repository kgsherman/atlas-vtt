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
import { deltaFromPatches, reduceDm } from "@/core/session"
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
