import * as THREE from "three"
import { describe, expect, it } from "vitest"

import type { GridSettings } from "@/core/scene/types"

import { GroundSampler } from "../builders/ground"
import { gridGeometry, GridOverlay } from "./grid"

const grid = (width: number, depth: number): GridSettings => ({ cellSize: 5, width, depth, diagonalRule: "5-5-5", visionOrigin: "square" })

/** Dense lattice sampler (resolution `res`) of h(x, z) on a level at `elevation`. */
function sampler(g: GridSettings, res: number, elevation: number, h: (x: number, z: number) => number): GroundSampler {
  const sx = g.width * res + 1
  const sz = g.depth * res + 1
  const s = g.cellSize / res
  const heights = new Float32Array(sx * sz)
  for (let j = 0; j < sz; j++) for (let i = 0; i < sx; i++) heights[j * sx + i] = h(i * s, j * s)
  return GroundSampler.fromDense({ elevation }, g, heights)!
}

function overlayOn(g: GridSettings, ground: GroundSampler): { overlay: GridOverlay; pos: THREE.BufferAttribute } {
  const overlay = new GridOverlay()
  overlay.setLevel(g, ground, "level", 0)
  return { overlay, pos: overlay.mesh.geometry.getAttribute("position") as THREE.BufferAttribute }
}

const hill = (x: number, z: number) => Math.sin(x / 7) * 2 + Math.cos(z / 5)

describe("grid overlay: refreshHeights (terrain previews)", () => {
  it("moves exactly the vertices of the dirty rect grown by one sample, to the new terrain", () => {
    const g = grid(12, 10)
    const res = 2
    const before = sampler(g, res, 3, hill)
    const { overlay, pos } = overlayOn(g, before)
    const old = (pos.array as Float32Array).slice()
    const after = sampler(g, res, 3, (x, z) => hill(x, z) + 4)
    const dirty = { x: 12.5, z: 20, w: 10, d: 7.5 }
    expect(overlay.refreshHeights(after, dirty)).toBe(true)
    // What a fresh build on the new terrain puts there.
    const fresh = gridGeometry(60, 50, after).getAttribute("position")
    const s = g.cellSize / res
    const nx = g.width * res
    let moved = 0
    for (let k = 0; k < pos.count; k++) {
      const i = k % (nx + 1)
      const j = Math.floor(k / (nx + 1))
      const inside = i >= dirty.x / s - 1 && i <= (dirty.x + dirty.w) / s + 1 && j >= dirty.z / s - 1 && j <= (dirty.z + dirty.d) / s + 1
      expect(pos.getX(k)).toBe(old[k * 3])
      expect(pos.getZ(k)).toBe(old[k * 3 + 2])
      if (inside) {
        expect(pos.getY(k), `${i},${j}`).toBeCloseTo(fresh.getY(k), 5)
        moved++
      } else expect(pos.getY(k), `${i},${j}`).toBe(old[k * 3 + 1])
    }
    expect(moved).toBe(7 * 6)
    overlay.dispose()
  })

  it("uploads the touched rows as one range, merged with the ranges not uploaded yet", () => {
    const g = grid(8, 6)
    const ground = sampler(g, 1, 0, hill)
    const { overlay, pos } = overlayOn(g, ground)
    const row = (g.width + 1) * 3
    pos.clearUpdateRanges()
    overlay.refreshHeights(ground, { x: 10, z: 10, w: 5, d: 5 })
    // Samples 1..4 (the rect 2..3 grown by one) on rows 1..4: from row 1's first to row 4's last (one
    // bufferSubData, not one per row).
    expect(pos.updateRanges).toEqual([{ start: row + 3, count: 3 * row + 4 * 3 }])
    // Full-width rows.
    pos.clearUpdateRanges()
    overlay.refreshHeights(ground, { x: 0, z: 10, w: 40, d: 5 })
    expect(pos.updateRanges).toEqual([{ start: row, count: 4 * row }])
    // Pending ranges of an earlier preview are kept until the upload (a corner: two partial rows).
    overlay.refreshHeights(ground, { x: 0, z: 0, w: 0, d: 0 })
    expect(pos.updateRanges).toEqual([{ start: 0, count: 5 * row }])
    expect(pos.version).toBeGreaterThan(0)
    overlay.dispose()
  })

  it("grows existing bounds by union and leaves missing ones to be computed lazily", () => {
    const g = grid(10, 10)
    const flatish = sampler(g, 2, 0, () => 0.5)
    const { overlay } = overlayOn(g, flatish)
    const geometry = overlay.mesh.geometry
    geometry.computeBoundingBox()
    geometry.computeBoundingSphere()
    const spike = sampler(g, 2, 0, (x, z) => (Math.abs(x - 25) < 3 && Math.abs(z - 25) < 3 ? 30 : 0.5))
    overlay.refreshHeights(spike, { x: 20, z: 20, w: 10, d: 10 })
    const pos = geometry.getAttribute("position") as THREE.BufferAttribute
    const v = new THREE.Vector3()
    for (let k = 0; k < pos.count; k++) {
      v.fromBufferAttribute(pos, k)
      expect(geometry.boundingBox!.containsPoint(v), `${k}: ${v.toArray()}`).toBe(true)
      expect(geometry.boundingSphere!.distanceToPoint(v)).toBeLessThanOrEqual(1e-4)
    }
    expect(geometry.boundingBox!.max.y).toBeGreaterThan(30)

    // No bounds yet: none are made up (three computes them from the positions when asked).
    const other = overlayOn(g, flatish).overlay
    other.refreshHeights(spike, null)
    expect(other.mesh.geometry.boundingSphere).toBeNull()
    other.mesh.geometry.computeBoundingBox()
    expect(other.mesh.geometry.boundingBox!.max.y).toBeGreaterThan(30)
    overlay.dispose()
    other.dispose()
  })

  it("refuses geometry it cannot update in place (flat grid, other lattice spacing)", () => {
    const g = grid(6, 6)
    const flat = new GroundSampler(0, 5, 7, 7, null)
    const { overlay } = overlayOn(g, flat)
    expect(overlay.refreshHeights(sampler(g, 2, 0, hill), null)).toBe(false)
    overlay.setLevel(g, sampler(g, 2, 0, hill), "level", 1)
    expect(overlay.refreshHeights(sampler(g, 4, 0, hill), null)).toBe(false)
    expect(overlay.refreshHeights(flat, null)).toBe(false)
    expect(overlay.refreshHeights(sampler(g, 2, 0, hill), { x: 500, z: 500, w: 5, d: 5 })).toBe(true)
    overlay.dispose()
  })

  it("a 100 × 100 ft preview on a 200 × 200-cell level at resolution 4 stays well inside the 4 ms budget", () => {
    const g = grid(200, 200)
    const base = sampler(g, 4, 0, hill)
    const { overlay, pos } = overlayOn(g, base)
    expect(pos.count).toBe(801 * 801)
    overlay.mesh.geometry.computeBoundingSphere()
    const raised = sampler(g, 4, 0, (x, z) => hill(x, z) + 1)
    const times: number[] = []
    for (let k = 0; k < 25; k++) {
      pos.clearUpdateRanges()
      const t0 = performance.now()
      overlay.refreshHeights(k % 2 ? raised : base, { x: 400 + k, z: 450, w: 100, d: 100 })
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(4)
    overlay.dispose()
  })
})
