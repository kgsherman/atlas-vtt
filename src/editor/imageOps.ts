/**
 * Editor commands for battlemap images (ARCHITECTURE §9), used by the import dialog:
 *  - addBackdrop / updateBackdrop / removeBackdrop: Scene.assets metadata + Level.backdrop, one undo step each;
 *  - floorFromImage: a (masked) floor covering the image's opaque part ("Floor from image");
 *  - wallsFromImage: walls along the image's alpha outline ("Walls from image outline");
 *  - planSceneFromImages / createSceneFromImages: a new scene with one level per image.
 *
 * The image bytes live in the AssetStore (net/assets); the document only references them by id. Store
 * the image (AssetStore.putImage) BEFORE adding the backdrop so the id in `assetMeta` exists.
 */
import { createFloor, createLevel, createScene, newId } from "@/core/scene/factory"
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
import type { AssetMeta, AssetStore } from "@/net/assets/types"
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

// ---------------------------------------------------------------------------
// New scene from map images
// ---------------------------------------------------------------------------

export interface SceneImage {
  /** Image (file) name, kept as the asset name. */
  name: string
  imported: ImportedImage
  /** Level elevation (feet). */
  elevation: number
  levelName: string
  /** Asset id to use (default: a fresh id). */
  assetId?: Id
}

export interface SceneFromImagesOptions {
  sceneName?: string
  /** Floors covering each image's opaque part (default true; a plain full floor otherwise). */
  traceFloors?: boolean
  /** Walls along the alpha outline of images with transparency (default false). */
  traceWalls?: boolean
  floorMaterial?: MaterialId
  wallMaterial?: MaterialId
  /** Storey height of every level (default 10 ft). */
  levelHeight?: number
}

export interface SceneFromImagesPlan {
  scene: Scene
  /** Images to store under `scene.id` (AssetStore.putImage) with these ids. */
  uploads: Array<{ assetId: Id; blob: Blob; meta: Omit<AssetMeta, "bytes"> }>
}

/** Grid cell size implied by an imported image (rect width / cells across). */
function importedCellSize(img: Pick<ImportedImage, "rect" | "width" | "pxPerCell">): number {
  const cells = img.width / img.pxPerCell
  return Math.round((img.rect.w / cells) * 1e6) / 1e6
}

/**
 * A new scene with one level per image (sorted by elevation): grid sized from the images (cell size
 * from the first image's calibration), each level with its backdrop and a floor covering the image's
 * opaque part (masked for caves / rotated storeys; a plain rect for opaque maps), optionally walls
 * along the outline of images that have transparency.
 */
export function planSceneFromImages(images: SceneImage[], opts: SceneFromImagesOptions = {}): SceneFromImagesPlan {
  if (images.length === 0) throw new Error("createSceneFromImages: no images")
  if (images.length > SCENE_LIMITS.maxLevels) throw new Error(`at most ${SCENE_LIMITS.maxLevels} levels`)
  const cellSize = Math.min(SCENE_LIMITS.maxCellSize, Math.max(SCENE_LIMITS.minCellSize, importedCellSize(images[0].imported)))
  let maxX = 0
  let maxZ = 0
  for (const { imported } of images) {
    maxX = Math.max(maxX, imported.rect.x + imported.rect.w)
    maxZ = Math.max(maxZ, imported.rect.z + imported.rect.d)
  }
  const width = Math.min(SCENE_LIMITS.maxGridCells, Math.max(1, Math.ceil(maxX / cellSize - 1e-6)))
  const depth = Math.min(SCENE_LIMITS.maxGridCells, Math.max(1, Math.ceil(maxZ / cellSize - 1e-6)))
  const scene = createScene({ name: opts.sceneName ?? images[0].levelName, width, depth, groundFloor: false })
  scene.grid.cellSize = cellSize
  scene.levels = {}
  scene.assets = {}
  const levelHeight = opts.levelHeight ?? 10
  const uploads: SceneFromImagesPlan["uploads"] = []
  const sorted = [...images].sort((a, b) => a.elevation - b.elevation)
  for (const img of sorted) {
    const level = createLevel({ name: img.levelName, elevation: img.elevation, height: levelHeight })
    scene.levels[level.id] = level
    const assetId = img.assetId ?? newId()
    const meta: Omit<AssetMeta, "bytes"> = { id: assetId, kind: "image", name: img.name.slice(0, SCENE_LIMITS.maxString), mime: img.imported.mime, width: img.imported.width, height: img.imported.height }
    scene.assets[assetId] = { ...meta, bytes: img.imported.blob.size }
    uploads.push({ assetId, blob: img.imported.blob, meta })
    const r = img.imported.rect
    level.backdrop = { assetId, rect: { x: r.x, z: r.z, w: r.w, d: r.d }, opacity: 1, tintWalls: false }

    const px = img.imported.pixels
    const hasPixels = px.width > 0 && px.height > 0 && px.data.length >= px.width * px.height * 4
    const calib = { rect: r, cellSize }
    const traced = opts.traceFloors !== false && hasPixels ? floorMaskFromAlpha(px, calib) : null
    if (traced) {
      const floor = floorObjectFromTrace(level.id, traced, { material: opts.floorMaterial ?? "stone" })
      scene.objects[floor.id] = floor
    } else if (opts.traceFloors === false || !hasPixels) {
      const floor = createFloor(level.id, { x: r.x, z: r.z, w: r.w, d: r.d }, opts.floorMaterial ?? "stone")
      scene.objects[floor.id] = floor
    }
    // An opaque map's outline is just its border: only images with transparency get outline walls.
    if (opts.traceWalls && hasPixels && traced && traced.fill < 1) {
      const segs = wallsFromAlpha(px, calib)
      for (const w of wallObjectsFromSegments(level.id, segs, { height: levelHeight, thickness: 1, material: opts.wallMaterial ?? "stone" })) scene.objects[w.id] = w
    }
  }
  return { scene, uploads }
}

/** planSceneFromImages(...).scene — store the images under scene.id with the backdrops' asset ids. */
export function createSceneFromImages(images: SceneImage[], opts: SceneFromImagesOptions = {}): Scene {
  return planSceneFromImages(images, opts).scene
}

/** Plan the scene, store every image under its id (AssetStore.putImage), and return the scene. */
export async function createSceneFromImagesStored(assets: Pick<AssetStore, "putImage">, images: SceneImage[], opts: SceneFromImagesOptions = {}): Promise<Scene> {
  const { scene, uploads } = planSceneFromImages(images, opts)
  for (const u of uploads) {
    const stored = await assets.putImage(scene.id, u.blob, u.meta)
    scene.assets![u.assetId] = { ...scene.assets![u.assetId], bytes: stored.bytes }
  }
  return scene
}
