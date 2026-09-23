import { describe, expect, it } from "vitest"

import type { PlayerView } from "@/core/session/types"
import { createCellMask, encodeMask, setCell, setSubcells } from "@/core/vision/mask"

import {
  BackdropCompositor,
  backdropLayout,
  cellPixelRect,
  exploredCellsInRect,
  type BackdropCanvas,
  type BackdropEvent,
  type CompositorClock,
} from "./backdropCanvas"

/** Deterministic timers: advance() runs due callbacks in time order. */
class ManualClock implements CompositorClock {
  private t = 0
  private seq = 0
  private readonly timers = new Map<number, { at: number; fn: () => void }>()
  now = () => this.t
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq
    this.timers.set(id, { at: this.t + ms, fn })
    return id
  }
  clearTimeout = (h: unknown) => {
    this.timers.delete(h as number)
  }
  async advance(ms: number): Promise<void> {
    const end = this.t + ms
    for (;;) {
      await flush()
      const due = [...this.timers.entries()].filter(([, v]) => v.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])
      if (due.length === 0) break
      const [id, { at, fn }] = due[0]
      this.timers.delete(id)
      this.t = at
      fn()
    }
    this.t = end
    await flush()
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

interface Op {
  op: "clear" | "draw"
  x: number
  y: number
  w: number
  h: number
  tile?: string
}

function recordingCanvas() {
  const made: Array<{ canvas: BackdropCanvas; ops: Op[] }> = []
  const create = (width: number, height: number): BackdropCanvas => {
    const ops: Op[] = []
    const ctx = {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      clearRect: (x: number, y: number, w: number, h: number) => ops.push({ op: "clear", x, y, w, h }),
      drawImage: (img: { tag: string }, x: number, y: number, w: number, h: number) => ops.push({ op: "draw", x, y, w, h, tile: img.tag }),
    }
    const canvas = { width, height, getContext: () => ctx } as unknown as BackdropCanvas
    made.push({ canvas, ops })
    return canvas
  }
  return { made, create }
}

type Answer = "tile" | "null" | "throw"

/** Tile source whose answers are scripted per cell (default: a tile). */
function scriptedTiles() {
  const calls: string[] = []
  const answers = new Map<string, Answer[]>()
  const closed: string[] = []
  let gate: Promise<void> | null = null
  let active = 0
  let maxActive = 0
  const source = {
    async getTile(levelId: string, cell: { i: number; j: number }) {
      const key = `${levelId}:${cell.i},${cell.j}`
      calls.push(key)
      active++
      maxActive = Math.max(maxActive, active)
      try {
        if (gate) await gate
        const a = answers.get(key)?.shift() ?? "tile"
        if (a === "throw") throw new Error("network")
        if (a === "null") return null
        return { tag: key, width: 140, height: 140, close: () => closed.push(key) } as unknown as ImageBitmap
      } finally {
        active--
      }
    },
    dispose() {},
  }
  return {
    source,
    calls,
    closed,
    answers,
    maxActive: () => maxActive,
    hold() {
      let release!: () => void
      gate = new Promise((r) => (release = r))
      return () => {
        gate = null
        release()
      }
    },
  }
}

const L = "lvl"

function view(opts: { w?: number; d?: number; cells: Array<[number, number]>; partial?: Array<[number, number, number]>; rect?: { x: number; z: number; w: number; d: number }; tilePx?: number; token?: { x: number; z: number }; backdrop?: boolean }): PlayerView {
  const w = opts.w ?? 4
  const d = opts.d ?? 3
  const mask = createCellMask(w, d)
  for (const [i, j] of opts.cells) setCell(mask, j * w + i)
  for (const [i, j, sub] of opts.partial ?? []) setSubcells(mask, j * w + i, sub)
  const explored = encodeMask(mask)
  const tokens = opts.token ? { t1: { id: "t1", levelId: L, position: opts.token, size: "medium", height: 6, color: "#ffffff", imageUrl: null, label: null } } : {}
  return {
    viewVersion: 1,
    sessionId: "s",
    userId: "u",
    scene: { name: "x", grid: { cellSize: 5, width: w, depth: d, diagonalRule: "5-5-5" }, environment: {}, levels: {} },
    objects: {},
    tokens,
    terrain: {},
    masks: { [L]: { perception: explored, explored, sunlit: explored } },
    backdrops: opts.backdrop === false ? {} : { [L]: { rect: opts.rect ?? { x: 0, z: 0, w: w * 5, d: d * 5 }, opacity: 1, tintWalls: false, tilePx: opts.tilePx ?? 140 } },
    controlledTokenIds: opts.token ? ["t1"] : [],
    visionTokenIds: [],
    flags: { movementLocked: false, sharedVision: false, enforceSpeed: false },
  } as unknown as PlayerView
}

function setup(extra: Partial<ConstructorParameters<typeof BackdropCompositor>[0]> = {}) {
  const clock = new ManualClock()
  const canvases = recordingCanvas()
  const tiles = scriptedTiles()
  const events: BackdropEvent[] = []
  const comp = new BackdropCompositor({
    tiles: tiles.source,
    onEvent: (ev) => events.push(ev),
    createCanvas: canvases.create,
    clock,
    flushMs: 50,
    busyFlushMs: 150,
    retryDelaysMs: [100, 200],
    ...extra,
  })
  return { clock, canvases, tiles, events, comp }
}

describe("backdrop layout", () => {
  it("sizes the canvas at tilePx per cell (Forgotten Adventures 27×47 → 3780×6580)", () => {
    expect(backdropLayout({ x: 0, z: 0, w: 135, d: 235 }, 5, 140)).toEqual({ width: 3780, height: 6580, pxPerCell: 140 })
  })

  it("scales down to the side and pixel budgets", () => {
    const side = backdropLayout({ x: 0, z: 0, w: 135, d: 235 }, 5, 140, 4096)
    expect(side.height).toBe(4096)
    expect(side.pxPerCell).toBeCloseTo(140 * (4096 / 6580), 6)
    const pixels = backdropLayout({ x: 0, z: 0, w: 135, d: 235 }, 5, 140, 8192, 4_000_000)
    expect(pixels.width * pixels.height).toBeLessThanOrEqual(4_000_000 * 1.001)
  })

  it("maps cells to abutting pixel rects, also for offset rects", () => {
    const rect = { x: 2.5, z: 0, w: 20, d: 10 }
    const a = cellPixelRect(0, 0, 5, rect, 400, 200)
    const b = cellPixelRect(1, 0, 5, rect, 400, 200)
    expect(a).toEqual({ x: -50, y: 0, w: 100, h: 100 })
    expect(b.x).toBe(a.x + a.w)
  })

  it("lists touched explored cells overlapping the rect with positive area", () => {
    const m = createCellMask(4, 3)
    setCell(m, 0)
    setCell(m, 3)
    setSubcells(m, 1 * 4 + 1, 0b1)
    expect([...exploredCellsInRect(m, 5, { x: 0, z: 0, w: 20, d: 15 })].sort((a, b) => a - b)).toEqual([0, 3, 5])
    // A rect ending exactly on a cell edge does not include the next cell.
    expect([...exploredCellsInRect(m, 5, { x: 0, z: 0, w: 15, d: 15 })].sort((a, b) => a - b)).toEqual([0, 5])
    expect(exploredCellsInRect(m, 5, { x: 0, z: 0, w: 0, d: 15 }).size).toBe(0)
  })
})

describe("BackdropCompositor", () => {
  it("draws explored tiles, announces once with content, then only updates new cells", async () => {
    const { clock, canvases, tiles, events, comp } = setup()
    comp.sync(view({ cells: [[0, 0], [1, 0]] }))
    expect(canvases.made).toHaveLength(1)
    expect([canvases.made[0].canvas.width, canvases.made[0].canvas.height]).toEqual([560, 420])
    await clock.advance(60)
    expect(tiles.calls.sort()).toEqual(["lvl:0,0", "lvl:1,0"])
    expect(canvases.made[0].ops.filter((o) => o.op === "draw")).toEqual([
      { op: "draw", x: 0, y: 0, w: 140, h: 140, tile: "lvl:0,0" },
      { op: "draw", x: 140, y: 0, w: 140, h: 140, tile: "lvl:1,0" },
    ])
    expect(tiles.closed.sort()).toEqual(["lvl:0,0", "lvl:1,0"])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: "set", levelId: L, dirty: { x: 0, z: 0, w: 10, d: 5 } })

    // Exploration grows by one cell: one fetch, one update with that cell's rect.
    const grown = view({ cells: [[0, 0], [1, 0], [2, 2]] })
    comp.sync(grown)
    await clock.advance(60)
    expect(tiles.calls).toHaveLength(3)
    expect(events[1]).toMatchObject({ kind: "update", dirty: { x: 10, z: 10, w: 5, d: 5 } })
    expect(comp.layer(L)?.stats).toEqual({ wanted: 3, drawn: 3, pending: 0, missing: 0 })

    // The same explored mask object again (e.g. a patch that only moved a token): nothing to do.
    const opsBefore = canvases.made[0].ops.length
    comp.sync({ ...grown, tokens: {} })
    await clock.advance(60)
    expect(tiles.calls).toHaveLength(3)
    expect(canvases.made[0].ops).toHaveLength(opsBefore)
    expect(events).toHaveLength(2)
  })

  it("batches updates harder while a burst of tiles is still arriving", async () => {
    const { clock, tiles, events, comp } = setup({ concurrency: 1 })
    comp.sync(view({ cells: [[0, 0]] }))
    await clock.advance(60)
    expect(events.map((e) => e.kind)).toEqual(["set"])
    // Three more cells, fetched one at a time: one update once the burst is through (150 ms window).
    comp.sync(view({ cells: [[0, 0], [1, 0], [2, 0], [3, 0]] }))
    await clock.advance(100)
    expect(tiles.calls).toHaveLength(4)
    expect(events).toHaveLength(1)
    await clock.advance(60)
    expect(events).toHaveLength(2)
    expect(events[1]).toMatchObject({ kind: "update", dirty: { x: 5, z: 0, w: 15, d: 5 } })
  })

  it("does not announce an empty canvas", async () => {
    const { clock, tiles, events, comp } = setup()
    tiles.answers.set("lvl:0,0", ["null", "null", "null"])
    comp.sync(view({ cells: [[0, 0]] }))
    await clock.advance(1000)
    expect(events).toEqual([])
    expect(comp.layer(L)).toMatchObject({ announced: false, stats: { wanted: 1, drawn: 0, missing: 1 } })
  })

  it("retries missing tiles with backoff, gives up, and retries again on demand or new exploration", async () => {
    const { clock, tiles, comp } = setup()
    tiles.answers.set("lvl:0,0", ["null", "throw", "null", "null", "tile"])
    comp.sync(view({ cells: [[0, 0]] }))
    await clock.advance(0)
    expect(tiles.calls).toEqual(["lvl:0,0"])
    await clock.advance(99)
    expect(tiles.calls).toHaveLength(1)
    await clock.advance(1)
    expect(tiles.calls).toHaveLength(2) // after 100 ms (throws)
    await clock.advance(200)
    expect(tiles.calls).toHaveLength(3) // after 200 ms more (null) → out of retries
    await clock.advance(5000)
    expect(tiles.calls).toHaveLength(3)
    expect(comp.layer(L)?.stats.missing).toBe(1)

    comp.retryMissing()
    await clock.advance(0)
    expect(tiles.calls).toHaveLength(4) // null again
    expect(comp.layer(L)?.stats.pending).toBe(1)
    await clock.advance(100)
    expect(tiles.calls).toHaveLength(5)
    expect(comp.layer(L)?.stats).toMatchObject({ drawn: 1, missing: 0, pending: 0 })

    // A give-up is also retried when exploration grows.
    tiles.answers.set("lvl:1,0", ["null", "null", "null"])
    comp.sync(view({ cells: [[0, 0], [1, 0]] }))
    await clock.advance(1000)
    expect(comp.layer(L)?.stats.missing).toBe(1)
    comp.sync(view({ cells: [[0, 0], [1, 0], [2, 0]] }))
    await clock.advance(0)
    expect(tiles.calls.filter((c) => c === "lvl:1,0")).toHaveLength(4)
  })

  it("clears cells that are no longer explored (fog reset)", async () => {
    const { clock, canvases, events, comp } = setup()
    comp.sync(view({ cells: [[0, 0], [1, 0]] }))
    await clock.advance(60)
    comp.sync(view({ cells: [[0, 0]] }))
    await clock.advance(60)
    expect(canvases.made[0].ops.at(-1)).toEqual({ op: "clear", x: 140, y: 0, w: 140, h: 140 })
    expect(events.at(-1)).toMatchObject({ kind: "update", dirty: { x: 5, z: 0, w: 5, d: 5 } })
    expect(comp.layer(L)?.stats).toMatchObject({ wanted: 1, drawn: 1 })
  })

  it("drops a tile that arrives after its cell stopped being explored", async () => {
    const { clock, canvases, tiles, comp } = setup()
    const release = tiles.hold()
    comp.sync(view({ cells: [[0, 0]] }))
    await clock.advance(0)
    comp.sync(view({ cells: [] }))
    release()
    await clock.advance(60)
    expect(canvases.made[0].ops.filter((o) => o.op === "draw")).toEqual([])
    expect(tiles.closed).toEqual(["lvl:0,0"])
  })

  it("recreates the canvas when the placement changes and removes it with the backdrop", async () => {
    const { clock, canvases, events, comp } = setup()
    comp.sync(view({ cells: [[0, 0]] }))
    await clock.advance(60)
    comp.sync(view({ cells: [[0, 0]], tilePx: 70 }))
    expect(events.at(-1)).toEqual({ kind: "remove", levelId: L })
    expect(canvases.made[0].canvas.width).toBe(0) // released
    await clock.advance(60)
    expect(canvases.made).toHaveLength(2)
    expect([canvases.made[1].canvas.width, canvases.made[1].canvas.height]).toEqual([280, 210])
    expect(events.at(-1)).toMatchObject({ kind: "set", layer: { pxPerCell: 70 } })
    comp.sync(view({ cells: [[0, 0]], backdrop: false }))
    expect(events.at(-1)).toEqual({ kind: "remove", levelId: L })
    expect(comp.layers()).toEqual([])
  })

  it("fetches nearest-first around the player's token, within the concurrency limit", async () => {
    const { clock, tiles, comp } = setup({ concurrency: 2 })
    const all: Array<[number, number]> = []
    for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) all.push([i, j])
    const release = tiles.hold()
    comp.sync(view({ cells: all, token: { x: 17.5, z: 12.5 } }))
    await clock.advance(0)
    // Equal distances break ties by cell index: (3,1) before (2,2).
    expect(tiles.calls).toEqual(["lvl:3,2", "lvl:3,1"])
    release()
    await clock.advance(60)
    expect(tiles.calls).toHaveLength(12)
    expect(tiles.maxActive()).toBeLessThanOrEqual(2)
    expect(tiles.calls.at(-1)).toBe("lvl:0,0")
  })

  it("includes partly explored cells and clips dirty rects to an offset backdrop rect", async () => {
    const { clock, canvases, events, comp } = setup()
    comp.sync(view({ cells: [], partial: [[1, 1, 0b1]], rect: { x: 2.5, z: 2.5, w: 15, d: 10 } }))
    await clock.advance(60)
    // Canvas: 15×10 ft at 28 px/ft = 420×280; cell (1,1) spans x 5..10 → px 70..210.
    expect(canvases.made[0].ops.filter((o) => o.op === "draw")).toEqual([{ op: "draw", x: 70, y: 70, w: 140, h: 140, tile: "lvl:1,1" }])
    expect(events[0]).toMatchObject({ kind: "set", dirty: { x: 5, z: 5, w: 5, d: 5 } })
  })

  it("stops everything on dispose", async () => {
    const { clock, tiles, events, comp } = setup()
    const release = tiles.hold()
    comp.sync(view({ cells: [[0, 0]] }))
    await clock.advance(0)
    comp.dispose()
    release()
    await clock.advance(500)
    expect(events).toEqual([])
    expect(tiles.closed).toEqual(["lvl:0,0"])
  })
})
