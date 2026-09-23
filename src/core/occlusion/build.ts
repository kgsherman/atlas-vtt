/**
 * Scene → occluder primitives, per source object, following the blocking table and the Terrain rule
 * of docs/ARCHITECTURE.md §2 and §5.1. Walls and openings take their heights from core/scene/wallProfile:
 * a piece whose top is constant is an OrientedBox, one under a sloping top line a WallStrip.
 *
 * Every primitive's sourceId is the object that owns it:
 *  - wall id: the full-height pieces between openings, plus door lintels and window sills/lintels
 *    (they are part of the wall and block everything);
 *  - door id: the closed/locked leaf; window id: the movement-only box spanning the opening;
 *  - floor id: one box per effective rect (flat level) or one Heightfield (level with a heightmap);
 *  - connector id: stepped boxes under a stairs/ramp run; pillar id; prop id (one per library part).
 * Keys are `${sourceId}` for the first primitive and `${sourceId}#${part}` for the others.
 */
import { orientedRectCorners, yawFromDirection } from "../geometry/box"
import { rectPolygon } from "../geometry/polygon"
import { DOOR_STYLES, PROP_LIBRARY } from "../scene/defaults"
import {
  connectorGround,
  effectiveFloorRects,
  floorThickness,
  levelCeilingY,
  type EffectiveFloor,
  type Opening,
} from "../scene/queries"
import type {
  ConnectorObject,
  DoorObject,
  FloorObject,
  Id,
  PillarObject,
  PropObject,
  Rect,
  SceneLike,
  SceneObject,
  SceneObjectType,
  Vec2,
  WallObject,
  WindowObject,
} from "../scene/types"
import { MIN_EXTENT, openingFrame, pieceKnots, WALL_BOTTOM_MARGIN, wallProfile, type WallProfile } from "../scene/wallProfile"
import { TerrainSampler } from "./terrain"
import type { BlockFlags, Heightfield, OccluderPrimitive, OrientedBox, VerticalCylinder, WallStrip } from "./types"

/** Wall bottoms extend this far below the minimum ground along their footprint (see core/scene/wallProfile). */
export { WALL_BOTTOM_MARGIN }

/** Stepped stair/ramp boxes stop this far below the walking surface at each row's low edge. */
export const STAIR_TOP_GAP = 0.05
/** Wall endpoints closer than this (feet) form a joint. */
export const JOINT_TOLERANCE = 1e-3

const BLOCK_ALL: BlockFlags = { movement: true, sight: true, light: true }
const BLOCK_VIEW: BlockFlags = { movement: false, sight: true, light: true }
const BLOCK_MOVEMENT: BlockFlags = { movement: true, sight: false, light: false }

const hasOwn = (o: object, k: string) => Object.hasOwn(o, k)

// ---------------------------------------------------------------------------
// Build context: per-scene caches shared by all sources of one build/update
// ---------------------------------------------------------------------------

interface Endpoint {
  x: number
  z: number
  wallId: Id
}

export class BuildContext {
  private readonly terrains = new Map<Id, TerrainSampler>()
  private readonly floors = new Map<Id, EffectiveFloor[]>()
  private readonly joints = new Map<Id, Map<string, Endpoint[]>>()
  private readonly frames = new WeakMap<WallObject, WallFrame | null>()
  private readonly hostFrames = new WeakMap<WallObject, WallFrame | null>()
  private openings: Map<Id, Opening[]> | null = null
  private byLevel: Map<Id, SceneObject[]> | null = null
  readonly scene: SceneLike

  constructor(scene: SceneLike) {
    this.scene = scene
  }

  hasLevel(id: Id): boolean {
    return hasOwn(this.scene.levels, id)
  }

  object(id: Id): SceneObject | undefined {
    return hasOwn(this.scene.objects, id) ? this.scene.objects[id] : undefined
  }

  terrain(levelId: Id): TerrainSampler {
    let t = this.terrains.get(levelId)
    if (!t) {
      t = new TerrainSampler(this.scene.levels[levelId], this.scene.grid)
      this.terrains.set(levelId, t)
    }
    return t
  }

  effectiveFloors(levelId: Id): EffectiveFloor[] {
    let f = this.floors.get(levelId)
    if (!f) {
      f = effectiveFloorRects(this.scene, levelId)
      this.floors.set(levelId, f)
    }
    return f
  }

  /**
   * A wall's frame, computed once per context. `joints` false (openings): any cached frame will do,
   * since the profile over [0, len] does not depend on the joint extensions; otherwise one without them
   * (no joint index is built for a door toggle).
   */
  frame(wall: WallObject, joints: boolean): WallFrame | null {
    let f = this.frames.get(wall)
    if (f === undefined && !joints) f = this.hostFrames.get(wall)
    if (f === undefined) {
      f = makeWallFrame(this, wall, joints)
      ;(joints ? this.frames : this.hostFrames).set(wall, f)
    }
    return f
  }

  /** Openings hosted by a wall, sorted by offset. */
  openingsOf(wallId: Id): Opening[] {
    if (!this.openings) {
      this.openings = new Map()
      for (const o of Object.values(this.scene.objects)) {
        if (o.type !== "door" && o.type !== "window") continue
        let list = this.openings.get(o.wallId)
        if (!list) this.openings.set(o.wallId, (list = []))
        list.push(o)
      }
      for (const list of this.openings.values()) list.sort((a, b) => a.offset - b.offset || (a.id < b.id ? -1 : 1))
    }
    return this.openings.get(wallId) ?? []
  }

  /** Objects on a level (unsorted). */
  objectsOn(levelId: Id): SceneObject[] {
    if (!this.byLevel) {
      this.byLevel = new Map()
      for (const o of Object.values(this.scene.objects)) {
        let list = this.byLevel.get(o.levelId)
        if (!list) this.byLevel.set(o.levelId, (list = []))
        list.push(o)
      }
    }
    return this.byLevel.get(levelId) ?? []
  }

  private jointIndex(levelId: Id): Map<string, Endpoint[]> {
    let idx = this.joints.get(levelId)
    if (!idx) {
      idx = new Map()
      for (const o of this.objectsOn(levelId)) {
        if (o.type !== "wall" || wallLen(o) < MIN_EXTENT) continue
        for (const p of [o.a, o.b]) {
          const key = `${Math.floor(p.x)},${Math.floor(p.z)}`
          let list = idx.get(key)
          if (!list) idx.set(key, (list = []))
          list.push({ x: p.x, z: p.z, wallId: o.id })
        }
      }
      this.joints.set(levelId, idx)
    }
    return idx
  }

  /** Walls on a level (other than `exceptWallId`) with an endpoint within JOINT_TOLERANCE of p. */
  wallsWithEndpointAt(levelId: Id, p: Vec2, exceptWallId: Id | null): Id[] {
    const idx = this.jointIndex(levelId)
    const out: Id[] = []
    const bx = Math.floor(p.x)
    const bz = Math.floor(p.z)
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = idx.get(`${bx + dx},${bz + dz}`)
        if (!list) continue
        for (const e of list) {
          if (e.wallId === exceptWallId || out.includes(e.wallId)) continue
          if (Math.hypot(e.x - p.x, e.z - p.z) <= JOINT_TOLERANCE) out.push(e.wallId)
        }
      }
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Object types that can produce occluder primitives. */
export const OCCLUDER_TYPES: ReadonlySet<SceneObjectType> = new Set(["floor", "wall", "door", "window", "connector", "pillar", "prop"])

/** All primitives owned by one source object (empty if it does not exist, is on a missing level, or blocks nothing). */
export function buildSource(ctx: BuildContext, id: Id): OccluderPrimitive[] {
  const o = ctx.object(id)
  if (!o || !ctx.hasLevel(o.levelId)) return []
  switch (o.type) {
    case "wall":
      return buildWall(ctx, o)
    case "door":
    case "window":
      return buildOpening(ctx, o)
    case "floor":
      return buildFloor(ctx, o)
    case "connector":
      return buildConnector(ctx, o)
    case "pillar":
      return buildPillar(ctx, o)
    case "prop":
      return buildProp(ctx, o)
    case "light":
      return []
  }
}

/** Every primitive of a scene, grouped by source id (deterministic order). */
export function buildAll(scene: SceneLike): OccluderPrimitive[] {
  const ctx = new BuildContext(scene)
  const out: OccluderPrimitive[] = []
  for (const id of Object.keys(scene.objects).sort()) out.push(...buildSource(ctx, id))
  return out
}

const partKey = (sourceId: Id, index: number, part: string): string => (index === 0 ? sourceId : `${sourceId}#${part}`)

// ---------------------------------------------------------------------------
// Walls and openings
// ---------------------------------------------------------------------------

function wallLen(w: Pick<WallObject, "a" | "b">): number {
  return Math.hypot(w.b.x - w.a.x, w.b.z - w.a.z)
}

/** Geometry shared by a wall's pieces and its openings. */
export interface WallFrame {
  wall: WallObject
  len: number
  /** Unit direction a→b. */
  dir: Vec2
  yaw: number
  /** Joint extensions past a / b (thickness/2 where another wall of the level ends there, else 0). */
  extA: number
  extB: number
  /** Base line, top and bottom (core/scene/wallProfile). */
  profile: WallProfile
}

/** A wall's frame with its joint extensions (null for degenerate walls). */
export function wallFrame(ctx: BuildContext, wall: WallObject): WallFrame | null {
  return ctx.frame(wall, true)
}

function makeWallFrame(ctx: BuildContext, wall: WallObject, joints: boolean): WallFrame | null {
  const len = wallLen(wall)
  if (len < MIN_EXTENT || !(wall.thickness > 0) || !(wall.height > 0)) return null
  const dir = { x: (wall.b.x - wall.a.x) / len, z: (wall.b.z - wall.a.z) / len }
  const yaw = yawFromDirection(dir.x, dir.z)
  const terrain = ctx.terrain(wall.levelId)
  const half = wall.thickness / 2
  const extA = joints && ctx.wallsWithEndpointAt(wall.levelId, wall.a, wall.id).length > 0 ? half : 0
  const extB = joints && ctx.wallsWithEndpointAt(wall.levelId, wall.b, wall.id).length > 0 ? half : 0
  const profile = wallProfile(wall, terrain.flat ? null : terrain, terrain.elevation, { a: extA, b: extB })
  return { wall, len, dir, yaw, extA, extB, profile }
}

/** Box spanning [u0, u1] along the wall (feet from a) and [y0, y1] vertically, full wall thickness. */
function wallBox(
  f: WallFrame,
  key: string,
  sourceId: Id,
  sourceType: SceneObjectType,
  blocks: BlockFlags,
  u0: number,
  u1: number,
  y0: number,
  y1: number
): OrientedBox | null {
  if (u1 - u0 < MIN_EXTENT || y1 - y0 < MIN_EXTENT) return null
  const um = (u0 + u1) / 2
  return {
    key,
    sourceId,
    sourceType,
    levelId: f.wall.levelId,
    blocks: { ...blocks },
    shape: "box",
    center: { x: f.wall.a.x + f.dir.x * um, y: (y0 + y1) / 2, z: f.wall.a.z + f.dir.z * um },
    halfExtents: { x: (u1 - u0) / 2, y: (y1 - y0) / 2, z: f.wall.thickness / 2 },
    yaw: f.yaw,
  }
}

/**
 * Wall piece spanning [u0, u1] from its flat bottom y0 up to the wall's top line (topAt(u)): a box
 * where the top is constant over the span, else a WallStrip over the profile knots inside it.
 */
function profilePiece(
  f: WallFrame,
  key: string,
  sourceId: Id,
  sourceType: SceneObjectType,
  blocks: BlockFlags,
  u0: number,
  u1: number,
  y0: number
): OrientedBox | WallStrip | null {
  if (u1 - u0 < MIN_EXTENT) return null
  const p = f.profile
  if (p.topConstant(u0, u1)) return wallBox(f, key, sourceId, sourceType, blocks, u0, u1, y0, p.maxTop(u0, u1))
  const us = pieceKnots(p, u0, u1)
  const top = us.map((u) => p.topAt(u))
  let maxTop = -Infinity
  for (const t of top) if (t > maxTop) maxTop = t
  if (maxTop - y0 < MIN_EXTENT) return null
  const um = (u0 + u1) / 2
  const hx = (u1 - u0) / 2
  const last = us.length - 1
  return {
    key,
    sourceId,
    sourceType,
    levelId: f.wall.levelId,
    blocks: { ...blocks },
    shape: "strip",
    center: { x: f.wall.a.x + f.dir.x * um, z: f.wall.a.z + f.dir.z * um },
    halfExtents: { x: hx, z: f.wall.thickness / 2 },
    yaw: f.yaw,
    knots: us.map((u, k) => (k === 0 ? -hx : k === last ? hx : u - um)),
    top,
    bottom: y0,
  }
}

function buildWall(ctx: BuildContext, wall: WallObject): OccluderPrimitive[] {
  const f = wallFrame(ctx, wall)
  if (!f) return []
  const { profile } = f
  const out: OccluderPrimitive[] = []
  const push = (p: OccluderPrimitive | null) => {
    if (p) out.push(p)
  }

  // Openings on this wall (same level), with their clamped spans and heights.
  const spans: { o: Opening; u0: number; u1: number; head: number; sillTop: number; hasSill: boolean }[] = []
  for (const o of ctx.openingsOf(wall.id)) {
    const fr = openingFrame(profile, wall, o)
    if (fr) spans.push({ o, ...fr })
  }

  // Full-height pieces: [−extA, len + extB] minus the union of the opening spans. The first piece
  // takes the plain wall key; later pieces are named after the opening they follow.
  let cursor = -f.extA
  let prevId: Id | null = null
  const sorted = [...spans].sort((p, q) => p.u0 - q.u0 || p.u1 - q.u1)
  for (const s of sorted) {
    if (s.u0 > cursor) {
      push(profilePiece(f, prevId === null ? wall.id : `${wall.id}#after:${prevId}`, wall.id, "wall", BLOCK_ALL, cursor, s.u0, profile.bottomY))
    }
    if (s.u1 >= cursor) {
      cursor = s.u1
      prevId = s.o.id
    }
  }
  push(profilePiece(f, prevId === null ? wall.id : `${wall.id}#after:${prevId}`, wall.id, "wall", BLOCK_ALL, cursor, f.len + f.extB, profile.bottomY))

  // Lintels [head, top line] and sills [bottom, sill top] (part of the wall, block everything).
  for (const s of spans) {
    if (s.o.type === "window" && s.hasSill) push(wallBox(f, `${wall.id}#sill:${s.o.id}`, wall.id, "wall", BLOCK_ALL, s.u0, s.u1, profile.bottomY, s.sillTop))
    push(profilePiece(f, `${wall.id}#lintel:${s.o.id}`, wall.id, "wall", BLOCK_ALL, s.u0, s.u1, s.head))
  }
  return out
}

function buildOpening(ctx: BuildContext, o: DoorObject | WindowObject): OccluderPrimitive[] {
  const host = ctx.object(o.wallId)
  if (!host || host.type !== "wall" || !ctx.hasLevel(host.levelId)) return []
  // Openings only need the host's heights over [0, len]: any frame of it (joint extensions may be missing).
  const f = ctx.frame(host, false)
  if (!f) return []
  const fr = openingFrame(f.profile, host, o)
  if (!fr) return []
  if (o.type === "window") {
    // Windows block movement through the whole opening (up to the highest top over it) but neither sight nor light.
    const p = wallBox(f, o.id, o.id, "window", BLOCK_MOVEMENT, fr.u0, fr.u1, f.profile.bottomY, f.profile.maxTop(fr.u0, fr.u1))
    return p ? [p] : []
  }
  if (o.state === "open") return []
  const style = DOOR_STYLES[o.style] ?? DOOR_STYLES.wood
  const blocks: BlockFlags = { movement: true, sight: style.blocksSightClosed, light: style.blocksLightClosed }
  const p = wallBox(f, o.id, o.id, "door", blocks, fr.u0, fr.u1, f.profile.bottomY, fr.head)
  return p ? [p] : []
}

// ---------------------------------------------------------------------------
// Floors
// ---------------------------------------------------------------------------

function buildFloor(ctx: BuildContext, floor: FloorObject): OccluderPrimitive[] {
  const th = floorThickness(ctx.scene, floor)
  if (!(th > 0)) return []
  const rects = ctx.effectiveFloors(floor.levelId).filter((e) => e.floorId === floor.id)
  if (rects.length === 0) return []
  const level = ctx.scene.levels[floor.levelId]
  if (!level.heightmap) {
    const top = level.elevation
    const out: OccluderPrimitive[] = []
    rects.forEach((e, k) => {
      const r = e.rect
      if (r.w < MIN_EXTENT || r.d < MIN_EXTENT) return
      out.push({
        key: partKey(floor.id, k, String(k)),
        sourceId: floor.id,
        sourceType: "floor",
        levelId: floor.levelId,
        blocks: { ...BLOCK_VIEW },
        shape: "box",
        center: { x: r.x + r.w / 2, y: top - th / 2, z: r.z + r.d / 2 },
        halfExtents: { x: r.w / 2, y: th / 2, z: r.d / 2 },
        yaw: 0,
      })
    })
    return out
  }
  const hf = floorHeightfield(ctx, floor, rects, th)
  return hf ? [hf] : []
}

/**
 * One heightfield over the lattice cells covering the floor rect. A lattice cell is solid when its
 * centre lies inside one of the floor's effective rects (exact for grid-aligned rects).
 */
function floorHeightfield(ctx: BuildContext, floor: FloorObject, rects: EffectiveFloor[], th: number): Heightfield | null {
  const terrain = ctx.terrain(floor.levelId)
  const s = terrain.spacing
  const r = floor.rect
  const i0 = Math.floor(r.x / s + 1e-9)
  const j0 = Math.floor(r.z / s + 1e-9)
  const i1 = Math.ceil((r.x + r.w) / s - 1e-9)
  const j1 = Math.ceil((r.z + r.d) / s - 1e-9)
  const cellsX = i1 - i0
  const cellsZ = j1 - j0
  if (cellsX <= 0 || cellsZ <= 0) return null
  const samplesX = cellsX + 1
  const samplesZ = cellsZ + 1
  const heights = new Float32Array(samplesX * samplesZ)
  for (let j = 0; j < samplesZ; j++) {
    for (let i = 0; i < samplesX; i++) heights[j * samplesX + i] = terrain.elevation + terrain.sample(i0 + i, j0 + j)
  }
  const solid = new Uint8Array(cellsX * cellsZ)
  let any = false
  for (const { rect: e } of rects) {
    // Lattice cells whose centre (i + 0.5)·s lies in [e.x, e.x + e.w) (half-open, like rectContains).
    const ci0 = Math.max(0, Math.ceil(e.x / s - 0.5) - i0)
    const ci1 = Math.min(cellsX - 1, Math.ceil((e.x + e.w) / s - 0.5) - 1 - i0)
    const cj0 = Math.max(0, Math.ceil(e.z / s - 0.5) - j0)
    const cj1 = Math.min(cellsZ - 1, Math.ceil((e.z + e.d) / s - 0.5) - 1 - j0)
    for (let j = cj0; j <= cj1; j++) {
      for (let i = ci0; i <= ci1; i++) {
        solid[j * cellsX + i] = 1
        any = true
      }
    }
  }
  if (!any) return null
  return {
    key: floor.id,
    sourceId: floor.id,
    sourceType: "terrain",
    levelId: floor.levelId,
    blocks: { ...BLOCK_VIEW },
    shape: "heightfield",
    originX: i0 * s,
    originZ: j0 * s,
    spacing: s,
    samplesX,
    samplesZ,
    heights,
    solid,
    thickness: th,
  }
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

/** Row rects of a stairs/ramp run, ordered from the bottom edge (k = 0) to the top edge. */
export function connectorRows(c: Pick<ConnectorObject, "rect" | "direction">, cellSize: number): Rect[] {
  const r = c.rect
  const alongZ = c.direction === 0 || c.direction === 2
  const runLen = alongZ ? r.d : r.w
  const n = Math.max(1, Math.round(runLen / cellSize))
  const step = runLen / n
  const out: Rect[] = []
  for (let k = 0; k < n; k++) {
    switch (c.direction) {
      case 0:
        out.push({ x: r.x, z: r.z + k * step, w: r.w, d: step })
        break
      case 1:
        out.push({ x: r.x + k * step, z: r.z, w: step, d: r.d })
        break
      case 2:
        out.push({ x: r.x, z: r.z + r.d - (k + 1) * step, w: r.w, d: step })
        break
      case 3:
        out.push({ x: r.x + r.w - (k + 1) * step, z: r.z, w: step, d: r.d })
        break
    }
  }
  return out
}

/** Points along the edge of a row perpendicular to the run (`high` = the edge nearer the top). */
function rowEdgePoints(c: ConnectorObject, row: Rect, high: boolean, spacing: number): Vec2[] {
  const alongZ = c.direction === 0 || c.direction === 2
  const ascending = c.direction === 0 || c.direction === 1
  const fixed = alongZ
    ? ascending === high
      ? row.z + row.d
      : row.z
    : ascending === high
      ? row.x + row.w
      : row.x
  const from = alongZ ? row.x : row.z
  const span = alongZ ? row.w : row.d
  const n = Math.max(1, Math.ceil(span / spacing))
  const out: Vec2[] = []
  for (let k = 0; k <= n; k++) {
    const v = from + (span * k) / n
    out.push(alongZ ? { x: v, z: fixed } : { x: fixed, z: v })
  }
  return out
}

function buildConnector(ctx: BuildContext, c: ConnectorObject): OccluderPrimitive[] {
  if (c.style === "ladder" || !ctx.hasLevel(c.toLevelId)) return []
  const scene = ctx.scene
  const lower = ctx.terrain(c.levelId)
  const upper = ctx.terrain(c.toLevelId)
  const spacing = Math.min(lower.spacing, upper.spacing)
  const bottom = lower.rangeOverPolygon(rectPolygon(c.rect)).min - WALL_BOTTOM_MARGIN
  const out: OccluderPrimitive[] = []
  connectorRows(c, scene.grid.cellSize).forEach((row, k) => {
    // Lowest walking surface on the row: the run is linear along the direction, so its minimum
    // is on one of the two edges perpendicular to the run.
    let surface = Infinity
    for (const high of [false, true]) {
      for (const p of rowEdgePoints(c, row, high, spacing)) surface = Math.min(surface, connectorGround(scene, c, p))
    }
    const top = surface - STAIR_TOP_GAP
    if (top - bottom < MIN_EXTENT) return
    out.push({
      key: partKey(c.id, k, String(k)),
      sourceId: c.id,
      sourceType: "connector",
      levelId: c.levelId,
      blocks: { ...BLOCK_VIEW },
      shape: "box",
      center: { x: row.x + row.w / 2, y: (top + bottom) / 2, z: row.z + row.d / 2 },
      halfExtents: { x: row.w / 2, y: (top - bottom) / 2, z: row.d / 2 },
      yaw: 0,
    })
  })
  return out
}

// ---------------------------------------------------------------------------
// Pillars and props
// ---------------------------------------------------------------------------

function buildPillar(ctx: BuildContext, p: PillarObject): OccluderPrimitive[] {
  if (!(p.size > 0)) return []
  const terrain = ctx.terrain(p.levelId)
  const half = p.size / 2
  const ground = terrain.heightAt(p.position.x, p.position.z)
  const bottom = terrain.rangeOverPolygon(orientedRectCorners(p.position, half, half, 0)).min
  const top = p.height === null ? levelCeilingY(ctx.scene, p.levelId) : ground + p.height
  if (top - bottom < MIN_EXTENT) return []
  const base = { key: p.id, sourceId: p.id, sourceType: "pillar" as const, levelId: p.levelId, blocks: { ...BLOCK_ALL } }
  if (p.shape === "square") {
    return [
      {
        ...base,
        shape: "box",
        center: { x: p.position.x, y: (top + bottom) / 2, z: p.position.z },
        halfExtents: { x: half, y: (top - bottom) / 2, z: half },
        yaw: 0,
      },
    ]
  }
  return [{ ...base, shape: "cylinder", base: { x: p.position.x, y: bottom, z: p.position.z }, radius: half, height: top - bottom }]
}

function buildProp(ctx: BuildContext, prop: PropObject): OccluderPrimitive[] {
  const def = PROP_LIBRARY[prop.kind]
  if (!def) return []
  const blocks: BlockFlags = { movement: prop.blocksMovement, sight: prop.blocksSight, light: prop.castsShadows }
  if (!blocks.movement && !blocks.sight && !blocks.light) return []
  const terrain = ctx.terrain(prop.levelId)
  const sx = Math.abs(prop.scale.x)
  const sy = Math.abs(prop.scale.y)
  const sz = Math.abs(prop.scale.z)
  const yaw = prop.rotationY
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  // Terrain rule: the prop's base sits at ground(centre) + y.
  const baseY = terrain.heightAt(prop.position.x, prop.position.z) + prop.position.y
  const resting = prop.position.y === 0
  const out: OccluderPrimitive[] = []
  def.parts.forEach((part, k) => {
    const lx = part.offset.x * sx
    const lz = part.offset.z * sz
    const cx = prop.position.x + cos * lx + sin * lz
    const cz = prop.position.z - sin * lx + cos * lz
    const y0 = baseY + part.offset.y * sy
    const h = part.size.y * sy
    if (!(h > 0)) return
    const common = {
      key: partKey(prop.id, k, String(k)),
      sourceId: prop.id,
      sourceType: "prop" as const,
      levelId: prop.levelId,
      blocks: { ...blocks },
    }
    if (part.shape === "box") {
      const hx = (part.size.x * sx) / 2
      const hz = (part.size.z * sz) / 2
      if (!(hx > 0 && hz > 0)) return
      // Parts resting on the ground reach down to the lowest ground under them (no gap on slopes).
      const bottom =
        resting && part.offset.y === 0
          ? Math.min(y0, terrain.rangeOverPolygon(orientedRectCorners({ x: cx, z: cz }, hx, hz, yaw)).min)
          : y0
      const top = y0 + h
      out.push({
        ...common,
        shape: "box",
        center: { x: cx, y: (top + bottom) / 2, z: cz },
        halfExtents: { x: hx, y: (top - bottom) / 2, z: hz },
        yaw,
      } satisfies OrientedBox)
    } else {
      const radius = (Math.max(sx, sz) * part.size.x) / 2
      if (!(radius > 0)) return
      const bottom =
        resting && part.offset.y === 0
          ? Math.min(y0, terrain.rangeOverPolygon(orientedRectCorners({ x: cx, z: cz }, radius, radius, 0)).min)
          : y0
      out.push({
        ...common,
        shape: "cylinder",
        base: { x: cx, y: bottom, z: cz },
        radius,
        height: y0 + h - bottom,
      } satisfies VerticalCylinder)
    }
  })
  return out
}

// ---------------------------------------------------------------------------
// Dependency info (what a source's primitives depend on), for incremental updates
// ---------------------------------------------------------------------------

export interface SourceInfo {
  type: SceneObjectType
  levelId: Id
  /** Walls: endpoints (joints of neighbours depend on them). */
  a?: Vec2
  b?: Vec2
  /** Openings: host wall and a signature of the fields the host wall's pieces depend on. */
  wallId?: Id
  openingSig?: string
  /** Connectors: upper level (floor cutouts of the levels in between depend on it). */
  toLevelId?: Id
}

export function openingSignature(o: Opening): string {
  return o.type === "door"
    ? `door|${o.wallId}|${o.offset}|${o.width}|${o.height}`
    : `window|${o.wallId}|${o.offset}|${o.width}|${o.sillHeight}|${o.height}`
}

export function sourceInfo(o: SceneObject): SourceInfo | null {
  switch (o.type) {
    case "wall":
      return { type: o.type, levelId: o.levelId, a: { ...o.a }, b: { ...o.b } }
    case "door":
    case "window":
      return { type: o.type, levelId: o.levelId, wallId: o.wallId, openingSig: openingSignature(o) }
    case "connector":
      return { type: o.type, levelId: o.levelId, toLevelId: o.toLevelId }
    case "floor":
    case "pillar":
    case "prop":
      return { type: o.type, levelId: o.levelId }
    case "light":
      return null
  }
}

/** Conservative XZ footprint rect of an object (for terrain-edit invalidation). */
export function objectFootprintRect(o: SceneObject): Rect | null {
  switch (o.type) {
    case "wall": {
      const m = o.thickness
      const x0 = Math.min(o.a.x, o.b.x) - m
      const z0 = Math.min(o.a.z, o.b.z) - m
      return { x: x0, z: z0, w: Math.max(o.a.x, o.b.x) + m - x0, d: Math.max(o.a.z, o.b.z) + m - z0 }
    }
    case "floor":
    case "connector":
      return o.rect
    case "pillar":
      return { x: o.position.x - o.size / 2, z: o.position.z - o.size / 2, w: o.size, d: o.size }
    case "prop": {
      const def = PROP_LIBRARY[o.kind]
      if (!def) return null
      // Radius of the scaled library bounding box plus part offsets, rotation-independent.
      let r = 0
      for (const part of def.parts) {
        const ox = Math.abs(part.offset.x * o.scale.x)
        const oz = Math.abs(part.offset.z * o.scale.z)
        const ex = (part.size.x * Math.max(Math.abs(o.scale.x), Math.abs(o.scale.z))) / 2
        const ez = (part.size.z * Math.max(Math.abs(o.scale.x), Math.abs(o.scale.z))) / 2
        r = Math.max(r, Math.hypot(ox + ex, oz + ez))
      }
      return { x: o.position.x - r, z: o.position.z - r, w: 2 * r, d: 2 * r }
    }
    case "door":
    case "window":
    case "light":
      return null
  }
}
