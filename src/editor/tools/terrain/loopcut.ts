/**
 * Loop cut sub-tool (Blender's Ctrl+R, for terrain shapes): hovering a shape previews a cut across its top
 * through the edge nearest the pointer, following the edge ring (core/scene/terrainShapes loopCutRing: each
 * top face crossed to its opposite side, on through earlier cuts, until the outline on both ends); a click
 * makes it, one undo step. New vertices sit on every crossed edge (interior ones where earlier cuts are
 * crossed), joined by new inner edges the top is split along (TerrainShape.innerEdges / innerPoints), so
 * raising them makes ridges; the shape keeps its form until then.
 *
 * Over a shape's top the edge (outline or inner) of the face under the pointer nearest to it is cut
 * through; over a side face, that side; otherwise an edge near the pointer on screen. One cut follows the pointer along the side,
 * snapped to eighths (Alt or free snapping: free); with more cuts (options bar, [ / ]) they are evenly
 * spaced. After the cut the new inner edges are selected in the advanced edge mode, ready to move (Q).
 */
import { pointInPolygon } from "@/core/geometry/polygon"
import { loopCut, loopCutRing, shapeEdgeEnds, TERRAIN_SHAPE_MAX_POINTS, topFaces, topVertexCount, topVertices } from "@/core/scene/terrainShapes"
import type { Id, TerrainShape, Vec2, Vec3 } from "@/core/scene/types"

import { TERRAIN_LOOP_CUTS_MAX } from "../../settings"
import { edgeHits, formatFeet, rayParam, shapeAcceptable, shapeHits } from "../../terrainMath"
import type { CursorKey, ToolPointerEvent } from "../types"
import { activeLevel, buriedTolerance, canvasOf, levelShapes, NO_PARTS, rayOf, snapModeOf, type SubTool, type TerrainToolContext } from "./context"

interface Hover {
  levelId: Id
  shapeId: Id
  /** Edge element under the pointer (outline k < n, inner n + c). */
  edge: number
  /** Pointer position along the edge (0..1 from its first end, shapeEdgeEnds order), unsnapped. */
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
    return shape && shapeEdgeEnds(shape, h.edge) ? shape : null
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
      const ring = loopCutRing(shape, h.edge)
      if (!ring) reason = "No loop here: it would reach a face with an odd number of sides"
      else if (topVertexCount(shape) + ring.length * ts.length > TERRAIN_SHAPE_MAX_POINTS)
        reason = `Too many vertices: a shape has at most ${TERRAIN_SHAPE_MAX_POINTS}`
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
        const edge = typeof h.face === "number" && h.face < shape.points.length ? h.face : sideNear(shape, p)
        if (edge !== null) return { levelId: a.levelId, shapeId: shape.id, edge, t: paramOn(shape, edge, p) }
      }
    }
    const cursor = canvasOf(e)
    if (deps.project && cursor) {
      const [h] = edgeHits(shapes, elevation, deps.project, cursor)
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
      const verts = topVertices(shape)
      const along = ([u, v]: readonly [number, number], t: number) => lerp(verts[u], verts[v], t)
      const [u, v] = shapeEdgeEnds(shape, hover.edge)!
      let segments: [Vec3, Vec3][]
      if (plan.result) {
        const next = plan.result.shape
        const nv = topVertices(next)
        const n = next.points.length
        segments = plan.result.edges.map((k) => {
          const [a, b] = next.innerEdges![k - n]
          return [w(nv[a]), w(nv[b])]
        })
      } else {
        // Where it would go along the ring, or the hovered edge alone.
        const ring = loopCutRing(shape, hover.edge)
        segments = ring
          ? plan.ts.flatMap((t) => ring.slice(1).map((e, i): [Vec3, Vec3] => [w(along(ring[i], t)), w(along(e, t))]))
          : [[w(verts[u]), w(verts[v])]]
      }
      const len = Math.hypot(verts[v].x - verts[u].x, verts[v].z - verts[u].z)
      const t = plan.ts[0]
      const text = !plan.result ? "Can't cut here" : plan.ts.length > 1 ? `${plan.ts.length} cuts` : `${formatFeet(t * len)} | ${formatFeet((1 - t) * len)} ft`
      return {
        ...NO_PARTS,
        hoverShapeId: shape.id,
        cuts: { segments, valid: plan.result !== null },
        label: { at: w(along([u, v], t)), text },
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

/** Position (0..1) of `p`'s projection onto edge element `edge` (x, z), from its first end. */
function paramOn(shape: TerrainShape, edge: number, p: Vec2): number {
  const [u, v] = shapeEdgeEnds(shape, edge)!
  const verts = topVertices(shape)
  const a = verts[u]
  const b = verts[v]
  const ex = b.x - a.x
  const ez = b.z - a.z
  const len2 = ex * ex + ez * ez
  return len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.z - a.z) * ez) / len2)) : 0.5
}

/**
 * The edge element of the top face under `p` nearest to it (outline or inner), preferring edges a loop can
 * run through; any outline edge when no face contains `p`. Null for an empty shape.
 */
function sideNear(shape: TerrainShape, p: Vec2): number | null {
  const n = shape.points.length
  const verts = topVertices(shape)
  const face = topFaces(shape).find((f) =>
    pointInPolygon(
      p,
      f.map((k) => verts[k])
    )
  )
  const inner = shape.innerEdges ?? []
  const edgeOf = (a: number, b: number): number => {
    if (a < n && b === (a + 1) % n) return a
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    return n + inner.findIndex(([x, y]) => x === lo && y === hi)
  }
  const sides = face ? face.map((a, i) => edgeOf(a, face[(i + 1) % face.length])).filter((k) => k >= 0) : Array.from({ length: n }, (_, k) => k)
  if (sides.length === 0) return null
  const cuttable = sides.filter((k) => loopCutRing(shape, k) !== null)
  const pool = cuttable.length > 0 ? cuttable : sides
  let best = pool[0]
  let bestD = Infinity
  for (const k of pool) {
    const [u, v] = shapeEdgeEnds(shape, k)!
    const q = lerp(verts[u], verts[v], paramOn(shape, k, p))
    const d = Math.hypot(q.x - p.x, q.z - p.z)
    if (d < bestD) {
      bestD = d
      best = k
    }
  }
  return best
}
