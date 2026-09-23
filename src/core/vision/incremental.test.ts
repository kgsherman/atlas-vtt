/**
 * The incremental engine (update() + cached light field / line of sight) must give exactly the
 * result of an engine built from scratch on the same scene revision.
 */
import { describe, expect, it } from "vitest"

import { paintHeightmap, rng } from "../occlusion/test-utils"
import {
  createConnector,
  createDoor,
  createLight,
  createProp,
  createWall,
  createWindow,
} from "../scene/factory"
import type { Id, Scene, SceneObject, Token } from "../scene/types"
import { createVisionEngine, encodeGrades, encodeMask, VisionEngineImpl } from "."
import { add, addLevel, addToken, flat } from "./test-scenes"
import type { VisibilityResult, VisionChange, VisionEngine } from "./types"

function snapshot(res: VisibilityResult) {
  const perception: Record<Id, unknown> = {}
  for (const [id, m] of Object.entries(res.perception)) perception[id] = encodeGrades(m)
  const sunlit: Record<Id, unknown> = {}
  for (const [id, m] of Object.entries(res.sunlit)) sunlit[id] = encodeMask(m)
  return {
    perception,
    sunlit,
    visible: [...res.visibleTokenIds].sort(),
    observed: [...res.observedObjectIds].sort(),
    lights: [...res.illuminatingLightIds].sort(),
  }
}

function expectSame(engine: VisionEngine, scene: Scene, tokens: Token[], label: string): string {
  const fresh = createVisionEngine(scene)
  const current = tokens.map((t) => scene.tokens[t.id])
  const vi = current.map((t) => engine.viewerFor(t))
  const vf = current.map((t) => fresh.viewerFor(t))
  expect(vi, label).toEqual(vf)
  const all = [snapshot(engine.compute(vi))]
  expect(all[0], label).toEqual(snapshot(fresh.compute(vf)))
  for (let k = 0; k < vi.length; k++) {
    all.push(snapshot(engine.compute([vi[k]])))
    expect(all[k + 1], `${label} / viewer ${k}`).toEqual(snapshot(fresh.compute([vf[k]])))
  }
  return JSON.stringify(all)
}

const setObject = (scene: Scene, o: SceneObject): Scene => ({ ...scene, objects: { ...scene.objects, [o.id]: o } })
const setToken = (scene: Scene, t: Token): Scene => ({ ...scene, tokens: { ...scene.tokens, [t.id]: t } })

describe("incremental updates", () => {
  it("match a fresh engine after every kind of change", () => {
    const { scene: s0, ground } = flat(24, 16, "dark")
    const upper = addLevel(s0, { name: "Upper", elevation: 10 }, { x: 0, z: 0, w: 60, d: 80 })
    paintHeightmap(s0, ground, (x, z) => (x > 80 ? 0.5 * Math.sin(x / 7) + 0.3 * Math.cos(z / 5) : 0), 2)
    const w1 = add(s0, createWall(ground, { x: 30, z: 0 }, { x: 30, z: 60 }))
    const door = add(s0, createDoor(w1, 22.5))
    add(s0, createWindow(w1, 45))
    const w2 = add(s0, createWall(ground, { x: 30, z: 60 }, { x: 80, z: 60 }, { height: 4 }))
    const stairs = add(s0, createConnector(ground, upper.id, { x: 10, z: 60, w: 5, d: 10 }, 0))
    const lamp = add(s0, createLight(ground, "lantern", { x: 15, z: 20 }))
    const brazier = add(s0, createLight(ground, "brazier", { x: 50, z: 30 }))
    add(s0, createLight(upper.id, "magical", { x: 30, z: 40 }))
    const elf = addToken(s0, ground, 12.5, 12.5, { vision: { darkvision: 60, blindsight: 0, blind: false } })
    const bearer = addToken(s0, ground, 42.5, 22.5)
    const torch = add(s0, createLight(ground, "torch", { x: 0, z: 0 }, { attachedTokenId: bearer.id, position: { x: 0, y: 4, z: 0 } }))
    const watcher = addToken(s0, upper.id, 22.5, 37.5)
    const viewers = [elf, bearer, watcher]

    const engine = new VisionEngineImpl(s0)
    let scene = s0
    let last = expectSame(engine, scene, viewers, "initial")
    const unchanged: string[] = []

    const step = (next: Scene, change: VisionChange, label: string) => {
      scene = next
      const world = engine.world
      engine.update(scene, change)
      // Only grid / level changes rebuild the world; everything else is incremental.
      expect(engine.world, label).toBe(world)
      const snap = expectSame(engine, scene, viewers, label)
      if (snap === last) unchanged.push(label)
      last = snap
    }

    step(setObject(scene, { ...door, state: "open" }), { objects: [door.id] }, "door opened")
    step(setObject(scene, { ...lamp, position: { ...lamp.position, x: 25, z: 45 } }), { objects: [lamp.id] }, "lamp moved")
    step(setObject(scene, { ...brazier, on: false }), { objects: [brazier.id] }, "brazier off")
    step(setToken(scene, { ...bearer, position: { x: 57.5, z: 32.5 } }), { tokens: [bearer.id] }, "torch bearer moved")
    const crate = createProp(ground, "crate", { x: 52.5, y: 0, z: 17.5 })
    step(setObject(scene, crate), { objects: [crate.id] }, "crate added")
    {
      const objects = { ...scene.objects }
      delete objects[w2.id]
      step({ ...scene, objects }, { objects: [w2.id] }, "wall deleted")
    }
    {
      const next = { ...scene, levels: { ...scene.levels } }
      paintHeightmap(next, ground, (x, z) => (x > 80 ? 2 * Math.sin(x / 9) + (z > 40 ? 1.5 : 0) : 0), 2)
      step(next, { terrain: [ground] }, "terrain edited")
    }
    step(
      { ...scene, environment: { ...scene.environment, skyLevel: "dim", directional: { ...scene.environment.directional, enabled: true } } },
      { structure: true },
      "sun and sky on"
    )
    step(setToken(scene, { ...elf, position: { x: 22.5, z: 32.5 } }), { tokens: [elf.id] }, "viewer moved")
    const candle = createLight(upper.id, "candle", { x: 12.5, z: 72.5 })
    step(setObject(scene, candle), { objects: [candle.id] }, "light added")
    step(setObject(scene, { ...stairs, rect: { x: 20, z: 60, w: 5, d: 10 } }), { objects: [stairs.id] }, "stairs moved")
    step(setObject(scene, { ...door, state: "closed" }), { objects: [door.id] }, "door closed")
    step(setObject(scene, { ...torch, hidden: true }), { objects: [torch.id] }, "carried torch hidden")
    step(setToken(scene, { ...bearer, hidden: true }), { tokens: [bearer.id] }, "bearer hidden")
    // Every step changed what the viewers perceive (the test is not vacuous).
    expect(unchanged).toEqual([])
  })

  it("match a fresh engine under random light and door churn", () => {
    const rand = rng(7)
    const { scene: s0, ground } = flat(30, 30, "dark")
    const doors: Id[] = []
    for (let k = 0; k < 6; k++) {
      const x = 25 * (k + 1)
      const wall = add(s0, createWall(ground, { x, z: 0 }, { x, z: 150 }))
      doors.push(add(s0, createDoor(wall, 20 + rand() * 110)).id)
    }
    const lights: Id[] = []
    for (let k = 0; k < 8; k++) lights.push(add(s0, createLight(ground, "torch", { x: 5 + rand() * 140, z: 5 + rand() * 140 })).id)
    const viewers = [
      addToken(s0, ground, 12.5, 72.5),
      addToken(s0, ground, 87.5, 22.5, { vision: { darkvision: 30, blindsight: 5, blind: false } }),
    ]
    const engine = createVisionEngine(s0)
    let scene = s0
    for (let it = 0; it < 12; it++) {
      const ids: Id[] = []
      for (let n = 0; n < 3; n++) {
        if (rand() < 0.5) {
          const id = doors[Math.floor(rand() * doors.length)]
          const d = scene.objects[id]
          if (d.type === "door") scene = setObject(scene, { ...d, state: d.state === "open" ? "closed" : "open" })
          ids.push(id)
        } else {
          const id = lights[Math.floor(rand() * lights.length)]
          const l = scene.objects[id]
          if (l.type === "light") scene = setObject(scene, { ...l, on: rand() < 0.7, position: { ...l.position, x: 5 + rand() * 140, z: 5 + rand() * 140 } })
          ids.push(id)
        }
      }
      engine.update(scene, { objects: ids })
      expectSame(engine, scene, viewers, `iteration ${it}`)
    }
  })
})
