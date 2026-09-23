import { describe, expect, it } from "vitest"

import { buildOcclusionWorld } from "../occlusion"
import { effectiveFloorRects } from "../scene/queries"
import { createDoor, createFloor, createLight, createProp, createWall, createWindow } from "../scene/factory"
import { createGradeMask, maskHasPoint, maskTouchesShape, objectFootprint, observedObjectIds } from "."
import { add, flat } from "./test-scenes"
import type { GradeMask, Viewer } from "./types"

function maskWith(cells: [number, number, number?][], width = 10, depth = 10): GradeMask {
  const m = createGradeMask(width, depth)
  for (const [i, j, partial] of cells) {
    m.grades[j * width + i] = 3
    if (partial !== undefined) m.partial.set(j * width + i, partial)
  }
  return m
}

describe("footprint overlap", () => {
  const rect = (x0: number, z0: number, x1: number, z1: number) => ({ x0, z0, x1, z1, pts: null })

  it("is strict: touching a perceived cell's edge does not count", () => {
    const m = maskWith([[2, 2]])
    expect(maskTouchesShape(m, 5, rect(15, 10, 16, 11))).toBe(false)
    expect(maskTouchesShape(m, 5, rect(14.9, 10, 16, 11))).toBe(true)
  })

  it("uses sub-cells of partial cells", () => {
    // Only sub-cell (3, 0) of cell (2, 2): x ∈ [13.75, 15], z ∈ [10, 11.25].
    const m = maskWith([[2, 2, 1 << 3]])
    expect(maskTouchesShape(m, 5, rect(10, 10, 12, 12))).toBe(false)
    expect(maskTouchesShape(m, 5, rect(14, 10.5, 14.5, 11))).toBe(true)
    expect(maskHasPoint(m, 5, 14.5, 10.5)).toBe(true)
    expect(maskHasPoint(m, 5, 11, 10.5)).toBe(false)
  })

  it("tests rotated footprints exactly", () => {
    const { scene, ground } = flat(10, 10)
    const wall = add(scene, createWall(ground, { x: 0, z: 0 }, { x: 20, z: 20 }))
    const fp = objectFootprint(scene, wall, (id) => effectiveFloorRects(scene, id))!
    // Cell (3, 0) is far from the diagonal; cell (2, 2) contains it.
    expect(maskTouchesShape(maskWith([[3, 0]]), 5, fp.shapes[0])).toBe(false)
    expect(maskTouchesShape(maskWith([[2, 2]]), 5, fp.shapes[0])).toBe(true)
  })

  it("builds footprints for every object kind", () => {
    const { scene, ground } = flat(10, 10)
    const floors = (id: string) => effectiveFloorRects(scene, id)
    const wall = add(scene, createWall(ground, { x: 10, z: 0 }, { x: 10, z: 30 }))
    const door = add(scene, createDoor(wall, 15))
    const win = add(scene, createWindow(wall, 25))
    const prop = add(scene, createProp(ground, "statue", { x: 30, y: 0, z: 30 }, { rotationY: 0.4 }))
    const light = add(scene, createLight(ground, "torch", { x: 5, z: 5 }))
    const fd = objectFootprint(scene, door, floors)!
    expect(fd.shapes[0]).toMatchObject({ x0: 9.75, x1: 10.25, z0: 13, z1: 17 })
    expect(objectFootprint(scene, win, floors)!.shapes[0]).toMatchObject({ z0: 23.5, z1: 26.5 })
    expect(objectFootprint(scene, prop, floors)!.shapes).toHaveLength(2)
    expect(objectFootprint(scene, light, floors)).toBeNull()
    const floorId = Object.values(scene.objects).find((o) => o.type === "floor")!
    expect(objectFootprint(scene, floorId, floors)!.shapes[0]).toMatchObject({ x0: 0, z0: 0, x1: 50, z1: 50 })
  })
})

describe("observedObjectIds", () => {
  it("observes objects whose footprint meets perceived cells and lit lights in line of sight", () => {
    const { scene, ground } = flat(10, 10)
    const wall = add(scene, createWall(ground, { x: 25, z: 0 }, { x: 25, z: 50 }))
    const near = add(scene, createProp(ground, "crate", { x: 12.5, y: 0, z: 12.5 }))
    const far = add(scene, createProp(ground, "crate", { x: 37.5, y: 0, z: 12.5 }))
    const small = add(scene, createFloor(ground, { x: 40, z: 40, w: 5, d: 5 }))
    const lamp = add(scene, createLight(ground, "lantern", { x: 40, z: 5 }, { position: { x: 40, y: 20, z: 5 } }))
    const perception = { [ground]: maskWith([[1, 1], [2, 2], [4, 3]]) }
    const viewers: Viewer[] = [{ tokenId: "v", levelId: ground, eye: { x: 7.5, y: 5.5, z: 7.5 }, vision: { darkvision: 0, blindsight: 0, blind: false } }]
    const world = buildOcclusionWorld(scene)
    const seen = observedObjectIds(scene, perception, viewers, world)
    expect(seen.has(wall.id)).toBe(true)
    expect(seen.has(near.id)).toBe(true)
    expect(seen.has(far.id)).toBe(false)
    expect(seen.has(small.id)).toBe(false)
    // The lantern is mounted above the 10 ft wall top and in line of sight of the eye.
    expect(seen.has(lamp.id)).toBe(true)
    const blind = observedObjectIds(scene, perception, [{ ...viewers[0], vision: { darkvision: 0, blindsight: 10, blind: true } }], world)
    expect(blind.has(lamp.id)).toBe(false)
  })
})
