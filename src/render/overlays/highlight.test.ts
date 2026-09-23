import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { heightmapDiffRect } from "@/core/occlusion"
import { createScene } from "@/core/scene/factory"
import { createHeightmap } from "@/core/scene/heightmap"
import { blockShape, writeTerrain } from "@/core/scene/terrainShapes"
import type { Level, Rect, Scene, TerrainShape } from "@/core/scene/types"
import { BuildContext, buildBucket } from "../builders"
import { updateTerrainGeometry } from "../builders/floors"
import { GroundSampler } from "../builders/ground"
import type { MergedBuild } from "../builders/types"
import { buildOutlines, disposeCachedEdges, moveCachedEdges, type ObjectMeshRef } from "./highlight"

/** Canonical, sorted segments of an outline's line geometry (aaLineGeometry: 4 vertices per segment). */
function segments(g: THREE.BufferGeometry): string[] {
  const a = g.getAttribute("aStart")
  const b = g.getAttribute("aEnd")
  const out: string[] = []
  const key = (x: number, y: number, z: number) => [x, y, z].map((v) => Math.round(v * 1e3)).join(",")
  for (let v = 0; v < a.count; v += 4) {
    const p = key(a.getX(v), a.getY(v), a.getZ(v))
    const q = key(b.getX(v), b.getY(v), b.getZ(v))
    out.push(p < q ? `${p} ${q}` : `${q} ${p}`)
  }
  return out.sort()
}

describe("outline edges of a terrain mesh moved in place", () => {
  const scene: Scene = createScene({ width: 40, depth: 40 })
  const levelId = Object.keys(scene.levels)[0]
  const floorId = Object.keys(scene.objects).find((id) => scene.objects[id].type === "floor")!
  const level = (shapes: TerrainShape[]): Level => {
    const l = { ...scene.levels[levelId], heightmap: createHeightmap(2) }
    writeTerrain(l, scene.grid, { upsert: shapes })
    return l
  }
  const a = (x: number) => blockShape("a", { x, z: 20, w: 30, d: 30 }, 0, 5, 0)
  const b = (h: number) => blockShape("b", { x: 120, z: 120, w: 20, d: 20 }, 0, h, 1)
  const start = level([a(20), b(3)])
  const built = buildBucket(new BuildContext({ ...scene, levels: { [levelId]: start } }), levelId, "floors").meshes.find(
    (m): m is MergedBuild => m.kind === "merged" && m.name === "terrain"
  )!
  const mesh = new THREE.Mesh(built.geometry)
  const ranges = (built.geometry.userData.ranges as { id: string; start: number; count: number }[]).filter((r) => r.id === floorId)
  const ref: ObjectMeshRef = { kind: "ranges", mesh, ranges }
  const material = new THREE.MeshBasicMaterial()
  const outline = () => buildOutlines([ref], material)[0].line.geometry
  const s = 2.5
  /**
   * Move the mesh onto `next` in place, as the engine does (moveTerrain), over the samples that changed
   * (tight, like a preview's dirty rect; a commit's changed chunks are wider).
   */
  const commit = (prev: Level, next: Level) => {
    const p = GroundSampler.forLevel(prev, scene.grid)
    const q = GroundSampler.forLevel(next, scene.grid)
    let x0 = Infinity
    let z0 = Infinity
    let x1 = -Infinity
    let z1 = -Infinity
    for (let sz = 0; sz < q.samplesZ; sz++) {
      for (let sx = 0; sx < q.samplesX; sx++) {
        if (p.sample(sx, sz) === q.sample(sx, sz)) continue
        x0 = Math.min(x0, sx * s)
        x1 = Math.max(x1, sx * s)
        z0 = Math.min(z0, sz * s)
        z1 = Math.max(z1, sz * s)
      }
    }
    const rect: Rect = { x: x0, z: z0, w: x1 - x0, d: z1 - z0 }
    expect(rect.w).toBeLessThan(heightmapDiffRect(prev.heightmap, next.heightmap, scene.grid)!.w)
    expect(updateTerrainGeometry(mesh.geometry, built.terrainOffsets!, GroundSampler.forLevel(next, scene.grid), rect, built.terrainRows)).toBeGreaterThan(0)
    const touched: Rect = { x: rect.x - s, z: rect.z - s, w: rect.w + 2 * s, d: rect.d + 2 * s }
    moveCachedEdges(mesh.geometry, touched, s * Math.SQRT2 + 1e-3)
  }
  /** The outline computed from scratch on the mesh as it is. */
  const fresh = () => {
    disposeCachedEdges(mesh.geometry)
    return segments(outline())
  }

  it("patches the cached edges where the mesh moved, on their next use, as a full recompute draws them", () => {
    const before = outline()
    expect(outline()).toBe(before)
    const initial = segments(before)
    // Block a moved 5 ft east.
    const moved = level([a(25), b(3)])
    commit(start, moved)
    const patched = outline()
    expect(patched).not.toBe(before)
    const got = segments(patched)
    expect(got).not.toEqual(initial)
    expect(got).toEqual(fresh())
    // Two commits in different places before the next use (block b raised, block a back).
    outline()
    const raised = level([a(25), b(6)])
    commit(moved, raised)
    const back = level([a(20), b(6)])
    commit(raised, back)
    const twice = segments(outline())
    expect(twice).toEqual(fresh())
    // Moved everywhere (null): recomputed whole on the next use.
    const cached = outline()
    moveCachedEdges(mesh.geometry, null, 1)
    expect(outline()).not.toBe(cached)
  })
})
