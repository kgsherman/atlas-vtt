import { produce } from "immer"
import { describe, expect, it } from "vitest"

import { findPath } from "@/core/movement"
import { buildOcclusionWorld } from "@/core/occlusion"
import { createConnector, createDoor, createFloor, createLight, createPillar, createProp, createScene, createToken, createWall } from "@/core/scene/factory"
import { copySelection } from "@/core/scene/integrity"
import type { ConnectorObject, DoorObject, GridSettings, LightObject, PropObject, Scene, WallObject } from "@/core/scene/types"

import { parseClipboardText, serializeClipboard, validatePastedItems } from "./clipboard"
import { sceneChangeFromPatches } from "./sceneChange"
import { closestOnSegment, constrainAngle, edgeSnapMode, effectiveSnapMode, placeOpening, snapTokenPosition, snapWallPoint } from "./snapping"
import { fixtureScene } from "./test-utils"
import { alignDelta, applyMove, applyRotation, boundsPivot, normalizeAngle, planMove, rotateQuarter, rotationPivot, snapDragDelta } from "./transform"

const grid: GridSettings = { cellSize: 5, width: 20, depth: 20, diagonalRule: "5-5-5" }

describe("sceneChangeFromPatches", () => {
  it("classifies object, token, terrain and structural paths", () => {
    expect(
      sceneChangeFromPatches([
        { op: "replace", path: ["objects", "b", "a", "x"], value: 1 },
        { op: "add", path: ["objects", "a"], value: {} },
        { op: "remove", path: ["tokens", "t1"] },
        { op: "replace", path: ["levels", "L", "heightmap", "chunks", "0,0"], value: "" },
        { op: "replace", path: ["name"], value: "n" },
      ])
    ).toEqual({ objects: ["a", "b"], tokens: ["t1"], terrain: ["L"] })
    expect(sceneChangeFromPatches([{ op: "replace", path: ["levels", "L", "elevation"], value: 3 }])).toEqual({ structure: true })
    expect(sceneChangeFromPatches([{ op: "replace", path: ["environment", "skyLevel"], value: "dim" }])).toEqual({ structure: true })
    expect(sceneChangeFromPatches([{ op: "replace", path: [], value: {} }])).toEqual({ structure: true })
    expect(sceneChangeFromPatches([])).toEqual({})
  })
})

describe("snapping", () => {
  it("effective and edge snap modes", () => {
    expect(effectiveSnapMode("center", true)).toBe("free")
    expect(effectiveSnapMode("half", false)).toBe("half")
    expect(edgeSnapMode("center")).toBe("vertex")
    expect(edgeSnapMode("half")).toBe("half")
  })

  it("anchors token footprints on the grid", () => {
    expect(snapTokenPosition(grid, { x: 11, z: 3 }, "medium", "center")).toEqual({ x: 12.5, z: 2.5 })
    expect(snapTokenPosition(grid, { x: 11, z: 3 }, "large", "center")).toEqual({ x: 10, z: 5 })
    expect(snapTokenPosition(grid, { x: 11, z: 3 }, "tiny", "vertex")).toEqual({ x: 12.5, z: 2.5 })
    expect(snapTokenPosition(grid, { x: 11, z: 3 }, "medium", "half")).toEqual({ x: 10, z: 2.5 })
    expect(snapTokenPosition(grid, { x: 11, z: 3 }, "huge", "free")).toEqual({ x: 11, z: 3 })
  })

  it("wall snapping prefers endpoints, then centrelines (grid points on them first), then the grid", () => {
    const scene = createScene({ width: 20, depth: 20 })
    const level = Object.keys(scene.levels)[0]
    const diag = createWall(level, { x: 0, z: 0 }, { x: 30, z: 20 })
    const straight = createWall(level, { x: 50, z: 10 }, { x: 80, z: 10 })
    scene.objects[diag.id] = diag
    scene.objects[straight.id] = straight
    // Near an endpoint.
    expect(snapWallPoint(scene, level, { x: 30.8, z: 19.4 }, { mode: "center" })).toMatchObject({ kind: "endpoint", point: { x: 30, z: 20 }, wallId: diag.id })
    // On the diagonal wall's centreline, away from grid points on it: raw projection.
    const onDiag = snapWallPoint(scene, level, { x: 13, z: 9 }, { mode: "vertex" })
    expect(onDiag.kind).toBe("centerline")
    expect(closestOnSegment(diag.a, diag.b, onDiag.point).distance).toBeLessThan(1e-9)
    // Near the straight wall: the grid point on its centreline.
    expect(snapWallPoint(scene, level, { x: 61, z: 10.8 }, { mode: "vertex" })).toMatchObject({ kind: "grid", point: { x: 60, z: 10 }, wallId: straight.id })
    // Open ground: grid ("center" acts as "vertex" for walls).
    expect(snapWallPoint(scene, level, { x: 41, z: 47 }, { mode: "center" })).toMatchObject({ kind: "grid", point: { x: 40, z: 45 }, wallId: null })
    // Extra points (polyline start) count as endpoints; free disables everything.
    expect(snapWallPoint(scene, level, { x: 90.5, z: 90.5 }, { mode: "center", extraPoints: [{ x: 90, z: 90 }] }).kind).toBe("endpoint")
    expect(snapWallPoint(scene, level, { x: 30.8, z: 19.4 }, { mode: "free" })).toMatchObject({ kind: "free", point: { x: 30.8, z: 19.4 } })
  })

  it("constrains to 45° steps with grid-aligned lengths", () => {
    expect(constrainAngle(grid, { x: 0, z: 0 }, { x: 12, z: 1 }, "vertex")).toEqual({ x: 12.5, z: 0 })
    const d = constrainAngle(grid, { x: 0, z: 0 }, { x: 9, z: 11 }, "vertex")
    expect(d.x).toBeCloseTo(10)
    expect(d.z).toBeCloseTo(10)
  })

  it("places openings at the nearest free, snapped offset", () => {
    const f = fixtureScene()
    const wall = f.scene.objects[f.wallId] as WallObject
    // Wall length 20 with a door [3,7] and a window [12.5,15.5]. A 4 ft door can go in [9,10.5] or [17.5,18].
    expect(placeOpening(f.scene, wall, 8, 4, { mode: "free" })).toEqual({ offset: 9, valid: true })
    expect(placeOpening(f.scene, wall, 19.5, 4, { mode: "free" })).toEqual({ offset: 18, valid: true })
    // Snapped ("vertex" = whole cells from a): 10 is free.
    expect(placeOpening(f.scene, wall, 11, 4, { mode: "vertex" })).toEqual({ offset: 10, valid: true })
    // Excluding the door itself frees its spot.
    expect(placeOpening(f.scene, wall, 5, 4, { mode: "free", excludeId: f.doorId }).offset).toBe(5)
    // Too wide for any gap.
    expect(placeOpening(f.scene, wall, 10, 12, { mode: "free" }).valid).toBe(false)
    expect(placeOpening(f.scene, wall, 10, 40, { mode: "free" }).valid).toBe(false)
  })

  it("snaps doors in rotated walls to where a medium token can walk through on the grid", () => {
    let moved = 0
    let placed = 0
    for (const deg of [12, 29, 38, 45, 52, 61, 77, 142]) {
      for (const width of [4, 6.5]) {
        for (const desired of [30, 33.3, 36.1, 41.7]) {
          const scene = createScene({ width: 20, depth: 20 })
          const levelId = Object.keys(scene.levels)[0]
          const u = { x: Math.cos((deg * Math.PI) / 180), z: Math.sin((deg * Math.PI) / 180) }
          // An 80 ft wall through the middle of the map (a battlemap building's side, off the grid).
          const a = { x: 51.3 - 40 * u.x, z: 48.9 - 40 * u.z }
          const wall = createWall(levelId, a, { x: a.x + 80 * u.x, z: a.z + 80 * u.z }, { thickness: 0.75 })
          scene.objects[wall.id] = wall
          const { offset, valid } = placeOpening(scene, wall, desired, width, { mode: "center", kind: "door" })
          expect(valid).toBe(true)
          expect(Math.abs(offset - desired)).toBeLessThanOrEqual(3)
          placed++
          if (Math.abs(offset - desired) > 1e-9) moved++
          const door = createDoor(wall, offset, { width, state: "open" })
          scene.objects[door.id] = door
          // From 8 ft in front of the door to 8 ft behind it in a few steps: through the doorway.
          const c = { x: a.x + u.x * offset, z: a.z + u.z * offset }
          const side = (k: number) => ({ i: Math.floor((c.x - u.z * 8 * k) / 5), j: Math.floor((c.z + u.x * 8 * k) / 5) })
          const token = createToken(levelId, { x: (side(1).i + 0.5) * 5, z: (side(1).j + 0.5) * 5 })
          scene.tokens[token.id] = token
          const path = findPath(scene, buildOcclusionWorld(scene), token, { cell: side(-1), levelId }, { maxSteps: 6 })
          expect(path, `${deg}° ${width} ft door at ${offset.toFixed(2)}`).not.toBeNull()
        }
      }
    }
    // Most placements need no nudge at all.
    expect(moved).toBeLessThan(placed / 2)
    // Free placement (Alt) and windows keep the usual rules; so do grid-aligned walls.
    const scene = createScene({ width: 40, depth: 40 })
    const levelId = Object.keys(scene.levels)[0]
    const wall = createWall(levelId, { x: 97.5, z: 33.5 }, { x: 121.5, z: 57 })
    scene.objects[wall.id] = wall
    expect(placeOpening(scene, wall, 12.3, 6.5, { mode: "free", kind: "door" }).offset).toBeCloseTo(12.3)
    expect(placeOpening(scene, wall, 12.3, 3, { mode: "center", kind: "window" }).offset).toBeCloseTo(12.5)
    const straight = createWall(levelId, { x: 0, z: 10 }, { x: 30, z: 10 })
    scene.objects[straight.id] = straight
    expect(placeOpening(scene, straight, 11, 4, { mode: "vertex", kind: "door" }).offset).toBe(10)
  })
})

describe("transform", () => {
  it("planMove skips openings of moving walls and lights of moving carriers", () => {
    const f = fixtureScene()
    const hero = createToken(f.groundId, { x: 2.5, z: 2.5 })
    f.scene.tokens[hero.id] = hero
    const lamp = createLight(f.groundId, "torch", { x: 0, z: 0 }, { attachedTokenId: hero.id })
    f.scene.objects[lamp.id] = lamp
    const plan = planMove(f.scene, [f.wallId, f.doorId, hero.id, lamp.id, "missing"])
    expect(plan.objects.map((o) => o.id)).toEqual([f.wallId])
    expect(plan.tokens.map((t) => t.id)).toEqual([hero.id])
    expect(plan.cellAligned).toBe(false)
    expect(planMove(f.scene, [f.stairsId]).cellAligned).toBe(true)
    expect(alignDelta(planMove(f.scene, [f.stairsId]), 5, 7, -3)).toEqual({ x: 5, z: -5 })
  })

  it("applyMove writes absolute positions from the originals and slides lone openings along their wall", () => {
    const f = fixtureScene()
    const prop = createProp(f.groundId, "crate", { x: 5, y: 1, z: 5 })
    f.scene.objects[prop.id] = prop
    const plan = planMove(f.scene, [f.doorId, prop.id, f.stairsId])
    let s = produce(f.scene, (d) => applyMove(d, plan, 10, 5))
    s = produce(s, (d) => applyMove(d, plan, 5, 5))
    expect((s.objects[prop.id] as PropObject).position).toEqual({ x: 10, y: 1, z: 10 })
    expect((s.objects[f.stairsId] as ConnectorObject).rect).toEqual({ x: 45, z: 45, w: 10, d: 20 })
    // The wall runs along +X: the door slides by the x component, clamped inside the wall.
    expect((s.objects[f.doorId] as DoorObject).offset).toBe(10)
    s = produce(f.scene, (d) => applyMove(d, plan, 100, 0))
    expect((s.objects[f.doorId] as DoorObject).offset).toBe(18)
  })

  it("rotates points by quarter turns (+X → −Z)", () => {
    expect(rotateQuarter({ x: 10, z: 0 }, { x: 0, z: 0 }, 1)).toEqual({ x: 0, z: -10 })
    expect(rotateQuarter({ x: 10, z: 0 }, { x: 0, z: 0 }, -1)).toEqual({ x: 0, z: 10 })
    expect(rotateQuarter({ x: 3, z: 4 }, { x: 1, z: 1 }, 4)).toEqual({ x: 3, z: 4 })
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI)
    expect(normalizeAngle(-Math.PI / 2)).toBeCloseTo(-Math.PI / 2)
  })

  it("applyRotation turns walls, rects, connectors, props and tokens; skips attached lights", () => {
    const f = fixtureScene()
    const pillar = createPillar(f.groundId, { x: 20, z: 20 })
    const prop = createProp(f.groundId, "bed", { x: 12.5, y: 0, z: 12.5 }, { rotationY: Math.PI / 2 })
    const floor = createFloor(f.groundId, { x: 0, z: 0, w: 10, d: 5 })
    const hero = createToken(f.groundId, { x: 2.5, z: 2.5 })
    const lamp = createLight(f.groundId, "torch", { x: 1, z: 0 }, { attachedTokenId: hero.id, position: { x: 1, y: 5, z: 0 } })
    for (const o of [pillar, prop, floor, lamp]) f.scene.objects[o.id] = o
    f.scene.tokens[hero.id] = hero
    const plan = planMove(f.scene, [f.wallId, pillar.id, prop.id, floor.id, f.stairsId, hero.id])
    const pivot = { x: 0, z: 0 }
    const s = produce(f.scene, (d) => applyRotation(d, plan, pivot, 1))
    const wall = s.objects[f.wallId] as WallObject
    expect(wall.a).toEqual({ x: 10, z: -10 })
    expect(wall.b).toEqual({ x: 10, z: -30 })
    expect(s.objects[floor.id]).toMatchObject({ rect: { x: 0, z: -10, w: 5, d: 10 } })
    expect((s.objects[f.stairsId] as ConnectorObject).direction).toBe(1)
    expect((s.objects[prop.id] as PropObject).rotationY).toBeCloseTo(Math.PI)
    expect(s.tokens[hero.id].position).toEqual({ x: 2.5, z: -2.5 })
    expect((s.objects[lamp.id] as LightObject).position).toEqual({ x: 1, y: 5, z: 0 })
    // Openings keep their offsets on the rotated wall.
    expect((s.objects[f.doorId] as DoorObject).offset).toBe(5)
  })

  it("rotation pivots: lone point items turn in place, others about a vertex-snapped centre", () => {
    const f = fixtureScene()
    const prop = createProp(f.groundId, "crate", { x: 12.5, y: 0, z: 7.5 })
    f.scene.objects[prop.id] = prop
    expect(rotationPivot(f.scene, planMove(f.scene, [prop.id]), "center")).toEqual({ x: 12.5, z: 7.5 })
    // Stairs 40..50 × 40..60 → centre (45, 50).
    expect(rotationPivot(f.scene, planMove(f.scene, [f.stairsId]), "center")).toEqual({ x: 45, z: 50 })
    const wall = createWall(f.groundId, { x: 0, z: 0 }, { x: 15, z: 0 })
    f.scene.objects[wall.id] = wall
    expect(rotationPivot(f.scene, planMove(f.scene, [wall.id]), "center")).toEqual({ x: 10, z: 0 })
    expect(rotationPivot(f.scene, planMove(f.scene, [wall.id]), "free")).toEqual({ x: 7.5, z: 0 })
    expect(rotationPivot(f.scene, planMove(f.scene, []), "free")).toBeNull()
    // The same rule for bare bounds (terrain shapes).
    expect(boundsPivot(grid, { x: 0, z: 0, w: 15, d: 3 }, "center")).toEqual({ x: 10, z: 0 })
    expect(boundsPivot(grid, { x: 0, z: 0, w: 15, d: 3 }, "free")).toEqual({ x: 7.5, z: 1.5 })
  })

  it("drag deltas snap the grabbed item's anchor like placement does", () => {
    const f = fixtureScene()
    const hero = createToken(f.groundId, { x: 2.5, z: 2.5 })
    f.scene.tokens[hero.id] = hero
    const prop = createProp(f.groundId, "crate", { x: 1, y: 0, z: 1 })
    f.scene.objects[prop.id] = prop
    expect(snapDragDelta(f.scene, hero.id, { x: 6, z: 1 }, "center")).toEqual({ x: 5, z: 0 })
    expect(snapDragDelta(f.scene, f.wallId, { x: 6, z: 1 }, "center")).toEqual({ x: 5, z: 0 })
    expect(snapDragDelta(f.scene, prop.id, { x: 6, z: 1 }, "center")).toEqual({ x: 6.5, z: 1.5 })
    expect(snapDragDelta(f.scene, prop.id, { x: 6, z: 1 }, "free")).toEqual({ x: 6, z: 1 })
  })
})

describe("clipboard text", () => {
  it("round-trips and rejects non-clipboard text", () => {
    const f = fixtureScene()
    const clip = copySelection(f.scene, [f.wallId])
    expect(parseClipboardText(serializeClipboard(clip))).toEqual(clip)
    expect(parseClipboardText("")).toBeNull()
    expect(parseClipboardText("{")).toBeNull()
    expect(parseClipboardText(JSON.stringify({ kind: "atlas-clipboard" }))).toBeNull()
    expect(parseClipboardText(JSON.stringify({ ...clip, schemaVersion: 99 }))).toBeNull()
    expect(parseClipboardText(JSON.stringify({ ...clip, objects: [1] }))).toBeNull()
    expect(parseClipboardText(JSON.stringify({ ...clip, levelOffsets: { a: 0.5 } }))).toBeNull()
  })

  it("validatePastedItems reports schema and reference problems of pasted items only", () => {
    const f = fixtureScene()
    expect(validatePastedItems(f.scene, [f.wallId, f.doorId])).toEqual([])
    const bad = produce(f.scene as Scene, (d) => {
      const door = d.objects[f.doorId] as DoorObject
      door.offset = 1000
      const c = d.objects[f.stairsId] as ConnectorObject
      c.rect.x = 41
    })
    expect(validatePastedItems(bad, [f.doorId]).join("\n")).toMatch(/does not fit/)
    expect(validatePastedItems(bad, [f.stairsId]).length).toBeGreaterThan(0)
    const lonely = createConnector(f.groundId, "nowhere", { x: 0, z: 0, w: 5, d: 5 }, 0)
    const withLonely = produce(f.scene as Scene, (d) => {
      d.objects[lonely.id] = lonely
    })
    expect(validatePastedItems(withLonely, [lonely.id]).join("\n")).toMatch(/does not exist/)
  })
})
