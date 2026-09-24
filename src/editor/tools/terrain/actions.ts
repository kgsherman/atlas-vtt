/**
 * Keyboard actions on the terrain selection (DESIGN §3.4): delete (object mode: shapes; advanced mode:
 * dissolve vertices / collapse edges), duplicate, select all, nudge, rotate, the advanced-mode toggle and
 * element kind, and the Escape order past a gesture. Each edit is one store.applyTerrainEdit; nudges
 * coalesce in history like object nudges. Every action is a no-op when read-only or nothing is selected.
 */
import { newId } from "@/core/scene/factory"
import {
  compareShapeOrder,
  dissolveVertices,
  nextShapeOrder,
  removeInnerEdges,
  shapeEdgePart,
  rotateShapeQuarter,
  translateShape,
  translateVertices,
  type TerrainEdit,
  type TerrainElementMode,
} from "@/core/scene/terrainShapes"
import type { Id, TerrainShape } from "@/core/scene/types"

import type { ApplyOptions, TerrainSelection } from "../../store"
import { allElements, collapseEdges, elementKey, elementVerticesByShape, shapeAcceptable, shapeInExtent, shapesPivot } from "../../terrainMath"
import { activeLevel, activeSelection, editMode, levelShapes, pointsCentre, snapModeOf, type TerrainToolContext } from "./context"

export interface ShapeActions {
  delete(): void
  duplicate(): void
  selectAll(): void
  /** Arrow keys: one cell, or one foot when `fine` (Shift). */
  nudge(x: number, z: number, fine: boolean): void
  /** Quarter turns about the selection's pivot (object mode; a lone cylinder: its centre). */
  rotate(turns: number): void
  toggleAdvanced(): void
  setElementMode(mode: TerrainElementMode): void
  /** Escape past a gesture: element selection → advanced mode → shape selection. False when nothing was cleared. */
  escape(): boolean
  /** Replace the terrain selection (null or empty clears it and leaves the advanced mode). */
  select(next: TerrainSelection | null): void
}

export const NEED_THREE_VERTICES = "A shape needs at least 3 vertices"

export function createShapeActions(ctx: TerrainToolContext): ShapeActions {
  const { store } = ctx

  const current = () => {
    const s = store.getState()
    const a = activeLevel(s)
    return { s, a, sel: activeSelection(s), rec: levelShapes(a?.level), edit: editMode(s) }
  }

  const select = (next: TerrainSelection | null) =>
    ctx.write(() => {
      store.getState().setTerrainSelection(next && next.shapeIds.length > 0 ? next : null)
      const s = store.getState()
      if (!s.terrainSelection && s.toolSettings.terrain.advanced) s.setToolSettings("terrain", { advanced: false })
    })

  const edit = (levelId: Id, e: TerrainEdit, label: string, opts?: ApplyOptions) => ctx.write(() => store.getState().applyTerrainEdit(levelId, e, label, opts))

  const selected = (sel: TerrainSelection, rec: Readonly<Record<Id, TerrainShape>>) => sel.shapeIds.filter((id) => Object.hasOwn(rec, id)).map((id) => rec[id])

  /** The selection (shapes, or the selected elements' vertices in advanced mode) moved by `delta`; null when refused. */
  const translated = (sel: TerrainSelection, rec: Readonly<Record<Id, TerrainShape>>, advanced: boolean, dx: number, dz: number): TerrainShape[] | null => {
    const grid = store.getState().scene.grid
    const delta = { x: dx, y: 0, z: dz }
    const out: TerrainShape[] = []
    if (advanced) {
      for (const [id, ks] of elementVerticesByShape(rec, sel.elements)) {
        const next = translateVertices(rec[id], ks, delta)
        if (!next || !shapeInExtent(next, grid)) return null
        out.push(next)
      }
      return out
    }
    for (const sh of selected(sel, rec)) {
      const next = translateShape(sh, delta)
      if (!next || !shapeInExtent(next, grid)) return null
      out.push(next)
    }
    return out
  }

  return {
    select,

    delete() {
      const { s, a, sel, rec, edit: advanced } = current()
      if (!a || !sel || s.readOnly) return
      if (!advanced) {
        edit(a.levelId, { remove: sel.shapeIds }, sel.shapeIds.length === 1 ? "Delete terrain shape" : "Delete terrain shapes")
        return
      }
      const mode = s.toolSettings.terrain.element
      if (mode === "face") {
        ctx.notify("Tab to object mode to delete shapes")
        return
      }
      const upsert: TerrainShape[] = []
      let collapsed = false
      let cornered = false
      for (const sh of selected(sel, rec)) {
        const ks = sel.elements.filter((x) => x.shapeId === sh.id && x.kind === mode).map((x) => x.index as number)
        if (ks.length === 0) continue
        // Edge mode: selected inner edges (loop cuts) are removed, selected outline edges and the bottom edges
        // under them collapsed, and the corners under selected side edges dissolved.
        const n = sh.points.length
        const parts = mode === "edge" ? ks.map((k) => ({ k, e: shapeEdgePart(sh, k) })) : []
        const inner = parts.filter((p) => p.e?.part === "top" && p.k >= n).map((p) => p.k - n)
        const outline =
          mode === "edge" ? [...new Set(parts.flatMap((p) => (p.e?.part === "bottom" ? [p.e.ends[0]] : p.e?.part === "top" && p.k < n ? [p.k] : [])))] : ks
        const corners = parts.flatMap((p) => (p.e?.part === "side" ? [p.e.vertex] : []))
        if (corners.length > 0 && outline.length > 0) {
          ctx.notify("Delete side edges on their own (they remove their corner)")
          return
        }
        const trimmed = inner.length > 0 ? removeInnerEdges(sh, inner) : sh
        const dissolved = trimmed && corners.length > 0 ? dissolveVertices(trimmed, corners) : trimmed
        const next = mode === "vertex" ? dissolveVertices(sh, ks) : !dissolved ? null : outline.length > 0 ? collapseEdges(trimmed!, outline) : dissolved
        if (!next || !shapeInExtent(next, s.scene.grid)) {
          ctx.notify(n - new Set([...outline, ...corners]).size < 3 ? NEED_THREE_VERTICES : "That would make the shape cross itself")
          return
        }
        collapsed ||= outline.length > 0
        cornered ||= corners.length > 0
        upsert.push(next)
      }
      if (upsert.length === 0) {
        ctx.notify(mode === "vertex" ? "Select vertices to dissolve" : "Select edges to collapse")
        return
      }
      const label = mode === "vertex" || cornered ? "Dissolve terrain vertices" : collapsed ? "Collapse terrain edges" : "Remove terrain loop cuts"
      if (edit(a.levelId, { upsert }, label)) {
        const now = activeSelection(store.getState())
        if (now) select({ ...now, elements: [] })
      }
    },

    duplicate() {
      const { s, a, sel, rec, edit: advanced } = current()
      if (!a || !sel || s.readOnly || advanced) return
      const cell = s.scene.grid.cellSize
      let order = nextShapeOrder(a.level)
      const copies: TerrainShape[] = []
      for (const sh of selected(sel, rec).sort(compareShapeOrder)) {
        const movedShape = translateShape(sh, { x: cell, y: 0, z: cell })
        const copy = movedShape ? { ...movedShape, id: newId(), order: order++ } : null
        if (!copy || !shapeAcceptable(copy, s.scene.grid)) {
          ctx.notify("The copy would leave the map")
          return
        }
        copies.push(copy)
      }
      if (copies.length === 0) return
      if (edit(a.levelId, { upsert: copies }, copies.length === 1 ? "Duplicate terrain shape" : "Duplicate terrain shapes")) {
        select({ levelId: a.levelId, shapeIds: copies.map((c) => c.id), elements: [] })
      }
    },

    selectAll() {
      const { s, a, sel, rec, edit: advanced } = current()
      if (!a) return
      if (advanced && sel) {
        select({ ...sel, elements: allElements(selected(sel, rec), s.toolSettings.terrain.element) })
        return
      }
      const ids = Object.values(rec)
        .sort(compareShapeOrder)
        .map((sh) => sh.id)
      select(ids.length > 0 ? { levelId: a.levelId, shapeIds: ids, elements: [] } : null)
    },

    nudge(x, z, fine) {
      const { s, a, sel, rec, edit: advanced } = current()
      if (!a || !sel || s.readOnly) return
      const step = fine ? 1 : s.scene.grid.cellSize
      const upsert = translated(sel, rec, advanced, x * step, z * step)
      if (!upsert) {
        ctx.notify("The shape can't move there")
        return
      }
      if (upsert.length === 0) return
      const what = advanced ? sel.elements.map(elementKey).join(",") : sel.shapeIds.join(",")
      edit(a.levelId, { upsert }, "Nudge terrain", { coalesceKey: `terrain-nudge:${a.levelId}:${what}` })
    },

    rotate(turns) {
      const { s, a, sel, rec, edit: advanced } = current()
      if (!a || !sel || s.readOnly || advanced || Math.round(turns) % 4 === 0) return
      const shapes = selected(sel, rec)
      // A lone cylinder turns about its own centre, like a point item (the vertex-snapped bounds centre
      // would only shift it by a cell).
      const pivot = shapes.length === 1 && shapes[0].kind === "cylinder" ? pointsCentre(shapes[0]) : shapesPivot(shapes, s.scene.grid, snapModeOf(store, null))
      if (!pivot) return
      const upsert: TerrainShape[] = []
      for (const sh of shapes) {
        const next = rotateShapeQuarter(sh, pivot, turns)
        if (!next || !shapeInExtent(next, s.scene.grid)) {
          ctx.notify("The shape can't turn there")
          return
        }
        upsert.push(next)
      }
      edit(a.levelId, { upsert }, upsert.length === 1 ? "Rotate terrain shape" : "Rotate terrain shapes")
    },

    toggleAdvanced() {
      const { s, sel } = current()
      if (!sel) {
        ctx.notify("Select a shape to edit its vertices, edges and faces")
        return
      }
      // The effective mode: from another sub-tool Tab always goes (back) to Select in the advanced mode.
      const on = !editMode(s)
      ctx.write(() => {
        s.setToolSettings("terrain", on && s.toolSettings.terrain.sub !== "select" ? { advanced: on, sub: "select" } : { advanced: on })
        if (!on && sel.elements.length > 0) store.getState().setTerrainSelection({ ...sel, elements: [] })
      })
    },

    setElementMode(mode) {
      const { s, sel } = current()
      ctx.write(() => {
        s.setToolSettings("terrain", sel ? { element: mode, advanced: true, sub: "select" } : { element: mode })
        if (sel && sel.elements.length > 0 && mode !== s.toolSettings.terrain.element) store.getState().setTerrainSelection({ ...sel, elements: [] })
      })
    },

    escape() {
      const { s, sel } = current()
      if (!sel) {
        if (s.toolSettings.terrain.advanced) ctx.write(() => s.setToolSettings("terrain", { advanced: false }))
        return false
      }
      if (editMode(s) && sel.elements.length > 0) {
        select({ ...sel, elements: [] })
        return true
      }
      if (editMode(s)) {
        ctx.write(() => s.setToolSettings("terrain", { advanced: false }))
        return true
      }
      // (Outside Select the advanced flag is not shown: this clears the visible selection, and the flag.)
      select(null)
      return true
    },
  }
}
