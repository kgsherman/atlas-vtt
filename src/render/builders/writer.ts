/**
 * MeshWriter accumulates non-indexed triangles with the world-mesh attributes (position, normal,
 * linear `color`, `aSurf`, `aMat`) and records which triangles belong to which scene object, so merged
 * per-level meshes can still be picked and highlighted per object (userData.ranges).
 *
 * `aMat` is the procedural surface material (MAT ids in materials/surface.ts) of the vertices written
 * while `material` is set; the world shader adds per-material detail (grout, planks, grain, ripples).
 */
import * as THREE from "three"

import { SURF } from "../internal"
import { MAT } from "../materials/surface"
import type { RGB } from "./color"

export type V3 = readonly [number, number, number]

/** Triangles [start, start + count) of a merged geometry belong to object `id`. */
export interface TriRange {
  id: string
  start: number
  count: number
}

/** Growable Float32Array. */
export class F32 {
  a: Float32Array
  n = 0
  constructor(capacity = 1024) {
    this.a = new Float32Array(capacity)
  }
  reserve(extra: number): void {
    if (this.n + extra <= this.a.length) return
    let cap = this.a.length * 2
    while (cap < this.n + extra) cap *= 2
    const next = new Float32Array(cap)
    next.set(this.a.subarray(0, this.n))
    this.a = next
  }
  push3(x: number, y: number, z: number): void {
    this.reserve(3)
    this.a[this.n++] = x
    this.a[this.n++] = y
    this.a[this.n++] = z
  }
  push1(x: number): void {
    this.reserve(1)
    this.a[this.n++] = x
  }
  toArray(): Float32Array {
    return this.a.slice(0, this.n)
  }
}

/**
 * Surface class for a face normal (ARCHITECTURE §4.1 step 3): upward faces (n.y > 0.7) are WALKABLE
 * for floors/terrain/connector tops and CAP for everything else; the rest are FACE.
 */
export function surfForNormal(ny: number, walkable: boolean): number {
  if (ny > 0.7) return walkable ? SURF.WALKABLE : SURF.CAP
  return SURF.FACE
}

export function faceNormal(a: V3, b: V3, c: V3): [number, number, number] {
  const ux = b[0] - a[0]
  const uy = b[1] - a[1]
  const uz = b[2] - a[2]
  const vx = c[0] - a[0]
  const vy = c[1] - a[1]
  const vz = c[2] - a[2]
  const nx = uy * vz - uz * vy
  const ny = uz * vx - ux * vz
  const nz = ux * vy - uy * vx
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}

export class MeshWriter {
  readonly positions = new F32()
  readonly normals = new F32()
  readonly colors = new F32()
  readonly surf = new F32(512)
  readonly mats = new F32(512)
  readonly ranges: TriRange[] = []
  /** Procedural surface material of the vertices written from now on (MAT.NONE = plain albedo). */
  material: number = MAT.NONE
  private openId: string | null = null
  private openStart = 0

  get vertexCount(): number {
    return this.positions.n / 3
  }

  get triangleCount(): number {
    return this.positions.n / 9
  }

  isEmpty(): boolean {
    return this.positions.n === 0
  }

  /** Start attributing triangles to an object (closes the previous one). */
  begin(id: string): void {
    this.end()
    this.openId = id
    this.openStart = this.triangleCount
  }

  end(): void {
    if (this.openId === null) return
    const count = this.triangleCount - this.openStart
    if (count > 0) this.ranges.push({ id: this.openId, start: this.openStart, count })
    this.openId = null
  }

  private vertex(p: V3, n: V3, c: RGB, s: number): void {
    this.positions.push3(p[0], p[1], p[2])
    this.normals.push3(n[0], n[1], n[2])
    this.colors.push3(c[0], c[1], c[2])
    this.surf.push1(s)
    this.mats.push1(this.material)
  }

  /** Flat triangle; winding a→b→c counter-clockwise seen from the front. `n` defaults to the winding normal. */
  triangle(a: V3, b: V3, c: V3, color: RGB, surf: number, n?: V3): void {
    const nn = n ?? faceNormal(a, b, c)
    this.vertex(a, nn, color, surf)
    this.vertex(b, nn, color, surf)
    this.vertex(c, nn, color, surf)
  }

  /** Triangle with per-vertex normals (smooth shading). */
  triangleSmooth(a: V3, na: V3, b: V3, nb: V3, c: V3, nc: V3, color: RGB, surf: number): void {
    this.vertex(a, na, color, surf)
    this.vertex(b, nb, color, surf)
    this.vertex(c, nc, color, surf)
  }

  /** Quad a→b→c→d counter-clockwise seen from the front (split along a–c). */
  quad(a: V3, b: V3, c: V3, d: V3, color: RGB, surf: number, n?: V3): void {
    const nn = n ?? faceNormal(a, b, c)
    this.triangle(a, b, c, color, surf, nn)
    this.triangle(a, c, d, color, surf, nn)
  }

  /** BufferGeometry with position/normal/color/aSurf/aMat, `userData.ranges`; null when empty. */
  build(): THREE.BufferGeometry | null {
    this.end()
    if (this.isEmpty()) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute("position", new THREE.BufferAttribute(this.positions.toArray(), 3))
    g.setAttribute("normal", new THREE.BufferAttribute(this.normals.toArray(), 3))
    g.setAttribute("color", new THREE.BufferAttribute(this.colors.toArray(), 3))
    g.setAttribute("aSurf", new THREE.BufferAttribute(this.surf.toArray(), 1))
    g.setAttribute("aMat", new THREE.BufferAttribute(this.mats.toArray(), 1))
    g.userData.ranges = this.ranges.slice()
    g.computeBoundingSphere()
    g.computeBoundingBox()
    return g
  }
}

/** Object id owning triangle `tri` of a geometry built by MeshWriter/terrain (binary search over ranges). */
export function rangeIdAt(ranges: readonly TriRange[] | undefined, tri: number): string | null {
  if (!ranges || ranges.length === 0) return null
  let lo = 0
  let hi = ranges.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const r = ranges[mid]
    if (tri < r.start) hi = mid - 1
    else if (tri >= r.start + r.count) lo = mid + 1
    else return r.id
  }
  return null
}
