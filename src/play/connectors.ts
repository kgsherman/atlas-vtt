/**
 * Level changes the HUD offers (ARCHITECTURE §2 "Connectors", §8): ladders are climbed in place with a
 * "Climb up / down" button; stairs and ramps are climbed by pathing across their top edge (the move
 * planner does that for drags), so they only get a hint here.
 */
import { footprintCells, tokenAnchor } from "@/core/movement"
import type { PathStep } from "@/core/movement/types"
import { levelById, rectsOverlap } from "@/core/scene/queries"
import type { ConnectorObject, Id, SceneLike, Token } from "@/core/scene/types"

export interface ClimbOption {
  direction: "up" | "down"
  connectorId: Id
  toLevelId: Id
  /** Level name as the viewer knows it (null for unexplored stub levels). */
  toLevelName: string | null
  /** The move to request: start step + the switch in place. */
  path: PathStep[]
}

/** Ladders under a token's footprint that switch it to another level, up first. */
export function climbOptions(scene: SceneLike, token: Token): ClimbOption[] {
  const s = scene.grid.cellSize
  const anchor = tokenAnchor(scene, token)
  const k = footprintCells(token.size)
  const foot = { x: anchor.i * s, z: anchor.j * s, w: k * s, d: k * s }
  const start: PathStep = { cell: anchor, levelId: token.levelId }
  const out: ClimbOption[] = []
  const seen = new Set<Id>()
  for (const id of Object.keys(scene.objects).sort()) {
    const o = scene.objects[id]
    if (o.type !== "connector" || o.style !== "ladder") continue
    if (!overlapsPositive(foot, o.rect)) continue
    const other = otherLevel(o, token.levelId)
    if (!other || seen.has(other) || !levelById(scene, other)) continue
    seen.add(other)
    const level = scene.levels[other]
    const direction = other === o.toLevelId ? "up" : "down"
    out.push({
      direction,
      connectorId: o.id,
      toLevelId: other,
      toLevelName: level.name || null,
      path: [start, { cell: { ...anchor }, levelId: other }],
    })
  }
  return out.sort((a, b) =>
    a.direction === b.direction ? 0 : a.direction === "up" ? -1 : 1
  )
}

/** Stairs / ramps whose footprint the token stands on (for a "walk up the stairs" hint). */
export function stairsUnder(scene: SceneLike, token: Token): ConnectorObject[] {
  const s = scene.grid.cellSize
  const anchor = tokenAnchor(scene, token)
  const k = footprintCells(token.size)
  const foot = { x: anchor.i * s, z: anchor.j * s, w: k * s, d: k * s }
  const out: ConnectorObject[] = []
  for (const o of Object.values(scene.objects)) {
    if (o.type !== "connector" || o.style === "ladder") continue
    if (
      (o.levelId === token.levelId || o.toLevelId === token.levelId) &&
      overlapsPositive(foot, o.rect)
    )
      out.push(o)
  }
  return out
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
