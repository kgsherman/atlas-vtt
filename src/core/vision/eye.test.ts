import { describe, expect, it } from "vitest"

import { buildOcclusionWorld } from "../occlusion"
import { createConnector, createProp, createWall } from "../scene/factory"
import { resolveViewerEye, tokenPointColumns, tokenTestPoints } from "."
import { add, addLevel, addToken, flat } from "./test-scenes"

describe("resolveViewerEye", () => {
  it("is ground + eyeHeight in the open", () => {
    const { scene, ground } = flat(10, 10)
    const t = addToken(scene, ground, 12.5, 12.5)
    const eye = resolveViewerEye(buildOcclusionWorld(scene), scene, t)
    expect(eye).toEqual({ x: 12.5, y: 5.5, z: 12.5 })
  })

  it("stays 0.25 ft below a ceiling", () => {
    const { scene, ground } = flat(10, 10)
    addLevel(scene, { name: "Upper", elevation: 8, floorThickness: 0.5 }, { x: 0, z: 0, w: 50, d: 50 })
    const t = addToken(scene, ground, 12.5, 12.5, { eyeHeight: 9 })
    expect(resolveViewerEye(buildOcclusionWorld(scene), scene, t).y).toBeCloseTo(7.25, 9)
  })

  it("follows stairs and ignores the stair solid underneath", () => {
    const { scene, ground } = flat(10, 10)
    const upper = addLevel(scene, { name: "Upper", elevation: 10 }, { x: 0, z: 0, w: 50, d: 50 })
    add(scene, createConnector(ground, upper.id, { x: 20, z: 20, w: 5, d: 10 }, 0))
    const t = addToken(scene, ground, 22.5, 25)
    // Half way up the run: ground 5.
    expect(resolveViewerEye(buildOcclusionWorld(scene), scene, t).y).toBeCloseTo(10.5, 9)
  })

  it("keeps the eye inside a blocker the creature stands in (a bush)", () => {
    const { scene, ground } = flat(10, 10)
    add(scene, { ...createProp(ground, "bush", { x: 12.5, y: 0, z: 12.5 }), scale: { x: 1, y: 3, z: 1 } })
    const t = addToken(scene, ground, 12.5, 12.5)
    const eye = resolveViewerEye(buildOcclusionWorld(scene), scene, t)
    expect(eye.y).toBeCloseTo(5.5, 9)
    expect(eye.x).toBe(12.5)
  })

  it("is clamped under an overhanging blocker it did not start in", () => {
    const { scene, ground } = flat(10, 10)
    // Tree canopy from 7 to 18 ft; a huge creature standing under it (beside the trunk).
    add(scene, createProp(ground, "tree", { x: 12.5, y: 0, z: 12.5 }))
    const t = addToken(scene, ground, 15, 12.5, { size: "huge", eyeHeight: 14, height: 16 })
    const eye = resolveViewerEye(buildOcclusionWorld(scene), scene, t)
    expect(eye.y).toBeCloseTo(6.75, 9)
  })
})

describe("tokenTestPoints", () => {
  it("uses centre + 4 corners (+ 4 edge midpoints for ≥ 3-cell tokens) × 3 heights", () => {
    expect(tokenPointColumns(5, "medium")).toHaveLength(5)
    expect(tokenPointColumns(5, "large")).toHaveLength(5)
    expect(tokenPointColumns(5, "huge")).toHaveLength(9)
    expect(tokenPointColumns(5, "gargantuan")).toHaveLength(9)
    const { scene, ground } = flat(10, 10)
    const t = addToken(scene, ground, 12.5, 12.5)
    const pts = tokenTestPoints(buildOcclusionWorld(scene), scene, t)
    expect(pts).toHaveLength(15)
    expect(pts.slice(0, 3).map((p) => p.y)).toEqual([0.25, 3, 5.9])
    // Corners inset 0.5 ft from the 5 ft footprint.
    expect(pts.some((p) => p.x === 14.5 && p.z === 14.5)).toBe(true)
  })

  it("caps points below a low ceiling", () => {
    const { scene, ground } = flat(10, 10)
    addLevel(scene, { name: "Upper", elevation: 5, floorThickness: 0.5 }, { x: 0, z: 0, w: 50, d: 50 })
    const t = addToken(scene, ground, 12.5, 12.5)
    const pts = tokenTestPoints(buildOcclusionWorld(scene), scene, t)
    for (const p of pts) expect(p.y).toBeLessThanOrEqual(4.25 + 1e-9)
  })

  it("skips off-centre points separated from the centre by a wall", () => {
    const { scene, ground } = flat(10, 10)
    // A large token straddling a thin wall through its footprint.
    add(scene, createWall(ground, { x: 20, z: 0 }, { x: 20, z: 50 }, { thickness: 0.2 }))
    const t = addToken(scene, ground, 21, 25, { size: "large" })
    const pts = tokenTestPoints(buildOcclusionWorld(scene), scene, t)
    expect(pts.every((p) => p.x > 20)).toBe(true)
    expect(pts.length).toBeLessThan(15)
  })
})
