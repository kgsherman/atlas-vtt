/**
 * Backdrop tiles (ARCHITECTURE §9 "Players never receive a whole image"). Per player and level, the
 * host keeps that player's explored cells of the battlemap in Storage as chunks of TILE_CHUNK × TILE_CHUNK
 * cells (net/assets/chunks.ts: `{sessionId}/{userId}/{levelId}/{ci}_{cj}.webp`, readable only by that
 * player and the DM). After every knowledge update (`sync`), chunks whose explored cells changed are
 * re-drawn (only explored cells, tilePx per cell — the stored px per cell) and uploaded in the
 * background, nearest to the player's tokens first, a few at a time, backing off when Storage
 * rate-limits. Each finished upload is announced to the player (`onChunks` → `{t: "tiles"}`) so their
 * client fetches it; hostRunner waits briefly for a player's uploads before sending the view that reveals
 * the cells, but never blocks the game on them.
 *
 * Local mode: the player's tile source crops from the locally stored asset itself (dev only), so the
 * tiler is inactive.
 *
 * Image placement: the image's top-left pixel is at the rect's min corner (x, z); image +x → world +x,
 * image +y (down) → world +z.
 */
import { decodeMaskCached } from "@/core/session/masks"
import type { PlayerBackdrop } from "@/core/session/types"
import type { Cell, GridSettings, Id, Rect, Scene, Vec2 } from "@/core/scene/types"
import { cellTouched } from "@/core/vision/mask"
import type { EncodedMask } from "@/core/vision/types"

import { chunkFromKey, chunkKey, TILE_CHUNK, type ChunkEntry } from "../assets/chunks"
import type { AssetStore } from "../assets/types"

// ---------------------------------------------------------------------------
// Geometry (pure)
// ---------------------------------------------------------------------------

/** Inclusive cell range. */
export interface CellRange {
  i0: number
  j0: number
  i1: number
  j1: number
}

const EPS = 1e-6

/** Grid cells overlapping the rect with positive area, clamped to the grid. */
export function backdropCellRange(rect: Rect, grid: Pick<GridSettings, "cellSize" | "width" | "depth">): CellRange | null {
  if (!(rect.w > 0) || !(rect.d > 0)) return null
  const s = grid.cellSize
  const i0 = Math.max(0, Math.floor(rect.x / s + EPS))
  const j0 = Math.max(0, Math.floor(rect.z / s + EPS))
  const i1 = Math.min(grid.width - 1, Math.ceil((rect.x + rect.w) / s - EPS) - 1)
  const j1 = Math.min(grid.depth - 1, Math.ceil((rect.z + rect.d) / s - EPS) - 1)
  return i1 < i0 || j1 < j0 ? null : { i0, j0, i1, j1 }
}

/** Stored pixels per grid cell of an image stretched over `rect` (the tile edge length). */
export function tilePxFor(rect: Rect, imageWidth: number, cellSize: number): number {
  const px = Math.round((imageWidth * cellSize) / rect.w)
  return Math.max(1, Math.min(1024, Number.isFinite(px) ? px : 1))
}

/** Source rect in image pixels and destination rect in tile pixels for one cell's tile. */
export interface TileCrop {
  sx: number
  sy: number
  sw: number
  sh: number
  dx: number
  dy: number
  dw: number
  dh: number
}

/** The part of the image under a cell (null when the cell does not overlap the image). */
export function tileCrop(rect: Rect, imageWidth: number, imageHeight: number, cellSize: number, cell: Cell, tilePx: number): TileCrop | null {
  const s = cellSize
  const x0 = cell.i * s
  const z0 = cell.j * s
  const ix0 = Math.max(x0, rect.x)
  const ix1 = Math.min(x0 + s, rect.x + rect.w)
  const iz0 = Math.max(z0, rect.z)
  const iz1 = Math.min(z0 + s, rect.z + rect.d)
  if (ix1 - ix0 <= EPS || iz1 - iz0 <= EPS) return null
  const kx = imageWidth / rect.w
  const kz = imageHeight / rect.d
  const kt = tilePx / s
  return {
    sx: (ix0 - rect.x) * kx,
    sy: (iz0 - rect.z) * kz,
    sw: (ix1 - ix0) * kx,
    sh: (iz1 - iz0) * kz,
    dx: (ix0 - x0) * kt,
    dy: (iz0 - z0) * kt,
    dw: (ix1 - ix0) * kt,
    dh: (iz1 - iz0) * kt,
  }
}

// ---------------------------------------------------------------------------
// Codec (browser: createImageBitmap + OffscreenCanvas; injectable for tests)
// ---------------------------------------------------------------------------

export interface TileImage {
  readonly width: number
  readonly height: number
}

/** One cell of a chunk: its crop of the image, drawn at (ox, oy) in the chunk. */
export interface ChunkPart {
  crop: TileCrop
  ox: number
  oy: number
}

export interface TileCodec {
  decode(blob: Blob): Promise<TileImage>
  /** A transparent `sizePx`² image with each part's crop drawn at its offset, encoded (WebP). */
  encodeChunk(image: TileImage, parts: readonly ChunkPart[], sizePx: number): Promise<Blob>
  release(image: TileImage): void
}

/** Largest chunk image side (the bucket caps objects at 2 MB): tiles above 256 px are downscaled. */
export const MAX_CHUNK_PX = TILE_CHUNK * 256

/** Canvas codec, or null where OffscreenCanvas / createImageBitmap are unavailable (Node). */
export function createCanvasTileCodec(opts: { quality?: number; canvases?: number } = {}): TileCodec | null {
  if (typeof OffscreenCanvas !== "function" || typeof createImageBitmap !== "function") return null
  const quality = opts.quality ?? 0.85
  const free: OffscreenCanvas[] = []
  const max = opts.canvases ?? 4
  let created = 0
  const waiters: Array<(c: OffscreenCanvas) => void> = []
  const acquire = (): Promise<OffscreenCanvas> => {
    const c = free.pop()
    if (c) return Promise.resolve(c)
    if (created < max) {
      created++
      return Promise.resolve(new OffscreenCanvas(1, 1))
    }
    return new Promise((resolve) => waiters.push(resolve))
  }
  const release = (c: OffscreenCanvas) => {
    const w = waiters.shift()
    if (w) w(c)
    else free.push(c)
  }
  return {
    decode: (blob) => createImageBitmap(blob),
    async encodeChunk(image, parts, sizePx) {
      const canvas = await acquire()
      try {
        if (canvas.width !== sizePx || canvas.height !== sizePx) {
          canvas.width = sizePx
          canvas.height = sizePx
        }
        const ctx = canvas.getContext("2d")
        if (!ctx) throw new Error("2d context unavailable")
        ctx.clearRect(0, 0, sizePx, sizePx)
        ctx.imageSmoothingEnabled = true
        ctx.imageSmoothingQuality = "high"
        for (const { crop, ox, oy } of parts) {
          ctx.drawImage(image as ImageBitmap, crop.sx, crop.sy, crop.sw, crop.sh, ox + crop.dx, oy + crop.dy, crop.dw, crop.dh)
        }
        return await canvas.convertToBlob({ type: "image/webp", quality })
      } finally {
        release(canvas)
      }
    },
    release: (image) => (image as ImageBitmap).close?.(),
  }
}

// ---------------------------------------------------------------------------
// Tiler
// ---------------------------------------------------------------------------

interface LevelSpec {
  levelId: Id
  assetId: Id
  rect: Rect
  imageWidth: number
  imageHeight: number
  tilePx: number
  range: CellRange
  opacity: number
  tintWalls: boolean
  /** Changes when anything affecting the tile pixels changes. */
  key: string
}

/** One player's chunks on one level. */
interface PlayerLevel {
  /** chunk key → cell mask of the object in Storage. */
  uploaded: Map<number, number>
  /** chunk key → cell mask the object should hold (the explored cells; absent = no object). */
  target: Map<number, number>
  queued: Set<number>
  inflight: Set<number>
  /** The explored mask last synced (encoded masks are immutable: same object = nothing new). */
  explored: EncodedMask | null
}

const behind = (st: PlayerLevel, key: number) => (st.target.get(key) ?? 0) !== (st.uploaded.get(key) ?? 0)

interface Job {
  uid: string
  levelId: Id
  key: number
  /** Not before (ms, `now()`): retries after a failure. */
  at: number
}

export interface TilerTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface BackdropTilerOptions {
  assets: AssetStore
  sessionId: string
  codec: TileCodec | null
  /** Scene ids under which the scene's assets may be stored, tried in order. */
  assetSceneIds: () => string[]
  /**
   * Chunks of a player's level were uploaded (entries carry their cell masks) or removed (mask 0);
   * `reset`: the level's chunks start over (placement changed) and `entries` replace everything.
   */
  onChunks: (uid: string, levelId: Id, entries: ChunkEntry[], reset: boolean) => void
  now?: () => number
  timers?: TilerTimers
  /** Uploads in flight at once. Default 8. */
  concurrency?: number
  /** Delay before retrying a failed upload. Default 3 s (rate limiting: doubling up to 30 s). */
  retryMs?: number
  /**
   * Decoded images unused for this long are released (a 3780×6580 map is ~100 MB) and decoded again
   * on demand (~0.2 s). Default 60 s.
   */
  imageIdleMs?: number
  log?: (msg: string, err?: unknown) => void
}

export interface TilerStats {
  uploaded: number
  removed: number
  failures: number
  rateLimited: number
}

const HTTP_TOO_MANY = 429

function httpStatus(err: unknown): number | null {
  const e = err as { status?: unknown; statusCode?: unknown; cause?: unknown } | null
  if (!e || typeof e !== "object") return null
  if (typeof e.status === "number") return e.status
  if (typeof e.statusCode === "string" && /^\d{3}$/.test(e.statusCode)) return Number(e.statusCode)
  return e.cause ? httpStatus(e.cause) : null
}

export class BackdropTiler {
  private readonly o: BackdropTilerOptions
  private readonly now: () => number
  private readonly timers: TilerTimers
  private levels = new Map<Id, LevelSpec>()
  private grid: GridSettings | null = null
  private readonly players = new Map<string, Map<Id, PlayerLevel>>()
  private readonly images = new Map<Id, { image: Promise<TileImage | null>; users: number; lastUsed: number }>()
  /** Levels whose image could not be loaded: no tiles for them. */
  private readonly unavailable = new Set<Id>()
  private queue: Job[] = []
  private active = 0
  /** Rate limited: no new uploads before this time. */
  private pausedUntil = 0
  private backoffMs = 0
  private wakeTimer: unknown = null
  private sweepTimer: unknown = null
  private readonly waiters = new Map<string, Array<() => void>>()
  private disposed = false
  readonly stats: TilerStats = { uploaded: 0, removed: 0, failures: 0, rateLimited: 0 }

  constructor(opts: BackdropTilerOptions) {
    this.o = opts
    this.now = opts.now ?? (() => Date.now())
    this.timers = opts.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }
  }

  /** Uploading tiles (Supabase + a codec) for at least one backdrop level. */
  get publishing(): boolean {
    return this.o.assets.mode === "supabase" && this.o.codec !== null && this.levels.size > 0
  }

  /** (Re)read backdrop placements. Levels whose image or placement changed start over for everyone. */
  setScene(scene: Scene): void {
    const gridChanged = !this.grid || this.grid.width !== scene.grid.width || this.grid.depth !== scene.grid.depth || this.grid.cellSize !== scene.grid.cellSize
    this.grid = scene.grid
    const next = new Map<Id, LevelSpec>()
    for (const level of Object.values(scene.levels)) {
      const b = level.backdrop
      if (!b) continue
      const asset = scene.assets && Object.hasOwn(scene.assets, b.assetId) ? scene.assets[b.assetId] : undefined
      if (!asset || !(asset.width > 0) || !(asset.height > 0)) continue
      const range = backdropCellRange(b.rect, scene.grid)
      if (!range) continue
      const tilePx = tilePxFor(b.rect, asset.width, scene.grid.cellSize)
      const key = [b.assetId, asset.width, asset.height, b.rect.x, b.rect.z, b.rect.w, b.rect.d, scene.grid.cellSize, scene.grid.width, scene.grid.depth].join("|")
      next.set(level.id, {
        levelId: level.id,
        assetId: b.assetId,
        rect: { x: b.rect.x, z: b.rect.z, w: b.rect.w, d: b.rect.d },
        imageWidth: asset.width,
        imageHeight: asset.height,
        tilePx,
        range,
        opacity: b.opacity,
        tintWalls: b.tintWalls,
        key,
      })
    }
    for (const [id, prev] of this.levels) {
      const spec = next.get(id)
      if (spec && spec.key === prev.key && !gridChanged) continue
      // Placement or image changed (or the level lost its backdrop): every player's chunks start over.
      this.unavailable.delete(id)
      for (const [uid, perLevel] of this.players) {
        if (!perLevel.delete(id)) continue
        this.o.onChunks(uid, id, [], true)
      }
    }
    this.levels = next
    // Release decoded images no level uses any more.
    const used = new Set([...next.values()].map((l) => l.assetId))
    for (const [assetId, entry] of this.images) if (!used.has(assetId) && entry.users === 0) this.releaseImage(assetId)
    this.pump()
  }

  /** PlayerView.backdrops for the player's known levels (undefined when none has a backdrop). */
  backdrops(knownLevelIds: Iterable<Id>): Record<Id, PlayerBackdrop> | undefined {
    let out: Record<Id, PlayerBackdrop> | undefined
    for (const id of knownLevelIds) {
      const s = this.levels.get(id)
      if (!s || this.unavailable.has(id)) continue
      out ??= {}
      out[id] = { rect: { ...s.rect }, opacity: s.opacity, tintWalls: s.tintWalls, tilePx: s.tilePx }
    }
    return out
  }

  /**
   * The player's explored cells changed (or may have): queue uploads of the chunks that now differ,
   * nearest to `focus` (their tokens, world feet) first. Resolves when every upload queued for this
   * player so far has finished (successfully or not) — callers bound the wait.
   */
  sync(uid: string, explored: Readonly<Record<Id, EncodedMask>>, focus: readonly Vec2[] = []): Promise<void> {
    const grid = this.grid
    if (!this.publishing || !grid || this.disposed) return Promise.resolve()
    let perLevel = this.players.get(uid)
    if (!perLevel) this.players.set(uid, (perLevel = new Map()))
    const fresh: Job[] = []
    for (const [levelId, spec] of this.levels) {
      if (this.unavailable.has(levelId)) continue
      const enc = Object.hasOwn(explored, levelId) ? explored[levelId] : undefined
      let st = perLevel.get(levelId)
      if (!st) perLevel.set(levelId, (st = { uploaded: new Map(), target: new Map(), queued: new Set(), inflight: new Set(), explored: null }))
      if (st.explored === (enc ?? null)) continue
      st.explored = enc ?? null
      const desired = new Map<number, number>()
      if (enc && enc.width === grid.width && enc.depth === grid.depth) {
        const mask = decodeMaskCached(enc)
        const { i0, j0, i1, j1 } = spec.range
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            if (!cellTouched(mask, j * grid.width + i)) continue
            const ci = Math.floor(i / TILE_CHUNK)
            const cj = Math.floor(j / TILE_CHUNK)
            const key = chunkKey(ci, cj)
            desired.set(key, (desired.get(key) ?? 0) | (1 << ((j - cj * TILE_CHUNK) * TILE_CHUNK + (i - ci * TILE_CHUNK))))
          }
        }
      }
      st.target = desired
      // Chunks behind their target: new cells, or fewer after a fog reset (shrunk or deleted).
      for (const key of new Set([...desired.keys(), ...st.uploaded.keys()])) {
        if (behind(st, key) && !st.queued.has(key) && !st.inflight.has(key)) {
          st.queued.add(key)
          fresh.push({ uid, levelId, key, at: 0 })
        }
      }
    }
    if (fresh.length > 0) {
      const cs = grid.cellSize * TILE_CHUNK
      const dist = (j: Job) => {
        if (focus.length === 0) return 0
        const { ci, cj } = chunkFromKey(j.key)
        const cx = (ci + 0.5) * cs
        const cz = (cj + 0.5) * cs
        return Math.min(...focus.map((f) => Math.hypot(f.x - cx, f.z - cz)))
      }
      fresh.sort((a, b) => dist(a) - dist(b))
      this.queue.push(...fresh)
      this.pump()
    }
    return this.idle(uid) ? Promise.resolve() : new Promise((resolve) => this.addWaiter(uid, resolve))
  }

  /** Everything uploaded for a player, per level (to announce after a snapshot). */
  table(uid: string): Array<{ levelId: Id; entries: ChunkEntry[] }> {
    const out: Array<{ levelId: Id; entries: ChunkEntry[] }> = []
    for (const [levelId, st] of this.players.get(uid) ?? []) {
      if (!this.levels.has(levelId)) continue
      out.push({ levelId, entries: [...st.uploaded].map(([key, mask]) => { const { ci, cj } = chunkFromKey(key); return [ci, cj, mask] as ChunkEntry }) })
    }
    return out
  }

  forgetPlayer(uid: string): void {
    this.players.delete(uid)
    this.queue = this.queue.filter((j) => j.uid !== uid)
    this.resolveWaiters(uid)
  }

  private idle(uid: string): boolean {
    for (const st of this.players.get(uid)?.values() ?? []) if (st.queued.size > 0 || st.inflight.size > 0) return false
    return true
  }

  private addWaiter(uid: string, fn: () => void): void {
    let list = this.waiters.get(uid)
    if (!list) this.waiters.set(uid, (list = []))
    list.push(fn)
  }

  private resolveWaiters(uid: string): void {
    const list = this.waiters.get(uid)
    if (!list) return
    this.waiters.delete(uid)
    for (const fn of list) fn()
  }

  /** Start queued uploads up to the concurrency limit (respecting rate-limit pauses and retry times). */
  private pump(): void {
    if (this.disposed) return
    const limit = this.o.concurrency ?? 8
    const now = this.now()
    if (now < this.pausedUntil) return this.wakeAt(this.pausedUntil)
    let soonest = Infinity
    for (let k = 0; k < this.queue.length && this.active < limit; ) {
      const job = this.queue[k]
      if (job.at > now) {
        soonest = Math.min(soonest, job.at)
        k++
        continue
      }
      this.queue.splice(k, 1)
      const st = this.players.get(job.uid)?.get(job.levelId)
      if (!st || !this.levels.has(job.levelId)) continue
      st.queued.delete(job.key)
      if (!behind(st, job.key)) {
        if (this.idle(job.uid)) this.resolveWaiters(job.uid)
        continue
      }
      const mask = st.target.get(job.key) ?? 0
      st.inflight.add(job.key)
      this.active++
      void this.run(job, st, mask)
    }
    if (Number.isFinite(soonest)) this.wakeAt(soonest)
  }

  private wakeAt(at: number): void {
    if (this.wakeTimer !== null || this.disposed) return
    this.wakeTimer = this.timers.setTimeout(() => {
      this.wakeTimer = null
      this.pump()
    }, Math.max(0, at - this.now()))
  }

  private async run(job: Job, st: PlayerLevel, mask: number): Promise<void> {
    const { ci, cj } = chunkFromKey(job.key)
    let ok = false
    try {
      if (mask === 0) {
        await this.o.assets.deleteTileChunks(this.o.sessionId, job.uid, job.levelId, [{ ci, cj }])
        this.stats.removed++
      } else {
        const blob = await this.cut(job.levelId, ci, cj, mask)
        if (blob) {
          await this.o.assets.putTileChunk(this.o.sessionId, job.uid, job.levelId, ci, cj, blob)
          this.stats.uploaded++
        }
      }
      ok = true
      this.backoffMs = 0
    } catch (err) {
      this.stats.failures++
      const limited = httpStatus(err) === HTTP_TOO_MANY
      if (limited) {
        this.stats.rateLimited++
        this.backoffMs = Math.min(30_000, Math.max(1000, this.backoffMs * 2))
        this.pausedUntil = this.now() + this.backoffMs
      }
      this.o.log?.(`uploading backdrop chunk ${ci},${cj} of ${job.levelId} failed${limited ? " (rate limited)" : ""}`, err)
    } finally {
      this.active--
      st.inflight.delete(job.key)
    }
    const current = this.players.get(job.uid)?.get(job.levelId)
    if (current === st && !this.disposed) {
      if (ok) {
        if (mask === 0) st.uploaded.delete(job.key)
        else st.uploaded.set(job.key, mask)
        this.o.onChunks(job.uid, job.levelId, [[ci, cj, mask]], false)
      }
      // The target moved on meanwhile, or the upload failed: go again (failures after a delay).
      if (behind(st, job.key) && !st.queued.has(job.key)) {
        st.queued.add(job.key)
        const retry = { ...job, at: ok ? 0 : this.now() + Math.max(this.o.retryMs ?? 3000, this.backoffMs) }
        if (ok) this.queue.unshift(retry)
        else this.queue.push(retry)
      }
      // Failed jobs keep the player "busy" only until their retry is queued: waiters are about the
      // current attempt, so the game never waits on a retry schedule.
      if (!ok || this.idle(job.uid)) this.resolveWaiters(job.uid)
    }
    this.pump()
  }

  /** Draw the chunk's explored cells (null when the level's image is unavailable). */
  private async cut(levelId: Id, ci: number, cj: number, mask: number): Promise<Blob | null> {
    const spec = this.levels.get(levelId)
    const codec = this.o.codec
    const grid = this.grid
    if (!spec || !codec || !grid) return null
    const entry = this.acquireImage(spec.assetId)
    try {
      const image = await entry.image
      if (!image) {
        this.unavailable.add(levelId)
        return null
      }
      const size = Math.min(MAX_CHUNK_PX, TILE_CHUNK * spec.tilePx)
      const px = size / TILE_CHUNK
      const parts: ChunkPart[] = []
      for (let bit = 0; bit < TILE_CHUNK * TILE_CHUNK; bit++) {
        if ((mask & (1 << bit)) === 0) continue
        const u = bit % TILE_CHUNK
        const v = Math.floor(bit / TILE_CHUNK)
        const crop = tileCrop(spec.rect, image.width, image.height, grid.cellSize, { i: ci * TILE_CHUNK + u, j: cj * TILE_CHUNK + v }, px)
        if (crop) parts.push({ crop, ox: u * px, oy: v * px })
      }
      return await codec.encodeChunk(image, parts, size)
    } finally {
      entry.users--
      entry.lastUsed = this.now()
      this.scheduleSweep()
    }
  }

  private acquireImage(assetId: Id): { image: Promise<TileImage | null>; users: number; lastUsed: number } {
    let entry = this.images.get(assetId)
    if (!entry) {
      entry = { image: this.loadImage(assetId), users: 0, lastUsed: this.now() }
      this.images.set(assetId, entry)
    }
    entry.users++
    entry.lastUsed = this.now()
    return entry
  }

  private releaseImage(assetId: Id): void {
    const entry = this.images.get(assetId)
    if (!entry) return
    this.images.delete(assetId)
    void entry.image.then((img) => img && this.o.codec?.release(img)).catch(() => {})
  }

  /** Drop decoded images nobody used for imageIdleMs (a missing image stays remembered as missing). */
  private scheduleSweep(): void {
    if (this.sweepTimer !== null || this.disposed) return
    const idle = this.o.imageIdleMs ?? 60_000
    this.sweepTimer = this.timers.setTimeout(() => {
      this.sweepTimer = null
      const now = this.now()
      let busy = false
      for (const [assetId, entry] of this.images) {
        if (entry.users > 0 || now - entry.lastUsed < idle) busy = true
        else this.releaseImage(assetId)
      }
      if (busy) this.scheduleSweep()
    }, idle)
  }

  private async loadImage(assetId: Id): Promise<TileImage | null> {
    const codec = this.o.codec
    if (!codec) return null
    for (const sceneId of [...new Set(this.o.assetSceneIds())]) {
      try {
        const blob = await this.o.assets.getImage(sceneId, assetId)
        if (blob) return await codec.decode(blob)
      } catch (err) {
        this.o.log?.(`loading backdrop image ${assetId} failed`, err)
      }
    }
    this.o.log?.(`backdrop image ${assetId} not found: players get no tiles for it`)
    return null
  }

  dispose(): void {
    this.disposed = true
    if (this.wakeTimer !== null) this.timers.clearTimeout(this.wakeTimer)
    if (this.sweepTimer !== null) this.timers.clearTimeout(this.sweepTimer)
    this.wakeTimer = null
    this.sweepTimer = null
    for (const assetId of [...this.images.keys()]) this.releaseImage(assetId)
    this.levels.clear()
    this.players.clear()
    this.queue = []
    for (const uid of [...this.waiters.keys()]) this.resolveWaiters(uid)
  }
}
