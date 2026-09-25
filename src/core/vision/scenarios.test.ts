/**
 * Spec scenarios (docs/SPEC.md "Lighting and vision", docs/ARCHITECTURE.md §5.2) on hand-built scenes.
 * Cells are 5 ft; cell (i, j) spans x ∈ [5i, 5i+5), z ∈ [5j, 5j+5).
 */
import { describe, expect, it } from "vitest"

import { buildOcclusionWorld } from "../occlusion"
import { paintHeightmap } from "../occlusion/test-utils"
import { createConnector, createDoor, createFloor, createLight, createPillar, createProp, createWall, createWindow } from "../scene/factory"
import { createVisionEngine, resolveViewerEye, VisionEngineImpl } from "."
import { add, addLevel, addToken, flat, grade, partial, perceivedCount, subPerceived, sunlitCell, withObject, withToken } from "./test-scenes"
import type { VisibilityResult } from "./types"

describe("eye height and low walls", () => {
  // Outdoors in daylight; a 3 ft wall along x = 25 (cells i ≥ 5 are behind it).
  const { scene, ground } = flat(20, 10)
  add(scene, createWall(ground, { x: 25, z: 0 }, { x: 25, z: 50 }, { height: 3 }))
  const halfling = addToken(scene, ground, 17.5, 22.5, { size: "small", eyeHeight: 3, height: 3.5 })
  const human = addToken(scene, ground, 12.5, 22.5, { size: "medium" })
  const giant = addToken(scene, ground, 15, 22.5, { size: "huge", eyeHeight: 14, height: 16 })
  const engine = createVisionEngine(scene)

  it("a halfling (eye 3 ft) cannot perceive the floor behind a 3 ft wall", () => {
    const res = engine.compute([engine.viewerFor(halfling)])
    for (const i of [5, 6, 8, 12, 19]) expect(grade(res, ground, i, 4)).toBe(0)
    expect(grade(res, ground, 2, 4)).toBe(3)
  })

  it("a hill giant (eye 14 ft) perceives the floor just behind it", () => {
    const res = engine.compute([engine.viewerFor(giant)])
    // The far part of the first cell behind the wall, then everything beyond.
    expect(grade(res, ground, 5, 4)).toBe(3)
    expect(partial(res, ground, 5, 4)).toBeDefined()
    expect(subPerceived(res, ground, 5, 4, 3, 1)).toBe(true)
    expect(subPerceived(res, ground, 5, 4, 0, 1)).toBe(false)
    for (const i of [6, 8, 12, 19]) {
      expect(grade(res, ground, i, 4)).toBe(3)
      expect(partial(res, ground, i, 4)).toBeUndefined()
    }
  })

  it("a human (eye 5.5 ft) sees the floor a few cells behind the wall but not right behind it", () => {
    const res = engine.compute([engine.viewerFor(human)])
    expect(grade(res, ground, 5, 4)).toBe(0)
    expect(grade(res, ground, 8, 4)).toBe(3)
  })

  it("the union of viewers takes the best grade", () => {
    const res = engine.compute([engine.viewerFor(halfling), engine.viewerFor(giant)])
    expect(grade(res, ground, 6, 4)).toBe(3)
  })
})

describe("levels", () => {
  it("a token on a balcony perceives the courtyard below", () => {
    const { scene, ground } = flat(20, 20, "dark")
    scene.environment.skyLevel = "bright"
    // Upper level floor over x ∈ [0, 25): the balcony. The courtyard beyond is open to the sky.
    const upper = addLevel(scene, { name: "Upper", elevation: 10 }, { x: 0, z: 0, w: 25, d: 100 })
    const watcher = addToken(scene, upper.id, 22.5, 52.5)
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(watcher)])
    expect(grade(res, ground, 10, 10)).toBe(3)
    expect(grade(res, ground, 15, 12)).toBe(3)
    // Under the balcony: hidden by its own floor, and dark anyway.
    expect(grade(res, ground, 2, 10)).toBe(0)
    // Its own level is perceived too.
    expect(grade(res, upper.id, 2, 10)).toBe(3)
  })

  it("a large token clamped under a ceiling still sees its room; a huge one does not see through the slab", () => {
    const { scene, ground } = flat(12, 12)
    const upper = addLevel(scene, { name: "Upper", elevation: 10 }, { x: 0, z: 0, w: 60, d: 60 })
    const large = addToken(scene, ground, 20, 20, { size: "large", eyeHeight: 9, height: 10 })
    const huge = addToken(scene, ground, 32.5, 32.5, { size: "huge", eyeHeight: 14, height: 16 })
    const engine = createVisionEngine(scene)
    const world = buildOcclusionWorld(scene)
    // Ceiling = underside of the upper slab (10 − 1) → eye 0.25 below it.
    expect(resolveViewerEye(world, scene, large).y).toBeCloseTo(8.75, 6)
    expect(resolveViewerEye(world, scene, huge).y).toBeCloseTo(8.75, 6)
    const resLarge = engine.compute([engine.viewerFor(large)])
    expect(grade(resLarge, ground, 10, 10)).toBe(3)
    expect(grade(resLarge, ground, 0, 0)).toBe(3)
    expect(perceivedCount(resLarge, upper.id)).toBe(0)
    const resHuge = engine.compute([engine.viewerFor(huge)])
    expect(perceivedCount(resHuge, upper.id)).toBe(0)
    expect(grade(resHuge, ground, 1, 1)).toBe(3)
  })

  it("a stairwell lets sight pass between levels", () => {
    const { scene, ground } = flat(12, 12)
    const upper = addLevel(scene, { name: "Upper", elevation: 10 }, { x: 0, z: 0, w: 60, d: 60 })
    // Stairs up +Z over x ∈ [20, 25), z ∈ [20, 30): cut out of the upper floor.
    const stairs = add(scene, createConnector(ground, upper.id, { x: 20, z: 20, w: 5, d: 10 }, 0))
    const above = addToken(scene, upper.id, 22.5, 32.5)
    const climbing = addToken(scene, ground, 22.5, 27.5)
    const cellar = addToken(scene, ground, 52.5, 52.5)
    const engine = createVisionEngine(scene)

    // Looking down the stairwell: the run and the lower floor beyond its foot.
    const down = engine.compute([engine.viewerFor(above)])
    expect(grade(down, ground, 4, 4)).toBe(3)
    expect(grade(down, ground, 4, 5)).toBe(3)
    expect(grade(down, ground, 4, 2)).toBe(3)
    // The top row of the run is also sampleable on the upper level.
    expect(engine instanceof VisionEngineImpl && engine.inspectSample(upper.id, 4, 5)?.valid).toBe(true)
    expect(engine instanceof VisionEngineImpl && engine.inspectSample(upper.id, 4, 4)?.valid).toBe(false)
    // Far from the hole the lower level is hidden by the slab.
    expect(grade(down, ground, 10, 10)).toBe(0)

    // A token near the top of the run (still on the lower level) sees the upper floor.
    const eye = engine.viewerFor(climbing).eye
    expect(eye.y).toBeCloseTo(7.5 + 5.5, 6)
    const up = engine.compute([engine.viewerFor(climbing)])
    expect(grade(up, upper.id, 4, 7)).toBe(3)

    // A token elsewhere on the lower level perceives nothing upstairs.
    const res = engine.compute([engine.viewerFor(cellar)])
    expect(perceivedCount(res, upper.id)).toBe(0)
    expect(stairs.levelId).toBe(ground)
  })
})

describe("senses", () => {
  it("darkvision 60 perceives darkness in greyscale within 60 ft and nothing beyond", () => {
    const { scene, ground } = flat(40, 10, "dark")
    const elf = addToken(scene, ground, 2.5, 22.5, { vision: { darkvision: 60, blindsight: 0, blind: false } })
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(elf)])
    expect(grade(res, ground, 5, 4)).toBe(2)
    expect(grade(res, ground, 10, 4)).toBe(2)
    expect(partial(res, ground, 10, 4)).toBeUndefined()
    // The 60 ft sphere crosses cell 12.
    expect(grade(res, ground, 12, 4)).toBe(2)
    expect(partial(res, ground, 12, 4)).toBeDefined()
    expect(grade(res, ground, 14, 4)).toBe(0)
    expect(grade(res, ground, 30, 4)).toBe(0)
  })

  it("torch-lit cells are perceived in full colour; darkness beyond is not", () => {
    const { scene, ground } = flat(40, 10, "dark")
    const torch = add(scene, createLight(ground, "torch", { x: 52.5, z: 22.5 }))
    const human = addToken(scene, ground, 2.5, 22.5)
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(human)])
    expect(grade(res, ground, 10, 4)).toBe(3)
    expect(grade(res, ground, 5, 4)).toBe(3)
    expect(grade(res, ground, 18, 4)).toBe(3)
    expect(grade(res, ground, 1, 4)).toBe(0)
    expect(grade(res, ground, 25, 4)).toBe(0)
    // Its own cell by touch only.
    expect(grade(res, ground, 0, 4)).toBe(1)
    expect(res.illuminatingLightIds.has(torch.id)).toBe(true)
  })

  it("blindsight 10 perceives within 10 ft even when blind", () => {
    const { scene, ground } = flat(20, 10)
    const bat = addToken(scene, ground, 22.5, 22.5, { vision: { darkvision: 0, blindsight: 10, blind: true } })
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(bat)])
    expect(grade(res, ground, 4, 4)).toBe(1)
    expect(grade(res, ground, 5, 4)).toBe(1)
    expect(grade(res, ground, 3, 4)).toBe(1)
    expect(grade(res, ground, 4, 5)).toBe(1)
    expect(grade(res, ground, 7, 4)).toBe(0)
    expect(grade(res, ground, 1, 4)).toBe(0)
    const m = res.perception[ground]
    expect(Math.max(...m.grades)).toBe(1)
  })

  it("blindsight works in darkness too", () => {
    const { scene, ground } = flat(20, 10, "dark")
    const bat = addToken(scene, ground, 22.5, 22.5, { vision: { darkvision: 0, blindsight: 10, blind: false } })
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(bat)])
    expect(grade(res, ground, 5, 4)).toBe(1)
    expect(grade(res, ground, 8, 4)).toBe(0)
  })

  it("a blind viewer without blindsight perceives only its own footprint", () => {
    const { scene, ground } = flat(20, 10)
    const blind = addToken(scene, ground, 22.5, 22.5, { vision: { darkvision: 60, blindsight: 0, blind: true } })
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(blind)])
    expect(perceivedCount(res, ground)).toBe(1)
    expect(grade(res, ground, 4, 4)).toBe(1)
    // A large blind creature: its 2×2 footprint.
    const ogre = addToken(scene, ground, 50, 25, { size: "large", vision: { darkvision: 0, blindsight: 0, blind: true } })
    const engine2 = createVisionEngine(scene)
    const res2 = engine2.compute([engine2.viewerFor(ogre)])
    expect(perceivedCount(res2, ground)).toBe(4)
    expect(grade(res2, ground, 9, 4)).toBe(1)
    expect(grade(res2, ground, 10, 5)).toBe(1)
  })
})

describe("doors and windows", () => {
  function room() {
    const { scene, ground } = flat(20, 10)
    const wall = add(scene, createWall(ground, { x: 25, z: 0 }, { x: 25, z: 50 }))
    const viewer = addToken(scene, ground, 12.5, 22.5)
    return { scene, ground, wall, viewer }
  }

  it("a closed door blocks sight; opening it (incremental update) reveals the far side", () => {
    const { scene, ground, wall, viewer } = room()
    const door = add(scene, createDoor(wall, 22.5))
    const engine = createVisionEngine(scene)
    const closed = engine.compute([engine.viewerFor(viewer)])
    for (const i of [5, 6, 10]) expect(grade(closed, ground, i, 4)).toBe(0)
    expect(closed.observedObjectIds.has(door.id)).toBe(true)

    const opened = withObject(scene, { ...door, state: "open" as const })
    engine.update(opened, { objects: [door.id] })
    const open = engine.compute([engine.viewerFor(viewer)])
    expect(grade(open, ground, 6, 4)).toBe(3)
    expect(grade(open, ground, 10, 4)).toBe(3)
    expect(grade(open, ground, 6, 0)).toBe(0)

    // And closing it again.
    engine.update(scene, { objects: [door.id] })
    const again = engine.compute([engine.viewerFor(viewer)])
    expect(grade(again, ground, 6, 4)).toBe(0)
  })

  it("a portcullis (closed) does not block sight", () => {
    const { scene, ground, wall, viewer } = room()
    add(scene, createDoor(wall, 22.5, { style: "portcullis" }))
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(viewer)])
    expect(grade(res, ground, 6, 4)).toBe(3)
  })

  it("a window does not block sight above its sill", () => {
    const { scene, ground, wall, viewer } = room()
    add(scene, createWindow(wall, 22.5))
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(viewer)])
    // Rays to the floor right behind pass below the 3 ft sill; farther floor is seen through the pane.
    expect(grade(res, ground, 5, 4)).toBe(0)
    expect(grade(res, ground, 8, 4)).toBe(3)
    expect(grade(res, ground, 9, 4)).toBe(3)
    expect(grade(res, ground, 8, 0)).toBe(0)
  })
})

describe("sun, sky and lights", () => {
  function roofed() {
    const { scene, ground } = flat(20, 10, "dark")
    // A roof (upper level floor) over x ∈ [0, 50).
    const roof = addLevel(scene, { name: "Roof", elevation: 10 }, { x: 0, z: 0, w: 50, d: 50 })
    const viewer = addToken(scene, ground, 52.5, 22.5)
    return { scene, ground, roof, viewer }
  }

  it("the sun lights the outdoors but not under a roof", () => {
    const { scene, ground, viewer } = roofed()
    scene.environment.directional = { ...scene.environment.directional, enabled: true, kind: "sun", elevation: Math.PI / 2, grants: "bright" }
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(viewer)])
    expect(grade(res, ground, 15, 4)).toBe(3)
    expect(sunlitCell(res, ground, 15, 4)).toBe(true)
    expect(grade(res, ground, 5, 4)).toBe(0)
    expect(sunlitCell(res, ground, 5, 4)).toBe(false)
  })

  it("a low sun casts long shadows from the roof edge", () => {
    const { scene, ground, viewer } = roofed()
    // Sun from +X (azimuth π/2) at 45°: the roof edge at x = 50 shades nothing outdoors;
    // from −X it shades the ground up to ~9 ft past the edge.
    scene.environment.directional = { ...scene.environment.directional, enabled: true, azimuth: -Math.PI / 2, elevation: Math.PI / 4, grants: "bright" }
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(viewer)])
    expect(grade(res, ground, 10, 4)).toBe(1) // own footprint only (shaded)
    expect(sunlitCell(res, ground, 12, 4)).toBe(true)
    expect(grade(res, ground, 12, 4)).toBe(3)
  })

  it("the sky level applies where the sky is overhead", () => {
    const { scene, ground, viewer } = roofed()
    scene.environment.skyLevel = "dim"
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(viewer)])
    expect(grade(res, ground, 15, 4)).toBe(3)
    expect(grade(res, ground, 5, 4)).toBe(0)
    expect(res.sunlit[ground]).toBeUndefined()
  })

  it("switching the sun on is applied incrementally (structure change)", () => {
    const { scene, ground, viewer } = roofed()
    const engine = createVisionEngine(scene)
    expect(grade(engine.compute([engine.viewerFor(viewer)]), ground, 15, 4)).toBe(0)
    const sunny = { ...scene, environment: { ...scene.environment, directional: { ...scene.environment.directional, enabled: true, elevation: Math.PI / 2 } } }
    engine.update(sunny, { structure: true })
    const res = engine.compute([engine.viewerFor(viewer)])
    expect(grade(res, ground, 15, 4)).toBe(3)
    expect(grade(res, ground, 5, 4)).toBe(0)
  })

  it("a hidden light, or a light carried by a hidden token, does not illuminate", () => {
    const { scene, ground } = flat(40, 10, "dark")
    const viewer = addToken(scene, ground, 2.5, 22.5)
    const lamp = add(scene, createLight(ground, "torch", { x: 52.5, z: 22.5 }, { hidden: true }))
    const sneak = addToken(scene, ground, 152.5, 22.5, { hidden: true })
    const carried = add(scene, createLight(ground, "torch", { x: 0, z: 0 }, { attachedTokenId: sneak.id, position: { x: 0, y: 4, z: 0 } }))
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(viewer)])
    expect(grade(res, ground, 10, 4)).toBe(0)
    expect(grade(res, ground, 30, 4)).toBe(0)
    expect(res.illuminatingLightIds.size).toBe(0)
    // Unhiding the lamp (incremental).
    const shown = withObject(scene, { ...lamp, hidden: false })
    engine.update(shown, { objects: [lamp.id] })
    const res2 = engine.compute([engine.viewerFor(viewer)])
    expect(grade(res2, ground, 10, 4)).toBe(3)
    expect(res2.illuminatingLightIds.has(lamp.id)).toBe(true)
    expect(res2.illuminatingLightIds.has(carried.id)).toBe(false)
  })

  it("a light attached to a token moves with it", () => {
    const { scene, ground } = flat(40, 10, "dark")
    const viewer = addToken(scene, ground, 2.5, 22.5)
    const bearer = addToken(scene, ground, 52.5, 22.5)
    const torch = add(scene, createLight(ground, "torch", { x: 0, z: 0 }, { attachedTokenId: bearer.id, position: { x: 0, y: 4, z: 0 } }))
    const engine = createVisionEngine(scene)
    const before = engine.compute([engine.viewerFor(viewer)])
    expect(grade(before, ground, 10, 4)).toBe(3)
    expect(grade(before, ground, 30, 4)).toBe(0)
    expect(before.visibleTokenIds.has(bearer.id)).toBe(true)

    const moved = withToken(scene, { ...bearer, position: { x: 152.5, z: 22.5 } })
    engine.update(moved, { tokens: [bearer.id] })
    const after = engine.compute([engine.viewerFor(viewer)])
    expect(grade(after, ground, 10, 4)).toBe(0)
    expect(grade(after, ground, 30, 4)).toBe(3)
    expect(after.visibleTokenIds.has(bearer.id)).toBe(true)
    expect(after.illuminatingLightIds.has(torch.id)).toBe(true)
    // Attached lights are never observed as objects.
    expect(after.observedObjectIds.has(torch.id)).toBe(false)
  })

  it("an unshadowed light shines through walls", () => {
    const { scene, ground } = flat(20, 10, "dark")
    add(scene, createWall(ground, { x: 25, z: 0 }, { x: 25, z: 50 }))
    add(scene, createLight(ground, "torch", { x: 32.5, z: 22.5 }, { castsShadows: false }))
    const viewer = addToken(scene, ground, 22.5, 22.5)
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(viewer)])
    expect(grade(res, ground, 3, 4)).toBe(3)
    // Shadowed version: the wall keeps the viewer's side dark.
    const { scene: s2, ground: g2 } = flat(20, 10, "dark")
    add(s2, createWall(g2, { x: 25, z: 0 }, { x: 25, z: 50 }))
    add(s2, createLight(g2, "torch", { x: 32.5, z: 22.5 }))
    const v2 = addToken(s2, g2, 22.5, 22.5)
    const e2 = createVisionEngine(s2)
    expect(grade(e2.compute([e2.viewerFor(v2)]), g2, 3, 4)).toBe(0)
  })
})

describe("buried samples and sub-cells", () => {
  it("a sample inside a boulder counts as seen via the side probe", () => {
    const { scene, ground } = flat(20, 10)
    // A small boulder (r = 1.125 ft) buries the centre sample but hides none of the corner samples.
    add(scene, { ...createProp(ground, "rock", { x: 32.5, y: 0, z: 22.5 }), scale: { x: 0.5, y: 0.5, z: 0.5 } })
    const viewer = addToken(scene, ground, 12.5, 22.5)
    const engine = new VisionEngineImpl(scene)
    expect(engine.inspectSample(ground, 6, 4, 0)?.buried).toBe(true)
    expect(engine.inspectSample(ground, 6, 4, 1)?.buried).toBe(false)
    const res = engine.compute([engine.viewerFor(viewer)])
    expect(grade(res, ground, 6, 4)).toBe(3)
    expect(partial(res, ground, 6, 4)).toBeUndefined()
  })

  it("a full-size boulder hides the floor behind it within its own cell", () => {
    const { scene, ground } = flat(20, 10)
    add(scene, createProp(ground, "rock", { x: 32.5, y: 0, z: 22.5 }))
    const viewer = addToken(scene, ground, 12.5, 22.5)
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(viewer)])
    expect(grade(res, ground, 6, 4)).toBe(3)
    // The boulder itself (buried sub-cells, via side probes) and the floor in front of it are seen…
    expect(subPerceived(res, ground, 6, 4, 1, 1)).toBe(true)
    expect(subPerceived(res, ground, 6, 4, 2, 2)).toBe(true)
    expect(subPerceived(res, ground, 6, 4, 0, 1)).toBe(true)
    // …the floor right behind it is not.
    expect(subPerceived(res, ground, 6, 4, 3, 0)).toBe(false)
    expect(subPerceived(res, ground, 6, 4, 3, 3)).toBe(false)
  })

  it("a crate behind a low wall is seen via its top probe", () => {
    const { scene, ground } = flat(20, 10)
    add(scene, createWall(ground, { x: 20, z: 0 }, { x: 20, z: 50 }, { height: 2.5 }))
    add(scene, createProp(ground, "crate", { x: 22.5, y: 0, z: 22.5 }))
    const viewer = addToken(scene, ground, 7.5, 22.5)
    const engine = new VisionEngineImpl(scene)
    const probe = engine.inspectSample(ground, 4, 4, 0)?.topProbe
    expect(probe?.y).toBeCloseTo(3.25, 6)
    const res = engine.compute([engine.viewerFor(viewer)])
    expect(grade(res, ground, 4, 4)).toBe(3)
    // Only the crate top is visible: the 4 central sub-cells.
    expect(partial(res, ground, 4, 4)).toBe(0x0660)
  })

  it("a full-height pillar has no top probe", () => {
    const { scene, ground } = flat(10, 10)
    addLevel(scene, { name: "Upper", elevation: 10 }, { x: 0, z: 0, w: 50, d: 50 })
    add(scene, createPillar(ground, { x: 22.5, z: 22.5 }, { shape: "square", size: 2, height: null }))
    // A tall rock reaching into the slab above: its probe would be above the ceiling.
    add(scene, { ...createProp(ground, "rock", { x: 32.5, y: 0, z: 22.5 }), scale: { x: 1, y: 3, z: 1 } })
    const engine = new VisionEngineImpl(scene)
    const rock = engine.inspectSample(ground, 6, 4, 0)
    expect(rock?.buried).toBe(true)
    expect(rock?.topProbe).toBeNull()
    const info = engine.inspectSample(ground, 4, 4, 0)
    expect(info?.buried).toBe(true)
    expect(info?.topProbe).toBeNull()
  })

  it("a cell split by a diagonal wall is refined into sub-cells", () => {
    const { scene, ground } = flat(12, 12)
    add(scene, createWall(ground, { x: 0, z: 0 }, { x: 50, z: 50 }))
    const viewer = addToken(scene, ground, 37.5, 12.5)
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(viewer)])
    expect(grade(res, ground, 4, 4)).toBe(3)
    const p = partial(res, ground, 4, 4)
    expect(p).toBeDefined()
    // Viewer's side (x > z) perceived; the far side not.
    expect(subPerceived(res, ground, 4, 4, 3, 0)).toBe(true)
    expect(subPerceived(res, ground, 4, 4, 2, 1)).toBe(true)
    expect(subPerceived(res, ground, 4, 4, 0, 3)).toBe(false)
    expect(subPerceived(res, ground, 4, 4, 1, 2)).toBe(false)
    // Cells wholly on the far side are not perceived at all.
    expect(grade(res, ground, 2, 6)).toBe(0)
  })
})

describe("token visibility", () => {
  it("tokens behind a wall are not visible; a head over a low wall is", () => {
    const { scene, ground } = flat(20, 10)
    add(scene, createWall(ground, { x: 25, z: 0 }, { x: 25, z: 20 }))
    add(scene, createWall(ground, { x: 25, z: 30 }, { x: 25, z: 50 }, { height: 3 }))
    const halfling = addToken(scene, ground, 12.5, 32.5, { size: "small", eyeHeight: 3, height: 3.5 })
    const behindFull = addToken(scene, ground, 32.5, 7.5)
    const behindLow = addToken(scene, ground, 32.5, 37.5)
    const cat = addToken(scene, ground, 32.5, 42.5, { size: "tiny", eyeHeight: 1, height: 1.5 })
    const hidden = addToken(scene, ground, 7.5, 32.5, { hidden: true })
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(halfling)])
    expect(res.visibleTokenIds.has(behindFull.id)).toBe(false)
    expect(res.visibleTokenIds.has(behindLow.id)).toBe(true)
    expect(res.visibleTokenIds.has(cat.id)).toBe(false)
    // Hidden tokens are reported; the session filters them.
    expect(res.visibleTokenIds.has(hidden.id)).toBe(true)
    // Viewers are never listed.
    expect(res.visibleTokenIds.has(halfling.id)).toBe(false)
  })

  it("a token in darkness is visible only to darkvision or blindsight in range", () => {
    const { scene, ground } = flat(20, 10, "dark")
    const human = addToken(scene, ground, 12.5, 22.5)
    const elf = addToken(scene, ground, 12.5, 27.5, { vision: { darkvision: 60, blindsight: 0, blind: false } })
    const orc = addToken(scene, ground, 52.5, 22.5)
    const engine = createVisionEngine(scene)
    expect(engine.compute([engine.viewerFor(human)]).visibleTokenIds.has(orc.id)).toBe(false)
    expect(engine.compute([engine.viewerFor(elf)]).visibleTokenIds.has(orc.id)).toBe(true)
  })
})

describe("observation", () => {
  it("a door is observed only via its own footprint cells", () => {
    const { scene, ground } = flat(20, 20)
    const long = add(scene, createWall(ground, { x: 25, z: 0 }, { x: 25, z: 60 }))
    const door = add(scene, createDoor(long, 42.5))
    const divider = add(scene, createWall(ground, { x: 0, z: 35 }, { x: 25, z: 35 }))
    const far = add(scene, createWall(ground, { x: 60, z: 0 }, { x: 60, z: 60 }))
    const crate = add(scene, createProp(ground, "crate", { x: 12.5, y: 0, z: 22.5 }))
    const lamp = add(scene, createLight(ground, "lantern", { x: 7.5, z: 7.5 }))
    const south = addToken(scene, ground, 12.5, 12.5)
    const north = addToken(scene, ground, 12.5, 47.5)
    const engine = createVisionEngine(scene)

    const a = engine.compute([engine.viewerFor(south)])
    expect(a.observedObjectIds.has(long.id)).toBe(true)
    expect(a.observedObjectIds.has(divider.id)).toBe(true)
    expect(a.observedObjectIds.has(door.id)).toBe(false)
    expect(a.observedObjectIds.has(far.id)).toBe(false)
    expect(a.observedObjectIds.has(crate.id)).toBe(true)
    expect(a.observedObjectIds.has(lamp.id)).toBe(true)
    // The ground floor is observed.
    const floorId = Object.values(scene.objects).find((o) => o.type === "floor")!.id
    expect(a.observedObjectIds.has(floorId)).toBe(true)

    const b = engine.compute([engine.viewerFor(north)])
    expect(b.observedObjectIds.has(door.id)).toBe(true)
    expect(b.observedObjectIds.has(crate.id)).toBe(false)
  })

  it("a lit static light is observed by line of sight to its source even when its cell is not perceived", () => {
    const { scene, ground } = flat(20, 10, "dark")
    add(scene, createWall(ground, { x: 25, z: 0 }, { x: 25, z: 50 }, { height: 3 }))
    // Mounted high with a tiny radius: its floor stays dark, but the flame shows over the wall.
    const sconce = add(scene, createLight(ground, "candle", { x: 37.5, z: 22.5 }, { position: { x: 37.5, y: 8, z: 22.5 }, brightRadius: 1, dimRadius: 2 }))
    const behind = add(scene, createLight(ground, "candle", { x: 27.5, z: 32.5 }, { position: { x: 27.5, y: 1, z: 32.5 }, brightRadius: 0.2, dimRadius: 0.5 }))
    const off = add(scene, createLight(ground, "candle", { x: 37.5, z: 12.5 }, { position: { x: 37.5, y: 8, z: 12.5 }, on: false }))
    const viewer = addToken(scene, ground, 12.5, 22.5)
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(viewer)])
    expect(grade(res, ground, 7, 4)).toBe(0)
    expect(res.observedObjectIds.has(sconce.id)).toBe(true)
    expect(res.observedObjectIds.has(behind.id)).toBe(false)
    expect(res.observedObjectIds.has(off.id)).toBe(false)
  })

  it("a connector is observed from the level above through its stairwell", () => {
    const { scene, ground } = flat(12, 12)
    const upper = addLevel(scene, { name: "Upper", elevation: 10 }, { x: 0, z: 0, w: 60, d: 60 })
    const stairs = add(scene, createConnector(ground, upper.id, { x: 20, z: 20, w: 5, d: 10 }, 0))
    const floor = add(scene, createFloor(ground, { x: 55, z: 55, w: 5, d: 5 }))
    const above = addToken(scene, upper.id, 22.5, 32.5)
    const engine = createVisionEngine(scene)
    const res = engine.compute([engine.viewerFor(above)])
    expect(res.observedObjectIds.has(stairs.id)).toBe(true)
    expect(res.observedObjectIds.has(floor.id)).toBe(false)
  })
})

describe("terrain", () => {
  it("samples follow the heightmap and a hill blocks sight", () => {
    const { scene, ground } = flat(30, 10)
    // A 10 ft ridge centred on x = 75 across the whole map.
    paintHeightmap(scene, ground, (x) => Math.max(0, 10 - Math.abs(x - 75) / 2), 2)
    const viewer = addToken(scene, ground, 12.5, 22.5)
    const engine = new VisionEngineImpl(scene)
    const top = engine.inspectSample(ground, 15, 4)
    expect(top?.valid).toBe(true)
    expect(top?.position.y).toBeCloseTo(10 - 2.5 / 2 + 0.25, 6)
    const res = engine.compute([engine.viewerFor(viewer)])
    // The near slope faces the viewer; the far side of the ridge is hidden.
    expect(grade(res, ground, 12, 4)).toBe(3)
    expect(grade(res, ground, 18, 4)).toBe(0)
    expect(grade(res, ground, 25, 4)).toBe(0)
    // A giant sees over the ridge to the far valley.
    const giant = addToken(scene, ground, 57.5, 22.5, { size: "huge", eyeHeight: 14, height: 16 })
    const res2 = engine.compute([engine.viewerFor(giant)])
    expect(grade(res2, ground, 25, 4)).toBe(3)
  })

  it("a terrain edit is applied incrementally", () => {
    const { scene, ground } = flat(30, 10)
    paintHeightmap(scene, ground, () => 0, 2)
    const viewer = addToken(scene, ground, 12.5, 22.5)
    const engine = createVisionEngine(scene)
    expect(grade(engine.compute([engine.viewerFor(viewer)]), ground, 25, 4)).toBe(3)
    const next = { ...scene, levels: { ...scene.levels } }
    paintHeightmap(next, ground, (x) => Math.max(0, 10 - Math.abs(x - 75) / 2), 2)
    engine.update(next, { terrain: [ground] })
    expect(grade(engine.compute([engine.viewerFor(next.tokens[viewer.id])]), ground, 25, 4)).toBe(0)
  })
})

describe("ladders", () => {
  it("a ladder cell is sampleable on both levels at each level's ground", () => {
    const { scene, ground } = flat(10, 10)
    const upper = addLevel(scene, { name: "Loft", elevation: 12 }, { x: 0, z: 0, w: 50, d: 50 })
    add(scene, createConnector(ground, upper.id, { x: 20, z: 20, w: 5, d: 5 }, 0, "ladder"))
    const engine = new VisionEngineImpl(scene)
    expect(engine.inspectSample(upper.id, 4, 4)?.position.y).toBeCloseTo(12.25, 9)
    expect(engine.inspectSample(ground, 4, 4)?.position.y).toBeCloseTo(0.25, 9)
    expect(engine.inspectSample(upper.id, 3, 4)?.valid).toBe(true)
    // Looking up the ladder shaft from its foot: the hatch edge of the loft is not a floor sample,
    // but the ladder cell itself (in the opening) is.
    const climber = addToken(scene, ground, 22.5, 22.5, { eyeHeight: 11 })
    const res = engine.compute([engine.viewerFor(climber)])
    expect(grade(res, upper.id, 4, 4)).toBe(3)
  })
})

describe("engine edge cases", () => {
  it("computes an empty result for no viewers", () => {
    const { scene } = flat(5, 5)
    const engine = createVisionEngine(scene)
    const res = engine.compute([])
    expect(Object.keys(res.perception)).toHaveLength(0)
    expect(res.visibleTokenIds.size).toBe(0)
    expect(res.observedObjectIds.size).toBe(0)
  })

  it("keeps a bounded number of viewer caches and stays correct after eviction", () => {
    const { scene, ground } = flat(10, 10)
    const tokens = Array.from({ length: 40 }, (_, k) => addToken(scene, ground, 2.5 + (k % 10) * 5, 2.5 + Math.floor(k / 10) * 5))
    const engine = new VisionEngineImpl(scene)
    for (const t of tokens) engine.compute([engine.viewerFor(t)])
    expect(engine.stats().viewerCaches).toBeLessThanOrEqual(32)
    const res = engine.compute([engine.viewerFor(tokens[0])])
    expect(perceivedCount(res, ground)).toBe(100)
  })

  it("a union keeps a cell uniform when any viewer perceives all of it", () => {
    const { scene, ground } = flat(12, 12)
    add(scene, createWall(ground, { x: 0, z: 0 }, { x: 50, z: 50 }))
    const a = addToken(scene, ground, 37.5, 12.5)
    const b = addToken(scene, ground, 12.5, 37.5)
    const c = addToken(scene, ground, 22.5, 12.5)
    const engine = createVisionEngine(scene)
    // Each side sees half of the split cell; together they see all of it.
    const res = engine.compute([engine.viewerFor(a), engine.viewerFor(b)])
    expect(grade(res, ground, 4, 4)).toBe(3)
    expect(partial(res, ground, 4, 4)).toBeUndefined()
    // c stands next to the cell on the same side as a: still partial.
    const res2 = engine.compute([engine.viewerFor(a), engine.viewerFor(c)])
    expect(partial(res2, ground, 4, 4)).toBeDefined()
  })
})

describe("sight from the whole square", () => {
  // A 3 ft pillar-like wall (x = 20, z 11..14) straight between the viewer (12.5, 12.5) and the east. The
  // eye's shadow of it runs to the grid edge; the corner eyes (x 10.5..14.5, z 10.5..14.5) are 4 ft apart,
  // wider than the wall, so they see behind it from x ≈ 37 on.
  function pillar(origin: "eye" | "square") {
    const t = flat(12, 5, "bright", origin)
    add(t.scene, createWall(t.ground, { x: 20, z: 11 }, { x: 20, z: 14 }))
    const viewer = addToken(t.scene, t.ground, 12.5, 12.5)
    const target = addToken(t.scene, t.ground, 30, 12.5)
    const engine = createVisionEngine(t.scene)
    return { ...t, viewer, target, res: engine.compute([engine.viewerFor(viewer)]) }
  }

  it("sees behind an obstacle narrower than its space", () => {
    const eye = pillar("eye")
    const sq = pillar("square")
    expect(grade(eye.res, eye.ground, 8, 2)).toBe(0)
    expect(grade(sq.res, sq.ground, 8, 2)).toBe(3)
    expect(perceivedCount(sq.res, sq.ground)).toBeGreaterThan(perceivedCount(eye.res, eye.ground))
    // Everything the eye perceives, the square perceives too.
    const g = (t: { res: VisibilityResult; ground: string }, c: number) => t.res.perception[t.ground].grades[c]
    for (let c = 0; c < 60; c++) if (g(eye, c) > 0) expect(g(sq, c)).toBeGreaterThan(0)
  })

  it("sees tokens behind the obstacle that the eye alone cannot", () => {
    expect(pillar("eye").res.visibleTokenIds.has(pillar("eye").target.id)).toBe(false)
    const sq = pillar("square")
    expect(sq.res.visibleTokenIds.has(sq.target.id)).toBe(true)
  })

  it("never sees through a wall the token stands against", () => {
    // A thick wall along x = 10 (x 9.25..10.75) with the token's cell right against it: its east corners
    // (x = 9.5) are in the wall and dropped.
    const { scene, ground } = flat(8, 4, "bright", "square")
    add(scene, createWall(ground, { x: 10, z: -5 }, { x: 10, z: 25 }, { thickness: 1.5 }))
    const viewer = addToken(scene, ground, 7.5, 12.5)
    const beyond = addToken(scene, ground, 17.5, 12.5)
    const engine = createVisionEngine(scene)
    const v = engine.viewerFor(viewer)
    expect(v.eyes!.length).toBe(3)
    const res = engine.compute([v])
    for (let j = 0; j < 4; j++) for (let i = 3; i < 8; i++) expect(grade(res, ground, i, j), `(${i}, ${j})`).toBe(0)
    expect(res.visibleTokenIds.has(beyond.id)).toBe(false)
  })

  it("measures darkvision from the nearest eye", () => {
    const sub = (origin: "eye" | "square") => {
      const { scene, ground } = flat(40, 3, "dark", origin)
      const elf = addToken(scene, ground, 2.5, 7.5, { vision: { darkvision: 60, blindsight: 0, blind: false } })
      const engine = createVisionEngine(scene)
      const res = engine.compute([engine.viewerFor(elf)])
      expect(grade(res, ground, 12, 1)).toBe(2)
      let n = 0
      for (let sz = 0; sz < 4; sz++) for (let sx = 0; sx < 4; sx++) if (subPerceived(res, ground, 12, 1, sx, sz)) n++
      return n
    }
    // The 60 ft sphere crosses cell 12 (x 60..65); the east corner eyes are 2 ft closer than the eye.
    expect(sub("square")).toBeGreaterThan(sub("eye"))
  })
})
