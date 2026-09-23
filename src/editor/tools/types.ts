/**
 * Contract between the editor canvas (React), the engine's picking, and editor tools.
 * The canvas converts DOM pointer events into ToolPointerEvents (picking via Engine.pick against the
 * active level, snapping via core/grid) and forwards them to the active tool.
 */
import type { Id, Vec2 } from "@/core/scene/types"
import type { PickResult, ToolPreview } from "@/render/contracts"

export type ToolId =
  | "select"
  | "floor"
  | "wall"
  | "door"
  | "window"
  | "connector"
  | "pillar"
  | "prop"
  | "light"
  | "terrain"
  | "token"
  | "measure"

export interface ToolPointerEvent {
  /** Raw pick on the active level (ground point unsnapped; objectId/tokenId under the cursor). */
  pick: PickResult
  /** Ground point snapped with the editor's current snap mode (Alt held = free). null when off the level plane. */
  snapped: Vec2 | null
  /** Raw ground point (unsnapped). */
  ground: Vec2 | null
  button: number
  shift: boolean
  alt: boolean
  ctrl: boolean
  clientX: number
  clientY: number
  /** Click count from the DOM event (2 = double click). */
  detail?: number
}

export interface ToolKeyEvent {
  key: string
  shift: boolean
  alt: boolean
  ctrl: boolean
}

export interface ToolContext {
  activeLevelId: Id
}

export interface Tool {
  id: ToolId
  /** Whether the engine's camera controls should be disabled while this tool is active (e.g. dragging). */
  capturesPointer?: boolean
  onPointerDown?(e: ToolPointerEvent): void
  onPointerMove?(e: ToolPointerEvent): void
  onPointerUp?(e: ToolPointerEvent): void
  onKeyDown?(e: ToolKeyEvent): boolean
  /** Called when the tool is deactivated or Escape cancels an in-progress gesture. */
  cancel?(): void
  /** Current preview to draw (read by the canvas each frame / on change). */
  preview(): ToolPreview | null
}
