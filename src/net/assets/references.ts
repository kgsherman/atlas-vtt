/**
 * Which stored map images are still in use (ARCHITECTURE §9): images live under the id of the scene
 * DOCUMENT that references them (`Scene.id`, or — for old uploads — the library row id), keyed by
 * asset id. A (folder, asset) pair is in use while any saved scene version, active session state or
 * editor draft references it. Pure helpers shared by the Supabase and local asset stores.
 */
import type { LocalStore } from "../localStore"

type Doc = { id?: unknown; assets?: unknown }

/** Add the `${folder}/${assetId}` pairs a scene document references (folders: its id and `alias`). */
export function addImageRefs(doc: unknown, out: Set<string>, alias?: string | null): void {
  if (!doc || typeof doc !== "object") return
  const d = doc as Doc
  const assets = d.assets && typeof d.assets === "object" ? Object.keys(d.assets as object) : []
  const folders = [typeof d.id === "string" ? d.id : null, alias ?? null].filter((f): f is string => !!f)
  for (const folder of folders) for (const assetId of assets) out.add(`${folder}/${assetId}`)
}

/** The scene document of an editor draft ({ scene, … }) or of a session state (seed or game). */
export function sceneOf(value: unknown): unknown {
  return value && typeof value === "object" ? (value as { scene?: unknown }).scene : undefined
}

/** Document ids of this browser's editor drafts (their images may not be saved anywhere yet). */
export async function draftDocIds(store: LocalStore): Promise<Set<string>> {
  const out = new Set<string>()
  for (const [, draft] of await store.entries<{ data?: unknown }>("drafts")) {
    const scene = sceneOf(draft?.data) as Doc | undefined
    if (scene && typeof scene.id === "string") out.add(scene.id)
  }
  return out
}
