/**
 * Ray-coherence cache for segment queries. Neighbouring rays (samples of one cell, rows of a light
 * sphere, sun rays under one roof) are usually blocked by the same primitive, so the last blockers
 * are tested first with the exact single-primitive entry test, skipping the grid traversal.
 *
 * Same semantics as OcclusionWorld: segmentEntry() applies the ENTRY rule, and cached primitives
 * come from queries on one channel. The cache is dropped whenever the world version changes, so a
 * removed or replaced primitive (e.g. a door that was opened) can never block.
 */
import { segmentEntry } from "../occlusion/primitives"
import type { BlockChannel, OccluderPrimitive, OcclusionWorld, SegmentQueryOptions } from "../occlusion/types"
import type { Vec3 } from "../scene/types"

export class BlockerCache {
  private a: OccluderPrimitive | null = null
  private b: OccluderPrimitive | null = null
  private version = -1
  private readonly world: OcclusionWorld
  private readonly opts: SegmentQueryOptions

  constructor(world: OcclusionWorld, channel: BlockChannel) {
    this.world = world
    this.opts = { channel }
  }

  private sync(): void {
    if (this.version === this.world.version) return
    this.version = this.world.version
    this.a = null
    this.b = null
  }

  private cachedBlocks(from: Vec3, to: Vec3, ignore: ReadonlySet<string> | undefined): boolean {
    const a = this.a
    const b = this.b
    if (a !== null && !ignore?.has(a.sourceId) && segmentEntry(a, from, to) !== null) return true
    if (b !== null && !ignore?.has(b.sourceId) && segmentEntry(b, from, to) !== null) {
      const t = this.a
      this.a = this.b
      this.b = t
      return true
    }
    return false
  }

  private remember(p: OccluderPrimitive): void {
    // Heightfield entry tests walk their lattice; a failed cache probe would cost as much as the query.
    if (p.shape === "heightfield" || p === this.a) return
    this.b = this.a
    this.a = p
  }

  /** world.segmentBlocked on this cache's channel, with `ignore` source ids. */
  blocked(from: Vec3, to: Vec3, ignore?: ReadonlySet<string>): boolean {
    this.sync()
    if (this.cachedBlocks(from, to, ignore)) return true
    this.opts.ignoreSourceIds = ignore
    const hit = this.world.raycast(from, to, this.opts)
    if (!hit) return false
    this.remember(hit.primitive)
    return true
  }
}
