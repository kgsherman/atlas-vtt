/**
 * Selection / hover / hidden-object outlines: feature edges of the triangles an object owns, whether
 * it lives in a merged level mesh (triangle ranges), an InstancedMesh (one instance) or its own mesh
 * (door leaves, which animate, so their outline is parented to the leaf). Edges are drawn as
 * anti-aliased screen-space segments (materials/aaLineMaterial): the canvas has no MSAA.
 */
import * as THREE from "three"

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

/** Anti-aliased line geometry of a geometry's feature edges. */
function outlineGeometry(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const edges = new THREE.EdgesGeometry(g, EDGE_ANGLE)
  const out = aaLineGeometry(edges.getAttribute("position").array)
  edges.dispose()
  out.userData.cached = true
  return out
}

// Edges of shared unit geometries (instanced) and door leaves, cached per geometry.
const edgeCache = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry>()

function cachedEdges(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let e = edgeCache.get(g)
  if (!e) {
    e = outlineGeometry(g)
    edgeCache.set(g, e)
  }
  return e
}

// Per-object edges of merged meshes, cached per mesh geometry (hovering a big floor must not
// recompute its outline on every hover change).
const rangeEdgeCache = new WeakMap<THREE.BufferGeometry, Map<string, THREE.BufferGeometry>>()

function cachedRangeEdges(g: THREE.BufferGeometry, ranges: readonly TriRange[]): THREE.BufferGeometry {
  let byId = rangeEdgeCache.get(g)
  if (!byId) rangeEdgeCache.set(g, (byId = new Map()))
  const key = ranges.map((r) => `${r.start}:${r.count}`).join(",")
  let e = byId.get(key)
  if (!e) {
    const tri = extractTriangles(g, ranges)
    e = outlineGeometry(tri)
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
