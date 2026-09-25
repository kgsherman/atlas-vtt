import { describe, expect, it } from "vitest"

import { buildOcclusionWorld } from "../occlusion"
import { createDoor, createFloor, createWall } from "../scene/factory"
import type { Id, Scene } from "../scene/types"
import { add, addLevel, addToken, flat } from "../vision/test-scenes"
import {
  AREA_LIMITS,
  areaAroundToken,
  areaOutline,
  areaVolume,
  computeAreaEffect,
  describeArea,
  normalizeArea,
  type AreaGeometry,
  type AreaShape,
} from "./index"

const area = (levelId: Id, shape: AreaShape, x: number, z: number, size: number, more: Partial<AreaGeometry> = {}): AreaGeometry =>
  normalizeArea({ shape, levelId, x, z, elevation: 0, angle: 0, size, width: 5, height: 40, ...more })

function effect(scene: Scene, g: AreaGeometry) {
  return computeAreaEffect(scene, buildOcclusionWorld(scene), g)
}

/** Covered cells of a level as "i,j" strings. */
function cellsOf(scene: Scene, cells: readonly number[] | undefined): string[] {
  return (cells ?? []).map((k) => `${k % scene.grid.width},${Math.floor(k / scene.grid.width)}`)
}

describe("normalizeArea", () => {
  it("clamps sizes, normalises the angle and zeroes it for round shapes", () => {
    const g = normalizeArea({ shape: "cone", levelId: "L", x: 1, z: 2, elevation: -5, angle: 3 * Math.PI, size: 9999, width: 0, height: 0 })
    expect(g.size).toBe(AREA_LIMITS.maxSize)
    expect(g.elevation).toBe(0)
    expect(Math.cos(g.angle)).toBeCloseTo(-1, 5)
    expect(g.width).toBe(5)
    const s = normalizeArea({ shape: "sphere", levelId: "L", x: 0, z: 0, elevation: 0, angle: 1.2, size: 0, width: 30, height: 3 })
    expect(s.angle).toBe(0)
    expect(s.size).toBe(AREA_LIMITS.minSize)
    expect(s.width).toBe(5)
    expect(s.height).toBe(40)
    expect(normalizeArea({ ...s, shape: "cylinder", height: 1000 }).height).toBe(AREA_LIMITS.maxHeight)
    expect(normalizeArea({ ...s, shape: "nope" as AreaShape }).shape).toBe("sphere")
    expect(normalizeArea({ ...s, x: Number.NaN }).x).toBe(0)
  })

  it("keeps rounded angles within [−π, π] (a westward aim is stored as a loadable value)", () => {
    for (const a of [Math.PI, -Math.PI, Math.PI - 1e-5, -Math.PI + 1e-5, 3 * Math.PI]) {
      const g = normalizeArea({ shape: "line", levelId: "L", x: 0, z: 0, elevation: 0, angle: a, size: 10, width: 5, height: 40 })
      expect(Math.abs(g.angle)).toBeLessThanOrEqual(Math.PI)
      expect(Math.abs(Math.abs(g.angle) - Math.PI)).toBeLessThan(0.002)
    }
  })

  it("describes areas", () => {
    expect(describeArea(area("L", "sphere", 0, 0, 20))).toBe("20 ft sphere")
    expect(describeArea(area("L", "line", 0, 0, 100, { width: 5 }))).toBe("100 × 5 ft line")
    expect(describeArea(area("L", "cylinder", 0, 0, 10, { height: 40 }))).toBe("10 ft cylinder, 40 ft high")
  })
})

describe("areaVolume", () => {
  it("cones are as wide as they are far, in every direction around the axis", () => {
    const v = areaVolume(area("L", "cone", 0, 0, 20), 0)
    expect(v.contains({ x: 10, y: 0, z: 4.9 })).toBe(true)
    expect(v.contains({ x: 10, y: 0, z: 5.2 })).toBe(false)
    expect(v.contains({ x: 10, y: 4.9, z: 0 })).toBe(true)
    expect(v.contains({ x: 10, y: -5.2, z: 0 })).toBe(false)
    expect(v.contains({ x: -1, y: 0, z: 0 })).toBe(false)
    expect(v.contains({ x: 20.5, y: 0, z: 0 })).toBe(false)
  })

  it("aims along (cos angle, sin angle) in XZ", () => {
    const v = areaVolume(area("L", "line", 10, 10, 30, { angle: Math.PI / 2 }), 0)
    expect(v.contains({ x: 10, y: 1, z: 35 })).toBe(true)
    expect(v.contains({ x: 10, y: 1, z: 5 })).toBe(false)
    expect(v.contains({ x: 13, y: 1, z: 20 })).toBe(false)
    expect(v.contains({ x: 10, y: 3, z: 20 })).toBe(false)
  })

  it("cylinders and cubes reach down to lower ground but not above their top", () => {
    const c = areaVolume(area("L", "cylinder", 0, 0, 10, { height: 20 }), 5)
    expect(c.contains({ x: 3, y: -30, z: 3 })).toBe(true)
    expect(c.contains({ x: 3, y: 25.5, z: 3 })).toBe(false)
    const k = areaVolume(area("L", "cube", 0, 0, 10), 0)
    expect(k.contains({ x: 9, y: -3, z: 4.9 })).toBe(true)
    expect(k.contains({ x: 9, y: 10.5, z: 0 })).toBe(false)
    expect(k.contains({ x: 9, y: 1, z: 5.2 })).toBe(false)
  })

  it("outlines each shape from above", () => {
    expect(areaOutline(area("L", "sphere", 0, 0, 10), 16)).toHaveLength(16)
    const cone = areaOutline(area("L", "cone", 0, 0, 10))
    expect(cone).toHaveLength(3)
    expect(cone[1].x).toBeCloseTo(10)
    expect(Math.abs(cone[1].z)).toBeCloseTo(5)
    expect(areaOutline(area("L", "cube", 0, 0, 10))).toHaveLength(4)
  })
})

describe("computeAreaEffect", () => {
  it("a 20 ft sphere from a grid intersection covers the 52 squares whose centres it contains", () => {
    const { scene, ground } = flat(20, 20)
    const r = effect(scene, area(ground, "sphere", 50, 50, 20))
    expect(r.cells[ground]).toHaveLength(52)
    expect(Object.keys(r.cells)).toEqual([ground])
  })

  it("walls stop it: squares and creatures behind a wall are untouched", () => {
    const { scene, ground } = flat(20, 20)
    add(scene, createWall(ground, { x: 60, z: 0 }, { x: 60, z: 100 }, { height: 10 }))
    const near = addToken(scene, ground, 57.5, 52.5)
    const far = addToken(scene, ground, 62.5, 52.5)
    const r = effect(scene, area(ground, "sphere", 50, 50, 20))
    const cells = cellsOf(scene, r.cells[ground])
    expect(cells).toContain("11,10")
    expect(cells).not.toContain("12,10")
    expect(cells.every((c) => Number(c.split(",")[0]) <= 11)).toBe(true)
    expect(r.tokenIds).toEqual([near.id])
    expect(r.tokenIds).not.toContain(far.id)
  })

  it("a low wall stops the low part only: a tall creature behind it is still reached", () => {
    const { scene, ground } = flat(20, 20)
    add(scene, createWall(ground, { x: 60, z: 0 }, { x: 60, z: 100 }, { height: 3 }))
    const small = addToken(scene, ground, 62.5, 52.5, { size: "small", height: 2, eyeHeight: 1.5 })
    const tall = addToken(scene, ground, 62.5, 47.5, { height: 6 })
    const r = effect(scene, area(ground, "sphere", 50, 50, 20))
    expect(r.tokenIds).toContain(tall.id)
    expect(r.tokenIds).not.toContain(small.id)
  })

  it("closed doors block, open doors let it through", () => {
    const { scene, ground } = flat(20, 20)
    const wall = add(scene, createWall(ground, { x: 60, z: 40 }, { x: 60, z: 60 }, { height: 10 }))
    const door = add(scene, createDoor(wall, 10, { state: "closed", width: 5 }))
    const beyond = addToken(scene, ground, 67.5, 50)
    const g = area(ground, "line", 42.5, 50, 40)
    expect(effect(scene, g).tokenIds).not.toContain(beyond.id)
    scene.objects[door.id] = { ...door, state: "open" }
    expect(effect(scene, g).tokenIds).toContain(beyond.id)
  })

  it("a cone from an intersection along +x covers the squares whose centres are in it", () => {
    const { scene, ground } = flat(20, 20)
    const r = effect(scene, area(ground, "cone", 50, 50, 15))
    expect(cellsOf(scene, r.cells[ground]).sort()).toEqual(["11,10", "11,9", "12,10", "12,9"])
  })

  it("a line covers its width along its length", () => {
    const { scene, ground } = flat(20, 20)
    const r = effect(scene, area(ground, "line", 50, 52.5, 30))
    expect(cellsOf(scene, r.cells[ground])).toEqual(["10,10", "11,10", "12,10", "13,10", "14,10", "15,10"])
  })

  it("floors stop it: the cellar under a fireball is never reached", () => {
    const { scene, ground } = flat(20, 20)
    const cellar = addLevel(scene, { name: "Cellar", elevation: -10, height: 9 }, { x: 0, z: 0, w: 100, d: 100 })
    const rat = addToken(scene, cellar.id, 52.5, 52.5, { size: "tiny", height: 1, eyeHeight: 0.8 })
    const r = effect(scene, area(ground, "sphere", 50, 50, 20))
    expect(r.cells[cellar.id]).toBeUndefined()
    expect(r.tokenIds).not.toContain(rat.id)
  })

  it("reaches the edge of a balcony over the courtyard, not the floor behind it", () => {
    const { scene, ground } = flat(20, 20)
    const upper = addLevel(scene, { name: "Upper", elevation: 10 }, { x: 0, z: 0, w: 50, d: 100 })
    const onEdge = addToken(scene, upper.id, 47.5, 52.5)
    const inside = addToken(scene, upper.id, 32.5, 52.5)
    const r = effect(scene, area(ground, "sphere", 57.5, 50, 20))
    const upperCells = cellsOf(scene, r.cells[upper.id])
    expect(upperCells).toContain("9,10")
    expect(upperCells.every((c) => Number(c.split(",")[0]) === 9)).toBe(true)
    expect(r.tokenIds).toContain(onEdge.id)
    expect(r.tokenIds).not.toContain(inside.id)
    // Its own level still gets the full disc of the courtyard side.
    expect(cellsOf(scene, r.cells[ground])).toContain("11,10")
  })

  it("a sphere high in the air reaches the storey above but not the ground below it", () => {
    const { scene, ground } = flat(20, 20)
    const upper = addLevel(scene, { name: "Upper", elevation: 10 }, { x: 0, z: 0, w: 100, d: 100 })
    const r = effect(scene, area(ground, "sphere", 50, 50, 10, { elevation: 20 }))
    expect(r.cells[upper.id]?.length).toBeGreaterThan(0)
    expect(r.cells[ground]).toBeUndefined()
  })

  it("only tests the tokens it is given (a player's view)", () => {
    const { scene, ground } = flat(10, 10)
    const a = addToken(scene, ground, 22.5, 22.5)
    const b = addToken(scene, ground, 27.5, 22.5)
    const r = computeAreaEffect(scene, buildOcclusionWorld(scene), area(ground, "sphere", 25, 25, 10), { tokens: [a], noCells: true })
    expect(r.tokenIds).toEqual([a.id])
    expect(r.cells).toEqual({})
    expect(r.tokenIds).not.toContain(b.id)
  })

  it("a large creature is affected when any square it occupies is covered", () => {
    const { scene, ground } = flat(20, 20)
    const ogre = addToken(scene, ground, 20, 50, { size: "large", height: 9, eyeHeight: 8 })
    // A 5 ft line along z at x = 22.5 covers the ogre's right-hand column only.
    const r = effect(scene, area(ground, "line", 22.5, 40, 20, { angle: Math.PI / 2 }))
    expect(r.tokenIds).toEqual([ogre.id])
  })

  it("ignores areas on unknown levels", () => {
    const { scene } = flat(10, 10)
    expect(effect(scene, area("nope", "sphere", 25, 25, 10))).toEqual({ origin: { x: 0, y: 0, z: 0 }, cells: {}, tokenIds: [] })
  })

  it("an area carried by a token is measured from the edge of its space", () => {
    const { scene, ground } = flat(10, 10)
    const cleric = addToken(scene, ground, 22.5, 27.5)
    const g = areaAroundToken(area(ground, "sphere", 0, 0, 15), cleric, 5)
    expect(g).toMatchObject({ levelId: ground, x: 22.5, z: 27.5, size: 17.5 })
    expect(areaAroundToken(area(ground, "cone", 0, 0, 15), cleric, 5).size).toBe(15)
  })

  it("floors without ground are not covered (nothing stands there)", () => {
    const { scene, ground } = flat(20, 20, "bright")
    for (const o of Object.values(scene.objects)) delete scene.objects[o.id]
    add(scene, createFloor(ground, { x: 0, z: 0, w: 50, d: 100 }))
    const r = effect(scene, area(ground, "sphere", 50, 50, 20))
    expect(cellsOf(scene, r.cells[ground]).every((c) => Number(c.split(",")[0]) < 10)).toBe(true)
  })
})
