/**
 * Token tool: click to place a token (size and kind from the tool settings) on the active level. With
 * snapping, the footprint's corner sits on the grid (medium tokens centre on cells, large on vertices).
 */
import { SIZE_FOOTPRINT } from "@/core/scene/defaults"
import { createToken } from "@/core/scene/factory"
import { groundIndex } from "@/core/scene/queries"
import type { Scene, TokenKind, Vec2 } from "@/core/scene/types"
import type { ToolPreview } from "@/render/contracts"

import { insideExtent, snapTokenPosition } from "../snapping"
import { createPreviewCache, INVALID_COLOR, PREVIEW_COLOR, pointerSnapMode, samePoint, type ToolDeps } from "./shared"
import type { Tool, ToolPointerEvent } from "./types"

const KIND_NAMES: Record<TokenKind, string> = { pc: "Hero", npc: "NPC", monster: "Monster" }

/** "Hero 3": the next free number for tokens of a kind. */
export function nextTokenName(scene: Scene, kind: TokenKind): string {
  const base = KIND_NAMES[kind]
  const used = new Set(Object.values(scene.tokens).map((t) => t.name))
  for (let n = 1; ; n++) {
    const name = `${base} ${n}`
    if (!used.has(name)) return name
  }
}

export function createTokenTool(deps: ToolDeps): Tool {
  const { store } = deps
  let hover: Vec2 | null = null

  const changed = () => {
    preview.bump()
    deps.invalidate?.()
  }

  const positionOf = (e: Pick<ToolPointerEvent, "alt" | "ground">): Vec2 | null => {
    if (!e.ground) return null
    const s = store.getState()
    return snapTokenPosition(s.scene.grid, e.ground, s.toolSettings.token.size, pointerSnapMode(store, e))
  }

  const preview = createPreviewCache(store, (): ToolPreview | null => {
    if (!hover) return null
    const s = store.getState()
    const radius = (SIZE_FOOTPRINT[s.toolSettings.token.size] * s.scene.grid.cellSize) / 2
    // Tokens need ground: warn (but still allow) where there is no floor yet.
    // The committed scene's memoised index: this runs on every pointer move.
    const ok = insideExtent(s.scene.grid, hover) && groundIndex(s.scene).hasGroundAt(s.activeLevelId, hover)
    return { kind: "point", levelId: s.activeLevelId, position: { x: hover.x, y: 0, z: hover.z }, radius, color: ok ? PREVIEW_COLOR : INVALID_COLOR }
  })

  return {
    id: "token",

    onPointerMove(e) {
      const p = positionOf(e)
      if (p === hover || (p && hover && samePoint(p, hover, 1e-9))) return
      hover = p
      changed()
    },

    onPointerDown(e) {
      if (e.button !== 0) return
      const p = positionOf(e)
      const s = store.getState()
      if (!p || !insideExtent(s.scene.grid, p)) return
      const { size, kind } = s.toolSettings.token
      s.addToken(createToken(s.activeLevelId, p, { size, kind, name: nextTokenName(s.scene, kind) }), "Add token")
    },

    cancel() {
      hover = null
      changed()
    },

    preview: () => preview.get(),
  }
}
