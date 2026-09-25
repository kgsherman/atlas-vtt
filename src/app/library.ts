/**
 * Scene-library operations used by the home and shared pages and the host console (duplicate, samples,
 * import/export, copying a shared scene, loading a scene to play). Each returns user-facing warnings for
 * partial successes (e.g. a map image that could not be copied) and throws LibraryError / NetError on failure.
 */
import { newId } from "@/core/scene/factory"
import { sampleById } from "@/core/scene/samples"
import type { ParseSceneResult } from "@/core/scene/schema"
import type { Scene } from "@/core/scene/types"
import type { SceneOrigin } from "@/core/session/types"
import { exportSceneFile, exportSceneFileWithAssets, importSceneFileWithAssets, type SceneSummary, type SharedScene } from "@/net/scenesRepo"
import { describeNetError, isNetError } from "@/net/supabase"

import type { AppServices } from "./services"

export class LibraryError extends Error {
  readonly details: string[]
  constructor(message: string, details: string[] = []) {
    super(message)
    this.name = "LibraryError"
    this.details = details
  }
}

export interface LibraryResult {
  summary: SceneSummary
  warnings: string[]
}

/** A short, friendly message for any error thrown by the services. */
export function userMessage(err: unknown): string {
  if (err instanceof LibraryError) return err.message
  if (isNetError(err)) return describeNetError(err.code)
  if (err instanceof Error && err.message) return err.message
  return "Something went wrong."
}

/** "Keep (copy)", then "Keep (copy 2)", … avoiding names already in the library. */
export function nextCopyName(name: string, existing: Iterable<string>): string {
  const taken = new Set(existing)
  const base = name.replace(/\s+\(copy(?: \d+)?\)$/u, "")
  let candidate = `${base} (copy)`
  for (let n = 2; taken.has(candidate); n++) candidate = `${base} (copy ${n})`
  return candidate
}

function requireScene(parsed: ParseSceneResult, action: string): Scene {
  if (parsed.ok) return parsed.scene
  if (parsed.error === "too-new") {
    throw new LibraryError(`This scene was saved by a newer version of Atlas, so it can't be ${action} here. Update the app and try again.`)
  }
  throw new LibraryError(`This scene's data is not valid, so it can't be ${action}.`, parsed.issues.slice(0, 5))
}

export interface PlayableScene {
  /** The latest version, migrated to the current schema (its name follows the library row). */
  scene: Scene
  /** What a game playing it records as its origin (GameState.origin): the row and the version loaded. */
  origin: SceneOrigin
  name: string
}

/**
 * The latest version of a library scene, ready to play, with the origin to record (the DM changing
 * the map mid-session). Documents saved by a newer version of Atlas, or invalid ones, are refused
 * (LibraryError); a row deleted meanwhile rejects with NetError("not_found").
 */
export async function loadLibraryScene(services: Pick<AppServices, "scenes">, sceneId: string): Promise<PlayableScene> {
  const loaded = await services.scenes.load(sceneId)
  const scene = requireScene(loaded.parsed, "played")
  return { scene, origin: { sceneId: loaded.summary.id, version: loaded.version, dirty: false }, name: loaded.summary.name }
}

/** A copy of a document with a fresh identity (never shares ids with its source). */
function forkScene(scene: Scene, name: string): Scene {
  const copy = structuredClone(scene)
  const now = new Date().toISOString()
  copy.id = newId()
  copy.name = name
  copy.createdAt = now
  copy.updatedAt = now
  return copy
}

export async function duplicateScene(services: AppServices, summary: SceneSummary, existingNames: Iterable<string>): Promise<LibraryResult> {
  const loaded = await services.scenes.load(summary.id)
  const source = requireScene(loaded.parsed, "copied")
  const copy = forkScene(source, nextCopyName(summary.name, existingNames))
  const created = await services.scenes.create(copy)
  const warnings: string[] = []
  const assetIds = Object.keys(copy.assets ?? {})
  if (assetIds.length > 0) {
    try {
      await services.assets.copyImages(source.id, copy.id, assetIds)
    } catch (err) {
      warnings.push(`Map images could not be copied: ${userMessage(err)}`)
    }
  }
  return { summary: created, warnings }
}

export async function createFromSample(services: AppServices, sampleId: string): Promise<LibraryResult> {
  const sample = sampleById(sampleId)
  if (!sample) throw new LibraryError("That sample scene does not exist.")
  const scene = sample.build()
  scene.name = sample.name
  return { summary: await services.scenes.create(scene), warnings: [] }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Best-effort removal of a document's stored map images; returns how many could not be removed. */
async function deleteImages(services: AppServices, docId: string, assetIds: readonly string[]): Promise<number> {
  let failed = 0
  for (const id of assetIds) {
    try {
      await services.assets.deleteImage(docId, id)
    } catch {
      failed++
    }
  }
  return failed
}

/**
 * Delete a library scene and (best-effort) its map images. The image folders only this scene's
 * versions use (ScenesRepo.imageFoldersToFree: no other scene's versions, no active session) are
 * looked up BEFORE the row goes, and deleted after it (AssetStore.deleteSceneImages), so a failed image
 * delete leaves an orphan image, never a scene with missing images. Folders still in use (e.g. by an
 * active session started from the scene) stay; orphans are collected later by sweepUnusedImages.
 */
export async function deleteScene(services: AppServices, summary: SceneSummary): Promise<{ warnings: string[] }> {
  let folders: string[] = []
  try {
    folders = await services.scenes.imageFoldersToFree(summary.id)
  } catch {
    // Can't tell which images are unused: delete the row anyway; the images stay for the sweep.
  }
  await services.scenes.remove(summary.id)
  const warnings: string[] = []
  const deleteFolder = services.assets.deleteSceneImages?.bind(services.assets)
  if (deleteFolder && folders.length > 0) {
    let failed = 0
    for (const folder of folders) {
      try {
        await deleteFolder(folder)
      } catch {
        failed++
      }
    }
    if (failed > 0) warnings.push("Some map images could not be removed from storage.")
  }
  return { warnings }
}

/** Minimum time between two background image sweeps from this browser. */
export const IMAGE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000
const SWEEP_KEY = "atlas:image-sweep"

/**
 * Background clean-up of map images no saved scene version, active session or editor draft uses any
 * more (deleted scenes whose folders were in use then, images of versions pruned from history, imports
 * or editor sessions that never saved). Runs at most once per IMAGE_SWEEP_INTERVAL_MS per browser and
 * only on Supabase, where the store also skips images younger than a week (an import or an editor in
 * another tab may not have saved the scene that references a new image yet); local mode has no age to
 * protect such images. Never throws.
 */
export async function sweepUnusedImages(services: Pick<AppServices, "mode" | "assets">, now = Date.now()): Promise<{ removed: number; bytes: number } | null> {
  if (services.mode !== "supabase" || !services.assets.sweepUnreferencedImages) return null
  try {
    const last = Number(localStorage.getItem(SWEEP_KEY))
    if (Number.isFinite(last) && last > 0 && now - last < IMAGE_SWEEP_INTERVAL_MS) return null
    localStorage.setItem(SWEEP_KEY, String(now))
  } catch {
    // No storage: sweeping on every home visit would be wasteful; skip.
    return null
  }
  try {
    return await services.assets.sweepUnreferencedImages()
  } catch (err) {
    console.warn("[atlas] map image clean-up failed:", err)
    return null
  }
}

/** "Keep (imported)", then "Keep (imported 2)", … when the library already has the name. */
export function importedName(name: string, existing: Iterable<string>): string {
  const taken = new Set(existing)
  if (!taken.has(name)) return name
  const base = name.replace(/\s+\(imported(?: \d+)?\)$/u, "")
  let candidate = `${base} (imported)`
  for (let n = 2; taken.has(candidate); n++) candidate = `${base} (imported ${n})`
  return candidate
}

/** Import an `.atlas.json` file (with embedded map images) into the library. */
export async function importSceneFile(services: AppServices, file: Blob): Promise<LibraryResult> {
  const text = await file.text()
  const warnings: string[] = []
  // Restores embedded images under the imported scene's fresh document id. It never throws for the
  // image store: a failing store (quota, network) is reported as storeError with the same scene, so
  // the images stored before the failure still resolve.
  const result = await importSceneFileWithAssets(text, services.assets)
  const parsed = result.parsed
  const failed = result.storeError !== undefined
  const missing = result.missing.length
  if (failed) warnings.push(`Map images could not be stored: ${userMessage(result.storeError)}`)
  if (!parsed.ok) {
    if (parsed.error === "too-new") throw new LibraryError("This file was made by a newer version of Atlas. Update the app to open it.")
    throw new LibraryError("This file is not a valid Atlas scene.", parsed.issues.slice(0, 5))
  }
  const scene = parsed.scene
  try {
    // A second entry with an identical name is ambiguous in the library: suffix it.
    scene.name = importedName(
      scene.name,
      (await services.scenes.list()).map((s) => s.name)
    )
  } catch {
    // Listing failed: keep the file's name.
  }
  let summary: SceneSummary
  try {
    summary = await services.scenes.create(scene)
  } catch (err) {
    // No scene references the images stored for it: remove them (best-effort).
    await deleteImages(services, scene.id, Object.keys(scene.assets ?? {}))
    throw err
  }
  if (missing > 0 && !failed) warnings.push(`${plural(missing, "map image is", "map images are")} not included in the file.`)
  return { summary, warnings }
}

export interface ExportedFile {
  fileName: string
  mimeType: string
  text: string
  warnings: string[]
}

/** The latest version as a portable `.atlas.json` (map images embedded as data URLs). */
export async function exportScene(services: AppServices, summary: SceneSummary): Promise<ExportedFile> {
  const loaded = await services.scenes.load(summary.id)
  const scene = requireScene(loaded.parsed, "exported")
  const images = Object.keys(scene.assets ?? {}).length
  try {
    const file = await exportSceneFileWithAssets(scene, services.assets)
    const n = file.missing.length
    return {
      fileName: file.fileName,
      mimeType: file.mimeType,
      text: file.text,
      warnings: n > 0 ? [`${plural(n, "map image", "map images")} could not be included.`] : [],
    }
  } catch {
    const file = exportSceneFile(scene)
    return { ...file, warnings: images > 0 ? [`${plural(images, "map image", "map images")} could not be included.`] : [] }
  }
}

/** Whether a document references map images (shared links do not carry them). */
export function hasMapImages(scene: Pick<Scene, "assets" | "levels">): boolean {
  return Object.keys(scene.assets ?? {}).length > 0 || Object.values(scene.levels).some((l) => !!l.backdrop)
}

/**
 * Copy a link-shared scene into my library. The owner's map images live in their private storage
 * and are not part of the share, so backdrops are dropped (the geometry, lights and tokens stay).
 */
export async function copySharedScene(services: AppServices, shared: SharedScene): Promise<LibraryResult> {
  const source = requireScene(shared.parsed, "copied")
  const copy = forkScene(source, shared.name)
  const warnings: string[] = []
  if (hasMapImages(copy)) {
    delete copy.assets
    for (const level of Object.values(copy.levels)) delete level.backdrop
    warnings.push("Map images are not included in shared links, so the copy has no backdrop images.")
  }
  return { summary: await services.scenes.create(copy), warnings }
}
