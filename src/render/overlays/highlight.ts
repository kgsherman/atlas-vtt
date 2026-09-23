/**
 * Selection / hover / hidden-object outlines: feature edges of the triangles an object owns, whether
 * it lives in a merged level mesh (triangle ranges), an InstancedMesh (one instance) or its own mesh
 * (door leaves, which animate, so their outline is parented to the leaf). Edges are drawn as
 * anti-aliased screen-space segments (materials/aaLineMaterial): the canvas has no MSAA.
 */
import * as THREE from "three"

import type { Rect } from "@/core/scene/types"
import type { TriRange } from "../builders/writer"
import { aaLineGeometry } from "../materials/aaLineMaterial"

export type ObjectMeshRef =
  | { kind: "ranges"; mesh: THREE.Mesh; ranges: TriRange[] }
  | { kind: "instance"; mesh: THREE.InstancedMesh; index: number }
  | { kind: "whole"; mesh: THREE.Mesh }

/** Positions of the given triangle ranges of a non-indexed geometry. */
export function extractTriangles(geometry: THREE.BufferGeometry, ranges: readonly TriRange[]): THREE.BufferGeometry {
  const src = geometry.getAttribute("position").array as Float32Array
  let total = 0
  for (const r of ranges) total += r.count
  const out = new Float32Array(total * 9)
  let o = 0
  for (const r of ranges) {
    out.set(src.subarray(r.start * 9, (r.start + r.count) * 9), o)
    o += r.count * 9
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(out, 3))
  return g
}

const EDGE_ANGLE = 25

/** Feature edges of a geometry (THREE.EdgesGeometry at EDGE_ANGLE): segment endpoint pairs, 6 floats per edge. */
function featureEdges(g: THREE.BufferGeometry): Float32Array {
  const edges = new THREE.EdgesGeometry(g, EDGE_ANGLE)
  const pairs = edges.getAttribute("position").array as Float32Array
  edges.dispose()
  return pairs
}

/** Anti-aliased line geometry of segment pairs, marked as cached (disposeOutlines leaves it alone). */
function outlineLines(pairs: ArrayLike<number>): THREE.BufferGeometry {
  const out = aaLineGeometry(pairs)
  out.userData.cached = true
  return out
}

// Edges of shared unit geometries (instanced) and door leaves, cached per geometry.
const edgeCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>()

function cachedEdges(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let e = edgeCache.get(g)
  if (!e) {
    e = outlineLines(featureEdges(g))
    edgeCache.set(g, e)
  }
  return e
}

/** XZ bounds (world units, closed). */
interface Bounds2 {
  x0: number
  z0: number
  x1: number
  z1: number
}

/** An object's outline in a merged mesh: its triangle ranges, their feature edges and the line geometry drawn. */
interface RangeEdges {
  ranges: TriRange[]
  pairs: Float32Array
  lines: THREE.BufferGeometry
  /** Where the mesh moved since `pairs` were computed (moveCachedEdges), patched on the next use; null = current. */
  moved: { bounds: Bounds2; reach: number } | null
}

// Per-object edges of merged meshes, cached per mesh geometry (hovering a big floor must not
// recompute its outline on every hover change).
const rangeEdgeCache = new WeakMap<THREE.BufferGeometry, Map<string, RangeEdges>>()

function cachedRangeEdges(g: THREE.BufferGeometry, ranges: readonly TriRange[]): THREE.BufferGeometry {
  let byId = rangeEdgeCache.get(g)
  if (!byId) rangeEdgeCache.set(g, (byId = new Map()))
  const key = ranges.map((r) => `${r.start}:${r.count}`).join(",")
  let e = byId.get(key)
  if (!e) {
    const tri = extractTriangles(g, ranges)
    const pairs = featureEdges(tri)
    tri.dispose()
    e = { ranges: ranges.map((r) => ({ ...r })), pairs, lines: outlineLines(pairs), moved: null }
    byId.set(key, e)
  } else if (e.moved) {
    patchRangeEdges(g, e, e.moved.bounds, e.moved.reach)
  }
  return e.lines
}

/** Free the cached outline edges of a geometry that is being disposed (level rebuilds). */
export function disposeCachedEdges(g: THREE.BufferGeometry): void {
  const e = edgeCache.get(g)
  if (e) {
    e.dispose()
    edgeCache.delete(g)
  }
  const byId = rangeEdgeCache.get(g)
  if (byId) {
    for (const r of byId.values()) r.lines.dispose()
    rangeEdgeCache.delete(g)
  }
}

/**
 * The vertices of `g` moved in place (vertically) within `rect` only (XZ; null: anywhere): a terrain mesh
 * following a commit or a cleared preview (engine moveTerrain). The outline edges cached against it are
 * patched where they may have changed, on their next use (a whole-floor recompute costs seconds on a large
 * resolution-4 level; the moves of several commits add up until then). `reach` bounds the XZ extent of a
 * triangle (a terrain mesh: the lattice diagonal). Outlines built from the old edges must be rebuilt
 * (OverlayManager.sceneChanged).
 */
export function moveCachedEdges(g: THREE.BufferGeometry, rect: Rect | null, reach: number): void {
  const e = edgeCache.get(g)
  if (e) {
    e.dispose()
    edgeCache.delete(g)
  }
  const byId = rangeEdgeCache.get(g)
  if (!byId) return
  if (!rect || !(reach >= 0)) {
    disposeCachedEdges(g)
    return
  }
  for (const entry of byId.values()) {
    const b = entry.moved?.bounds
    const bounds = { x0: rect.x, z0: rect.z, x1: rect.x + rect.w, z1: rect.z + rect.d }
    if (b) {
      bounds.x0 = Math.min(bounds.x0, b.x0)
      bounds.z0 = Math.min(bounds.z0, b.z0)
      bounds.x1 = Math.max(bounds.x1, b.x1)
      bounds.z1 = Math.max(bounds.z1, b.z1)
    }
    entry.moved = { bounds, reach: Math.max(reach, entry.moved?.reach ?? 0) }
  }
}

/**
 * Recompute an outline's edges over `moved` from the mesh as it is now, keeping the rest. An edge can only
 * have changed if one of its two triangles has a vertex in `moved`, so its midpoint lies within `reach` of
 * it (r1), and the triangles on such an edge have every vertex within `reach` of r1 (r2): the edges with
 * their midpoint in r1 are recomputed from the object's triangles with a vertex in r2.
 */
function patchRangeEdges(g: THREE.BufferGeometry, entry: RangeEdges, moved: Bounds2, reach: number): void {
  entry.moved = null
  const src = g.getAttribute("position").array as Float32Array
  const r1 = { x0: moved.x0 - reach, z0: moved.z0 - reach, x1: moved.x1 + reach, z1: moved.z1 + reach }
  const r2 = { x0: r1.x0 - reach, z0: r1.z0 - reach, x1: r1.x1 + reach, z1: r1.z1 + reach }
  const in2 = (k: number) => src[k] >= r2.x0 && src[k] <= r2.x1 && src[k + 2] >= r2.z0 && src[k + 2] <= r2.z1
  const nearTriangle = (t: number) => in2(t * 9) || in2(t * 9 + 3) || in2(t * 9 + 6)
  const midIn1 = (pairs: Float32Array, k: number) => {
    const x = (pairs[k] + pairs[k + 3]) / 2
    const z = (pairs[k + 2] + pairs[k + 5]) / 2
    return x >= r1.x0 && x <= r1.x1 && z >= r1.z0 && z <= r1.z1
  }
  // The object's triangles near the change, and their feature edges.
  let n = 0
  for (const r of entry.ranges) for (let t = r.start; t < r.start + r.count; t++) if (nearTriangle(t)) n++
  const near = new Float32Array(n * 9)
  let o = 0
  for (const r of entry.ranges) {
    for (let t = r.start; t < r.start + r.count; t++) {
      if (!nearTriangle(t)) continue
      near.set(src.subarray(t * 9, t * 9 + 9), o)
      o += 9
    }
  }
  const tri = new THREE.BufferGeometry()
  tri.setAttribute("position", new THREE.BufferAttribute(near, 3))
  const fresh = featureEdges(tri)
  tri.dispose()
  // The old edges away from the change and the fresh ones near it (partitioned by the same test).
  const old = entry.pairs
  let count = 0
  for (let k = 0; k + 5 < old.length; k += 6) if (!midIn1(old, k)) count++
  for (let k = 0; k + 5 < fresh.length; k += 6) if (midIn1(fresh, k)) count++
  const pairs = new Float32Array(count * 6)
  o = 0
  for (let k = 0; k + 5 < old.length; k += 6) {
    if (midIn1(old, k)) continue
    pairs.set(old.subarray(k, k + 6), o)
    o += 6
  }
  for (let k = 0; k + 5 < fresh.length; k += 6) {
    if (!midIn1(fresh, k)) continue
    pairs.set(fresh.subarray(k, k + 6), o)
    o += 6
  }
  entry.pairs = pairs
  entry.lines.dispose()
  entry.lines = outlineLines(pairs)
}

/** An outline object: anti-aliased edge quads (aaLineGeometry) drawn with an aaLineMaterial. */
export type OutlineMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material>

/**
 * Outline objects for an object's mesh refs. Returned objects are either world-space meshes (add them
 * to the overlay root) or, for "whole" refs, children to attach to the mesh itself (`attachTo` set),
 * so the outline follows animations. `material`: materials/aaLineMaterial.
 */
export function buildOutlines(refs: readonly ObjectMeshRef[], material: THREE.Material): { line: OutlineMesh; attachTo: THREE.Object3D | null }[] {
  const out: { line: OutlineMesh; attachTo: THREE.Object3D | null }[] = []
  for (const ref of refs) {
    switch (ref.kind) {
      case "ranges": {
        const line = new THREE.Mesh(cachedRangeEdges(ref.mesh.geometry, ref.ranges), material)
        ref.mesh.updateWorldMatrix(true, false)
        line.matrixAutoUpdate = false
        line.matrix.copy(ref.mesh.matrixWorld)
        out.push({ line, attachTo: null })
        break
      }
      case "instance": {
        const m = new THREE.Matrix4()
        ref.mesh.getMatrixAt(ref.index, m)
        ref.mesh.updateWorldMatrix(true, false)
        const line = new THREE.Mesh(cachedEdges(ref.mesh.geometry), material)
        line.matrixAutoUpdate = false
        line.matrix.multiplyMatrices(ref.mesh.matrixWorld, m)
        out.push({ line, attachTo: null })
        break
      }
      case "whole": {
        const line = new THREE.Mesh(cachedEdges(ref.mesh.geometry), material)
        out.push({ line, attachTo: ref.mesh })
        break
      }
    }
    const last = out[out.length - 1]
    last.line.renderOrder = 15
    last.line.frustumCulled = false
    last.line.raycast = () => {}
  }
  return out
}

/** Remove and free outline objects created by buildOutlines. */
export function disposeOutlines(items: readonly { line: OutlineMesh }[]): void {
  for (const { line } of items) {
    line.removeFromParent()
    if (!line.geometry.userData.cached) line.geometry.dispose()
  }
}
