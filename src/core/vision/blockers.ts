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
import type { BlockChannel, OccluderPrimitive, OcclusionWorld, RayHit, SegmentQueryOptions } from "../occlusion/types"
import type { Vec3 } from "../scene/types"

/** Parametric tolerance within which two entry points along one segment count as the same. */
const HIT_TIE = 1e-9

/**
 * The buried-point rule "the ray's FIRST hit is a blocker containing the end point", independent of
 * which primitive the raycast reports on a tie: coplanar faces (walls sharing a face, a sill flush with
 * another wall) are entered at the same t, and the reported one depends on grid registration order,
 * i.e. on edit history. True when `hit` is one of `keys` (blockers containing `to`), or when one of
 * them (not ignored) is entered no later than `hit`.
 */
export function hitEntersContaining(
  world: OcclusionWorld,
  from: Vec3,
  to: Vec3,
  hit: RayHit,
  keys: ReadonlySet<string>,
  channel: BlockChannel,
  ignore?: ReadonlySet<string>
): boolean {
  if (keys.has(hit.primitive.key)) return true
  for (const p of world.containing(to, channel)) {
    if (!keys.has(p.key) || ignore?.has(p.sourceId)) continue
    const t = segmentEntry(p, from, to)
    if (t !== null && t <= hit.t + HIT_TIE) return true
  }
  return false
}

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
