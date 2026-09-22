/**
 * Public API of the render layer. React components, the editor and play controllers talk to the
 * renderer ONLY through this interface (see docs/ARCHITECTURE.md §4).
 */
import type { PathStep } from "@/core/movement/types"
import type { Id, Rect, Scene, Vec2, Vec3 } from "@/core/scene/types"
import type { EncodedMask } from "@/core/vision/types"

export type Quality = "low" | "medium" | "high"

export type RenderMode =
  /** DM building: orbit camera, all levels per visibility toggles, no fog. */
  | "editor"
  /** DM running a session: sees everything; can preview a token's vision. */
  | "dm-play"
  /** Player: 2.5D camera, cutaway above the current level, fog of war. */
  | "player"

export type CameraKind = "orbit" | "topdown"

/** How vision/fog is applied. */
export type VisionMode =
  /** No vision test: everything lit normally (DM). */
  | "off"
  /** Player fog of war: visible / explored memory / black. */
  | "fog"
  /** DM preview of some tokens' vision: non-visible areas darkened but not hidden. */
  | "preview"

export interface ViewState {
  mode: RenderMode
  camera: CameraKind
  /** Level being edited (editor) or the current level for cutaway (player / dm-play). */
  activeLevelId: Id | null
  /** Editor per-level visibility toggles (missing = visible). */
  levelVisibility: Record<Id, boolean>
  /** Editor: draw the levels directly above/below the active one as translucent ghosts. */
  ghostAdjacent: boolean
  /** Player/dm-play: hide everything above the active level. */
  cutaway: boolean
  showGrid: boolean
  vision: VisionMode
  /** Tokens whose eyes provide vision in "fog"/"preview" modes. */
  viewerTokenIds: Id[]
  /** Authoritative explored masks per level (player mode). Missing level = unexplored. */
  exploredMasks: Record<Id, EncodedMask>
  /** Player camera tilt from vertical, radians (0 = straight down). */
  tilt: number
  /** Editor-only helpers (light radius gizmos, connector arrows, hidden objects outlined). */
  showHelpers: boolean
}

// ---------------------------------------------------------------------------
// Overlays: transient visuals driven by tools / play controllers
// ---------------------------------------------------------------------------

export type ToolPreview =
  | { kind: "rect"; levelId: Id; rect: Rect; color?: string }
  | { kind: "segment"; levelId: Id; a: Vec2; b: Vec2; height: number; thickness: number; valid: boolean }
  | { kind: "opening"; levelId: Id; a: Vec2; b: Vec2; height: number; sill: number; valid: boolean }
  | { kind: "point"; levelId: Id; position: Vec3; radius?: number; color?: string }
  | { kind: "brush"; levelId: Id; center: Vec2; radius: number; mode: "raise" | "lower" | "smooth" | "flatten" }
  | { kind: "ghost-objects"; scene: Pick<Scene, "objects" | "levels" | "grid">; offset: Vec2 }

export interface RulerOverlay {
  levelId: Id
  points: Vec3[]
  label: string
}

export interface OverlayState {
  selectedIds: Id[]
  hoveredId: Id | null
  preview: ToolPreview | null
  ruler: RulerOverlay | null
  /** Token paths awaiting host confirmation (drawn dashed). */
  pendingMoves: Record<Id, PathStep[]>
  /** Token drag previews (token drawn at these positions translucently). */
  dragGhosts: Record<Id, { levelId: Id; position: Vec2 }>
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

export interface PickOptions {
  /** Intersect the ground of this level (floors/terrain, or the level plane if nothing there). */
  levelId: Id
  /** Also pick objects/tokens under the cursor. */
  objects?: boolean
  tokens?: boolean
}

export interface PickResult {
  /** World point on the level's ground (or plane) under the cursor. */
  ground: Vec3 | null
  objectId: Id | null
  tokenId: Id | null
  /** World point of the object hit, when any. */
  hitPoint: Vec3 | null
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface FrameStats {
  fps: number
  frameMs: number
  drawCalls: number
  triangles: number
  activeLights: number
  shadowTilesUpdated: number
  shadowTilesTotal: number
  pixelRatio: number
}

export interface SceneChange {
  /** Object ids added, changed or removed since the last call. */
  objects?: Id[]
  tokens?: Id[]
  /** Levels/grid/environment changed → rebuild affected levels. */
  structure?: boolean
}

export interface Engine {
  /** Replace the scene entirely (full rebuild). */
  setScene(scene: Scene): void
  /** Apply a new scene revision; `change` lets the engine rebuild only what changed. */
  updateScene(scene: Scene, change?: SceneChange): void
  setView(view: Partial<ViewState>): void
  getView(): ViewState
  setOverlays(overlays: Partial<OverlayState>): void
  setQuality(q: Quality): void

  pick(clientX: number, clientY: number, opts: PickOptions): PickResult
  /** Project a world point to canvas-relative CSS pixels (for HTML labels). */
  project(p: Vec3): { x: number; y: number; visible: boolean }

  /** Camera helpers. */
  focus(point: Vec3, opts?: { distance?: number; immediate?: boolean }): void
  frameScene(): void
  rotateCamera(quarterTurns: number): void
  /** Enable/disable the engine's own camera controls (tools may need exclusive pointer). */
  setCameraControlsEnabled(enabled: boolean): void

  onFrame(cb: (stats: FrameStats) => void): () => void
  resize(): void
  dispose(): void
}

export interface EngineOptions {
  quality?: Quality
  /** Called when WebGL context is lost/restored. */
  onContextLost?: () => void
}

export type CreateEngine = (canvas: HTMLCanvasElement, opts?: EngineOptions) => Engine
