/**
 * Prop tool: click to place a prop of the kind chosen in the tool settings. The preview is a ghost
 * of the prop; R / Shift+R rotate the next prop by 90° (stored in the settings so it persists).
 */
import { createProp } from "@/core/scene/factory"
import type { Id, PropObject, SceneLike, Vec2 } from "@/core/scene/types"
import type { ToolPreview } from "@/render/contracts"

import { insideExtent } from "../snapping"
import { normalizeAngle } from "../transform"
import { createPreviewCache, rotateTurns, samePoint, snappedGround, type ToolDeps } from "./shared"
import type { Tool } from "./types"

/** Fixed id of the ghost prop (never inserted into a document). */
const GHOST_ID = "__prop-preview__"

export function createPropTool(deps: ToolDeps): Tool {
  const { store } = deps
  let hover: Vec2 | null = null
  /**
   * The ghost scene holds the prop at the origin and the preview moves it with `offset`, so the
   * renderer can keep the built ghost while only the pointer moves. Rebuilt when the kind, rotation,
   * level or the level set changes.
   */
  let ghost: { key: string; levels: SceneLike["levels"]; grid: SceneLike["grid"]; scene: Pick<SceneLike, "objects" | "levels" | "grid"> } | null = null

  const changed = () => {
    preview.bump()
    deps.invalidate?.()
  }

  const ghostScene = (): Pick<SceneLike, "objects" | "levels" | "grid"> => {
    const s = store.getState()
    const { kind, rotationY } = s.toolSettings.prop
    const key = `${kind}|${rotationY}|${s.activeLevelId}`
    if (ghost && ghost.key === key && ghost.levels === s.scene.levels && ghost.grid === s.scene.grid) return ghost.scene
    const prop: PropObject = { ...createProp(s.activeLevelId, kind, { x: 0, y: 0, z: 0 }, { rotationY }), id: GHOST_ID as Id }
    const scene = { objects: { [GHOST_ID]: prop }, levels: s.scene.levels, grid: s.scene.grid }
    ghost = { key, levels: s.scene.levels, grid: s.scene.grid, scene }
    return scene
  }

  const preview = createPreviewCache(store, (): ToolPreview | null => {
    if (!hover) return null
    return { kind: "ghost-objects", scene: ghostScene(), offset: { x: hover.x, z: hover.z } }
  })

  const rotate = (turns: number) => {
    const s = store.getState()
    s.setToolSettings("prop", { rotationY: normalizeAngle(s.toolSettings.prop.rotationY + (turns * Math.PI) / 2) })
    changed()
  }

  return {
    id: "prop",

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
      const { kind, rotationY } = s.toolSettings.prop
      s.addObject(createProp(s.activeLevelId, kind, { x: p.x, y: 0, z: p.z }, { rotationY }), "Add prop")
    },

    onKeyDown(e) {
      const turns = rotateTurns(e)
      if (turns === 0) return false
      rotate(turns)
      return true
    },

    cancel() {
      hover = null
      changed()
    },

    preview: () => preview.get(),
  }
}
