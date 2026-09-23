/**
 * React binding for the editor store: `useEditor(selector)` subscribes a component to a slice of the
 * app-wide store (or of a store passed explicitly, e.g. in tests or embedded editors).
 */
import { useStore } from "zustand"

import { editorStore, type EditorState, type EditorStore } from "./store"

export function useEditor<T>(selector: (state: EditorState) => T, store: EditorStore = editorStore): T {
  return useStore(store, selector)
}
