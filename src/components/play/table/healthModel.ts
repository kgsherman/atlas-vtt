/**
 * Which tokens get health bars and condition icons on the map: players from their view (the host
 * already chose exact hit points, a band or nothing per token), the DM from the game state (exact
 * hit points for everything).
 */
import * as React from "react"

import { footprintCells } from "@/core/movement"
import type {
  HealthBand,
  TokenCondition,
  TokenHp,
} from "@/core/scene/tokenStatus"
import type { Id, SceneLike } from "@/core/scene/types"
import type { PlayerView } from "@/core/session/types"

export interface BadgeToken {
  id: Id
  /** Footprint radius (ft): the badges sit just outside it. */
  radiusFt: number
  hp?: TokenHp
  band?: HealthBand
  conditions?: readonly TokenCondition[]
}

type StatusLike = {
  size: SceneLike["tokens"][string]["size"]
  hp?: TokenHp
  health?: HealthBand
  conditions?: readonly TokenCondition[]
}

function badge(id: Id, t: StatusLike, cellSize: number): BadgeToken | null {
  const conditions = t.conditions?.length ? t.conditions : undefined
  if (!t.hp && !t.health && !conditions) return null
  return {
    id,
    radiusFt: (footprintCells(t.size) * cellSize) / 2,
    hp: t.hp,
    band: t.hp ? undefined : t.health,
    conditions,
  }
}

export function playerBadgeTokens(
  view: PlayerView | null,
  cellSize: number
): BadgeToken[] {
  if (!view) return []
  const out: BadgeToken[] = []
  for (const [id, t] of Object.entries(view.tokens)) {
    const b = badge(id, t, cellSize)
    if (b) out.push(b)
  }
  return out
}

export function dmBadgeTokens(scene: SceneLike | null): BadgeToken[] {
  if (!scene) return []
  const out: BadgeToken[] = []
  for (const [id, t] of Object.entries(scene.tokens)) {
    const b = badge(id, t, scene.grid.cellSize)
    if (b) out.push(b)
  }
  return out
}

/** `tokens`, kept as the same array while its content is the same (a move changes the view, not the badges). */
export function useStableBadges(tokens: BadgeToken[]): BadgeToken[] {
  const key = JSON.stringify(tokens)
  return React.useMemo(() => JSON.parse(key) as BadgeToken[], [key])
}
