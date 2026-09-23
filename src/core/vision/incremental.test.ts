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
  createPillar,
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

/** Every sample's light / sun / layout on two engines is identical. */
function expectSameSamples(a: VisionEngineImpl, b: VisionEngineImpl, scene: Scene, label: string): void {
  for (const levelId of Object.keys(scene.levels)) {
    for (let j = 0; j < scene.grid.depth; j++) {
      for (let i = 0; i < scene.grid.width; i++) {
        for (let k = 0; k < 5; k++) expect(a.inspectSample(levelId, i, j, k), `${label} (${i}, ${j}) #${k}`).toEqual(b.inspectSample(levelId, i, j, k))
      }
    }
  }
}

/** Dark scene with a low sun (grants bright) from azimuth `az`. */
function sunScene(width: number, depth: number, az: number, el: number): { scene: Scene; ground: Id } {
  const t = flat(width, depth, "dark")
  t.scene.environment.directional = { ...t.scene.environment.directional, enabled: true, grants: "bright", azimuth: az, elevation: el }
  return t
}

/** Brute-force sun test: a 1000 ft light-channel ray toward the sun from the sample (or its top probe). */
function bruteSunlit(engine: VisionEngineImpl, scene: Scene, levelId: Id, i: number, j: number, k: number): boolean | null {
  const s = engine.inspectSample(levelId, i, j, k)
  if (!s || !s.valid) return null
  const d = scene.environment.directional
  const el = Math.min(Math.PI / 2, Math.max(0.1, d.elevation))
  const dir = { x: Math.sin(d.azimuth) * Math.cos(el), y: Math.sin(el), z: Math.cos(d.azimuth) * Math.cos(el) }
  const far = (p: { x: number; y: number; z: number }) => ({ x: p.x + dir.x * 1000, y: p.y + dir.y * 1000, z: p.z + dir.z * 1000 })
  const world = engine.world
  if (!world.segmentBlocked(s.position, far(s.position), { channel: "light" })) return true
  return s.topProbe !== null && !world.segmentBlocked(s.topProbe, far(s.topProbe), { channel: "light" })
}

function expectBruteSun(engine: VisionEngineImpl, scene: Scene, label: string): number {
  let shadowed = 0
  for (const levelId of Object.keys(scene.levels)) {
    for (let j = 0; j < scene.grid.depth; j++) {
      for (let i = 0; i < scene.grid.width; i++) {
        for (let k = 0; k < 5; k++) {
          const want = bruteSunlit(engine, scene, levelId, i, j, k)
          if (want === null) continue
          if (!want) shadowed++
          expect(engine.inspectSample(levelId, i, j, k)!.sunlit, `${label} (${i}, ${j}) #${k}`).toBe(want)
        }
      }
    }
  }
  return shadowed
}

describe("sun rays and geometry outside the grid", () => {
  it("a wall just outside the grid shadows the cells next to it", () => {
    const { scene, ground } = sunScene(8, 8, -Math.PI / 2, 0.3)
    add(scene, createWall(ground, { x: -3, z: -10 }, { x: -3, z: 50 }, { height: 20 }))
    const viewer = addToken(scene, ground, 20, 20)
    const engine = new VisionEngineImpl(scene)
    const s = engine.inspectSample(ground, 0, 4, 0)!
    expect(s.sunlit).toBe(false)
    expect(s.light).toBe(0)
    const res = engine.compute([engine.viewerFor(viewer)])
    expect(res.perception[ground].grades[4 * 8 + 0]).toBe(0)
    // (The wall shadows the whole 40 ft grid: its top is 12 ft above the ray from the far column.)
    expect(expectBruteSun(engine, scene, "fresh")).toBe(8 * 8 * 5)
  })

  it("an incremental engine agrees with a fresh one after the out-of-grid wall is nudged", () => {
    const { scene: s0, ground } = sunScene(8, 8, -Math.PI / 2, 0.3)
    const wall = add(s0, createWall(ground, { x: -3, z: -10 }, { x: -3, z: 50 }, { height: 20 }))
    const viewer = addToken(s0, ground, 20, 20)
    const engine = new VisionEngineImpl(s0)
    const s1 = setObject(s0, { ...wall, a: { x: -3.1, z: -10 } })
    engine.update(s1, { objects: [wall.id] })
    expectSameSamples(engine, new VisionEngineImpl(s1), s1, "nudged")
    expectSame(engine, s1, [viewer], "nudged")
  })

  it("a tree outside the grid shadows exactly what brute-force rays say", () => {
    const { scene, ground } = sunScene(8, 8, -Math.PI / 2, 0.3)
    add(scene, createProp(ground, "tree", { x: -5, y: 0, z: 20 }))
    const engine = new VisionEngineImpl(scene)
    expect(expectBruteSun(engine, scene, "tree")).toBeGreaterThan(0)
  })

  it("adding a crate far outside the grid keeps incremental = fresh = brute force", () => {
    const { scene: s0, ground } = sunScene(8, 8, -Math.PI / 2, 0.3)
    add(s0, createWall(ground, { x: -3, z: 0 }, { x: -3, z: 20 }, { height: 20 }))
    const viewer = addToken(s0, ground, 20, 20)
    const engine = new VisionEngineImpl(s0)
    const crate = { ...createProp(ground, "crate", { x: -30, y: 0, z: 30 }), scale: { x: 1, y: 6, z: 8 } }
    const s1 = setObject(s0, crate)
    engine.update(s1, { objects: [crate.id] })
    expectSameSamples(engine, new VisionEngineImpl(s1), s1, "crate added")
    expectBruteSun(engine, s1, "crate added")
    expectSame(engine, s1, [viewer], "crate added")
  })

  it("a tall wall 8 ft west of the grid: fresh engine and one given the wall by update agree", () => {
    const { scene: withWall, ground } = sunScene(10, 10, (3 * Math.PI) / 2, 0.3)
    const without: Scene = { ...withWall, objects: { ...withWall.objects } }
    const wall = add(withWall, createWall(ground, { x: -8, z: -10 }, { x: -8, z: 60 }, { height: 40 }))
    const fresh = new VisionEngineImpl(withWall)
    const s = fresh.inspectSample(ground, 0, 5, 0)!
    expect(s.sunlit).toBe(false)
    expect(s.light).toBe(0)
    const incremental = new VisionEngineImpl(without)
    expect(incremental.inspectSample(ground, 0, 5, 0)!.sunlit).toBe(true)
    incremental.update(withWall, { objects: [wall.id] })
    expectSameSamples(incremental, fresh, withWall, "wall added")
  })
})

describe("sub-cell light after sun / occluder changes that move a shadow edge between sub-cells", () => {
  // Sun from +X. The shadow of the 10 ft wall at x = 35 ends at x = 34.75 − 9.75 / tan(el): 16.5
  // here, 17.2 after either edit. No sample of cell (3, 2) changes (x = 15.75, 17.5, 19.25), but the
  // sub-cell centre at x = 16.875 does.
  const el1 = Math.atan(9.75 / 18.25)
  const el2 = Math.atan(9.75 / 17.55)
  const setup = () => {
    const { scene, ground } = sunScene(8, 6, Math.PI / 2, el1)
    const wall = add(scene, createWall(ground, { x: 35, z: 0 }, { x: 35, z: 30 }, { height: 10, thickness: 0.5 }))
    const viewer = addToken(scene, ground, 2.5, 12.5)
    const engine = new VisionEngineImpl(scene)
    expectSame(engine, scene, [viewer], "initial")
    return { scene, ground, wall, viewer, engine }
  }
  const cell = 2 * 8 + 3

  it("sun elevation change", () => {
    const { scene: s0, ground, viewer, engine } = setup()
    const s1: Scene = { ...s0, environment: { ...s0.environment, directional: { ...s0.environment.directional, elevation: el2 } } }
    engine.update(s1, { structure: true })
    expectSame(engine, s1, [viewer], "elevation changed")
    const res = engine.compute([engine.viewerFor(viewer)])
    expect(res.perception[ground].partial.get(cell)).toBe(0x3333)
  })

  it("wall height change far from the shadow edge, then a viewer move (LightField sub-cell cache)", () => {
    const { scene: s0, ground, wall, viewer, engine } = setup()
    const s1 = setObject(s0, { ...wall, height: 0.25 + 17.55 * Math.tan(el1) })
    engine.update(s1, { objects: [wall.id] })
    expectSame(engine, s1, [viewer], "wall raised")
    expect(engine.compute([engine.viewerFor(viewer)]).perception[ground].partial.get(cell)).toBe(0x3333)
    const s2 = setToken(s1, { ...viewer, position: { x: 7.5, z: 12.5 } })
    engine.update(s2, { tokens: [viewer.id] })
    expectSame(engine, s2, [viewer], "viewer moved")
  })
})

describe("coplanar nearest-hit ties do not depend on ids or edit history", () => {
  // Wall P (box x ∈ [24, 50], z ∈ [19, 21]) and wall Q (box x ∈ [24, 26]) share the x = 24 face, so rays
  // to samples buried in P enter P and Q at the same t. A thin pole makes cell (5, 4) partial; a tree
  // canopy over the eye makes the side probe (first hit = a blocker containing the sample) decide.
  function tieScene(qId: string, lit: boolean): { scene: Scene; ground: Id; viewer: Token } {
    const { scene, ground } = flat(12, 8, lit ? "bright" : "dark")
    const put = <T extends SceneObject>(o: T, id: string): T => add(scene, { ...o, id })
    put(createWall(ground, { x: 24, z: 20 }, { x: 50, z: 20 }, { height: 10, thickness: 2 }), "P")
    put(createWall(ground, { x: 25, z: 20.92 }, { x: 25, z: 23.92 }, { height: 3, thickness: 2 }), qId)
    put(createPillar(ground, { x: 14, z: 23.37 }, { size: 0.4, height: 20, shape: "round" }), "pole")
    put(createProp(ground, "tree", { x: 20, y: 0, z: 18.2 }), "tree")
    let viewer: Token
    if (lit) {
      viewer = addToken(scene, ground, 2.5, 22.5, { eyeHeight: 9 })
    } else {
      scene.environment.directional = { ...scene.environment.directional, enabled: false }
      const light = put(createLight(ground, "torch", { x: 2.5, z: 22.5 }, { brightRadius: 60, dimRadius: 80, castsShadows: true }), "light")
      light.position.y = 9
      viewer = addToken(scene, ground, 28.125, 2.5, { eyeHeight: 9 })
    }
    return { scene, ground, viewer }
  }
  const cell = 4 * 12 + 5
  const partialOf = (scene: Scene, ground: Id, viewer: Token, engine = new VisionEngineImpl(scene)) =>
    engine.compute([engine.viewerFor(scene.tokens[viewer.id])]).perception[ground].partial.get(cell)

  it("line of sight: the same partial mask whatever the second wall is called", () => {
    for (const id of ["Q", "A"]) {
      const { scene, ground, viewer } = tieScene(id, true)
      expect(partialOf(scene, ground, viewer), id).toBe(287)
    }
  })

  it("line of sight: an edit round trip on P leaves the incremental engine equal to a fresh one", () => {
    const { scene: s0, ground, viewer } = tieScene("Q", true)
    const engine = new VisionEngineImpl(s0)
    expectSame(engine, s0, [viewer], "initial")
    const P = s0.objects.P
    if (P.type !== "wall") throw new Error("P")
    engine.update(setObject(s0, { ...P, height: 10.5 }), { objects: ["P"] })
    engine.update(s0, { objects: ["P"] })
    expectSame(engine, s0, [viewer], "P raised and restored")
    expect(partialOf(s0, ground, viewer, engine)).toBe(287)
  })

  it("light: a buried sample's light does not depend on which tied wall the ray reports", () => {
    for (const id of ["Q", "A"]) {
      const { scene, ground, viewer } = tieScene(id, false)
      expect(partialOf(scene, ground, viewer), id).toBe(15)
    }
  })
})
