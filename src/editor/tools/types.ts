/**
 * Contract between the editor canvas (React), the engine's picking, and editor tools.
 * The canvas converts DOM pointer events into ToolPointerEvents (picking via Engine.pick against the
 * active level, snapping via core/grid) and forwards them to the active tool.
 */
import type { Id, Vec2 } from "@/core/scene/types"
import type { PickResult, ToolPreview } from "@/render/contracts"

import type { ShortcutAction } from "../shortcuts"

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
  /** Pointer position relative to the canvas, CSS px (the frame of ToolDeps.project). */
  canvasX?: number
  canvasY?: number
  /** DOM `buttons` bitmask (1 left, 2 right, 4 middle): lets tools ignore moves while the camera is dragged. */
  buttons?: number
  /** Click count from the DOM event (2 = double click). */
  detail?: number
}

export interface ToolKeyEvent {
  key: string
  shift: boolean
  alt: boolean
  ctrl: boolean
  /** The keymap action bound to the key (tools should match actions, so remapped keys work). */
  action?: ShortcutAction
}

/**
 * One row of the key hints that float next to the cursor during a multi-step gesture (Tool.cursorKeys):
 * a mouse input and / or keymap commands (shown with their current keys, so remaps show), and what it does.
 */
export interface CursorKey {
  /** Mouse input shown as-is ("Click", "Right-click"). */
  mouse?: string
  /** Keymap command ids (EDITOR_COMMANDS) whose keys are shown. */
  commands?: readonly string[]
  label: string
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
  /** CSS cursor while this tool is active (null or absent: the canvas default). */
  cursor?(): string | null
  /** Phase-aware hint for the options bar (null or absent: the tool's static hint). */
  hint?(): string | null
  /**
   * Key hints drawn next to the cursor (null or absent: none). Return the same array while it is unchanged:
   * the canvas re-reads it on every controller notification and re-renders on a new identity.
   */
  cursorKeys?(): readonly CursorKey[] | null
}
