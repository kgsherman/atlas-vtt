/**
 * Selection / hover / hidden-object outlines: feature edges of the triangles an object owns, whether
 * it lives in a merged level mesh (triangle ranges), an InstancedMesh (one instance) or its own mesh
 * (door leaves, which animate, so their outline is parented to the leaf).
 */
import * as THREE from "three"

import type { TriRange } from "../builders/writer"

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

// Edges of shared unit geometries (instanced) and door leaves, cached per geometry.
const edgeCache = new WeakMap<THREE.BufferGeometry, THREE.EdgesGeometry>()

function cachedEdges(g: THREE.BufferGeometry): THREE.EdgesGeometry {
  let e = edgeCache.get(g)
  if (!e) {
    e = new THREE.EdgesGeometry(g, EDGE_ANGLE)
    e.userData.cached = true
    edgeCache.set(g, e)
  }
  return e
}

// Per-object edges of merged meshes, cached per mesh geometry (hovering a big floor must not
// recompute its outline on every hover change).
const rangeEdgeCache = new WeakMap<THREE.BufferGeometry, Map<string, THREE.EdgesGeometry>>()

function cachedRangeEdges(g: THREE.BufferGeometry, ranges: readonly TriRange[]): THREE.EdgesGeometry {
  let byId = rangeEdgeCache.get(g)
  if (!byId) rangeEdgeCache.set(g, (byId = new Map()))
  const key = ranges.map((r) => `${r.start}:${r.count}`).join(",")
  let e = byId.get(key)
  if (!e) {
    const tri = extractTriangles(g, ranges)
    e = new THREE.EdgesGeometry(tri, EDGE_ANGLE)
    e.userData.cached = true
    tri.dispose()
    byId.set(key, e)
  }
  return e
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
    for (const r of byId.values()) r.dispose()
    rangeEdgeCache.delete(g)
  }
}

/**
 * Outline objects for an object's mesh refs. Returned objects are either world-space LineSegments
 * (add them to the overlay root) or, for "whole" refs, children to attach to the mesh itself
 * (`attachTo` set), so the outline follows animations.
 */
export function buildOutlines(refs: readonly ObjectMeshRef[], material: THREE.LineBasicMaterial): { line: THREE.LineSegments; attachTo: THREE.Object3D | null }[] {
  const out: { line: THREE.LineSegments; attachTo: THREE.Object3D | null }[] = []
  for (const ref of refs) {
    switch (ref.kind) {
      case "ranges": {
        const line = new THREE.LineSegments(cachedRangeEdges(ref.mesh.geometry, ref.ranges), material)
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
        const line = new THREE.LineSegments(cachedEdges(ref.mesh.geometry), material)
        line.matrixAutoUpdate = false
        line.matrix.multiplyMatrices(ref.mesh.matrixWorld, m)
        out.push({ line, attachTo: null })
        break
      }
      case "whole": {
        const line = new THREE.LineSegments(cachedEdges(ref.mesh.geometry), material)
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
export function disposeOutlines(items: readonly { line: THREE.LineSegments }[]): void {
  for (const { line } of items) {
    line.removeFromParent()
    if (!line.geometry.userData.cached) line.geometry.dispose()
  }
}
