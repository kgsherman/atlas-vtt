/**
 * The initiative order as the turn strip shows it: players from their view (already filtered by the
 * host), the DM from the game state (everything, hidden entries marked).
 */
import type { Id, SceneLike } from "@/core/scene/types"
import type { GameState, PlayerView } from "@/core/session/types"
import { tokenDisplayName } from "@/play"

import type { TurnStripEntry } from "./TurnStrip"

export interface TurnOrder {
  round: number
  activeId: string | null
  entries: TurnStripEntry[]
  /** The acting token (null: nobody, a custom entry, or one this viewer cannot see). */
  activeTokenId: Id | null
}

export function playerTurnOrder(view: PlayerView | null): TurnOrder | null {
  const c = view?.table?.combat
  if (!view || !c) return null
  const mine = new Set(view.controlledTokenIds)
  const entries = c.entries.map((e): TurnStripEntry => {
    const t =
      e.tokenId !== null && Object.hasOwn(view.tokens, e.tokenId)
        ? view.tokens[e.tokenId]
        : null
    return {
      id: e.id,
      name: e.name,
      initiative: e.initiative,
      token: t
        ? {
            name: t.name ?? e.name,
            label: t.label,
            color: t.color,
            imageUrl: t.imageUrl,
          }
        : null,
      tokenId: e.tokenId,
      mine: e.tokenId !== null && mine.has(e.tokenId),
      hp: t?.hp,
      band: t?.hp ? undefined : t?.health,
    }
  })
  const active = entries.find((e) => e.id === c.activeId) ?? null
  return {
    round: c.round,
    activeId: c.activeId,
    entries,
    activeTokenId: active?.tokenId ?? null,
  }
}

export function dmTurnOrder(
  state: {
    table?: GameState["table"]
    scene: Pick<GameState["scene"], "tokens">
  } | null
): TurnOrder | null {
  const c = state?.table?.combat
  if (!state || !c) return null
  const entries = c.entries.map((e): TurnStripEntry => {
    const t =
      e.tokenId !== null && Object.hasOwn(state.scene.tokens, e.tokenId)
        ? state.scene.tokens[e.tokenId]
        : null
    return {
      id: e.id,
      name:
        e.tokenId === null ? e.name : t ? tokenDisplayName(t) : "Removed token",
      initiative: e.initiative,
      token: t,
      tokenId: t ? e.tokenId : null,
      mine: false,
      hidden: e.hidden || (t?.hidden ?? false),
      hp: t?.hp,
    }
  })
  const active = entries.find((e) => e.id === c.activeId) ?? null
  return {
    round: c.round,
    activeId: c.activeId,
    entries,
    activeTokenId: active?.tokenId ?? null,
  }
}

/** Whether a level is drawn in a cutaway at `activeLevelId` (that level and the ones below it). */
export function levelShown(
  scene: Pick<SceneLike, "levels">,
  activeLevelId: Id | null,
  levelId: Id
): boolean {
  if (activeLevelId === null || levelId === activeLevelId) return true
  const a = Object.hasOwn(scene.levels, activeLevelId)
    ? scene.levels[activeLevelId]
    : null
  const l = Object.hasOwn(scene.levels, levelId) ? scene.levels[levelId] : null
  return !!a && !!l && l.elevation < a.elevation
}
