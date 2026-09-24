/**
 * Token Maker page context: the editor store, the decoded image cache, the link to open game tabs and
 * the file picker.
 */
import * as React from "react"
import { useStore } from "zustand"

import type { LinkedGame, MakerLink } from "@/net/tokenMakerLink"
import type { ImageCache, TokenMakerActions, TokenMakerState, TokenMakerStore } from "@/tokenMaker/store"

export interface TokenMakerContextValue {
  store: TokenMakerStore
  cache: ImageCache
  link: MakerLink
  /** Open the file picker to add an image layer of `role`. */
  pickFile(role: "background" | "frame" | "subject"): void
}

export const TokenMakerContext = React.createContext<TokenMakerContextValue | null>(null)

export function useTokenMaker(): TokenMakerContextValue {
  const v = React.useContext(TokenMakerContext)
  if (!v) throw new Error("useTokenMaker() outside the Token Maker")
  return v
}

export function useMaker<T>(select: (s: TokenMakerState & TokenMakerActions) => T): T {
  return useStore(useTokenMaker().store, select)
}

const objectUrls = new WeakMap<Blob, string>()

/**
 * An object URL for a blob (one per blob, kept while the blob lives: the Token Maker keeps its images
 * for the whole session anyway, and undo may show an old one again).
 */
export function objectUrl(blob: Blob | null | undefined): string | null {
  if (!blob) return null
  let url = objectUrls.get(blob)
  if (!url) {
    url = URL.createObjectURL(blob)
    objectUrls.set(blob, url)
  }
  return url
}

/** Games open in other tabs (their announcements). */
export function useLinkedGames(): LinkedGame[] {
  const { link } = useTokenMaker()
  return React.useSyncExternalStore(link.subscribe, link.getGames)
}
