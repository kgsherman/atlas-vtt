import { describe, expect, it } from "vitest"

import {
  createConnector,
  createDoor,
  createFloor,
  createLight,
  createPillar,
  createProp,
  createToken,
  createWall,
  createWindow,
} from "../scene/factory"
import { connectorGround, levelCeilingY, levelGround } from "../scene/queries"
import { buildAll, connectorRows } from "./build"
import { primitiveBounds } from "./primitives"
import { add, addLevel, flatScene, paintHeightmap } from "./test-utils"
import type { Heightfield, OccluderPrimitive, OrientedBox, VerticalCylinder } from "./types"

const byKey = (prims: OccluderPrimitive[]) => new Map(prims.map((p) => [p.key, p]))
const asBox = (p: OccluderPrimitive | undefined) => p as OrientedBox
const bounds = (p: OccluderPrimitive | undefined) => primitiveBounds(p!)

describe("walls and openings", () => {
  it("a plain wall is one box from ground − 0.05 to its height", () => {
    const { scene, levelId } = flatScene()
    const w = add(scene, createWall(levelId, { x: 10, z: 10 }, { x: 30, z: 10 }, { height: 8, thickness: 0.5 }))
    const prims = buildAll(scene).filter((p) => p.sourceId === w.id)
    expect(prims).toHaveLength(1)
    const b = asBox(prims[0])
    expect(b.key).toBe(w.id)
    expect(b.sourceType).toBe("wall")
    expect(b.blocks).toEqual({ movement: true, sight: true, light: true })
    expect(b.center.x).toBeCloseTo(20)
    expect(b.center.z).toBeCloseTo(10)
    expect(b.halfExtents.x).toBeCloseTo(10)
    expect(b.halfExtents.z).toBeCloseTo(0.25)
    const bb = bounds(b)
    expect(bb.minY).toBeCloseTo(-0.05)
    expect(bb.maxY).toBeCloseTo(8)
  })

  it("splits around a door and a window with lintels, sill, leaf and a movement-only window box", () => {
    const { scene, levelId } = flatScene()
    const w = add(scene, createWall(levelId, { x: 0, z: 10 }, { x: 40, z: 10 }, { height: 10 }))
    const door = add(scene, createDoor(w, 10, { width: 4, height: 7, style: "iron" }))
    const win = add(scene, createWindow(w, 30, { width: 3, sillHeight: 3, height: 3 }))
    const m = byKey(buildAll(scene))
    // Full-height pieces: [0, 8], [12, 28.5], [31.5, 40].
    expect(bounds(m.get(w.id)).minX).toBeCloseTo(0)
    expect(bounds(m.get(w.id)).maxX).toBeCloseTo(8)
    expect(bounds(m.get(`${w.id}#after:${door.id}`)).minX).toBeCloseTo(12)
    expect(bounds(m.get(`${w.id}#after:${door.id}`)).maxX).toBeCloseTo(28.5)
    expect(bounds(m.get(`${w.id}#after:${win.id}`)).minX).toBeCloseTo(31.5)
    expect(bounds(m.get(`${w.id}#after:${win.id}`)).maxX).toBeCloseTo(40)
    // Door lintel 7 → 10, leaf −0.05 → 7 with style flags.
    const lintel = bounds(m.get(`${w.id}#lintel:${door.id}`))
    expect(lintel.minY).toBeCloseTo(7)
    expect(lintel.maxY).toBeCloseTo(10)
    const leaf = m.get(door.id)!
    expect(leaf.sourceType).toBe("door")
    expect(leaf.blocks).toEqual({ movement: true, sight: true, light: true })
    expect(bounds(leaf).maxY).toBeCloseTo(7)
    expect(bounds(leaf).minX).toBeCloseTo(8)
    expect(bounds(leaf).maxX).toBeCloseTo(12)
    // Window sill −0.05 → 3, lintel 6 → 10, movement box over the whole opening.
    expect(bounds(m.get(`${w.id}#sill:${win.id}`)).maxY).toBeCloseTo(3)
    expect(bounds(m.get(`${w.id}#lintel:${win.id}`)).minY).toBeCloseTo(6)
    const winBox = m.get(win.id)!
    expect(winBox.sourceType).toBe("window")
    expect(winBox.blocks).toEqual({ movement: true, sight: false, light: false })
    expect(bounds(winBox).minY).toBeCloseTo(-0.05)
    expect(bounds(winBox).maxY).toBeCloseTo(10)
    // Every wall piece belongs to the wall.
    expect([...m.values()].filter((p) => p.sourceId === w.id)).toHaveLength(6)
  })

  it("open doors have no leaf; styles set the leaf's sight/light flags", () => {
    const { scene, levelId } = flatScene()
    const w = add(scene, createWall(levelId, { x: 0, z: 10 }, { x: 40, z: 10 }))
    const open = add(scene, createDoor(w, 5, { state: "open" }))
    const portcullis = add(scene, createDoor(w, 15, { style: "portcullis", state: "locked" }))
    const secret = add(scene, createDoor(w, 25, { style: "secret" }))
    const m = byKey(buildAll(scene))
    expect(m.has(open.id)).toBe(false)
    expect(m.has(`${w.id}#lintel:${open.id}`)).toBe(true)
    expect(m.get(portcullis.id)!.blocks).toEqual({ movement: true, sight: false, light: false })
    expect(m.get(secret.id)!.blocks).toEqual({ movement: true, sight: true, light: true })
  })

  it("extends wall ends by thickness/2 at joints only (same level)", () => {
    const { scene, levelId } = flatScene()
    const a = add(scene, createWall(levelId, { x: 10, z: 10 }, { x: 20, z: 10 }, { thickness: 1 }))
    const b = add(scene, createWall(levelId, { x: 10.0005, z: 10 }, { x: 10, z: 20 }, { thickness: 1 }))
    const upper = addLevel(scene, { elevation: 10 })
    const c = add(scene, createWall(upper.id, { x: 20, z: 10 }, { x: 30, z: 10 }, { thickness: 1 }))
    const m = byKey(buildAll(scene))
    expect(bounds(m.get(a.id)).minX).toBeCloseTo(9.5)
    expect(bounds(m.get(a.id)).maxX).toBeCloseTo(20) // (20,10) is only shared with a wall on another level
    expect(bounds(m.get(b.id)).minZ).toBeCloseTo(9.5)
    expect(bounds(m.get(b.id)).maxZ).toBeCloseTo(20)
    expect(bounds(m.get(c.id)).minX).toBeCloseTo(20)
  })

  it("follows the Terrain rule on slopes", () => {
    const { scene, levelId } = flatScene()
    paintHeightmap(scene, levelId, (x) => x / 10) // 1 ft rise per 10 ft along x
    const w = add(scene, createWall(levelId, { x: 10, z: 20 }, { x: 30, z: 20 }, { height: 6, thickness: 0.5 }))
    const door = add(scene, createDoor(w, 10, { width: 4, height: 5 }))
    const m = byKey(buildAll(scene))
    const base = levelGround(scene, levelId, 20, 20)
    expect(base).toBeCloseTo(2)
    // Bottom: lowest ground under the footprint incl. the thickness/2 end extension (x = 9.75) − 0.05.
    expect(bounds(m.get(w.id)).minY).toBeCloseTo(0.975 - 0.05)
    expect(bounds(m.get(w.id)).maxY).toBeCloseTo(8)
    expect(bounds(m.get(door.id)).maxY).toBeCloseTo(7)
    expect(bounds(m.get(`${w.id}#lintel:${door.id}`)).minY).toBeCloseTo(7)
  })

  it("skips openings whose host is missing and objects on missing levels", () => {
    const { scene, levelId } = flatScene()
    const w = createWall(levelId, { x: 0, z: 10 }, { x: 40, z: 10 })
    const orphan = add(scene, createDoor(w, 5))
    const ghost = add(scene, createWall("nope", { x: 0, z: 0 }, { x: 10, z: 0 }))
    const prims = buildAll(scene)
    expect(prims.some((p) => p.sourceId === orphan.id || p.sourceId === ghost.id)).toBe(false)
  })
})

describe("floors", () => {
  it("flat levels: one box per effective rect, top at the ground", () => {
    const { scene, levelId } = flatScene(10, 10)
    const floorId = Object.keys(scene.objects)[0]
    const prims = buildAll(scene)
    expect(prims).toHaveLength(1)
    const b = asBox(prims[0])
    expect(b.key).toBe(floorId)
    expect(b.sourceType).toBe("floor")
    expect(b.blocks).toEqual({ movement: false, sight: true, light: true })
    expect(bounds(b)).toEqual({ minX: 0, minY: -1, minZ: 0, maxX: 50, maxY: 0, maxZ: 50 })
    expect(b.levelId).toBe(levelId)
  })

  it("connector footprints are cut out of the floors the rise passes through", () => {
    const { scene, levelId } = flatScene(10, 10)
    const upper = addLevel(scene, { elevation: 10, floorThickness: 1.5 })
    const top = add(scene, createFloor(upper.id, { x: 0, z: 0, w: 50, d: 50 }))
    add(scene, createConnector(levelId, upper.id, { x: 20, z: 20, w: 5, d: 15 }, 0))
    const floors = buildAll(scene).filter((p) => p.sourceId === top.id)
    expect(floors.length).toBe(4)
    expect(floors[0].key).toBe(top.id)
    expect(floors.slice(1).every((p) => p.key.startsWith(`${top.id}#`))).toBe(true)
    const area = floors.reduce((s, p) => {
      const bb = bounds(p)
      expect(bb.maxY).toBeCloseTo(10)
      expect(bb.minY).toBeCloseTo(8.5)
      return s + (bb.maxX - bb.minX) * (bb.maxZ - bb.minZ)
    }, 0)
    expect(area).toBeCloseTo(2500 - 75)
  })

  it("levels with a heightmap get one heightfield per floor with cutouts unsolid", () => {
    const { scene, levelId } = flatScene(8, 8)
    const below = addLevel(scene, { elevation: -10 })
    paintHeightmap(scene, levelId, (x, z) => (x + z) / 20, 2)
    const floorId = Object.keys(scene.objects)[0]
    add(scene, createConnector(below.id, levelId, { x: 10, z: 10, w: 5, d: 5 }, 0, "ladder"))
    const prims = buildAll(scene).filter((p) => p.sourceId === floorId)
    expect(prims).toHaveLength(1)
    const hf = prims[0] as Heightfield
    expect(hf.shape).toBe("heightfield")
    expect(hf.sourceType).toBe("terrain")
    expect(hf.key).toBe(floorId)
    expect(hf.spacing).toBe(2.5)
    expect(hf.samplesX).toBe(17)
    expect(hf.thickness).toBe(1)
    expect(hf.heights[16 * 17 + 16]).toBeCloseTo(4)
    const cells = hf.samplesX - 1
    // Lattice cells (4..5, 4..5) are under the ladder.
    expect(hf.solid[4 * cells + 4]).toBe(0)
    expect(hf.solid[5 * cells + 5]).toBe(0)
    expect(hf.solid[3 * cells + 4]).toBe(1)
    expect(hf.solid.reduce((s, v) => s + v, 0)).toBe(256 - 4)
  })
})

describe("connectors, pillars, props", () => {
  it("stairs: stepped boxes per row, tops just below the walking surface; ladders: nothing", () => {
    const { scene, levelId } = flatScene(10, 10)
    const upper = addLevel(scene, { elevation: 12 })
    const stairs = add(scene, createConnector(levelId, upper.id, { x: 20, z: 20, w: 10, d: 15 }, 2))
    add(scene, createConnector(levelId, upper.id, { x: 0, z: 0, w: 5, d: 5 }, 0, "ladder"))
    const rows = connectorRows(stairs, 5)
    expect(rows).toEqual([
      { x: 20, z: 30, w: 10, d: 5 },
      { x: 20, z: 25, w: 10, d: 5 },
      { x: 20, z: 20, w: 10, d: 5 },
    ])
    const prims = buildAll(scene).filter((p) => p.sourceType === "connector")
    // Row 0 starts at floor level → no box.
    expect(prims.map((p) => p.key)).toEqual([`${stairs.id}#1`, `${stairs.id}#2`])
    for (const [k, p] of prims.entries()) {
      const bb = bounds(p)
      // The run climbs towards −Z from z = 35: row k + 1 starts at z = 35 − 5·(k + 1).
      const lowEdge = connectorGround(scene, stairs, { x: 25, z: 35 - 5 * (k + 1) })
      expect(bb.maxY).toBeCloseTo(lowEdge - 0.05)
      expect(bb.minY).toBeCloseTo(-0.05)
      expect(p.blocks).toEqual({ movement: false, sight: true, light: true })
    }
    expect(bounds(prims[0]).maxY).toBeCloseTo(4 - 0.05)
    expect(bounds(prims[1]).maxY).toBeCloseTo(8 - 0.05)
  })

  it("pillars: square box / round cylinder, null height up to the ceiling", () => {
    const { scene, levelId } = flatScene(10, 10)
    addLevel(scene, { elevation: 12, floorThickness: 1 })
    const round = add(scene, createPillar(levelId, { x: 10, z: 10 }, { size: 2 }))
    const square = add(scene, createPillar(levelId, { x: 20, z: 10 }, { shape: "square", size: 1, height: 4 }))
    const m = byKey(buildAll(scene))
    const c = m.get(round.id) as VerticalCylinder
    expect(c.shape).toBe("cylinder")
    expect(c.radius).toBe(1)
    expect(c.base).toEqual({ x: 10, y: 0, z: 10 })
    expect(c.height).toBe(levelCeilingY(scene, levelId))
    expect(c.height).toBe(11)
    const b = m.get(square.id) as OrientedBox
    expect(b.shape).toBe("box")
    expect(bounds(b)).toEqual({ minX: 19.5, minY: 0, minZ: 9.5, maxX: 20.5, maxY: 4, maxZ: 10.5 })
  })

  it("props: parts scaled, rotated, flagged per prop; hidden included; tokens and lights ignored", () => {
    const { scene, levelId } = flatScene(10, 10)
    const crate = add(scene, createProp(levelId, "crate", { x: 10, y: 0, z: 10 }, { scale: { x: 2, y: 1, z: 1 }, rotationY: Math.PI / 2, hidden: true }))
    const tree = add(scene, createProp(levelId, "tree", { x: 30, y: 0, z: 30 }))
    const barrel = add(scene, createProp(levelId, "barrel", { x: 20, y: 1, z: 20 }, { scale: { x: 1, y: 2, z: 2 } }))
    const chair = add(scene, createProp(levelId, "chair", { x: 5, y: 0, z: 5 }))
    const inert = add(scene, createProp(levelId, "chair", { x: 5, y: 0, z: 15 }, { castsShadows: false }))
    scene.tokens.t = createToken(levelId, { x: 2.5, z: 2.5 })
    add(scene, createLight(levelId, "torch", { x: 3, z: 3 }))
    const m = byKey(buildAll(scene))
    const cb = m.get(crate.id) as OrientedBox
    expect(cb.halfExtents).toEqual({ x: 3, y: 1.5, z: 1.5 })
    expect(cb.yaw).toBe(Math.PI / 2)
    expect(bounds(cb).maxZ - bounds(cb).minZ).toBeCloseTo(6)
    const trunk = m.get(tree.id) as VerticalCylinder
    const canopy = m.get(`${tree.id}#1`) as VerticalCylinder
    expect(trunk.radius).toBe(0.75)
    expect(trunk.height).toBe(7)
    expect(canopy.base.y).toBe(7)
    expect(canopy.radius).toBe(4)
    expect(canopy.height).toBe(11)
    const bc = m.get(barrel.id) as VerticalCylinder
    expect(bc.radius).toBe(2.5)
    expect(bc.base.y).toBe(1)
    expect(bc.height).toBe(7)
    expect(m.get(chair.id)!.blocks).toEqual({ movement: false, sight: false, light: true })
    expect(m.has(inert.id)).toBe(false)
    expect([...m.values()].every((p) => p.sourceType !== "light")).toBe(true)
  })

  it("rotated box parts are placed with the three.js yaw convention", () => {
    const { scene, levelId } = flatScene(10, 10)
    // Statue base (3×1×3 box) + a cylinder; rotate a table (5 wide along local x) by 90°.
    const table = add(scene, createProp(levelId, "table", { x: 10, y: 0, z: 10 }, { rotationY: Math.PI / 2 }))
    const b = bounds(buildAll(scene).find((p) => p.sourceId === table.id))
    expect(b.maxX - b.minX).toBeCloseTo(3)
    expect(b.maxZ - b.minZ).toBeCloseTo(5)
  })
})
