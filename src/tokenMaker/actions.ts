/**
 * Token Maker flows (ARCHITECTURE §11) that mix the store with images and services: adding layers from
 * files and free parts, fitting the disc to a frame, background removal, the starting template,
 * downloads and applying a token to a game.
 */
import { findLayer, GAME_TOKEN_SIZE, radiusForFrame, replaceImage, setMask } from "@/core/tokenMaker/design"
import type { LayerRole, TokenDesign, TokenLayer } from "@/core/tokenMaker/types"
import type { FreeTokenPart } from "@/net/freeAssets"
import type { BackgroundRemover } from "@/net/imageTools"
import type { TokenImageStore } from "@/net/tokenImages"

import { frameOpening, importSourceImage } from "./images"
import { exportDesign } from "./render"
import type { ImageCache, TokenMakerStore } from "./store"

/** Default solid backdrop when no free backdrop is available (a dusky plum, like the free one). */
export const DEFAULT_FILL = "#2a2230"

/**
 * Where a new layer of `role` goes: backgrounds at the bottom, frames on top, subjects just under
 * the topmost unmasked layer (the frame), so the frame stays in front.
 */
export function insertIndex(design: TokenDesign, role: LayerRole): number {
  if (role === "background") return 0
  if (role === "frame") return design.layers.length
  for (let i = design.layers.length - 1; i >= 0; i--) if (design.layers[i].mask.shape === "none") return i
  return design.layers.length
}

/** A readable layer name from a file name ("elf_ranger-final.png" → "elf ranger-final"). */
export function nameFromFile(name: string): string {
  const base = name
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[_]+/g, " ")
    .trim()
  return (base || "Image").slice(0, 64)
}

export async function addImageFile(store: TokenMakerStore, cache: ImageCache, file: Blob, name: string, role: LayerRole): Promise<string | null> {
  const img = await importSourceImage(file)
  const s = store.getState()
  const id = s.addImageLayer(img, name, role, insertIndex(s.design, role))
  if (id && role === "frame") await fitDiscToFrame(store, cache, id)
  return id
}

/** Fetch a free part and add it as a layer (frames also fit the disc to their opening). */
export async function addFreePart(store: TokenMakerStore, cache: ImageCache, part: FreeTokenPart): Promise<string | null> {
  let res: Response
  try {
    res = await fetch(part.url)
  } catch (err) {
    throw new Error(`Couldn't download “${part.name}”. Check your connection.`, { cause: err })
  }
  if (!res.ok) throw new Error(`Couldn't download “${part.name}” (HTTP ${res.status}).`)
  return addImageFile(store, cache, await res.blob(), part.name, part.role)
}

/**
 * Set the token disc to a frame layer's opening. Returns the new radius, or null when the image has
 * no detectable opening or is not centred on the canvas.
 */
export async function fitDiscToFrame(store: TokenMakerStore, cache: ImageCache, layerId: string): Promise<number | null> {
  const layer = findLayer(store.getState().design, layerId)
  if (!layer || layer.source.type !== "image") return null
  const opening = frameOpening(await cache.ready(layer.source.imageId))
  if (opening === null) return null
  const now = findLayer(store.getState().design, layerId)
  const radius = now ? radiusForFrame(now, opening) : null
  if (radius === null) return null
  store.getState().setRadius(radius)
  return radius
}

/** The first frame-like layer (unmasked image), topmost first. */
export function frameLayer(design: TokenDesign): TokenLayer | null {
  for (let i = design.layers.length - 1; i >= 0; i--) {
    const l = design.layers[i]
    if (l.source.type === "image" && l.mask.shape === "none") return l
  }
  return null
}

/**
 * Replace a layer's image by its background-removed version (same place and size). A disc-masked
 * layer is then allowed to break out of the frame (pop-out), which is what a cut-out is for.
 */
export async function removeLayerBackground(store: TokenMakerStore, remover: BackgroundRemover, layerId: string, signal?: AbortSignal): Promise<void> {
  const s = store.getState()
  const layer = findLayer(s.design, layerId)
  if (!layer || layer.source.type !== "image") throw new Error("Pick an image layer first.")
  const src = s.images[layer.source.imageId]
  if (!src) throw new Error("That layer's image is missing.")
  s.setWorking(layerId, "Removing the background…")
  try {
    const out = await remover.removeBackground(src.blob, { width: src.width, height: src.height }, signal)
    const img = await importSourceImage(out)
    const now = store.getState()
    const current = findLayer(now.design, layerId)
    if (!current) return
    const imageId = now.addImage(img)
    let next = replaceImage(now.design, layerId, { type: "image", imageId, width: img.width, height: img.height })
    if (current.mask.shape === "disc") next = setMask(next, layerId, { popOut: true })
    now.commit(next)
  } finally {
    store.getState().setWorking(layerId, null)
  }
}

/** Start a new token: the free backdrop and frame when available, else a plain backdrop. */
export async function startTemplate(store: TokenMakerStore, cache: ImageCache, parts: FreeTokenPart[]): Promise<void> {
  store.getState().load({ version: 1, radius: store.getState().design.radius, layers: [] }, {})
  const bg = parts.find((p) => p.role === "background")
  const frame = parts.find((p) => p.role === "frame")
  const [bgBlob, frameBlob] = await Promise.all(
    [bg, frame].map((p) =>
      p
        ? fetch(p.url).then(
            (r) => (r.ok ? r.blob() : null),
            () => null
          )
        : Promise.resolve(null)
    )
  )
  const s = store.getState()
  if (bg && bgBlob) s.addImageLayer(await importSourceImage(bgBlob), bg.name, "background", 0)
  else s.addFillLayer(DEFAULT_FILL, "Backdrop", "background", 0)
  if (frame && frameBlob) {
    const id = store.getState().addImageLayer(await importSourceImage(frameBlob), frame.name, "frame")
    if (id) await fitDiscToFrame(store, cache, id).catch(() => null)
  }
  // The template is where history starts.
  store.setState({ past: [], future: [], selectedId: null })
}

export function lookupFor(cache: ImageCache) {
  return (imageId: string) => cache.get(imageId)
}

/** Every image of the design decoded (so an export never misses a layer). */
export async function decodeAll(cache: ImageCache, design: TokenDesign): Promise<void> {
  await Promise.all(design.layers.map((l) => (l.source.type === "image" ? cache.ready(l.source.imageId) : null)))
}

export async function exportPng(store: TokenMakerStore, cache: ImageCache, size: number): Promise<Blob> {
  const design = store.getState().design
  await decodeAll(cache, design)
  return exportDesign(design, lookupFor(cache), size, "image/png")
}

/** File name for a download: the character's (subject layer's) name when there is one. */
export function downloadName(design: TokenDesign, size: number): string {
  const subject = [...design.layers].reverse().find((l) => l.source.type === "image" && l.mask.shape === "disc" && l.transform.scale < 1.5)
  const slug = (subject?.name ?? "token")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
  return `${slug || "token"}-${size}px.png`
}

/** Render the game-sized token (WebP when supported) and store it; returns its public URL. */
export async function uploadForGame(store: TokenMakerStore, cache: ImageCache, images: TokenImageStore): Promise<string> {
  const design = store.getState().design
  await decodeAll(cache, design)
  const blob = await exportDesign(design, lookupFor(cache), GAME_TOKEN_SIZE, "image/webp", 0.9)
  return images.put(blob)
}
