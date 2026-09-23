import { describe, expect, it } from "vitest"

import { createScene } from "@/core/scene/factory"

import { backdropCanvasSize, backdropCells, backdropTilePx, tileDestRect, tileSourceRect } from "./tiles"

describe("tile geometry", () => {
  const grid = { cellSize: 5, width: 27, depth: 47 }

  it("lists the grid cells a backdrop covers", () => {
    expect(backdropCells({ x: 0, z: 0, w: 135, d: 235 }, grid)).toHaveLength(27 * 47)
    // Offset by half a cell: overlaps one more column and row, clamped to the grid.
    const cells = backdropCells({ x: 2.5, z: 2.5, w: 10, d: 5 }, grid)
    expect(cells).toEqual([
      { i: 0, j: 0 },
      { i: 1, j: 0 },
      { i: 2, j: 0 },
      { i: 0, j: 1 },
      { i: 1, j: 1 },
      { i: 2, j: 1 },
    ])
    expect(backdropCells({ x: -20, z: -20, w: 10, d: 10 }, grid)).toEqual([])
  })

  it("maps a cell to its source pixels and its place on the player canvas", () => {
    const rect = { x: 0, z: 0, w: 135, d: 235 }
    // 3780×6580 px image = 140 px per 5 ft cell.
    expect(tileSourceRect(rect, { width: 3780, height: 6580 }, 5, { i: 2, j: 3 })).toEqual({ sx: 280, sy: 420, sw: 140, sh: 140 })
    expect(tileDestRect(rect, 5, 140, { i: 2, j: 3 })).toEqual({ dx: 280, dy: 420, size: 140 })
    expect(tileDestRect(rect, 5, 140, { i: 2, j: 3 }, 0.5)).toEqual({ dx: 140, dy: 210, size: 70 })
    expect(backdropCanvasSize(rect, 5, 140)).toEqual({ width: 3780, height: 6580 })
    // A backdrop placed at an offset: cell (0, 0) starts before the image.
    const off = { x: 2.5, z: 0, w: 135, d: 235 }
    expect(tileSourceRect(off, { width: 3780, height: 6580 }, 5, { i: 0, j: 0 }).sx).toBe(-70)
  })
})

describe("backdrop tile size", () => {
  it("is the stored px per cell, like the player filter's placement", () => {
    const scene = createScene({ width: 27, depth: 47 })
    const levelId = Object.keys(scene.levels)[0]
    expect(backdropTilePx(scene, levelId)).toBeNull()
    scene.assets = { map: { id: "map", kind: "image", name: "m", mime: "image/webp", width: 3780, height: 6580, bytes: 1 } }
    scene.levels[levelId].backdrop = { assetId: "map", rect: { x: 0, z: 0, w: 135, d: 235 }, opacity: 1, tintWalls: false }
    expect(backdropTilePx(scene, levelId)).toBe(140)
    scene.assets.map.width = 1_000_000
    expect(backdropTilePx(scene, levelId)).toBe(1024)
  })
})
