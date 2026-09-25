import { afterEach, describe, expect, it, vi } from "vitest"

import { createScene } from "@/core/scene/factory"
import { backdropCellRange } from "@/core/session/backdrop"
import { createCellMask, setCell, setSubcells } from "@/core/vision/mask"

import { createMemoryStore } from "../localStore"
import { exploredCellsInRect } from "../player/backdropCanvas"
import type { AtlasClient } from "../supabase"
import { createLocalAssetStore } from "./localAssets"
import { createLocalTileSource, createSupabaseTileSource, tileSourceRect } from "./tiles"

describe("tile geometry", () => {
  const grid = { cellSize: 5, width: 27, depth: 47 }

  it("lists the grid cells a backdrop covers (core/session/backdrop)", () => {
    expect(backdropCellRange({ x: 0, z: 0, w: 135, d: 235 }, grid)).toEqual({ i0: 0, j0: 0, i1: 26, j1: 46 })
    // Offset by half a cell: overlaps one more column and row, clamped to the grid.
    expect(backdropCellRange({ x: 2.5, z: 2.5, w: 10, d: 5 }, grid)).toEqual({ i0: 0, j0: 0, i1: 2, j1: 1 })
    expect(backdropCellRange({ x: -20, z: -20, w: 10, d: 10 }, grid)).toBeNull()
  })

  it("treats a rect edge within float noise of a grid line as on it (host and player agree)", () => {
    // Calibration noise: edges at k·cellSize ± 1e-7 ft.
    for (const e of [1e-7, -1e-7]) {
      expect(backdropCellRange({ x: 10 + e, z: 20 + e, w: 25, d: 15 }, grid)).toEqual({ i0: 2, j0: 4, i1: 6, j1: 6 })
      expect(backdropCellRange({ x: 10, z: 20, w: 25 + e, d: 15 + e }, grid)).toEqual({ i0: 2, j0: 4, i1: 6, j1: 6 })
    }
    // Every cell around those edges explored: the player waits for exactly the cells the host tiles.
    const m = createCellMask(27, 47)
    for (let j = 3; j <= 7; j++) for (let i = 1; i <= 7; i++) setCell(m, j * 27 + i, true)
    setSubcells(m, 7 * 27 + 8, 0b1)
    for (const e of [1e-7, -1e-7, 0]) {
      for (const rect of [
        { x: 10 + e, z: 20 + e, w: 25, d: 15 },
        { x: 10, z: 20, w: 25 + e, d: 15 + e },
      ]) {
        const r = backdropCellRange(rect, grid)!
        const hostCells: number[] = []
        for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) if (i >= 1 && i <= 7 && j >= 3 && j <= 7) hostCells.push(j * 27 + i)
        expect([...exploredCellsInRect(m, 5, rect)].sort((a, b) => a - b)).toEqual(hostCells)
        expect(hostCells).toHaveLength(5 * 3)
      }
    }
  })

  it("maps a cell to its source pixels", () => {
    const rect = { x: 0, z: 0, w: 135, d: 235 }
    // 3780×6580 px image = 140 px per 5 ft cell.
    expect(tileSourceRect(rect, { width: 3780, height: 6580 }, 5, { i: 2, j: 3 })).toEqual({ sx: 280, sy: 420, sw: 140, sh: 140 })
    // A backdrop placed at an offset: cell (0, 0) starts before the image.
    const off = { x: 2.5, z: 0, w: 135, d: 235 }
    expect(tileSourceRect(off, { width: 3780, height: 6580 }, 5, { i: 0, j: 0 }).sx).toBe(-70)
  })
})

describe("Supabase tile source", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Storage whose downloads are tagged with the path and cache nonce they were asked for. */
  function fakeStorage() {
    const downloads: string[] = []
    const client = {
      storage: {
        from: (bucket: string) => ({
          download: async (path: string, opts: { cacheNonce: string }) => {
            const tag = `${bucket}/${path}#${opts.cacheNonce}`
            downloads.push(tag)
            return { data: new Blob([tag]), error: null }
          },
        }),
      },
    } as unknown as AtlasClient
    return { client, downloads }
  }

  /** Decoding keeps the downloaded tag; a crop keeps its chunk's. */
  function stubBitmaps() {
    vi.stubGlobal("createImageBitmap", async (src: Blob | { tag: string }) => {
      const tag = src instanceof Blob ? await src.text() : src.tag
      return { tag, width: 40, height: 40, close() {} }
    })
  }
  const tagOf = (b: ImageBitmap | null) => (b as unknown as { tag: string } | null)?.tag ?? null

  it("keys chunks by the announced (mask, rev): another map's chunk is downloaded again, never served from the cache", async () => {
    stubBitmaps()
    const { client, downloads } = fakeStorage()
    const tiles = createSupabaseTileSource(client, "s", "u")
    const cell = { i: 1, j: 2 }
    const mask = 1 << (2 * 4 + 1)
    tiles.setChunks!("lvl", [[0, 0, mask, 7]], true)
    const first = "session-tiles/s/u/lvl/0_0.webp#512.7"
    expect(tagOf(await tiles.getTile("lvl", cell))).toBe(first)
    expect(tagOf(await tiles.getTile("lvl", cell))).toBe(first)
    expect(downloads).toEqual([first])

    // The DM moves the game to a duplicate of this map (same level id, the same cells explored): the host
    // resets the level, then announces the new map's chunk under a rev salted with the document.
    tiles.setChunks!("lvl", [], true)
    expect(await tiles.getTile("lvl", cell)).toBeNull()
    tiles.setChunks!("lvl", [[0, 0, mask, 8]], false)
    const second = "session-tiles/s/u/lvl/0_0.webp#512.8"
    expect(tagOf(await tiles.getTile("lvl", cell))).toBe(second)
    expect(downloads).toEqual([first, second])
    tiles.dispose()
  })
})

describe("local tile source", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Canvases that remember what was drawn on them: a tile says which image it was cut from, and where. */
  function stubCanvases() {
    class FakeCanvas {
      drawn = ""
      width: number
      height: number
      constructor(width: number, height: number) {
        this.width = width
        this.height = height
      }
      getContext() {
        return {
          imageSmoothingQuality: "low",
          clearRect: () => {},
          drawImage: (image: { tag: string }, sx: number, sy: number) => {
            this.drawn = `${image.tag}@${sx},${sy}`
          },
        }
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeCanvas)
    vi.stubGlobal("createImageBitmap", async (src: Blob | FakeCanvas) => ({
      tag: src instanceof Blob ? await src.text() : src.drawn,
      width: 400,
      height: 400,
      close() {},
    }))
  }
  const tagOf = (b: ImageBitmap | null) => (b as unknown as { tag: string } | null)?.tag ?? null

  it("cuts tiles from the stored scene of the map the view shows, never from another map's", async () => {
    stubCanvases()
    const store = createMemoryStore()
    const images = createLocalAssetStore(store)
    // A 400 px backdrop over 40 ft: 50 px per 5 ft cell.
    const keep = createScene({ name: "Keep", width: 8, depth: 8 })
    const level = Object.keys(keep.levels)[0]
    const meta = { id: "img", kind: "image" as const, name: "map", mime: "image/webp" as const, width: 400, height: 400 }
    keep.assets = { img: { ...meta, bytes: 4 } }
    keep.levels[level].backdrop = { assetId: "img", rect: { x: 0, z: 0, w: 40, d: 40 }, opacity: 1, tintWalls: false }
    // Its night copy: the same level and asset ids, other pixels, placed a cell further west.
    const night = structuredClone(keep)
    night.id = "night-keep"
    night.levels[level].backdrop!.rect.x = -5
    await images.putImage(keep.id, new Blob(["keep"]), meta)
    await images.putImage(night.id, new Blob(["night"]), meta)
    const save = (state: object) => store.put("sessions", "state:s1", { epoch: 1, state, updatedAt: "" })
    const cell = { i: 1, j: 1 }

    await save({ kind: "seed", scene: keep })
    const tiles = createLocalTileSource(store, "s1")
    tiles.setMap(0)
    expect(tagOf(await tiles.getTile(level, cell))).toBe("keep@50,50")
    // The DM moves the game to the night copy (saved before the view went out): the scene read a moment
    // ago is not used for it.
    await save({ scene: night, mapSerial: 1 })
    tiles.setMap(1)
    expect(tagOf(await tiles.getTile(level, cell))).toBe("night@100,50")
    // Back to the keep with the view ahead of the save: nothing (the compositor retries) until it lands.
    tiles.setMap(2)
    expect(await tiles.getTile(level, cell)).toBeNull()
    await save({ scene: keep, mapSerial: 2 })
    expect(tagOf(await tiles.getTile(level, cell))).toBe("keep@50,50")
    tiles.dispose()
  })
})
