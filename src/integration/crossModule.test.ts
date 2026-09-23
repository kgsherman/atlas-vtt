/**
 * Cross-module consistency checks: where two modules implement the same rule independently (render
 * builders vs core/occlusion, vision vs movement ground rules) or hand data to each other (vision →
 * session → player client → occlusion/movement, editor patches → live session), they must agree.
 * Runs on the sample scenes so every feature (terrain, stairs, ladders, openings, props) is covered.
 */
import * as THREE from "three"
import { applyPatches, type Patch } from "immer"
import { describe, expect, it } from "vitest"

import { findPath, validateMove } from "@/core/movement"
import { MoveContext } from "@/core/movement/context"
import type { PathStep } from "@/core/movement/types"
import { BuildContext as OcclusionContext, buildOcclusionWorld, footprintPolygon, primitiveBounds, wallFrame as occlusionWallFrame } from "@/core/occlusion"
import type { OccluderPrimitive } from "@/core/occlusion/types"
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
import { bytesToBase64, denseHeights, writeHeights } from "@/core/scene/heightmap"
import { parseScene } from "@/core/scene/schema"
import { validateReferences } from "@/core/scene/integrity"
import { effectiveFloorRects, floorRects, groundHeightAt, hasGroundAt, sortedLevels } from "@/core/scene/queries"
import { SAMPLE_SCENES, sampleById } from "@/core/scene/samples"
import type { CreatureSize, FloorObject, Id, LightPreset, PropKind, Scene, SceneObject } from "@/core/scene/types"
import { applyPatchOps, createGameState, deltaFromPatches, diffViews, parsePlayerView, reduceDm, viewToScene } from "@/core/session"
import { TestHost } from "@/core/session/test-utils"
import { encodeGrades, encodeMask, VisionEngineImpl } from "@/core/vision"
import { SceneIndex } from "@/core/vision/sceneIndex"
import type { VisibilityResult } from "@/core/vision/types"
import { sceneChangeFromPatches } from "@/editor/sceneChange"
import { createEditorStore } from "@/editor/store"
import { buildLevel } from "@/render/builders"
import { BuildContext as RenderContext } from "@/render/builders/context"
import { pillarExtent, propPlacement } from "@/render/builders/props"
import { wallFrame as renderWallFrame, wallPieces } from "@/render/builders/walls"
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

const SCENES = [...SAMPLE_SCENES.map((s) => [s.id, s.build()] as const), ["mask-floors", maskFloorFixture()] as const]

const baseId = (id: Id): Id => id.split("@")[0]

describe("render builders agree with core/occlusion", () => {
  for (const [name, scene] of SCENES) {
    it(`${name}: walls have the same frame, joints and solid volume`, () => {
      const octx = new OcclusionContext(scene)
      const rctx = new RenderContext(scene)
      const world = buildOcclusionWorld(scene)
      const occVolume = new Map<Id, number>()
      for (const p of world.primitives) {
        if (p.sourceType !== "wall" || p.shape !== "box") continue
        occVolume.set(p.sourceId, (occVolume.get(p.sourceId) ?? 0) + 8 * p.halfExtents.x * p.halfExtents.y * p.halfExtents.z)
      }
      for (const wall of Object.values(scene.objects)) {
        if (wall.type !== "wall") continue
        const o = occlusionWallFrame(octx, wall)
        const r = renderWallFrame(rctx, wall)
        expect(r === null, wall.id).toBe(o === null)
        if (!o || !r) continue
        expect(r.baseY).toBeCloseTo(o.baseY, 9)
        expect(r.topY).toBeCloseTo(o.topY, 9)
        expect(r.bottomY).toBeCloseTo(o.bottomY, 9)
        expect(r.extA > 0).toBe(octx.wallsWithEndpointAt(wall.levelId, wall.a, wall.id).length > 0)
        expect(r.extB > 0).toBe(octx.wallsWithEndpointAt(wall.levelId, wall.b, wall.id).length > 0)
        const renderVolume = wallPieces(rctx, r).reduce((v, p) => v + (p.u1 - p.u0) * (p.y1 - p.y0) * wall.thickness, 0)
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
      proxies.dispose()
    })
  }
})

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
function renderExtents(scene: Scene, bucket: "floors" | "connectors"): { extents: Map<Id, Extent>; walkable: Map<Id, number> } {
  const extents = new Map<Id, Extent>()
  const walkable = new Map<Id, number>()
  const ctx = new RenderContext(scene)
  for (const level of sortedLevels(scene)) {
    for (const m of buildLevel(ctx, level.id)[bucket].meshes) {
      if (m.kind !== "merged") continue
      const pos = m.geometry.getAttribute("position")
      const surf = m.geometry.getAttribute("aSurf")
      for (const r of m.geometry.userData.ranges as { id: string; start: number; count: number }[]) {
        const e = extents.get(r.id) ?? emptyExtent()
        for (let k = r.start * 3; k < (r.start + r.count) * 3; k++) {
          grow(e, { minX: pos.getX(k), maxX: pos.getX(k), minY: pos.getY(k), maxY: pos.getY(k), minZ: pos.getZ(k), maxZ: pos.getZ(k) })
        }
        extents.set(r.id, e)
        if (m.terrainOffsets && surf) {
          let n = 0
          for (let t = r.start; t < r.start + r.count; t++) if (surf.getX(t * 3) === SURF.WALKABLE) n++
          walkable.set(r.id, (walkable.get(r.id) ?? 0) + n)
        }
      }
    }
  }
  return { extents, walkable }
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
      const { extents, walkable } = renderExtents(scene, "floors")
      const solid = new Map<Id, number>()
      for (const p of buildOcclusionWorld(scene).primitives) if (p.shape === "heightfield") solid.set(p.sourceId, p.solid.reduce((a, b) => a + b, 0))
      let checked = 0
      for (const o of Object.values(scene.objects)) {
        if (o.type !== "floor") continue
        const r = extents.get(o.id)
        const b = occ.get(o.id)
        expect(r === undefined, `${o.id}: rendered ${r !== undefined}, occluder ${b !== undefined}`).toBe(b === undefined)
        if (!r || !b) continue
        for (const k of ["minX", "maxX", "minY", "maxY", "minZ", "maxZ"] as const) expect(r[k], `${o.id} ${k}`).toBeCloseTo(b[k], 3)
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
    // A slope h = 0.3·x; wall W runs past both grid edges with a closed door and a window. The PC sees
    // by darkvision only, so W is explored in part and sent as pieces whose midpoints (where the
    // client puts their base, Terrain rule) differ from W's.
    const scene = createScene({ width: 16, depth: 8 })
    const ground = Object.keys(scene.levels)[0]
    scene.environment = { ...scene.environment, skyLevel: "dark", ambientLevel: "dark", directional: { ...scene.environment.directional, enabled: false } }
    const res = 2
    const samplesX = scene.grid.width * res + 1
    const samplesZ = scene.grid.depth * res + 1
    const dense = new Float32Array(samplesX * samplesZ)
    for (let j = 0; j < samplesZ; j++) for (let i = 0; i < samplesX; i++) dense[j * samplesX + i] = 0.3 * i * (scene.grid.cellSize / res)
    scene.levels[ground] = { ...scene.levels[ground], heightmap: writeHeights({ resolution: res, chunks: {} }, scene.grid, dense) }
    const wall = createWall(ground, { x: -20, z: 20 }, { x: 100, z: 20 }, { height: 12, thickness: 0.5 })
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

    /** Solid Y spans of a wall's render pieces at wall-frame position u, clipped to y ≥ from. */
    const spansAt = (pieces: ReturnType<typeof wallPieces>, u: number, from: number) =>
      pieces
        .filter((p) => p.u0 < u && u < p.u1 && p.y1 > from)
        .map((p) => [Math.max(p.y0, from), p.y1])
        .sort((a, b) => a[0] - b[0])
    const hostCtx = new RenderContext(host.scene)
    const hostFrame = renderWallFrame(hostCtx, wall)!
    const hostPieces = wallPieces(hostCtx, hostFrame)
    const playerCtx = new RenderContext(playerScene)
    const pieces = Object.values(playerScene.objects).filter((o) => o.type === "wall" && baseId(o.id) === wall.id)
    expect(pieces.length).toBeGreaterThan(0)
    let compared = 0
    let rebased = 0
    for (const piece of pieces) {
      if (piece.type !== "wall") continue
      const frame = renderWallFrame(playerCtx, piece)!
      const own = wallPieces(playerCtx, frame)
      // The piece lies on W's line: its frame's u = 0 is W's u = offset.
      const offset = Math.hypot(piece.a.x - wall.a.x, piece.a.z - wall.a.z)
      if (Math.abs(frame.baseY - hostFrame.baseY) > 0.5) rebased++
      expect(frame.topY, piece.id).toBeCloseTo(hostFrame.topY, 6)
      // Above both bottoms (the host's depends on terrain the player is not sent), every solid span
      // matches: the wall top, the door head and the window's sill and lintel keep their world Y.
      const from = Math.max(frame.bottomY, hostFrame.bottomY)
      for (let u = 0.07; u < frame.len; u += 0.25) {
        expect(spansAt(own, u, from), `${piece.id} at u = ${u}`).toEqual(
          spansAt(hostPieces, u + offset, from).map(([a, b]) => [expect.closeTo(a, 6), expect.closeTo(b, 6)])
        )
        compared++
      }
    }
    expect(compared).toBeGreaterThan(20)
    // The case this guards: at least one piece stands on ground other than W's base.
    expect(rebased).toBeGreaterThan(0)
    // The door and the window were sent (on a piece).
    expect(Object.hasOwn(playerScene.objects, door.id) || Object.hasOwn(playerScene.objects, win.id)).toBe(true)
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
