import { describe, expect, it, vi } from "vitest"

import { createScene } from "@/core/scene/factory"
import { backdropCellRange, playerBackdrop } from "@/core/session/backdrop"
import type { Id, Scene } from "@/core/scene/types"
import { createCellMask, encodeMask, setCell, setSubcells } from "@/core/vision/mask"
import type { EncodedMask } from "@/core/vision/types"

import type { ChunkEntry } from "../assets/chunks"
import type { AssetStore } from "../assets/types"
import { BackdropTiler, chunkRev, subcellClipRects, tileCrop, type ChunkPart, type TileCodec, type TileImage } from "./tiles"

const GRID = { cellSize: 5, width: 27, depth: 47 }

describe("sub-cell clips", () => {
  it("covers set sub-cells with one rect per run, merging identical runs of consecutive rows", () => {
    expect(subcellClipRects(0b1, 0, 0, 40)).toEqual([{ x: 0, y: 0, w: 10, h: 10 }])
    // Row 0: sub-cells 0-1; row 1: 0-1 (merged); row 3: sub-cell 3.
    const mask = 0b11 | (0b11 << 4) | (0b1000 << 12)
    expect(subcellClipRects(mask, 100, 200, 40)).toEqual([
      { x: 100, y: 200, w: 20, h: 20 },
      { x: 130, y: 230, w: 10, h: 10 },
    ])
    // Two runs in one row.
    expect(subcellClipRects(0b1001, 0, 0, 40)).toEqual([
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 30, y: 0, w: 10, h: 10 },
    ])
    // Non-integer sub-cell size: rounded on absolute coordinates, so neighbours abut exactly.
    const odd = subcellClipRects(0xffff & ~0b10, 10, 0, 10)
    const xs = odd.flatMap((r) => [r.x, r.x + r.w])
    expect(xs.every(Number.isInteger)).toBe(true)
    expect(subcellClipRects(0xffff, 10, 0, 10)).toEqual([{ x: 10, y: 0, w: 10, h: 10 }])
    expect(subcellClipRects(0, 0, 0, 40)).toEqual([])
  })

  it("chunk revs are non-zero and change with any sub-cell", () => {
    const a = new Array(16).fill(0)
    const b = [...a]
    b[5] = 0b1
    const c = [...a]
    c[5] = 0b11
    expect(chunkRev(a)).toBeGreaterThan(0)
    expect(new Set([chunkRev(a), chunkRev(b), chunkRev(c)]).size).toBe(3)
    expect(chunkRev(b)).toBe(chunkRev([...b]))
    expect(Number.isInteger(chunkRev(c)) && chunkRev(c) < 2 ** 32).toBe(true)
  })
})

describe("tile geometry", () => {
  it("cell ranges cover cells overlapping the rect with positive area", () => {
    expect(backdropCellRange({ x: 0, z: 0, w: 135, d: 235 }, GRID)).toEqual({ i0: 0, j0: 0, i1: 26, j1: 46 })
    expect(backdropCellRange({ x: 2.5, z: 5, w: 10, d: 5 }, GRID)).toEqual({ i0: 0, j0: 1, i1: 2, j1: 1 })
    // Clamped to the grid.
    expect(backdropCellRange({ x: -50, z: -50, w: 1000, d: 1000 }, GRID)).toEqual({ i0: 0, j0: 0, i1: 26, j1: 46 })
    expect(backdropCellRange({ x: 200, z: 0, w: 10, d: 10 }, GRID)).toBeNull()
    expect(backdropCellRange({ x: 0, z: 0, w: 0, d: 10 }, GRID)).toBeNull()
  })

  it("cuts tiles at the tile size the filter announces (playerBackdrop), and none where it announces no backdrop", () => {
    const { scene, levelId } = backdropScene()
    const { store } = fakeAssets("supabase")
    const { t } = tiler(store, fakeCodec().codec)
    for (const width of [3780, 1890, 1_000_000]) {
      scene.assets!.map1.width = width
      t.setScene(scene)
      const announced = playerBackdrop(scene, levelId)!.tilePx
      // Forgotten Adventures maps: 140 px per cell; 70 at half size; capped at 1024.
      expect(announced).toBe(width === 3780 ? 140 : width === 1890 ? 70 : 1024)
      expect(t.backdrops([levelId])?.[levelId].tilePx).toBe(announced)
    }
    // A tiny image (less than half a pixel per cell): no backdrop for players, so nothing to cut.
    scene.assets!.map1.width = 10
    expect(playerBackdrop(scene, levelId)).toBeNull()
    t.setScene(scene)
    expect(t.backdrops([levelId])).toBeUndefined()
    expect(t.publishing).toBe(false)
    t.dispose()
  })

  it("crops the image under a cell, placing partial cells inside the tile", () => {
    const rect = { x: 0, z: 0, w: 135, d: 235 }
    expect(tileCrop(rect, 3780, 6580, 5, { i: 0, j: 0 }, 140)).toEqual({ sx: 0, sy: 0, sw: 140, sh: 140, dx: 0, dy: 0, dw: 140, dh: 140 })
    expect(tileCrop(rect, 3780, 6580, 5, { i: 3, j: 2 }, 140)).toEqual({ sx: 420, sy: 280, sw: 140, sh: 140, dx: 0, dy: 0, dw: 140, dh: 140 })
    // Image offset by half a cell: the first cell gets the image in its right/bottom half.
    const off = { x: 2.5, z: 2.5, w: 10, d: 10 }
    const c = tileCrop(off, 200, 200, 5, { i: 0, j: 0 }, 100)!
    expect(c).toEqual({ sx: 0, sy: 0, sw: 50, sh: 50, dx: 50, dy: 50, dw: 50, dh: 50 })
    expect(tileCrop(off, 200, 200, 5, { i: 5, j: 5 }, 100)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Tiler (per-player chunks)
// ---------------------------------------------------------------------------

interface Upload {
  uid: string
  levelId: Id
  ci: number
  cj: number
  parts: number
}

function fakeAssets(mode: "supabase" | "local", opts: { fail?: (u: Upload) => unknown } = {}) {
  const uploads: Upload[] = []
  const deletes: string[] = []
  const store: AssetStore = {
    mode,
    putImage: async () => {
      throw new Error("unused")
    },
    getImage: async (sceneId) => (sceneId === "scene-1" ? new Blob(["img"]) : null),
    deleteImage: async () => {},
    copyImages: async () => {},
    putTileChunk: async (_sid, uid, levelId, ci, cj, blob) => {
      const u = { uid, levelId, ci, cj, parts: Number(await blob.text()) }
      const err = opts.fail?.(u)
      if (err) throw err
      uploads.push(u)
    },
    deleteTileChunks: async (_sid, uid, levelId, chunks) => {
      for (const c of chunks) deletes.push(`${uid}:${levelId}:${c.ci},${c.cj}`)
    },
    removeSessionTiles: async () => 0,
    deleteSceneImages: async () => 0,
    sweepUnreferencedImages: async () => ({ removed: 0, bytes: 0 }),
  }
  return { store, uploads, deletes }
}

function fakeCodec() {
  const chunks: Array<{ size: number; parts: ChunkPart[] }> = []
  const codec: TileCodec = {
    decode: async () => ({ width: 270, height: 470 }),
    encodeChunk: async (_img: TileImage, parts, size) => {
      chunks.push({ size, parts: [...parts] })
      return new Blob([String(parts.length)])
    },
    release: () => {},
  }
  return { codec, chunks }
}

function backdropScene(): { scene: Scene; levelId: Id } {
  const scene = createScene({ width: 27, depth: 47 })
  const levelId = Object.keys(scene.levels)[0]
  scene.assets = { map1: { id: "map1", kind: "image", name: "Map", mime: "image/webp", width: 270, height: 470, bytes: 1000 } }
  scene.levels[levelId].backdrop = { assetId: "map1", rect: { x: 0, z: 0, w: 135, d: 235 }, opacity: 1, tintWalls: false }
  return { scene, levelId }
}

function explored(levelId: Id, cells: Array<[number, number]>, partial: Array<[number, number] | [number, number, number]> = []): Record<Id, EncodedMask> {
  const m = createCellMask(27, 47)
  for (const [i, j] of cells) setCell(m, j * 27 + i, true)
  for (const [i, j, sub] of partial) setSubcells(m, j * 27 + i, sub ?? 0b1)
  return { [levelId]: encodeMask(m) }
}

function tiler(assets: AssetStore, codec: TileCodec | null, extra: Partial<ConstructorParameters<typeof BackdropTiler>[0]> = {}) {
  const notices: Array<{ uid: string; levelId: Id; entries: ChunkEntry[]; reset: boolean }> = []
  let now = 0
  const t = new BackdropTiler({
    assets,
    sessionId: "sess",
    codec,
    assetSceneIds: () => ["other", "scene-1"],
    onChunks: (uid, levelId, entries, reset) => notices.push({ uid, levelId, entries, reset }),
    now: () => now,
    ...extra,
  })
  return { t, notices, advance: (ms: number) => (now += ms) }
}

const bit = (i: number, j: number) => 1 << ((j % 4) * 4 + (i % 4))

describe("BackdropTiler", () => {
  it("uploads each player's explored cells in 4×4-cell chunks and announces them", async () => {
    const { scene, levelId } = backdropScene()
    const { store, uploads, deletes } = fakeAssets("supabase")
    const { codec, chunks } = fakeCodec()
    const { t, notices } = tiler(store, codec)
    t.setScene(scene)
    expect(t.publishing).toBe(true)
    expect(t.backdrops([levelId])).toEqual({ [levelId]: { rect: { x: 0, z: 0, w: 135, d: 235 }, opacity: 1, tintWalls: false, tilePx: 10 } })
    // Cells (0,0), (1,0) share chunk (0,0); (5,0) is chunk (1,0); partly explored (4,5) → chunk (1,1).
    await t.sync("p1", explored(levelId, [[0, 0], [1, 0], [5, 0]], [[4, 5]]))
    expect(uploads.map((u) => `${u.uid}:${u.ci},${u.cj}:${u.parts}`).sort()).toEqual(["p1:0,0:2", "p1:1,0:1", "p1:1,1:1"])
    expect(chunks[0].size).toBe(40)
    const withoutRev = (e: ChunkEntry) => e.slice(0, 3)
    expect(notices.flatMap((n) => n.entries).map(withoutRev).sort()).toEqual([[0, 0, bit(0, 0) | bit(1, 0)], [1, 0, bit(5, 0)], [1, 1, bit(4, 5)]].sort())
    // Every uploaded chunk is announced with its content rev.
    expect(notices.flatMap((n) => n.entries).every((e) => e.length === 4 && e[3] > 0)).toBe(true)
    // The partly explored cell (4, 5) — sub-cell (0, 0) only — is clipped to that sub-cell: 10 px per
    // cell, so 2.5 px per sub-cell (edges rounded on absolute coordinates). Full cells are not clipped.
    const partialChunk = chunks.find((c) => c.parts.some((p) => p.clip))!
    expect(partialChunk.parts).toHaveLength(1)
    expect(partialChunk.parts[0]).toMatchObject({ ox: 0, oy: 10, clip: [{ x: 0, y: 10, w: 3, h: 3 }] })
    expect(chunks.filter((c) => c !== partialChunk).every((c) => c.parts.every((p) => p.clip === undefined))).toBe(true)
    // The same explored mask again: nothing to do.
    const before = uploads.length
    const same = explored(levelId, [[0, 0]])
    await t.sync("p1", same)
    const n = uploads.length
    await t.sync("p1", same)
    expect(uploads.length).toBe(n)
    // Chunk (0,0) is re-cut with one cell; (1,0) and (1,1) are deleted and announced with mask 0.
    expect(n).toBe(before + 1)
    expect(deletes.sort()).toEqual([`p1:${levelId}:1,0`, `p1:${levelId}:1,1`])
    expect(notices.slice(-3).flatMap((x) => x.entries).map(withoutRev).sort()).toEqual([[0, 0, bit(0, 0)], [1, 0, 0], [1, 1, 0]].sort())
    // Removals carry no rev.
    expect(notices.slice(-3).flatMap((x) => x.entries).filter((e) => e[2] === 0).every((e) => e.length === 3)).toBe(true)
    const full = new Array(16).fill(0)
    full[0] = 0xffff
    expect(t.table("p1")).toEqual([{ levelId, entries: [[0, 0, bit(0, 0), chunkRev(full)]] }])
    // Another player gets their own chunks.
    await t.sync("p2", explored(levelId, [[0, 0]]))
    expect(uploads.filter((u) => u.uid === "p2")).toHaveLength(1)
    t.dispose()
  })

  it("deletes chunks a fog reset emptied", async () => {
    const { scene, levelId } = backdropScene()
    const { store, deletes } = fakeAssets("supabase")
    const { t, notices } = tiler(store, fakeCodec().codec)
    t.setScene(scene)
    await t.sync("p1", explored(levelId, [[9, 9]]))
    await t.sync("p1", explored(levelId, []))
    expect(deletes).toEqual([`p1:${levelId}:2,2`])
    expect(notices.at(-1)?.entries).toEqual([[2, 2, 0]])
    expect(t.table("p1")).toEqual([{ levelId, entries: [] }])
  })

  it("re-cuts a chunk under a new rev when a partly explored cell grows or shrinks", async () => {
    const { scene, levelId } = backdropScene()
    const { store, uploads } = fakeAssets("supabase")
    const { codec, chunks } = fakeCodec()
    const { t, notices } = tiler(store, codec)
    t.setScene(scene)
    await t.sync("p1", explored(levelId, [], [[4, 5, 0b1]]))
    expect(uploads).toHaveLength(1)
    const rev1 = notices.at(-1)!.entries[0][3]
    // Grows by the sub-cell to its right: re-uploaded with a larger clip and a new rev.
    await t.sync("p1", explored(levelId, [], [[4, 5, 0b11]]))
    expect(uploads).toHaveLength(2)
    expect(chunks.at(-1)!.parts[0].clip).toEqual([{ x: 0, y: 10, w: 5, h: 3 }])
    const e2 = notices.at(-1)!.entries[0]
    expect(e2.slice(0, 3)).toEqual([1, 1, bit(4, 5)])
    expect(e2[3]).not.toBe(rev1)
    // Becomes fully explored: no clip.
    await t.sync("p1", explored(levelId, [[4, 5]]))
    expect(uploads).toHaveLength(3)
    expect(chunks.at(-1)!.parts[0].clip).toBeUndefined()
    // Shrinks back to a partial cell (fog reset): re-uploaded too.
    await t.sync("p1", explored(levelId, [], [[4, 5, 0b1000]]))
    expect(uploads).toHaveLength(4)
    expect(chunks.at(-1)!.parts[0].clip).toEqual([{ x: 8, y: 10, w: 2, h: 3 }])
    // The same content again (a new mask object): nothing to do.
    await t.sync("p1", explored(levelId, [], [[4, 5, 0b1000]]))
    expect(uploads).toHaveLength(4)
  })

  it("uploads nearest the player's tokens first, a few at a time", async () => {
    const { scene, levelId } = backdropScene()
    const order: string[] = []
    let inflight = 0
    let peak = 0
    const { store } = fakeAssets("supabase", {
      fail: (u) => {
        order.push(`${u.ci},${u.cj}`)
        return null
      },
    })
    const slow: AssetStore = {
      ...store,
      putTileChunk: async (...args) => {
        inflight++
        peak = Math.max(peak, inflight)
        await new Promise((r) => setTimeout(r, 1))
        inflight--
        return store.putTileChunk(...args)
      },
    }
    const { t } = tiler(slow, fakeCodec().codec, { concurrency: 2 })
    t.setScene(scene)
    const cells: Array<[number, number]> = []
    for (let j = 0; j < 47; j += 4) for (let i = 0; i < 27; i += 4) cells.push([i, j])
    // Token near the bottom-right corner (cell 25, 45).
    await t.sync("p1", explored(levelId, cells), [{ x: 127.5, z: 227.5 }])
    expect(peak).toBe(2)
    expect(order[0]).toBe("6,11")
    expect(order.at(-1)).toBe("0,0")
  })

  it("backs off when rate limited and retries, without holding the caller", async () => {
    vi.useFakeTimers()
    try {
      const { scene, levelId } = backdropScene()
      let limited = 2
      const { store, uploads } = fakeAssets("supabase", {
        fail: () => (limited-- > 0 ? Object.assign(new Error("Too Many Requests"), { status: 429 }) : null),
      })
      const { t } = tiler(store, fakeCodec().codec, { now: () => Date.now(), retryMs: 100 })
      t.setScene(scene)
      // The wait resolves after the failed attempt (the caller never waits on the retry schedule).
      await t.sync("p1", explored(levelId, [[0, 0]]))
      expect(uploads).toHaveLength(0)
      expect(t.stats.rateLimited).toBe(1)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(uploads).toHaveLength(1)
      expect(t.stats.rateLimited).toBe(2)
      t.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it("a changed backdrop starts every player over; a missing image yields no tiles; local mode is inactive", async () => {
    const { scene, levelId } = backdropScene()
    const { store, uploads } = fakeAssets("supabase")
    const { t, notices } = tiler(store, fakeCodec().codec)
    t.setScene(scene)
    await t.sync("p1", explored(levelId, [[0, 0]]))
    const moved = structuredClone(scene)
    moved.levels[levelId].backdrop!.rect = { x: 5, z: 0, w: 130, d: 235 }
    t.setScene(moved)
    expect(notices.at(-1)).toEqual({ uid: "p1", levelId, entries: [], reset: true })
    await t.sync("p1", explored(levelId, [[0, 0], [1, 0]]))
    // The image now starts at x = 5: only cell (1, 0) overlaps it.
    expect(uploads.at(-1)).toMatchObject({ ci: 0, cj: 0, parts: 1 })
    // An image that cannot be loaded: nothing is uploaded and the backdrop is not offered.
    const missing = tiler(store, fakeCodec().codec, { assetSceneIds: () => ["nope"] })
    missing.t.setScene(scene)
    await missing.t.sync("p1", explored(levelId, [[0, 0]]))
    expect(missing.t.backdrops([levelId])).toBeUndefined()
    // Local mode: players crop by themselves.
    const local = tiler(fakeAssets("local").store, fakeCodec().codec)
    local.t.setScene(scene)
    expect(local.t.publishing).toBe(false)
    expect(local.t.backdrops([levelId])).toBeDefined()
  })

  it("releases decoded images after they sit idle and decodes again on demand", async () => {
    vi.useFakeTimers()
    try {
      const { scene, levelId } = backdropScene()
      const { store } = fakeAssets("supabase")
      let decodes = 0
      let releases = 0
      const codec: TileCodec = {
        decode: async () => {
          decodes++
          return { width: 270, height: 470 }
        },
        encodeChunk: async () => new Blob(["1"]),
        release: () => {
          releases++
        },
      }
      const { t } = tiler(store, codec, { now: () => Date.now(), imageIdleMs: 1000 })
      t.setScene(scene)
      await t.sync("p1", explored(levelId, [[0, 0]]))
      await t.sync("p1", explored(levelId, [[0, 0], [9, 9]]))
      expect(decodes).toBe(1)
      await vi.advanceTimersByTimeAsync(2500)
      expect(releases).toBe(1)
      await t.sync("p1", explored(levelId, [[0, 0], [9, 9], [20, 20]]))
      expect(decodes).toBe(2)
      t.dispose()
      await vi.advanceTimersByTimeAsync(0)
      expect(releases).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
