import { describe, expect, it } from "vitest"

import { TerrainSampler } from "../occlusion/terrain"
import { createDoor, createScene, createWall, createWindow } from "./factory"
import { createHeightmap, sampleCounts, writeHeights } from "./heightmap"
import { levelGround } from "./queries"
import type { Id, Scene, Vec2, WallObject } from "./types"
import {
  lineLatticeKnots,
  MIN_EXTENT,
  openingFrame,
  pieceKnots,
  WALL_BOTTOM_MARGIN,
  wallBaseKnots,
  wallProfile,
  type GroundLike,
  type WallProfile,
} from "./wallProfile"

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sceneWith(f: ((x: number, z: number) => number) | null, resolution: 1 | 2 | 4 = 2, elevation = 0): { scene: Scene; levelId: Id } {
  const scene = createScene({ width: 20, depth: 20 })
  const levelId = Object.keys(scene.levels)[0]
  const level = { ...scene.levels[levelId], elevation }
  if (f) {
    const hm = createHeightmap(resolution)
    const { samplesX, samplesZ } = sampleCounts(scene.grid, resolution)
    const s = scene.grid.cellSize / resolution
    const dense = new Float32Array(samplesX * samplesZ)
    for (let j = 0; j < samplesZ; j++) for (let i = 0; i < samplesX; i++) dense[j * samplesX + i] = f(i * s, j * s)
    level.heightmap = writeHeights(hm, scene.grid, dense)
  }
  scene.levels[levelId] = level
  return { scene, levelId }
}

const groundOf = (scene: Scene, levelId: Id): GroundLike => new TerrainSampler(scene.levels[levelId], scene.grid)

const wall = (a: Vec2, b: Vec2, partial: Partial<WallObject> = {}): WallObject =>
  createWall("L", a, b, { height: 8, thickness: 0.5, followTerrain: true, ...partial })

const pointAt = (w: WallObject, u: number): Vec2 => {
  const len = Math.hypot(w.b.x - w.a.x, w.b.z - w.a.z)
  return { x: w.a.x + ((w.b.x - w.a.x) / len) * u, z: w.a.z + ((w.b.z - w.a.z) / len) * u }
}

/** Every knot lies on a lattice line; consecutive knots are strictly increasing. */
function expectLatticeKnots(a: Vec2, b: Vec2, s: number, knots: number[]) {
  const len = Math.hypot(b.x - a.x, b.z - a.z)
  for (let k = 0; k < knots.length; k++) {
    if (k > 0) expect(knots[k]).toBeGreaterThan(knots[k - 1])
    const x = (a.x + ((b.x - a.x) / len) * knots[k]) / s
    const z = (a.z + ((b.z - a.z) / len) * knots[k]) / s
    const off = Math.min(Math.abs(x - Math.round(x)), Math.abs(z - Math.round(z)), Math.abs(x - z - Math.round(x - z)))
    expect(off).toBeLessThan(1e-9)
    expect(x).toBeGreaterThanOrEqual(-1e-9)
    expect(z).toBeGreaterThanOrEqual(-1e-9)
  }
}

/** Brute force: the knots where the lattice cell / triangle under the centreline changes. */
function bruteKnots(a: Vec2, b: Vec2, s: number): number[] {
  const len = Math.hypot(b.x - a.x, b.z - a.z)
  const n = 20000
  const out: number[] = []
  const tri = (u: number) => {
    const fx = (a.x + ((b.x - a.x) / len) * u) / s
    const fz = (a.z + ((b.z - a.z) / len) * u) / s
    if (fx < 0 || fz < 0) return "out"
    const sx = Math.floor(fx)
    const sz = Math.floor(fz)
    return `${sx},${sz},${fx - sx >= fz - sz ? 0 : 1}`
  }
  let prev = tri(0)
  for (let k = 1; k <= n; k++) {
    const t = tri((len * k) / n)
    if (t !== prev) out.push((len * (k - 0.5)) / n)
    prev = t
  }
  return out
}

describe("lineLatticeKnots", () => {
  it("finds the x, z and diagonal crossings of an off-lattice wall, ascending", () => {
    const a = { x: 1, z: 1.2 }
    const b = { x: 6, z: 3.7 }
    const k = lineLatticeKnots(a, b, 2.5, 0, Math.hypot(5, 2.5))
    expectLatticeKnots(a, b, 2.5, k)
    const brute = bruteKnots(a, b, 2.5)
    expect(k.length).toBe(brute.length)
    for (let i = 0; i < k.length; i++) expect(Math.abs(k[i] - brute[i])).toBeLessThan(0.01)
  })

  it("matches the brute-force triangle changes along random segments", () => {
    const r = rng(4)
    for (let n = 0; n < 60; n++) {
      const s = [1.25, 2.5, 5][n % 3]
      const a = { x: r() * 40, z: r() * 40 }
      const b = { x: a.x + (r() - 0.5) * 30, z: a.z + (r() - 0.5) * 30 }
      const len = Math.hypot(b.x - a.x, b.z - a.z)
      const k = lineLatticeKnots(a, b, s, 0, len)
      expectLatticeKnots(a, b, s, k)
      const brute = bruteKnots(a, b, s).filter((u) => u > 0.01 && u < len - 0.01)
      const inner = k.filter((u) => u > 0.01 && u < len - 0.01)
      // Brute force sees near-coincident crossings as one change.
      expect(inner.length).toBeGreaterThanOrEqual(brute.length)
      for (const u of brute) expect(Math.min(...inner.map((v) => Math.abs(v - u)))).toBeLessThan(len / 20000 + 1e-9)
    }
  })

  it("skips the wall's own family on lattice lines and merges coincident crossings", () => {
    // On z = 10 (a lattice line at s = 2.5): diagonal crossings coincide with the x crossings.
    const k = lineLatticeKnots({ x: 1, z: 10 }, { x: 11, z: 10 }, 2.5, 0, 10)
    expect(k.map((u) => +u.toFixed(9))).toEqual([1.5, 4, 6.5, 9])
    // A 45° wall on a diagonal: x and z crossings meet at lattice vertices, the diagonal family is parallel.
    const d = lineLatticeKnots({ x: 0, z: 5 }, { x: 10, z: 15 }, 2.5, 0, Math.hypot(10, 10))
    expect(d).toHaveLength(3)
    d.forEach((u, i) => expect(u).toBeCloseTo((i + 1) * 2.5 * Math.SQRT2, 9))
    // The other 45° direction crosses the diagonals in the middle of each cell as well.
    const e = lineLatticeKnots({ x: 0, z: 10 }, { x: 10, z: 0 }, 2.5, 0, Math.hypot(10, 10))
    expect(e).toHaveLength(7)
    e.forEach((u, i) => expect(u).toBeCloseTo(((i + 1) * 2.5 * Math.SQRT2) / 2, 9))
  })

  it("excludes crossings at (or within tolerance of) the interval ends", () => {
    expect(lineLatticeKnots({ x: 5, z: 5 }, { x: 10, z: 5 }, 5, 0, 5)).toEqual([])
    expect(lineLatticeKnots({ x: 5, z: 5 }, { x: 10, z: 5 }, 2.5, 0, 5).map((u) => +u.toFixed(9))).toEqual([2.5])
    expect(lineLatticeKnots({ x: 5, z: 5 }, { x: 10, z: 5 }, 2.5, 2.5, 5)).toEqual([])
    expect(lineLatticeKnots({ x: 5, z: 5 }, { x: 10, z: 5 }, 2.5, 2.5 - 1e-10, 5)).toEqual([])
    // Off a lattice line the diagonals cross in between: (5, 1) → (10, 1) meets x − z = 5 at u = 1 and 7.5 at u = 3.5.
    expect(lineLatticeKnots({ x: 5, z: 1 }, { x: 10, z: 1 }, 2.5, 0, 5).map((u) => +u.toFixed(9))).toEqual([1, 2.5, 3.5])
    expect(lineLatticeKnots({ x: 5, z: 1 }, { x: 10, z: 1 }, 2.5, 1, 3.5).map((u) => +u.toFixed(9))).toEqual([2.5])
    expect(lineLatticeKnots({ x: 5, z: 1 }, { x: 5, z: 1 }, 2.5, 0, 5)).toEqual([])
  })

  it("stays inside the lattice quadrant (x ≥ 0, z ≥ 0)", () => {
    const a = { x: -7, z: 5 }
    const b = { x: 8, z: 5 }
    const k = lineLatticeKnots(a, b, 2.5, 0, 15)
    expectLatticeKnots(a, b, 2.5, k)
    expect(k.map((u) => +u.toFixed(9))).toEqual([7, 9.5, 12, 14.5]) // from x = 0 on
    const c = lineLatticeKnots({ x: -7, z: 3 }, { x: 8, z: 3 }, 2.5, 0, 15)
    expect(c[0]).toBeCloseTo(7, 9)
    expect(c[1]).toBeCloseTo(7.5, 9) // the diagonal x − z = −2.5
    expect(lineLatticeKnots({ x: -9, z: 3 }, { x: -1, z: 30 }, 2.5, 0, 30)).toEqual([])
    expect(lineLatticeKnots({ x: 4, z: -3 }, { x: 4, z: -30 }, 2.5, 0, 27)).toEqual([])
  })
})

describe("wallBaseKnots", () => {
  it("is 0, the lattice crossings, len", () => {
    const w = wall({ x: 1, z: 5 }, { x: 9, z: 5 })
    expect(wallBaseKnots(w, 2.5).map((u) => +u.toFixed(9))).toEqual([0, 1.5, 4, 6.5, 8])
    expect(wallBaseKnots(wall({ x: 0, z: 0 }, { x: 5, z: 0 }), 5)).toEqual([0, 5])
  })
})

describe("wallProfile", () => {
  const bumpy = (x: number, z: number) => 3 * Math.sin(x / 7) * Math.cos(z / 5) + 0.02 * x * z

  it("flat levels and follow-off walls: base = elevation, one interval, box-like", () => {
    const flat = wallProfile(wall({ x: 0, z: 0 }, { x: 10, z: 0 }), null, 12, { a: 0.25, b: 0 })
    expect(flat.follow).toBe(false)
    expect(flat.knots).toEqual([-0.25, 10])
    expect(flat.base).toEqual([12, 12])
    expect(flat.bottomY).toBe(12 - WALL_BOTTOM_MARGIN)
    expect(flat.topAt(3)).toBe(20)
    expect(flat.topConstant(-0.25, 10)).toBe(true)

    const { scene, levelId } = sceneWith((x) => x / 5 - 1, 2, 4)
    const w = wall({ x: 10, z: 20 }, { x: 40, z: 20 }, { followTerrain: false })
    const off = wallProfile(w, groundOf(scene, levelId), 4, { a: 0, b: 0 })
    expect(off.follow).toBe(false)
    expect(off.knots).toEqual([0, 30])
    expect(off.base).toEqual([4, 4])
    // Bottom: below both the elevation and the lowest ground (x = 9.75 → 4 + 0.95).
    expect(off.bottomY).toBe(4 - WALL_BOTTOM_MARGIN)
    const dip = sceneWith((x) => -x / 10, 2, 4)
    const offDip = wallProfile(w, groundOf(dip.scene, dip.levelId), 4, { a: 0, b: 0 })
    expect(offDip.bottomY).toBeCloseTo(4 - 4.025 - WALL_BOTTOM_MARGIN, 9)
  })

  it("follow walls: the top is the ground + H at any u (oracle: levelGround)", () => {
    const r = rng(9)
    for (const res of [1, 2, 4] as const) {
      const { scene, levelId } = sceneWith(bumpy, res, 3)
      const ground = groundOf(scene, levelId)
      for (let n = 0; n < 40; n++) {
        // Inside the lattice quadrant (see "partly outside" below); some reach past the far edge.
        const a = { x: 30 + r() * 80, z: 30 + r() * 80 }
        // Random, axis-aligned (often on lattice lines) and 45° walls.
        const kind = n % 4
        const L = 3 + r() * 25
        const ang = kind === 0 ? r() * Math.PI * 2 : kind === 1 ? (Math.floor(r() * 4) * Math.PI) / 2 : Math.PI / 4 + (Math.floor(r() * 4) * Math.PI) / 2
        if (kind !== 0) {
          a.x = Math.round(a.x / 2.5) * 2.5
          a.z = Math.round(a.z / 2.5) * 2.5
        }
        const w = wall(a, { x: a.x + Math.cos(ang) * L, z: a.z + Math.sin(ang) * L })
        const p = wallProfile(w, ground, 3, { a: 0.25, b: 0.25 })
        expect(p.follow).toBe(true)
        for (let k = 1; k < p.knots.length; k++) expect(p.knots[k] - p.knots[k - 1]).toBeGreaterThanOrEqual(MIN_EXTENT)
        expect(p.knots[0]).toBe(-0.25)
        expect(p.knots[p.knots.length - 1]).toBeCloseTo(p.len + 0.25, 12)
        for (let m = 0; m <= 50; m++) {
          const u = (p.len * m) / 50
          const q = pointAt(w, u)
          expect(p.topAt(u)).toBeCloseTo(levelGround(scene, levelId, q.x, q.z) + 8, 9)
        }
        // Flat joint extensions.
        expect(p.baseAt(-0.25)).toBe(p.baseAt(0))
        expect(p.baseAt(p.len + 0.25)).toBe(p.baseAt(p.len))
        expect(p.baseAt(0)).toBe(ground.heightAt(w.a.x, w.a.z))
        expect(p.baseAt(p.len)).toBe(ground.heightAt(w.b.x, w.b.z))
      }
    }
  })

  it("walls sharing a node have identical tops there", () => {
    const { scene, levelId } = sceneWith(bumpy, 4)
    const ground = groundOf(scene, levelId)
    const node = { x: 31.3, z: 47.9 }
    const p1 = wallProfile(wall({ x: 12.1, z: 40.2 }, node), ground, 0, { a: 0, b: 0.25 })
    const p2 = wallProfile(wall(node, { x: 50.7, z: 66.6 }), ground, 0, { a: 0.25, b: 0 })
    expect(p1.topAt(p1.len)).toBe(p2.topAt(0))
    expect(p1.topAt(p1.len + 0.25)).toBe(p2.topAt(-0.25))
  })

  it("drops knots collinear with their original neighbours (constant slope → two knots)", () => {
    const { scene, levelId } = sceneWith((x) => x / 10)
    const p = wallProfile(wall({ x: 10, z: 20 }, { x: 30, z: 20 }), groundOf(scene, levelId), 0, { a: 0, b: 0 })
    expect(p.knots).toEqual([0, 20])
    expect(p.base[0]).toBeCloseTo(1, 12)
    expect(p.base[1]).toBeCloseTo(3, 12)
    // A kink stays: the ridge at x = 20.
    const ridge = sceneWith((x) => 5 - Math.abs(x - 20) / 4)
    const q = wallProfile(wall({ x: 10, z: 20 }, { x: 30, z: 20 }), groundOf(ridge.scene, ridge.levelId), 0, { a: 0.25, b: 0.25 })
    expect(q.knots).toEqual([-0.25, 0, 10, 20, 20.25])
    expect(q.maxTop(0, 20)).toBeCloseTo(13, 9)
    expect(q.minTop(0, 20)).toBeCloseTo(10.5, 9)
    expect(q.topConstant(-0.25, 0)).toBe(true)
    expect(q.topConstant(0, 20)).toBe(false)
  })

  it("flat ground under a follow wall gives a constant top", () => {
    const { scene, levelId } = sceneWith((x) => (x > 60 ? 2 : 0))
    const p = wallProfile(wall({ x: 5, z: 5 }, { x: 45, z: 5 }), groundOf(scene, levelId), 0, { a: 0, b: 0 })
    expect(p.knots).toEqual([0, 40])
    expect(p.topConstant(0, 40)).toBe(true)
    expect(p.maxTop(0, 40)).toBe(8)
  })

  it("min / max / constant over sub-ranges match sampling", () => {
    const { scene, levelId } = sceneWith(bumpy, 2)
    const ground = groundOf(scene, levelId)
    const r = rng(12)
    for (let n = 0; n < 20; n++) {
      const a = { x: 5 + r() * 80, z: 5 + r() * 80 }
      const ang = r() * Math.PI * 2
      const w = wall(a, { x: a.x + Math.cos(ang) * 20, z: a.z + Math.sin(ang) * 20 })
      const p = wallProfile(w, ground, 0, { a: 0, b: 0 })
      const u0 = r() * 10
      const u1 = u0 + r() * 10
      let lo = Infinity
      let hi = -Infinity
      for (let m = 0; m <= 2000; m++) {
        const t = p.topAt(u0 + ((u1 - u0) * m) / 2000)
        lo = Math.min(lo, t)
        hi = Math.max(hi, t)
      }
      expect(p.minTop(u0, u1)).toBeLessThanOrEqual(lo + 1e-12)
      expect(p.maxTop(u0, u1)).toBeGreaterThanOrEqual(hi - 1e-12)
      expect(p.minTop(u0, u1)).toBeGreaterThan(lo - 0.05)
      expect(p.maxTop(u0, u1)).toBeLessThan(hi + 0.05)
      expect(p.minTop(u1, u0)).toBe(p.minTop(u0, u1))
    }
  })

  it("the bottom lies below the lowest ground over the joint-extended footprint", () => {
    const { scene, levelId } = sceneWith(bumpy, 4)
    const ground = groundOf(scene, levelId)
    const r = rng(5)
    for (let n = 0; n < 20; n++) {
      const a = { x: 20 + r() * 60, z: 20 + r() * 60 }
      const ang = r() * Math.PI * 2
      const w = wall(a, { x: a.x + Math.cos(ang) * 15, z: a.z + Math.sin(ang) * 15 }, { thickness: 1 })
      const p = wallProfile(w, ground, 0, { a: 0, b: 0 })
      let min = Infinity
      for (let i = 0; i <= 60; i++) {
        for (const off of [-0.5, 0, 0.5]) {
          const u = -0.5 + ((p.len + 1) * i) / 60
          min = Math.min(min, levelGround(scene, levelId, a.x + p.dir.x * u - p.dir.z * off, a.z + p.dir.z * u + p.dir.x * off))
        }
      }
      expect(p.bottomY).toBeLessThanOrEqual(min - WALL_BOTTOM_MARGIN + 1e-9)
      expect(p.bottomY).toBeGreaterThan(min - WALL_BOTTOM_MARGIN - 1)
    }
  })

  it("walls partly outside the lattice: exact inside it, the known one-interval ramp at the low edge", () => {
    const { scene, levelId } = sceneWith((x, z) => 2 + x / 10 + z / 20)
    const w = wall({ x: -10, z: 12 }, { x: 20, z: 12 })
    const p = wallProfile(w, groundOf(scene, levelId), 0, { a: 0, b: 0 })
    expect(p.baseAt(0)).toBe(0) // outside the lattice the ground is the elevation
    expect(p.knots.every((u, k) => k === 0 || u >= 10 - 1e-9)).toBe(true)
    for (let u = 10; u <= 30; u += 0.37) {
      const q = pointAt(w, u)
      expect(p.baseAt(u)).toBeCloseTo(levelGround(scene, levelId, q.x, q.z), 9)
    }
  })

  it("oblique walls entering the lattice: the edge crossing samples the lattice even when it rounds to just below 0", () => {
    // Terrain at +6 up to the edge: the ramp from the elevation must stay outside the lattice.
    const { scene, levelId } = sceneWith(() => 6)
    const ground = groundOf(scene, levelId)
    let edgeKnots = 0
    for (let k = 0; k < 200; k++) {
      const outside = { x: 3 + k * 0.27, z: -4 - (k % 7) * 0.3 }
      const inside = { x: 20 + (k % 13) * 1.7, z: 30 + (k % 5) }
      const swap = (v: Vec2): Vec2 => ({ x: v.z, z: v.x })
      for (const [a, b] of [
        [outside, inside],
        [swap(outside), swap(inside)],
      ]) {
        const w = wall(a, b)
        const p = wallProfile(w, ground, 0, { a: 0, b: 0 })
        // The knot on the edge (x = 0 or z = 0) is on the lattice, and 0.5 ft inside the base is the ground.
        const across = a.z < 0 ? (u: number) => pointAt(w, u).z : (u: number) => pointAt(w, u).x
        const edge = p.knots.findIndex((u) => Math.abs(across(u)) < 1e-9)
        expect(edge, `${JSON.stringify(a)} → ${JSON.stringify(b)}`).toBeGreaterThan(0)
        if (across(p.knots[edge]) < 0) edgeKnots++
        expect(p.base[edge], `${JSON.stringify(a)} → ${JSON.stringify(b)}`).toBe(6)
        const u = p.knots[edge] + 0.5
        const q = pointAt(w, u)
        expect(p.baseAt(u), `${JSON.stringify(a)} → ${JSON.stringify(b)}`).toBeCloseTo(levelGround(scene, levelId, q.x, q.z), 9)
      }
    }
    // Some edge crossings do round to just below 0 (the case under test).
    expect(edgeKnots).toBeGreaterThan(0)
  })

  it("player clients: a terrainProfile of the base-knot count replaces the sampled ground", () => {
    const { scene, levelId } = sceneWith(() => 0)
    const ground = groundOf(scene, levelId)
    const w = wall({ x: 1, z: 1 }, { x: 9, z: 1 })
    const knots = wallBaseKnots(w, ground.spacing)
    const host = knots.map((u) => 10 + u * u)
    const p = wallProfile({ ...w, terrainProfile: host }, ground, 0, { a: 0.25, b: 0 })
    expect(p.knots.map((u) => +u.toFixed(9))).toEqual([-0.25, ...knots.map((u) => +u.toFixed(9))])
    expect(p.base).toEqual([host[0], ...host])
    expect(p.topAt(8)).toBe(10 + 64 + 8)
    // The bottom stays below the (host) base even where the client's ground is higher.
    expect(p.bottomY).toBeLessThan(10)
    const low = wallProfile({ ...w, terrainProfile: knots.map(() => -30) }, ground, 0, { a: 0, b: 0 })
    expect(low.bottomY).toBe(-30 - WALL_BOTTOM_MARGIN)
    // Wrong length or non-finite values: ignored (sampled).
    expect(wallProfile({ ...w, terrainProfile: [1, 2] }, ground, 0, { a: 0, b: 0 }).base).toEqual([0, 0])
    expect(wallProfile({ ...w, terrainProfile: knots.map(() => NaN) }, ground, 0, { a: 0, b: 0 }).base).toEqual([0, 0])
    // Follow-off walls ignore it.
    expect(wallProfile({ ...w, followTerrain: false, terrainProfile: host }, ground, 0, { a: 0, b: 0 }).base).toEqual([0, 0])
  })
})

describe("pieceKnots", () => {
  it("is the piece's ends plus the profile knots strictly inside, none within MIN_EXTENT of an end", () => {
    const p = { knots: [0, 1, 2, 3, 4], base: [0, 1, 0, 1, 0] } as unknown as WallProfile
    expect(pieceKnots(p, 0.5, 3.5)).toEqual([0.5, 1, 2, 3, 3.5])
    expect(pieceKnots(p, 1, 3)).toEqual([1, 2, 3])
    expect(pieceKnots(p, 1 - 1e-7, 3 + 1e-7)).toEqual([1 - 1e-7, 2, 3 + 1e-7])
    expect(pieceKnots(p, -1, 0.5)).toEqual([-1, 0, 0.5])
    expect(pieceKnots(p, 3.5, 5)).toEqual([3.5, 4, 5])
    expect(pieceKnots(p, 4, 5)).toEqual([4, 5])
  })
})

describe("openingFrame", () => {
  it("flat walls: doors from the base, windows with a sill piece when the raw sill is above 0", () => {
    const { scene, levelId } = sceneWith(null)
    const w = wall({ x: 0, z: 10 }, { x: 40, z: 10 }, { levelId, height: 10 })
    const p = wallProfile(w, null, 2, { a: 0, b: 0 })
    const door = openingFrame(p, w, createDoor(w, 10, { width: 4, height: 7 }))!
    expect(door).toEqual({ u0: 8, u1: 12, base: 2, head: 9, sillTop: 0, hasSill: false })
    const win = openingFrame(p, w, createWindow(w, 30, { width: 3, sillHeight: 3, height: 3 }))!
    expect(win).toEqual({ u0: 28.5, u1: 31.5, base: 2, head: 8, sillTop: 5, hasSill: true })
    const tall = openingFrame(p, w, createWindow(w, 30, { sillHeight: 0, height: 30 }))!
    expect(tall.hasSill).toBe(false)
    expect(tall.head).toBe(12)
    // Clamped to the wall; nothing left → null.
    expect(openingFrame(p, w, createDoor(w, 39.5, { width: 4 }))!.u1).toBe(40)
    expect(openingFrame(p, w, createDoor(w, 45, { width: 4 }))).toBeNull()
    expect(scene).toBeDefined()
  })

  it("slopes: heights measure from the base at the span centre, clamped to the lowest top over the span", () => {
    const { scene, levelId } = sceneWith((x) => x / 10)
    const ground = groundOf(scene, levelId)
    const w = wall({ x: 10, z: 20 }, { x: 30, z: 20 }, { height: 6 })
    const p = wallProfile(w, ground, 0, { a: 0, b: 0 })
    const door = openingFrame(p, w, createDoor(w, 10, { width: 4, height: 5 }))!
    expect(door.base).toBeCloseTo(2, 9)
    expect(door.head).toBeCloseTo(7, 9)
    // A door taller than the wall stops at the lowest top over its span (x = 18: 1.8 + 6).
    expect(openingFrame(p, w, createDoor(w, 10, { width: 4, height: 6 }))!.head).toBeCloseTo(7.8, 9)
    const win = openingFrame(p, w, createWindow(w, 10, { width: 4, sillHeight: 2, height: 5 }))!
    expect(win.sillTop).toBeCloseTo(4, 9)
    expect(win.head).toBeCloseTo(7.8, 9)
    expect(win.hasSill).toBe(true)
  })

  it("steep drops within an opening never invert lintels or lose the sill", () => {
    // The ground falls 12 ft across a 4 ft opening on an 8 ft wall.
    const { scene, levelId } = sceneWith((x) => (x < 20 ? 20 : x > 25 ? 8 : 20 - ((x - 20) * 12) / 5), 4)
    const ground = groundOf(scene, levelId)
    const w = wall({ x: 10, z: 20 }, { x: 35, z: 20 }, { height: 8 })
    const p = wallProfile(w, ground, 0, { a: 0, b: 0 })
    for (const offset of [9, 10, 11, 12, 13, 14, 15, 16]) {
      for (const o of [
        createDoor(w, offset, { width: 4, height: 7 }),
        createWindow(w, offset, { width: 4, sillHeight: 3, height: 3 }),
        createWindow(w, offset, { width: 4, sillHeight: 0.5, height: 20 }),
      ]) {
        const fr = openingFrame(p, w, o)!
        const minTop = p.minTop(fr.u0, fr.u1)
        expect(fr.head).toBeLessThanOrEqual(minTop)
        expect(fr.head).toBeGreaterThanOrEqual(p.bottomY)
        // The raw formula.
        const H = w.height
        const b = p.baseAt((fr.u0 + fr.u1) / 2)
        expect(fr.base).toBe(b)
        if (o.type === "door") {
          expect(fr.head).toBe(Math.max(p.bottomY, Math.min(b + Math.min(Math.max(o.height, 0), H), minTop)))
        } else {
          const sillTop = Math.min(b + Math.min(Math.max(o.sillHeight, 0), H), minTop)
          expect(fr.sillTop).toBe(sillTop)
          expect(fr.head).toBe(Math.max(sillTop, Math.min(b + Math.min(Math.max(o.sillHeight + o.height, 0), H), minTop)))
          expect(fr.sillTop).toBeLessThanOrEqual(fr.head)
          expect(fr.hasSill).toBe(fr.sillTop - p.bottomY >= MIN_EXTENT)
          expect(fr.hasSill).toBe(true)
        }
      }
    }
  })
})
