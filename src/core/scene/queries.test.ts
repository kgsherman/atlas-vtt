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
  groundIndex,
  hasGroundAt,
  levelCeilingY,
  lightEffectivelyHidden,
  lightGroundY,
  lightLevelId,
  lightWorldPosition,
  nominalTokenEye,
  openingSegment,
  rectSubtract,
  sortedLevels,
  tokenRect,
  tokenViewLevelId,
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

describe("tokenViewLevelId", () => {
  // A 6-row, 10 ft stair run from the ground floor (0) to the upper floor (10), rising along +z.
  function stairs() {
    const { scene, ground, upper } = tower()
    const run = add(scene, createConnector(ground.id, upper.id, { x: 20, z: 10, w: 5, d: 30 }, 0))
    const ladder = add(scene, createConnector(ground.id, upper.id, { x: 40, z: 40, w: 5, d: 5 }, 0, "ladder"))
    const at = (row: number, eyeHeight: number) => ({ levelId: ground.id, position: { x: 22.5, z: 12.5 + 5 * row }, eyeHeight })
    return { scene, ground, upper, run, ladder, at }
  }

  it("is the token's own level off a run", () => {
    const { scene, ground } = stairs()
    expect(tokenViewLevelId(scene, { levelId: ground.id, position: { x: 7.5, z: 7.5 }, eyeHeight: 14 })).toBe(ground.id)
  })

  it("switches to the arrival level once the eye is above its floor", () => {
    const { scene, ground, upper, at } = stairs()
    expect([0, 1, 2, 3, 4, 5].map((row) => tokenViewLevelId(scene, at(row, 5.5)))).toEqual([ground.id, ground.id, ground.id, upper.id, upper.id, upper.id])
    // A halfling (eye 3) switches later; a giant (eye 14) from the bottom row.
    expect([0, 1, 2, 3, 4, 5].map((row) => tokenViewLevelId(scene, at(row, 3)))).toEqual([ground.id, ground.id, ground.id, ground.id, upper.id, upper.id])
    expect([0, 1, 2, 3, 4, 5].map((row) => tokenViewLevelId(scene, at(row, 14)))).toEqual(Array(6).fill(upper.id))
  })

  it("never switches on a ladder", () => {
    const { scene, ground, upper } = stairs()
    expect(tokenViewLevelId(scene, { levelId: ground.id, position: { x: 42.5, z: 42.5 }, eyeHeight: 14 })).toBe(ground.id)
    expect(tokenViewLevelId(scene, { levelId: upper.id, position: { x: 42.5, z: 42.5 }, eyeHeight: 5.5 })).toBe(upper.id)
  })

  it("stays on the token's level when the connector's arrival level is missing", () => {
    const { scene, ground, run, at } = stairs()
    scene.objects[run.id] = { ...run, toLevelId: "gone" }
    expect(tokenViewLevelId(scene, at(5, 5.5))).toBe(ground.id)
  })
})

describe("groundIndex", () => {
  /** Tower with stairs, a ramp, a ladder, a masked floor and terrain on the upper level. */
  function varied() {
    const { scene, ground, upper, roof } = tower()
    add(scene, createConnector(ground.id, upper.id, { x: 10, z: 10, w: 5, d: 15 }, 0))
    add(scene, createConnector(upper.id, roof.id, { x: 30, z: 5, w: 10, d: 5 }, 3, "ramp"))
    add(scene, createConnector(ground.id, upper.id, { x: 40, z: 40, w: 5, d: 5 }, 1, "ladder"))
    // A masked floor on the roof: 8 × 4 cells of 1.25 ft at x = 3.75 (not lattice-aligned), checkerboard rows.
    add(scene, { ...createFloor(roof.id, { x: 3.75, z: 20, w: 10, d: 5 }), mask: { spacing: 1.25, cols: 8, rows: 4, b64: btoa(String.fromCharCode(0xff, 0x0f, 0xf0, 0x3c)) } })
    const hm = createHeightmap(2)
    const { samplesX, samplesZ } = sampleCounts(scene.grid, 2)
    const dense = new Float32Array(samplesX * samplesZ)
    for (let k = 0; k < dense.length; k++) dense[k] = 0.25 * Math.sin(k / 7)
    scene.levels[upper.id] = { ...upper, heightmap: writeHeights(hm, scene.grid, dense) }
    return { scene, ground, upper, roof }
  }

  const expectSameAsFree = (scene: Scene) => {
    const index = groundIndex(scene)
    let ground = 0
    for (const levelId of Object.keys(scene.levels)) {
      expect(index.effectiveFloors(levelId)).toEqual(effectiveFloorRects(scene, levelId))
      for (let z = -2.3; z < 52; z += 1.1) {
        for (let x = -2.3; x < 52; x += 1.1) {
          const p = { x, z }
          const has = hasGroundAt(scene, levelId, p)
          expect(index.hasGroundAt(levelId, p), `${levelId} ${x},${z}`).toBe(has)
          expect(index.groundHeightAt(levelId, p), `${levelId} ${x},${z}`).toBe(groundHeightAt(scene, levelId, p))
          expect(index.runAt(levelId, p), `${levelId} ${x},${z}`).toBe(connectorsAt(scene, levelId, p).find((c) => c.style !== "ladder"))
          if (has) ground++
        }
      }
    }
    expect(ground).toBeGreaterThan(0)
  }

  it("gives the free functions' results", () => {
    expectSameAsFree(varied().scene)
  })

  it("gives the token and light helpers the same results as without it", () => {
    const { scene, ground, upper, roof } = varied()
    const index = groundIndex(scene)
    let n = 0
    for (const levelId of [ground.id, upper.id, roof.id]) {
      for (let z = 1.25; z < 50; z += 2.5) {
        for (let x = 1.25; x < 50; x += 2.5) {
          const token = createToken(levelId, { x, z }, { eyeHeight: 5.5 })
          scene.tokens[token.id] = token
          const light = createLight(levelId, "torch", { x, z }, { position: { x, y: 4, z } })
          const carried = createLight(levelId, "lantern", { x: 0, z: 0 }, { attachedTokenId: token.id, position: { x: 0.5, y: 3, z: -0.5 } })
          for (const l of [light, carried]) {
            expect(lightGroundY(scene, l, index)).toBe(lightGroundY(scene, l))
            expect(lightWorldPosition(scene, l, index)).toEqual(lightWorldPosition(scene, l))
          }
          expect(nominalTokenEye(scene, token, index)).toEqual(nominalTokenEye(scene, token))
          expect(tokenViewLevelId(scene, token, index)).toBe(tokenViewLevelId(scene, token))
          if (tokenViewLevelId(scene, token) !== levelId) n++
          delete scene.tokens[token.id]
        }
      }
    }
    // Some of those tokens stood high on a run (the view level switched).
    expect(n).toBeGreaterThan(0)
  })

  it("is memoised per scene revision and rebuilt after immer edits to objects, levels or terrain", () => {
    const { scene, ground, upper, roof } = varied()
    const a = groundIndex(scene)
    expect(groundIndex(scene)).toBe(a)
    expect(groundIndex({ ...scene })).toBe(a)
    const added = produce(scene, (d) => {
      const c = createConnector(ground.id, roof.id, { x: 0, z: 40, w: 5, d: 10 }, 0)
      d.objects[c.id] = c
    })
    expect(groundIndex(added)).not.toBe(a)
    expectSameAsFree(added)
    const raised = produce(added, (d) => {
      d.levels[upper.id].elevation = 12
    })
    expect(groundIndex(raised)).not.toBe(groundIndex(added))
    expectSameAsFree(raised)
    const terrain = produce(raised, (d) => {
      const { samplesX, samplesZ } = sampleCounts(d.grid, 2)
      d.levels[upper.id].heightmap = writeHeights(createHeightmap(2), d.grid, new Float32Array(samplesX * samplesZ).fill(1.5))
    })
    expect(groundIndex(terrain)).not.toBe(groundIndex(raised))
    expect(groundIndex(terrain).groundHeightAt(upper.id, { x: 2.5, z: 2.5 })).toBe(13.5)
    expectSameAsFree(terrain)
  })
})
