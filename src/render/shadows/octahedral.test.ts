import { describe, expect, it } from "vitest"

import {
  CAP_EPSILON,
  CAP_INSET,
  capCovered,
  capCoverageProbe,
  DISTANCE_EPSILON,
  losContour,
  normalOffsetScale,
  octDecode,
  octEncode,
  octWrap,
  pcfSample,
  planeDistance,
  receiverOffset,
  reencodeTexel,
  tileTexelDirections,
  viewerLosSample,
  type Dir3,
  type TileRect,
} from "./octahedral"

/** Deterministic pseudo-random unit vectors. */
function randomDirs(n: number, seed = 1): Dir3[] {
  let s = seed
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
  const out: Dir3[] = []
  while (out.length < n) {
    const x = rnd() * 2 - 1
    const y = rnd() * 2 - 1
    const z = rnd() * 2 - 1
    const l = Math.hypot(x, y, z)
    if (l > 0.1 && l <= 1) out.push([x / l, y / l, z / l])
  }
  return out
}

/** Chord length between unit vectors (≈ angle for small angles, numerically stable near 0). */
const angle = (a: Dir3, b: Dir3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe("octahedral mapping", () => {
  it("round-trips directions", () => {
    for (const d of randomDirs(2000)) {
      const [u, v] = octEncode(...d)
      expect(Math.abs(u)).toBeLessThanOrEqual(1)
      expect(Math.abs(v)).toBeLessThanOrEqual(1)
      const back = octDecode(u, v)
      expect(angle(d, back)).toBeLessThan(1e-9)
    }
  })

  it("puts −Y at the centre, the horizon on the diamond and +Y in the corners", () => {
    expect(octEncode(0, -1, 0)).toEqual([0, 0])
    const [u, v] = octEncode(0.6, 0, -0.8)
    expect(Math.abs(u) + Math.abs(v)).toBeCloseTo(1, 12)
    for (const [cu, cv] of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ]) {
      const d = octDecode(cu, cv)
      expect(d[1]).toBeCloseTo(1, 12)
    }
    // Lower hemisphere never touches the fold.
    for (const d of randomDirs(500, 7)) {
      if (d[1] >= 0) continue
      const [a, b] = octEncode(...d)
      expect(Math.abs(a) + Math.abs(b)).toBeLessThanOrEqual(1 + 1e-12)
    }
  })

  it("wraps across the edges to the same direction", () => {
    for (let k = 0; k < 200; k++) {
      const v = (k / 199) * 2 - 1
      const h = 0.01
      // (1 + h, v) continues past the edge; the wrap must agree with the mirrored interior point.
      const [wu, wv] = octWrap(1 + h, v)
      expect(wu).toBeCloseTo(1 - h, 12)
      expect(wv).toBeCloseTo(-v, 12)
      // Points on the edge are shared by ±v.
      expect(angle(octDecode(1, v), octDecode(1, -v))).toBeLessThan(1e-9)
      expect(angle(octDecode(v, -1), octDecode(-v, -1))).toBeLessThan(1e-9)
    }
    // Corners wrap to the opposite corner (all four corners are +Y).
    const [cu, cv] = octWrap(1.02, 1.02)
    expect(cu).toBeCloseTo(-0.98, 12)
    expect(cv).toBeCloseTo(-0.98, 12)
  })

  it("fills the guard ring with the mirrored interior texel", () => {
    const T = 34
    const S = T - 2
    const same = (a: Dir3[], b: Dir3[]) => {
      // Same set of 4 taps (order may differ).
      for (const d of a) expect(Math.min(...b.map((e) => angle(d, e)))).toBeLessThan(1e-9)
    }
    for (let ty = 1; ty < T - 1; ty++) {
      const iy = ty - 1
      // Right guard column (interior x = S) mirrors interior (S − 1, S − 1 − iy).
      same(tileTexelDirections(T - 1, ty, T), tileTexelDirections(S - 1 + 1, S - 1 - iy + 1, T))
      // Left guard column (interior x = −1) mirrors interior (0, S − 1 − iy).
      same(tileTexelDirections(0, ty, T), tileTexelDirections(1, S - 1 - iy + 1, T))
    }
  })
})

describe("normal offset", () => {
  it("matches k = 1.5·√(4π)/(T − 2)", () => {
    expect(normalOffsetScale(512)).toBeCloseTo((1.5 * Math.sqrt(4 * Math.PI)) / 510, 12)
    const { q, dist } = receiverOffset([10, 0, 0], [0, 1, 0], [0, 0, 0], 512)
    expect(q[0]).toBe(10)
    expect(q[1]).toBeCloseTo(10 * normalOffsetScale(512), 12)
    expect(dist).toBeCloseTo(Math.hypot(10, q[1]), 12)
  })
})

/**
 * End-to-end CPU mirror of capture + lookup: a "cube" distance function for a source at the origin
 * above an infinite floor at y = −4 with a wall slab at x ∈ [3, 3.5] (back face at x = 3.5, as
 * BackSide rendering stores). Receivers on the floor must be lit in front of the wall and shadowed
 * behind it, away from the penumbra.
 */
describe("capture → PCF pipeline", () => {
  const T = 130
  const tile: TileRect = { x: 7, y: 3, size: T }
  const W = 150
  const H = 140
  const atlas = new Float32Array(W * H).fill(Number.NaN)

  // Stored distance = distance to the nearest back face along d (second depth).
  const scene = (d: Dir3): number => {
    let best = 1e6
    if (d[1] < 0) best = Math.min(best, -5 / d[1]) // floor slab bottom at y = −5 (top at −4)
    if (d[0] > 0) {
      const t = 3.5 / d[0]
      const y = d[1] * t
      if (y > -4 && y < 4) best = Math.min(best, t) // wall slab x ∈ [3, 3.5], y ∈ [−4, 4]
    }
    return best
  }

  for (let ty = 0; ty < T; ty++) {
    for (let tx = 0; tx < T; tx++) atlas[(tile.y + ty) * W + tile.x + tx] = reencodeTexel(tx, ty, T, scene)
  }

  const fetch = (ax: number, ay: number) => {
    if (ax < tile.x || ay < tile.y || ax >= tile.x + T || ay >= tile.y + T) throw new Error(`tap outside tile ${ax},${ay}`)
    return atlas[ay * W + ax]
  }

  const litAt = (x: number, z: number, wide: boolean, plane = false) => {
    const { q, dist } = receiverOffset([x, -4, z], [0, 1, 0], [0, 0, 0], T)
    const [u, v] = octEncode(...q)
    return pcfSample(fetch, tile, u, v, dist, wide, undefined, plane ? { q, n: [0, 1, 0] } : null)
  }

  it("lights the floor in front of the wall and shadows it behind", () => {
    for (const plane of [false, true]) {
      for (const wide of [false, true]) {
        expect(litAt(1, 0, wide, plane)).toBe(1)
        expect(litAt(-6, 2, wide, plane)).toBe(1)
        expect(litAt(0, -7, wide, plane)).toBe(1)
        // Grazing floor far from the source: no self-shadowing with receiver-plane distances (the plain
        // 3×3 filter loses ~1.5 % there).
        if (plane) expect(litAt(-30, 25, wide, plane)).toBe(1)
        expect(litAt(8, 0, wide, plane)).toBe(0)
        expect(litAt(9, 3, wide, plane)).toBe(0)
      }
    }
  })

  it("never taps outside the tile, including at the seams and straight up", () => {
    for (const d of randomDirs(3000, 3)) {
      const [u, v] = octEncode(...d)
      expect(() => pcfSample(fetch, tile, u, v, 1, false)).not.toThrow()
      expect(() => pcfSample(fetch, tile, u, v, 1, true)).not.toThrow()
    }
    for (const [u, v] of [
      [1, 1],
      [-1, -1],
      [1, -1],
      [-1, 1],
      [0, 1],
      [1, 0],
    ]) {
      expect(() => pcfSample(fetch, tile, u, v, 1, true)).not.toThrow()
      expect(() => pcfSample(fetch, tile, u, v, 1, false)).not.toThrow()
    }
  })

  it("produces a monotone penumbra across the shadow edge", () => {
    // Walk along +x on the floor across the wall's shadow edge; lit fraction must not increase.
    let prev = 1
    for (let x = 2; x <= 5; x += 0.05) {
      const f = litAt(x, 0.3, false)
      expect(f).toBeLessThanOrEqual(prev + 1e-9)
      prev = f
    }
    expect(prev).toBe(0)
  })
})

/**
 * Caps (tops of walls / props) and back-face coincidence: a light 3 ft above a 1 ft slab (y ∈ [−4, −3])
 * and a wall x ∈ [4, 4.5] whose cap is at y = −4, touching the slab's underside (a cellar wall under the
 * ground floor). The stored map holds the slab's bottom there, exactly on the cap.
 */
describe("cap receivers", () => {
  const T = 258
  const tile: TileRect = { x: 0, y: 0, size: T }
  const build = (slab: boolean) => {
    const atlas = new Float32Array(T * T)
    const scene = (d: Dir3): number => {
      let best = 1e6
      if (slab && d[1] < 0) best = Math.min(best, -4 / d[1]) // slab bottom (back face seen from above)
      if (d[0] > 0) {
        // Wall back faces from above: its far side x = 4.5 (y ∈ [−13, −4]) and its bottom.
        const t = 4.5 / d[0]
        const y = d[1] * t
        if (y > -13 && y < -4) best = Math.min(best, t)
      }
      if (d[1] < 0) best = Math.min(best, -30 / d[1]) // far floor
      return best
    }
    for (let ty = 0; ty < T; ty++) for (let tx = 0; tx < T; tx++) atlas[ty * T + tx] = reencodeTexel(tx, ty, T, scene)
    return (ax: number, ay: number) => atlas[ay * T + ax]
  }
  const covered = build(true)
  const free = build(false)
  const capPoint: Dir3 = [4.25, -4, 0.2]
  const up: Dir3 = [0, 1, 0]
  const lit = (fetch: (x: number, y: number) => number, cap: boolean, at: Dir3 = capPoint, plane = true, wide = false) => {
    const { q, dist, epsilon } = receiverOffset(at, up, [0, 0, 0], T, cap)
    const [u, v] = octEncode(...q)
    return pcfSample(fetch, tile, u, v, dist, wide, epsilon, plane ? { q, n: up } : null)
  }
  /** The shaders' cap path: covered → 0, else the filter without plane distances. */
  const capLit = (fetch: (x: number, y: number) => number, at: Dir3, wide = false) => {
    const { q, dist, epsilon } = receiverOffset(at, up, [0, 0, 0], T, true)
    if (capCovered(fetch, tile, { q: capCoverageProbe(at, up, [0, 0, 0], T), n: up })) return 0
    const [u, v] = octEncode(...q)
    return pcfSample(fetch, tile, u, v, dist, wide, epsilon)
  }

  it("the §4.2 normal offset alone would light a cap through the slab above it", () => {
    expect(lit(covered, false, capPoint, false)).toBeGreaterThan(0.5)
  })

  it("receiver-plane distances keep a covered cap dark at grazing angles (no acne through neighbour taps)", () => {
    // 4 ft below the light and ~14 ft away: the slab bottom's distance changes by ~0.2 ft per texel.
    const grazing: Dir3 = [4.2, -4, 13.7]
    const coveredGrazing = build(true)
    for (const wide of [false, true]) {
      expect(lit(coveredGrazing, true, grazing, false, wide)).toBeGreaterThan(0)
      expect(lit(coveredGrazing, true, grazing, true, wide)).toBe(0)
    }
  })

  it("the cap rule shadows a covered cap and keeps a free cap lit", () => {
    expect(lit(covered, true)).toBe(0)
    expect(lit(free, true)).toBe(1)
    for (const wide of [false, true]) {
      expect(capLit(covered, capPoint, wide)).toBe(0)
      expect(capLit(free, capPoint, wide)).toBe(1)
    }
  })

  it("plane distances would leak light onto a floor right behind a wall standing on it (so only caps use them)", () => {
    // The wall stands on a floor slab y ∈ [−14, −13]; receivers on the floor 0.2–0.3 ft past the wall's
    // far face, seen at grazing angles: the floor's plane runs under the wall, and taps aimed there pass.
    const atlas = new Float32Array(T * T)
    const scene = (d: Dir3): number => {
      let best = 1e6
      if (d[0] > 0) {
        const t = 4.5 / d[0]
        const y = d[1] * t
        if (y > -13 && y < -4) best = Math.min(best, t)
      }
      if (d[1] < 0) best = Math.min(best, -14 / d[1])
      return best
    }
    for (let ty = 0; ty < T; ty++) for (let tx = 0; tx < T; tx++) atlas[ty * T + tx] = reencodeTexel(tx, ty, T, scene)
    const fetch = (ax: number, ay: number) => atlas[ay * T + ax]
    for (const at of [[4.7, -13, 20], [4.8, -13, 20]] as Dir3[]) {
      const { q, dist } = receiverOffset(at, up, [0, 0, 0], T)
      const [u, v] = octEncode(...q)
      expect(pcfSample(fetch, tile, u, v, dist, true)).toBe(0)
      expect(pcfSample(fetch, tile, u, v, dist, true, undefined, { q, n: up })).toBeGreaterThan(0.1)
    }
  })

  it("the shaders' cap path keeps a covered cap dark at grazing angles and a thin free cap lit to its far edge", () => {
    const grazing: Dir3 = [4.2, -4, 13.7]
    expect(capLit(covered, grazing)).toBe(0)
    expect(capLit(covered, grazing, true)).toBe(0)
    // Free cap, 0.15 ft from its far face (x = 4.5): plane distances past the edge would dim it.
    const nearEdge: Dir3 = [4.35, -4, 0.2]
    expect(capLit(free, nearEdge)).toBe(1)
    expect(lit(free, true, nearEdge, true, true)).toBeLessThan(1)
    // …also at grazing angles, where the texel under the receiver already holds side-face exits (only a
    // rim within ~0.1 ft of the far face darkens).
    for (const z of [4, 8, 11, 14]) {
      expect(capLit(free, [4.4, -4, z])).toBeGreaterThan(0.6)
      expect(capLit(covered, [4.4, -4, z])).toBe(0)
      expect(capLit(covered, [4.05, -4, z])).toBe(0)
    }
  })

  it("plane distance follows the tap direction and falls back when parallel", () => {
    const plane = { q: [0, -4, 10] as Dir3, n: up }
    const dir = (x: number, y: number, z: number): Dir3 => {
      const l = Math.hypot(x, y, z)
      return [x / l, y / l, z / l]
    }
    const dist = Math.hypot(4, 10)
    expect(planeDistance(plane, dir(0, -4, 10), dist)).toBeCloseTo(dist, 9)
    expect(planeDistance(plane, dir(0, -4, 10.2), dist)).toBeCloseTo(Math.hypot(4, 10.2), 9)
    expect(planeDistance(plane, dir(0, 1, 10), dist)).toBe(dist)
    expect(planeDistance(plane, dir(0, -4, 40), dist)).toBeCloseTo(dist * 1.1, 9)
  })

  it("insets caps into their solid and compares strictly", () => {
    const { q, epsilon } = receiverOffset([1, 2, 3], up, [0, 0, 0], T, true)
    expect(q).toEqual([1, 2 - CAP_INSET, 3])
    expect(epsilon).toBe(-CAP_EPSILON)
    expect(receiverOffset([1, 2, 3], up, [0, 0, 0], T).epsilon).toBe(DISTANCE_EPSILON)
  })
})

/**
 * Viewer line of sight past a window sill: the eye at the origin, head height 5.5 ft over the ground
 * (y = −5.5, a 1 ft slab), and a wall x ∈ [−10.5, −10] up to y = −2.3 (a sill 3.2 ft high) running along z.
 * The ground beyond it is hidden up to a straight line along z about 23 ft out. At that grazing angle one
 * texel of the 512 map spans ~0.6 ft of ground: the bilinear filter's edge wanders by about that much along
 * z, with partly seen tails along the rays (a player's feathered fog edge, zoomed in on a view out of a
 * window); the shader's test must draw a straight edge.
 */
describe("viewer line of sight at a grazing edge", () => {
  const T = 512
  const tile: TileRect = { x: 0, y: 0, size: T }
  const atlas = new Float32Array(T * T)
  const scene = (d: Dir3): number => {
    let best = 1e6
    if (d[1] < 0) best = Math.min(best, -6.5 / d[1])
    if (d[0] < 0) {
      const t = 10.5 / -d[0]
      const y = d[1] * t
      if (y > -6.5 && y < -2.3) best = Math.min(best, t)
    }
    return best
  }
  for (let ty = 0; ty < T; ty++) for (let tx = 0; tx < T; tx++) atlas[ty * T + tx] = reencodeTexel(tx, ty, T, scene)
  const fetch = (ax: number, ay: number) => {
    if (ax < 0 || ay < 0 || ax >= T || ay >= T) throw new Error(`tap outside tile ${ax},${ay}`)
    return atlas[ay * T + ax]
  }
  type Filter = "bilinear" | "contour" | "shader"
  // The world shader's ground test: 0.25 ft up, then the normal offset; "shader" = atViewerLos zoomed in
  // (0.02 ft pixels: taps across the ray).
  const seen = (x: number, z: number, filter: Filter) => {
    if (filter === "shader") return viewerLosSample(fetch, tile, [x, -5.25, z], [0, 1, 0], 0.02)
    const { q, dist } = receiverOffset([x, -5.25, z], [0, 1, 0], [0, 0, 0], T)
    const [u, v] = octEncode(...q)
    return filter === "contour" ? losContour(fetch, tile, u, v, dist) : pcfSample(fetch, tile, u, v, dist, false)
  }
  const zs = Array.from({ length: 301 }, (_, i) => -3 + i * 0.02)
  /** Where the edge crosses `level` along x at each z (bisection between hidden and seen ground). */
  const edge = (filter: Filter, level = 0.5) =>
    zs.map((z) => {
      let lo = -40
      let hi = -18
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2
        if (seen(mid, z, filter) >= level) lo = mid
        else hi = mid
      }
      return (lo + hi) / 2
    })
  /** How far the line wanders along z: 5th to 95th percentile of its x. */
  const spread = (xs: number[]) => {
    const sorted = xs.slice().sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length * 0.95)] - sorted[Math.floor(sorted.length * 0.05)]
  }
  /** Widest ramp from 5 % to 95 % seen, along x. */
  const ramp = (filter: Filter) => {
    const inner = edge(filter, 0.95)
    return Math.max(...edge(filter, 0.05).map((x, i) => x - inner[i]))
  }

  it("sees the ground well beyond the sill and not below it", () => {
    for (const filter of ["bilinear", "contour", "shader"] as const) {
      expect(seen(-32, 0.4, filter)).toBe(1)
      expect(seen(-20, -1.3, filter)).toBe(0)
      expect(seen(-5, 2, filter)).toBe(1)
    }
  })

  it("draws a straight edge where the bilinear filter draws teeth", () => {
    // Bilinear: the half-seen line wanders by ~0.5 ft along z, and partly seen tails run well over a foot
    // out along the rays (the feathers).
    expect(spread(edge("bilinear"))).toBeGreaterThan(0.45)
    expect(ramp("bilinear")).toBeGreaterThan(1.2)
    // The contour alone ends the tails (a short ramp) but still wobbles nearly as far (scallops); averaged
    // across the ray the edge is straight, a soft ramp about as wide as a texel's span of ground.
    expect(ramp("contour")).toBeLessThan(0.3)
    expect(spread(edge("contour"))).toBeGreaterThan(0.35)
    expect(spread(edge("shader"))).toBeLessThan(0.2)
    expect(ramp("shader")).toBeLessThan(0.8)
  })

  it("tests a single tap where a texel is smaller than the pixel", () => {
    const { q, dist } = receiverOffset([-23.2, -5.25, 0.3], [0, 1, 0], [0, 0, 0], T)
    const [u, v] = octEncode(...q)
    expect(viewerLosSample(fetch, tile, [-23.2, -5.25, 0.3], [0, 1, 0], 5)).toBe(losContour(fetch, tile, u, v, dist))
  })

  it("never taps outside the tile", () => {
    for (const d of randomDirs(3000, 5)) {
      const [u, v] = octEncode(...d)
      for (const dist of [0.5, 5, 30, 1e7]) expect(() => losContour(fetch, tile, u, v, dist)).not.toThrow()
    }
    for (const [u, v] of [
      [1, 1],
      [-1, -1],
      [1, -1],
      [-1, 1],
    ])
      expect(() => losContour(fetch, tile, u, v, 20)).not.toThrow()
  })
})

