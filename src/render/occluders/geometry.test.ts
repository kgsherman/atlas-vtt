import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { primitiveContains } from "@/core/occlusion"
import type { WallStrip } from "@/core/occlusion/types"

import {
  boxInstanceMatrix,
  cylinderInstanceMatrix,
  heightfieldChunks,
  PRISM_RADIUS_SCALE,
  PRISM_SIDES,
  stripTriangles,
  TriangleSink,
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

describe("wall strip proxies", () => {
  const strip = (o: Partial<WallStrip> = {}): WallStrip => ({
    key: "w",
    sourceId: "w",
    sourceType: "wall",
    levelId: "L1",
    blocks: { movement: true, light: true, sight: true },
    shape: "strip",
    center: { x: 30, z: -12 },
    halfExtents: { x: 6, z: 0.25 },
    yaw: 0.9,
    knots: [-6, -3.5, 0.25, 2, 6],
    top: [9, 10.5, 7.25, 7.25, 12],
    bottom: 1.5,
    ...o,
  })
  const trianglesOf = (st: WallStrip) => {
    const sink = new TriangleSink()
    stripTriangles(st, sink)
    return sink.toArray()
  }
  /** Exact volume: thickness × area under the piecewise-linear top. */
  const volumeOf = (st: WallStrip) => {
    let a = 0
    for (let i = 0; i + 1 < st.knots.length; i++) a += ((st.knots[i + 1] - st.knots[i]) * (st.top[i] + st.top[i + 1] - 2 * st.bottom)) / 2
    return a * 2 * st.halfExtents.z
  }

  it("is closed, outward-wound and has the strip's volume", () => {
    for (const st of [strip(), strip({ yaw: -2.3 }), strip({ yaw: 0, knots: [-6, 6], top: [4, 9] })]) {
      const pos = trianglesOf(st)
      expectClosed(pos)
      expect(signedVolume(pos)).toBeCloseTo(volumeOf(st), 3)
    }
  })

  it("stays closed where the top touches the bottom (a lintel clamped to the lowest top)", () => {
    const st = strip({ knots: [-6, 0, 6], top: [4, 1.5, 4] })
    const pos = trianglesOf(st)
    expectClosed(pos)
    expect(signedVolume(pos)).toBeCloseTo(volumeOf(st), 3)
  })

  it("puts every vertex on the strip's surface in the core yaw convention", () => {
    const st = strip()
    const pos = trianglesOf(st)
    for (let k = 0; k < pos.length; k += 3) {
      const p = { x: pos[k], y: pos[k + 1], z: pos[k + 2] }
      expect(primitiveContains(st, p, 1e-4), JSON.stringify(p)).toBe(true)
      // Pushed away from the centre line across the wall (local ±z), it is outside.
      const lz = Math.sin(st.yaw) * (p.x - st.center.x) + Math.cos(st.yaw) * (p.z - st.center.z)
      const side = lz >= 0 ? 1 : -1
      const out = { x: p.x + Math.sin(st.yaw) * side * 0.01, y: p.y, z: p.z + Math.cos(st.yaw) * side * 0.01 }
      expect(primitiveContains(st, out, 1e-4)).toBe(false)
    }
    // Local +x end at the top: world centre + (cos·6, −sin·6).
    const tip = [st.center.x + Math.cos(st.yaw) * 6, 12, st.center.z - Math.sin(st.yaw) * 6]
    let found = false
    for (let k = 0; k < pos.length; k += 3) {
      if (Math.hypot(pos[k] - tip[0], pos[k + 2] - tip[2]) < 0.26 && Math.abs(pos[k + 1] - tip[1]) < 1e-4) found = true
    }
    expect(found).toBe(true)
  })
})
