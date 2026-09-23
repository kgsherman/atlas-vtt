/**
 * Level changes the HUD offers (ARCHITECTURE §2 "Connectors", §8): ladders are climbed in place with a
 * "Climb up / down" button; stairs and ramps change level by an orthogonal step across their top edge,
 * offered as "Go up" (token on the top row, lower level) / "Go down" (token on the cell beyond the top
 * edge, upper level). Drags path across the top edge too (the move planner prefers the upper level for
 * a drop just beyond it).
 */
import { footprintCells, tokenAnchor } from "@/core/movement"
import {
  connectorSpan,
  footprintAlong,
  footprintWithinLateral,
} from "@/core/movement/context"
import type { PathStep } from "@/core/movement/types"
import { levelById, rectsOverlap } from "@/core/scene/queries"
import type {
  Cell,
  ConnectorObject,
  Id,
  SceneLike,
  Token,
} from "@/core/scene/types"

export interface ClimbOption {
  direction: "up" | "down"
  connectorId: Id
  /** Ladders are climbed ("Climb up"); stairs and ramps are walked ("Go up"). */
  style: ConnectorObject["style"]
  toLevelId: Id
  /** Level name as the viewer knows it (null for unexplored stub levels). */
  toLevelName: string | null
  /** The move to request: start step + the switch in place. */
  path: PathStep[]
}

/**
 * Level changes available from where a token stands, up first: ladders under its footprint (switch in
 * place) and stairs/ramps whose top edge it stands next to (one step across it). The caller validates
 * the paths (a blocked landing is not offered).
 */
export function climbOptions(scene: SceneLike, token: Token): ClimbOption[] {
  const s = scene.grid.cellSize
  const anchor = tokenAnchor(scene, token)
  const k = footprintCells(token.size)
  const foot = { x: anchor.i * s, z: anchor.j * s, w: k * s, d: k * s }
  const start: PathStep = { cell: anchor, levelId: token.levelId }
  const out: ClimbOption[] = []
  const seen = new Set<Id>()
  const offer = (
    o: ConnectorObject,
    other: Id,
    direction: "up" | "down",
    to: PathStep
  ) => {
    if (seen.has(other) || !levelById(scene, other)) return
    seen.add(other)
    out.push({
      direction,
      connectorId: o.id,
      style: o.style,
      toLevelId: other,
      toLevelName: scene.levels[other].name || null,
      path: [start, to],
    })
  }
  for (const id of Object.keys(scene.objects).sort()) {
    const o = scene.objects[id]
    if (o.type !== "connector") continue
    if (o.style === "ladder") {
      if (!overlapsPositive(foot, o.rect)) continue
      const other = otherLevel(o, token.levelId)
      if (!other) continue
      offer(o, other, other === o.toLevelId ? "up" : "down", {
        cell: { ...anchor },
        levelId: other,
      })
      continue
    }
    const sp = connectorSpan(o, s)
    if (!sp) continue
    const onTopRow = (lower: Cell) =>
      footprintWithinLateral(sp, lower, k) &&
      footprintAlong(sp, lower, k).hi === sp.top
    if (token.levelId === o.levelId && onTopRow(anchor)) {
      offer(o, o.toLevelId, "up", {
        cell: { i: anchor.i + sp.fwd.i, j: anchor.j + sp.fwd.j },
        levelId: o.toLevelId,
      })
    } else if (token.levelId === o.toLevelId) {
      const lower = { i: anchor.i - sp.fwd.i, j: anchor.j - sp.fwd.j }
      if (onTopRow(lower))
        offer(o, o.levelId, "down", { cell: lower, levelId: o.levelId })
    }
  }
  return out.sort((a, b) =>
    a.direction === b.direction ? 0 : a.direction === "up" ? -1 : 1
  )
}

function otherLevel(c: ConnectorObject, levelId: Id): Id | null {
  if (c.levelId === levelId) return c.toLevelId
  if (c.toLevelId === levelId) return c.levelId
  return null
}

function overlapsPositive(
  a: { x: number; z: number; w: number; d: number },
  b: { x: number; z: number; w: number; d: number }
): boolean {
  const eps = 1e-6
  return (
    rectsOverlap(a, b) &&
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > eps &&
    Math.min(a.z + a.d, b.z + b.d) - Math.max(a.z, b.z) > eps
  )
}
