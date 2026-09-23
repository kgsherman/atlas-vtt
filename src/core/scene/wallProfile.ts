/**
 * Walls on terrain (docs/ARCHITECTURE.md §2 "Walls on terrain"): the base line of a wall along its
 * length and the heights of its openings. Shared by the render builders, core/occlusion, the tool
 * previews and the session filter, so what is drawn is what blocks and players see the host's tops.
 *
 *  - Follow-terrain walls: base(u) = ground on the centreline at u ∈ [0, len] (u = feet from a along
 *    a→b), flat beyond the ends (joint extensions: identical corner tops at shared nodes). The ground is
 *    piecewise linear along the centreline between the points where it crosses the lattice lines
 *    x = i·s, z = j·s and the triangle diagonals (see ./heightmap), so sampling it there is exact.
 *  - Other walls (followTerrain false, or no heightmap): base = the level elevation everywhere.
 *  - The top is base + wall.height; the bottom is flat, just below the lowest ground (and base) under
 *    the joint-extended footprint, so no light leaks under a wall.
 *
 * Ground outside the lattice (x < 0 or z < 0) is the elevation, so a wall crossing the lattice's low
 * edge ramps over the knot interval just outside it instead of stepping (known limit); the knot on the
 * edge itself always samples the lattice.
 */
import { openingSegment, type Opening } from "./queries"
import type { Vec2, WallObject } from "./types"

/** Wall bottoms extend this far below the minimum ground along their footprint (feet). */
export const WALL_BOTTOM_MARGIN = 0.05
/** Profile knots and wall pieces thinner than this (feet) are dropped. */
export const MIN_EXTENT = 1e-6
/** Knots whose base lies within this (feet) of the line through their neighbours are dropped. */
const COLLINEAR_TOLERANCE = 1e-9
/** Pieces whose top varies by at most this (feet) have a constant top (they become boxes). */
const CONSTANT_TOP_TOLERANCE = 1e-9

/**
 * World-space ground of a level with a heightmap (render's GroundSampler and core/occlusion's
 * TerrainSampler both satisfy it): `heightAt` is world Y, `spacing` the feet between lattice samples.
 */
export interface GroundLike {
  readonly spacing: number
  heightAt(x: number, z: number): number
  /** Exact world-Y range of the ground over a convex polygon. */
  rangeOverPolygon(poly: readonly Vec2[]): { min: number; max: number }
}

export interface WallProfile {
  /** The base follows the ground (wall.followTerrain on a level with a heightmap). */
  follow: boolean
  len: number
  /** Unit direction a→b. */
  dir: Vec2
  /**
   * u of the profile knots from −ext.a to len + ext.b (ends within MIN_EXTENT of 0 / len: 0 / len), strictly
   * increasing (≥ MIN_EXTENT apart). Follow walls always have knots at 0 and len.
   */
  knots: number[]
  /** World Y of the base line at each knot; linear in between, flat beyond the ends. */
  base: number[]
  /** World Y of the flat bottom of every full-height piece. */
  bottomY: number
  baseAt(u: number): number
  /** baseAt(u) + wall.height. */
  topAt(u: number): number
  /** Min / max of the top over [u0, u1]. */
  minTop(u0: number, u1: number): number
  maxTop(u0: number, u1: number): number
  /** The top is constant over [u0, u1] (a piece there is a box; its top is maxTop). */
  topConstant(u0: number, u1: number): boolean
}

/** Heights of an opening on its host wall (world Y), see openingFrame. */
export interface OpeningFrame {
  /** Span along the wall (feet from a), clamped to [0, len]. */
  u0: number
  u1: number
  /** Opening base b_o: the wall's base at the centre of the span. */
  base: number
  /** Door head / window head (top of the hole). */
  head: number
  /** Windows: top of the sill (bottom of the hole when hasSill); 0 for doors. */
  sillTop: number
  /** A sill piece [bottomY, sillTop] stands under the window. */
  hasSill: boolean
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

// ---------------------------------------------------------------------------
// Knots
// ---------------------------------------------------------------------------

/**
 * Distances along a→b in the open interval (u0, u1) where the segment crosses a lattice line of
 * spacing `spacing`: x = i·s, z = j·s or the triangle diagonal x/s − z/s = k (the (sx, sz)→(sx+1, sz+1)
 * split of ./heightmap). Families parallel to the segment are skipped; crossings within
 * 1e-9·max(1, |b − a|) of each other or of u0 / u1 are merged; ascending. Only crossings inside the
 * lattice quadrant (x ≥ 0 and z ≥ 0) are returned: outside it the ground is flat.
 */
export function lineLatticeKnots(a: Vec2, b: Vec2, spacing: number, u0: number, u1: number): number[] {
  const len = Math.hypot(b.x - a.x, b.z - a.z)
  if (!(len > 0) || !(spacing > 0) || !(u1 > u0)) return []
  const dx = (b.x - a.x) / len
  const dz = (b.z - a.z) / len
  const tol = 1e-9 * Math.max(1, len)
  // Part of [u0, u1] inside the quadrant x ≥ 0, z ≥ 0.
  let lo = u0
  let hi = u1
  for (const [p, d] of [
    [a.x, dx],
    [a.z, dz],
  ]) {
    if (d > 0) lo = Math.max(lo, -p / d)
    else if (d < 0) hi = Math.min(hi, -p / d)
    else if (p < 0) return []
  }
  if (lo > hi + tol) return []
  const out: number[] = []
  // Crossings of f(u) = f0 + df·u (lattice units) with the integers.
  const family = (f0: number, df: number) => {
    if (df === 0) return
    const fa = f0 + df * lo
    const fb = f0 + df * hi
    const k0 = Math.ceil(Math.min(fa, fb) - 1e-9)
    const k1 = Math.floor(Math.max(fa, fb) + 1e-9)
    for (let k = k0; k <= k1; k++) {
      const u = (k - f0) / df
      if (u > u0 + tol && u < u1 - tol && u >= lo - tol && u <= hi + tol) out.push(u)
    }
  }
  family(a.x / spacing, dx / spacing)
  family(a.z / spacing, dz / spacing)
  family((a.x - a.z) / spacing, (dx - dz) / spacing)
  out.sort((p, q) => p - q)
  const res: number[] = []
  for (const u of out) if (res.length === 0 || u - res[res.length - 1] > tol) res.push(u)
  return res
}

/**
 * u of the knots where a follow-terrain wall samples its base: 0, the lattice crossings, len.
 * Deterministic from the wall's geometry and the lattice spacing, so the host can send its base line at
 * these knots (PlayerWall.terrainProfile) and the client knows where they are.
 */
export function wallBaseKnots(wall: Pick<WallObject, "a" | "b">, spacing: number): number[] {
  const len = Math.hypot(wall.b.x - wall.a.x, wall.b.z - wall.a.z)
  return [0, ...lineLatticeKnots(wall.a, wall.b, spacing, 0, len), len]
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/** Index i of the knot interval [k[i], k[i+1]] containing u (the first / last one outside the knots). */
function intervalOf(k: readonly number[], u: number): number {
  let lo = 0
  let hi = k.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (k[mid] <= u) lo = mid
    else hi = mid - 1
  }
  return lo
}

class Profile implements WallProfile {
  readonly follow: boolean
  readonly len: number
  readonly dir: Vec2
  readonly knots: number[]
  readonly base: number[]
  readonly bottomY: number
  private readonly height: number

  constructor(follow: boolean, len: number, dir: Vec2, knots: number[], base: number[], bottomY: number, height: number) {
    this.follow = follow
    this.len = len
    this.dir = dir
    this.knots = knots
    this.base = base
    this.bottomY = bottomY
    this.height = height
  }

  baseAt(u: number): number {
    const k = this.knots
    const b = this.base
    const n = k.length
    if (!(u > k[0])) return b[0]
    if (u >= k[n - 1]) return b[n - 1]
    const i = intervalOf(k, u)
    return b[i] + ((u - k[i]) / (k[i + 1] - k[i])) * (b[i + 1] - b[i])
  }

  topAt(u: number): number {
    return this.baseAt(u) + this.height
  }

  /** Extreme base over [u0, u1]: the ends and the knots strictly inside. */
  private baseExtreme(u0: number, u1: number, max: boolean): number {
    if (u1 < u0) [u0, u1] = [u1, u0]
    let v = this.baseAt(u0)
    const e = this.baseAt(u1)
    if (max ? e > v : e < v) v = e
    const k = this.knots
    for (let i = intervalOf(k, u0) + 1; i < k.length && k[i] < u1; i++) {
      if (k[i] <= u0) continue
      const b = this.base[i]
      if (max ? b > v : b < v) v = b
    }
    return v
  }

  minTop(u0: number, u1: number): number {
    return this.baseExtreme(u0, u1, false) + this.height
  }

  maxTop(u0: number, u1: number): number {
    return this.baseExtreme(u0, u1, true) + this.height
  }

  topConstant(u0: number, u1: number): boolean {
    return this.baseExtreme(u0, u1, true) - this.baseExtreme(u0, u1, false) <= CONSTANT_TOP_TOLERANCE
  }
}

/** Corners of the wall's joint-extended footprint (thickness/2 past both ends). */
function footprint(wall: Pick<WallObject, "a" | "b" | "thickness">, len: number, dir: Vec2): Vec2[] {
  const mx = (wall.a.x + wall.b.x) / 2
  const mz = (wall.a.z + wall.b.z) / 2
  const hx = len / 2 + wall.thickness / 2
  const hz = wall.thickness / 2
  const nx = -dir.z
  const nz = dir.x
  return [
    { x: mx - dir.x * hx - nx * hz, z: mz - dir.z * hx - nz * hz },
    { x: mx + dir.x * hx - nx * hz, z: mz + dir.z * hx - nz * hz },
    { x: mx + dir.x * hx + nx * hz, z: mz + dir.z * hx + nz * hz },
    { x: mx - dir.x * hx + nx * hz, z: mz - dir.z * hx + nz * hz },
  ]
}

/**
 * Base line, top and bottom of a wall. `ground` is the level's ground (null: the level has no
 * heightmap), `elevation` the level's elevation, `ext` the joint extensions past a and b (feet ≥ 0).
 * A follow-terrain wall with a `terrainProfile` of wallBaseKnots' length (player clients) uses those
 * values as its base at those knots instead of sampling `ground`.
 */
export function wallProfile(
  wall: Pick<WallObject, "a" | "b" | "height" | "thickness" | "followTerrain" | "terrainProfile">,
  ground: GroundLike | null,
  elevation: number,
  ext: { a: number; b: number }
): WallProfile {
  const len = Math.hypot(wall.b.x - wall.a.x, wall.b.z - wall.a.z)
  const dir = len > 0 ? { x: (wall.b.x - wall.a.x) / len, z: (wall.b.z - wall.a.z) / len } : { x: 1, z: 0 }
  // Joint extensions thinner than MIN_EXTENT get no knot (the base is flat past the ends anyway).
  const extA = ext.a >= MIN_EXTENT ? ext.a : 0
  const extB = ext.b >= MIN_EXTENT ? ext.b : 0
  const groundMin = ground ? ground.rangeOverPolygon(footprint(wall, len, dir)).min : elevation
  if (!wall.followTerrain || !ground) {
    const knots = [extA > 0 ? -extA : 0, len + extB]
    return new Profile(false, len, dir, knots, [elevation, elevation], Math.min(elevation, groundMin) - WALL_BOTTOM_MARGIN, wall.height)
  }

  // Base at the base knots: sampled, or the host's (player clients).
  const baseKnots = wallBaseKnots(wall, ground.spacing)
  const n = baseKnots.length
  const tp = wall.terrainProfile
  let values: number[]
  if (tp && tp.length === n && tp.every(Number.isFinite)) values = tp.slice()
  else {
    // Lattice knots lie in the quadrant up to lineLatticeKnots' tolerance: one on the low edge (x = 0 or
    // z = 0) can round to just below it, where the ground reads the elevation. Snap it onto the edge.
    const edgeTol = 1e-9 * Math.max(1, len)
    const onLattice = (v: number) => (v < 0 && v > -edgeTol ? 0 : v)
    values = baseKnots.map((u, k) =>
      k === 0
        ? ground.heightAt(wall.a.x, wall.a.z)
        : k === n - 1
          ? ground.heightAt(wall.b.x, wall.b.z)
          : ground.heightAt(onLattice(wall.a.x + dir.x * u), onLattice(wall.a.z + dir.z * u))
    )
  }

  // Knots on [0, len] at least MIN_EXTENT apart: a lattice knot too close to the previous kept knot or
  // to len is dropped.
  const ks: number[] = [0]
  const bs: number[] = [values[0]]
  for (let k = 1; k < n - 1; k++) {
    if (baseKnots[k] - ks[ks.length - 1] < MIN_EXTENT || len - baseKnots[k] < MIN_EXTENT) continue
    ks.push(baseKnots[k])
    bs.push(values[k])
  }
  ks.push(len)
  bs.push(values[n - 1])

  // Drop lattice knots collinear with their ORIGINAL neighbours (the function is unchanged). 0 and len
  // always stay, so the profile over [0, len] (openings, bottom) does not depend on the joint extensions,
  // which are flat.
  const knots: number[] = []
  const base: number[] = []
  if (extA > 0) {
    knots.push(-extA)
    base.push(bs[0])
  }
  knots.push(0)
  base.push(bs[0])
  for (let k = 1; k + 1 < ks.length; k++) {
    const t = (ks[k] - ks[k - 1]) / (ks[k + 1] - ks[k - 1])
    if (Math.abs(bs[k - 1] + t * (bs[k + 1] - bs[k - 1]) - bs[k]) <= COLLINEAR_TOLERANCE) continue
    knots.push(ks[k])
    base.push(bs[k])
  }
  knots.push(len)
  base.push(bs[bs.length - 1])
  if (extB > 0) {
    knots.push(len + extB)
    base.push(bs[bs.length - 1])
  }

  let minBase = Infinity
  for (const b of base) if (b < minBase) minBase = b
  return new Profile(true, len, dir, knots, base, Math.min(groundMin, minBase) - WALL_BOTTOM_MARGIN, wall.height)
}

/**
 * Knots (u) of a wall piece over [u0, u1]: u0, the profile knots strictly inside, u1. Interior knots
 * within MIN_EXTENT of an end are dropped, so the result is strictly increasing.
 */
export function pieceKnots(profile: WallProfile, u0: number, u1: number): number[] {
  const out = [u0]
  const k = profile.knots
  for (let i = intervalOf(k, u0); i < k.length; i++) {
    const u = k[i]
    if (u >= u1 - MIN_EXTENT) break
    if (u > u0 + MIN_EXTENT) out.push(u)
  }
  out.push(u1)
  return out
}

// ---------------------------------------------------------------------------
// Openings
// ---------------------------------------------------------------------------

/** Span [u0, u1] of an opening along its host wall (feet from a), clamped to the wall (like openingSegment). */
export function openingSpan(
  profile: Pick<WallProfile, "len" | "dir">,
  wall: Pick<WallObject, "a" | "b">,
  o: Pick<Opening, "offset" | "width">
): [number, number] {
  const seg = openingSegment(wall, o)
  const u0 = (seg.a.x - wall.a.x) * profile.dir.x + (seg.a.z - wall.a.z) * profile.dir.z
  const u1 = (seg.b.x - wall.a.x) * profile.dir.x + (seg.b.z - wall.a.z) * profile.dir.z
  return [Math.max(0, Math.min(u0, u1)), Math.min(profile.len, Math.max(u0, u1))]
}

/**
 * Heights of a door or window on its host wall, or null when its clamped span is thinner than
 * MIN_EXTENT. With H = wall.height, b_o = baseAt(centre of the span) and the minimum top over the span
 * (so lintels are never inverted and doors / sills stay flat boxes):
 *  - door: head = max(bottomY, min(b_o + clamp(h, 0, H), minTop));
 *  - window: sillTop = min(b_o + clamp(sill, 0, H), minTop), head = max(sillTop, min(b_o + clamp(sill + h, 0, H), minTop));
 *    a raw sill > 0 has a sill piece [bottomY, sillTop] unless that is thinner than MIN_EXTENT.
 */
export function openingFrame(profile: WallProfile, wall: Pick<WallObject, "a" | "b" | "height">, o: Opening): OpeningFrame | null {
  const [u0, u1] = openingSpan(profile, wall, o)
  if (u1 - u0 < MIN_EXTENT) return null
  const H = wall.height
  const base = profile.baseAt((u0 + u1) / 2)
  const minTop = profile.minTop(u0, u1)
  if (o.type === "door") {
    const head = Math.max(profile.bottomY, Math.min(base + clamp(o.height, 0, H), minTop))
    return { u0, u1, base, head, sillTop: 0, hasSill: false }
  }
  const sillTop = Math.min(base + clamp(o.sillHeight, 0, H), minTop)
  const head = Math.max(sillTop, Math.min(base + clamp(o.sillHeight + o.height, 0, H), minTop))
  return { u0, u1, base, head, sillTop, hasSill: o.sillHeight > 0 && sillTop - profile.bottomY >= MIN_EXTENT }
}
