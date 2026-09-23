/**
 * Editor clipboard: in-memory AtlasClipboard (core/scene/integrity copySelection) mirrored to the
 * system clipboard as JSON when the browser allows it. Text read back from the system clipboard is
 * untrusted (it may come from another app or another Atlas version), so it is parsed defensively
 * and every pasted item is validated with the strict scene schema before the paste is committed.
 */
import type { AtlasClipboard } from "@/core/scene/integrity"
import { validateReferences } from "@/core/scene/integrity"
import { SCENE_LIMITS, sceneSchema } from "@/core/scene/schema"
import { SCENE_SCHEMA_VERSION, type Id, type Level, type Scene, type SceneObject, type Token } from "@/core/scene/types"

/** The subset of the async Clipboard API the editor uses (injectable for tests). */
export interface SystemClipboard {
  writeText(text: string): Promise<void>
  readText(): Promise<string>
}

/** navigator.clipboard when available (secure context), else null. */
export function browserClipboard(): SystemClipboard | null {
  const nav = (globalThis as { navigator?: { clipboard?: SystemClipboard } }).navigator
  const cb = nav?.clipboard
  if (!cb || typeof cb.writeText !== "function" || typeof cb.readText !== "function") return null
  return cb
}

export function serializeClipboard(clip: AtlasClipboard): string {
  return JSON.stringify(clip)
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)
const isVec2 = (v: unknown): boolean => isRecord(v) && Number.isFinite(v.x) && Number.isFinite(v.z)

/**
 * Parse clipboard text into an AtlasClipboard envelope, or null if it is not one. Only the envelope
 * is checked here; the items themselves are validated after pasting (validatePastedItems).
 */
export function parseClipboardText(text: string): AtlasClipboard | null {
  if (text.length === 0 || text.length > 32 * 1024 * 1024) return null
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(json) || json.kind !== "atlas-clipboard") return null
  if (json.schemaVersion !== SCENE_SCHEMA_VERSION) return null
  if (typeof json.sourceLevelId !== "string" || !isVec2(json.origin)) return null
  if (!Array.isArray(json.objects) || !Array.isArray(json.tokens)) return null
  if (json.objects.length > SCENE_LIMITS.maxObjects || json.tokens.length > SCENE_LIMITS.maxTokens) return null
  if (!json.objects.every(isRecord) || !json.tokens.every(isRecord)) return null
  if (json.levelOffsets !== undefined) {
    if (!isRecord(json.levelOffsets) || !Object.values(json.levelOffsets).every((n) => Number.isInteger(n))) return null
  }
  if (json.openingCenters !== undefined) {
    if (!isRecord(json.openingCenters) || !Object.values(json.openingCenters).every(isVec2)) return null
  }
  return json as unknown as AtlasClipboard
}

/**
 * Validate freshly pasted items against the strict scene schema and reference rules, using a probe
 * scene made of the pasted items plus whatever they reference (host walls, carrier tokens) and the
 * scene's levels without terrain (keeps the check cheap). Returns problems; empty = valid.
 */
export function validatePastedItems(scene: Scene, ids: readonly Id[]): string[] {
  const objects: Record<Id, SceneObject> = {}
  const tokens: Record<Id, Token> = {}
  const include = (id: Id) => {
    if (Object.hasOwn(scene.objects, id)) objects[id] = scene.objects[id]
    else if (Object.hasOwn(scene.tokens, id)) tokens[id] = scene.tokens[id]
  }
  for (const id of ids) include(id)
  for (const o of Object.values(objects)) {
    if (o.type === "door" || o.type === "window") include(o.wallId)
    if (o.type === "light" && o.attachedTokenId) include(o.attachedTokenId)
  }
  const levels: Record<Id, Level> = {}
  for (const [id, level] of Object.entries(scene.levels)) levels[id] = { ...level, heightmap: null }
  const probe = { ...scene, levels, objects, tokens }
  const parsed = sceneSchema.safeParse(probe)
  if (!parsed.success) {
    return parsed.error.issues.slice(0, 20).map((i) => `${i.path.map(String).join(".")}: ${i.message}`)
  }
  return validateReferences(probe).slice(0, 20)
}
