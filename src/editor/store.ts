/**
 * DM editor state (docs/ARCHITECTURE.md §7): the working Scene, selection, active level, tool and
 * tool settings, snapping, view options, clipboard and undo/redo.
 *
 * Every document change goes through `apply(recipe, label)` → immer produceWithPatches → core/history.
 * Undo/redo apply the recorded patches. Tools group gestures (drags, strokes) in transactions that
 * commit as one undo step.
 *
 * Live sessions: `setPatchSink(fn)` forwards every document patch (apply, undo, redo, cancelled
 * transactions) to the host, which applies it to GameState.scene (DmCommand "apply-scene-patches");
 * the local scene is updated too, and `syncScene()` adopts the host's scene after play actions.
 * `setPlaySink(fn)` routes play actions (door state, light on/off, token drags/nudges) to the host as
 * DmCommands instead of document edits, so they never enter undo.
 */
import { applyPatches, current, produceWithPatches, type Draft, type Patch } from "immer"
import { createStore, type StoreApi } from "zustand/vanilla"

import type { SnapMode } from "@/core/grid/grid"
import { createHistory, type HistoryOptions, type HistoryState } from "@/core/history"
import { createLevel, createScene } from "@/core/scene/factory"
import { createHeightmap, DEFAULT_TERRAIN_RESOLUTION, finestTerrainResolution, maxCellsForResolution, sampleCounts, sampleSpacing, terrainResolutionFits } from "@/core/scene/heightmap"
import {
  applyShapesEdit,
  cropTerrainToGrid,
  hasPaintedBase,
  resampleTerrain,
  writeTerrain,
  type TerrainEdit,
  type TerrainElementRef,
  type TerrainResult,
} from "@/core/scene/terrainShapes"
import {
  copySelection as copyItems,
  deleteWithDependents,
  openingFits,
  pasteClipboard,
  reprojectOpenings,
  type AtlasClipboard,
} from "@/core/scene/integrity"
import { groundHeightAt, lightLevelId, lightWorldPosition, sortedLevels, wallLength } from "@/core/scene/queries"
import { SCENE_LIMITS } from "@/core/scene/schema"
import type {
  DirectionalLightSettings,
  DoorState,
  Environment,
  GridSettings,
  Heightmap,
  Id,
  Level,
  Scene,
  SceneMeta,
  SceneObject,
  Token,
  Vec2,
} from "@/core/scene/types"
import type { DmCommand } from "@/core/session/types"
import type { SceneChange, ViewState } from "@/render/contracts"

import { browserClipboard, parseClipboardText, serializeClipboard, validatePastedItems, type SystemClipboard } from "./clipboard"
import { sceneChangeFromPatches } from "./sceneChange"
import {
  BRUSH_RADIUS_MAX,
  BRUSH_RADIUS_MIN,
  DEFAULT_SNAP_MODE,
  defaultToolSettings,
  defaultViewOptions,
  type EditorViewOptions,
  type ToolSettings,
} from "./settings"
import { effectiveSnapMode } from "./snapping"
import type { ToolId } from "./tools/types"
import { alignDelta, applyMove, applyRotation, planMove, rotateQuarter, rotationPivot, snapPasteAt, type MovePlan } from "./transform"
import { validateEdit } from "./validate"

export type SceneRecipe = (draft: Draft<Scene>) => void

export type PatchSource = "apply" | "undo" | "redo" | "cancel"
export type PatchSink = (patches: Patch[], meta: { label: string; source: PatchSource }) => void
export type PlaySink = (command: DmCommand) => void

export type SelectMode = "replace" | "add" | "toggle" | "remove"

/** Partial edit of any object type (id and type are immutable). */
export type ObjectUpdate = {
  [K in SceneObject["type"]]: Partial<Omit<Extract<SceneObject, { type: K }>, "id" | "type">>
}[SceneObject["type"]]

export type TokenUpdate = Partial<Omit<Token, "id">>
/** Level fields editable through updateLevel. Terrain (heightmap, terrainEdits) goes through the terrain actions. */
export type LevelUpdate = Partial<Omit<Level, "id" | "heightmap" | "terrainEdits">>
export type EnvironmentUpdate = Partial<Omit<Environment, "directional">> & { directional?: Partial<DirectionalLightSettings> }
export type GridUpdate = Partial<Pick<GridSettings, "width" | "depth" | "diagonalRule">>

export interface ApplyOptions {
  /** Merge with the previous undo step when it has the same key (slider drags, repeated nudges). */
  coalesceKey?: string
}

export interface PasteOptions {
  /** Where the clipboard's origin lands (default: in place on another level, one cell down-right on the same level). */
  at?: Vec2
  /** Wall under the pointer: openings copied without their wall are re-hosted on it. */
  hostWallId?: Id
  /** Paste this clipboard instead of the stored one. */
  clipboard?: AtlasClipboard
  /**
   * Snap mode for a paste `at` the pointer: the translation is snapped like a drag (transform.ts
   * snapPasteAt). Without it, `at` places the clipboard's origin exactly.
   */
  snap?: SnapMode
}

export type PasteTextResult = { ok: true; ids: Id[] } | { ok: false; issues: string[] }

/** A document set aside by detachDocument() (opaque apart from its scene). */
export interface DocumentStash {
  readonly scene: Scene
  /** @internal */
  readonly _state: unknown
}

/** Terrain shapes (and, in the advanced mode, their elements) selected by the terrain tool on one level. */
export interface TerrainSelection {
  levelId: Id
  /** Non-empty; ids of Level.terrainEdits.shapes. */
  shapeIds: Id[]
  /** Advanced mode: selected elements of the selected shapes. */
  elements: TerrainElementRef[]
}

interface StashState {
  history: ReturnType<typeof createHistory>
  savedHead: number
  selection: Id[]
  activeLevelId: Id
}

export interface EditorState {
  // ---- document -----------------------------------------------------------
  scene: Scene
  /** A scene from a newer schema version is opened read-only: apply() is a no-op. */
  readOnly: boolean
  /** Increments on every document change (apply, undo, redo, load, sync). */
  revision: number
  /** What the last document change touched (null after load/sync: diff or rebuild everything). */
  lastChange: SceneChange | null
  /** Unsaved changes since load / markSaved(). */
  dirty: boolean
  /**
   * The last edit that was refused because the document would no longer load (validateEdit: e.g.
   * content moved outside the scene extent, a grid shrunk under objects). Cleared by the next change.
   */
  lastRejected: { label: string; issues: string[] } | null
  history: HistoryState
  /** A patch sink is attached (live session). */
  live: boolean
  /** A play sink is attached: door/light toggles and token moves are sent as DmCommands, not edits. */
  playActions: boolean

  // ---- editor UI state ----------------------------------------------------
  selection: Id[]
  /**
   * The terrain tool's shape selection (not scene objects, so not `selection`). Missing shapes are dropped
   * on every document change (syncScene included); cleared on level change, a new / loaded / restored
   * document and when the terrain tool is left. When it becomes empty, toolSettings.terrain.advanced
   * resets to false (the advanced mode is effective only with shapes selected).
   */
  terrainSelection: TerrainSelection | null
  activeLevelId: Id
  tool: ToolId
  toolSettings: ToolSettings
  snapMode: SnapMode
  /** Alt held: placement is free regardless of snapMode. */
  altHeld: boolean
  view: EditorViewOptions
  clipboard: AtlasClipboard | null

  // ---- document plumbing --------------------------------------------------
  /**
   * Run `recipe` on a draft and commit the result as one undo step. Returns the patches, or [] when
   * nothing changed or the result was refused by validateEdit (see `lastRejected`). EditRejected
   * errors thrown by the recipe itself propagate.
   */
  apply(recipe: SceneRecipe, label: string, opts?: ApplyOptions): Patch[]
  /** Open a transaction (one undo step for a whole gesture). Returns its id (nested calls join). */
  beginTransaction(label: string): number
  commitTransaction(): void
  /** Revert everything applied since beginTransaction and record nothing. */
  cancelTransaction(): void
  /** Undo (or, while a transaction is open, cancel it). Returns whether anything changed. */
  undo(): boolean
  redo(): boolean
  loadScene(scene: Scene, opts?: { readOnly?: boolean }): void
  /**
   * Set the current document aside with its undo history (e.g. before viewing an old version
   * read-only); the store continues with a fresh, empty history. restoreDocument() brings it back.
   */
  detachDocument(): DocumentStash
  /** Return to a document set aside by detachDocument(), undo/redo history included. */
  restoreDocument(stash: DocumentStash): void
  newScene(opts?: Parameters<typeof createScene>[0]): void
  /** Adopt a scene changed outside the editor (live host state) without touching history. */
  syncScene(scene: Scene): void
  markSaved(): void
  setPatchSink(sink: PatchSink | null): void
  setPlaySink(sink: PlaySink | null): void

  // ---- levels -------------------------------------------------------------
  addLevel(partial?: Partial<Level>, opts?: { activate?: boolean }): Id | null
  /** Edit level fields (not its terrain: see the terrain actions below). Returns false when refused. */
  updateLevel(id: Id, partial: LevelUpdate): boolean
  removeLevel(id: Id): boolean

  // ---- terrain (every write goes through core/scene/terrainShapes; each action is one undo step) ----
  // The boolean actions return true when the document changed; false when refused (read-only, unknown
  // level, writeTerrain or validateEdit) or when there was nothing to do.
  /**
   * Edit a level's terrain through core/scene/terrainShapes writeTerrain (the single writer of heightmap +
   * terrainEdits) as one undo step. Returns false when the edit was refused (writeTerrain or validateEdit)
   * or changed nothing. `opts.coalesceKey` merges repeated edits (e.g. terrain nudges) into one step.
   */
  applyTerrainEdit(levelId: Id, edit: TerrainEdit, label: string, opts?: ApplyOptions): boolean
  /** Give a level without terrain an empty heightmap (default resolution DEFAULT_TERRAIN_RESOLUTION). */
  enableTerrain(levelId: Id, resolution?: Heightmap["resolution"]): boolean
  /** Remove the level's terrain: heightmap null, terrain shapes and painted base deleted. */
  clearTerrain(levelId: Id): boolean
  /**
   * Painted terrain (the base) back to 0 everywhere; the shapes stay (rebaked on the flat ground). False
   * when the painted base is already flat (`hasPaintedBase`), even where shapes raise the terrain.
   */
  flattenTerrain(levelId: Id): boolean
  /** Delete every terrain shape of the level (the painted base becomes the heightmap). */
  clearTerrainShapes(levelId: Id): boolean
  /**
   * Change the heightmap resolution: the painted base is resampled, the shapes rebaked at the new
   * resolution (baseChunks rewritten in the same edit). A level without terrain gets an empty heightmap.
   * False when the resolution does not fit the grid (core/scene/heightmap terrainResolutionFits).
   */
  setTerrainResolution(levelId: Id, resolution: Heightmap["resolution"]): boolean
  /**
   * "Apply to terrain": bake the given shapes into the painted base and delete them, together with the
   * older shapes under them (`applyShapesClosure`), so the terrain does not change. The undo label counts
   * every applied shape ("Apply 2 shapes to terrain").
   */
  applyTerrainShapes(levelId: Id, shapeIds: readonly Id[]): boolean
  /** Changing the active level clears the terrain selection. */
  setActiveLevel(id: Id): void
  /** +1 = the level above, −1 = the level below. */
  stepActiveLevel(delta: number): void

  // ---- objects / tokens ---------------------------------------------------
  addObject(object: SceneObject, label?: string): Id
  addToken(token: Token, label?: string): Id
  /**
   * Edit an object; returns false (and changes nothing) when the result would be invalid. Walls
   * reproject their openings; lights keep their world position when detached from a token.
   */
  updateObject(id: Id, partial: ObjectUpdate, opts?: ApplyOptions): boolean
  updateToken(id: Id, partial: TokenUpdate, opts?: ApplyOptions): boolean
  /** Delete objects/tokens and their dependents (openings of walls, attached lights are detached). */
  deleteIds(ids: Id[], label?: string): void
  setDoorState(id: Id, state: DoorState): void
  toggleLight(id: Id): void
  setLightOn(id: Id, on: boolean): void
  updateEnvironment(partial: EnvironmentUpdate, opts?: ApplyOptions): void
  updateGrid(partial: GridUpdate): void
  updateSceneInfo(partial: { name?: string; meta?: Partial<SceneMeta> }): void

  // ---- selection ----------------------------------------------------------
  /** Set the terrain selection (normalised: unknown shapes dropped, elements limited to selected shapes, empty → null). */
  setTerrainSelection(selection: TerrainSelection | null): void
  select(ids: Id[], mode?: SelectMode): void
  toggleSelected(id: Id): void
  clearSelection(): void
  /** Everything on the active level that is not editor-locked. */
  selectAll(): void
  deleteSelection(): number
  duplicateSelection(): Id[]
  copySelection(): AtlasClipboard | null
  cutSelection(): AtlasClipboard | null
  paste(opts?: PasteOptions): Id[]
  /** Paste untrusted clipboard text (system clipboard / paste event); validated before it is committed. */
  pasteText(text: string, opts?: Omit<PasteOptions, "clipboard">): PasteTextResult
  /** Read the system clipboard (when available) and paste it; falls back to the in-memory clipboard. */
  pasteFromSystem(opts?: Omit<PasteOptions, "clipboard">): Promise<PasteTextResult>
  nudgeSelection(dx: number, dz: number): void
  /** Rotate the selection by quarter turns (+90° about +Y each; negative = the other way). */
  rotateSelection(quarterTurns?: number): void
  /**
   * Move tokens as a play action when a play sink is attached (DmCommand "move-token"), else as a
   * document edit. Used by token drags so live sessions never put token moves in undo.
   */
  moveTokens(moves: { id: Id; position: Vec2; levelId?: Id }[], label?: string): void

  // ---- tools, snapping, view ----------------------------------------------
  /** Leaving the terrain tool clears the terrain selection. */
  setTool(tool: ToolId): void
  setToolSettings<K extends keyof ToolSettings>(tool: K, partial: Partial<ToolSettings[K]>): void
  /** Multiply the brush radius (clamped). */
  scaleBrushRadius(factor: number): void
  setSnapMode(mode: SnapMode): void
  setAltHeld(held: boolean): void
  setView(partial: Partial<EditorViewOptions>): void
  toggleGrid(): void
  toggleHelpers(): void
  toggleDarkVision(): void
  toggleGhostAdjacent(): void
  setLevelVisibility(id: Id, visible: boolean): void
  toggleLevelVisibility(id: Id): void
}

export type EditorStore = StoreApi<EditorState>

export interface CreateEditorStoreOptions {
  scene?: Scene
  history?: HistoryOptions
  /** System clipboard (default: navigator.clipboard when available; null disables it). */
  systemClipboard?: SystemClipboard | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hasOwn = (o: object, k: string) => Object.hasOwn(o, k)

export function itemExists(scene: Scene, id: Id): boolean {
  return hasOwn(scene.objects, id) || hasOwn(scene.tokens, id)
}

/** The level an object or token is on (attached lights: their carrier's level). */
export function itemLevelId(scene: Scene, id: Id): Id | null {
  if (hasOwn(scene.tokens, id)) return scene.tokens[id].levelId
  if (!hasOwn(scene.objects, id)) return null
  const o = scene.objects[id]
  return o.type === "light" ? lightLevelId(scene, o) : o.levelId
}

/** The ground-ish level: elevation closest to 0 (ties → the lower one). */
export function defaultActiveLevel(scene: Scene): Id {
  const levels = sortedLevels(scene)
  let best = levels[0]
  for (const l of levels) if (Math.abs(l.elevation) < Math.abs(best.elevation)) best = l
  return best?.id ?? ""
}

/** Keep `id` if it exists in `next`, else the level of `next` nearest in elevation to where it was. */
function resolveActiveLevel(next: Scene, id: Id, prev: Scene): Id {
  if (hasOwn(next.levels, id)) return id
  const levels = sortedLevels(next)
  if (levels.length === 0) return ""
  const elevation = hasOwn(prev.levels, id) ? prev.levels[id].elevation : 0
  let best = levels[0]
  for (const l of levels) if (Math.abs(l.elevation - elevation) < Math.abs(best.elevation - elevation)) best = l
  return best.id
}

const sameIds = (a: readonly Id[], b: readonly Id[]) => a.length === b.length && a.every((id, k) => id === b[k])
const sameElements = (a: readonly TerrainElementRef[], b: readonly TerrainElementRef[]) =>
  a.length === b.length && a.every((e, k) => e.shapeId === b[k].shapeId && e.kind === b[k].kind && e.index === b[k].index)

/**
 * Connectors must lead to an existing, higher level. After level edits, retarget broken ones to the
 * level directly above their own, or delete them when there is none.
 */
export function repairConnectors(draft: Scene): void {
  const levels = sortedLevels(draft)
  for (const o of Object.values(draft.objects)) {
    if (o.type !== "connector") continue
    const from = hasOwn(draft.levels, o.levelId) ? draft.levels[o.levelId] : undefined
    const to = hasOwn(draft.levels, o.toLevelId) ? draft.levels[o.toLevelId] : undefined
    if (from && to && to.elevation > from.elevation) continue
    const k = levels.findIndex((l) => l.id === o.levelId)
    const above = k >= 0 ? levels[k + 1] : undefined
    if (from && above && above.elevation > from.elevation) o.toLevelId = above.id
    else delete draft.objects[o.id]
  }
}

class EditRejected extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    super(issues.join("; "))
    this.issues = issues
  }
}

/**
 * Enforce per-type invariants after an edit (inside a recipe). Throws EditRejected when the edit
 * cannot be made valid (the recipe is then discarded by immer).
 */
function normalizeObject(draft: Scene, o: SceneObject): void {
  if (!hasOwn(draft.levels, o.levelId)) throw new EditRejected([`level "${o.levelId}" does not exist`])
  const s = draft.grid.cellSize
  switch (o.type) {
    case "wall":
      if (!(o.thickness > 0)) throw new EditRejected(["wall thickness must be > 0"])
      if (wallLength(o) < 0.01) throw new EditRejected(["wall is too short"])
      break
    case "door":
    case "window": {
      const host = hasOwn(draft.objects, o.wallId) ? draft.objects[o.wallId] : undefined
      if (!host || host.type !== "wall") throw new EditRejected(["opening has no host wall"])
      const len = wallLength(host)
      if (o.width > len + 1e-9) throw new EditRejected(["opening is wider than its wall"])
      o.offset = Math.min(Math.max(o.offset, o.width / 2), len - o.width / 2)
      if (!openingFits(len, o.offset, o.width)) throw new EditRejected(["opening does not fit its wall"])
      o.levelId = host.levelId
      break
    }
    case "connector": {
      const r = o.rect
      const snap = (v: number) => Math.round(v / s) * s
      o.rect = o.style === "ladder" ? { x: snap(r.x), z: snap(r.z), w: s, d: s } : { x: snap(r.x), z: snap(r.z), w: Math.max(s, snap(r.w)), d: Math.max(s, snap(r.d)) }
      const from = draft.levels[o.levelId]
      const to = hasOwn(draft.levels, o.toLevelId) ? draft.levels[o.toLevelId] : undefined
      if (!to || to.elevation <= from.elevation) throw new EditRejected(["connector must lead to a higher level"])
      break
    }
    case "light":
      if (o.dimRadius < o.brightRadius) o.dimRadius = o.brightRadius
      if (o.attachedTokenId) {
        if (!hasOwn(draft.tokens, o.attachedTokenId)) throw new EditRejected([`token "${o.attachedTokenId}" does not exist`])
        o.levelId = draft.tokens[o.attachedTokenId].levelId
      }
      break
    default:
      break
  }
}

const OBJECT_LABELS: Record<SceneObject["type"], string> = {
  floor: "floor",
  wall: "wall",
  door: "door",
  window: "window",
  connector: "connector",
  pillar: "pillar",
  prop: "prop",
  light: "light",
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`

/**
 * The terrain selection against `scene`: shapes that no longer exist are dropped, elements are limited to
 * the remaining shapes, and an empty selection becomes null. Returns `sel` itself when nothing changed.
 */
export function normalizeTerrainSelection(scene: Scene, sel: TerrainSelection | null): TerrainSelection | null {
  if (!sel) return null
  const shapes = hasOwn(scene.levels, sel.levelId) ? scene.levels[sel.levelId].terrainEdits?.shapes : undefined
  if (!shapes) return null
  const shapeIds = sel.shapeIds.filter((id, k) => hasOwn(shapes, id) && sel.shapeIds.indexOf(id) === k)
  if (shapeIds.length === 0) return null
  const elements = sel.elements.filter((e) => shapeIds.includes(e.shapeId))
  if (shapeIds.length === sel.shapeIds.length && elements.length === sel.elements.length) return sel
  return { levelId: sel.levelId, shapeIds, elements }
}

/**
 * State update that sets the terrain selection to `next`: when a selection becomes empty, the advanced
 * (element editing) mode switches off too.
 */
function terrainSelectionUpdate(
  s: Pick<EditorState, "terrainSelection" | "toolSettings">,
  next: TerrainSelection | null
): Pick<EditorState, "terrainSelection"> & Partial<Pick<EditorState, "toolSettings">> {
  if (next === null && s.terrainSelection !== null && s.toolSettings.terrain.advanced) {
    return { terrainSelection: null, toolSettings: { ...s.toolSettings, terrain: { ...s.toolSettings.terrain, advanced: false } } }
  }
  return { terrainSelection: next }
}

/**
 * Write new terrain fields (a core/scene/terrainShapes level operation's result for `prev`, the level
 * the draft started from) into the draft level, assigning only what changed: heightmap chunks, shapes
 * and base chunks key by key while the resolution is unchanged (small, per-chunk undo patches), whole
 * records otherwise.
 */
function assignTerrain(draft: Draft<Level>, prev: Level, next: TerrainResult): void {
  const ph = prev.heightmap
  const nh = next.heightmap
  if (nh !== ph) {
    if (!ph || !nh || !draft.heightmap || ph.resolution !== nh.resolution) draft.heightmap = nh
    else assignRecord(draft.heightmap.chunks, ph.chunks, nh.chunks)
  }
  const pt = prev.terrainEdits
  const nt = next.terrainEdits
  if (nt === pt) return
  if (!nt) delete draft.terrainEdits
  else if (!pt || !draft.terrainEdits) draft.terrainEdits = nt
  else {
    assignRecord(draft.terrainEdits.shapes, pt.shapes, nt.shapes)
    assignRecord(draft.terrainEdits.baseChunks, pt.baseChunks, nt.baseChunks)
  }
}

/** Make `draft` (a draft of `prev`) equal to `next`, touching only keys whose value (identity) changed. */
function assignRecord<T>(draft: Record<string, T>, prev: Readonly<Record<string, T>>, next: Readonly<Record<string, T>>): void {
  for (const k of Object.keys(prev)) if (!hasOwn(next, k)) delete draft[k]
  for (const k of Object.keys(next)) if (!hasOwn(prev, k) || prev[k] !== next[k]) draft[k] = next[k]
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function createEditorStore(opts: CreateEditorStoreOptions = {}): EditorStore {
  // Replaced (not cleared) by detachDocument, which keeps the old instance in its stash.
  let history = createHistory(opts.history)
  const systemClipboard = opts.systemClipboard === undefined ? browserClipboard() : opts.systemClipboard
  let patchSink: PatchSink | null = null
  let playSink: PlaySink | null = null
  let savedHead = history.state().head
  /** The open transaction has applied at least one change (for the dirty flag). */
  let txnChanged = false

  const initialScene = opts.scene ?? createScene()

  return createStore<EditorState>()((set, get) => {
    const isDirty = () => history.state().head !== savedHead || (history.inTransaction && txnChanged)

    /** The terrain selection after the document became `next`: missing shapes dropped; cleared when the active level changed. */
    const adoptedTerrainSelection = (s: EditorState, next: Scene, activeLevelId: Id) =>
      terrainSelectionUpdate(s, activeLevelId === s.activeLevelId ? normalizeTerrainSelection(next, s.terrainSelection) : null)

    /** Publish a new document revision produced by `patches`, and forward the patches to a live host. */
    const commitDoc = (next: Scene, patches: Patch[], label: string, source: PatchSource) => {
      const s = get()
      const selection = s.selection.filter((id) => itemExists(next, id))
      const activeLevelId = resolveActiveLevel(next, s.activeLevelId, s.scene)
      set({
        scene: next,
        revision: s.revision + 1,
        lastChange: sceneChangeFromPatches(patches),
        lastRejected: null,
        selection: sameIds(selection, s.selection) ? s.selection : selection,
        ...adoptedTerrainSelection(s, next, activeLevelId),
        activeLevelId,
        history: history.state(),
        dirty: isDirty(),
      })
      patchSink?.(patches, { label, source })
    }

    /**
     * Produce, validate and commit an edit. `rejected` is true when validateEdit refused the result
     * (the document is left unchanged and `lastRejected` explains why).
     */
    const applyChecked = (recipe: SceneRecipe, label: string, applyOpts: ApplyOptions = {}): { patches: Patch[]; rejected: boolean } => {
      const s = get()
      if (s.readOnly) return { patches: [], rejected: false }
      const [next, patches, inversePatches] = produceWithPatches(s.scene, (draft) => {
        recipe(draft)
      })
      if (patches.length === 0) return { patches: [], rejected: false }
      // Never commit a revision that parseScene would refuse: it could be saved but not reopened.
      const issues = validateEdit(next, patches)
      if (issues.length > 0) {
        set({ lastRejected: { label, issues } })
        return { patches: [], rejected: true }
      }
      if (history.inTransaction) txnChanged = true
      history.push({ label, patches, inversePatches }, { coalesceKey: applyOpts.coalesceKey })
      commitDoc(next, patches, label, "apply")
      return { patches, rejected: false }
    }

    const apply: EditorState["apply"] = (recipe, label, applyOpts = {}) => applyChecked(recipe, label, applyOpts).patches

    /** apply() that reports refusals (EditRejected from the recipe, or validateEdit) as `false`. */
    const tryApply = (recipe: SceneRecipe, label: string, applyOpts?: ApplyOptions): boolean => {
      try {
        return !applyChecked(recipe, label, applyOpts).rejected
      } catch (err) {
        if (err instanceof EditRejected) {
          set({ lastRejected: { label, issues: err.issues } })
          return false
        }
        throw err
      }
    }

    const writeSystemClipboard = (clip: AtlasClipboard) => {
      if (!systemClipboard) return
      systemClipboard.writeText(serializeClipboard(clip)).catch(() => {
        // Permission denied / document not focused: the in-memory clipboard still works.
      })
    }

    const defaultPasteAt = (clip: AtlasClipboard): Vec2 => {
      const s = get()
      const c = s.scene.grid.cellSize
      return s.activeLevelId === clip.sourceLevelId ? { x: clip.origin.x + c, z: clip.origin.z + c } : { ...clip.origin }
    }

    /** The origin's landing point: the (snapped) pointer when given, else the default offset. */
    const pasteAt = (clip: AtlasClipboard, o: Pick<PasteOptions, "at" | "snap">): Vec2 => {
      if (!o.at) return defaultPasteAt(clip)
      return o.snap ? snapPasteAt(get().scene, clip, o.at, o.snap) : o.at
    }

    /** Emit move-token commands for tokens in a plan (live) and drop them from the document edit. */
    const routeTokenMoves = (plan: MovePlan, positionOf: (t: Token) => Vec2): MovePlan => {
      if (!playSink || plan.tokens.length === 0) return plan
      for (const t of plan.tokens) {
        const p = positionOf(t)
        playSink({ t: "move-token", tokenId: t.id, levelId: t.levelId, x: p.x, z: p.z })
      }
      return { ...plan, tokens: [] }
    }

    const setLight = (id: Id, on: boolean | "toggle") => {
      const s = get()
      const o = hasOwn(s.scene.objects, id) ? s.scene.objects[id] : undefined
      if (!o || o.type !== "light") return
      const next = on === "toggle" ? !o.on : on
      if (next === o.on) return
      if (playSink) {
        playSink({ t: "set-light", lightId: id, on: next })
        return
      }
      apply((d) => {
        const light = d.objects[id]
        if (light.type === "light") light.on = next
      }, next ? "Turn light on" : "Turn light off")
    }

    return {
      scene: initialScene,
      readOnly: false,
      revision: 0,
      lastChange: null,
      dirty: false,
      lastRejected: null,
      history: history.state(),
      live: false,
      playActions: false,

      selection: [],
      terrainSelection: null,
      activeLevelId: defaultActiveLevel(initialScene),
      tool: "select",
      toolSettings: defaultToolSettings(),
      snapMode: DEFAULT_SNAP_MODE,
      altHeld: false,
      view: defaultViewOptions(),
      clipboard: null,

      // ---- document plumbing ------------------------------------------------

      apply,

      beginTransaction(label) {
        const wasOpen = history.inTransaction
        const id = history.begin(label, get().scene)
        if (!wasOpen) txnChanged = false
        set({ history: history.state() })
        return id
      },

      commitTransaction() {
        if (!history.inTransaction) return
        history.commit()
        if (!history.inTransaction) txnChanged = false
        set({ history: history.state(), dirty: isDirty() })
      },

      cancelTransaction() {
        if (!history.inTransaction) return
        const label = history.state().transaction?.label ?? "Cancel"
        const inverse = history.cancel()
        txnChanged = false
        if (inverse.length === 0) {
          set({ history: history.state(), dirty: isDirty() })
          return
        }
        let next: Scene
        try {
          next = applyPatches(get().scene, inverse)
        } catch {
          // The document was replaced underneath the gesture (live host sync): nothing to revert onto.
          set({ history: history.state(), dirty: isDirty() })
          return
        }
        commitDoc(next, inverse, label, "cancel")
      },

      undo() {
        if (history.inTransaction) {
          get().cancelTransaction()
          return true
        }
        const step = history.undo()
        if (!step) return false
        let next: Scene
        try {
          next = applyPatches(get().scene, step.patches)
        } catch {
          // The document changed underneath (live host edits): this step can no longer be undone.
          history.discard("redo")
          set({ history: history.state() })
          return false
        }
        commitDoc(next, step.patches, step.label, "undo")
        return true
      },

      redo() {
        if (history.inTransaction) return false
        const step = history.redo()
        if (!step) return false
        let next: Scene
        try {
          next = applyPatches(get().scene, step.patches)
        } catch {
          history.discard("undo")
          set({ history: history.state() })
          return false
        }
        commitDoc(next, step.patches, step.label, "redo")
        return true
      },

      loadScene(scene, loadOpts = {}) {
        history.clear()
        savedHead = history.state().head
        txnChanged = false
        const s = get()
        set({
          scene,
          readOnly: loadOpts.readOnly ?? false,
          revision: s.revision + 1,
          lastChange: null,
          dirty: false,
          history: history.state(),
          selection: [],
          ...terrainSelectionUpdate(s, null),
          activeLevelId: defaultActiveLevel(scene),
          view: { ...s.view, levelVisibility: {} },
        })
      },

      detachDocument() {
        if (history.inTransaction) get().cancelTransaction()
        const cur = get()
        const state: StashState = { history, savedHead, selection: cur.selection, activeLevelId: cur.activeLevelId }
        history = createHistory(opts.history)
        savedHead = history.state().head
        txnChanged = false
        set({ history: history.state(), dirty: false })
        return { scene: cur.scene, _state: state }
      },

      restoreDocument(stash) {
        const st = stash._state as StashState
        history = st.history
        savedHead = st.savedHead
        txnChanged = false
        const s = get()
        const scene = stash.scene
        set({
          scene,
          readOnly: false,
          revision: s.revision + 1,
          lastChange: null,
          history: history.state(),
          dirty: isDirty(),
          selection: st.selection.filter((id) => itemExists(scene, id)),
          ...terrainSelectionUpdate(s, null),
          activeLevelId: Object.hasOwn(scene.levels, st.activeLevelId) ? st.activeLevelId : defaultActiveLevel(scene),
          view: { ...s.view, levelVisibility: {} },
        })
      },

      newScene(sceneOpts) {
        get().loadScene(createScene(sceneOpts))
      },

      syncScene(scene) {
        const s = get()
        if (scene === s.scene) return
        const selection = s.selection.filter((id) => itemExists(scene, id))
        const activeLevelId = resolveActiveLevel(scene, s.activeLevelId, s.scene)
        set({
          scene,
          revision: s.revision + 1,
          lastChange: null,
          selection: sameIds(selection, s.selection) ? s.selection : selection,
          // Live hosts re-sync on every player step: drop missing shapes only, never the whole selection.
          ...adoptedTerrainSelection(s, scene, activeLevelId),
          activeLevelId,
        })
      },

      markSaved() {
        savedHead = history.state().head
        set({ dirty: isDirty() })
      },

      setPatchSink(sink) {
        patchSink = sink
        set({ live: sink !== null })
      },

      setPlaySink(sink) {
        playSink = sink
        set({ playActions: sink !== null })
      },

      // ---- levels -------------------------------------------------------------

      addLevel(partial = {}, levelOpts = {}) {
        const s = get()
        const levels = sortedLevels(s.scene)
        if (levels.length >= SCENE_LIMITS.maxLevels) return null
        const top = levels[levels.length - 1]
        const level = createLevel({
          name: `Level ${levels.length + 1}`,
          elevation: top ? top.elevation + top.height : 0,
          ...partial,
        })
        apply((d) => {
          d.levels[level.id] = level
        }, "Add level")
        if (levelOpts.activate !== false && hasOwn(get().scene.levels, level.id)) {
          set({ activeLevelId: level.id, selection: [], ...terrainSelectionUpdate(get(), null) })
        }
        return level.id
      },

      updateLevel(id, partial) {
        if (!hasOwn(get().scene.levels, id)) return false
        const rest: LevelUpdate & { id?: unknown; heightmap?: unknown; terrainEdits?: unknown } = { ...partial }
        delete rest.id
        // Terrain has its own actions (writeTerrain keeps heightmap and terrainEdits consistent).
        delete rest.heightmap
        delete rest.terrainEdits
        return tryApply(
          (d) => {
            Object.assign(d.levels[id], rest)
            repairConnectors(d)
          },
          "Edit level",
          { coalesceKey: `level:${id}:${Object.keys(rest).sort().join(",")}` }
        )
      },

      removeLevel(id) {
        const s = get()
        if (!hasOwn(s.scene.levels, id) || Object.keys(s.scene.levels).length <= 1) return false
        apply((d) => deleteWithDependents(d, [id]), `Delete level "${s.scene.levels[id].name}"`)
        return true
      },

      applyTerrainEdit(levelId, edit, label, applyOpts) {
        if (!hasOwn(get().scene.levels, levelId)) return false
        let ok = true
        const patches = apply(
          (d) => {
            if (!hasOwn(d.levels, levelId)) return
            ok = writeTerrain(d.levels[levelId], d.grid, edit)
          },
          label,
          applyOpts
        )
        return ok && patches.length > 0
      },

      enableTerrain(levelId, resolution = DEFAULT_TERRAIN_RESOLUTION) {
        const s = get()
        if (!hasOwn(s.scene.levels, levelId) || s.scene.levels[levelId].heightmap) return false
        return (
          apply((d) => {
            d.levels[levelId].heightmap = createHeightmap(resolution)
          }, "Enable terrain").length > 0
        )
      },

      clearTerrain(levelId) {
        const s = get()
        if (!hasOwn(s.scene.levels, levelId)) return false
        const level = s.scene.levels[levelId]
        if (!level.heightmap && !level.terrainEdits) return false
        return (
          apply((d) => {
            const l = d.levels[levelId]
            l.heightmap = null
            delete l.terrainEdits
          }, "Clear terrain").length > 0
        )
      },

      flattenTerrain(levelId) {
        const s = get()
        if (!hasOwn(s.scene.levels, levelId)) return false
        const level = s.scene.levels[levelId]
        const hm = level.heightmap
        if (!hm || !hasPaintedBase(level)) return false
        // A zero base over the whole extent: shapes stay and are rebaked on the flat ground.
        const grid = s.scene.grid
        const { samplesX, samplesZ } = sampleCounts(grid, hm.resolution)
        const lattice = { samplesX, samplesZ, heights: new Float32Array(samplesX * samplesZ), spacing: sampleSpacing(grid.cellSize, hm.resolution) }
        const extent = { x: 0, z: 0, w: grid.width * grid.cellSize, d: grid.depth * grid.cellSize }
        return get().applyTerrainEdit(levelId, { base: { lattice, rects: [extent] } }, "Flatten terrain")
      },

      clearTerrainShapes(levelId) {
        const s = get()
        const shapes = hasOwn(s.scene.levels, levelId) ? s.scene.levels[levelId].terrainEdits?.shapes : undefined
        if (!shapes) return false
        return get().applyTerrainEdit(levelId, { remove: Object.keys(shapes) }, "Delete terrain shapes")
      },

      setTerrainResolution(levelId, resolution) {
        const s = get()
        if (!hasOwn(s.scene.levels, levelId)) return false
        const level = s.scene.levels[levelId]
        if (level.heightmap?.resolution === resolution) return false
        if (!terrainResolutionFits(s.scene.grid, resolution)) return false
        const next = resampleTerrain(level, s.scene.grid, resolution)
        return tryApply((d) => assignTerrain(d.levels[levelId], level, next), "Change terrain resolution") && get().scene !== s.scene
      },

      applyTerrainShapes(levelId, shapeIds) {
        const s = get()
        if (!hasOwn(s.scene.levels, levelId)) return false
        const edit = applyShapesEdit(s.scene.levels[levelId], s.scene.grid, shapeIds)
        if (!edit) return false
        const n = edit.remove?.length ?? 0
        return get().applyTerrainEdit(levelId, edit, n === 1 ? "Apply shape to terrain" : `Apply ${plural(n, "shape")} to terrain`)
      },

      setActiveLevel(id) {
        const s = get()
        if (hasOwn(s.scene.levels, id) && s.activeLevelId !== id) set({ activeLevelId: id, ...terrainSelectionUpdate(s, null) })
      },

      stepActiveLevel(delta) {
        const s = get()
        const levels = sortedLevels(s.scene)
        const k = levels.findIndex((l) => l.id === s.activeLevelId)
        const next = levels[Math.min(levels.length - 1, Math.max(0, (k < 0 ? 0 : k) + Math.sign(delta)))]
        if (next) get().setActiveLevel(next.id)
      },

      // ---- objects / tokens ---------------------------------------------------

      addObject(object, label) {
        apply((d) => {
          d.objects[object.id] = object
        }, label ?? `Add ${OBJECT_LABELS[object.type]}`)
        return object.id
      },

      addToken(token, label) {
        apply((d) => {
          d.tokens[token.id] = token
        }, label ?? "Add token")
        return token.id
      },

      updateObject(id, partial, applyOpts) {
        const s = get()
        if (!hasOwn(s.scene.objects, id)) return false
        const rest: Record<string, unknown> = { ...partial }
        delete rest.id
        delete rest.type
        const type = s.scene.objects[id].type
        const original = s.scene.objects[id]
        return tryApply(
          (d) => {
            const target = d.objects[id]
            const before = target.type === "wall" ? { a: { ...target.a }, b: { ...target.b } } : null
            Object.assign(target, rest)
            if (original.type === "light" && target.type === "light" && rest.position === undefined) {
              if (original.attachedTokenId && !target.attachedTokenId) {
                // Detached: keep the light where it was in the world (its position was an offset).
                const levelId = lightLevelId(s.scene, original)
                const world = lightWorldPosition(s.scene, original)
                target.levelId = levelId
                target.position = { x: world.x, y: world.y - groundHeightAt(d, levelId, world), z: world.z }
              } else if (!original.attachedTokenId && target.attachedTokenId) {
                // Attached: carried at the token's centre at the same height.
                target.position = { x: 0, y: original.position.y, z: 0 }
              }
            }
            normalizeObject(d, target)
            // Openings keep their distance from the endpoint that stayed put and follow the wall's level.
            if (target.type === "wall" && before) reprojectOpenings(d, id, before)
          },
          `Edit ${OBJECT_LABELS[type]}`,
          applyOpts ?? { coalesceKey: `object:${id}:${Object.keys(rest).sort().join(",")}` }
        )
      },

      updateToken(id, partial, applyOpts) {
        const s = get()
        if (!hasOwn(s.scene.tokens, id)) return false
        const rest: TokenUpdate & { id?: unknown } = { ...partial }
        delete rest.id
        if (rest.levelId !== undefined && !hasOwn(s.scene.levels, rest.levelId)) return false
        return tryApply(
          (d) => {
            const t = d.tokens[id]
            Object.assign(t, rest)
            // `model: undefined` means the default body: drop the key instead of storing undefined.
            if (Object.hasOwn(rest, "model") && rest.model === undefined) delete t.model
            // Attached lights keep their stored level aligned with their carrier's.
            for (const o of Object.values(d.objects)) {
              if (o.type === "light" && o.attachedTokenId === id && o.levelId !== t.levelId) o.levelId = t.levelId
            }
          },
          "Edit token",
          applyOpts ?? { coalesceKey: `token:${id}:${Object.keys(rest).sort().join(",")}` }
        )
      },

      deleteIds(ids, label) {
        const s = get()
        // Objects and tokens only: levels go through removeLevel (which keeps at least one).
        const present = ids.filter((id) => itemExists(s.scene, id))
        if (present.length === 0) return
        apply((d) => deleteWithDependents(d, present), label ?? `Delete ${plural(present.length, "item")}`)
      },

      setDoorState(id, state) {
        const s = get()
        const o = hasOwn(s.scene.objects, id) ? s.scene.objects[id] : undefined
        if (!o || o.type !== "door" || o.state === state) return
        if (playSink) {
          playSink({ t: "set-door", doorId: id, state })
          return
        }
        const verb = state === "open" ? "Open" : state === "closed" ? "Close" : "Lock"
        apply((d) => {
          const door = d.objects[id]
          if (door.type === "door") door.state = state
        }, `${verb} door`)
      },

      toggleLight(id) {
        setLight(id, "toggle")
      },

      setLightOn(id, on) {
        setLight(id, on)
      },

      updateEnvironment(partial, applyOpts) {
        const { directional, ...rest } = partial
        apply(
          (d) => {
            Object.assign(d.environment, rest)
            if (directional) Object.assign(d.environment.directional, directional)
            const dir = d.environment.directional
            dir.elevation = Math.min(Math.PI / 2, Math.max(0.1, dir.elevation))
          },
          "Edit environment",
          applyOpts ?? { coalesceKey: `env:${Object.keys(rest).sort().join(",")}:${Object.keys(directional ?? {}).sort().join(",")}` }
        )
      },

      updateGrid(partial) {
        const s = get()
        // Fine terrain resolutions support smaller grids only (core/scene/heightmap MAX_TERRAIN_SAMPLES_PER_SIDE).
        const finest = finestTerrainResolution(s.scene.levels)
        const maxCells = Math.min(SCENE_LIMITS.maxGridCells, finest === null ? Infinity : maxCellsForResolution(finest))
        const clampCells = (v: number) => Math.min(maxCells, Math.max(1, Math.round(v)))
        const prevGrid = s.scene.grid
        apply((d) => {
          if (partial.width !== undefined) d.grid.width = clampCells(partial.width)
          if (partial.depth !== undefined) d.grid.depth = clampCells(partial.depth)
          if (partial.diagonalRule !== undefined) d.grid.diagonalRule = partial.diagonalRule
          if (d.grid.width === prevGrid.width && d.grid.depth === prevGrid.depth) return
          // Terrain follows the new lattice: the painted base is cropped (samples beyond it dropped, so old
          // heights can't come back if the grid grows again) and the shapes rebaked (a grown grid shows the
          // parts of shapes it re-exposes). Shapes beyond the new extent make validateEdit refuse the edit.
          const grid = { width: d.grid.width, depth: d.grid.depth, cellSize: d.grid.cellSize }
          for (const id of Object.keys(s.scene.levels)) {
            const level = s.scene.levels[id]
            if (level.heightmap) assignTerrain(d.levels[id], level, cropTerrainToGrid(level, grid, prevGrid))
          }
        }, "Edit grid")
      },

      updateSceneInfo(partial) {
        apply(
          (d) => {
            if (partial.name !== undefined) d.name = partial.name
            if (partial.meta) Object.assign(d.meta, partial.meta)
          },
          "Edit scene info",
          { coalesceKey: `info:${partial.name !== undefined ? "name" : ""}:${Object.keys(partial.meta ?? {}).sort().join(",")}` }
        )
      },

      // ---- selection ----------------------------------------------------------

      select(ids, mode = "replace") {
        const s = get()
        const valid = ids.filter((id) => itemExists(s.scene, id))
        let next: Id[]
        switch (mode) {
          case "replace":
            next = [...new Set(valid)]
            break
          case "add":
            next = [...new Set([...s.selection, ...valid])]
            break
          case "remove": {
            const drop = new Set(valid)
            next = s.selection.filter((id) => !drop.has(id))
            break
          }
          case "toggle": {
            const out = new Set(s.selection)
            for (const id of new Set(valid)) {
              if (out.has(id)) out.delete(id)
              else out.add(id)
            }
            next = [...out]
            break
          }
        }
        if (!sameIds(next, s.selection)) set({ selection: next })
      },

      toggleSelected(id) {
        get().select([id], "toggle")
      },

      setTerrainSelection(selection) {
        const s = get()
        const next = normalizeTerrainSelection(s.scene, selection)
        const cur = s.terrainSelection
        if (next === cur) return
        if (next && cur && next.levelId === cur.levelId && sameIds(next.shapeIds, cur.shapeIds) && sameElements(next.elements, cur.elements)) return
        set(terrainSelectionUpdate(s, next))
      },

      clearSelection() {
        if (get().selection.length > 0) set({ selection: [] })
      },

      selectAll() {
        const s = get()
        const ids: Id[] = []
        for (const o of Object.values(s.scene.objects)) {
          if (!o.editorLocked && itemLevelId(s.scene, o.id) === s.activeLevelId) ids.push(o.id)
        }
        for (const t of Object.values(s.scene.tokens)) if (t.levelId === s.activeLevelId) ids.push(t.id)
        ids.sort()
        if (!sameIds(ids, s.selection)) set({ selection: ids })
      },

      deleteSelection() {
        const ids = get().selection
        if (ids.length === 0) return 0
        get().deleteIds(ids)
        if (get().selection.length > 0) set({ selection: [] })
        return ids.length
      },

      duplicateSelection() {
        const s = get()
        if (s.selection.length === 0) return []
        const clip = copyItems(s.scene, s.selection)
        const c = s.scene.grid.cellSize
        let ids: Id[] = []
        const patches = apply((d) => {
          ids = pasteClipboard(d, clip, { targetLevelId: clip.sourceLevelId, at: { x: clip.origin.x + c, z: clip.origin.z + c } })
        }, `Duplicate ${plural(s.selection.length, "item")}`)
        // A refused edit (validateEdit) created nothing.
        if (patches.length === 0) return []
        if (ids.length > 0) set({ selection: ids })
        return ids
      },

      copySelection() {
        const s = get()
        if (s.selection.length === 0) return null
        const clip = copyItems(s.scene, s.selection)
        set({ clipboard: clip })
        writeSystemClipboard(clip)
        return clip
      },

      cutSelection() {
        const clip = get().copySelection()
        if (!clip) return null
        get().deleteIds([...get().selection], `Cut ${plural(get().selection.length, "item")}`)
        set({ selection: [] })
        return clip
      },

      paste(pasteOpts = {}) {
        const s = get()
        const clip = pasteOpts.clipboard ?? s.clipboard
        if (!clip || !hasOwn(s.scene.levels, s.activeLevelId)) return []
        const at = pasteAt(clip, pasteOpts)
        let ids: Id[] = []
        const patches = apply((d) => {
          ids = pasteClipboard(d, clip, { targetLevelId: s.activeLevelId, at, hostWallId: pasteOpts.hostWallId })
        }, "Paste")
        if (patches.length === 0) return []
        if (ids.length > 0) set({ selection: ids })
        return ids
      },

      pasteText(text, pasteOpts = {}) {
        const clip = parseClipboardText(text)
        if (!clip) return { ok: false, issues: ["the clipboard does not contain Atlas objects"] }
        const s = get()
        const at = pasteAt(clip, pasteOpts)
        let ids: Id[] = []
        let patches: Patch[]
        try {
          patches = apply((d) => {
            ids = pasteClipboard(d, clip, { targetLevelId: s.activeLevelId, at, hostWallId: pasteOpts.hostWallId })
            const issues = validatePastedItems(current(d), ids)
            if (issues.length > 0) throw new EditRejected(issues)
          }, "Paste")
        } catch (err) {
          if (err instanceof EditRejected) return { ok: false, issues: err.issues }
          // Structurally broken items can make pasteClipboard itself throw.
          return { ok: false, issues: [err instanceof Error ? err.message : String(err)] }
        }
        // Valid items can still be refused as a whole (e.g. too many objects for one scene).
        if (patches.length === 0 && ids.length > 0) return { ok: false, issues: get().lastRejected?.issues ?? ["the paste was refused"] }
        if (ids.length > 0) set({ selection: ids, clipboard: clip })
        return { ok: true, ids }
      },

      async pasteFromSystem(pasteOpts = {}) {
        if (systemClipboard) {
          try {
            const text = await systemClipboard.readText()
            const result = get().pasteText(text, pasteOpts)
            if (result.ok || !get().clipboard) return result
          } catch {
            // Permission denied: fall back to the in-memory clipboard.
          }
        }
        if (!get().clipboard) return { ok: false, issues: ["the clipboard is empty"] }
        return { ok: true, ids: get().paste(pasteOpts) }
      },

      nudgeSelection(dx, dz) {
        const s = get()
        if (s.selection.length === 0) return
        const plan = planMove(s.scene, s.selection)
        const d = alignDelta(plan, s.scene.grid.cellSize, dx, dz)
        if (d.x === 0 && d.z === 0) return
        const docPlan = routeTokenMoves(plan, (t) => ({ x: t.position.x + d.x, z: t.position.z + d.z }))
        if (docPlan.objects.length + docPlan.tokens.length === 0) return
        apply((draft) => applyMove(draft, docPlan, d.x, d.z), "Nudge", { coalesceKey: `nudge:${s.selection.join(",")}` })
      },

      rotateSelection(quarterTurns = 1) {
        const s = get()
        if (s.selection.length === 0 || Math.round(quarterTurns) % 4 === 0) return
        const plan = planMove(s.scene, s.selection)
        const pivot = rotationPivot(s.scene, plan, effectiveSnapMode(s.snapMode, s.altHeld))
        if (!pivot) return
        const docPlan = routeTokenMoves(plan, (t) => rotateQuarter(t.position, pivot, quarterTurns))
        apply((d) => applyRotation(d, docPlan, pivot, quarterTurns), "Rotate")
      },

      moveTokens(moves, label) {
        const s = get()
        const valid = moves.filter((m) => hasOwn(s.scene.tokens, m.id) && (m.levelId === undefined || hasOwn(s.scene.levels, m.levelId)))
        if (valid.length === 0) return
        if (playSink) {
          for (const m of valid) {
            playSink({ t: "move-token", tokenId: m.id, levelId: m.levelId ?? s.scene.tokens[m.id].levelId, x: m.position.x, z: m.position.z })
          }
          return
        }
        apply((d) => {
          for (const m of valid) {
            const t = d.tokens[m.id]
            t.position = { x: m.position.x, z: m.position.z }
            if (m.levelId !== undefined && m.levelId !== t.levelId) {
              t.levelId = m.levelId
              for (const o of Object.values(d.objects)) {
                if (o.type === "light" && o.attachedTokenId === m.id) o.levelId = m.levelId
              }
            }
          }
        }, label ?? `Move ${plural(valid.length, "token")}`)
      },

      // ---- tools, snapping, view ----------------------------------------------

      setTool(tool) {
        const s = get()
        if (s.tool === tool) return
        set(s.tool === "terrain" ? { tool, ...terrainSelectionUpdate(s, null) } : { tool })
      },

      setToolSettings(tool, partial) {
        const s = get()
        set({ toolSettings: { ...s.toolSettings, [tool]: { ...s.toolSettings[tool], ...partial } } })
      },

      scaleBrushRadius(factor) {
        const s = get()
        const r = Math.round(s.toolSettings.brush.radius * factor * 2) / 2
        get().setToolSettings("brush", { radius: Math.min(BRUSH_RADIUS_MAX, Math.max(BRUSH_RADIUS_MIN, r)) })
      },

      setSnapMode(mode) {
        set({ snapMode: mode })
      },

      setAltHeld(held) {
        if (get().altHeld !== held) set({ altHeld: held })
      },

      setView(partial) {
        set({ view: { ...get().view, ...partial } })
      },

      toggleGrid() {
        get().setView({ showGrid: !get().view.showGrid })
      },

      toggleHelpers() {
        get().setView({ showHelpers: !get().view.showHelpers })
      },

      toggleDarkVision() {
        get().setView({ darkVision: !get().view.darkVision })
      },

      toggleGhostAdjacent() {
        get().setView({ ghostAdjacent: !get().view.ghostAdjacent })
      },

      setLevelVisibility(id, visible) {
        const v = get().view
        set({ view: { ...v, levelVisibility: { ...v.levelVisibility, [id]: visible } } })
      },

      toggleLevelVisibility(id) {
        const v = get().view
        get().setLevelVisibility(id, v.levelVisibility[id] === false)
      },
    }
  })
}

/** Editor view options as an engine ViewState patch (render mode "editor", no fog). */
export function editorViewState(state: Pick<EditorState, "view" | "activeLevelId">): Partial<ViewState> {
  return {
    mode: "editor",
    camera: state.view.camera,
    activeLevelId: state.activeLevelId,
    levelVisibility: state.view.levelVisibility,
    ghostAdjacent: state.view.ghostAdjacent,
    showGrid: state.view.showGrid,
    showHelpers: state.view.showHelpers,
    darkVision: state.view.darkVision,
    cutaway: false,
    vision: "off",
  }
}

/** Snap mode currently in effect (Alt held → free). */
export function currentSnapMode(state: Pick<EditorState, "snapMode" | "altHeld">, alt = false): SnapMode {
  return effectiveSnapMode(state.snapMode, alt || state.altHeld)
}
