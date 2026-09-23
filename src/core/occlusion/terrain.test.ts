import { describe, expect, it } from "vitest"

import { orientedRectCorners } from "../geometry/box"
import { chunkKey, createHeightmap, sampleCounts, writeHeights } from "../scene/heightmap"
import { levelGround } from "../scene/queries"
import { heightmapDiffRect, TerrainSampler } from "./terrain"
import { flatScene, paintHeightmap, rng } from "./test-utils"

describe("TerrainSampler", () => {
  it("matches levelGround (same triangle split) everywhere on the lattice", () => {
    const { scene, levelId } = flatScene(8, 8)
    scene.levels[levelId] = { ...scene.levels[levelId], elevation: 3 }
    const rand = rng(1)
    paintHeightmap(scene, levelId, () => Math.round(rand() * 80) / 10 - 2, 2)
    const t = new TerrainSampler(scene.levels[levelId], scene.grid)
    expect(t.flat).toBe(false)
    expect(t.spacing).toBe(2.5)
    const r = rng(2)
    for (let k = 0; k < 2000; k++) {
      const x = r() * 42 - 1
      const z = r() * 42 - 1
      expect(t.heightAt(x, z)).toBe(levelGround(scene, levelId, x, z))
    }
  })

  it("decodes successive heightmaps of a level incrementally (changed, added and dropped chunks)", () => {
    const { scene, levelId } = flatScene(24, 24)
    const rand = rng(5)
    paintHeightmap(scene, levelId, (x, z) => (x < 60 && z < 60 ? rand() * 5 : 0), 2)
    const check = () => {
      const t = new TerrainSampler(scene.levels[levelId], scene.grid)
      const r = rng(6)
      for (let k = 0; k < 1500; k++) {
        const x = r() * 120
        const z = r() * 120
        expect(t.heightAt(x, z)).toBe(levelGround(scene, levelId, x, z))
      }
    }
    check()
    // Change one region, add a new non-zero region, and zero the first region (its chunks are dropped).
    paintHeightmap(scene, levelId, (x, z) => (x < 60 && z < 60 ? 0 : x > 80 && z > 80 ? rand() * 3 : 0), 2)
    expect(Object.keys(scene.levels[levelId].heightmap!.chunks).length).toBeGreaterThan(0)
    check()
    paintHeightmap(scene, levelId, (x, z) => (x > 80 && z > 80 ? 1 : 0.5), 2)
    check()
  })

  it("is the level elevation without a heightmap", () => {
    const { scene, levelId } = flatScene(4, 4)
    scene.levels[levelId] = { ...scene.levels[levelId], elevation: 7 }
    const t = new TerrainSampler(scene.levels[levelId], scene.grid)
    expect(t.flat).toBe(true)
    expect(t.heightAt(3, 3)).toBe(7)
    expect(t.rangeOverPolygon(orientedRectCorners({ x: 5, z: 5 }, 3, 1, 0.4))).toEqual({ min: 7, max: 7 })
  })

  it("rangeOverPolygon is exact for the piecewise-linear surface", () => {
    const { scene, levelId } = flatScene(8, 8)
    const rand = rng(3)
    paintHeightmap(scene, levelId, () => rand() * 6, 2)
    const t = new TerrainSampler(scene.levels[levelId], scene.grid)
    const r = rng(4)
    for (let k = 0; k < 40; k++) {
      const poly = orientedRectCorners({ x: 5 + r() * 30, z: 5 + r() * 30 }, 0.5 + r() * 6, 0.25 + r() * 2, r() * Math.PI)
      const range = t.rangeOverPolygon(poly)
      // Dense sampling inside the polygon never escapes the computed range and gets close to it.
      let lo = Infinity
      let hi = -Infinity
      for (let u = 0; u <= 40; u++) {
        for (let v = 0; v <= 40; v++) {
          // Bilinear parametrisation of the (convex) quad.
          const a = poly[0]
          const b = poly[1]
          const c = poly[2]
          const d = poly[3]
          const su = u / 40
          const sv = v / 40
          const x = (1 - sv) * (a.x + (b.x - a.x) * su) + sv * (d.x + (c.x - d.x) * su)
          const z = (1 - sv) * (a.z + (b.z - a.z) * su) + sv * (d.z + (c.z - d.z) * su)
          const h = t.heightAt(x, z)
          lo = Math.min(lo, h)
          hi = Math.max(hi, h)
        }
      }
      expect(range.min).toBeLessThanOrEqual(lo + 1e-9)
      expect(range.max).toBeGreaterThanOrEqual(hi - 1e-9)
      expect(lo - range.min).toBeLessThan(0.5)
      expect(range.max - hi).toBeLessThan(0.5)
    }
  })
})

describe("heightmapDiffRect", () => {
  it("covers the changed chunks grown by one spacing; whole grid on resolution changes; null when identical", () => {
    const grid = { width: 40, depth: 40, cellSize: 5 }
    const { samplesX, samplesZ } = sampleCounts(grid, 2)
    const hm = writeHeights(createHeightmap(2), grid, new Float32Array(samplesX * samplesZ).fill(1))
    const dense = new Float32Array(samplesX * samplesZ).fill(1)
    dense[40 * samplesX + 40] = 3 // sample (40, 40) = (100, 100) ft: chunk (2, 2) at res 2 (16 samples a chunk)
    const next = writeHeights(hm, grid, dense, { x: 99, z: 99, w: 2, d: 2 })
    expect(Object.keys(next.chunks).filter((k) => next.chunks[k] !== hm.chunks[k])).toEqual([chunkKey(2, 2)])
    expect(heightmapDiffRect(hm, next, grid)).toEqual({ x: 77.5, z: 77.5, w: 42.5, d: 42.5 })
    expect(heightmapDiffRect(next, next, grid)).toBeNull()
    expect(heightmapDiffRect(hm, { ...hm }, grid)).toBeNull()
    expect(heightmapDiffRect(null, next, grid)).toEqual({ x: 0, z: 0, w: 200, d: 200 })
    expect(heightmapDiffRect(hm, { resolution: 4, chunks: {} }, grid)).toEqual({ x: 0, z: 0, w: 200, d: 200 })
    // A dropped (all-zero) chunk counts as changed.
    const dropped = { resolution: hm.resolution, chunks: { ...hm.chunks } }
    delete dropped.chunks[chunkKey(0, 0)]
    expect(heightmapDiffRect(hm, dropped, grid)).toEqual({ x: -2.5, z: -2.5, w: 42.5, d: 42.5 })
  })
})
