/**
 * Public API of the render layer. React components, the editor and play controllers talk to the
 * renderer ONLY through this interface (see docs/ARCHITECTURE.md §4).
 */
import type { GizmoAxis, GizmoPart } from "@/core/geometry/gizmo"
import type { PathStep } from "@/core/movement/types"
import type { BrushMode } from "@/core/scene/heightmapBrush"
import type { TerrainElementMode, TerrainElementRef } from "@/core/scene/terrainShapes"
import type { Id, Rect, SceneLike, TerrainShape, Vec2, Vec3 } from "@/core/scene/types"
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
  /** Editor-only helpers (light radius gizmos, connector arrows, hidden objects outlined). */
  showHelpers: boolean
  /**
   * DM dark vision (DM modes with vision "off"): dark and dim surfaces are lifted so a dark level stays
   * workable, and drawn desaturated, blue-tinted and striped in proportion to the lift. Ignored otherwise.
   */
  darkVision: boolean
}

// ---------------------------------------------------------------------------
// Overlays: transient visuals driven by tools / play controllers
// ---------------------------------------------------------------------------

/** Translate-gizmo axis (world X / Y / Z) and gizmo handle (an axis or the rotate ring), shared with the tools' gizmo math. */
export type { GizmoAxis, GizmoPart }

/**
 * The terrain editing mode's overlay (ARCHITECTURE §7 "Terrain tools"): the active level's shapes as editable
 * prisms over the baked terrain, the selection, the advanced mode's elements, a shape being created, the
 * translate gizmo, the brush ring and a value label. Shape coordinates follow TerrainShape (x, z world feet;
 * y relative to the level elevation); `gizmo.at` and `label.at` are world points. Arrays keep their identity
 * while unchanged, so the renderer can cache per-shape geometry.
 */
export interface TerrainOverlay {
  kind: "terrain"
  levelId: Id
  /** Shapes to draw (the tool substitutes drafts / dragged versions). */
  shapes: readonly TerrainShape[]
  selectedShapeIds: readonly Id[]
  hoverShapeId: Id | null
  /** Advanced (edit) mode: element display of the selected shapes. */
  elements: { mode: TerrainElementMode; selected: readonly TerrainElementRef[]; hover: TerrainElementRef | null } | null
  /** Shape being created (a zero-height prism during the base phase); `valid` false draws it red. */
  draft: { shape: TerrainShape; valid: boolean } | null
  /**
   * Gizmo at the selection's pivot: the translate arrows plus the ring that rotates about the vertical axis
   * (core/geometry/gizmo gizmoHandles / gizmoRing); the part being dragged and the one under the pointer.
   */
  gizmo: { at: Vec3; active: GizmoPart | null; hover: GizmoPart | null } | null
  brush: { center: Vec2; radius: number; mode: BrushMode } | null
  /** Live value next to the cursor (e.g. "+7.5 ft · Add"). */
  label: { at: Vec3; text: string } | null
  /**
   * Screen-space selection box of the select sub-tool (canvas CSS px, y down: the frame of
   * ToolPointerEvent.canvasX / canvasY and Engine.project), drawn as a rect outline with a faint fill.
   * Absent or null: none.
   */
  marquee?: { from: { x: number; y: number }; to: { x: number; y: number } } | null
  /**
   * Outline of a polygon being drawn (world space): the corners placed so far and the pending one, joined
   * in order, with vertex dots; `valid` false draws the open chain red. `closing`: the edge from the last
   * point back to the first, drawn dimmed ("ok") or red ("crossing": it would cross the outline); "none"
   * with fewer than three points. Absent or null: none.
   */
  outline?: { points: readonly Vec3[]; valid: boolean; closing: "none" | "ok" | "crossing" } | null
}

export type ToolPreview =
  | { kind: "rect"; levelId: Id; rect: Rect; color?: string }
  /** `followTerrain` false: the wall stands on the level elevation (default: it follows the terrain). */
  | { kind: "segment"; levelId: Id; a: Vec2; b: Vec2; height: number; thickness: number; valid: boolean; followTerrain?: boolean }
  /** `followTerrain`: the host wall's option (false: the opening measures from the level elevation). */
  | { kind: "opening"; levelId: Id; a: Vec2; b: Vec2; height: number; sill: number; valid: boolean; followTerrain?: boolean }
  | { kind: "point"; levelId: Id; position: Vec3; radius?: number; color?: string }
  | { kind: "brush"; levelId: Id; center: Vec2; radius: number; mode: BrushMode }
  | { kind: "ghost-objects"; scene: Pick<SceneLike, "objects" | "levels" | "grid">; offset: Vec2 }
  | TerrainOverlay

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
  /**
   * Ground on a heightmap level: march the terrain wherever it lies inside the grid extent (as the grid
   * overlay drapes it), not only under floors; the level plane remains the fallback. Editor picks set it
   * (wall nodes land where the cursor ray meets the terrain). Affects `ground` only, not the floor-object hit.
   */
  terrain?: boolean
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
  /**
   * The pointer ray in world space (unit direction). Orthographic cameras give parallel rays with a
   * per-pixel origin, so never derive it from the camera position. Absent when the canvas has no size.
   */
  ray?: { origin: Vec3; direction: Vec3 } | null
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

/**
 * Start-up progress (Engine.getLoadState), after a scene is set, a user quality change or a context
 * restore: "compiling" while the shader programs compile (the engine draws nothing meanwhile), then
 * "lighting" while the first shadow / vision captures fill (the scene draws, lights may still pop in).
 */
export interface EngineLoadState {
  loading: boolean
  stage: "compiling" | "lighting" | "ready"
  /** 0..1 over both stages (1 when ready). */
  progress: number
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
   * `opts` overrides the level document's `backdrop.opacity` / `tintWalls` (players' scenes may lack
   * them: pass PlayerBackdrop's values). ImageBitmaps should be decoded with premultiplyAlpha
   * "premultiply". Oversized images are downscaled to the tier's texel budget (≤ 8192 px per side).
   */
  setLevelImage(levelId: Id, image: TexImageSource | null, rect: Rect | null, opts?: { opacity?: number; tintWalls?: boolean }): void
  /**
   * Re-upload a level image after its canvas changed: all of it when `dirty` is omitted, else only the
   * dirty world rect(s). A list means independent regions that are uploaded separately (pass the changed
   * cells or chunks, not their bounding box: a box around two distant cells re-uploads everything between).
   */
  updateLevelImage(levelId: Id, dirty?: Rect | readonly Rect[]): void
  setView(view: Partial<ViewState>): void
  getView(): ViewState
  setOverlays(overlays: Partial<OverlayState>): void
  setQuality(q: Quality): void
  /**
   * The quality ceiling (the tier given to createEngine / setQuality / benchmarkQuality; adaptive quality
   * never goes above it). Level image budgets follow it (`backdropTexelBudget` in render/index.ts).
   */
  getQualityCeiling(): Quality
  /**
   * Pick the quality tier for this device (renderer heuristics + a short synthetic benchmark, cached per
   * GPU; see render/engine/autoQuality.ts), apply it as the quality ceiling and return it. Optional:
   * callers that create engines before knowing the tier can call it once after creation (or use the
   * exported pickInitialQuality() before createEngine).
   */
  benchmarkQuality?(): Promise<Quality>

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
  /**
   * Load progress (EngineLoadState). Programs compile in parallel off the main thread where the browser
   * supports it (KHR_parallel_shader_compile); until they are ready the engine draws nothing, so the page
   * stays responsive. Without that extension compiles are synchronous and the state stays "ready".
   * Listeners are called on changes only.
   */
  getLoadState(): EngineLoadState
  onLoadState(cb: (s: EngineLoadState) => void): () => void
  resize(): void
  dispose(): void
}

/** Resolves Token.model references (e.g. "free:elf-archer") to the URL of a GLB (render/engine/tokenModels.ts). */
export interface TokenModelSource {
  /** null when the reference names no model this app can load. */
  resolveUrl(ref: string): Promise<string | null>
}

export interface EngineOptions {
  quality?: Quality
  /** Called when WebGL context is lost/restored. */
  onContextLost?: () => void
  /** Where token models come from; without it every token keeps the default body. */
  tokenModels?: TokenModelSource
}

export type CreateEngine = (canvas: HTMLCanvasElement, opts?: EngineOptions) => Engine
