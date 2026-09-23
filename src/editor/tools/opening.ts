/**
 * Door and window tools: hovering a wall on the active level previews the opening at the nearest
 * valid offset (inside the wall, not overlapping other openings; snapped along the wall unless Alt);
 * clicking places it.
 */
import { createDoor, createWindow } from "@/core/scene/factory"
import { openingSegment } from "@/core/scene/queries"
import type { Id, Scene, WallObject } from "@/core/scene/types"
import type { ToolPreview } from "@/render/contracts"

import { nearestWall, offsetOnWall, placeOpening } from "../snapping"
import { createPreviewCache, pointerSnapMode, type ToolDeps } from "./shared"
import type { Tool, ToolPointerEvent } from "./types"

interface Hover {
  wallId: Id
  offset: number
  valid: boolean
}

/** Host wall for a pointer event: the picked wall (or the wall of a picked opening), else the nearest wall on the level. */
export function wallUnderPointer(scene: Scene, levelId: Id, e: Pick<ToolPointerEvent, "pick" | "ground">): WallObject | null {
  const id = e.pick.objectId
  if (id && Object.hasOwn(scene.objects, id)) {
    const o = scene.objects[id]
    const wallId = o.type === "door" || o.type === "window" ? o.wallId : o.id
    const w = Object.hasOwn(scene.objects, wallId) ? scene.objects[wallId] : undefined
    if (w && w.type === "wall" && w.levelId === levelId) return w
  }
  if (!e.ground) return null
  return nearestWall(scene, levelId, e.ground, scene.grid.cellSize * 0.3)
}

export function createOpeningTool(deps: ToolDeps, kind: "door" | "window"): Tool {
  const { store } = deps
  let hover: Hover | null = null

  const changed = () => {
    preview.bump()
    deps.invalidate?.()
  }

  /** Width, height and sill of the opening to place on `wall` (door height and window sill + height fit the wall). */
  const dims = (wall: WallObject) => {
    const s = store.getState().toolSettings
    if (kind === "door") return { width: s.door.width, height: Math.min(s.door.height, wall.height), sill: 0 }
    const sill = Math.min(s.window.sillHeight, wall.height)
    return { width: s.window.width, height: Math.min(s.window.height, wall.height - sill), sill }
  }

  const compute = (e: ToolPointerEvent): Hover | null => {
    const s = store.getState()
    const wall = wallUnderPointer(s.scene, s.activeLevelId, e)
    if (!wall) return null
    const p = e.pick.hitPoint ?? e.ground
    if (!p) return null
    const { width, height } = dims(wall)
    const placement = placeOpening(s.scene, wall, offsetOnWall(wall, p), width, { mode: pointerSnapMode(store, e) })
    return { wallId: wall.id, offset: placement.offset, valid: placement.valid && height > 0 }
  }

  const preview = createPreviewCache(store, (): ToolPreview | null => {
    if (!hover) return null
    const s = store.getState()
    const wall = Object.hasOwn(s.scene.objects, hover.wallId) ? s.scene.objects[hover.wallId] : undefined
    if (!wall || wall.type !== "wall") return null
    const { width, height, sill } = dims(wall)
    const seg = openingSegment(wall, { offset: hover.offset, width })
    return { kind: "opening", levelId: wall.levelId, a: seg.a, b: seg.b, height, sill, valid: hover.valid }
  })

  const setHover = (next: Hover | null) => {
    if (next === hover || (next && hover && next.wallId === hover.wallId && next.offset === hover.offset && next.valid === hover.valid)) return
    hover = next
    changed()
  }

  return {
    id: kind,

    onPointerMove(e) {
      setHover(compute(e))
    },

    onPointerDown(e) {
      if (e.button !== 0) return
      const h = compute(e)
      setHover(h)
      if (!h || !h.valid) return
      const s = store.getState()
      const wall = s.scene.objects[h.wallId] as WallObject
      const { width, height, sill } = dims(wall)
      if (kind === "door") {
        const d = s.toolSettings.door
        s.addObject(createDoor(wall, h.offset, { width, height, style: d.style, leaves: d.leaves }), "Add door")
      } else {
        s.addObject(createWindow(wall, h.offset, { width, height, sillHeight: sill }), "Add window")
      }
      // The new opening now occupies this spot: recompute so the preview shows the next valid place.
      setHover(compute(e))
    },

    cancel() {
      setHover(null)
    },

    preview: () => preview.get(),
  }
}
