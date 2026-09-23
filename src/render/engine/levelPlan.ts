/**
 * Which levels are drawn and how (ARCHITECTURE §4.3):
 *  - editor: per-level visibility toggles; with ghostAdjacent the active level is solid, the levels
 *    directly above/below are translucent ghosts and the rest are hidden;
 *  - player / dm-play: cutaway hides every level above the active one (their tokens become faded
 *    outline markers); dm-play also honours the visibility toggles.
 * Draw order: rank 1 = active level, then the levels below by descending elevation (so lower
 * storeys are early-Z rejected under the active floors), then the levels above.
 */
import type { Id, Level } from "@/core/scene/types"

import type { ViewState } from "../contracts"

export type LevelDrawMode = "solid" | "ghost" | "hidden"
export type TokenDrawMode = "solid" | "marker" | "none"

export interface LevelPlanEntry {
  mode: LevelDrawMode
  tokens: TokenDrawMode
  /** renderOrder of the level group (lower draws first). */
  rank: number
}

export type LevelPlanView = Pick<ViewState, "mode" | "activeLevelId" | "levelVisibility" | "ghostAdjacent" | "cutaway">

/** The active level if it exists, else the lowest level (null for a scene without levels). */
export function effectiveActiveLevelId(sorted: readonly Pick<Level, "id">[], activeLevelId: Id | null): Id | null {
  if (activeLevelId !== null && sorted.some((l) => l.id === activeLevelId)) return activeLevelId
  return sorted.length > 0 ? sorted[0].id : null
}

/** Plan per level id. `sorted` must be ordered by (elevation, id) (core/scene sortedLevels). */
export function computeLevelPlan(sorted: readonly Pick<Level, "id">[], view: LevelPlanView): Map<Id, LevelPlanEntry> {
  const out = new Map<Id, LevelPlanEntry>()
  const active = effectiveActiveLevelId(sorted, view.activeLevelId)
  const ai = active === null ? 0 : sorted.findIndex((l) => l.id === active)
  const visible = (id: Id) => view.levelVisibility[id] !== false
  sorted.forEach((level, k) => {
    const rank = k === ai ? 1 : k < ai ? 1 + (ai - k) : 1 + ai + (k - ai)
    let mode: LevelDrawMode
    let tokens: TokenDrawMode
    if (view.mode === "editor") {
      if (view.ghostAdjacent && active !== null) {
        mode = k === ai ? "solid" : Math.abs(k - ai) === 1 ? "ghost" : "hidden"
      } else {
        mode = "solid"
      }
      if (!visible(level.id)) mode = "hidden"
      tokens = mode === "solid" ? "solid" : mode === "ghost" ? "marker" : "none"
    } else {
      const above = view.cutaway && active !== null && k > ai
      const toggledOff = view.mode === "dm-play" && !visible(level.id)
      if (toggledOff) {
        mode = "hidden"
        tokens = "none"
      } else if (above) {
        mode = "hidden"
        tokens = "marker"
      } else {
        mode = "solid"
        tokens = "solid"
      }
    }
    out.set(level.id, { mode, tokens, rank })
  })
  return out
}
