import * as THREE from "three"
import { describe, expect, it } from "vitest"

import {
  boxInstanceMatrix,
  cylinderInstanceMatrix,
  heightfieldChunks,
  PRISM_RADIUS_SCALE,
  PRISM_SIDES,
  unitBoxTriangles,
  unitPrismTriangles,
} from "./geometry"

/** Signed volume by the divergence theorem (positive for outward winding). */
function signedVolume(pos: Float32Array): number {
  let v = 0
  for (let k = 0; k < pos.length; k += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = pos.subarray(k, k + 9)
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  return v / 6
}

/** Every directed edge must be matched by the reverse edge equally often (closed, consistently wound). */
function expectClosed(pos: Float32Array): void {
  const key = (k: number) => `${pos[k].toFixed(5)},${pos[k + 1].toFixed(5)},${pos[k + 2].toFixed(5)}`
  const edges = new Map<string, number>()
  for (let k = 0; k < pos.length; k += 9) {
    const v = [key(k), key(k + 3), key(k + 6)]
    for (let e = 0; e < 3; e++) {
      const id = `${v[e]}>${v[(e + 1) % 3]}`
      edges.set(id, (edges.get(id) ?? 0) + 1)
    }
  }
  for (const [id, n] of edges) {
    const [a, b] = id.split(">")
    expect(edges.get(`${b}>${a}`), `edge ${id}`).toBe(n)
  }
}

describe("unit proxies", () => {
  it("unit box is closed, outward and of volume 1", () => {
    const b = unitBoxTriangles()
    expectClosed(b)
    expect(signedVolume(b)).toBeCloseTo(1, 10)
  })

  it("unit prism is closed, outward and has the unit cylinder's volume", () => {
    const p = unitPrismTriangles()
    expect(p.length / 9).toBe(PRISM_SIDES * 4)
    expectClosed(p)
    // Area-preserving radius: volume = π·0.5²·1.
    expect(signedVolume(p)).toBeCloseTo(Math.PI * 0.25, 6)
    expect(PRISM_RADIUS_SCALE).toBeGreaterThan(1)
    expect(PRISM_RADIUS_SCALE).toBeLessThan(1.014)
  })

  it("instance matrices follow the core yaw convention", () => {
    const m = boxInstanceMatrix({ center: { x: 10, y: 2, z: -3 }, halfExtents: { x: 2, y: 1, z: 0.25 }, yaw: 0.7 }, new THREE.Matrix4())
    const c = Math.cos(0.7)
    const s = Math.sin(0.7)
    // Local +X corner (lx = 2, lz = 0.25) → world (c·lx + s·lz, −s·lx + c·lz) + centre.
    const p = new THREE.Vector3(0.5, 0.5, 0.5).applyMatrix4(m)
    expect(p.x).toBeCloseTo(10 + c * 2 + s * 0.25, 10)
    expect(p.y).toBeCloseTo(3, 10)
    expect(p.z).toBeCloseTo(-3 - s * 2 + c * 0.25, 10)
    const cyl = cylinderInstanceMatrix({ base: { x: 1, y: 4, z: 2 }, radius: 1.5, height: 6 }, new THREE.Matrix4())
    const bottom = new THREE.Vector3(0.5, -0.5, 0).applyMatrix4(cyl)
    expect(bottom.toArray()).toEqual([2.5, 4, 2])
    const top = new THREE.Vector3(0, 0.5, 0).applyMatrix4(cyl)
    expect(top.y).toBe(10)
  })
})

describe("heightfield proxies", () => {
  const n = 6
  const heights = new Float32Array((n + 1) * (n + 1))
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) heights[j * (n + 1) + i] = 3 + Math.sin(i * 0.7) * 0.8 + j * 0.3
  const solid = new Uint8Array(n * n).fill(1)
  // A hole and a notch so the boundary has interior loops and concave corners.
  solid[2 * n + 2] = 0
  solid[2 * n + 3] = 0
  solid[0 * n + 5] = 0
  const hf = { originX: 10, originZ: 20, spacing: 2.5, samplesX: n + 1, samplesZ: n + 1, heights, solid, thickness: 1 }

  it("forms one closed volume = solid area × thickness across chunks", () => {
    const chunks = heightfieldChunks(hf, 4)
    expect(chunks.length).toBe(4)
    const all = new Float32Array(chunks.reduce((s, c) => s + c.positions.length, 0))
    let o = 0
    for (const c of chunks) {
      all.set(c.positions, o)
      o += c.positions.length
    }
    expectClosed(all)
    const solidCells = solid.reduce((s, v) => s + v, 0)
    expect(signedVolume(all)).toBeCloseTo(solidCells * 2.5 * 2.5 * 1, 6)
  })

  it("puts the top surface on the lattice heights", () => {
    const [chunk] = heightfieldChunks(hf, 16)
    let maxY = -Infinity
    for (let k = 1; k < chunk.positions.length; k += 3) maxY = Math.max(maxY, chunk.positions[k])
    expect(maxY).toBeCloseTo(Math.max(...heights), 5)
  })
})
