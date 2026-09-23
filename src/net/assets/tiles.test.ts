import { describe, expect, it } from "vitest"

import { createScene } from "@/core/scene/factory"
import type { Cell } from "@/core/scene/types"
import { createCellMask, encodeMask, setCell } from "@/core/vision/mask"

import { createMemoryStore } from "../localStore"
import { createAssetStore } from "./index"
import { backdropCanvasSize, backdropCells, createBackdropPublisher, tileDestRect, tileSourceRect } from "./tiles"
import type { AssetStore } from "./types"

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

describe("backdrop publisher", () => {
  function fixture() {
    const scene = createScene({ width: 10, depth: 10 })
    const levelId = Object.keys(scene.levels)[0]
    scene.assets = { img: { id: "img", kind: "image", name: "map.webp", mime: "image/webp", width: 700, height: 700, bytes: 1 } }
    scene.levels[levelId].backdrop = { assetId: "img", rect: { x: 0, z: 0, w: 50, d: 50 }, opacity: 1, tintWalls: false }
    const published: Cell[] = []
    const granted: { user: string; epoch: number; cells: Cell[] }[] = []
    const assets: AssetStore = {
      mode: "supabase",
      putImage: () => Promise.reject(new Error("unused")),
      getImage: async () => new Blob([]),
      deleteImage: async () => {},
      copyImages: async () => {},
      putTileChunk: async () => {},
      deleteTileChunks: async () => {},
      removeSessionTiles: async () => 0,
      async publishTiles(_sid, _level, tiles) {
        published.push(...tiles.map((t) => t.cell))
      },
      async grantTiles(_sid, epoch, user, _level, cells) {
        granted.push({ user, epoch, cells: [...cells] })
      },
    }
    const cutCalls: Cell[][] = []
    const publisher = createBackdropPublisher({
      sessionId: "s",
      assets,
      loadImage: async () => ({ width: 700, height: 700, close() {} }) as unknown as ImageBitmap,
      cut: async (_img, size, rect, cellSize, tilePx, cells) => {
        expect(size).toMatchObject({ width: 700, height: 700 })
        expect(rect).toEqual({ x: 0, z: 0, w: 50, d: 50 })
        expect(cellSize).toBe(5)
        expect(tilePx).toBe(70)
        cutCalls.push([...cells])
        // Pretend the first cell is transparent (no tile).
        return cells.slice(1).map((cell) => ({ cell, blob: new Blob([]) }))
      },
    })
    const explored = (cells: [number, number][]) => {
      const m = createCellMask(10, 10)
      for (const [i, j] of cells) setCell(m, j * 10 + i, true)
      return { [levelId]: encodeMask(m) }
    }
    return { scene, levelId, publisher, published, granted, cutCalls, explored }
  }

  it("cuts, publishes and grants only new explored cells", async () => {
    const f = fixture()
    await f.publisher.sync(f.scene, "u1", 3, f.explored([[0, 0], [1, 0], [2, 0]]))
    expect(f.cutCalls).toEqual([[{ i: 0, j: 0 }, { i: 1, j: 0 }, { i: 2, j: 0 }]])
    expect(f.published).toEqual([{ i: 1, j: 0 }, { i: 2, j: 0 }])
    expect(f.granted).toEqual([{ user: "u1", epoch: 3, cells: [{ i: 0, j: 0 }, { i: 1, j: 0 }, { i: 2, j: 0 }] }])
    // Same explored set: nothing to do. One more cell: only that one.
    await f.publisher.sync(f.scene, "u1", 3, f.explored([[0, 0], [1, 0], [2, 0]]))
    await f.publisher.sync(f.scene, "u1", 3, f.explored([[0, 0], [1, 0], [2, 0], [0, 1]]))
    expect(f.cutCalls).toHaveLength(2)
    expect(f.cutCalls[1]).toEqual([{ i: 0, j: 1 }])
    expect(f.granted[1].cells).toEqual([{ i: 0, j: 1 }])
    // Another player exploring published cells: granted without re-cutting.
    await f.publisher.sync(f.scene, "u2", 3, f.explored([[1, 0]]))
    expect(f.cutCalls).toHaveLength(2)
    expect(f.granted[2]).toEqual({ user: "u2", epoch: 3, cells: [{ i: 1, j: 0 }] })
  })

  it("re-cuts after the backdrop changes and skips levels without one", async () => {
    const f = fixture()
    await f.publisher.sync(f.scene, "u1", 1, f.explored([[4, 4]]))
    f.scene.levels[f.levelId].backdrop = { ...f.scene.levels[f.levelId].backdrop!, rect: { x: 0, z: 0, w: 50, d: 50 }, assetId: "img" }
    f.scene.assets!.img2 = { ...f.scene.assets!.img, id: "img2" }
    f.scene.levels[f.levelId].backdrop!.assetId = "img2"
    await f.publisher.sync(f.scene, "u1", 1, f.explored([[4, 4]]))
    expect(f.cutCalls).toHaveLength(2)
    f.scene.levels[f.levelId].backdrop = null
    await f.publisher.sync(f.scene, "u1", 1, f.explored([[5, 5]]))
    expect(f.cutCalls).toHaveLength(2)
  })

  it("does nothing for local asset stores", async () => {
    const f = fixture()
    const local = createAssetStore({ client: null, store: createMemoryStore(), userId: "u" })
    const p = createBackdropPublisher({ sessionId: "s", assets: local, cut: async () => Promise.reject(new Error("must not cut")) })
    await expect(p.sync(f.scene, "u1", 1, f.explored([[0, 0]]))).resolves.toBeUndefined()
  })
})
