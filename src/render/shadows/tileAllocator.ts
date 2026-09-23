/**
 * Fixed pool of square tiles in an atlas with least-recently-used eviction (ARCHITECTURE §4.2).
 * Owners are string keys ("light:<id>", "viewer:<id>"). A tile stays cached after its owner leaves the
 * frame's list, so a light that scrolls back on screen is drawn immediately; it is only evicted when a
 * new owner needs a slot. Tiles used in the current frame are never evicted.
 */

export interface AtlasTile<T> {
  /** Slot index in the pool. */
  readonly index: number
  /** Atlas texel of the tile's lower-left corner (guard ring included). */
  readonly x: number
  readonly y: number
  /** Texels per side (guard ring included). */
  readonly size: number
  owner: string | null
  lastUsed: number
  /** Per-owner capture state (null until the owner's first capture). */
  state: T | null
}

export class TileAllocator<T> {
  readonly width: number
  readonly height: number
  readonly tileSize: number
  readonly columns: number
  readonly rows: number
  private readonly tiles: AtlasTile<T>[] = []
  private readonly byOwner = new Map<string, AtlasTile<T>>()

  constructor(width: number, height: number, tileSize: number) {
    this.width = width
    this.height = height
    this.tileSize = tileSize
    this.columns = Math.floor(width / tileSize)
    this.rows = Math.floor(height / tileSize)
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.columns; c++) {
        this.tiles.push({ index: this.tiles.length, x: c * tileSize, y: r * tileSize, size: tileSize, owner: null, lastUsed: -Infinity, state: null })
      }
    }
  }

  get capacity(): number {
    return this.tiles.length
  }

  get(owner: string): AtlasTile<T> | undefined {
    return this.byOwner.get(owner)
  }

  /** Mark an owner's tile as used this frame (protects it from eviction). */
  touch(owner: string, frame: number): AtlasTile<T> | undefined {
    const t = this.byOwner.get(owner)
    if (t) t.lastUsed = frame
    return t
  }

  /**
   * The owner's tile, allocating one if needed: a free slot first, otherwise the least recently used
   * slot not used in `frame`. Returns undefined when every slot is in use this frame. A newly assigned
   * tile has `state === null` (never captured).
   */
  acquire(owner: string, frame: number): AtlasTile<T> | undefined {
    const existing = this.byOwner.get(owner)
    if (existing) {
      existing.lastUsed = frame
      return existing
    }
    let victim: AtlasTile<T> | undefined
    for (const t of this.tiles) {
      if (t.owner === null) {
        victim = t
        break
      }
      if (t.lastUsed >= frame) continue
      if (!victim || t.lastUsed < victim.lastUsed) victim = t
    }
    if (!victim) return undefined
    if (victim.owner !== null) this.byOwner.delete(victim.owner)
    victim.owner = owner
    victim.lastUsed = frame
    victim.state = null
    this.byOwner.set(owner, victim)
    return victim
  }

  release(owner: string): void {
    const t = this.byOwner.get(owner)
    if (!t) return
    this.byOwner.delete(owner)
    t.owner = null
    t.state = null
    t.lastUsed = -Infinity
  }

  /** Drop every assignment (e.g. context restored or atlas re-created). */
  clear(): void {
    this.byOwner.clear()
    for (const t of this.tiles) {
      t.owner = null
      t.state = null
      t.lastUsed = -Infinity
    }
  }

  /** Tiles that currently have an owner. */
  owned(): AtlasTile<T>[] {
    return [...this.byOwner.values()]
  }
}
