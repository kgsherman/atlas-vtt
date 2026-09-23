/**
 * Pillar tool: click to place a pillar (shape, size, height, material from the tool settings) at the
 * snapped pointer position on the active level.
 */
import { createPillar } from "@/core/scene/factory"
import type { Vec2 } from "@/core/scene/types"
import type { ToolPreview } from "@/render/contracts"

import { insideExtent } from "../snapping"
import { createPreviewCache, INVALID_COLOR, PREVIEW_COLOR, samePoint, snappedGround, type ToolDeps } from "./shared"
import type { Tool } from "./types"

export function createPillarTool(deps: ToolDeps): Tool {
  const { store } = deps
  let hover: Vec2 | null = null

  const changed = () => {
    preview.bump()
    deps.invalidate?.()
  }

  const preview = createPreviewCache(store, (): ToolPreview | null => {
    if (!hover) return null
    const s = store.getState()
    const valid = insideExtent(s.scene.grid, hover)
    return { kind: "point", levelId: s.activeLevelId, position: { x: hover.x, y: 0, z: hover.z }, radius: s.toolSettings.pillar.size / 2, color: valid ? PREVIEW_COLOR : INVALID_COLOR }
  })

  return {
    id: "pillar",

    onPointerMove(e) {
      const p = snappedGround(store, e)
      if (p === hover || (p && hover && samePoint(p, hover, 1e-9))) return
      hover = p
      changed()
    },

    onPointerDown(e) {
      if (e.button !== 0) return
      const p = snappedGround(store, e)
      const s = store.getState()
      if (!p || !insideExtent(s.scene.grid, p)) return
      const { shape, size, height, material } = s.toolSettings.pillar
      s.addObject(createPillar(s.activeLevelId, p, { shape, size, height, material }), "Add pillar")
    },

    cancel() {
      hover = null
      changed()
    },

    preview: () => preview.get(),
  }
}
