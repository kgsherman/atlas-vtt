/**
 * Randomised incremental-update check: after every update() the world must hold exactly the
 * primitives a fresh build of the new scene produces, and every primitive that changed must be
 * covered by a returned dirty region (old and new bounds).
 */
import { describe, expect, it } from "vitest"

import { createConnector, createDoor, createPillar, createProp, createWall, createWindow } from "../scene/factory"
import { createHeightmap, sampleCounts, writeHeights } from "../scene/heightmap"
import type { Id, Scene, SceneObject } from "../scene/types"
import { buildOcclusionWorld } from "./index"
import { primitiveBounds } from "./primitives"
import { addLevel, flatScene, rng } from "./test-utils"
import type { DirtyRegion, OccluderPrimitive, OcclusionWorld } from "./types"
import { primitivesEqual } from "./world"

function snapshot(world: OcclusionWorld): Map<string, OccluderPrimitive> {
  return new Map(world.primitives.map((p) => [p.key, p]))
}

function covered(regions: DirtyRegion[], p: OccluderPrimitive): boolean {
  const b = primitiveBounds(p)
  if (b.minX > b.maxX) return true
  const e = 1e-9
  return regions.some(
    (r) =>
      r.levelId === p.levelId &&
      r.min.x <= b.minX + e &&
      r.min.y <= b.minY + e &&
      r.min.z <= b.minZ + e &&
      r.max.x >= b.maxX - e &&
      r.max.y >= b.maxY - e &&
      r.max.z >= b.maxZ - e
  )
}

describe("incremental update() equals a fresh build", () => {
  it("over 300 random edits", () => {
    const r = rng(123)
    const { scene: initial, levelId } = flatScene(20, 20)
    const upper = addLevel(initial, { elevation: 10 })
    let scene: Scene = initial
    const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)]
    const snap = (v: number) => Math.round(v / 5) * 5
    const randPoint = () => ({ x: snap(r() * 100), z: snap(r() * 100) })
    const objects = () => Object.values(scene.objects)
    const setObjects = (objs: Record<Id, SceneObject>) => {
      scene = { ...scene, objects: objs }
    }

    const world = buildOcclusionWorld(scene)
    let dirtyUpdates = 0
    for (let step = 0; step < 300; step++) {
      const objs = { ...scene.objects }
      const changed: Id[] = []
      const put = (o: SceneObject) => {
        objs[o.id] = o
        changed.push(o.id)
      }
      const walls = objects().filter((o) => o.type === "wall")
      const openings = objects().filter((o) => o.type === "door" || o.type === "window")
      const op = r()
      if (op < 0.25 || walls.length < 3) {
        // Add a wall sharing an endpoint with an existing one half of the time.
        const a = walls.length > 0 && r() < 0.5 ? { ...(pick(walls) as { a: { x: number; z: number } }).a } : randPoint()
        const b = randPoint()
        if (a.x !== b.x || a.z !== b.z) put(createWall(r() < 0.8 ? levelId : upper.id, a, b))
      } else if (op < 0.4) {
        const w = pick(walls)
        if (w.type === "wall") {
          const len = Math.hypot(w.b.x - w.a.x, w.b.z - w.a.z)
          put(r() < 0.5 ? createDoor(w, len / 2, { width: Math.min(4, len) }) : createWindow(w, len / 3, { width: Math.min(3, len / 2) }))
        }
      } else if (op < 0.55 && openings.length > 0) {
        const o = pick(openings)
        if (o.type === "door") put({ ...o, state: pick(["open", "closed", "locked"] as const), style: pick(["wood", "portcullis"] as const) })
        else if (o.type === "window") put({ ...o, offset: o.offset + 1 })
      } else if (op < 0.7) {
        // Move a wall endpoint (joints of neighbours change).
        const w = pick(walls)
        if (w.type === "wall") {
          const b = randPoint()
          if (b.x !== w.a.x || b.z !== w.a.z) put({ ...w, b })
        }
      } else if (op < 0.78) {
        // Delete a wall with its openings.
        const w = pick(walls)
        delete objs[w.id]
        changed.push(w.id)
        for (const o of openings) {
          if ((o.type === "door" || o.type === "window") && o.wallId === w.id) {
            delete objs[o.id]
            changed.push(o.id)
          }
        }
      } else if (op < 0.88) {
        put(
          r() < 0.5
            ? createPillar(levelId, randPoint(), { size: 1 + r() })
            : createProp(levelId, pick(["crate", "tree", "barrel"] as const), { x: r() * 100, y: 0, z: r() * 100 }, { rotationY: r() * 6 })
        )
      } else if (op < 0.94) {
        const p = randPoint()
        put(createConnector(levelId, upper.id, { x: p.x, z: p.z, w: 5, d: 10 }, pick([0, 1, 2, 3] as const), pick(["stairs", "ladder"] as const)))
      } else {
        const floors = objects().filter((o) => o.type === "floor" && o.levelId === upper.id)
        if (floors.length === 0) {
          const f = { id: `upper-floor-${step}`, type: "floor" as const, levelId: upper.id, rect: { x: 0, z: 0, w: 60, d: 60 }, material: "wood" as const }
          put(f)
        } else {
          const f = floors[0]
          if (f.type === "floor") put({ ...f, rect: { ...f.rect, w: f.rect.w === 60 ? 80 : 60 } })
        }
      }
      if (changed.length === 0) continue

      const before = snapshot(world)
      setObjects(objs)
      const dirty = world.update(scene, changed)
      if (dirty.length > 0) dirtyUpdates++
      const after = snapshot(world)
      const fresh = snapshot(buildOcclusionWorld(scene))

      expect([...after.keys()].sort()).toEqual([...fresh.keys()].sort())
      for (const [key, p] of fresh) expect(primitivesEqual(after.get(key)!, p)).toBe(true)

      for (const [key, p] of after) {
        const old = before.get(key)
        if (old && primitivesEqual(old, p)) continue
        expect(covered(dirty, p)).toBe(true)
        if (old) expect(covered(dirty, old)).toBe(true)
      }
      for (const [key, old] of before) if (!after.has(key)) expect(covered(dirty, old)).toBe(true)
    }
    expect(dirtyUpdates).toBeGreaterThan(150)
    expect(world.primitives.length).toBeGreaterThan(100)
  })
})

describe("incremental updateTerrain() equals a fresh build", () => {
  it("over 40 random brush strokes", () => {
    const r = rng(77)
    const { scene: initial, levelId } = flatScene(16, 16)
    const upper = addLevel(initial, { elevation: 12 })
    let scene: Scene = initial
    const objs: Record<Id, SceneObject> = { ...scene.objects }
    const put = (o: SceneObject) => (objs[o.id] = o)
    for (let k = 0; k < 12; k++) {
      const a = { x: r() * 80, z: r() * 80 }
      const w = createWall(levelId, a, { x: a.x + (r() - 0.5) * 30, z: a.z + (r() - 0.5) * 30 })
      put(w)
      if (k % 3 === 0) put(createDoor(w, 3, { width: 2 }))
      put(createProp(levelId, "tree", { x: r() * 80, y: 0, z: r() * 80 }, { rotationY: r() }))
      put(createPillar(levelId, { x: r() * 80, z: r() * 80 }, { shape: k % 2 ? "round" : "square", height: 6 }))
    }
    put(createConnector(levelId, upper.id, { x: 30, z: 30, w: 10, d: 15 }, 1))
    scene = { ...scene, objects: objs, levels: { ...scene.levels } }
    // Start with a (flat) heightmap so strokes are pure terrain edits.
    const hm = createHeightmap(2)
    scene.levels[levelId] = { ...scene.levels[levelId], heightmap: hm }
    const world = buildOcclusionWorld(scene)
    const { samplesX, samplesZ } = sampleCounts(scene.grid, 2)
    let dense = new Float32Array(samplesX * samplesZ)
    for (let stroke = 0; stroke < 40; stroke++) {
      const cx = r() * 80
      const cz = r() * 80
      const radius = 3 + r() * 8
      dense = dense.slice()
      for (let j = 0; j < samplesZ; j++) {
        for (let i = 0; i < samplesX; i++) {
          const d = Math.hypot(i * 2.5 - cx, j * 2.5 - cz)
          if (d <= radius) dense[j * samplesX + i] += (r() - 0.3) * 2 * (1 - d / radius)
        }
      }
      const rect = { x: cx - radius, z: cz - radius, w: 2 * radius, d: 2 * radius }
      const level = scene.levels[levelId]
      scene = { ...scene, levels: { ...scene.levels, [levelId]: { ...level, heightmap: writeHeights(level.heightmap!, scene.grid, dense, rect) } } }
      const before = snapshot(world)
      const dirty = world.updateTerrain(scene, levelId, rect)
      const after = snapshot(world)
      const fresh = snapshot(buildOcclusionWorld(scene))
      expect([...after.keys()].sort()).toEqual([...fresh.keys()].sort())
      for (const [key, p] of fresh) expect(primitivesEqual(after.get(key)!, p)).toBe(true)
      for (const [key, p] of after) {
        const old = before.get(key)
        if (!old || primitivesEqual(old, p) || p.shape === "heightfield") continue
        expect(covered(dirty, p)).toBe(true)
        expect(covered(dirty, old)).toBe(true)
      }
      // Patched per-cell Y ranges: queries agree with a freshly built world near the stroke.
      const freshWorld = buildOcclusionWorld(scene)
      for (let q = 0; q < 150; q++) {
        const a = { x: cx + (r() - 0.5) * 40, y: r() * 6 - 1, z: cz + (r() - 0.5) * 40 }
        const b = { x: cx + (r() - 0.5) * 40, y: r() * 6 - 1, z: cz + (r() - 0.5) * 40 }
        expect(world.segmentBlocked(a, b, { channel: "sight" })).toBe(freshWorld.segmentBlocked(a, b, { channel: "sight" }))
      }
      // Heightfield dirty regions stay local to the stroke.
      for (const d of dirty) {
        expect(d.min.x).toBeGreaterThanOrEqual(rect.x - 40)
        expect(d.max.x).toBeLessThanOrEqual(rect.x + rect.w + 40)
      }
    }
  })
})
