/**
 * Loop cut sub-tool (Blender's Ctrl+R, for terrain shapes): hovering a shape previews a cut across its top,
 * from the side under the pointer to the opposite side of that top face (core/scene/terrainShapes
 * loopCutOpposite: faces with an even number of sides whose opposite side is on the outline); a click
 * makes it, one undo step. The new vertices sit on the two sides, joined by an inner edge the top is split
 * along (TerrainShape.innerEdges), so raising that edge makes a ridge; the shape keeps its form until then.
 *
 * Over a shape's top the side nearest the pointer inside the face under it is cut; over a side face, that
 * side; otherwise an outline edge near the pointer on screen. One cut follows the pointer along the side,
 * snapped to eighths (Alt or free snapping: free); with more cuts (options bar, [ / ]) they are evenly
 * spaced. After the cut the new inner edges are selected in the advanced edge mode, ready to move (Q).
 */
import { pointInPolygon } from "@/core/geometry/polygon"
import { loopCut, loopCutOpposite, TERRAIN_SHAPE_MAX_POINTS, topFaces } from "@/core/scene/terrainShapes"
import type { Id, TerrainShape, Vec2, Vec3 } from "@/core/scene/types"

import { TERRAIN_LOOP_CUTS_MAX } from "../../settings"
import { edgeHits, formatFeet, rayParam, shapeAcceptable, shapeHits } from "../../terrainMath"
import type { CursorKey, ToolPointerEvent } from "../types"
import { activeLevel, buriedTolerance, canvasOf, levelShapes, NO_PARTS, rayOf, snapModeOf, type SubTool, type TerrainToolContext } from "./context"

interface Hover {
  levelId: Id
  shapeId: Id
  /** Outline edge under the pointer. */
  edge: number
  /** Pointer position along the edge (0..1 from its first vertex), unsnapped. */
  t: number
}

interface Plan {
  shape: TerrainShape
  ts: number[]
  result: ReturnType<typeof loopCut>
  /** Why there is no result (null when there is one). */
  reason: string | null
}

/** One cut's position snaps to this fraction of the side (unless free). */
const SNAP_FRACTION = 1 / 8
/** A free cut stays this fraction of the side away from its ends. */
const FREE_MARGIN = 0.01

const HOVER_KEYS: readonly CursorKey[] = [
  { mouse: "Click", label: "Cut" },
  { commands: ["brush.smaller", "brush.larger"], label: "Fewer / more cuts" },
  { mouse: "Alt", label: "Free position" },
]

export function createLoopCutSubTool(ctx: TerrainToolContext): SubTool {
  const { store, deps } = ctx
  let hover: Hover | null = null
  let planCache: { key: string; shape: TerrainShape; plan: Plan } | null = null

  const cutCount = () => Math.max(1, Math.min(TERRAIN_LOOP_CUTS_MAX, Math.round(store.getState().toolSettings.terrain.loopCuts) || 1))

  /** Cut positions along the hovered edge. */
  const positions = (h: Hover): number[] => {
    const count = cutCount()
    if (count > 1) return Array.from({ length: count }, (_, i) => (i + 1) / (count + 1))
    if (snapModeOf(store, { alt: store.getState().altHeld }) === "free") return [Math.min(1 - FREE_MARGIN, Math.max(FREE_MARGIN, h.t))]
    return [Math.min(1 - SNAP_FRACTION, Math.max(SNAP_FRACTION, Math.round(h.t / SNAP_FRACTION) * SNAP_FRACTION))]
  }

  const shapeOf = (h: Hover): TerrainShape | null => {
    const s = store.getState()
    if (!Object.hasOwn(s.scene.levels, h.levelId)) return null
    const shape = levelShapes(s.scene.levels[h.levelId])[h.shapeId]
    return shape && h.edge < shape.points.length ? shape : null
  }

  const planOf = (h: Hover): Plan | null => {
    const shape = shapeOf(h)
    if (!shape) return null
    const ts = positions(h)
    const key = `${h.edge}|${ts.join(",")}`
    if (planCache && planCache.shape === shape && planCache.key === key) return planCache.plan
    const result = loopCut(shape, h.edge, ts)
    let reason: string | null = null
    if (!result) {
      if (loopCutOpposite(shape, h.edge) === null) reason = "No loop here: the face has an odd number of sides, or the loop would cross a loop cut"
      else if (shape.points.length + 2 * ts.length > TERRAIN_SHAPE_MAX_POINTS) reason = `Too many vertices: a shape has at most ${TERRAIN_SHAPE_MAX_POINTS}`
      else reason = "This cut would leave the shape"
    }
    const plan = { shape, ts, result, reason }
    planCache = { key, shape, plan }
    return plan
  }

  /** The shape side under the pointer and the pointer's position along it. */
  const hoverAt = (e: ToolPointerEvent): Hover | null => {
    const s = store.getState()
    const a = activeLevel(s)
    if (!a || s.readOnly) return null
    const record = levelShapes(a.level)
    const shapes = Object.values(record)
    if (shapes.length === 0) return null
    const elevation = a.level.elevation
    const ray = rayOf(e)
    if (ray) {
      const groundT = e.pick.ground ? rayParam(ray, e.pick.ground) : null
      const [h] = shapeHits(shapes, elevation, ray, { groundT, tolerance: buriedTolerance(a.level, s.scene.grid.cellSize) })
      if (h) {
        const shape = record[h.shapeId]
        const p = { x: h.point.x, z: h.point.z }
        const edge = h.face === "top" ? sideNear(shape, p) : h.face
        if (edge !== null) return { levelId: a.levelId, shapeId: shape.id, edge, t: paramOn(shape, edge, p) }
      }
    }
    const cursor = canvasOf(e)
    if (deps.project && cursor) {
      const [h] = edgeHits(shapes, elevation, deps.project, cursor, undefined, true)
      if (h) {
        const shape = record[h.ref.shapeId]
        return { levelId: a.levelId, shapeId: shape.id, edge: h.ref.index as number, t: paramOn(shape, h.ref.index as number, h.point) }
      }
    }
    return null
  }

  const hoverKey = (h: Hover | null) => (h ? `${h.levelId}|${h.shapeId}|${h.edge}|${positions(h).join(",")}` : "")

  const commit = () => {
    const h = hover
    const plan = h ? planOf(h) : null
    if (!h || !plan) return
    if (!plan.result) {
      ctx.notify(plan.reason)
      return
    }
    const s = store.getState()
    const { shape, edges } = plan.result
    if (!shapeAcceptable(shape, s.scene.grid)) {
      ctx.notify("This cut would leave the shape")
      return
    }
    const label = plan.ts.length > 1 ? `Loop cut terrain shape (${plan.ts.length} cuts)` : "Loop cut terrain shape"
    if (!ctx.write(() => s.applyTerrainEdit(h.levelId, { upsert: [shape] }, label))) {
      ctx.notify("This cut would leave the shape")
      return
    }
    // The new inner edges, selected in the edge mode: ready to raise into a ridge with the Select tool.
    ctx.write(() => {
      store
        .getState()
        .setTerrainSelection({ levelId: h.levelId, shapeIds: [shape.id], elements: edges.map((index) => ({ shapeId: shape.id, kind: "edge", index })) })
      store.getState().setToolSettings("terrain", { advanced: true, element: "edge" })
    })
  }

  return {
    gestureLevel: () => null,
    captures: () => false,

    pointerDown(e) {
      if (e.button !== 0) return
      hover = hoverAt(e)
      commit()
      ctx.changed()
    },

    pointerMove(e) {
      const next = hoverAt(e)
      if (hoverKey(next) !== hoverKey(hover)) {
        hover = next
        ctx.changed()
      } else hover = next
    },

    pointerUp() {},

    key(k) {
      if (k.type !== "brush-size") return false
      const count = Math.max(1, Math.min(TERRAIN_LOOP_CUTS_MAX, cutCount() + (k.factor > 1 ? 1 : -1)))
      ctx.write(() => store.getState().setToolSettings("terrain", { loopCuts: count }))
      ctx.changed()
      return true
    },

    cancel() {
      hover = null
      planCache = null
    },

    refresh() {},

    parts() {
      if (!hover) return NO_PARTS
      const plan = planOf(hover)
      if (!plan) return NO_PARTS
      const s = store.getState()
      const elevation = s.scene.levels[hover.levelId].elevation
      const { shape } = plan
      const w = (p: Vec3): Vec3 => ({ x: p.x, y: elevation + p.y, z: p.z })
      let segments: [Vec3, Vec3][]
      if (plan.result) {
        const next = plan.result.shape
        const n = next.points.length
        // Each segment from the hovered side (where the label goes) across.
        const off = (p: Vec3) => distanceToEdge(shape, hover!.edge, p)
        segments = plan.result.edges.map((k) => {
          const [a, b] = next.innerEdges![k - n].map((i) => next.points[i])
          return off(a) <= off(b) ? [w(a), w(b)] : [w(b), w(a)]
        })
      } else {
        // Where it would go: across to the opposite side, or the hovered side alone.
        const n = shape.points.length
        const along = (k: number, t: number) => lerp(shape.points[k], shape.points[(k + 1) % n], t)
        const opp = loopCutOpposite(shape, hover.edge)
        segments =
          opp === null
            ? [[w(shape.points[hover.edge]), w(shape.points[(hover.edge + 1) % n])]]
            : plan.ts.map((t): [Vec3, Vec3] => [w(along(hover!.edge, t)), w(along(opp, 1 - t))])
      }
      const a = shape.points[hover.edge]
      const b = shape.points[(hover.edge + 1) % shape.points.length]
      const len = Math.hypot(b.x - a.x, b.z - a.z)
      const t = plan.ts[0]
      const text = !plan.result ? "Can't cut here" : plan.ts.length > 1 ? `${plan.ts.length} cuts` : `${formatFeet(t * len)} | ${formatFeet((1 - t) * len)} ft`
      return {
        ...NO_PARTS,
        hoverShapeId: shape.id,
        cuts: { segments, valid: plan.result !== null },
        label: { at: segments[0][0], text },
      }
    },

    cursorKeys() {
      return hover && planOf(hover)?.result ? HOVER_KEYS : null
    },

    cursor() {
      return store.getState().readOnly ? null : "crosshair"
    },

    hint() {
      const count = cutCount()
      const cuts = count > 1 ? `${count} cuts` : "one cut"
      if (!hover) return `Point at a shape's side to preview a loop cut (${cuts}; [ / ] change it)`
      const plan = planOf(hover)
      if (plan && !plan.result) return plan.reason
      return count > 1 ? `Click to make ${count} evenly spaced cuts ([ / ] change the count)` : "Click to cut (Alt: free position; [ / ] more cuts)"
    },
  }
}

const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t })

/** Position (0..1) of `p`'s projection onto outline edge `edge` (x, z). */
function paramOn(shape: TerrainShape, edge: number, p: Vec2): number {
  const n = shape.points.length
  const a = shape.points[edge]
  const b = shape.points[(edge + 1) % n]
  const ex = b.x - a.x
  const ez = b.z - a.z
  const len2 = ex * ex + ez * ez
  return len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.z - a.z) * ez) / len2)) : 0.5
}

/**
 * The outline side of the top face under `p` nearest to it, preferring sides a loop cut can start from;
 * any outline edge when no face contains `p`. Null for an empty shape.
 */
function sideNear(shape: TerrainShape, p: Vec2): number | null {
  const n = shape.points.length
  const faces = topFaces(n, shape.innerEdges)
  const face = faces.find((f) =>
    pointInPolygon(
      p,
      f.map((k) => shape.points[k])
    )
  )
  const sides: number[] = []
  if (face) {
    for (let i = 0; i < face.length; i++) {
      const u = face[i]
      if (face[(i + 1) % face.length] === (u + 1) % n) sides.push(u)
    }
  } else for (let k = 0; k < n; k++) sides.push(k)
  if (sides.length === 0) return null
  const cuttable = sides.filter((k) => loopCutOpposite(shape, k) !== null)
  const pool = cuttable.length > 0 ? cuttable : sides
  let best = pool[0]
  let bestD = Infinity
  for (const k of pool) {
    const t = paramOn(shape, k, p)
    const q = lerp(shape.points[k], shape.points[(k + 1) % n], t)
    const d = Math.hypot(q.x - p.x, q.z - p.z)
    if (d < bestD) {
      bestD = d
      best = k
    }
  }
  return best
}

/** Distance (x, z) from `p` to outline edge `edge`. */
function distanceToEdge(shape: TerrainShape, edge: number, p: Vec2): number {
  const q = lerp(shape.points[edge], shape.points[(edge + 1) % shape.points.length], paramOn(shape, edge, p))
  return Math.hypot(q.x - p.x, q.z - p.z)
}
