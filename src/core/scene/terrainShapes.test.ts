import { applyPatches, enablePatches, produce, produceWithPatches } from "immer"
import { describe, expect, it } from "vitest"

import { createLevel } from "./factory"
import {
  chunkKey,
  chunkSamples,
  createHeightmap,
  decodeChunk,
  DEFAULT_TERRAIN_RESOLUTION,
  encodeChunk,
  sampleCounts,
  sampleHeight,
  sampleSpacing,
  writeHeights,
} from "./heightmap"
import { MAX_TERRAIN_HEIGHT, type HeightLattice } from "./heightmapBrush"
import {
  applyShapesClosure,
  applyShapesEdit,
  applyShapesToBase,
  bakeRegion,
  baseLattice,
  blockShape,
  canonicalize,
  clearTerrainShapes,
  collapseEdge,
  countShapeSamples,
  cropTerrainToGrid,
  cylinderShape,
  dissolveVertices,
  elementVertexIndices,
  flattenTerrain,
  hasPaintedBase,
  isSimplePolygon,
  isSimplePolyline,
  isValidTerrainShape,
  latticeWindow,
  loopCut,
  loopCutRing,
  nextShapeOrder,
  polygonShape,
  removeInnerEdges,
  rampShape,
  rayHitShape,
  resampleTerrain,
  rotateShape,
  rotateShapeQuarter,
  shapeBounds,
  shapeEdgeEnds,
  shapeTopAt,
  signedArea,
  TERRAIN_SHAPE_MAX_POINTS,
  topFaces,
  topGraphValid,
  topVertices,
  translateShape,
  translateVertices,
  triangulateFootprint,
  writeTerrain,
  type TerrainLevel,
} from "./terrainShapes"
import type { Heightmap, Level, Rect, TerrainShape, Vec3 } from "./types"

enablePatches()

// 20×12 cells of 5 ft; at resolution 2 the lattice is 41×25 samples in 3×2 chunks of 16 (with padding).
const grid = { cellSize: 5, width: 20, depth: 12 }

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pts = (xz: [number, number][], y = 0): Vec3[] => xz.map(([x, z]) => ({ x, y, z }))

function shape(id: string, points: Vec3[], op: TerrainShape["op"] = "add", order = 0): TerrainShape {
  return { id, kind: "block", op, order, points, base: 0 }
}

function terrainLevel(res: Heightmap["resolution"] = 2, g = grid, f?: (x: number, z: number) => number): Level {
  const heightmap = createHeightmap(res)
  if (!f) return createLevel({ heightmap })
  const { samplesX, samplesZ } = sampleCounts(g, res)
  const s = sampleSpacing(g.cellSize, res)
  const dense = new Float32Array(samplesX * samplesZ)
  for (let sz = 0; sz < samplesZ; sz++) for (let sx = 0; sx < samplesX; sx++) dense[sz * samplesX + sx] = f(sx * s, sz * s)
  return createLevel({ heightmap: writeHeights(heightmap, g, dense) })
}

/** writeTerrain through immer (like the store); asserts it accepted the edit. */
function edit(level: Level, e: Parameters<typeof writeTerrain>[2], g = grid): Level {
  return produce(level, (d) => {
    expect(writeTerrain(d, g, e)).toBe(true)
  })
}

const canonical = (v: number) => (v === 0 || v !== v ? 0 : Math.fround(Math.max(-MAX_TERRAIN_HEIGHT, Math.min(MAX_TERRAIN_HEIGHT, v))))

function allZero(a: Float32Array): boolean {
  return a.every((v) => v === 0)
}

function bitsEqual(a: Float32Array, b: Float32Array): boolean {
  const ua = new Uint32Array(a.buffer, a.byteOffset, a.length)
  const ub = new Uint32Array(b.buffer, b.byteOffset, b.length)
  return ua.every((v, k) => v === ub[k])
}

/** Chunk (ci, cj) of a dense lattice, padding zeroed, canonical. */
function chunkOf(l: HeightLattice, res: Heightmap["resolution"], ci: number, cj: number): Float32Array {
  const n = chunkSamples(res)
  const out = new Float32Array(n * n)
  for (let lz = 0; lz < n; lz++) {
    for (let lx = 0; lx < n; lx++) {
      const sx = ci * n + lx
      const sz = cj * n + lz
      if (sx < l.samplesX && sz < l.samplesZ) out[lz * n + lx] = canonical(l.heights[sz * l.samplesX + sx])
    }
  }
  return out
}

/**
 * The invariant (terrainShapes header) for every chunk of the level, plus — when `truth` (the painted base
 * the test applied) is given — that the stored base is exactly it and the heightmap is its full rebake.
 * Returns the baked dense lattice.
 */
function checkInvariant(level: TerrainLevel, g: typeof grid, truth?: Float32Array): HeightLattice {
  const hm = level.heightmap!
  const res = hm.resolution
  const n = chunkSamples(res)
  const shapes = Object.values(level.terrainEdits?.shapes ?? {})
  if (level.terrainEdits) expect(shapes.length).toBeGreaterThan(0)
  const base = baseLattice(level, g)
  if (truth) {
    expect(base.heights.length).toBe(truth.length)
    expect(bitsEqual(base.heights, Float32Array.from(truth, canonical))).toBe(true)
  }
  const baked: HeightLattice = { ...base, heights: base.heights.slice() }
  bakeRegion(baked, shapes, null)
  const chunksX = Math.ceil(base.samplesX / n)
  const chunksZ = Math.ceil(base.samplesZ / n)
  const keys = new Set<string>()
  for (let cj = 0; cj < chunksZ; cj++) {
    for (let ci = 0; ci < chunksX; ci++) {
      const key = chunkKey(ci, cj)
      keys.add(key)
      const b = chunkOf(base, res, ci, cj)
      const k = chunkOf(baked, res, ci, cj)
      expect(hm.chunks[key], `heightmap ${key}`).toBe(allZero(k) ? undefined : encodeChunk(k))
      const expectedBase = bitsEqual(b, k) ? undefined : allZero(b) ? "" : encodeChunk(b)
      expect(level.terrainEdits?.baseChunks[key], `base ${key}`).toBe(expectedBase)
    }
  }
  for (const key of Object.keys(hm.chunks)) expect(keys.has(key)).toBe(true)
  for (const key of Object.keys(level.terrainEdits?.baseChunks ?? {})) expect(keys.has(key)).toBe(true)
  return baked
}

/** A random simple star-shaped polygon (canonical), heights per vertex or constant. */
function randomShape(rand: () => number, id: string, g = grid): TerrainShape {
  const n = 3 + Math.floor(rand() * 10)
  const cx = -10 + rand() * (g.width * g.cellSize + 20)
  const cz = -10 + rand() * (g.depth * g.cellSize + 20)
  const step = (2 * Math.PI) / n
  const op = rand() < 0.35 ? "carve" : "add"
  const flat = rand() < 0.5
  const top = op === "add" ? -2 + rand() * 12 : -12 + rand() * 10
  const points: Vec3[] = []
  for (let k = 0; k < n; k++) {
    const a = k * step + (rand() - 0.5) * 0.4 * step
    const r = 2 + rand() * 20
    points.push({ x: cx + r * Math.cos(a), y: flat ? top : top + (rand() - 0.5) * 8, z: cz + r * Math.sin(a) })
  }
  return { id, kind: "block", op, order: Math.floor(rand() * 4), points, base: 0 }
}

describe("polygons", () => {
  it("signedArea is positive for the canonical orientation", () => {
    const sq = pts([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ])
    expect(signedArea(sq)).toBe(100)
    expect(signedArea([...sq].reverse())).toBe(-100)
    expect(signedArea(canonicalize([...sq].reverse()))).toBe(100)
    expect(canonicalize(sq)).toEqual(sq)
  })

  it("isSimplePolygon accepts simple polygons of either orientation, incl. straight vertices", () => {
    const sq: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]
    expect(isSimplePolygon(pts(sq))).toBe(true)
    expect(isSimplePolygon(pts(sq).reverse())).toBe(true)
    expect(
      isSimplePolygon(
        pts([
          [0, 0],
          [5, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ])
      )
    ).toBe(true)
    expect(
      isSimplePolygon(
        pts([
          [0, 0],
          [10, 0],
          [10, 10],
          [5, 3],
          [0, 10],
        ])
      )
    ).toBe(true)
  })

  it("isSimplePolygon rejects crossings, touches, repeats, spikes and zero area", () => {
    const bad: [number, number][][] = [
      [
        [0, 0],
        [10, 10],
        [10, 0],
        [0, 10],
      ], // bow tie
      [
        [0, 0],
        [10, 0],
        [10, 0],
        [0, 10],
      ], // repeated vertex
      [
        [0, 0],
        [10, 0],
        [5, 0],
        [5, 10],
      ], // fold back along an edge
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [5, 0],
        [0, 10],
      ], // vertex touching a non-adjacent edge
      [
        [0, 0],
        [5, 0],
        [10, 0],
      ], // zero area
      [
        [0, 0],
        [10, 0],
      ],
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ], // closed ring (first == last)
    ]
    for (const p of bad) expect(isSimplePolygon(pts(p)), JSON.stringify(p)).toBe(false)
    expect(isSimplePolygon([...pts(bad[0].slice(0, 3)), { x: NaN, y: 0, z: 1 }])).toBe(false)
  })
})

/** Σ triangle areas, every triangle positive and its centroid inside the polygon. */
function checkTriangulation(points: Vec3[], tris: number[]): number {
  expect(tris.length % 3).toBe(0)
  let sum = 0
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [points[tris[t]], points[tris[t + 1]], points[tris[t + 2]]]
    const d = (b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x)
    expect(d).toBeGreaterThan(1e-9)
    sum += d / 2
  }
  return sum
}

describe("isSimplePolyline", () => {
  const xz = (a: [number, number][]) => a.map(([x, z]) => ({ x, z }))

  it("accepts open chains that can still close, whatever the closing edge does", () => {
    expect(isSimplePolyline([])).toBe(true)
    expect(isSimplePolyline(xz([[0, 0]]))).toBe(true)
    expect(
      isSimplePolyline(
        xz([
          [0, 0],
          [10, 0],
        ])
      )
    ).toBe(true)
    // An open "Z": its closing edge (last → first) would cross the first segment, but the chain is fine.
    expect(
      isSimplePolyline(
        xz([
          [0, 0],
          [10, 0],
          [0, 10],
          [10, 10],
        ])
      )
    ).toBe(true)
    expect(
      isSimplePolygon(
        xz([
          [0, 0],
          [10, 0],
          [0, 10],
          [10, 10],
        ])
      )
    ).toBe(false)
    // A U shape drawn corner by corner.
    const u = xz([
      [0, 0],
      [30, 0],
      [30, 30],
      [20, 30],
      [20, 10],
      [10, 10],
      [10, 30],
      [0, 30],
    ])
    for (let n = 1; n <= u.length; n++) expect(isSimplePolyline(u.slice(0, n))).toBe(true)
    expect(isSimplePolygon(u)).toBe(true)
  })

  it("rejects crossings, touches, repeats, fold-backs and non-finite points", () => {
    const bad: [number, number][][] = [
      // The fourth segment crosses the first.
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [5, -5],
      ],
      // A corner on an earlier segment.
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [5, 0],
      ],
      // A repeated corner.
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 0],
      ],
      [
        [0, 0],
        [10, 0],
        [10, 0],
      ],
      // Folding back along the previous segment.
      [
        [0, 0],
        [10, 0],
        [5, 0],
      ],
    ]
    for (const p of bad) expect(isSimplePolyline(xz(p)), JSON.stringify(p)).toBe(false)
    expect(
      isSimplePolyline([
        { x: 0, z: 0 },
        { x: NaN, z: 1 },
      ])
    ).toBe(false)
  })
})

describe("triangulateFootprint", () => {
  it("triangulates convex, concave and reversed polygons exactly", () => {
    const L = pts([
      [0, 0],
      [20, 0],
      [20, 5],
      [5, 5],
      [5, 20],
      [0, 20],
    ])
    const t = triangulateFootprint(L)
    expect(t.length).toBe(12)
    expect(checkTriangulation(L, t)).toBeCloseTo(175, 9)
    const rev = [...L].reverse()
    expect(checkTriangulation(rev, triangulateFootprint(rev))).toBeCloseTo(175, 9)
    const cyl = cylinderShape("c", { x: 0, z: 0 }, 10, 64, 0, 1, 0)
    const ct = triangulateFootprint(cyl.points)
    expect(ct.length).toBe(62 * 3)
    expect(checkTriangulation(cyl.points, ct)).toBeCloseTo(signedArea(cyl.points), 9)
  })

  it("covers random star polygons exactly", () => {
    const rand = mulberry32(7)
    for (let k = 0; k < 200; k++) {
      const s = randomShape(rand, "s")
      const t = triangulateFootprint(s.points)
      expect(t.length).toBe((s.points.length - 2) * 3)
      expect(checkTriangulation(s.points, t)).toBeCloseTo(signedArea(s.points), 6)
    }
  })

  it("triangulates combs and polygons with inserted collinear vertices", () => {
    // A comb: a base bar with 8 teeth (x ∈ [10k + 5, 10k + 10] up to z = 30), many reflex vertices.
    const comb: [number, number][] = [
      [0, 0],
      [80, 0],
    ]
    for (let k = 7; k >= 0; k--) comb.push([10 * k + 10, 30], [10 * k + 5, 30], [10 * k + 5, 8], [10 * k, 8])
    const c = pts(comb)
    expect(isSimplePolygon(c)).toBe(true)
    // (Exact cover; fewer than n − 2 triangles, as a diagonal along z = 8 leaves zero-width slits to drop.)
    expect(checkTriangulation(c, triangulateFootprint(c))).toBeCloseTo(signedArea(c), 9)
    const spiral = pts([
      [0, 0],
      [50, 0],
      [50, 50],
      [10, 50],
      [10, 20],
      [30, 20],
      [30, 30],
      [20, 30],
      [20, 40],
      [40, 40],
      [40, 10],
      [0, 10],
    ])
    expect(isSimplePolygon(spiral)).toBe(true)
    expect(checkTriangulation(spiral, triangulateFootprint(spiral))).toBeCloseTo(signedArea(spiral), 9)
    const rand = mulberry32(99)
    for (let k = 0; k < 100; k++) {
      const s = randomShape(rand, "s")
      const withMid: Vec3[] = []
      s.points.forEach((p, i) => {
        withMid.push(p)
        const q = s.points[(i + 1) % s.points.length]
        if (rand() < 0.5) withMid.push({ x: (p.x + q.x) / 2, y: p.y, z: (p.z + q.z) / 2 })
      })
      expect(checkTriangulation(withMid, triangulateFootprint(withMid))).toBeCloseTo(signedArea(withMid), 6)
      const far = withMid.map((p) => ({ ...p, x: p.x + 900, z: p.z - 700 }))
      expect(checkTriangulation(far, triangulateFootprint(far))).toBeCloseTo(signedArea(far), 5)
    }
  })

  it("handles collinear, repeated and degenerate input without covering outside area", () => {
    const mid = pts([
      [0, 0],
      [5, 0],
      [10, 0],
      [10, 5],
      [10, 10],
      [5, 10],
      [0, 10],
      [0, 5],
    ])
    expect(checkTriangulation(mid, triangulateFootprint(mid))).toBeCloseTo(100, 9)
    const dup = pts([
      [0, 0],
      [10, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 10],
    ])
    expect(checkTriangulation(dup, triangulateFootprint(dup))).toBeCloseTo(100, 9)
    const spike = pts([
      [0, 0],
      [10, 0],
      [10, 10],
      [5, 10],
      [5, 18],
      [5, 10],
      [0, 10],
    ])
    expect(checkTriangulation(spike, triangulateFootprint(spike))).toBeCloseTo(100, 9)
    // Two squares pinched at a repeated corner (weakly simple).
    const pinch = pts([
      [0, 0],
      [10, 0],
      [10, 10],
      [20, 10],
      [20, 20],
      [10, 20],
      [10, 10],
      [0, 10],
    ])
    expect(checkTriangulation(pinch, triangulateFootprint(pinch))).toBeCloseTo(200, 9)
    expect(
      triangulateFootprint(
        pts([
          [0, 0],
          [5, 0],
          [10, 0],
        ])
      )
    ).toEqual([])
    expect(
      triangulateFootprint(
        pts([
          [3, 3],
          [3, 3],
          [3, 3],
        ])
      )
    ).toEqual([])
    expect(triangulateFootprint([{ x: NaN, y: 0, z: 0 }, ...pts([[1, 0]]), ...pts([[0, 1]])])).toEqual([])
    // Bow tie with net area: whatever it returns has positive triangles and finite indices.
    const bow = pts([
      [0, 0],
      [20, 0],
      [0, 10],
      [10, 10],
    ])
    const bt = triangulateFootprint(bow)
    checkTriangulation(bow, bt)
    for (const i of bt) expect(i >= 0 && i < bow.length).toBe(true)
  })

  it("covers the whole footprint when a vertex lies on a candidate diagonal within rounding (a cylinder vertex dragged onto its centre)", () => {
    // 8-gon around (10, 10), vertex 3 snapped onto the centre: vertices 1, 3 and 5 are collinear up to cos / sin rounding.
    const cyl = cylinderShape("c", { x: 10, z: 10 }, 10, 8, 0, 4, 0)
    const pacman = translateVertices(cyl, [3], { x: 10 - cyl.points[3].x, y: 0, z: 10 - cyl.points[3].z })!
    expect(isValidTerrainShape(pacman)).toBe(true)
    const t = triangulateFootprint(pacman.points)
    expect(checkTriangulation(pacman.points, t)).toBeCloseTo(signedArea(pacman.points), 9)
    // (12, 18) is inside the footprint (edge 1–2 passes z ≈ 19.17 there): baked and picked.
    expect(shapeTopAt(pacman, 12, 18)).toBe(4)
    expect(rayHitShape(pacman, 0, { origin: { x: 12, y: 100, z: 18 }, direction: { x: 0, y: -1, z: 0 } })?.face).toBe("top")
    // Every vertex of 24-gons of several radii and centres dragged onto the (grid-snapped) centre.
    let tried = 0
    for (const r of [2.5, 5, 7.5, 10, 12.5, 15, 20, 25]) {
      for (const cx of [5, 10, 20, 25]) {
        for (const cz of [5, 10, 20, 25]) {
          const c = cylinderShape("c", { x: cx, z: cz }, r, 24, 0, 4, 0)
          for (let v = 0; v < 24; v++) {
            const s = translateVertices(c, [v], { x: cx - c.points[v].x, y: 0, z: cz - c.points[v].z })
            if (!s) continue
            tried++
            const area = signedArea(s.points)
            expect(Math.abs(checkTriangulation(s.points, triangulateFootprint(s.points)) - area), `r ${r} centre ${cx},${cz} vertex ${v}`).toBeLessThan(
              1e-6 * area
            )
          }
        }
      }
    }
    expect(tried).toBeGreaterThan(3000)
  })
})

describe("bake", () => {
  const lattice = (res: Heightmap["resolution"] = 2): HeightLattice => baseLattice(terrainLevel(res), grid)
  const at = (l: HeightLattice, x: number, z: number) => l.heights[Math.round(z / l.spacing) * l.samplesX + Math.round(x / l.spacing)]

  it("raises (add) or cuts (carve) the closed footprint", () => {
    const l = lattice()
    bakeRegion(l, [blockShape("a", { x: 10, z: 10, w: 10, d: 5 }, 0, 4, 0), blockShape("b", { x: 40, z: 20, w: 10, d: 10 }, 0, -3, 0)], null)
    expect(at(l, 10, 10)).toBe(4) // closed: the corner sample is inside
    expect(at(l, 20, 15)).toBe(4)
    expect(at(l, 15, 12.5)).toBe(4)
    expect(at(l, 22.5, 12.5)).toBe(0)
    expect(at(l, 45, 25)).toBe(-3)
    expect(at(l, 7.5, 12.5)).toBe(0)
  })

  it("applies shapes in (order, id): a block inside a carved pit stands when it comes later", () => {
    const pit = blockShape("pit", { x: 10, z: 10, w: 30, d: 30 }, 0, -10, 0)
    const pillar = blockShape("pillar", { x: 20, z: 20, w: 10, d: 10 }, -10, 8, 1)
    const l = lattice()
    bakeRegion(l, [pillar, pit], null)
    expect(at(l, 25, 25)).toBe(-2)
    expect(at(l, 15, 15)).toBe(-10)
    const l2 = lattice()
    bakeRegion(
      l2,
      [
        { ...pillar, order: 0 },
        { ...pit, order: 1 },
      ],
      null
    )
    expect(at(l2, 25, 25)).toBe(-10)
    // Equal orders: the id decides ("a" < "b").
    const l3 = lattice()
    bakeRegion(
      l3,
      [
        { ...pit, id: "b", order: 3 },
        { ...pillar, id: "a", order: 3 },
      ],
      null
    )
    expect(at(l3, 25, 25)).toBe(-10)
  })

  it("interpolates non-planar tops and clamps to ±MAX_TERRAIN_HEIGHT", () => {
    const l = lattice(4)
    bakeRegion(l, [rampShape("r", { x: 0, z: 0, w: 20, d: 20 }, 0, 0, 10, 0)], null)
    expect(at(l, 10, 0)).toBe(0)
    expect(at(l, 10, 10)).toBe(5)
    expect(at(l, 10, 20)).toBe(10)
    const tall = shape(
      "t",
      pts([
        [30, 30],
        [40, 30],
        [40, 40],
      ]).map((p, k) => ({ ...p, y: k === 0 ? 499 : 5000 }))
    )
    bakeRegion(l, [tall], null)
    expect(Math.max(...l.heights)).toBe(MAX_TERRAIN_HEIGHT)
  })

  it("restricts to the rect and never writes outside the lattice (no row wrap)", () => {
    const l = lattice()
    const b = blockShape("a", { x: 0, z: 0, w: 60, d: 20 }, 0, 2, 0)
    bakeRegion(l, [b], { x: 0, z: 0, w: 25, d: 20 })
    expect(at(l, 25, 10)).toBe(2)
    expect(at(l, 27.5, 10)).toBe(0)
    const l2 = lattice()
    bakeRegion(l2, [blockShape("neg", { x: -30, z: 10, w: 29, d: 10 }, 0, 7, 0), blockShape("far", { x: 101, z: 10, w: 30, d: 10 }, 0, 7, 0)], null)
    expect(allZero(l2.heights)).toBe(true)
  })

  it("never produces NaN from degenerate or hostile shapes", () => {
    const l = lattice(4)
    const shapes = [
      shape(
        "collinear",
        pts(
          [
            [0, 0],
            [5, 0],
            [10, 0],
          ],
          3
        )
      ),
      shape(
        "dup",
        pts(
          [
            [10, 10],
            [20, 10],
            [20, 10],
            [20, 20],
            [10, 20],
          ],
          3
        )
      ),
      shape(
        "sliver",
        pts(
          [
            [30, 5],
            [60, 5],
            [90, 5.0000001],
          ],
          9
        )
      ),
      shape(
        "bow",
        pts(
          [
            [40, 30],
            [60, 30],
            [40, 50],
            [55, 50],
          ],
          4
        ),
        "carve"
      ),
      shape("nan", [
        { x: NaN, y: 1, z: 0 },
        ...pts(
          [
            [5, 5],
            [9, 9],
          ],
          1
        ),
      ]),
      shape(
        "inf-y",
        pts([
          [70, 30],
          [90, 30],
          [90, 50],
        ]).map((p) => ({ ...p, y: Infinity }))
      ),
    ]
    bakeRegion(l, shapes, null)
    expect(l.heights.every(Number.isFinite)).toBe(true)
    expect(at(l, 15, 15)).toBe(3)
  })

  it("shapeTopAt follows the bake rule", () => {
    const r = rampShape("r", { x: 0, z: 0, w: 10, d: 20 }, 1, 2, 6, 0)
    expect(shapeTopAt(r, 5, 10)).toBeCloseTo(5, 12)
    expect(shapeTopAt(r, 0, 0)).toBeCloseTo(2, 12)
    expect(shapeTopAt(r, 10, 20)).toBeCloseTo(8, 12)
    expect(shapeTopAt(r, 10.5, 10)).toBe(null)
    const l = lattice(4)
    bakeRegion(l, [r], null)
    expect(at(l, 5, 10)).toBe(Math.fround(shapeTopAt(r, 5, 10)!))
  })

  it("counts covered samples (undersized-shape warning)", () => {
    const small = blockShape("s", { x: 0, z: 0, w: 5, d: 5 }, 0, 1, 0)
    expect(countShapeSamples(small, 2.5)).toBe(9)
    expect(countShapeSamples(small, 2.5, 4)).toBe(4)
    expect(countShapeSamples(blockShape("t", { x: 0.2, z: 0.2, w: 1, d: 1 }, 0, 1, 0), 2.5)).toBe(0)
  })
})

describe("writeTerrain", () => {
  it("keeps the invariant under random shape and base edits and equals a rebake from scratch bit for bit", () => {
    const rand = mulberry32(20260923)
    for (const res of [1, 2, 4] as const) {
      let level = terrainLevel(res)
      const { samplesX, samplesZ } = sampleCounts(grid, res)
      const truth = new Float32Array(samplesX * samplesZ)
      let nextId = 0
      for (let step = 0; step < 30; step++) {
        const ids = Object.keys(level.terrainEdits?.shapes ?? {})
        const r = rand()
        if (r < 0.35 || ids.length === 0) {
          level = edit(level, { upsert: [randomShape(rand, `s${nextId++}`)] })
        } else if (r < 0.5) {
          const id = ids[Math.floor(rand() * ids.length)]
          const moved = translateShape(level.terrainEdits!.shapes[id], { x: (rand() - 0.5) * 30, y: (rand() - 0.5) * 4, z: (rand() - 0.5) * 30 })
          if (moved) level = edit(level, { upsert: [{ ...moved, order: Math.floor(rand() * 4) }] })
        } else if (r < 0.62) {
          level = edit(level, { remove: [ids[Math.floor(rand() * ids.length)]] })
        } else {
          // Base edit: garbage everywhere in the lattice, authoritative only inside the rect.
          const lattice = baseLattice(level, grid)
          for (let k = 0; k < lattice.heights.length; k++) lattice.heights[k] += 1000
          const rect: Rect = { x: rand() * 90, z: rand() * 50, w: rand() * 40, d: rand() * 30 }
          const w = latticeWindow(lattice, rect) ?? { sx0: 0, sx1: -1, sz0: 0, sz1: -1 }
          for (let sz = w.sz0; sz <= w.sz1; sz++) {
            for (let sx = w.sx0; sx <= w.sx1; sx++) {
              const k = sz * samplesX + sx
              const u = rand()
              const v = u < 0.1 ? -0 : u < 0.15 ? 0 : u < 0.18 ? 600 : (rand() - 0.5) * 20
              lattice.heights[k] = v
              truth[k] = canonical(v)
            }
          }
          level = edit(level, { base: { lattice, rects: [rect] } })
        }
        checkInvariant(level, grid, truth)
      }
      // From scratch: the painted base alone, then every shape in one write.
      const fresh = edit(createLevel({ heightmap: writeHeights(createHeightmap(res), grid, truth) }), {
        upsert: Object.values(level.terrainEdits?.shapes ?? {}),
        rebake: "all",
      })
      expect(fresh.heightmap).toEqual(level.heightmap)
      expect(fresh.terrainEdits).toEqual(level.terrainEdits)
    }
  })

  it('stores all-zero base chunks as "" and restores the base when the last shape goes', () => {
    let level = edit(terrainLevel(), { upsert: [blockShape("a", { x: 10, z: 10, w: 10, d: 10 }, 0, 5, 0)] })
    expect(level.terrainEdits!.baseChunks).toEqual({ "0,0": "" })
    expect(Object.keys(level.heightmap!.chunks)).toEqual(["0,0"])
    level = edit(level, { remove: ["a"] })
    expect(level.terrainEdits).toBe(undefined)
    expect(level.heightmap!.chunks).toEqual({})
    checkInvariant(level, grid)
  })

  it("creates the heightmap at the default resolution for a level without terrain", () => {
    const level = edit(createLevel(), { upsert: [blockShape("a", { x: 0, z: 0, w: 5, d: 5 }, 0, 1, 0)] })
    expect(level.heightmap!.resolution).toBe(DEFAULT_TERRAIN_RESOLUTION)
    checkInvariant(level, grid)
    const untouched = createLevel()
    expect(edit(untouched, { remove: ["nope"], rebake: "all" })).toBe(untouched)
  })

  it("leaves padding beyond the lattice at zero", () => {
    const level = edit(terrainLevel(), { upsert: [blockShape("wide", { x: -20, z: -20, w: 200, d: 120 }, 0, 3, 0)] })
    const n = chunkSamples(2)
    const corner = decodeChunk(level.heightmap!.chunks["2,1"], 2)
    for (let lz = 0; lz < n; lz++) {
      for (let lx = 0; lx < n; lx++) {
        const inside = 32 + lx <= 40 && 16 + lz <= 24
        expect(corner[lz * n + lx]).toBe(inside ? 3 : 0)
      }
    }
    checkInvariant(level, grid)
  })

  it("produces undo-friendly patches: only touched chunks and shapes", () => {
    const hill = (x: number, z: number) => Math.sin(x / 9) * 3 + Math.cos(z / 7) * 2
    let level = terrainLevel(2, grid, hill)
    level = edit(level, { upsert: [blockShape("far", { x: 85, z: 45, w: 10, d: 10 }, 0, 6, 0)] })
    const block = blockShape("near", { x: 5, z: 5, w: 10, d: 10 }, 0, 9, 1)
    const [next, patches, inverse] = produceWithPatches(level, (d) => {
      writeTerrain(d, grid, { upsert: [block] })
    })
    const paths = patches.map((p) => p.path.join("/")).sort()
    expect(paths).toEqual(["heightmap/chunks/0,0", "terrainEdits/baseChunks/0,0", "terrainEdits/shapes/near"])
    expect(applyPatches(next, inverse)).toEqual(level)
    checkInvariant(next, grid)
    // Moving it across a chunk boundary touches the old and the new chunks only.
    const moved = translateShape(next.terrainEdits!.shapes.near, { x: 40, y: 0, z: 0 })!
    const [, movePatches] = produceWithPatches(next, (d) => {
      writeTerrain(d, grid, { upsert: [moved] })
    })
    expect(movePatches.map((p) => p.path.join("/")).sort()).toEqual([
      "heightmap/chunks/0,0",
      "heightmap/chunks/1,0",
      "terrainEdits/baseChunks/0,0",
      "terrainEdits/baseChunks/1,0",
      "terrainEdits/shapes/near",
    ])
    // Re-upserting an equal shape, or rebaking, changes nothing.
    const [, none] = produceWithPatches(next, (d) => {
      writeTerrain(d, grid, {
        upsert: [{ ...next.terrainEdits!.shapes.near, points: next.terrainEdits!.shapes.near.points.map((p) => ({ ...p })) }],
        rebake: "all",
      })
    })
    expect(none).toEqual([])
  })

  it("stores normalised copies of upserted shapes", () => {
    const s = { ...blockShape("a", { x: 0, z: 0, w: 5, d: 5 }, 0, 1, 0), name: undefined, extra: 1 } as TerrainShape
    const level = edit(terrainLevel(), { upsert: [s] })
    expect(Object.keys(level.terrainEdits!.shapes.a).sort()).toEqual(["base", "id", "kind", "op", "order", "points"])
  })

  it("refuses mismatched lattices and invalid shapes without writing", () => {
    const level = edit(terrainLevel(), { upsert: [blockShape("a", { x: 0, z: 0, w: 5, d: 5 }, 0, 1, 0)] })
    const wrongRes = baseLattice(terrainLevel(4), grid)
    const wrongGrid = baseLattice(level, { ...grid, width: 21 })
    const good = blockShape("b", { x: 20, z: 0, w: 5, d: 5 }, 0, 1, 0)
    // A simple 65-gon: invalid only for its vertex count.
    const tooMany = shape(
      "c",
      Array.from({ length: TERRAIN_SHAPE_MAX_POINTS + 1 }, (_, k) => {
        const a = (2 * Math.PI * k) / (TERRAIN_SHAPE_MAX_POINTS + 1)
        return { x: 50 + 10 * Math.cos(a), y: 1, z: 30 + 10 * Math.sin(a) }
      })
    )
    const invalid: TerrainShape[] = [
      shape(
        "bow",
        pts([
          [0, 0],
          [10, 10],
          [10, 0],
          [0, 10],
        ])
      ),
      { ...good, points: [...good.points].reverse() },
      { ...good, order: -1 },
      { ...good, id: "bad id" },
      { ...good, id: "__proto__" },
      { ...good, name: "x".repeat(2001) },
      { ...good, order: 1.5 },
      { ...good, base: 501 },
      { ...good, points: good.points.map((p) => ({ ...p, y: -600 })) },
      { ...good, points: good.points.map((p, k) => (k === 0 ? { ...p, x: NaN } : p)) },
      tooMany,
    ]
    const edits = [
      { base: { lattice: wrongRes, rects: [{ x: 0, z: 0, w: 10, d: 10 }] } },
      { base: { lattice: wrongGrid, rects: [{ x: 0, z: 0, w: 10, d: 10 }] } },
      ...invalid.map((s) => ({ upsert: [good, s] })),
    ]
    expect(isSimplePolygon(tooMany.points)).toBe(true)
    for (const e of edits) {
      const [next, patches] = produceWithPatches(level, (d) => {
        expect(writeTerrain(d, grid, e)).toBe(false)
      })
      expect(patches).toEqual([])
      expect(next).toBe(level)
    }
  })

  it("reads shapes changed earlier in the same recipe", () => {
    const level = edit(terrainLevel(), { upsert: [blockShape("a", { x: 0, z: 0, w: 5, d: 5 }, 0, 1, 0)] })
    const next = produce(level, (d) => {
      writeTerrain(d, grid, { upsert: [blockShape("b", { x: 50, z: 30, w: 5, d: 5 }, 0, 2, 1)] })
      writeTerrain(d, grid, { remove: ["a"] })
    })
    expect(Object.keys(next.terrainEdits!.shapes)).toEqual(["b"])
    checkInvariant(next, grid)
  })
})

describe("level operations", () => {
  const hill = (x: number, z: number) => 2 + Math.sin(x / 11) * 3 + z / 20
  function sculpted(res: Heightmap["resolution"] = 2): { level: Level; truth: Float32Array } {
    const level = edit(terrainLevel(res, grid, hill), {
      upsert: [
        blockShape("pit", { x: 10, z: 10, w: 30, d: 30 }, 0, -6, 0),
        blockShape("pillar", { x: 20, z: 20, w: 10, d: 10 }, -6, 12, 1),
        rampShape("ramp", { x: 60, z: 5, w: 20, d: 30 }, 0, 0, 8, 2),
      ],
    })
    return { level, truth: baseLattice(terrainLevel(res, grid, hill), grid).heights }
  }

  it("nextShapeOrder is max + 1, 0 without shapes", () => {
    expect(nextShapeOrder(terrainLevel())).toBe(0)
    expect(nextShapeOrder(sculpted().level)).toBe(3)
  })

  it("resampleTerrain resamples the base and rebakes the shapes sharply", () => {
    const { level } = sculpted(2)
    const r = resampleTerrain(level, grid, 4)
    expect(r.heightmap!.resolution).toBe(4)
    // Reference: today's levelOps resampling of the base alone (bilinear on the source triangles).
    const baseHm = writeHeights(createHeightmap(2), grid, baseLattice(level, grid).heights)
    const { samplesX, samplesZ } = sampleCounts(grid, 4)
    const s = sampleSpacing(grid.cellSize, 4)
    const truth = new Float32Array(samplesX * samplesZ)
    for (let sz = 0; sz < samplesZ; sz++)
      for (let sx = 0; sx < samplesX; sx++) truth[sz * samplesX + sx] = sampleHeight(baseHm, grid.cellSize, sx * s, sz * s, grid)
    checkInvariant(r, grid, truth)
    expect(sampleHeight(r.heightmap, grid.cellSize, 25, 25)).toBe(6)
    expect(sampleHeight(r.heightmap, grid.cellSize, 12.5, 12.5)).toBe(-6)
    expect(Object.keys(r.terrainEdits!.shapes).sort()).toEqual(["pillar", "pit", "ramp"])
    expect(resampleTerrain(level, grid, 2).heightmap).toBe(level.heightmap)
    expect(resampleTerrain(createLevel(), grid, 4)).toEqual({ heightmap: createHeightmap(4) })
  })

  it("cropTerrainToGrid crops the base and re-exposes shapes when the grid grows back", () => {
    const { level, truth } = sculpted()
    const small = { ...grid, width: 13 }
    const cropped = cropTerrainToGrid(level, small, grid)
    const { samplesX: sxSmall, samplesZ } = sampleCounts(small, 2)
    const { samplesX } = sampleCounts(grid, 2)
    const smallTruth = new Float32Array(sxSmall * samplesZ)
    for (let sz = 0; sz < samplesZ; sz++) for (let sx = 0; sx < sxSmall; sx++) smallTruth[sz * sxSmall + sx] = truth[sz * samplesX + sx]
    checkInvariant(cropped, small, smallTruth)
    expect(sampleHeight(cropped.heightmap, grid.cellSize, 70, 30, small)).toBe(0)
    const regrown = cropTerrainToGrid(cropped, grid, small)
    const regrownTruth = new Float32Array(truth.length)
    for (let sz = 0; sz < samplesZ; sz++) for (let sx = 0; sx < sxSmall; sx++) regrownTruth[sz * samplesX + sx] = truth[sz * samplesX + sx]
    checkInvariant(regrown, grid, regrownTruth)
    expect(sampleHeight(regrown.heightmap, grid.cellSize, 70, 35, grid)).toBeCloseTo(8, 5)
    expect(cropTerrainToGrid(level, { ...grid, diagonalRule: "5-10-5" } as typeof grid, grid).heightmap).toBe(level.heightmap)
  })

  it("flattenTerrain zeroes the base and keeps the shapes", () => {
    const { level } = sculpted()
    const r = flattenTerrain(level, grid)
    const { samplesX, samplesZ } = sampleCounts(grid, 2)
    const baked = checkInvariant(r, grid, new Float32Array(samplesX * samplesZ))
    expect(r.terrainEdits!.shapes).toEqual(level.terrainEdits!.shapes)
    expect(Object.values(r.terrainEdits!.baseChunks).every((v) => v === "")).toBe(true)
    expect(baked.heights[Math.round(25 / 2.5) * baked.samplesX + 10]).toBe(6)
  })

  it("clearTerrainShapes turns the base into the heightmap", () => {
    const { level, truth } = sculpted()
    const r = clearTerrainShapes(level, grid)
    expect(r.terrainEdits).toBe(undefined)
    checkInvariant(r, grid, truth)
    expect(r.heightmap).toEqual(terrainLevel(2, grid, hill).heightmap)
  })

  it("applyShapesToBase bakes the lowest shapes into the base exactly and deletes them", () => {
    const { level, truth } = sculpted()
    const r = applyShapesToBase(level, grid, ["pit", "nope"])
    expect(Object.keys(r.terrainEdits!.shapes).sort()).toEqual(["pillar", "ramp"])
    expect(r.heightmap).toEqual(level.heightmap)
    const expectedBase: HeightLattice = { ...baseLattice(level, grid), heights: Float32Array.from(truth) }
    bakeRegion(expectedBase, [level.terrainEdits!.shapes.pit], null)
    checkInvariant(r, grid, expectedBase.heights)
    // Delta form on a draft: patches only where the pit was.
    const [, patches] = produceWithPatches(level, (d) => {
      writeTerrain(d, grid, applyShapesEdit(d, grid, ["pit"])!)
    })
    for (const p of patches) expect(p.path.join("/")).toMatch(/^(heightmap\/chunks\/[01],[01]|terrainEdits\/(baseChunks\/[01],[01]|shapes\/pit))$/)
    expect(applyShapesEdit(level, grid, ["nope"])).toBe(null)
    // Applying everything leaves no terrainEdits and the same heightmap.
    const all = applyShapesToBase(level, grid, ["pit", "pillar", "ramp"])
    expect(all.terrainEdits).toBe(undefined)
    expect(all.heightmap).toEqual(level.heightmap)
  })

  it("applyShapesToBase also applies the older shapes under the selection, so the heightmap never changes", () => {
    // Creation order: a pillar in a pit, a trench cut into a platform, a chain of overlapping blocks, and
    // an older block apart from everything.
    const level = edit(terrainLevel(2, grid, hill), {
      upsert: [
        blockShape("pit", { x: 10, z: 5, w: 30, d: 30 }, 0, -6, 0),
        blockShape("pillar", { x: 20, z: 15, w: 10, d: 10 }, -6, 10, 1),
        blockShape("platform", { x: 55, z: 5, w: 30, d: 30 }, 0, 5, 2),
        blockShape("trench", { x: 65, z: 10, w: 5, d: 20 }, 5, -8, 3),
        blockShape("c1", { x: 5, z: 40, w: 20, d: 15 }, 0, 3, 4),
        rampShape("c2", { x: 20, z: 40, w: 20, d: 15 }, 1, 0, 6, 5),
        blockShape("c3", { x: 35, z: 45, w: 15, d: 10 }, 0, -2, 6),
        blockShape("apart", { x: 85, z: 45, w: 10, d: 10 }, 0, 2, 0),
      ],
    })
    const top = (l: TerrainLevel, x: number, z: number) => sampleHeight(l.heightmap, grid.cellSize, x, z, grid)
    const left = (r: TerrainLevel) => Object.keys(r.terrainEdits?.shapes ?? {}).sort()
    expect(top(level, 25, 20)).toBeCloseTo(4, 5)
    expect(top(level, 67.5, 20)).toBeCloseTo(-3, 5)

    // The pillar: the pit (older, under it) is applied too, and the pillar still stands.
    expect(applyShapesClosure(level, ["pillar"]).map((s) => s.id)).toEqual(["pit", "pillar"])
    const pillar = applyShapesToBase(level, grid, ["pillar"])
    expect(left(pillar)).toEqual(["apart", "c1", "c2", "c3", "platform", "trench"])
    expect(pillar.heightmap).toEqual(level.heightmap)
    expect(top(pillar, 25, 20)).toBeCloseTo(4, 5)
    checkInvariant(pillar, grid)
    // The trench: the platform is applied too, and the trench does not fill back in.
    const trench = applyShapesToBase(level, grid, ["trench"])
    expect(left(trench)).toEqual(["apart", "c1", "c2", "c3", "pillar", "pit"])
    expect(trench.heightmap).toEqual(level.heightmap)
    expect(top(trench, 67.5, 20)).toBeCloseTo(-3, 5)
    checkInvariant(trench, grid)
    // Transitive: c3 overlaps c2, which overlaps c1 (c1 does not overlap c3).
    expect(applyShapesClosure(level, ["c3"]).map((s) => s.id)).toEqual(["c1", "c2", "c3"])
    expect(applyShapesToBase(level, grid, ["c3"]).heightmap).toEqual(level.heightmap)
    // Later overlapping shapes and older shapes elsewhere stay; unknown ids are ignored.
    expect(applyShapesClosure(level, ["pit", "nope"]).map((s) => s.id)).toEqual(["pit"])
    expect(applyShapesClosure(level, ["c1"]).map((s) => s.id)).toEqual(["c1"])
    expect(applyShapesClosure(level, ["nope"])).toEqual([])
    expect(applyShapesClosure(terrainLevel(), ["pit"])).toEqual([])
    expect(applyShapesEdit(level, grid, ["trench"])!.remove).toEqual(["platform", "trench"])
  })

  it("applyShapesToBase is exact for any selection of random overlapping shapes", () => {
    const rand = mulberry32(2024)
    const left = (r: TerrainLevel) => Object.keys(r.terrainEdits?.shapes ?? {}).sort()
    for (let trial = 0; trial < 40; trial++) {
      const shapes = Array.from({ length: 8 }, (_, k) => randomShape(rand, `s${k}`))
      const level = edit(terrainLevel(2, grid, hill), { upsert: shapes })
      const ids = shapes.filter(() => rand() < 0.3).map((s) => s.id)
      const r = applyShapesToBase(level, grid, ids)
      expect(r.heightmap, `trial ${trial}`).toEqual(level.heightmap)
      const applied = applyShapesClosure(level, ids).map((s) => s.id)
      for (const id of ids) expect(applied).toContain(id)
      expect(left(r)).toEqual(
        shapes
          .map((s) => s.id)
          .filter((id) => !applied.includes(id))
          .sort()
      )
      checkInvariant(r, grid)
    }
  })

  it("hasPaintedBase tells a painted base from terrain raised only by shapes", () => {
    const flat = terrainLevel()
    expect(hasPaintedBase(flat)).toBe(false)
    expect(hasPaintedBase({ heightmap: null })).toBe(false)
    // Only a shape raises the terrain: the heightmap has chunks, the painted base is flat.
    const shaped = edit(flat, { upsert: [blockShape("b", { x: 10, z: 10, w: 10, d: 10 }, 0, 5, 0)] })
    expect(Object.keys(shaped.heightmap!.chunks).length).toBeGreaterThan(0)
    expect(hasPaintedBase(shaped)).toBe(false)
    // Painted where the shape is ("" → a stored base) and elsewhere (a heightmap chunk without a base entry).
    const under = baseLattice(shaped, grid)
    under.heights[Math.round(15 / under.spacing) * under.samplesX + Math.round(15 / under.spacing)] = 1
    expect(hasPaintedBase(edit(shaped, { base: { lattice: under, rects: [{ x: 10, z: 10, w: 10, d: 10 }] } }))).toBe(true)
    const beside = baseLattice(shaped, grid)
    beside.heights[Math.round(50 / beside.spacing) * beside.samplesX + Math.round(90 / beside.spacing)] = 1
    expect(hasPaintedBase(edit(shaped, { base: { lattice: beside, rects: [{ x: 85, z: 45, w: 10, d: 10 }] } }))).toBe(true)
    // Without shapes the heightmap is the base.
    expect(hasPaintedBase(sculpted().level)).toBe(true)
    expect(hasPaintedBase(terrainLevel(2, grid, hill))).toBe(true)
    expect(hasPaintedBase(flattenTerrain(sculpted().level, grid))).toBe(false)
  })
})

describe("factories", () => {
  it("builds canonical, valid blocks, ramps and cylinders", () => {
    const b = blockShape("b", { x: 10, z: 10, w: -5, d: 5 }, 2, 3, 4)
    expect(b).toMatchObject({ kind: "block", op: "add", order: 4, base: 2 })
    expect(b.points.every((p) => p.y === 5)).toBe(true)
    expect(shapeBounds(b)).toEqual({ x: 5, z: 10, w: 5, d: 5 })
    expect(blockShape("c", { x: 0, z: 0, w: 5, d: 5 }, 0, -2, 0).op).toBe("carve")
    const cyl = cylinderShape("y", { x: 20, z: 20 }, 5, 24, 1, 2, 0)
    expect(cyl.points.length).toBe(24)
    expect(cylinderShape("y", { x: 20, z: 20 }, 5, 500, 1, 2, 0).points.length).toBe(TERRAIN_SHAPE_MAX_POINTS)
    for (const s of [b, cyl, ...[0, 1, 2, 3].map((d) => rampShape("r", { x: 0, z: 0, w: 10, d: 20 }, d as 0 | 1 | 2 | 3, 1, 4, 0))]) {
      expect(signedArea(s.points)).toBeGreaterThan(0)
      expect(isValidTerrainShape(s)).toBe(true)
    }
  })

  it("builds flat-topped polygons in canonical order from either winding", () => {
    const l = [
      { x: 0, z: 0 },
      { x: 20, z: 0 },
      { x: 20, z: 20 },
      { x: 10, z: 20 },
      { x: 10, z: 10 },
      { x: 0, z: 10 },
    ]
    for (const footprint of [l, [...l].reverse()]) {
      const p = polygonShape("p", footprint, 1, 3, 2)
      expect(p).toMatchObject({ kind: "polygon", op: "add", order: 2, base: 1 })
      expect(p.points.map((q) => ({ x: q.x, z: q.z }))).toEqual(signedArea(l) > 0 ? l : [...l].reverse())
      expect(p.points.every((q) => q.y === 4)).toBe(true)
      expect(isValidTerrainShape(p)).toBe(true)
      // An L: the notch stays at the ground.
      expect(shapeTopAt(p, 5, 5)).toBe(4)
      expect(shapeTopAt(p, 5, 15)).toBeNull()
    }
    expect(polygonShape("q", l, 0, -2, 0).op).toBe("carve")
    // Not validated (like the other factories): a crossing outline is caught by isValidTerrainShape.
    const bowtie = polygonShape(
      "x",
      [
        { x: 0, z: 0 },
        { x: 10, z: 10 },
        { x: 10, z: 0 },
        { x: 0, z: 10 },
      ],
      0,
      1,
      0
    )
    expect(isValidTerrainShape(bowtie)).toBe(false)
  })

  it("ramps rise towards their direction", () => {
    const rect = { x: 0, z: 0, w: 10, d: 20 }
    const top = (dir: 0 | 1 | 2 | 3, x: number, z: number) => shapeTopAt(rampShape("r", rect, dir, 1, 4, 0), x, z)!
    expect([top(0, 5, 0), top(0, 5, 20)]).toEqual([1, 5])
    expect([top(1, 0, 10), top(1, 10, 10)]).toEqual([1, 5])
    expect([top(2, 5, 20), top(2, 5, 0)]).toEqual([1, 5])
    expect([top(3, 10, 10), top(3, 0, 10)]).toEqual([1, 5])
    expect(rampShape("r", rect, 0, 1, -4, 0).op).toBe("carve")
  })
})

describe("elements", () => {
  const b = blockShape("b", { x: 0, z: 0, w: 10, d: 10 }, 0, 4, 0)

  it("maps elements to top vertices", () => {
    expect(elementVertexIndices(b, { shapeId: "b", kind: "vertex", index: 2 })).toEqual([2])
    expect(elementVertexIndices(b, { shapeId: "b", kind: "edge", index: 3 })).toEqual([3, 0])
    expect(elementVertexIndices(b, { shapeId: "b", kind: "face", index: 1 })).toEqual([1, 2])
    expect(elementVertexIndices(b, { shapeId: "b", kind: "face", index: "top" })).toEqual([0, 1, 2, 3])
    expect(elementVertexIndices(b, { shapeId: "b", kind: "vertex", index: 4 })).toEqual([])
    expect(elementVertexIndices(b, { shapeId: "b", kind: "edge", index: 1.5 })).toEqual([])
  })

  it("translates vertices, refusing self-intersection, flips and out-of-range heights", () => {
    const t = translateVertices(b, [2], { x: 5, y: 1, z: 0 })!
    expect(t.points[2]).toEqual({ x: 15, y: 5, z: 10 })
    expect(t.base).toBe(0)
    expect(t).not.toBe(b)
    expect(b.points[2]).toEqual({ x: 10, y: 4, z: 10 })
    expect(translateVertices(b, [1], { x: -20, y: 0, z: 5 })).toBe(null) // crosses the opposite edge
    expect(translateVertices(b, [1, 2], { x: -20, y: 0, z: 0 })).toBe(null) // flips the orientation
    expect(translateVertices(b, [0], { x: 0, y: 600, z: 0 })).toBe(null)
    expect(translateVertices(b, [0, 1, 2, 3], { x: 3, y: 0, z: 3 })).not.toBe(null)
  })

  it("moves and rotates whole shapes", () => {
    const m = translateShape(b, { x: 1, y: 2, z: 3 })!
    expect(m.base).toBe(2)
    expect(m.points[0]).toEqual({ x: 1, y: 6, z: 3 })
    expect(translateShape(b, { x: 0, y: 499, z: 0 })).toBe(null)
    const r = rotateShapeQuarter(rampShape("r", { x: 0, z: 0, w: 10, d: 20 }, 0, 0, 4, 0), { x: 0, z: 0 }, 1)!
    expect(signedArea(r.points)).toBeCloseTo(200, 9)
    // (x, z) → (z, −x): the +Z ramp now rises towards +X.
    expect(shapeTopAt(r, 20, -5)).toBeCloseTo(4, 9)
    expect(shapeTopAt(r, 0, -5)).toBeCloseTo(0, 9)
    expect(rotateShapeQuarter(b, { x: 3, z: 3 }, 4)).toBe(b)
  })

  it("rotates by any angle about a vertical axis (the rotate ring), quarter turns exactly", () => {
    const blk = blockShape("q", { x: 0, z: 0, w: 10, d: 4 }, 0, 3, 0)
    const pivot = { x: 5, z: 2 }
    expect(rotateShape(blk, pivot, Math.PI / 2)).toEqual(rotateShapeQuarter(blk, pivot, 1))
    expect(rotateShape(blk, pivot, -Math.PI)).toEqual(rotateShapeQuarter(blk, pivot, 2))
    // 30°: area, heights, base and the pivot-centred distances are kept; the sense is +Z towards +X.
    const r = rotateShape(blk, pivot, Math.PI / 6)!
    expect(signedArea(r.points)).toBeCloseTo(40, 9)
    expect(r.base).toBe(blk.base)
    r.points.forEach((p, k) => {
      expect(p.y).toBe(blk.points[k].y)
      expect(Math.hypot(p.x - pivot.x, p.z - pivot.z)).toBeCloseTo(Math.hypot(blk.points[k].x - pivot.x, blk.points[k].z - pivot.z), 9)
    })
    // The general (trigonometric) path turns the same way as the quarter turns.
    const nearQuarter = rotateShape(blk, pivot, Math.PI / 2 + 1e-9)!
    const quarter = rotateShapeQuarter(blk, pivot, 1)!
    nearQuarter.points.forEach((p, k) => {
      expect(p.x).toBeCloseTo(quarter.points[k].x, 6)
      expect(p.z).toBeCloseTo(quarter.points[k].z, 6)
    })
    // Rotating some vertices only; a partial turn that folds the footprint is refused.
    const partial = rotateShape(blk, { x: 10, z: 2 }, 0.2, [1, 2])!
    expect(partial.points[0]).toEqual(blk.points[0])
    expect(partial.points[3]).toEqual(blk.points[3])
    expect(rotateShape(blk, { x: 10, z: 2 }, Math.PI, [1, 2])).toBe(null)
    expect(rotateShape(blk, pivot, Number.NaN)).toBe(null)
  })

  it("dissolves vertices and collapses edges, keeping at least 3 vertices", () => {
    const d = dissolveVertices(b, [1])!
    expect(d.points.length).toBe(3)
    expect(signedArea(d.points)).toBe(50)
    expect(dissolveVertices(b, [0, 1])).toBe(null)
    expect(dissolveVertices(d, [0])).toBe(null)
    const c = collapseEdge(b, 3)!
    expect(c.points).toEqual([
      { x: 10, y: 4, z: 0 },
      { x: 10, y: 4, z: 10 },
      { x: 0, y: 4, z: 5 },
    ])
    expect(collapseEdge(b, 1)!.points).toEqual([
      { x: 0, y: 4, z: 0 },
      { x: 10, y: 4, z: 5 },
      { x: 0, y: 4, z: 10 },
    ])
    expect(collapseEdge(c, 0)).toBe(null)
    expect(collapseEdge(b, 4)).toBe(null)
    // An L-shape whose reflex vertex removal would self-intersect is refused.
    const L = shape(
      "L",
      pts([
        [0, 0],
        [20, 0],
        [20, 5],
        [5, 5],
        [5, 20],
        [0, 20],
      ])
    )
    expect(dissolveVertices(L, [3])).not.toBe(null)
    expect(dissolveVertices(L, [0])).toBe(null)
  })
})

describe("rayHitShape", () => {
  const block = blockShape("b", { x: 0, z: 0, w: 10, d: 10 }, 0, 5, 0)

  it("hits the top from above and the sides from the side, never the base cap", () => {
    expect(rayHitShape(block, 10, { origin: { x: 5, y: 100, z: 5 }, direction: { x: 0, y: -1, z: 0 } })).toEqual({ t: 85, face: "top", topFace: 0 })
    const side = rayHitShape(block, 10, { origin: { x: -10, y: 12, z: 5 }, direction: { x: 1, y: 0, z: 0 } })
    expect(side).toEqual({ t: 10, face: 3, topFace: 0 })
    expect(rayHitShape(block, 10, { origin: { x: 5, y: 12, z: 30 }, direction: { x: 0, y: 0, z: -1 } })).toEqual({ t: 20, face: 2, topFace: 0 })
    expect(rayHitShape(block, 10, { origin: { x: -10, y: 9, z: 5 }, direction: { x: 1, y: 0, z: 0 } })).toBe(null)
    expect(rayHitShape(block, 10, { origin: { x: 5, y: -50, z: 5 }, direction: { x: 0, y: 1, z: 0 } })).toEqual({ t: 65, face: "top", topFace: 0 })
    expect(rayHitShape(block, 10, { origin: { x: 50, y: 100, z: 5 }, direction: { x: 0, y: -1, z: 0 } })).toBe(null)
    expect(rayHitShape(block, 10, { origin: { x: 5, y: 100, z: 5 }, direction: { x: 0, y: 1, z: 0 } })).toBe(null)
  })

  it("hits a carve's pit floor through its open top", () => {
    const pit = blockShape("p", { x: 0, z: 0, w: 10, d: 10 }, 0, -5, 0)
    expect(rayHitShape(pit, 10, { origin: { x: 5, y: 100, z: 5 }, direction: { x: 0, y: -1, z: 0 } })).toEqual({ t: 95, face: "top", topFace: 0 })
    const dir = { x: 1 / Math.sqrt(5), y: -2 / Math.sqrt(5), z: 0 }
    const hit = rayHitShape(pit, 10, { origin: { x: -4, y: 20, z: 5 }, direction: dir })!
    expect(hit.face).toBe("top")
    expect(-4 + hit.t * dir.x).toBeCloseTo(3.5, 9)
    // Looking into the pit sideways from inside hits the far wall (inner side of face 1, x = 10).
    expect(rayHitShape(pit, 10, { origin: { x: 5, y: 7, z: 5 }, direction: { x: 1, y: 0, z: 0 } })).toEqual({ t: 5, face: 1, topFace: 0 })
  })

  it("follows a sloped top and rejects non-finite rays", () => {
    const r = rampShape("r", { x: 0, z: 0, w: 10, d: 10 }, 1, 0, 10, 0)
    expect(rayHitShape(r, 0, { origin: { x: 7, y: 50, z: 5 }, direction: { x: 0, y: -1, z: 0 } })!.t).toBeCloseTo(43, 9)
    expect(rayHitShape(r, 0, { origin: { x: NaN, y: 50, z: 5 }, direction: { x: 0, y: -1, z: 0 } })).toBe(null)
  })
})

describe("inner edges and points (loop cuts)", () => {
  // A 20×10 block at y 4 over (0, 0)–(20, 10); its edges run 0: (0,0)→(20,0), 1: →(20,10), 2: →(0,10), 3: →(0,0).
  const box = () => blockShape("b", { x: 0, z: 0, w: 20, d: 10 }, 0, 4, 0)
  const xz = (s: TerrainShape) => topVertices(s).map((p) => [p.x, p.z])
  /** Cut left to right (through the short sides), then top to bottom through the first cut. */
  const crossed = () => {
    const once = loopCut(box(), 1, [0.5])!.shape
    return { once, twice: loopCut(once, 0, [0.5])! }
  }

  it("one cut: vertices on the side and the opposite side, joined by an inner edge; the shape keeps its form", () => {
    const b = box()
    expect(loopCutRing(b, 0)).toEqual([
      [0, 1],
      [3, 2],
    ])
    const cut = loopCut(b, 0, [0.25])!
    expect(xz(cut.shape)).toEqual([
      [0, 0],
      [5, 0],
      [20, 0],
      [20, 10],
      [5, 10],
      [0, 10],
    ])
    expect(cut.shape.innerEdges).toEqual([[1, 4]])
    expect(cut.shape.innerPoints).toBeUndefined()
    expect(cut.edges).toEqual([6])
    expect(shapeEdgeEnds(cut.shape, 6)).toEqual([1, 4])
    expect(isValidTerrainShape(cut.shape)).toBe(true)
    for (const [x, z] of [
      [1, 1],
      [10, 5],
      [19, 9],
      [4.9, 3],
    ])
      expect(shapeTopAt(cut.shape, x, z)).toBeCloseTo(4, 9)
    expect(topFaces(cut.shape)).toHaveLength(2)
  })

  it("a second cut crosses the first: an interior vertex splits it, four faces", () => {
    const { once, twice } = crossed()
    expect(xz(once)).toEqual([
      [0, 0],
      [20, 0],
      [20, 5],
      [20, 10],
      [0, 10],
      [0, 5],
    ])
    expect(once.innerEdges).toEqual([[2, 5]])
    // The loop runs from the bottom side through the first cut to the top side.
    expect(loopCutRing(once, 0)).toEqual([
      [0, 1],
      [5, 2],
      [4, 3],
    ])
    const s = twice.shape
    expect(xz(s)).toEqual([
      [0, 0],
      [10, 0],
      [20, 0],
      [20, 5],
      [20, 10],
      [10, 10],
      [0, 10],
      [0, 5],
      [10, 5],
    ])
    expect(s.innerPoints).toEqual([{ x: 10, y: 4, z: 5 }])
    expect(s.innerEdges).toEqual([
      [1, 8],
      [3, 8],
      [5, 8],
      [7, 8],
    ])
    // The new edges (bottom half, top half) are selected; the first cut's halves are not.
    expect(twice.edges.map((k) => shapeEdgeEnds(s, k))).toEqual([
      [1, 8],
      [5, 8],
    ])
    expect(isValidTerrainShape(s)).toBe(true)
    expect(topFaces(s)).toHaveLength(4)
    for (const [x, z] of [
      [1, 1],
      [10, 5],
      [19, 9],
      [15, 2],
    ])
      expect(shapeTopAt(s, x, z)).toBeCloseTo(4, 9)
    // A raised crossing point is a peak: every face slopes down from it.
    const peak = translateVertices(s, [8], { x: 0, y: 3, z: 0 })!
    expect(shapeTopAt(peak, 10, 5)).toBeCloseTo(7, 9)
    expect(shapeTopAt(peak, 10, 0.5)).toBeCloseTo(4.3, 9)
    expect(shapeTopAt(peak, 0.5, 5)).toBeCloseTo(4.15, 9)
    expect(shapeTopAt(peak, 1, 1)).toBeLessThan(5)
    // A third cut runs through one half only (the left half's faces are quads too).
    const third = loopCut(s, 0, [0.5])!
    expect(third.edges).toHaveLength(2)
    expect(third.shape.innerPoints).toHaveLength(2)
    expect(topFaces(third.shape)).toHaveLength(6)
  })

  it("faces of a cut top are elements n + f in a topology-only order; rays report the face they hit", () => {
    const { twice } = crossed()
    const s = twice.shape
    const n = s.points.length
    const faces = topFaces(s)
    // Each face starts at its lowest vertex; faces sorted by their vertex lists.
    expect(faces).toEqual([
      [0, 1, 8, 7],
      [1, 2, 3, 8],
      [3, 4, 5, 8],
      [5, 6, 7, 8],
    ])
    expect(elementVertexIndices(s, { shapeId: "b", kind: "face", index: n + 2 })).toEqual([3, 4, 5, 8])
    expect(elementVertexIndices(s, { shapeId: "b", kind: "face", index: n + 4 })).toEqual([])
    expect(elementVertexIndices(s, { shapeId: "b", kind: "face", index: "top" })).toHaveLength(9)
    // A vertex move keeps the order (it depends on the topology only).
    expect(topFaces(translateVertices(s, [8], { x: 3, y: 2, z: -1 })!)).toEqual(faces)
    const down = (x: number, z: number) => ({ origin: { x, y: 50, z }, direction: { x: 0, y: -1, z: 0 } })
    expect(rayHitShape(s, 0, down(15, 8))).toMatchObject({ face: "top", topFace: 2 })
    expect(rayHitShape(s, 0, down(2, 2))).toMatchObject({ face: "top", topFace: 0 })
  })

  it("a loop through an inner edge runs both ways, with one parameter along the whole ring", () => {
    const { once } = crossed()
    // Inner edge 6 = [2, 5] runs (20, 5) → (0, 5).
    const ring = loopCutRing(once, 6)!
    expect(ring).toEqual([
      [3, 4],
      [2, 5],
      [1, 0],
    ])
    const cut = loopCut(once, 6, [0.25])!
    expect(cut.edges.map((k) => shapeEdgeEnds(cut.shape, k)!.map((i) => topVertices(cut.shape)[i].x))).toEqual([
      [15, 15],
      [15, 15],
    ])
  })

  it("several cuts; where there is no loop; too many vertices", () => {
    const three = loopCut(box(), 0, [0.75, 0.25, 0.5])!
    expect(three.shape.points).toHaveLength(10)
    expect(three.edges.map((k) => shapeEdgeEnds(three.shape, k)!.map((i) => three.shape.points[i].x))).toEqual([
      [5, 5],
      [10, 10],
      [15, 15],
    ])
    // Three parallel cuts, crossed by a fourth (through the right side, edge 4 now): three interior vertices.
    const grid = loopCut(three.shape, 4, [0.5])!
    expect(grid.shape.innerPoints).toHaveLength(3)
    expect(topFaces(grid.shape)).toHaveLength(8)
    expect(loopCutRing(cylinderShape("c", { x: 20, z: 20 }, 5, 7, 0, 2, 0), 0)).toBeNull()
    expect(loopCut(box(), 0, [0, 1])).toBeNull()
    expect(
      loopCut(
        box(),
        0,
        Array.from({ length: 31 }, (_, i) => (i + 1) / 32)
      )
    ).toBeNull()
    // A loop leaving an L-shaped footprint is invalid.
    const l = polygonShape(
      "l",
      [
        { x: 0, z: 0 },
        { x: 20, z: 0 },
        { x: 20, z: 10 },
        { x: 10, z: 10 },
        { x: 10, z: 20 },
        { x: 0, z: 20 },
      ],
      0,
      2,
      0
    )
    expect(loopCut(l, 1, [0.5])).toBeNull()
  })

  it("edits keep, re-index or drop inner edges and points (no dangling edges)", () => {
    const { once, twice } = crossed()
    const s = twice.shape
    // Moves and rotations move interior points too.
    expect(translateShape(s, { x: 1, y: 1, z: 1 })!.innerPoints).toEqual([{ x: 11, y: 5, z: 6 }])
    expect(rotateShapeQuarter(s, { x: 10, z: 5 }, 1)!.innerPoints).toEqual([{ x: 10, y: 4, z: 5 }])
    expect(rotateShape(s, { x: 0, z: 0 }, 0.3)!.innerEdges).toEqual(s.innerEdges)
    // Dissolving the crossing drops its four edges; the outline keeps the cut vertices.
    const flat = dissolveVertices(s, [8])!
    expect(flat.innerPoints).toBeUndefined()
    expect(flat.innerEdges).toBeUndefined()
    expect(flat.points).toHaveLength(8)
    // Dissolving an outline end of the first cut drops that half: the crossing stays on three edges (a T).
    const half = dissolveVertices(s, [3])!
    expect(half.innerPoints).toEqual([{ x: 10, y: 4, z: 5 }])
    expect(half.innerEdges).toHaveLength(3)
    // Removing three of the four edges leaves the last one dangling from the crossing: both go.
    const bare = removeInnerEdges(s, [0, 1, 2])!
    expect(bare.innerPoints).toBeUndefined()
    expect(bare.innerEdges).toBeUndefined()
    // Removing both halves of the first cut keeps the second as a chain through the (now straight) vertex.
    const chain = removeInnerEdges(s, [1, 3])!
    expect(chain.innerPoints).toEqual([{ x: 10, y: 4, z: 5 }])
    expect(chain.innerEdges).toEqual([
      [1, 8],
      [5, 8],
    ])
    // Removing one half leaves a T: still valid.
    expect(isValidTerrainShape(removeInnerEdges(s, [1])!)).toBe(true)
    // Collapsing an outline edge re-indexes the interior vertex.
    const collapsed = collapseEdge(s, 0)!
    expect(collapsed.innerPoints).toEqual([{ x: 10, y: 4, z: 5 }])
    expect(isValidTerrainShape(collapsed)).toBe(true)
    expect(removeInnerEdges(once, [5])).toBeNull()
  })

  it("topGraphValid: interior points inside and on edges, no crossings, simple faces, nothing detached", () => {
    const sq = [
      { x: 0, z: 0 },
      { x: 10, z: 0 },
      { x: 20, z: 0 },
      { x: 20, z: 10 },
      { x: 10, z: 10 },
      { x: 0, z: 10 },
    ]
    const c = { x: 10, y: 0, z: 5 }
    expect(topGraphValid(sq, undefined, undefined)).toBe(true)
    expect(topGraphValid(sq, undefined, [[1, 4]])).toBe(true)
    expect(
      topGraphValid(
        sq,
        [c],
        [
          [1, 6],
          [4, 6],
        ]
      )
    ).toBe(true)
    const bad: [unknown, unknown][] = [
      // An interior point on no edge, or dangling on one.
      [[c], undefined],
      [[c], [[1, 6]]],
      // Outside the footprint, or on the outline.
      [
        [{ x: 30, y: 0, z: 5 }],
        [
          [1, 6],
          [4, 6],
        ],
      ],
      [
        [{ x: 10, y: 0, z: 0 }],
        [
          [1, 6],
          [4, 6],
        ],
      ],
      // Unsorted, repeated, an outline edge, out of range.
      [undefined, [[4, 1]]],
      [
        [c],
        [
          [4, 6],
          [1, 6],
        ],
      ],
      [undefined, [[1, 2]]],
      [undefined, [[1, 9]]],
      // Crossing edges.
      [
        undefined,
        [
          [0, 3],
          [2, 5],
        ],
      ],
      // Along the outline through a vertex.
      [undefined, [[0, 2]]],
      // A detached triangle inside.
      [
        [
          { x: 5, y: 0, z: 3 },
          { x: 8, y: 0, z: 3 },
          { x: 6, y: 0, z: 6 },
        ],
        [
          [6, 7],
          [6, 8],
          [7, 8],
        ],
      ],
      // A spike: an interior vertex hanging off a vertex by two collinear edges (a face touches itself).
      [
        [
          { x: 10, y: 0, z: 3 },
          { x: 10, y: 0, z: 6 },
        ],
        [
          [1, 6],
          [6, 7],
        ],
      ],
      ["x", undefined],
    ]
    for (const [points, edges] of bad) expect(topGraphValid(sq, points, edges), JSON.stringify([points, edges])).toBe(false)
  })

  it("the writer stores them, and shapes differing only in them are different", () => {
    const level: TerrainLevel = { heightmap: null }
    const b = box()
    expect(writeTerrain(level, grid, { upsert: [b] })).toBe(true)
    const s = crossed().twice.shape
    expect(writeTerrain(level, grid, { upsert: [s] })).toBe(true)
    expect(level.terrainEdits!.shapes.b.innerPoints).toEqual([{ x: 10, y: 4, z: 5 }])
    const peak = translateVertices(s, [8], { x: 0, y: 2, z: 0 })!
    expect(writeTerrain(level, grid, { upsert: [peak] })).toBe(true)
    expect(level.terrainEdits!.shapes.b.innerPoints).toEqual([{ x: 10, y: 6, z: 5 }])
    const plain = dissolveVertices(peak, [8])!
    expect(writeTerrain(level, grid, { upsert: [plain] })).toBe(true)
    expect(level.terrainEdits!.shapes.b).not.toHaveProperty("innerPoints")
    expect(level.terrainEdits!.shapes.b).not.toHaveProperty("innerEdges")
  })
})
