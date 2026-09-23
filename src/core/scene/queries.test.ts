import { produce } from "immer"
import { describe, expect, it } from "vitest"

import { createConnector, createFloor, createLevel, createLight, createScene, createToken, createWall } from "./factory"
import { createHeightmap, sampleCounts, writeHeights } from "./heightmap"
import {
  adjacentLevels,
  connectorGround,
  connectorProgress,
  connectorsAt,
  effectiveFloorRects,
  floorCutouts,
  groundHeightAt,
  hasGroundAt,
  levelCeilingY,
  lightEffectivelyHidden,
  lightLevelId,
  lightWorldPosition,
  nominalTokenEye,
  openingSegment,
  rectSubtract,
  sortedLevels,
  tokenRect,
  wallNormal,
} from "./queries"
import type { ConnectorObject, Level, Rect, Scene, SceneObject } from "./types"

/** Three stacked levels (0, 10, 20) with full floors, like a small tower. */
function tower() {
  const scene = createScene({ width: 10, depth: 10, groundFloor: false })
  const ground = Object.values(scene.levels)[0]
  const upper = createLevel({ id: "upper", name: "Upper", elevation: 10, floorThickness: 1 })
  const roof = createLevel({ id: "roof", name: "Roof", elevation: 20, floorThickness: 2 })
  scene.levels[upper.id] = upper
  scene.levels[roof.id] = roof
  for (const l of [ground, upper, roof]) {
    const f = createFloor(l.id, { x: 0, z: 0, w: 50, d: 50 })
    scene.objects[f.id] = f
  }
  return { scene, ground, upper, roof }
}

function add<T extends SceneObject>(scene: Scene, o: T): T {
  scene.objects[o.id] = o
  return o
}

const area = (rects: Rect[]) => rects.reduce((s, r) => s + r.w * r.d, 0)

describe("levels", () => {
  it("sorts by (elevation, id)", () => {
    const { scene, ground } = tower()
    const twin = createLevel({ id: "aaa", elevation: 10 })
    scene.levels[twin.id] = twin
    expect(sortedLevels(scene).map((l) => l.id)).toEqual([ground.id, "aaa", "upper", "roof"])
    expect(adjacentLevels(scene, "aaa")).toEqual({ below: ground, above: scene.levels.upper })
    expect(adjacentLevels(scene, "nope")).toEqual({})
  })

  it("does not return a stale order after a mutable scene changes (memo validation)", () => {
    const { scene } = tower()
    const first = sortedLevels(scene).map((l) => l.id)
    expect(sortedLevels(scene).map((l) => l.id)).toEqual(first)
    scene.levels.upper.elevation = 30
    expect(sortedLevels(scene).map((l) => l.id).slice(1)).toEqual(["roof", "upper"])
    delete scene.levels.roof
    expect(sortedLevels(scene).map((l) => l.id).slice(1)).toEqual(["upper"])
    const cellar: Level = createLevel({ id: "cellar", elevation: -10 })
    scene.levels.cellar = cellar
    expect(sortedLevels(scene)[0].id).toBe("cellar")
  })

  it("stays correct inside immer recipes", () => {
    const { scene } = tower()
    produce(scene, (draft) => {
      expect(sortedLevels(draft).map((l) => l.id).slice(1)).toEqual(["upper", "roof"])
      draft.levels.roof.elevation = 5
      expect(sortedLevels(draft).map((l) => l.id).slice(1)).toEqual(["roof", "upper"])
    })
  })

  it("computes ceilings from the slab of the level above", () => {
    const { scene, ground, upper, roof } = tower()
    expect(levelCeilingY(scene, ground.id)).toBe(9) // upper.elevation − upper.floorThickness
    expect(levelCeilingY(scene, upper.id)).toBe(18) // roof slab is 2 ft thick
    expect(levelCeilingY(scene, roof.id)).toBe(20 + roof.height)
    expect(levelCeilingY(scene, "missing")).toBe(0)
  })
})

describe("connectors", () => {
  it("applies stairs only to their lower level and ladders to both", () => {
    const { scene, ground, upper } = tower()
    const stairs = add(scene, createConnector(ground.id, upper.id, { x: 10, z: 10, w: 10, d: 20 }, 0, "stairs"))
    const ladder = add(scene, createConnector(ground.id, upper.id, { x: 40, z: 40, w: 5, d: 5 }, 0, "ladder"))
    expect(connectorsAt(scene, ground.id, { x: 12, z: 15 })).toEqual([stairs])
    expect(connectorsAt(scene, upper.id, { x: 12, z: 15 })).toEqual([])
    expect(connectorsAt(scene, ground.id, { x: 42, z: 42 })).toEqual([ladder])
    expect(connectorsAt(scene, upper.id, { x: 42, z: 42 })).toEqual([ladder])
    // Half-open footprint.
    expect(connectorsAt(scene, ground.id, { x: 20, z: 15 })).toEqual([])
    expect(connectorsAt(scene, ground.id, { x: 10, z: 10 })).toEqual([stairs])
  })

  it("measures progress along each direction", () => {
    const r = { x: 10, z: 20, w: 10, d: 20 }
    const p = { x: 12.5, z: 25 }
    expect(connectorProgress({ rect: r, direction: 0 }, p)).toBeCloseTo(0.25)
    expect(connectorProgress({ rect: r, direction: 1 }, p)).toBeCloseTo(0.25)
    expect(connectorProgress({ rect: r, direction: 2 }, p)).toBeCloseTo(0.75)
    expect(connectorProgress({ rect: r, direction: 3 }, p)).toBeCloseTo(0.75)
    expect(connectorProgress({ rect: r, direction: 0 }, { x: 12, z: 100 })).toBe(1)
  })

  it("interpolates stair ground from the lower to the upper level", () => {
    const { scene, ground, upper } = tower()
    const stairs = add(scene, createConnector(ground.id, upper.id, { x: 10, z: 10, w: 10, d: 20 }, 0, "stairs"))
    expect(connectorGround(scene, stairs, { x: 12, z: 10 })).toBeCloseTo(0)
    expect(connectorGround(scene, stairs, { x: 12, z: 20 })).toBeCloseTo(5)
    expect(connectorGround(scene, stairs, { x: 12, z: 30 })).toBeCloseTo(10)
    expect(groundHeightAt(scene, ground.id, { x: 12, z: 25 })).toBeCloseTo(7.5)
    // Off the run: plain level ground.
    expect(groundHeightAt(scene, ground.id, { x: 25, z: 25 })).toBe(0)
    expect(groundHeightAt(scene, upper.id, { x: 12, z: 25 })).toBe(10)
  })

  it("interpolates between terrain heights at the bottom and top edges", () => {
    const { scene, ground, upper } = tower()
    // Ground terrain: height = x/10 feet (res 1).
    const hm = createHeightmap(1)
    const { samplesX, samplesZ } = sampleCounts(scene.grid, 1)
    const dense = new Float32Array(samplesX * samplesZ)
    for (let sz = 0; sz < samplesZ; sz++) for (let sx = 0; sx < samplesX; sx++) dense[sz * samplesX + sx] = (sx * 5) / 10
    ground.heightmap = writeHeights(hm, scene.grid, dense)
    const stairs: ConnectorObject = add(scene, createConnector(ground.id, upper.id, { x: 20, z: 10, w: 10, d: 10 }, 3, "stairs"))
    // Direction 3 (−X): bottom edge x = 30 (ground 3), top edge x = 20 (upper level at 10).
    expect(connectorGround(scene, stairs, { x: 30, z: 15 })).toBeCloseTo(3)
    expect(connectorGround(scene, stairs, { x: 20, z: 15 })).toBeCloseTo(10)
    expect(connectorGround(scene, stairs, { x: 25, z: 15 })).toBeCloseTo(6.5)
  })

  it("ladders do not change ground height", () => {
    const { scene, ground, upper } = tower()
    add(scene, createConnector(ground.id, upper.id, { x: 40, z: 40, w: 5, d: 5 }, 0, "ladder"))
    expect(groundHeightAt(scene, ground.id, { x: 42, z: 42 })).toBe(0)
    expect(groundHeightAt(scene, upper.id, { x: 42, z: 42 })).toBe(10)
  })
})

describe("floors and cutouts", () => {
  it("cuts stairs out of the upper level's floors only", () => {
    const { scene, ground, upper, roof } = tower()
    const stairs = add(scene, createConnector(ground.id, upper.id, { x: 10, z: 10, w: 10, d: 20 }, 0, "stairs"))
    expect(floorCutouts(scene, ground.id)).toEqual([])
    expect(floorCutouts(scene, upper.id)).toEqual([stairs.rect])
    expect(floorCutouts(scene, roof.id)).toEqual([])
    expect(area(effectiveFloorRects(scene, ground.id).map((f) => f.rect))).toBe(2500)
    const up = effectiveFloorRects(scene, upper.id)
    expect(area(up.map((f) => f.rect))).toBe(2500 - 200)
    // Pieces are disjoint and none overlaps the hole.
    for (const f of up) {
      expect(rectSubtract(f.rect, stairs.rect)).toEqual([f.rect])
    }
    // Stairwell: no ground on the upper level, ground on the lower level (the run).
    expect(hasGroundAt(scene, upper.id, { x: 15, z: 15 })).toBe(false)
    expect(hasGroundAt(scene, ground.id, { x: 15, z: 15 })).toBe(true)
    // The landing beyond the top edge has floor on the upper level.
    expect(hasGroundAt(scene, upper.id, { x: 15, z: 32 })).toBe(true)
  })

  it("cuts a connector skipping a level out of every level it rises through", () => {
    const { scene, ground, upper, roof } = tower()
    add(scene, createConnector(ground.id, roof.id, { x: 0, z: 0, w: 5, d: 5 }, 0, "ladder"))
    expect(floorCutouts(scene, upper.id)).toHaveLength(1)
    expect(floorCutouts(scene, roof.id)).toHaveLength(1)
    expect(floorCutouts(scene, ground.id)).toHaveLength(0)
  })

  it("ladder cells have ground on both levels despite the cutout", () => {
    const { scene, ground, upper } = tower()
    add(scene, createConnector(ground.id, upper.id, { x: 40, z: 40, w: 5, d: 5 }, 0, "ladder"))
    expect(effectiveFloorRects(scene, upper.id).some((f) => f.rect.x <= 42 && f.rect.x + f.rect.w > 42 && f.rect.z <= 42 && f.rect.z + f.rect.d > 42)).toBe(false)
    expect(hasGroundAt(scene, upper.id, { x: 42, z: 42 })).toBe(true)
    expect(hasGroundAt(scene, ground.id, { x: 42, z: 42 })).toBe(true)
  })

  it("subtracts rects into disjoint pieces", () => {
    const a = { x: 0, z: 0, w: 10, d: 10 }
    expect(area(rectSubtract(a, { x: 2, z: 3, w: 4, d: 5 }))).toBe(80)
    expect(rectSubtract(a, { x: 20, z: 20, w: 1, d: 1 })).toEqual([a])
    expect(rectSubtract(a, { x: -1, z: -1, w: 20, d: 20 })).toEqual([])
  })
})

describe("tokens and lights", () => {
  it("resolves unattached lights against the ground under them", () => {
    const { scene, ground, upper } = tower()
    add(scene, createConnector(ground.id, upper.id, { x: 10, z: 10, w: 10, d: 20 }, 0, "stairs"))
    const onUpper = add(scene, createLight(upper.id, "torch", { x: 40, z: 40 }))
    expect(lightWorldPosition(scene, onUpper)).toEqual({ x: 40, y: 15, z: 40 })
    const onStairs = add(scene, createLight(ground.id, "candle", { x: 15, z: 20 }))
    expect(lightWorldPosition(scene, onStairs).y).toBeCloseTo(5 + 3)
  })

  it("resolves attached lights relative to the carrier's ground point", () => {
    const { scene, ground, upper } = tower()
    add(scene, createConnector(ground.id, upper.id, { x: 10, z: 10, w: 10, d: 20 }, 0, "stairs"))
    const t = createToken(ground.id, { x: 12.5, z: 22.5 })
    scene.tokens[t.id] = t
    const lantern = add(scene, createLight(upper.id, "lantern", { x: 0.5, z: -0.5 }, { attachedTokenId: t.id, position: { x: 0.5, y: 3, z: -0.5 } }))
    const w = lightWorldPosition(scene, lantern)
    expect(w.x).toBe(13)
    expect(w.z).toBe(22)
    expect(w.y).toBeCloseTo(6.25 + 3) // ground on the run at progress 0.625
    expect(lightLevelId(scene, lantern)).toBe(ground.id)
    expect(nominalTokenEye(scene, t).y).toBeCloseTo(6.25 + t.eyeHeight)
    // A dangling attachment falls back to the light's own fields.
    lantern.attachedTokenId = "gone"
    expect(lightLevelId(scene, lantern)).toBe(upper.id)
    expect(lightWorldPosition(scene, lantern)).toEqual({ x: 0.5, y: 13, z: -0.5 })
  })

  it("treats lights on hidden carriers as hidden", () => {
    const { scene, ground } = tower()
    const t = createToken(ground.id, { x: 2.5, z: 2.5 })
    scene.tokens[t.id] = t
    const light = add(scene, createLight(ground.id, "torch", { x: 0, z: 0 }, { attachedTokenId: t.id }))
    expect(lightEffectivelyHidden(scene, light)).toBe(false)
    t.hidden = true
    expect(lightEffectivelyHidden(scene, light)).toBe(true)
    t.hidden = false
    light.hidden = true
    expect(lightEffectivelyHidden(scene, light)).toBe(true)
    const free = add(scene, createLight(ground.id, "torch", { x: 1, z: 1 }))
    expect(lightEffectivelyHidden(scene, free)).toBe(false)
  })

  it("sizes token footprints", () => {
    const { scene, ground } = tower()
    expect(tokenRect(scene, createToken(ground.id, { x: 10, z: 10 }, { size: "large" }))).toEqual({ x: 5, z: 5, w: 10, d: 10 })
    expect(tokenRect(scene, createToken(ground.id, { x: 2.5, z: 2.5 }, { size: "tiny" }))).toEqual({ x: 1.25, z: 1.25, w: 2.5, d: 2.5 })
  })
})

describe("walls and openings", () => {
  it("derives opening segments and normals", () => {
    const w = createWall("l", { x: 0, z: 0 }, { x: 10, z: 0 })
    expect(openingSegment(w, { offset: 5, width: 4 })).toEqual({ a: { x: 3, z: 0 }, b: { x: 7, z: 0 } })
    expect(openingSegment(w, { offset: 1, width: 4 }).a).toEqual({ x: 0, z: 0 })
    const n = wallNormal(w)
    expect(n.x).toBeCloseTo(0)
    expect(n.z).toBeCloseTo(1)
  })
})
