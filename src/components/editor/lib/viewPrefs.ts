/**
 * The editor's view choices per scene (camera kind, grid, helpers, ghosted levels), remembered on this
 * device so reopening a scene restores them. Storage is untrusted input: every field is checked.
 */
import type { EditorViewOptions } from "@/editor/settings"

export type SavedEditorView = Partial<
  Pick<
    EditorViewOptions,
    "camera" | "showGrid" | "showHelpers" | "ghostAdjacent"
  >
>

type StorageLike = Pick<Storage, "getItem" | "setItem">

const key = (sceneId: string) => `atlas-editor:view:${sceneId}`

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}

export function readEditorView(
  sceneId: string,
  storage: StorageLike | null = defaultStorage()
): SavedEditorView | null {
  try {
    const raw = storage?.getItem(key(sceneId))
    if (!raw) return null
    const v = JSON.parse(raw) as Record<string, unknown>
    const out: SavedEditorView = {}
    if (v.camera === "orbit" || v.camera === "topdown") out.camera = v.camera
    for (const k of ["showGrid", "showHelpers", "ghostAdjacent"] as const)
      if (typeof v[k] === "boolean") out[k] = v[k]
    return Object.keys(out).length > 0 ? out : null
  } catch {
    return null
  }
}

export function writeEditorView(
  sceneId: string,
  view: Pick<
    EditorViewOptions,
    "camera" | "showGrid" | "showHelpers" | "ghostAdjacent"
  >,
  storage: StorageLike | null = defaultStorage()
): void {
  try {
    const saved: SavedEditorView = {
      camera: view.camera,
      showGrid: view.showGrid,
      showHelpers: view.showHelpers,
      ghostAdjacent: view.ghostAdjacent,
    }
    storage?.setItem(key(sceneId), JSON.stringify(saved))
  } catch {
    // Storage full / blocked: not remembered.
  }
}
