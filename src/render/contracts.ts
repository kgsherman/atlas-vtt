/**
 * Public API of the render layer. React components, the editor and play controllers talk to the
 * renderer ONLY through this interface (see docs/ARCHITECTURE.md §4).
 */
import type { PathStep } from "@/core/movement/types"
import type { Id, Rect, SceneLike, Vec2, Vec3 } from "@/core/scene/types"
import type { EncodedGrades, EncodedMask } from "@/core/vision/types"

export type Quality = "low" | "medium" | "high" | "ultra"

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
  /** Player fog of war: perceived / explored memory / black, clamped by the host masks. */
  | "fog"
  /** DM preview of some tokens' vision: non-perceived areas darkened but not hidden. */
  | "preview"

/**
 * Authoritative per-level masks (from PlayerView.masks, or computed locally by core/vision for DM
 * preview / editor "preview player view"). In "fog" and "preview" modes the renderer never shows a
 * pixel as perceived unless its cell (or sub-cell) is perceived here; GPU line of sight only refines
 * edges inside these cells. A level missing from the record is entirely unperceived/unexplored.
 */
export interface HostLevelMasks {
  perception: EncodedGrades
  explored: EncodedMask
  /** Cells reached by the sun/moon (player mode: gates the directional term). Absent = use the local shadow map only. */
  sunlit?: EncodedMask
}

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
  /**
   * Tokens whose eyes provide GPU line-of-sight refinement in "fog"/"preview" modes. The engine uses
   * the tokens' CONFIRMED positions from the scene it was given (never drag/pending positions) and
   * resolves eyes with core/vision resolveViewerEye so CPU and GPU eyes match.
   */
  viewerTokenIds: Id[]
  /** Host masks per level (required in "fog"/"preview"; ignored in "off"). */
  hostMasks: Record<Id, HostLevelMasks>
  /** Per-pixel GPU line-of-sight refinement inside host-perceived cells (off on the low tier). */
  gpuVisionRefine: boolean
  /** Tokens drawn darkened (DM preview: not visible to the previewed token). */
  dimmedTokenIds: Id[]
  /**
   * The locally controlled / selected viewer: its vision tile is refreshed every frame it moves, even over
   * the shadow update budget. Defaults to viewerTokenIds[0].
   */
  primaryViewerId: Id | null
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
  | { kind: "ghost-objects"; scene: Pick<SceneLike, "objects" | "levels" | "grid">; offset: Vec2 }

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
  /** World-space surface normal at hitPoint, when any (the light tool mounts at hitPoint + 0.3·normal). */
  hitNormal?: Vec3 | null
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface FrameStats {
  fps: number
  frameMs: number
  /** 95th percentile frame time over the last ~2 s. */
  frameMsP95: number
  drawCalls: number
  triangles: number
  activeLights: number
  shadowTilesUpdated: number
  shadowTilesTotal: number
  /** CPU submission time spent on shadow/vision tile updates this frame (not GPU time). */
  shadowUpdateMs: number
  pixelRatio: number
  quality: Quality
}

export interface SceneChange {
  /** Object ids added, changed or removed since the last call. */
  objects?: Id[]
  tokens?: Id[]
  /** Level ids whose terrain changed (re-mesh terrain + update occlusion heightfields only). */
  terrain?: Id[]
  /** Levels/grid/environment changed → rebuild affected levels. */
  structure?: boolean
}

export interface Engine {
  /**
   * Replace the scene entirely (full rebuild). DM modes pass the full Scene; player mode passes the
   * scene reconstructed from the PlayerView by core/session viewToScene().
   */
  setScene(scene: SceneLike): void
  /** Apply a new scene revision; `change` lets the engine rebuild only what changed. */
  updateScene(scene: SceneLike, change?: SceneChange): void
  /**
   * Live heightmap-brush preview: replace a level's terrain heights (dense lattice, see
   * core/scene/heightmap denseHeights) inside `dirty` without touching the document. null clears the preview.
   */
  previewTerrain(levelId: Id, heights: Float32Array | null, dirty: Rect | null): void
  /**
   * Battlemap image for a level (ARCHITECTURE §9), draped over its walkable surfaces within `rect`
   * (the level's backdrop rect). DM modes pass the whole decoded image; player mode passes a canvas the
   * player client composites explored-cell tiles into (unfilled texels are transparent), then calls
   * updateLevelImage() after drawing more tiles. null removes the image.
   */
  setLevelImage(levelId: Id, image: TexImageSource | null, rect: Rect | null): void
  /** Re-upload a level image after its canvas changed (optionally only `dirty`, world rect). */
  updateLevelImage(levelId: Id, dirty?: Rect): void
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
