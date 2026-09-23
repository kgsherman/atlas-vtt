/**
 * Scene-library operations used by the home and shared pages (duplicate, samples, import/export,
 * copying a shared scene). Each returns user-facing warnings for partial successes (e.g. a map image
 * that could not be copied) and throws LibraryError / NetError on failure.
 */
import { newId } from "@/core/scene/factory"
import { sampleById } from "@/core/scene/samples"
import type { ParseSceneResult } from "@/core/scene/schema"
import type { Scene } from "@/core/scene/types"
import { exportSceneFile, exportSceneFileWithAssets, importSceneFileWithAssets, readSceneFile, type SceneSummary, type SharedScene } from "@/net/scenesRepo"
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
  if (!scene.meta.description) scene.meta.description = sample.description
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
 * Delete a library scene and (best-effort) its map images. The row goes first, so a failed image
 * delete leaves an orphan image, never a scene with missing images. Images stay while an active
 * session started from the scene may still read them (or when that can't be checked). Only the latest
 * version's images are known here; ones only older versions referenced are not removed.
 */
export async function deleteScene(services: AppServices, summary: SceneSummary): Promise<{ warnings: string[] }> {
  let docId: string | null = null
  let assetIds: string[] = []
  try {
    const loaded = await services.scenes.load(summary.id)
    if (loaded.parsed.ok) {
      docId = loaded.parsed.scene.id
      assetIds = Object.keys(loaded.parsed.scene.assets ?? {})
    }
  } catch {
    // Unreadable latest version: delete the row anyway; its images (if any) stay.
  }
  let inUse = false
  if (assetIds.length > 0) {
    try {
      inUse = (await services.sessions.listMySessions()).some((s) => s.sceneId === summary.id && s.status === "active")
    } catch {
      inUse = true
    }
  }
  await services.scenes.remove(summary.id)
  const warnings: string[] = []
  if (docId && !inUse && assetIds.length > 0) {
    const failed = await deleteImages(services, docId, assetIds)
    if (failed > 0) warnings.push(`${plural(failed, "map image", "map images")} could not be removed from storage.`)
  }
  return { warnings }
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
  let parsed: ParseSceneResult
  let missing = 0
  try {
    // Restores embedded images under the imported scene's fresh document id.
    const result = await importSceneFileWithAssets(text, services.assets)
    parsed = result.parsed
    missing = result.missing.length
  } catch (err) {
    // The image store failed: import the document anyway, without its images.
    parsed = readSceneFile(text).parsed
    if (parsed.ok && Object.keys(parsed.scene.assets ?? {}).length > 0) warnings.push(`Map images could not be stored: ${userMessage(err)}`)
  }
  if (!parsed.ok) {
    if (parsed.error === "too-new") throw new LibraryError("This file was made by a newer version of Atlas. Update the app to open it.")
    throw new LibraryError("This file is not a valid Atlas scene.", parsed.issues.slice(0, 5))
  }
  const scene = parsed.scene
  try {
    // A second entry with an identical name is ambiguous in the library: suffix it.
    scene.name = importedName(scene.name, (await services.scenes.list()).map((s) => s.name))
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
  if (missing > 0) warnings.push(`${plural(missing, "map image is", "map images are")} not included in the file.`)
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
