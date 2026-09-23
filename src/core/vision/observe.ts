/**
 * Observation (docs/ARCHITECTURE.md §5.4): the objects the viewers observe right now. Drives
 * per-player memory in core/session.
 *
 * - door / window / pillar / prop / connector: a perceived cell (or sub-cell) intersects the object's
 *   OWN footprint (openings: their segment ± half the host wall's thickness; connectors: checked on
 *   their lower and upper level);
 * - wall / floor: a perceived cell (or sub-cell) intersects its footprint (walls: the segment
 *   inflated by thickness / 2; floors: their effective rects after connector cutouts);
 * - static light: its source point is in line of sight of a non-blind viewer while it is on and not
 *   hidden, or the cell (sub-cell) under it is perceived;
 * - attached lights are never observed as objects (they travel with their carrier token).
 *
 * Overlaps are strict (positive area): a perceived cell that only touches a footprint's edge does
 * not observe it. Hidden objects are reported like any other; the session decides what players get.
 */
import { convexPolygonsOverlap } from "../geometry/polygon"
import type { OcclusionWorld } from "../occlusion/types"
import { PROP_LIBRARY } from "../scene/defaults"
import { effectiveFloorRects, lightWorldPosition, openingSegment, type EffectiveFloor } from "../scene/queries"
import type { Id, LightObject, SceneLike, SceneObject, Vec2, Vec3 } from "../scene/types"
import { SUBCELLS, type GradeMask, type Viewer } from "./types"

export interface FootprintShape {
  /** Axis-aligned bounds. */
  x0: number
  z0: number
  x1: number
  z1: number
  /** Convex outline; null = the bounds themselves (axis-aligned rect). */
  pts: Vec2[] | null
}

export interface ObjectFootprint {
  /** Levels whose perception is checked. */
  levelIds: Id[]
  shapes: FootprintShape[]
}

const CIRCLE_SIDES = 16

function rectShape(x0: number, z0: number, x1: number, z1: number): FootprintShape {
  return { x0, z0, x1, z1, pts: null }
}

function polyShape(pts: Vec2[]): FootprintShape {
  let x0 = Infinity
  let z0 = Infinity
  let x1 = -Infinity
  let z1 = -Infinity
  for (const p of pts) {
    x0 = Math.min(x0, p.x)
    z0 = Math.min(z0, p.z)
    x1 = Math.max(x1, p.x)
    z1 = Math.max(z1, p.z)
  }
  return { x0, z0, x1, z1, pts }
}

/** Rectangle centred on c with half extents hu along the unit direction (ux, uz) and hv across it. */
function orientedShape(cx: number, cz: number, ux: number, uz: number, hu: number, hv: number): FootprintShape | null {
  if (!(hu > 0 && hv > 0)) return null
  // Axis-aligned directions give exact rects.
  if (Math.abs(ux) < 1e-12 || Math.abs(uz) < 1e-12) {
    const ex = Math.abs(ux) * hu + Math.abs(uz) * hv
    const ez = Math.abs(uz) * hu + Math.abs(ux) * hv
    return rectShape(cx - ex, cz - ez, cx + ex, cz + ez)
  }
  const vx = -uz
  const vz = ux
  return polyShape([
    { x: cx - ux * hu - vx * hv, z: cz - uz * hu - vz * hv },
    { x: cx + ux * hu - vx * hv, z: cz + uz * hu - vz * hv },
    { x: cx + ux * hu + vx * hv, z: cz + uz * hu + vz * hv },
    { x: cx - ux * hu + vx * hv, z: cz - uz * hu + vz * hv },
  ])
}

function circleShape(cx: number, cz: number, r: number): FootprintShape | null {
  if (!(r > 0)) return null
  const pts: Vec2[] = []
  for (let k = 0; k < CIRCLE_SIDES; k++) {
    const a = (2 * Math.PI * k) / CIRCLE_SIDES
    pts.push({ x: cx + r * Math.cos(a), z: cz + r * Math.sin(a) })
  }
  return polyShape(pts)
}

/**
 * Footprint of an object for observation, or null when it has none (lights, zero-size shapes,
 * openings without a host wall). `floors` supplies effective floor rects per level.
 */
export function objectFootprint(
  scene: Pick<SceneLike, "objects">,
  o: SceneObject,
  floors: (levelId: Id) => readonly EffectiveFloor[]
): ObjectFootprint | null {
  const shapes: FootprintShape[] = []
  const push = (s: FootprintShape | null) => {
    if (s && s.x1 > s.x0 && s.z1 > s.z0) shapes.push(s)
  }
  let levelIds = [o.levelId]
  switch (o.type) {
    case "floor":
      for (const f of floors(o.levelId)) {
        if (f.floorId === o.id) push(rectShape(f.rect.x, f.rect.z, f.rect.x + f.rect.w, f.rect.z + f.rect.d))
      }
      break
    case "wall": {
      const len = Math.hypot(o.b.x - o.a.x, o.b.z - o.a.z)
      const half = o.thickness / 2
      const ux = len > 0 ? (o.b.x - o.a.x) / len : 1
      const uz = len > 0 ? (o.b.z - o.a.z) / len : 0
      push(orientedShape((o.a.x + o.b.x) / 2, (o.a.z + o.b.z) / 2, ux, uz, len / 2 + half, half))
      break
    }
    case "door":
    case "window": {
      const wall = Object.hasOwn(scene.objects, o.wallId) ? scene.objects[o.wallId] : undefined
      if (!wall || wall.type !== "wall") return null
      const seg = openingSegment(wall, o)
      const len = Math.hypot(seg.b.x - seg.a.x, seg.b.z - seg.a.z)
      if (!(len > 0)) return null
      push(
        orientedShape(
          (seg.a.x + seg.b.x) / 2,
          (seg.a.z + seg.b.z) / 2,
          (seg.b.x - seg.a.x) / len,
          (seg.b.z - seg.a.z) / len,
          len / 2,
          wall.thickness / 2
        )
      )
      break
    }
    case "connector":
      levelIds = o.toLevelId === o.levelId ? [o.levelId] : [o.levelId, o.toLevelId]
      push(rectShape(o.rect.x, o.rect.z, o.rect.x + o.rect.w, o.rect.z + o.rect.d))
      break
    case "pillar": {
      const h = o.size / 2
      push(o.shape === "square" ? rectShape(o.position.x - h, o.position.z - h, o.position.x + h, o.position.z + h) : circleShape(o.position.x, o.position.z, h))
      break
    }
    case "prop": {
      const def = PROP_LIBRARY[o.kind]
      if (!def) return null
      const sx = Math.abs(o.scale.x)
      const sz = Math.abs(o.scale.z)
      const cos = Math.cos(o.rotationY)
      const sin = Math.sin(o.rotationY)
      // Same part transform as core/occlusion (local +X maps to (cos, −sin)).
      for (const part of def.parts) {
        const lx = part.offset.x * sx
        const lz = part.offset.z * sz
        const cx = o.position.x + cos * lx + sin * lz
        const cz = o.position.z - sin * lx + cos * lz
        if (part.shape === "box") push(orientedShape(cx, cz, cos, -sin, (part.size.x * sx) / 2, (part.size.z * sz) / 2))
        else push(circleShape(cx, cz, (Math.max(sx, sz) * part.size.x) / 2))
      }
      break
    }
    case "light":
      return null
  }
  return shapes.length > 0 ? { levelIds, shapes } : null
}

function rectHitsShape(shape: FootprintShape, x0: number, z0: number, x1: number, z1: number, rectPts: Vec2[]): boolean {
  if (!(x0 < shape.x1 && shape.x0 < x1 && z0 < shape.z1 && shape.z0 < z1)) return false
  if (shape.pts === null) return true
  rectPts[0].x = x0
  rectPts[0].z = z0
  rectPts[1].x = x1
  rectPts[1].z = z0
  rectPts[2].x = x1
  rectPts[2].z = z1
  rectPts[3].x = x0
  rectPts[3].z = z1
  return convexPolygonsOverlap(shape.pts, rectPts)
}

/** Whether any perceived cell or sub-cell of a level's grade mask overlaps the shape (positive area). */
export function maskTouchesShape(m: GradeMask, cellSize: number, shape: FootprintShape): boolean {
  const s = cellSize
  const q = s / SUBCELLS
  const i0 = Math.max(0, Math.floor(shape.x0 / s))
  const j0 = Math.max(0, Math.floor(shape.z0 / s))
  const i1 = Math.min(m.width - 1, Math.ceil(shape.x1 / s) - 1)
  const j1 = Math.min(m.depth - 1, Math.ceil(shape.z1 / s) - 1)
  const pts: Vec2[] = [
    { x: 0, z: 0 },
    { x: 0, z: 0 },
    { x: 0, z: 0 },
    { x: 0, z: 0 },
  ]
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const c = j * m.width + i
      if (m.grades[c] === 0) continue
      const x = i * s
      const z = j * s
      const partial = m.partial.get(c)
      if (partial === undefined) {
        if (rectHitsShape(shape, x, z, x + s, z + s, pts)) return true
        continue
      }
      for (let b = 0; b < SUBCELLS * SUBCELLS; b++) {
        if ((partial & (1 << b)) === 0) continue
        const sx = x + (b % SUBCELLS) * q
        const sz = z + Math.floor(b / SUBCELLS) * q
        if (rectHitsShape(shape, sx, sz, sx + q, sz + q, pts)) return true
      }
    }
  }
  return false
}

/** Whether the cell (sub-cell) containing (x, z) is perceived. */
export function maskHasPoint(m: GradeMask, cellSize: number, x: number, z: number): boolean {
  const i = Math.floor(x / cellSize)
  const j = Math.floor(z / cellSize)
  if (i < 0 || j < 0 || i >= m.width || j >= m.depth) return false
  const c = j * m.width + i
  if (m.grades[c] === 0) return false
  const partial = m.partial.get(c)
  if (partial === undefined) return true
  const q = cellSize / SUBCELLS
  const sx = Math.min(SUBCELLS - 1, Math.floor((x - i * cellSize) / q))
  const sz = Math.min(SUBCELLS - 1, Math.floor((z - j * cellSize) / q))
  return (partial & (1 << (sz * SUBCELLS + sx))) !== 0
}

/** Footprints cached per object; valid while the object (and an opening's host wall) is unchanged. */
export class FootprintCache {
  private readonly entries = new Map<Id, { o: SceneObject; host: SceneObject | undefined; epoch: number; fp: ObjectFootprint | null }>()

  get(scene: Pick<SceneLike, "objects">, o: SceneObject, floors: (levelId: Id) => readonly EffectiveFloor[], floorsEpoch: number): ObjectFootprint | null {
    const host = o.type === "door" || o.type === "window" ? (Object.hasOwn(scene.objects, o.wallId) ? scene.objects[o.wallId] : undefined) : undefined
    const hit = this.entries.get(o.id)
    if (hit && hit.o === o && hit.host === host && (o.type !== "floor" || hit.epoch === floorsEpoch)) return hit.fp
    const fp = objectFootprint(scene, o, floors)
    this.entries.set(o.id, { o, host, epoch: floorsEpoch, fp })
    return fp
  }

  /**
   * Drop entries for changed ids (for scenes mutated in place). `walls` lists changed wall ids: the
   * cached footprints of the openings they host are dropped too.
   */
  invalidate(ids: Iterable<Id>, walls: ReadonlySet<Id>): void {
    for (const id of ids) this.entries.delete(id)
    if (walls.size === 0) return
    for (const [id, e] of this.entries) {
      if ((e.o.type === "door" || e.o.type === "window") && walls.has(e.o.wallId)) this.entries.delete(id)
    }
  }

  clear(): void {
    this.entries.clear()
  }
}

export interface ObserveOptions {
  /** Footprint provider (defaults to objectFootprint with effective floors computed on demand). */
  footprint?: (o: SceneObject) => ObjectFootprint | null
  /** World position of a static light (defaults to lightWorldPosition). */
  lightPosition?: (light: LightObject) => Vec3
}

/**
 * Objects observed right now by the viewers, given the union perception per level (§5.4).
 * `world` is used for the line-of-sight test of lit static lights.
 */
export function observedObjectIds(
  scene: SceneLike,
  perception: Readonly<Record<Id, GradeMask>>,
  viewers: readonly Viewer[],
  world: OcclusionWorld,
  opts: ObserveOptions = {}
): Set<Id> {
  const cellSize = scene.grid.cellSize
  const out = new Set<Id>()
  let footprint = opts.footprint
  if (!footprint) {
    const floorCache = new Map<Id, EffectiveFloor[]>()
    const floors = (levelId: Id) => {
      let f = floorCache.get(levelId)
      if (!f) floorCache.set(levelId, (f = effectiveFloorRects(scene, levelId)))
      return f
    }
    footprint = (o) => objectFootprint(scene, o, floors)
  }
  const seeing = viewers.filter((v) => !v.vision.blind)
  const perceived = (levelId: Id) => Object.hasOwn(perception, levelId)
  for (const id of Object.keys(scene.objects)) {
    const o = scene.objects[id]
    // Cheap level pre-check before any footprint work (connectors are checked on both levels).
    if (o.type !== "light" && !perceived(o.levelId) && !(o.type === "connector" && perceived(o.toLevelId))) continue
    if (o.type === "light") {
      if (o.attachedTokenId) continue
      const pos = opts.lightPosition ? opts.lightPosition(o) : lightWorldPosition(scene, o)
      const m = Object.hasOwn(perception, o.levelId) ? perception[o.levelId] : undefined
      if (m && maskHasPoint(m, cellSize, pos.x, pos.z)) {
        out.add(id)
        continue
      }
      if (!o.on || o.hidden) continue
      for (const v of seeing) {
        if (!world.segmentBlocked(v.eye, pos, { channel: "sight" })) {
          out.add(id)
          break
        }
      }
      continue
    }
    const fp = footprint(o)
    if (!fp) continue
    let seen = false
    for (const levelId of fp.levelIds) {
      const m = Object.hasOwn(perception, levelId) ? perception[levelId] : undefined
      if (!m) continue
      for (const shape of fp.shapes) {
        if (maskTouchesShape(m, cellSize, shape)) {
          seen = true
          break
        }
      }
      if (seen) break
    }
    if (seen) out.add(id)
  }
  return out
}
