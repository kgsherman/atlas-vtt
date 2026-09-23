/**
 * Editor commands for battlemap images (ARCHITECTURE §9), used by the import dialog:
 *  - addBackdrop / updateBackdrop / removeBackdrop: Scene.assets metadata + Level.backdrop, one undo step each;
 *  - floorFromImage: a (masked) floor covering the image's opaque part ("Floor from image");
 *  - wallsFromImage: walls along the image's alpha outline ("Walls from image outline").
 * "New scene from map images" (components/editor/dialogs/MapImportDialog) runs the same commands on a
 * fresh editor store, one level per image.
 *
 * The image bytes live in the AssetStore (net/assets); the document only references them by id. Store
 * the image (AssetStore.putImage) BEFORE adding the backdrop so the id in `assetMeta` exists.
 */
import {
  floorMaskFromAlpha,
  floorObjectFromTrace,
  wallObjectsFromSegments,
  wallsFromAlpha,
  type FloorMaskOptions,
  type TraceImage,
  type WallTraceOptions,
} from "@/core/scene/imageTrace"
import { SCENE_LIMITS } from "@/core/scene/schema"
import type { Id, LevelBackdrop, MaterialId, Rect, Scene, SceneAsset } from "@/core/scene/types"
import type { AssetMeta } from "@/net/assets/types"
import type { ImportedImage } from "@/net/assets/import"

import type { EditorStore } from "./store"

export interface BackdropOptions {
  /** 0..1 (default 1). */
  opacity?: number
  /** Tint wall caps/faces with the image (default false). */
  tintWalls?: boolean
  /** World rect the image covers (default: the imported image's rect). */
  rect?: Rect
}

function sceneAsset(meta: AssetMeta): SceneAsset {
  return { id: meta.id, kind: "image", name: meta.name.slice(0, SCENE_LIMITS.maxString), mime: meta.mime, width: meta.width, height: meta.height, bytes: meta.bytes }
}

/** Asset ids still referenced by some level's backdrop. */
function referencedAssetIds(scene: Pick<Scene, "levels">): Set<Id> {
  const out = new Set<Id>()
  for (const l of Object.values(scene.levels)) if (l.backdrop) out.add(l.backdrop.assetId)
  return out
}

/** Drop asset metadata no backdrop references any more (the bytes stay in the store for undo). */
function pruneAssets(draft: Scene): void {
  if (!draft.assets) return
  const used = referencedAssetIds(draft)
  for (const id of Object.keys(draft.assets)) if (!used.has(id)) delete draft.assets[id]
  if (Object.keys(draft.assets).length === 0) delete draft.assets
}

/**
 * Set a level's map image: adds the asset metadata and the backdrop in ONE undo step (replacing an
 * existing backdrop; its metadata is dropped when nothing else uses it). false when refused (unknown
 * level, read-only document, or a placement the scene schema rejects — see store.lastRejected).
 */
export function addBackdrop(
  store: EditorStore,
  levelId: Id,
  imported: Pick<ImportedImage, "rect">,
  assetMeta: AssetMeta,
  opts: BackdropOptions = {}
): boolean {
  const s = store.getState()
  if (!Object.hasOwn(s.scene.levels, levelId)) return false
  const r = opts.rect ?? imported.rect
  const backdrop: LevelBackdrop = {
    assetId: assetMeta.id,
    rect: { x: r.x, z: r.z, w: r.w, d: r.d },
    opacity: Math.min(1, Math.max(0, opts.opacity ?? 1)),
    tintWalls: opts.tintWalls ?? false,
  }
  const patches = s.apply((d) => {
    d.assets ??= {}
    d.assets[assetMeta.id] = sceneAsset(assetMeta)
    d.levels[levelId].backdrop = backdrop
    pruneAssets(d)
  }, "Add map image")
  if (patches.length > 0) return true
  // Nothing changed: fine when the level already shows exactly this image (else the edit was refused).
  return JSON.stringify(store.getState().scene.levels[levelId].backdrop) === JSON.stringify(backdrop)
}

/** Edit a level's backdrop placement / blend (slider drags coalesce into one undo step). */
export function updateBackdrop(store: EditorStore, levelId: Id, partial: Partial<Omit<LevelBackdrop, "assetId">>): boolean {
  const s = store.getState()
  const cur = Object.hasOwn(s.scene.levels, levelId) ? s.scene.levels[levelId].backdrop : null
  if (!cur) return false
  const next: LevelBackdrop = {
    assetId: cur.assetId,
    rect: partial.rect ? { x: partial.rect.x, z: partial.rect.z, w: partial.rect.w, d: partial.rect.d } : cur.rect,
    opacity: partial.opacity !== undefined ? Math.min(1, Math.max(0, partial.opacity)) : cur.opacity,
    tintWalls: partial.tintWalls ?? cur.tintWalls,
  }
  const same = next.opacity === cur.opacity && next.tintWalls === cur.tintWalls && (["x", "z", "w", "d"] as const).every((k) => next.rect[k] === cur.rect[k])
  if (same) return true
  const keys = Object.keys(partial).sort().join(",")
  return (
    s.apply(
      (d) => {
        d.levels[levelId].backdrop = next
      },
      "Edit map image",
      { coalesceKey: `backdrop:${levelId}:${keys}` }
    ).length > 0
  )
}

/** Remove a level's map image (its metadata goes too when no other level uses it). */
export function removeBackdrop(store: EditorStore, levelId: Id): boolean {
  const s = store.getState()
  if (!Object.hasOwn(s.scene.levels, levelId) || !s.scene.levels[levelId].backdrop) return false
  return (
    s.apply((d) => {
      d.levels[levelId].backdrop = null
      pruneAssets(d)
    }, "Remove map image").length > 0
  )
}

export interface ImageCalibration {
  /** World rect the image covers (ImportedImage.rect). */
  rect: Rect
}

export interface FloorFromImageOptions extends FloorMaskOptions {
  material?: MaterialId
  /** Delete the level's existing floors first (in the same undo step). */
  replace?: boolean
}

/**
 * Add a floor covering exactly the image's opaque part (a plain rect when the image is fully
 * opaque). Returns the new floor id, or null when nothing is opaque or the edit was refused.
 */
export function floorFromImage(store: EditorStore, levelId: Id, pixels: TraceImage, calib: ImageCalibration, opts: FloorFromImageOptions = {}): Id | null {
  const s = store.getState()
  if (!Object.hasOwn(s.scene.levels, levelId)) return null
  const traced = floorMaskFromAlpha(pixels, { rect: calib.rect, cellSize: s.scene.grid.cellSize }, opts)
  if (!traced) return null
  const floor = floorObjectFromTrace(levelId, traced, { material: opts.material ?? "stone" })
  const patches = s.apply(
    (d) => {
      if (opts.replace) {
        for (const o of Object.values(d.objects)) if (o.type === "floor" && o.levelId === levelId) delete d.objects[o.id]
      }
      d.objects[floor.id] = floor
    },
    "Floor from image"
  )
  return patches.length > 0 ? floor.id : null
}

export interface WallsFromImageOptions extends WallTraceOptions {
  material?: MaterialId
}

/**
 * Add walls along the image's alpha outline (cave walls, building outlines) in one undo step.
 * Height defaults to the level's height, thickness to 1 ft. Returns the new wall ids ([] when the
 * image has no outline or the edit was refused).
 */
export function wallsFromImage(store: EditorStore, levelId: Id, pixels: TraceImage, calib: ImageCalibration, opts: WallsFromImageOptions = {}): Id[] {
  const s = store.getState()
  if (!Object.hasOwn(s.scene.levels, levelId)) return []
  const level = s.scene.levels[levelId]
  const segs = wallsFromAlpha(pixels, { rect: calib.rect, cellSize: s.scene.grid.cellSize }, opts)
  if (segs.length === 0) return []
  const walls = wallObjectsFromSegments(levelId, segs, { height: opts.height ?? level.height, thickness: opts.thickness ?? 1, material: opts.material ?? "stone" })
  if (Object.keys(s.scene.objects).length + walls.length > SCENE_LIMITS.maxObjects) return []
  const patches = s.apply(
    (d) => {
      for (const w of walls) d.objects[w.id] = w
    },
    `Walls from image outline (${walls.length})`
  )
  return patches.length > 0 ? walls.map((w) => w.id) : []
}
