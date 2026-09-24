/**
 * Cross-module consistency checks: where two modules implement the same rule independently (render
 * builders vs core/occlusion, vision vs movement ground rules) or hand data to each other (vision →
 * session → player client → occlusion/movement, editor patches → live session), they must agree.
 * Runs on the sample scenes so every feature (terrain, stairs, ladders, openings, props) is covered.
 *
 * Walls on terrain: render and occlusion share core/scene/wallProfile, so comparing their tops with each
 * other would compare one function with itself. Wall tops, door heads and sill tops are therefore also
 * checked against an independent oracle built from levelGround (core/scene/heightmap sampleHeight) and
 * the raw opening formula of ARCHITECTURE §2 "Walls on terrain".
 */
import * as THREE from "three"
import { applyPatches, type Patch } from "immer"
import { describe, expect, it } from "vitest"

import { findPath, validateMove } from "@/core/movement"
import { MoveContext } from "@/core/movement/context"
import type { PathStep } from "@/core/movement/types"
import {
  BuildContext as OcclusionContext,
  buildOcclusionWorld,
  footprintPolygon,
  primitiveBounds,
  primitiveTopAt,
  TerrainSampler,
  wallFrame as occlusionWallFrame,
} from "@/core/occlusion"
import type { OccluderPrimitive, WallStrip } from "@/core/occlusion/types"
import { LIGHT_PRESETS, PROP_LIBRARY, SIZE_FOOTPRINT } from "@/core/scene/defaults"
import {
  createConnector,
  createDoor,
  createFloor,
  createLevel,
  createLight,
  createPillar,
  createProp,
  createScene,
  createToken,
  createWall,
  createWindow,
} from "@/core/scene/factory"
import { bytesToBase64, createHeightmap, denseHeights, writeHeights } from "@/core/scene/heightmap"
import { parseScene } from "@/core/scene/schema"
import { validateReferences } from "@/core/scene/integrity"
import { effectiveFloorRects, floorRects, floorThickness, groundHeightAt, hasGroundAt, levelGround, sortedLevels, type Opening } from "@/core/scene/queries"
import { SAMPLE_SCENES, sampleById } from "@/core/scene/samples"
import { bakeRegion, baseLattice, blockShape, cylinderShape, rampShape, translateShape, writeTerrain } from "@/core/scene/terrainShapes"
import type {
  CreatureSize,
  DoorObject,
  FloorObject,
  Heightmap,
  Id,
  LightPreset,
  PropKind,
  Scene,
  SceneLike,
  SceneObject,
  WallObject,
  WindowObject,
} from "@/core/scene/types"
import { openingFrame, wallBaseKnots, wallProfile, WALL_BOTTOM_MARGIN, type WallProfile } from "@/core/scene/wallProfile"
import { applyPatchOps, createGameState, deltaFromPatches, diffViews, parsePlayerView, reduceDm, viewToScene } from "@/core/session"
import { prng, TestHost } from "@/core/session/test-utils"
import type { PatchOp, PlayerWall } from "@/core/session/types"
import { encodeGrades, encodeMask, VisionEngineImpl } from "@/core/vision"
import { SceneIndex } from "@/core/vision/sceneIndex"
import type { VisibilityResult } from "@/core/vision/types"
import { sceneChangeFromPatches } from "@/editor/sceneChange"
import { createEditorStore } from "@/editor/store"
import { buildLevel } from "@/render/builders"
import { BuildContext as RenderContext } from "@/render/builders/context"
import { pillarExtent, propPlacement } from "@/render/builders/props"
import { openingHole, wallFrame as renderWallFrame, wallPieceArea, wallPieces, wallPieceTopAt, type WallPiece } from "@/render/builders/walls"
import { boxInstanceMatrix } from "@/render/occluders/geometry"
import { OccluderProxies } from "@/render/occluders/proxies"
import { SURF } from "@/render/internal"

/**
 * Test-only fixture (not a user-facing sample): masked floors (the map-image feature) on a flat and a
 * heightmap level, rect origins off the cell grid, stairs cutting each masked floor, pillars, every
 * prop kind rotated on both levels, and a cellar slab of an explicit 0.01 ft thickness.
 */
function maskFloorFixture(): Scene {
  const scene = createScene({ name: "Mask floors", width: 12, depth: 12, groundFloor: false })
  const put = <T extends SceneObject>(o: T): T => {
    scene.objects[o.id] = o
    return o
  }
  const ground = Object.values(scene.levels)[0]
  const cellar = createLevel({ name: "Cellar", elevation: -12 })
  const upper = createLevel({ name: "Upper", elevation: 12 })
  scene.levels[cellar.id] = cellar
  scene.levels[upper.id] = upper
  const res = 4
  const hm = { resolution: res, chunks: {} } as const
  const dense = denseHeights(hm, scene.grid)
  for (let k = 0; k < dense.heights.length; k++) dense.heights[k] = Math.sin(k * 0.37) * 1.5 + Math.cos(k * 0.011) * 0.75
  scene.levels[upper.id] = { ...upper, heightmap: writeHeights(hm, scene.grid, dense.heights) }
  // Irregular masks at cellSize / 4 with an origin off the cell grid (x = 3.75).
  const spacing = scene.grid.cellSize / 4
  const masked = (levelId: Id, seed: number): FloorObject => {
    const rect = { x: 3.75, z: 2.5, w: 40, d: 45 }
    const cols = Math.round(rect.w / spacing)
    const rows = Math.round(rect.d / spacing)
    const bytes = new Uint8Array(Math.ceil((cols * rows) / 8))
    for (let v = 0; v < rows; v++) {
      for (let u = 0; u < cols; u++) {
        const k = v * cols + u
        if ((u * 7 + v * 3 + seed) % 5 !== 0 && Math.hypot(u - cols / 2, v - rows / 2) < cols / 2) bytes[k >> 3] |= 1 << (k & 7)
      }
    }
    return put({ ...createFloor(levelId, rect), mask: { spacing, cols, rows, b64: bytesToBase64(bytes) } })
  }
  masked(ground.id, 0)
  masked(upper.id, 2)
  // One thickness rule (core/scene floorThickness) for render and occlusion: a 0.01 ft slab is drawn
  // and blocks 0.01 ft thick (no visual minimum in render/builders/floors.ts).
  put({ ...createFloor(cellar.id, { x: 0, z: 0, w: 60, d: 60 }), id: "thin-slab", thickness: 0.01 })
  put(createConnector(cellar.id, ground.id, { x: 20, z: 20, w: 5, d: 15 }, 0))
  put(createConnector(ground.id, upper.id, { x: 30, z: 25, w: 10, d: 5 }, 1))
  for (const level of [ground, upper]) {
    put(createPillar(level.id, { x: 12.3, z: 17.1 }))
    put(createPillar(level.id, { x: 36.2, z: 12.4 }, { shape: "round", height: 6 }))
    Object.keys(PROP_LIBRARY).forEach((kind, k) => {
      put(createProp(level.id, kind as PropKind, { x: 6 + (k % 6) * 8.3, y: 0, z: 30 + Math.floor(k / 6) * 7.7 }, { rotationY: 0.3 + k * 0.4 }))
    })
    const t = createToken(level.id, { x: 12.5, z: 22.5 })
    scene.tokens[t.id] = t
  }
  return scene
}

/** A heightmap at `res` whose samples are h(x, z) (feet above the level elevation). */
function latticeOf(scene: Pick<Scene, "grid">, res: Heightmap["resolution"], h: (x: number, z: number) => number): Heightmap {
  const s = scene.grid.cellSize / res
  const samplesX = scene.grid.width * res + 1
  const samplesZ = scene.grid.depth * res + 1
  const dense = new Float32Array(samplesX * samplesZ)
  for (let j = 0; j < samplesZ; j++) for (let i = 0; i < samplesX; i++) dense[j * samplesX + i] = h(i * s, j * s)
  return writeHeights(createHeightmap(res), scene.grid, dense)
}

/** Bumpy slope of the terrain-walls fixture (feet above the elevation). */
const bumpySlope = (x: number, z: number) => 0.1 * x + 0.05 * z + 1.5 * Math.sin(x / 3) * Math.cos(z / 4)

/**
 * Test-only fixture (not a user-facing sample): walls on terrain. "Slope" (elevation 0, resolution 2): a
 * bumpy slope with follow-terrain walls carrying doors (closed and open) and windows (one tall enough that
 * the lowest top over it clamps its head), a diagonal wall, a joint chain, walls crossing the lattice's low
 * and high edges, and a follow-off wall with a door, buried where the slope rises above its top. "Shaped"
 * (elevation 30, resolution 4): painted terrain with terrain shapes baked in (a block, a ramp, a carved
 * cylinder and a block standing in the pit), crossed by follow and follow-off walls with openings.
 */
function terrainWallsFixture(): Scene {
  const scene = createScene({ name: "Terrain walls", width: 16, depth: 12 })
  const put = <T extends SceneObject>(o: T): T => {
    scene.objects[o.id] = o
    return o
  }
  const slope = Object.values(scene.levels)[0]
  scene.levels[slope.id] = { ...slope, name: "Slope", heightmap: latticeOf(scene, 2, bumpySlope) }
  const w1 = put(createWall(slope.id, { x: 5, z: 20 }, { x: 70, z: 20 }, { name: "W1" }))
  put(createDoor(w1, 12, { state: "closed", height: 7 }))
  put(createWindow(w1, 30, { sillHeight: 3, height: 4 }))
  put(createWindow(w1, 45, { sillHeight: 2, height: 7.5, width: 3 }))
  put(createDoor(w1, 58, { state: "open", height: 8 }))
  const w2 = put(createWall(slope.id, { x: 5, z: 26 }, { x: 45, z: 56 }, { name: "W2 diagonal", height: 8 }))
  put(createWindow(w2, 20, { sillHeight: 2.5, height: 3 }))
  put(createWall(slope.id, { x: 50, z: 30 }, { x: 75, z: 32 }, { name: "W3 chain" }))
  put(createWall(slope.id, { x: 75, z: 32 }, { x: 72, z: 57 }, { name: "W4 chain", thickness: 1 }))
  put(createWall(slope.id, { x: -10, z: 45 }, { x: 30, z: 40 }, { name: "low edge" }))
  put(createWall(slope.id, { x: 62, z: 58 }, { x: 95, z: 59 }, { name: "high edge", height: 6 }))
  const off = put(createWall(slope.id, { x: 0, z: 8 }, { x: 78, z: 8 }, { name: "OFF", height: 3, followTerrain: false }))
  put(createDoor(off, 40, { height: 2.5, width: 3 }))

  const shaped = createLevel({ name: "Shaped", elevation: 30 })
  put(createFloor(shaped.id, { x: 0, z: 0, w: 80, d: 60 }))
  // The painted base (what the brush edits) tilts gently; the shapes are baked over it.
  const level = { ...shaped, heightmap: latticeOf(scene, 4, (x, z) => 0.04 * x - 0.02 * z) }
  const baked = writeTerrain(level, scene.grid, {
    upsert: [
      blockShape("block", { x: 10, z: 10, w: 15, d: 10 }, 0, 4, 0),
      rampShape("ramp", { x: 30, z: 5, w: 10, d: 20 }, 1, 0, 6, 1),
      cylinderShape("pit", { x: 55, z: 35 }, 9, 16, 0.5, -3, 2),
      blockShape("plinth", { x: 52, z: 32, w: 4, d: 4 }, -2.5, 3.5, 3),
    ],
  })
  if (!baked) throw new Error("terrain shapes refused")
  scene.levels[shaped.id] = level
  const s1 = put(createWall(shaped.id, { x: 5, z: 15 }, { x: 75, z: 15 }, { name: "S1" }))
  put(createWindow(s1, 12, { sillHeight: 2, height: 3 }))
  put(createDoor(s1, 30, { height: 7 }))
  const s2 = put(createWall(shaped.id, { x: 40, z: 35 }, { x: 75, z: 35 }, { name: "S2 over the pit", height: 6 }))
  put(createWindow(s2, 15, { sillHeight: 1, height: 3 }))
  const s3 = put(createWall(shaped.id, { x: 5, z: 22 }, { x: 70, z: 22 }, { name: "S3 off", height: 5, followTerrain: false }))
  put(createDoor(s3, 30, { height: 4 }))

  for (const [levelId, x, z] of [
    [slope.id, 12.5, 12.5],
    [shaped.id, 67.5, 52.5],
  ] as const) {
    const t = createToken(levelId, { x, z })
    scene.tokens[t.id] = t
  }
  return scene
}

const SCENES = [
  ...SAMPLE_SCENES.map((s) => [s.id, s.build()] as const),
  ["mask-floors", maskFloorFixture()] as const,
  ["terrain-walls", terrainWallsFixture()] as const,
]

const baseId = (id: Id): Id => id.split("@")[0]

/** Volume of an occluder primitive of a wall (boxes; strips: Σ trapezoids along the knots × thickness). */
function wallPrimitiveVolume(p: OccluderPrimitive): number {
  if (p.shape === "box") return 8 * p.halfExtents.x * p.halfExtents.y * p.halfExtents.z
  if (p.shape !== "strip") throw new Error(`wall primitive ${p.key} is a ${p.shape}`)
  let area = 0
  for (let i = 0; i + 1 < p.knots.length; i++) area += ((p.knots[i + 1] - p.knots[i]) * (p.top[i] - p.bottom + p.top[i + 1] - p.bottom)) / 2
  return area * 2 * p.halfExtents.z
}

/**
 * Signed volume enclosed by triangles [first, first + count) of a soup (divergence theorem, about `o` to
 * keep float32 world positions accurate): positive when the surface is closed and wound outward.
 */
function meshVolume(pos: ArrayLike<number>, first: number, count: number, o: { x: number; y: number; z: number }): number {
  let v = 0
  for (let k = first * 9; k < (first + count) * 9; k += 9) {
    const ax = pos[k] - o.x
    const ay = pos[k + 1] - o.y
    const az = pos[k + 2] - o.z
    const bx = pos[k + 3] - o.x
    const by = pos[k + 4] - o.y
    const bz = pos[k + 5] - o.z
    const cx = pos[k + 6] - o.x
    const cy = pos[k + 7] - o.y
    const cz = pos[k + 8] - o.z
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  return v / 6
}

describe("render builders agree with core/occlusion", () => {
  for (const [name, scene] of SCENES) {
    it(`${name}: walls have the same profile, joints and solid volume`, () => {
      const octx = new OcclusionContext(scene)
      const rctx = new RenderContext(scene)
      const world = buildOcclusionWorld(scene)
      const occVolume = new Map<Id, number>()
      for (const p of world.primitives) {
        if (p.sourceType !== "wall") continue
        occVolume.set(p.sourceId, (occVolume.get(p.sourceId) ?? 0) + wallPrimitiveVolume(p))
      }
      for (const wall of Object.values(scene.objects)) {
        if (wall.type !== "wall") continue
        const o = occlusionWallFrame(octx, wall)
        const r = renderWallFrame(rctx, wall)
        expect(r === null, wall.id).toBe(o === null)
        if (!o || !r) continue
        expect(r.profile.follow, wall.id).toBe(o.profile.follow)
        expect(r.profile.bottomY, wall.id).toBeCloseTo(o.profile.bottomY, 9)
        expect(r.profile.knots, wall.id).toEqual(o.profile.knots.map((u) => expect.closeTo(u, 9)))
        for (const u of o.profile.knots) expect(r.profile.topAt(u), wall.id).toBeCloseTo(o.profile.topAt(u), 9)
        expect(r.extA > 0).toBe(octx.wallsWithEndpointAt(wall.levelId, wall.a, wall.id).length > 0)
        expect(r.extB > 0).toBe(octx.wallsWithEndpointAt(wall.levelId, wall.b, wall.id).length > 0)
        // Solid volume: render pieces (boxes and strip prisms, wallPieceArea × thickness) vs occlusion boxes and strips.
        const renderVolume = wallPieces(rctx, r).reduce((v, p) => v + wallPieceArea(p) * wall.thickness, 0)
        expect(renderVolume, wall.id).toBeCloseTo(occVolume.get(wall.id) ?? 0, 6)
      }
    })

    it(`${name}: occluder proxies instance exactly the sight/light primitives, in the core yaw convention`, () => {
      const world = buildOcclusionWorld(scene)
      const proxies = new OccluderProxies(new THREE.MeshBasicMaterial())
      proxies.rebuild(world)
      const blocking = world.primitives.filter((p) => p.blocks.light || p.blocks.sight)
      expect(proxies.primitiveCount).toBe(blocking.length)
      const m = new THREE.Matrix4()
      const v = new THREE.Vector3()
      for (const p of blocking) {
        if (p.shape !== "box") continue
        boxInstanceMatrix(p, m)
        const corners = footprintPolygon(p)!
        // Unit-cube corners at the four (±½, ·, ±½) combinations, in footprintPolygon's order-free sense.
        for (const [x, z] of [
          [-0.5, -0.5],
          [0.5, -0.5],
          [0.5, 0.5],
          [-0.5, 0.5],
        ]) {
          v.set(x, 0, z).applyMatrix4(m)
          const d = Math.min(...corners.map((c) => Math.hypot(c.x - v.x, c.z - v.z)))
          expect(d, p.key).toBeLessThan(1e-6)
        }
      }
      // Strips are merged meshes with per-vertex keys: each strip's triangles enclose its volume and lie
      // inside its bounds.
      const strips = blocking.filter((p): p is WallStrip => p.shape === "strip")
      const byKey = new Map<number, { pos: ArrayLike<number>; first: number; count: number }[]>()
      proxies.scene.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh || !mesh.name.includes("|strip|")) return
        const pos = mesh.geometry.getAttribute("position").array
        const keys = mesh.geometry.getAttribute("aKey")
        for (let t = 0; t < keys.count / 3; t++) {
          const key = keys.getX(t * 3)
          expect(keys.getX(t * 3 + 1)).toBe(key)
          expect(keys.getX(t * 3 + 2)).toBe(key)
          const list = byKey.get(key) ?? []
          const last = list[list.length - 1]
          if (last && last.pos === pos && last.first + last.count === t) last.count++
          else list.push({ pos, first: t, count: 1 })
          byKey.set(key, list)
        }
      })
      expect(byKey.size).toBe(strips.length)
      for (const p of strips) {
        const parts = byKey.get(proxies.keyId(p.key))
        expect(parts, p.key).toBeDefined()
        const origin = { x: p.center.x, y: p.bottom, z: p.center.z }
        const volume = parts!.reduce((a, q) => a + meshVolume(q.pos, q.first, q.count, origin), 0)
        expect(Math.abs(volume - wallPrimitiveVolume(p)), p.key).toBeLessThan(1e-5 * wallPrimitiveVolume(p) + 1e-4)
        const b = primitiveBounds(p)
        for (const q of parts!) {
          for (let k = q.first * 9; k < (q.first + q.count) * 9; k += 3) {
            expect(q.pos[k], p.key).toBeGreaterThanOrEqual(b.minX - 1e-4)
            expect(q.pos[k], p.key).toBeLessThanOrEqual(b.maxX + 1e-4)
            expect(q.pos[k + 1], p.key).toBeGreaterThanOrEqual(b.minY - 1e-4)
            expect(q.pos[k + 1], p.key).toBeLessThanOrEqual(b.maxY + 1e-4)
            expect(q.pos[k + 2], p.key).toBeGreaterThanOrEqual(b.minZ - 1e-4)
            expect(q.pos[k + 2], p.key).toBeLessThanOrEqual(b.maxZ + 1e-4)
          }
        }
      }
      proxies.dispose()
    })

    it(`${name}: render and occlusion sample the same (baked) terrain as levelGround`, () => {
      const octx = new OcclusionContext(scene)
      const rctx = new RenderContext(scene)
      const r = prng(7)
      const W = scene.grid.width * scene.grid.cellSize
      const D = scene.grid.depth * scene.grid.cellSize
      for (const level of sortedLevels(scene)) {
        const render = rctx.sampler(level.id)
        const occ = octx.terrain(level.id)
        expect(render.flat, level.id).toBe(level.heightmap === null)
        expect(occ.flat, level.id).toBe(level.heightmap === null)
        for (let k = 0; k < 400; k++) {
          const x = r() * W
          const z = r() * D
          const g = levelGround(scene, level.id, x, z)
          expect(render.heightAt(x, z), `${level.name} (${x}, ${z})`).toBeCloseTo(g, 6)
          expect(occ.heightAt(x, z), `${level.name} (${x}, ${z})`).toBeCloseTo(g, 6)
        }
      }
    })
  }
})

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * Independent oracle of ARCHITECTURE §2 "Walls on terrain", built on levelGround (core/scene/heightmap
 * sampleHeight, not the samplers the shared wall profile uses): the base at u (feet from a along a→b) is
 * the ground on the centreline at u clamped to [0, len] for follow-terrain walls on heightmap levels,
 * the level elevation otherwise; the top is base + height.
 */
function wallOracle(scene: SceneLike, wall: WallObject) {
  const level = scene.levels[wall.levelId]
  const follow = wall.followTerrain && level.heightmap !== null
  const len = Math.hypot(wall.b.x - wall.a.x, wall.b.z - wall.a.z)
  const dir = { x: (wall.b.x - wall.a.x) / len, z: (wall.b.z - wall.a.z) / len }
  const point = (u: number) => ({ x: wall.a.x + dir.x * u, z: wall.a.z + dir.z * u })
  const base = (u: number) => {
    if (!follow) return level.elevation
    const p = point(clamp(u, 0, len))
    return levelGround(scene, wall.levelId, p.x, p.z)
  }
  const top = (u: number) => base(u) + wall.height
  /**
   * u in (u0, u1) where the centreline crosses a lattice line x = i·s, z = j·s or a triangle diagonal
   * x − z = k·s: the ground along the wall is linear between them (brute force over the lines).
   */
  const breaks = (u0: number, u1: number): number[] => {
    if (!follow) return []
    const sp = scene.grid.cellSize / level.heightmap!.resolution
    const out: number[] = []
    const family = (f0: number, df: number) => {
      if (Math.abs(df) < 1e-12) return
      const fa = (f0 + df * u0) / sp
      const fb = (f0 + df * u1) / sp
      for (let k = Math.floor(Math.min(fa, fb)); k <= Math.ceil(Math.max(fa, fb)); k++) {
        const u = (k * sp - f0) / df
        if (u > u0 && u < u1) out.push(u)
      }
    }
    family(wall.a.x, dir.x)
    family(wall.a.z, dir.z)
    family(wall.a.x - wall.a.z, dir.x - dir.z)
    return out
  }
  const extreme = (u0: number, u1: number, pick: (a: number, b: number) => number) => [u0, u1, ...breaks(u0, u1)].map(top).reduce(pick)
  return {
    follow,
    len,
    point,
    base,
    top,
    minTop: (u0: number, u1: number) => extreme(u0, u1, (a, b) => Math.min(a, b)),
    maxTop: (u0: number, u1: number) => extreme(u0, u1, (a, b) => Math.max(a, b)),
    /** Known limit: ground is the elevation below x = 0 / z = 0 (a step the profile ramps over one knot): exact elsewhere. */
    exact: (u: number) => {
      if (!follow) return true
      const p = point(clamp(u, 0, len))
      return p.x >= 0 && p.z >= 0
    },
    /** An opening's span along the wall (openingSegment's clamp). */
    span: (o: Pick<Opening, "offset" | "width">): [number, number] => [clamp(o.offset - o.width / 2, 0, len), clamp(o.offset + o.width / 2, 0, len)],
  }
}

/** Full-height piece of a wall (not a lintel or a sill): keys `${wallId}` and `${wallId}#after:…`. */
const fullHeightPiece = (p: OccluderPrimitive, wallId: Id) => p.key === wallId || p.key.startsWith(`${wallId}#after:`)

describe("walls on terrain: tops, door heads and sill tops match the levelGround oracle", () => {
  for (const [name, scene] of SCENES) {
    it(`${name}: render pieces and occluders stand on the oracle's base line`, () => {
      const rctx = new RenderContext(scene)
      const world = buildOcclusionWorld(scene)
      const bySource = new Map<Id, OccluderPrimitive[]>()
      for (const p of world.primitives) bySource.set(p.sourceId, [...(bySource.get(p.sourceId) ?? []), p])
      const r = prng(11)
      let tops = 0
      let followTops = 0
      let openings = 0
      let clamped = 0
      const highest = (values: number[]) => values.reduce((a, b) => Math.max(a, b), -Infinity)
      for (const wall of Object.values(scene.objects)) {
        if (wall.type !== "wall") continue
        const f = renderWallFrame(rctx, wall)
        if (!f) continue
        const oracle = wallOracle(scene, wall)
        expect(f.profile.follow, wall.id).toBe(oracle.follow)
        const pieces = wallPieces(rctx, f)
        const own = bySource.get(wall.id) ?? []
        const hosted = rctx.openingsOf(wall.id).filter((o) => o.levelId === wall.levelId)
        const spans = hosted.map((o) => oracle.span(o))
        const bottom = f.profile.bottomY

        // Full-height pieces: the top line at the ends, the knots and random u outside the openings.
        const us = [-f.extA, 0, f.len, f.len + f.extB, ...f.profile.knots, ...Array.from({ length: 40 }, () => -f.extA + r() * (f.len + f.extA + f.extB))]
        for (const u of us) {
          if (!oracle.exact(u) || spans.some(([t0, t1]) => u > t0 - 1e-3 && u < t1 + 1e-3)) continue
          const expected = oracle.top(u)
          const drawn = highest(pieces.filter((p) => p.u0 - 1e-9 <= u && u <= p.u1 + 1e-9).map((p) => wallPieceTopAt(p, u)))
          expect(drawn, `${wall.id} render top at u = ${u}`).toBeCloseTo(expected, 6)
          const at = oracle.point(u)
          const blocking = highest(own.filter((p) => fullHeightPiece(p, wall.id)).map((p) => primitiveTopAt(p, at.x, at.z) ?? -Infinity))
          expect(blocking, `${wall.id} occluder top at u = ${u}`).toBeCloseTo(expected, 6)
          // The flat bottom lies below the base line.
          expect(bottom).toBeLessThanOrEqual(oracle.base(u) - WALL_BOTTOM_MARGIN + 1e-9)
          tops++
          if (oracle.follow && scene.levels[wall.levelId].heightmap) followTops++
        }

        // The bottom lies below every ground under the footprint (no light leaks under the wall), and no
        // lower than the lowest lattice sample around it extended by thickness / 2 past both ends (the
        // joint-extended footprint the profile's bottom is taken over, whether or not there is a joint).
        const half = wall.thickness / 2
        const n = { x: -(wall.b.z - wall.a.z) / oracle.len, z: (wall.b.x - wall.a.x) / oracle.len }
        let groundMin = Infinity
        for (let i = 0; i <= 40; i++) {
          const c = oracle.point(-f.extA + ((f.len + f.extA + f.extB) * i) / 40)
          for (const side of [-1, -0.5, 0, 0.5, 1]) {
            const x = c.x + n.x * half * side
            const z = c.z + n.z * half * side
            if (x >= 0 && z >= 0) groundMin = Math.min(groundMin, levelGround(scene, wall.levelId, x, z))
          }
        }
        expect(bottom, `${wall.id} bottom`).toBeLessThanOrEqual(groundMin - WALL_BOTTOM_MARGIN + 1e-9)
        const level = scene.levels[wall.levelId]
        if (level.heightmap) {
          const sp = scene.grid.cellSize / level.heightmap.resolution
          const corners = footprintOf(wall, half, half)
          let lowest = level.elevation
          const [x0, x1] = [Math.min(...corners.map((c) => c.x)), Math.max(...corners.map((c) => c.x))]
          const [z0, z1] = [Math.min(...corners.map((c) => c.z)), Math.max(...corners.map((c) => c.z))]
          for (let j = Math.floor(z0 / sp); j <= Math.ceil(z1 / sp); j++) {
            for (let i = Math.floor(x0 / sp); i <= Math.ceil(x1 / sp); i++) lowest = Math.min(lowest, levelGround(scene, wall.levelId, i * sp, j * sp))
          }
          expect(bottom, `${wall.id} bottom`).toBeGreaterThanOrEqual(Math.min(lowest, oracle.base(0), oracle.base(oracle.len)) - WALL_BOTTOM_MARGIN - 1e-6)
        } else expect(bottom).toBeCloseTo(level.elevation - WALL_BOTTOM_MARGIN, 9)

        // Openings: the raw formula (§2) with the oracle's base at the span's centre and lowest top over it.
        for (const o of hosted) {
          const [t0, t1] = oracle.span(o)
          if (t1 - t0 < 1e-6 || !oracle.exact(t0) || !oracle.exact(t1)) continue
          const H = wall.height
          const b = oracle.base((t0 + t1) / 2)
          const minTop = oracle.minTop(t0, t1)
          const maxTop = oracle.maxTop(t0, t1)
          const hole = openingHole(f, o)!
          const prims = bySource.get(o.id) ?? []
          const lintel = own.find((p) => p.key === `${wall.id}#lintel:${o.id}`)
          const sill = own.find((p) => p.key === `${wall.id}#sill:${o.id}`)
          let head: number
          if (o.type === "door") {
            head = Math.max(bottom, Math.min(b + clamp(o.height, 0, H), minTop))
            if (b + clamp(o.height, 0, H) > minTop) clamped++
            // Closed doors block from the bottom to the head; open ones not at all.
            if (o.state === "open") expect(prims).toEqual([])
            else {
              expect(prims, o.id).toHaveLength(1)
              expect(primitiveBounds(prims[0]).maxY, `${o.id} closed door top`).toBeCloseTo(head, 6)
              expect(primitiveBounds(prims[0]).minY, `${o.id} closed door bottom`).toBeCloseTo(bottom, 6)
            }
            expect(hole.y0).toBe(-Infinity)
            expect(sill).toBeUndefined()
          } else {
            const sillTop = Math.min(b + clamp(o.sillHeight, 0, H), minTop)
            head = Math.max(sillTop, Math.min(b + clamp(o.sillHeight + o.height, 0, H), minTop))
            if (b + clamp(o.sillHeight + o.height, 0, H) > minTop) clamped++
            const hasSill = o.sillHeight > 0 && sillTop - bottom >= 1e-6
            expect(sill !== undefined, `${o.id} sill`).toBe(hasSill)
            if (sill) expect(primitiveBounds(sill).maxY, `${o.id} sill top`).toBeCloseTo(sillTop, 6)
            if (hasSill) expect(hole.y0, `${o.id} render sill top`).toBeCloseTo(sillTop, 6)
            else expect(hole.y0).toBe(-Infinity)
            // Windows block movement through the whole opening, up to its highest top.
            expect(prims, o.id).toHaveLength(1)
            expect(primitiveBounds(prims[0]).maxY, `${o.id} movement box`).toBeCloseTo(maxTop, 6)
          }
          expect(hole.y1, `${o.id} render head`).toBeCloseTo(head, 6)
          // The lintel spans [head, top line] (dropped only when the head reaches the highest top).
          if (maxTop - head < 1e-6) expect(lintel).toBeUndefined()
          else {
            expect(lintel, `${o.id} lintel`).toBeDefined()
            expect(primitiveBounds(lintel!).minY, `${o.id} lintel bottom`).toBeCloseTo(head, 6)
            for (const u of [t0 + 1e-3, (t0 + t1) / 2, t1 - 1e-3]) {
              const at = oracle.point(u)
              expect(primitiveTopAt(lintel!, at.x, at.z), `${o.id} lintel top at ${u}`).toBeCloseTo(oracle.top(u), 6)
              const over = pieces.filter((p) => p.u0 <= u && u <= p.u1 && p.y0 >= head - 1e-6)
              expect(highest(over.map((p) => wallPieceTopAt(p, u))), `${o.id} render lintel top at ${u}`).toBeCloseTo(oracle.top(u), 6)
            }
          }
          openings++
        }
      }
      if (Object.values(scene.objects).some((o) => o.type === "wall")) expect(tops).toBeGreaterThan(0)
      if (name === "terrain-walls") {
        expect(followTops).toBeGreaterThan(100)
        expect(openings).toBeGreaterThanOrEqual(9)
        // The raw formula's clamp to the lowest top over the span is exercised.
        expect(clamped).toBeGreaterThan(0)
      }
    })
  }
})

/** Corners of a wall's joint-extended footprint. */
function footprintOf(wall: WallObject, extA: number, extB: number): { x: number; z: number }[] {
  const len = Math.hypot(wall.b.x - wall.a.x, wall.b.z - wall.a.z)
  const d = { x: (wall.b.x - wall.a.x) / len, z: (wall.b.z - wall.a.z) / len }
  const n = { x: -d.z * (wall.thickness / 2), z: d.x * (wall.thickness / 2) }
  const a = { x: wall.a.x - d.x * extA, z: wall.a.z - d.z * extA }
  const b = { x: wall.b.x + d.x * extB, z: wall.b.z + d.z * extB }
  return [
    { x: a.x + n.x, z: a.z + n.z },
    { x: b.x + n.x, z: b.z + n.z },
    { x: b.x - n.x, z: b.z - n.z },
    { x: a.x - n.x, z: a.z - n.z },
  ]
}

interface Extent {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

const emptyExtent = (): Extent => ({ minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity })

function grow(e: Extent, b: Extent): void {
  e.minX = Math.min(e.minX, b.minX)
  e.maxX = Math.max(e.maxX, b.maxX)
  e.minY = Math.min(e.minY, b.minY)
  e.maxY = Math.max(e.maxY, b.maxY)
  e.minZ = Math.min(e.minZ, b.minZ)
  e.maxZ = Math.max(e.maxZ, b.maxZ)
}

/** Per-object vertex extents of one render bucket's merged meshes (from userData.ranges), plus walkable triangle counts. */
function renderExtents(scene: Scene, bucket: "floors" | "connectors"): { extents: Map<Id, Extent>; walkable: Map<Id, number>; topMinY: Map<Id, number> } {
  const extents = new Map<Id, Extent>()
  const walkable = new Map<Id, number>()
  const topMinY = new Map<Id, number>()
  const ctx = new RenderContext(scene)
  for (const level of sortedLevels(scene)) {
    for (const m of buildLevel(ctx, level.id)[bucket].meshes) {
      if (m.kind !== "merged") continue
      const pos = m.geometry.getAttribute("position")
      const surf = m.geometry.getAttribute("aSurf")
      // Vertex of triangle corner k (terrain meshes are indexed).
      const index = m.geometry.index
      const vtx = (k: number) => (index ? index.getX(k) : k)
      for (const r of m.geometry.userData.ranges as { id: string; start: number; count: number }[]) {
        const e = extents.get(r.id) ?? emptyExtent()
        for (let c = r.start * 3; c < (r.start + r.count) * 3; c++) {
          const k = vtx(c)
          grow(e, { minX: pos.getX(k), maxX: pos.getX(k), minY: pos.getY(k), maxY: pos.getY(k), minZ: pos.getZ(k), maxZ: pos.getZ(k) })
        }
        extents.set(r.id, e)
        if (m.terrainOffsets && surf) {
          let n = 0
          let low = topMinY.get(r.id) ?? Infinity
          for (let t = r.start; t < r.start + r.count; t++) {
            if (surf.getX(vtx(t * 3)) !== SURF.WALKABLE) continue
            n++
            for (let c = 0; c < 3; c++) low = Math.min(low, pos.getY(vtx(t * 3 + c)))
          }
          walkable.set(r.id, (walkable.get(r.id) ?? 0) + n)
          topMinY.set(r.id, low)
        }
      }
    }
  }
  return { extents, walkable, topMinY }
}

/** Union of primitiveBounds per source id. */
function occluderExtents(scene: Scene): Map<Id, Extent> {
  const out = new Map<Id, Extent>()
  for (const p of buildOcclusionWorld(scene).primitives) {
    const e = out.get(p.sourceId) ?? emptyExtent()
    grow(e, primitiveBounds(p))
    out.set(p.sourceId, e)
  }
  return out
}

describe("render builders agree with core/occlusion: floors, connectors, pillars, props", () => {
  for (const [name, scene] of SCENES) {
    it(`${name}: floor / terrain slabs have the occluders' extents; terrain top cells = heightfield solid cells`, () => {
      const occ = occluderExtents(scene)
      const { extents, walkable, topMinY } = renderExtents(scene, "floors")
      const solid = new Map<Id, number>()
      for (const p of buildOcclusionWorld(scene).primitives) if (p.shape === "heightfield") solid.set(p.sourceId, p.solid.reduce((a, b) => a + b, 0))
      let checked = 0
      for (const o of Object.values(scene.objects)) {
        if (o.type !== "floor") continue
        const r = extents.get(o.id)
        const b = occ.get(o.id)
        expect(r === undefined, `${o.id}: rendered ${r !== undefined}, occluder ${b !== undefined}`).toBe(b === undefined)
        if (!r || !b) continue
        // Terrain meshes draw no bottom (skirts only): their slab bottom is the lowest top − thickness.
        const terrain = topMinY.get(o.id)
        for (const k of ["minX", "maxX", "minY", "maxY", "minZ", "maxZ"] as const) {
          const v = k === "minY" && terrain !== undefined ? terrain - floorThickness(scene, o) : r[k]
          expect(v, `${o.id} ${k}`).toBeCloseTo(b[k], 3)
        }
        if (solid.has(o.id)) expect(walkable.get(o.id), `${o.id} walkable triangles / 2`).toBe(2 * solid.get(o.id)!)
        checked++
      }
      expect(checked).toBeGreaterThan(0)
    })

    it(`${name}: stairs / ramps: occluder bottom = visual bottom, occluder top within the visual`, () => {
      const occ = occluderExtents(scene)
      const { extents } = renderExtents(scene, "connectors")
      for (const o of Object.values(scene.objects)) {
        if (o.type !== "connector" || o.style === "ladder") continue
        const r = extents.get(o.id)
        const b = occ.get(o.id)
        expect(r && b, o.id).toBeTruthy()
        expect(r!.minY, o.id).toBeCloseTo(b!.minY, 3)
        expect(b!.maxY, o.id).toBeLessThanOrEqual(r!.maxY + 1e-6)
      }
    })

    it(`${name}: pillars and blocking props span the same heights as their occluders`, () => {
      const occ = occluderExtents(scene)
      const ctx = new RenderContext(scene)
      for (const o of Object.values(scene.objects)) {
        if (o.type === "pillar") {
          const e = pillarExtent(ctx, o)
          const b = occ.get(o.id)
          expect(b, o.id).toBeTruthy()
          expect(e.bottom, o.id).toBeCloseTo(b!.minY, 6)
          expect(e.top, o.id).toBeCloseTo(b!.maxY, 6)
        } else if (o.type === "prop") {
          const b = occ.get(o.id)
          if (!b) continue
          const pl = propPlacement(ctx, o)
          expect(pl.bottom, `${o.kind} ${o.id}`).toBeCloseTo(b.minY, 6)
          expect(pl.top, `${o.kind} ${o.id}`).toBeCloseTo(b.maxY, 6)
        }
      }
    })
  }

  it("the mask-floor fixture exercises what it claims", () => {
    const scene = SCENES.find(([n]) => n === "mask-floors")![1]
    const parsed = parseScene(JSON.parse(JSON.stringify(scene)))
    expect(parsed.ok, parsed.ok ? "" : parsed.issues.join("\n")).toBe(true)
    expect(validateReferences(scene)).toEqual([])
    const world = buildOcclusionWorld(scene)
    // Both masked floors are cut by a stair run, one as boxes (flat), one as a heightfield.
    const floors = Object.values(scene.objects).filter((o): o is FloorObject => o.type === "floor" && o.mask !== undefined)
    expect(floors).toHaveLength(2)
    const area = (rects: { w: number; d: number }[]) => rects.reduce((a, r) => a + r.w * r.d, 0)
    for (const f of floors) expect(area(effectiveFloorRects(scene, f.levelId).map((e) => e.rect))).toBeLessThan(area(floorRects(f)) - 1)
    expect(world.primitives.some((p) => p.shape === "heightfield")).toBe(true)
    expect(world.primitives.filter((p) => p.sourceType === "prop").length).toBeGreaterThan(2 * Object.keys(PROP_LIBRARY).length - 4)
  })

  it("the terrain-walls fixture exercises what it claims", () => {
    const scene = SCENES.find(([n]) => n === "terrain-walls")![1]
    const parsed = parseScene(JSON.parse(JSON.stringify(scene)))
    expect(parsed.ok, parsed.ok ? "" : parsed.issues.join("\n")).toBe(true)
    expect(validateReferences(scene)).toEqual([])
    const world = buildOcclusionWorld(scene)
    const octx = new OcclusionContext(scene)
    const W = scene.grid.width * scene.grid.cellSize
    const [slope, shaped] = sortedLevels(scene)
    for (const level of [slope, shaped]) {
      expect(level.heightmap, level.name).not.toBeNull()
      // Sloped tops: strips on both levels, among the walls and the lintels.
      const lintels = world.primitives.filter((p) => p.shape === "strip" && p.levelId === level.id && p.key.includes("#lintel:"))
      expect(lintels.length, level.name).toBeGreaterThan(0)
      const walls = Object.values(scene.objects).filter((o): o is WallObject => o.type === "wall" && o.levelId === level.id)
      expect(walls.filter((w) => !w.followTerrain).length, level.name).toBeGreaterThan(0)
      const hosts = new Set(walls.filter((w) => w.followTerrain).map((w) => w.id))
      for (const type of ["door", "window"] as const) {
        const hosted = Object.values(scene.objects).filter((o) => o.type === type && hosts.has(o.wallId))
        expect(hosted.length, `${level.name} ${type} on a follow wall`).toBeGreaterThan(0)
      }
    }
    const slopeWalls = Object.values(scene.objects).filter((o): o is WallObject => o.type === "wall" && o.levelId === slope.id)
    // A joint chain, and walls crossing the lattice's low and high edges.
    expect(slopeWalls.some((w) => (occlusionWallFrame(octx, w)?.extA ?? 0) > 0)).toBe(true)
    expect(slopeWalls.some((w) => Math.min(w.a.x, w.b.x) < 0 && w.followTerrain)).toBe(true)
    expect(slopeWalls.some((w) => Math.max(w.a.x, w.b.x) > W && w.followTerrain)).toBe(true)
    // The buried follow-off wall: the slope rises above its top somewhere along it.
    const off = slopeWalls.find((w) => !w.followTerrain)!
    expect(levelGround(scene, slope.id, off.b.x - 1, off.b.z)).toBeGreaterThan(slope.elevation + off.height)

    // "Shaped": the heightmap is exactly its painted base with the shapes baked in (what every consumer
    // reads), and the shapes show in it.
    expect(Object.keys(shaped.terrainEdits!.shapes).sort()).toEqual(["block", "pit", "plinth", "ramp"])
    const lattice = baseLattice(shaped, scene.grid)
    const painted = Array.from(lattice.heights)
    bakeRegion(lattice, Object.values(shaped.terrainEdits!.shapes), null)
    expect(Array.from(denseHeights(shaped.heightmap!, scene.grid).heights)).toEqual(Array.from(lattice.heights))
    expect(Array.from(lattice.heights)).not.toEqual(painted)
    const E = shaped.elevation
    expect(levelGround(scene, shaped.id, 17.5, 15)).toBeCloseTo(E + 4, 5)
    expect(levelGround(scene, shaped.id, 35, 20)).toBeCloseTo(E + 3, 5)
    expect(levelGround(scene, shaped.id, 60, 35)).toBeCloseTo(E - 2.5, 5)
    expect(levelGround(scene, shaped.id, 54, 34)).toBeCloseTo(E + 1, 5)
    expect(levelGround(scene, shaped.id, 70, 55)).toBeCloseTo(E + 0.04 * 70 - 0.02 * 55, 5)
  })
})

describe("vision and movement share the ground and connector rules", () => {
  for (const [name, scene] of SCENES) {
    it(`${name}: every cell a token can stand on is sampleable by vision, at the same height`, () => {
      const world = buildOcclusionWorld(scene)
      const index = new SceneIndex(scene, world)
      const { width, depth, cellSize: s } = scene.grid
      for (const level of sortedLevels(scene)) {
        const li = index.levelIdx.get(level.id)!
        const flat = level.heightmap === null
        for (let j = 0; j < depth; j++) {
          for (let i = 0; i < width; i++) {
            const p = { x: (i + 0.5) * s, z: (j + 0.5) * s }
            if (!hasGroundAt(scene, level.id, p)) continue
            const surface = index.surfaceAt(li, p.x, p.z)
            // Heightmap floors are rasterised to lattice cells (exact for grid-aligned floors).
            if (flat) expect(Number.isNaN(surface), `${level.id} ${i},${j}`).toBe(false)
            if (!Number.isNaN(surface)) expect(surface).toBeCloseTo(groundHeightAt(scene, level.id, p), 9)
            expect(index.groundAt(li, p.x, p.z)).toBeCloseTo(groundHeightAt(scene, level.id, p), 9)
          }
        }
      }
    })

    it(`${name}: movement's cached ground equals groundHeightAt`, () => {
      const world = buildOcclusionWorld(scene)
      for (const token of Object.values(scene.tokens)) {
        const ctx = new MoveContext(scene, world, token)
        for (const level of sortedLevels(scene)) {
          for (let k = 0; k < 200; k++) {
            const p = { x: ((k * 7919) % (scene.grid.width * 100)) / 100 * scene.grid.cellSize, z: ((k * 104729) % (scene.grid.depth * 100)) / 100 * scene.grid.cellSize }
            expect(ctx.groundAt(level.id, p)).toBeCloseTo(groundHeightAt(scene, level.id, p), 9)
          }
        }
      }
    })
  }
})

/** Crooked Lantern session: every PC assigned to its own player. */
function lanternSession(edit?: (scene: Scene) => void): { host: TestHost; players: string[]; pcs: Id[] } {
  const scene = sampleById("crooked-lantern")!.build()
  edit?.(scene)
  const pcs = Object.values(scene.tokens)
    .filter((t) => t.kind === "pc")
    .map((t) => t.id)
    .sort()
  const players = pcs.map((_, k) => `p${k + 1}`)
  const host = new TestHost(scene, players)
  pcs.forEach((id, k) => host.assign(id, players[k]))
  return { host, players, pcs }
}

describe("host → player pipeline", () => {
  it("views validate, patch round-trips and rebuild into scenes whose blockers the host also has", () => {
    const { host, players } = lanternSession()
    const hostWorld = buildOcclusionWorld(host.scene)
    const hostBounds = new Map<Id, ReturnType<typeof primitiveBounds>[]>()
    for (const p of hostWorld.primitives) {
      const list = hostBounds.get(p.sourceId) ?? []
      list.push(primitiveBounds(p))
      hostBounds.set(p.sourceId, list)
    }
    for (const uid of players) {
      const { view } = host.refresh(uid)
      expect(parsePlayerView(JSON.parse(JSON.stringify(view)))).toEqual(view)
      expect(host.sent.get(uid)).toEqual(view)
      expect(applyPatchOps(view, diffViews(view, view))).toEqual(view)

      const playerScene = viewToScene(view)
      const playerWorld = buildOcclusionWorld(playerScene)
      expect(playerWorld.primitives.length).toBeGreaterThan(0)
      // With memory fresh from this very observation, every blocker the player's client builds must
      // lie inside a blocker of the same source on the host (pieces are clipped, never grown).
      for (const p of playerWorld.primitives) {
        const src = baseId(p.sourceId)
        const hostList = hostBounds.get(src)
        expect(hostList, `${uid}: ${p.key} has no host counterpart`).toBeTruthy()
        const b = primitiveBounds(p)
        // Clipped wall pieces may gain a joint extension (thickness/2) where a cut meets another wall end.
        const tol = p.sourceType === "wall" ? 0.5 : 1e-6
        const inside = hostList!.some(
          (h) => b.minX >= h.minX - tol && b.maxX <= h.maxX + tol && b.minZ >= h.minZ - tol && b.maxZ <= h.maxZ + tol && b.minY >= h.minY - 1e-6 && b.maxY <= h.maxY + 1e-6
        )
        expect(inside, `${uid}: ${p.key}`).toBe(true)
      }
    }
  })

  it("on terrain, the renderer draws the player's clipped wall pieces at the host's heights", () => {
    // A bumpy slope; wall W (2 ft thick, follow-terrain) runs past both grid edges along z = 20.5 with a
    // closed door and a window. The PC south of it sees by darkvision only, so W is explored in part and
    // sent as pieces; the lattice row z = 22.5 behind W is never sent, so the client's own clipped ground
    // under W's centreline is wrong: the pieces carry the host's base line (terrainProfile) instead.
    const scene = createScene({ width: 16, depth: 8 })
    const ground = Object.keys(scene.levels)[0]
    scene.environment = { ...scene.environment, skyLevel: "dark", ambientLevel: "dark", directional: { ...scene.environment.directional, enabled: false } }
    scene.levels[ground] = { ...scene.levels[ground], heightmap: latticeOf(scene, 2, (x, z) => 0.3 * x + 0.2 * z + Math.sin(x / 4)) }
    const wall = createWall(ground, { x: -20, z: 20.5 }, { x: 100, z: 20.5 }, { height: 12, thickness: 2 })
    scene.objects[wall.id] = wall
    const door = createDoor(wall, 40, { state: "closed", height: 7 })
    scene.objects[door.id] = door
    const win = createWindow(wall, 52, { sillHeight: 3, height: 4 })
    scene.objects[win.id] = win
    const pc = createToken(ground, { x: 22.5, z: 12.5 }, { kind: "pc", vision: { darkvision: 20, blindsight: 0, blind: false } })
    scene.tokens[pc.id] = pc
    expect(parseScene(JSON.parse(JSON.stringify(scene))).ok).toBe(true)
    const host = new TestHost(scene, ["p1"])
    host.assign(pc.id, "p1")
    const { view } = host.refresh("p1")
    const playerScene = viewToScene(view)

    /** A wall's base line computed on a scene's own terrain (the client's clipped one, or the host's). */
    const profileIn = (sc: SceneLike, w: WallObject): WallProfile => {
      const level = sc.levels[w.levelId]
      const t = new TerrainSampler(level, sc.grid)
      return wallProfile(w, t.flat ? null : t, level.elevation, { a: 0, b: 0 })
    }
    /** Solid Y spans of a wall's render pieces at wall-frame position u, clipped to y ≥ from. */
    const spansAt = (pieces: WallPiece[], u: number, from: number) =>
      pieces
        .filter((p) => p.u0 < u && u < p.u1 && wallPieceTopAt(p, u) > from)
        .map((p) => [Math.max(p.y0, from), wallPieceTopAt(p, u)])
        .sort((a, b) => a[0] - b[0])
    const hostCtx = new RenderContext(host.scene)
    const hostFrame = renderWallFrame(hostCtx, wall)!
    const hostPieces = wallPieces(hostCtx, hostFrame)
    const hostProfile = profileIn(host.scene, wall)
    const playerCtx = new RenderContext(playerScene)
    const sent = Object.values(view.objects).filter((o): o is PlayerWall => o.type === "wall" && baseId(o.id) === wall.id)
    expect(sent.length).toBeGreaterThan(0)
    const r = prng(5)
    let compared = 0
    let ownGroundWrong = 0
    for (const wire of sent) {
      const piece = playerScene.objects[wire.id] as WallObject
      expect(piece.followTerrain).toBe(true)
      // The host's base line at the piece's own base knots (its centreline), nothing else.
      expect(wire.terrainProfile).toHaveLength(wallBaseKnots(wire, 2.5).length)
      // The piece lies on W's line: its frame's u = 0 is W's u = t0.
      const t0 = Math.hypot(piece.a.x - wall.a.x, piece.a.z - wall.a.z)
      const frame = renderWallFrame(playerCtx, piece)!
      const client = profileIn(playerScene, piece)
      const bare = profileIn(playerScene, { ...piece, terrainProfile: undefined })
      let worst = 0
      for (let k = 0; k <= 30; k++) {
        const u = k === 0 ? 0 : k === 30 ? frame.len : r() * frame.len
        // Render and occlusion both stand the piece on the host's tops (world Y).
        expect(frame.profile.topAt(u), `${piece.id} render top at ${u}`).toBeCloseTo(hostProfile.topAt(t0 + u), 9)
        expect(client.topAt(u), `${piece.id} occlusion top at ${u}`).toBeCloseTo(hostProfile.topAt(t0 + u), 9)
        worst = Math.max(worst, Math.abs(bare.topAt(u) - hostProfile.topAt(t0 + u)))
      }
      if (worst > 0.1) ownGroundWrong++
      // Above both bottoms (the host's depends on terrain the player is not sent), every solid span
      // matches: the wall top, the door head and the window's sill and lintel keep their world Y.
      const from = Math.max(frame.profile.bottomY, hostFrame.profile.bottomY)
      const own = wallPieces(playerCtx, frame)
      for (let u = 0.07; u < frame.len; u += 0.25) {
        expect(spansAt(own, u, from), `${piece.id} at u = ${u}`).toEqual(
          spansAt(hostPieces, u + t0, from).map(([lo, hi]) => [expect.closeTo(lo, 6), expect.closeTo(hi, 6)])
        )
        compared++
      }
    }
    expect(compared).toBeGreaterThan(20)
    // The case this guards: without the host's profile some piece would stand on the client's own
    // (clipped) ground, at other heights.
    expect(ownGroundWrong).toBeGreaterThan(0)

    // Openings sent on a piece: base, head and sill top (world Y) and span as on the host.
    let openings = 0
    for (const o of [door, win]) {
      if (!Object.hasOwn(playerScene.objects, o.id)) continue
      const po = playerScene.objects[o.id] as DoorObject | WindowObject
      const piece = playerScene.objects[po.wallId] as WallObject
      const t0 = Math.hypot(piece.a.x - wall.a.x, piece.a.z - wall.a.z)
      const hf = openingFrame(hostProfile, wall, o)!
      const cf = openingFrame(profileIn(playerScene, piece), piece, po)!
      expect(cf.u0 + t0).toBeCloseTo(hf.u0, 9)
      expect(cf.u1 + t0).toBeCloseTo(hf.u1, 9)
      expect(cf.base, o.id).toBeCloseTo(hf.base, 9)
      expect(cf.head, o.id).toBeCloseTo(hf.head, 9)
      expect(cf.sillTop, o.id).toBeCloseTo(hf.sillTop, 9)
      expect(cf.hasSill).toBe(hf.hasSill)
      openings++
    }
    // The door and the window were sent (on a piece).
    expect(openings).toBeGreaterThan(0)
  })

  it("paths the host finds through perceived cells also validate on the player's rebuilt scene", () => {
    const { host, players, pcs } = lanternSession()
    let checked = 0
    players.forEach((uid, k) => {
      const { view, vis } = host.refresh(uid)
      const token = host.scene.tokens[pcs[k]]
      const playerScene = viewToScene(view)
      const playerWorld = buildOcclusionWorld(playerScene)
      const perception = vis.perception[token.levelId]
      if (!perception) return
      const perceived = (step: PathStep) =>
        step.levelId === token.levelId && perception.grades[step.cell.j * perception.width + step.cell.i] > 0 && !perception.partial.has(step.cell.j * perception.width + step.cell.i)
      for (let n = 0; n < perception.grades.length && checked < 60; n += 7) {
        if (perception.grades[n] === 0) continue
        const target: PathStep = { cell: { i: n % perception.width, j: Math.floor(n / perception.width) }, levelId: token.levelId }
        const path = findPath(host.scene, host.engine.world, token, target, { maxSteps: 24 })
        if (!path || !path.every(perceived)) continue
        const onPlayer = validateMove(playerScene, playerWorld, playerScene.tokens[token.id], path, { enforceSpeed: false })
        expect(onPlayer.ok, `${uid} → ${target.cell.i},${target.cell.j}: ${onPlayer.reason}`).toBe(true)
        checked++
      }
    })
    expect(checked).toBeGreaterThan(10)
  })
})

describe("editor ↔ integrity ↔ schema ↔ live session", () => {
  it("copy/paste/delete across levels keep the document valid, undo restores it, and a live host follows the patches", () => {
    const original = sampleById("crooked-lantern")!.build()
    const store = createEditorStore({ systemClipboard: null, scene: structuredClone(original) })
    let game = createGameState({ sessionId: "s", roomCode: "ROOM1234", scene: structuredClone(original) })
    const sent: Patch[][] = []
    store.getState().setPatchSink((patches) => {
      sent.push(patches)
      const before = game.scene
      const r = reduceDm(game, { t: "apply-scene-patches", patches })
      expect(r.error).toBeUndefined()
      game = r.state
      // The engine's SceneChange and the host's vision delta name the same objects/tokens.
      const change = sceneChangeFromPatches(patches)
      const delta = deltaFromPatches(before, game.scene, patches)
      for (const id of change.objects ?? []) expect(delta.objects).toContain(id)
      for (const id of change.tokens ?? []) expect(delta.tokens).toContain(id)
    })
    const valid = (scene: Scene) => {
      const parsed = parseScene(JSON.parse(JSON.stringify(scene)))
      expect(parsed.ok, parsed.ok ? "" : parsed.issues.join("\n")).toBe(true)
      expect(validateReferences(scene)).toEqual([])
    }

    const levels = sortedLevels(original)
    const ground = levels.find((l) => l.elevation === 0)!
    const upper = levels.find((l) => l.elevation > 0)!
    const s = store.getState()
    s.setActiveLevel(ground.id)
    s.selectAll()
    expect(store.getState().selection.length).toBeGreaterThan(20)
    s.copySelection()
    s.setActiveLevel(upper.id)
    const pasted = store.getState().paste()
    expect(pasted.length).toBeGreaterThan(0)
    valid(store.getState().scene)
    store.getState().setActiveLevel(ground.id)
    store.getState().selectAll()
    store.getState().deleteSelection()
    valid(store.getState().scene)
    expect(store.getState().removeLevel(upper.id)).toBe(true)
    valid(store.getState().scene)
    expect(game.scene).toEqual(store.getState().scene)

    while (store.getState().undo()) {
      /* unwind everything */
    }
    expect(store.getState().scene).toEqual(original)
    expect(game.scene).toEqual(original)
    // The patches the host received replay onto the original document to the same result.
    expect(sent.length).toBeGreaterThan(0)
    expect(sent.reduce((doc, p) => applyPatches(doc, p), original)).toEqual(original)
  })
})

describe("editor → live session: terrain shapes", () => {
  it("a shape edit reaches players as heightmap chunk diffs only, never terrainEdits", () => {
    // A bright, open level with terrain shapes baked in; the PC sees the whole of it.
    const scene = createScene({ width: 16, depth: 12 })
    scene.environment = { ...scene.environment, skyLevel: "bright", ambientLevel: "bright" }
    const levelId = Object.keys(scene.levels)[0]
    const level = { ...scene.levels[levelId], heightmap: latticeOf(scene, 2, (x, z) => 0.05 * x + 0.02 * z) }
    const shapes = [blockShape("hill", { x: 20, z: 20, w: 10, d: 10 }, 0, 3, 0), rampShape("ramp", { x: 50, z: 30, w: 10, d: 15 }, 0, 0, 4, 1)]
    expect(writeTerrain(level, scene.grid, { upsert: shapes })).toBe(true)
    scene.levels[levelId] = level
    const pc = createToken(levelId, { x: 42.5, z: 12.5 }, { kind: "pc" })
    scene.tokens[pc.id] = pc
    expect(parseScene(JSON.parse(JSON.stringify(scene))).ok).toBe(true)
    const host = new TestHost(scene, ["p1"])
    host.assign(pc.id, "p1")
    // The PC walks the level first, so every cell is explored (and the floor is sent whole): what an
    // edit changes for the player is then the terrain itself, plus what the PC sees over it now.
    const wire: unknown[] = []
    for (const [x, z] of [
      [7.5, 7.5],
      [72.5, 7.5],
      [72.5, 52.5],
      [7.5, 52.5],
      [42.5, 12.5],
    ]) {
      host.dm({ t: "move-token", tokenId: pc.id, levelId, x, z })
      wire.push(host.refresh("p1").view)
    }
    const floors = Object.values(host.sent.get("p1")!.objects).filter((o) => o.type === "floor")
    expect(floors.map((f) => f.type === "floor" && f.rect)).toEqual([{ x: 0, z: 0, w: 80, d: 60 }])
    expect(Object.keys(host.sent.get("p1")!.terrain[levelId] ?? {}).length).toBeGreaterThan(0)

    const store = createEditorStore({ systemClipboard: null, scene: host.scene })
    const sent: { patches: Patch[]; dirty: string[] | "all" }[] = []
    store.getState().setPatchSink((patches) => {
      const before = host.scene
      const r = host.dm({ t: "apply-scene-patches", patches })
      expect(r.error).toBeUndefined()
      sent.push({ patches, dirty: r.dirtyPlayers })
      // Shapes are not scene objects: the editor's SceneChange and the host's delta see terrain at most.
      const change = sceneChangeFromPatches(patches)
      const delta = deltaFromPatches(before, host.scene, patches)
      expect(change.objects ?? []).toEqual([])
      expect(delta.objects).toEqual([])
      expect(delta.structure).toBe(false)
      expect(delta.terrain).toEqual(patches.some((p) => p.path[2] === "heightmap") ? [levelId] : [])
    })
    const refresh = (): PatchOp[] => {
      const { ops } = host.refresh("p1")
      wire.push(ops)
      return ops
    }
    const hill = () => store.getState().scene.levels[levelId].terrainEdits!.shapes.hill
    const groundOf = (sc: SceneLike, x: number, z: number) => levelGround(sc, levelId, x, z)

    // A rename touches DM-only editing data only: no player is dirty and nothing is sent.
    expect(store.getState().applyTerrainEdit(levelId, { upsert: [{ ...hill(), name: "SECRET_HILL" }] }, "Rename shape")).toBe(true)
    expect(sent.at(-1)!.patches.every((p) => p.path[0] === "levels" && p.path[2] === "terrainEdits")).toBe(true)
    expect(sent.at(-1)!.dirty).toEqual([])
    expect(refresh()).toEqual([])

    // Moving (and raising) the hill changes the baked heightmap: the player gets chunk diffs, nothing else.
    const moved = translateShape(hill(), { x: 15, y: 1, z: 5 })!
    expect(store.getState().applyTerrainEdit(levelId, { upsert: [moved] }, "Move shape")).toBe(true)
    const patches = sent.at(-1)!.patches
    expect(patches.some((p) => p.path[2] === "heightmap")).toBe(true)
    expect(patches.some((p) => p.path[2] === "terrainEdits")).toBe(true)
    const check = (label: string) => {
      const ops = refresh()
      // Heightmap chunks (whole chunks, by key), plus what the PC now sees over the new terrain (masks).
      const terrain = ops.filter((op) => op.path[0] === "terrain")
      expect(terrain.length, label).toBeGreaterThan(0)
      for (const op of terrain) {
        expect(op.path, label).toHaveLength(3)
        expect(op.path[1], label).toBe(levelId)
      }
      const other = ops.filter((op) => op.path[0] !== "terrain" && op.path[0] !== "masks")
      expect(other, label).toEqual([])
      // The client's rebuilt terrain is the host's baked one (the PC sees the whole level).
      const client = viewToScene(host.sent.get("p1")!)
      for (const [x, z] of [
        [37.5, 27.5],
        [25, 25],
        [55, 37.5],
        [12.5, 50],
      ])
        expect(groundOf(client, x, z), `${label} (${x}, ${z})`).toBeCloseTo(groundOf(host.scene, x, z), 6)
    }
    check("moved")
    // The hill's top is baked where it now stands (1 ft higher), the ground where it stood is back.
    expect(groundOf(host.scene, 40, 30)).toBeCloseTo(4, 6)
    expect(groundOf(host.scene, 22.5, 22.5)).toBeCloseTo(0.05 * 22.5 + 0.02 * 22.5, 5)

    // Undo restores the hill where it was, again as chunk diffs only.
    expect(store.getState().undo()).toBe(true)
    check("undone")
    expect(groundOf(host.scene, 25, 25)).toBeCloseTo(3, 6)

    // Nothing DM-only ever reached the player (views and patches).
    const json = JSON.stringify(wire)
    for (const secret of ["terrainEdits", "baseChunks", "SECRET_HILL", '"shapes"', '"hill"']) expect(json).not.toContain(secret)
  })
})

/** Comparable form of a visibility result. */
function visSnapshot(res: VisibilityResult) {
  const perception: Record<Id, unknown> = {}
  for (const [id, m] of Object.entries(res.perception)) perception[id] = encodeGrades(m)
  const sunlit: Record<Id, unknown> = {}
  for (const [id, m] of Object.entries(res.sunlit)) sunlit[id] = encodeMask(m)
  return {
    perception,
    sunlit,
    visible: [...res.visibleTokenIds].sort(),
    observed: [...res.observedObjectIds].sort(),
    lights: [...res.illuminatingLightIds].sort(),
  }
}

const sortedPrimitives = (prims: readonly OccluderPrimitive[]) => [...prims].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

describe("live editing: editor patches → session delta → incremental occlusion and vision", () => {
  it("the host's incremental world and visibility equal a fresh build after every kind of edit", () => {
    // A tall wall beyond the grid's east edge (the schema allows 50 ft), toward the moon: its shadow
    // falls on the map, and sun rays must not stop at the grid edge (fresh and incremental bounds).
    let outside: Id = ""
    const { host, players, pcs } = lanternSession((s) => {
      const ground = sortedLevels(s).find((l) => l.elevation === 0)!
      const x = s.grid.width * s.grid.cellSize + 8
      const w = createWall(ground.id, { x, z: -10 }, { x, z: s.grid.depth * s.grid.cellSize + 10 }, { height: 60 })
      s.objects[w.id] = w
      outside = w.id
    })
    {
      // Not vacuous: the wall changes some sun bits of a fresh build.
      const without = { ...host.scene, objects: { ...host.scene.objects } }
      delete without.objects[outside]
      const a = new VisionEngineImpl(host.scene)
      const b = new VisionEngineImpl(without)
      let differ = 0
      for (const level of sortedLevels(host.scene)) {
        for (let j = 0; j < host.scene.grid.depth; j++) {
          for (let i = 0; i < host.scene.grid.width; i++) if (a.inspectSample(level.id, i, j)?.sunlit !== b.inspectSample(level.id, i, j)?.sunlit) differ++
        }
      }
      expect(differ).toBeGreaterThan(0)
    }
    const store = createEditorStore({ systemClipboard: null, scene: host.scene })
    store.getState().setPatchSink((patches) => {
      const r = host.dm({ t: "apply-scene-patches", patches })
      expect(r.error).toBeUndefined()
    })
    const check = (label: string) => {
      expect(host.scene, label).toEqual(store.getState().scene)
      expect(sortedPrimitives(host.engine.world.primitives), label).toEqual(sortedPrimitives(buildOcclusionWorld(host.scene).primitives))
      const fresh = new VisionEngineImpl(host.scene)
      for (const uid of players) {
        const ids = pcs.filter((_, k) => players[k] === uid)
        const a = host.engine.compute(ids.map((id) => host.engine.viewerFor(host.scene.tokens[id])))
        const b = fresh.compute(ids.map((id) => fresh.viewerFor(host.scene.tokens[id])))
        expect(visSnapshot(a), `${label} / ${uid}`).toEqual(visSnapshot(b))
      }
    }
    check("initial")

    const scene = () => store.getState().scene
    const objectsOf = <T extends SceneObject["type"]>(type: T) =>
      Object.values(scene().objects)
        .filter((o): o is Extract<SceneObject, { type: T }> => o.type === type)
        .sort((a, b) => (a.id < b.id ? -1 : 1))

    // Door toggles (every door, so at least one is in someone's view).
    for (const d of objectsOf("door")) store.getState().setDoorState(d.id, d.state === "open" ? "closed" : "open")
    check("doors toggled")

    // Lights on/off.
    for (const l of objectsOf("light").slice(0, 6)) store.getState().toggleLight(l.id)
    check("lights toggled")

    // A wall moved (its openings reproject, joints of its neighbours change).
    const wall = objectsOf("wall").find((w) => objectsOf("door").some((d) => d.wallId === w.id))!
    expect(store.getState().updateObject(wall.id, { a: { x: wall.a.x + 1, z: wall.a.z }, b: { x: wall.b.x + 1, z: wall.b.z } })).toBe(true)
    check("wall moved")

    // The wall beyond the grid moved further out (the fresh build's bounds must still contain it).
    {
      const w = scene().objects[outside]
      if (w.type !== "wall") throw new Error("outside wall")
      expect(store.getState().updateObject(outside, { a: { x: w.a.x + 4, z: w.a.z }, b: { x: w.b.x + 4, z: w.b.z } })).toBe(true)
    }
    check("wall beyond the grid moved")

    // Tokens moved (attached lights follow).
    for (const id of pcs) {
      const t = scene().tokens[id]
      store.getState().moveTokens([{ id, position: { x: t.position.x + 5, z: t.position.z } }])
    }
    check("tokens moved")

    // Terrain edited where a level already has a heightmap.
    const hilly = sortedLevels(scene()).find((l) => l.heightmap !== null)!
    store.getState().apply((d) => {
      const lvl = d.levels[hilly.id]
      const dense = denseHeights(lvl.heightmap!, d.grid)
      for (let k = 0; k < dense.heights.length; k += 3) dense.heights[k] += 0.75
      lvl.heightmap = writeHeights(lvl.heightmap!, d.grid, dense.heights)
    }, "Raise terrain")
    check("terrain raised")

    // A terrain shape added, then moved, on that level: the heightmap chunks it touches are rebaked, and
    // the follow-terrain walls there stand on the new ground (strips rebuilt incrementally).
    {
      const W = scene().grid.width * scene().grid.cellSize
      const D = scene().grid.depth * scene().grid.cellSize
      const mound = blockShape("mound", { x: W / 2 - 10, z: D / 2 - 10, w: 20, d: 15 }, 0, 3, 0)
      expect(store.getState().applyTerrainEdit(hilly.id, { upsert: [mound] }, "Add shape")).toBe(true)
      check("terrain shape added")
      expect(store.getState().applyTerrainEdit(hilly.id, { upsert: [translateShape(mound, { x: 7, y: 1, z: -4 })!] }, "Move shape")).toBe(true)
      check("terrain shape moved")
    }

    // Objects deleted (a wall takes its openings; a connector re-opens the floors it cut).
    store.getState().deleteIds([wall.id, objectsOf("connector")[0].id])
    check("wall and connector deleted")

    // Undo everything: the host follows the inverse patches.
    while (store.getState().undo()) {
      /* unwind */
    }
    check("undone")
  })
})

describe("factories produce documents the schema accepts", () => {
  it("every object kind, preset and size created by core/scene/factory parses", () => {
    const scene = createScene({ width: 20, depth: 20 })
    const ground = Object.keys(scene.levels)[0]
    const upper = createLevel({ name: "Upper", elevation: 10 })
    scene.levels[upper.id] = upper
    const put = <T extends SceneObject>(o: T): T => {
      scene.objects[o.id] = o
      return o
    }
    put(createFloor(upper.id, { x: 0, z: 0, w: 100, d: 100 }))
    const wall = put(createWall(ground, { x: 10, z: 10 }, { x: 40, z: 10 }))
    put(createDoor(wall, 5))
    put(createWindow(wall, 20))
    put(createConnector(ground, upper.id, { x: 50, z: 50, w: 10, d: 20 }, 0))
    put(createConnector(ground, upper.id, { x: 70, z: 50, w: 5, d: 5 }, 1, "ladder"))
    put(createPillar(ground, { x: 60, z: 20 }))
    Object.keys(PROP_LIBRARY).forEach((kind, k) => put(createProp(ground, kind as PropKind, { x: 5 + k * 6, y: 0, z: 80 })))
    Object.keys(LIGHT_PRESETS).forEach((preset, k) => put(createLight(ground, preset as LightPreset, { x: 5 + k * 10, z: 30 })))
    Object.keys(SIZE_FOOTPRINT).forEach((size, k) => {
      const t = createToken(ground, { x: 7.5 + k * 15, z: 67.5 }, { size: size as CreatureSize })
      scene.tokens[t.id] = t
    })
    const parsed = parseScene(JSON.parse(JSON.stringify(scene)))
    expect(parsed.ok, parsed.ok ? "" : parsed.issues.join("\n")).toBe(true)
  })
})

describe("occlusion primitives reference existing scene objects", () => {
  for (const [name, scene] of SCENES) {
    it(`${name}: every primitive's source exists on its level`, () => {
      const world = buildOcclusionWorld(scene)
      const byKey = new Set<string>()
      for (const p of world.primitives as readonly OccluderPrimitive[]) {
        expect(byKey.has(p.key), p.key).toBe(false)
        byKey.add(p.key)
        const o = scene.objects[p.sourceId]
        expect(o, p.key).toBeTruthy()
        expect(p.levelId).toBe(o.levelId)
      }
    })
  }
})
