/**
 * What the terrain tool's sub-tools share: the tool dependencies, redraw / notice plumbing, a guard that
 * marks the tool's own store writes (so its gesture-invalidation subscription ignores them), and small
 * readers of the store state the sub-tools need.
 */
import type { SnapMode } from "@/core/grid/grid"
import { DEFAULT_TERRAIN_RESOLUTION, sampleSpacing } from "@/core/scene/heightmap"
import type { TerrainElementRef } from "@/core/scene/terrainShapes"
import type { Id, Level, TerrainShape, Vec2, Vec3 } from "@/core/scene/types"
import type { TerrainOverlay } from "@/render/contracts"

import type { EditorState, EditorStore } from "../../store"
import { FREE_HEIGHT_STEP, type Ray } from "../../terrainMath"
import { pointerSnapMode, type ToolDeps } from "../shared"
import type { CursorKey, ToolPointerEvent } from "../types"
import type { TerrainKey } from "./keys"

export interface TerrainToolContext {
  readonly deps: ToolDeps
  readonly store: EditorStore
  /** The tool's own state changed: rebuild the overlay and redraw. */
  changed(): void
  /** Run store writes made by the tool itself (the invalidation subscription ignores them). */
  write<T>(fn: () => T): T
  /** A transient message shown by hint() until the next press or key (null clears it). */
  notify(message: string | null): void
}

/** Overlay contributions of a sub-tool (see overlay.ts). */
export interface OverlayParts {
  /** Shapes replaced while dragging (id → the moved version). */
  substitutes: ReadonlyMap<Id, TerrainShape> | null
  hoverShapeId: Id | null
  hoverElement: TerrainElementRef | null
  draft: TerrainOverlay["draft"]
  gizmo: TerrainOverlay["gizmo"]
  brush: TerrainOverlay["brush"]
  label: TerrainOverlay["label"]
  /** Screen-space selection box (canvas CSS px). */
  marquee: NonNullable<TerrainOverlay["marquee"]> | null
  /** Outline of the polygon being drawn. */
  outline: NonNullable<TerrainOverlay["outline"]> | null
  /** Loop cut preview. */
  cuts: NonNullable<TerrainOverlay["cuts"]> | null
}

export const NO_PARTS: OverlayParts = {
  substitutes: null,
  hoverShapeId: null,
  hoverElement: null,
  draft: null,
  gizmo: null,
  brush: null,
  label: null,
  marquee: null,
  outline: null,
  cuts: null,
}

/** One sub-tool of the terrain mode (brush, creation, select). */
export interface SubTool {
  /** A gesture is in progress (level of the gesture), else null. */
  gestureLevel(): Id | null
  /** Camera controls off: a drag gesture is in progress. */
  captures(): boolean
  pointerDown(e: ToolPointerEvent): void
  pointerMove(e: ToolPointerEvent): void
  pointerUp(e: ToolPointerEvent): void
  /** A key: true when handled (consumed), false when not. */
  key(k: TerrainKey): boolean
  /** Abort the gesture (engine previews dropped) and forget hover state. */
  cancel(): void
  /** Settings / Alt / snap mode changed: recompute the gesture from the last pointer event. */
  refresh(): void
  parts(): OverlayParts
  cursor(): string | null
  hint(): string | null
  /** Key hints next to the cursor (Tool.cursorKeys); absent: none. */
  cursorKeys?(): readonly CursorKey[] | null
}

/** The active level, when it exists. */
export function activeLevel(s: Pick<EditorState, "scene" | "activeLevelId">): { levelId: Id; level: Level } | null {
  const levelId = s.activeLevelId
  return Object.hasOwn(s.scene.levels, levelId) ? { levelId, level: s.scene.levels[levelId] } : null
}

/** Mean XZ of a shape's top vertices: the exact centre of a regular cylinder (any side count). */
export function pointsCentre(shape: Pick<TerrainShape, "points">): Vec2 {
  let x = 0
  let z = 0
  for (const p of shape.points) {
    x += p.x
    z += p.z
  }
  const n = Math.max(1, shape.points.length)
  return { x: x / n, z: z / n }
}

/** A level's shapes record (empty when it has none). */
export const levelShapes = (level: Pick<Level, "terrainEdits"> | undefined): Readonly<Record<Id, TerrainShape>> => level?.terrainEdits?.shapes ?? EMPTY_SHAPES

const EMPTY_SHAPES: Readonly<Record<Id, TerrainShape>> = Object.freeze({})

/** The terrain selection when it belongs to the active level (null otherwise). */
export function activeSelection(s: Pick<EditorState, "terrainSelection" | "activeLevelId">): EditorState["terrainSelection"] {
  const sel = s.terrainSelection
  return sel && sel.levelId === s.activeLevelId && sel.shapeIds.length > 0 ? sel : null
}

/**
 * The advanced (edit) mode is effective: the setting is on, the Select sub-tool is active (only it shows the
 * elements) and shapes of the active level are selected. Elsewhere the actions act on the whole shapes.
 */
export function editMode(s: Pick<EditorState, "terrainSelection" | "activeLevelId" | "toolSettings">): boolean {
  const t = s.toolSettings.terrain
  return t.advanced && t.sub === "select" && activeSelection(s) !== null
}

/** Snap mode of a pointer event (store mode; Alt on the event or held → free). */
export const snapModeOf = (store: EditorStore, e: Pick<ToolPointerEvent, "alt"> | null): SnapMode => pointerSnapMode(store, { alt: e?.alt ?? false })

/** Height snapping step: toolSettings.terrain.heightStep, or FREE_HEIGHT_STEP when snapping is off. */
export function heightStepOf(store: EditorStore, e: Pick<ToolPointerEvent, "alt"> | null): number {
  const step = store.getState().toolSettings.terrain.heightStep
  return snapModeOf(store, e) === "free" || !(step > 0) ? FREE_HEIGHT_STEP : step
}

/** The pointer ray of an event (null when the pick has none: pointer left the canvas). */
export const rayOf = (e: ToolPointerEvent): Ray | null => e.pick.ray ?? null

/** Canvas position of an event (the projector's frame), when the viewport filled it. */
export const canvasOf = (e: ToolPointerEvent): { x: number; y: number } | null =>
  e.canvasX !== undefined && e.canvasY !== undefined ? { x: e.canvasX, y: e.canvasY } : null

/** Pixel travel of a press (canvas px when known, else client px). */
export function pressTravel(a: ToolPointerEvent, b: ToolPointerEvent): number {
  const ca = canvasOf(a)
  const cb = canvasOf(b)
  if (ca && cb) return Math.hypot(cb.x - ca.x, cb.y - ca.y)
  return Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)
}

/** World point of the event's terrain pick (null off the level). */
export const groundOf = (e: ToolPointerEvent): Vec3 | null => e.pick.ground ?? null

/** The camera is being dragged (right = orbit, middle = pan) during this move. */
export const cameraDragging = (e: ToolPointerEvent) => ((e.buttons ?? 0) & 6) !== 0

/** Tolerance (ft) before a shape hit counts as hidden behind the baked terrain (the bake follows the lattice). */
export function buriedTolerance(level: Level, cellSize: number): number {
  return Math.max(0.5, 1.5 * sampleSpacing(cellSize, level.heightmap?.resolution ?? DEFAULT_TERRAIN_RESOLUTION))
}
