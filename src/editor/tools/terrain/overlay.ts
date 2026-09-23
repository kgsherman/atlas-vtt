/**
 * Composition of the terrain mode's overlay (render/contracts TerrainOverlay) from the document, the
 * terrain selection and a sub-tool's contributions. Arrays keep their identity while unchanged and
 * unchanged shape objects are passed through, so the renderer can cache per-shape geometry across a drag
 * or a live host re-sync.
 */
import type { TerrainElementMode } from "@/core/scene/terrainShapes"
import { compareShapeOrder } from "@/core/scene/terrainShapes"
import type { Id, TerrainShape } from "@/core/scene/types"
import type { TerrainOverlay } from "@/render/contracts"

import type { TerrainSelection } from "../../store"
import type { OverlayParts } from "./context"

const EMPTY_SHAPES: readonly TerrainShape[] = Object.freeze([])
const EMPTY_IDS: readonly Id[] = Object.freeze([])

export interface OverlayInput {
  levelId: Id
  /** The level's shapes record (terrainEdits.shapes), or null when it has none. */
  shapes: Readonly<Record<Id, TerrainShape>> | null
  selection: TerrainSelection | null
  /** Elements of the selected shapes are shown (advanced mode in the select sub-tool). */
  elementMode: TerrainElementMode | null
  parts: OverlayParts
}

export interface OverlayComposer {
  compose(input: OverlayInput): TerrainOverlay
  /** The level's shapes in bake order (memoised per record), with `substitutes` swapped in. */
  shapesOf(record: Readonly<Record<Id, TerrainShape>> | null, substitutes?: ReadonlyMap<Id, TerrainShape> | null): readonly TerrainShape[]
}

export function createOverlayComposer(): OverlayComposer {
  const sorted = new WeakMap<object, readonly TerrainShape[]>()
  let swapped: { list: readonly TerrainShape[]; subs: ReadonlyMap<Id, TerrainShape>; out: readonly TerrainShape[] } | null = null

  const shapesOf = (record: Readonly<Record<Id, TerrainShape>> | null, substitutes: ReadonlyMap<Id, TerrainShape> | null = null): readonly TerrainShape[] => {
    if (!record) return EMPTY_SHAPES
    let list = sorted.get(record)
    if (!list) {
      list = Object.values(record).sort(compareShapeOrder)
      sorted.set(record, list)
    }
    if (!substitutes || substitutes.size === 0) return list
    if (swapped && swapped.list === list && swapped.subs === substitutes) return swapped.out
    const out = list.map((s) => substitutes.get(s.id) ?? s)
    swapped = { list, subs: substitutes, out }
    return out
  }

  return {
    shapesOf,
    compose({ levelId, shapes, selection, elementMode, parts }) {
      const sel = selection && selection.levelId === levelId ? selection : null
      return {
        kind: "terrain",
        levelId,
        shapes: shapesOf(shapes, parts.substitutes),
        selectedShapeIds: sel ? sel.shapeIds : EMPTY_IDS,
        hoverShapeId: parts.hoverShapeId,
        elements: elementMode && sel ? { mode: elementMode, selected: sel.elements, hover: parts.hoverElement } : null,
        draft: parts.draft,
        gizmo: parts.gizmo,
        brush: parts.brush,
        label: parts.label,
        marquee: parts.marquee,
      }
    },
  }
}
