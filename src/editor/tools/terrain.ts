/**
 * Terrain editing mode (ARCHITECTURE §7 "Terrain tools", DESIGN §3): ToolId "terrain" with the sub-tools of
 * toolSettings.terrain.sub —
 *  - brush: paints the painted base under the shapes (terrain/brush.ts);
 *  - block / ramp / cylinder / polygon: Blender-style creation of terrain shapes (terrain/create.ts);
 *  - select: selection, moves and the advanced vertex / edge / face mode (terrain/select.ts, actions.ts).
 * The renderer shows the BAKED document terrain; this tool's preview is always a TerrainOverlay with the
 * active level's shapes (drafts and dragged versions substituted), the selection, elements, gizmo, brush
 * ring and a label. Gestures stay local (overlay + Engine.previewTerrain of the re-baked lattice) and commit
 * ONE store.applyTerrainEdit (core/scene/terrainShapes writeTerrain) each.
 *
 * A store subscription cancels a gesture when its basis changes underneath it: the active level, the
 * sub-tool, read-only, the grid, or the gesture level's heightmap / terrain edits / elevation (not on other
 * scene changes: the live host re-syncs on every player step). Undo / redo during a gesture only cancel it.
 * While this tool is active it consumes delete, duplicate, select all, nudge, rotate, copy, cut and paste
 * (no-ops without a shape selection) so a hidden object selection is never edited.
 */
import type { TerrainSubTool } from "../settings"
import type { EditorState } from "../store"
import { createShapeActions } from "./terrain/actions"
import { createBrushSubTool } from "./terrain/brush"
import { activeLevel, activeSelection, editMode, type SubTool, type TerrainToolContext } from "./terrain/context"
import { createShapeSubTool } from "./terrain/create"
import { terrainKey } from "./terrain/keys"
import { createOverlayComposer } from "./terrain/overlay"
import { createSelectSubTool } from "./terrain/select"
import type { ToolDeps } from "./shared"
import type { Tool } from "./types"

export interface TerrainTool extends Tool {
  /** Whether a brush stroke is in progress. */
  painting(): boolean
  cursor(): string | null
  hint(): string | null
}

export const READ_ONLY_HINT = "Read-only: the terrain can't be edited"
export const READ_ONLY_SELECT_HINT = "Read-only: shapes can be selected, not edited"

/** Whether a store change pulls the ground from under a gesture on `levelId`. */
function invalidates(s: EditorState, prev: EditorState, levelId: string): boolean {
  if (s.activeLevelId !== prev.activeLevelId || s.readOnly !== prev.readOnly || s.scene.grid !== prev.scene.grid) return true
  if (s.scene === prev.scene) return false
  const now = Object.hasOwn(s.scene.levels, levelId) ? s.scene.levels[levelId] : undefined
  const before = Object.hasOwn(prev.scene.levels, levelId) ? prev.scene.levels[levelId] : undefined
  return !now || !before || now.heightmap !== before.heightmap || now.terrainEdits !== before.terrainEdits || now.elevation !== before.elevation
}

export function createTerrainTool(deps: ToolDeps): TerrainTool {
  const { store } = deps
  let version = 0
  let writing = 0
  let notice: string | null = null
  let cache: { key: unknown[]; value: ReturnType<Tool["preview"]> } | null = null

  const ctx: TerrainToolContext = {
    deps,
    store,
    changed() {
      version++
      deps.invalidate?.()
    },
    write<T>(fn: () => T): T {
      writing++
      try {
        return fn()
      } finally {
        writing--
      }
    },
    notify(message) {
      if (notice === message) return
      notice = message
      ctx.changed()
    },
  }

  const actions = createShapeActions(ctx)
  const brush = createBrushSubTool(ctx)
  const subs: Record<TerrainSubTool, SubTool> = {
    brush,
    block: createShapeSubTool(ctx, "block"),
    ramp: createShapeSubTool(ctx, "ramp"),
    cylinder: createShapeSubTool(ctx, "cylinder"),
    polygon: createShapeSubTool(ctx, "polygon"),
    select: createSelectSubTool(ctx, actions),
  }
  const composer = createOverlayComposer()

  const subOf = (s: Pick<EditorState, "toolSettings">): SubTool => subs[s.toolSettings.terrain.sub] ?? brush
  const current = () => subOf(store.getState())

  const cancelAll = () => {
    for (const sub of Object.values(subs)) sub.cancel()
    notice = null
    ctx.changed()
  }

  store.subscribe((s, prev) => {
    if (s.tool !== prev.tool) {
      if (prev.tool === "terrain") cancelAll()
      return
    }
    if (s.toolSettings.terrain.sub !== prev.toolSettings.terrain.sub) {
      subOf(prev).cancel()
      notice = null
      ctx.changed()
    }
    if (writing > 0) return
    const sub = subOf(s)
    const levelId = sub.gestureLevel()
    if (levelId === null) return
    if (invalidates(s, prev, levelId)) {
      sub.cancel()
      ctx.changed()
    } else if (s.altHeld !== prev.altHeld || s.snapMode !== prev.snapMode || s.toolSettings.terrain !== prev.toolSettings.terrain) {
      sub.refresh()
      ctx.changed()
    }
  })

  const preview = () => {
    const s = store.getState()
    const a = activeLevel(s)
    const key = [
      version,
      s.activeLevelId,
      a?.level.terrainEdits,
      a?.level.elevation,
      s.terrainSelection,
      s.toolSettings.terrain,
      s.toolSettings.brush,
      s.snapMode,
      s.altHeld,
      s.readOnly,
      s.scene.grid,
    ]
    if (cache && cache.key.every((v, k) => v === key[k])) return cache.value
    let value: ReturnType<Tool["preview"]> = null
    if (a) {
      value = composer.compose({
        levelId: a.levelId,
        shapes: a.level.terrainEdits?.shapes ?? null,
        selection: activeSelection(s),
        elementMode: editMode(s) ? s.toolSettings.terrain.element : null,
        parts: subOf(s).parts(),
      })
    }
    cache = { key, value }
    return value
  }

  const tool: TerrainTool = {
    id: "terrain",

    get capturesPointer() {
      return current().captures()
    },

    onPointerDown(e) {
      ctx.notify(null)
      current().pointerDown(e)
    },

    onPointerMove(e) {
      current().pointerMove(e)
    },

    onPointerUp(e) {
      current().pointerUp(e)
    },

    onKeyDown(e) {
      const k = terrainKey(e)
      const sub = current()
      const busy = sub.gestureLevel() !== null
      if (k.type !== "other") ctx.notify(null)
      switch (k.type) {
        case "undo":
        case "redo":
          // Mid-gesture, undo / redo only abort the gesture (nothing of it was committed).
          if (!busy) return false
          sub.cancel()
          ctx.changed()
          return true
        case "escape":
          if (busy) {
            sub.cancel()
            ctx.changed()
            return true
          }
          return actions.escape()
        case "confirm":
        case "axis":
          return sub.key(k)
        case "rotate":
          if (busy) sub.key(k)
          else actions.rotate(k.turns)
          return true
        case "delete":
          // Mid-gesture it is the sub-tool's (the polygon's Backspace removes its last corner).
          if (busy) sub.key(k)
          else actions.delete()
          return true
        case "duplicate":
          if (!busy) actions.duplicate()
          return true
        case "select-all":
          if (!busy) actions.selectAll()
          return true
        case "nudge":
          if (!busy) actions.nudge(k.x, k.z, k.fine)
          return true
        case "copy":
        case "cut":
        case "paste":
          // Shapes are not on the clipboard; consumed so the (hidden) object selection is left alone.
          return true
        case "advanced":
          if (busy) return true
          // Nothing to toggle: a real Tab is left to the browser's focus navigation (the options bar's
          // Advanced switch, which has no key, still gets the "select a shape" hint).
          if (e.key === "Tab" && !activeSelection(store.getState())) return false
          actions.toggleAdvanced()
          return true
        case "element":
          if (!busy) actions.setElementMode(k.mode)
          return true
        case "other":
          return sub.key(k)
      }
    },

    cancel() {
      cancelAll()
    },

    preview,

    cursor: () => current().cursor(),

    cursorKeys: () => (store.getState().readOnly ? null : (current().cursorKeys?.() ?? null)),

    hint() {
      if (notice) return notice
      const s = store.getState()
      if (s.readOnly) return s.toolSettings.terrain.sub === "select" ? READ_ONLY_SELECT_HINT : READ_ONLY_HINT
      return current().hint()
    },

    painting: () => brush.painting(),
  }
  return tool
}
