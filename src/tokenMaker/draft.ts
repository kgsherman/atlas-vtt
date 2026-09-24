/**
 * The Token Maker's autosaved draft (IndexedDB `drafts` store, key `token-maker:current`): the design
 * and the image blobs it uses, so a reload or a closed tab never loses a token in progress. A draft
 * that fails validation, or misses an image, is ignored (and replaced by the next save).
 */
import { designImageIds, parseTokenDesign } from "@/core/tokenMaker/schema"
import type { TokenDesign } from "@/core/tokenMaker/types"
import { deleteDraft, getLocalStore, loadDraft, saveDraft } from "@/net/localStore"

import type { StoredImage } from "./store"

const KEY = "token-maker:current"

interface DraftData {
  design: unknown
  images: Record<string, { blob: Blob; width: number; height: number }>
}

export async function saveTokenDraft(design: TokenDesign, images: Record<string, StoredImage>): Promise<void> {
  const used: DraftData["images"] = {}
  for (const id of designImageIds(design)) {
    const img = images[id]
    if (img) used[id] = { blob: img.blob, width: img.width, height: img.height }
  }
  await saveDraft<DraftData>(await getLocalStore(), KEY, { design, images: used })
}

export async function loadTokenDraft(): Promise<{ design: TokenDesign; images: Record<string, StoredImage> } | null> {
  const draft = await loadDraft<DraftData>(await getLocalStore(), KEY)
  if (!draft?.data) return null
  const design = parseTokenDesign(draft.data.design)
  if (!design) return null
  const images: Record<string, StoredImage> = {}
  for (const id of designImageIds(design)) {
    const img = draft.data.images?.[id]
    if (!img || !(img.blob instanceof Blob) || !(img.width > 0) || !(img.height > 0)) return null
    images[id] = { blob: img.blob, width: img.width, height: img.height }
  }
  return { design, images }
}

export async function clearTokenDraft(): Promise<void> {
  await deleteDraft(await getLocalStore(), KEY)
}
