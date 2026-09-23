/**
 * Library-card thumbnails: scene digests cached per (library id, version) and map-image previews
 * cached per (document id, asset id) — assets are immutable by id, so a new scene version does not
 * re-decode its image. Memory first, then localStorage (bounded LRU). Loads are deduplicated and
 * run at most two at a time.
 */
import * as React from "react"

import type { SceneSummary } from "@/net/scenesRepo"

import { isSceneDigest, sceneDigest, type SceneDigest } from "./sceneDigest"
import type { AppServices } from "./services"

export interface DigestEntry {
  digest: SceneDigest
  /** Small WebP/JPEG data URL of the primary level's map image. */
  image: string | null
}

export type DigestStatus = "idle" | "loading" | "ready" | "error"

const PREFIX = "atlas-vtt:digest:v1:"
const IMAGE_PREFIX = "atlas-vtt:thumb:v1:"
const INDEX_KEY = "atlas-vtt:digest-index:v1"
const MAX_ENTRIES = 48
const THUMB_WIDTH = 360

const memory = new Map<string, DigestEntry>()
const inflight = new Map<string, Promise<DigestEntry>>()

export function digestKey(summary: Pick<SceneSummary, "id" | "latestVersion">): string {
  return `${summary.id}@${summary.latestVersion}`
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function readIndex(s: Storage): string[] {
  try {
    const v = JSON.parse(s.getItem(INDEX_KEY) ?? "[]") as unknown
    return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : []
  } catch {
    return []
  }
}

/** Record `key` as most recently used; evict the oldest and superseded versions. */
function touch(s: Storage, key: string, extra: string[] = []): void {
  const id = key.slice(0, key.lastIndexOf("@"))
  const fresh = new Set([key, ...extra])
  const keep: string[] = []
  for (const k of readIndex(s)) {
    if (fresh.has(k)) continue
    // Older versions of the same scene are never needed again.
    if (k.startsWith(`${id}@`)) s.removeItem(storageKeyOf(k))
    else keep.push(k)
  }
  keep.push(...fresh)
  while (keep.length > MAX_ENTRIES) s.removeItem(storageKeyOf(keep.shift()!))
  s.setItem(INDEX_KEY, JSON.stringify(keep))
}

/** Index entries are digest keys, or `img:<imageKey>` for map-image previews. */
function storageKeyOf(indexKey: string): string {
  return indexKey.startsWith("img:") ? IMAGE_PREFIX + indexKey.slice(4) : PREFIX + indexKey
}

function readStored(key: string): DigestEntry | null {
  const s = storage()
  if (!s) return null
  try {
    const raw = s.getItem(PREFIX + key)
    if (!raw) return null
    const v = JSON.parse(raw) as { digest?: unknown; imageKey?: unknown }
    if (!isSceneDigest(v.digest)) return null
    const image = typeof v.imageKey === "string" ? s.getItem(IMAGE_PREFIX + v.imageKey) : null
    // The preview was evicted: treat as a miss so it is rebuilt.
    if (typeof v.imageKey === "string" && !image?.startsWith("data:image/")) return null
    return { digest: v.digest, image }
  } catch {
    return null
  }
}

function writeStored(key: string, entry: DigestEntry, imageKey: string | null): void {
  const s = storage()
  if (!s) return
  const put = () => {
    s.setItem(PREFIX + key, JSON.stringify({ digest: entry.digest, imageKey }))
    if (imageKey && entry.image) s.setItem(IMAGE_PREFIX + imageKey, entry.image)
    touch(s, key, imageKey ? [`img:${imageKey}`] : [])
  }
  try {
    put()
  } catch {
    // Quota: drop every cached digest and try once more (they are only a cache).
    try {
      for (const k of readIndex(s)) s.removeItem(storageKeyOf(k))
      s.removeItem(INDEX_KEY)
      put()
    } catch {
      // give up silently
    }
  }
}

/** Cached entry, if any (synchronous; for first render). */
export function peekDigest(key: string): DigestEntry | null {
  const hit = memory.get(key)
  if (hit) return hit
  const stored = readStored(key)
  if (stored) memory.set(key, stored)
  return stored
}

// ---------------------------------------------------------------------------
// Loading queue
// ---------------------------------------------------------------------------

const MAX_PARALLEL = 2
let running = 0
const queue: Array<() => void> = []

function schedule<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      running++
      task()
        .then(resolve, reject)
        .finally(() => {
          running--
          queue.shift()?.()
        })
    }
    if (running < MAX_PARALLEL) start()
    else queue.push(start)
  })
}

async function makeImageThumb(blob: Blob): Promise<string | null> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null
  const bitmap = await createImageBitmap(blob, { resizeWidth: THUMB_WIDTH, resizeQuality: "medium" })
  try {
    const canvas = document.createElement("canvas")
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const ctx = canvas.getContext("2d")
    if (!ctx) return null
    ctx.drawImage(bitmap, 0, 0)
    const webp = canvas.toDataURL("image/webp", 0.72)
    return webp.startsWith("data:image/webp") ? webp : canvas.toDataURL("image/jpeg", 0.75)
  } finally {
    bitmap.close()
  }
}

/** Load (or reuse) the digest for a library entry. */
export function loadDigest(services: AppServices, summary: SceneSummary): Promise<DigestEntry> {
  const key = digestKey(summary)
  const cached = peekDigest(key)
  if (cached) return Promise.resolve(cached)
  let pending = inflight.get(key)
  if (!pending) {
    pending = schedule(async () => {
      const loaded = await services.scenes.load(summary.id, summary.latestVersion)
      if (!loaded.parsed.ok) throw new Error(loaded.parsed.error)
      const scene = loaded.parsed.scene
      const digest = sceneDigest(scene)
      let image: string | null = null
      let imageKey: string | null = null
      const backdrop = digest.primary.backdrop
      if (backdrop) {
        imageKey = `${scene.id}:${backdrop.assetId}`
        const s = storage()
        image = s?.getItem(IMAGE_PREFIX + imageKey) ?? null
        if (!image) {
          try {
            const blob = await services.assets.getImage(scene.id, backdrop.assetId)
            image = blob ? await makeImageThumb(blob) : null
          } catch {
            image = null
          }
        }
        if (!image) imageKey = null
      }
      const entry: DigestEntry = { digest, image }
      memory.set(key, entry)
      writeStored(key, entry, imageKey)
      return entry
    }).finally(() => inflight.delete(key))
    inflight.set(key, pending)
  }
  return pending
}

/** Forget cached digests of a deleted scene. */
export function forgetDigest(summary: Pick<SceneSummary, "id" | "latestVersion">): void {
  memory.delete(digestKey(summary))
  const s = storage()
  if (!s) return
  try {
    s.removeItem(PREFIX + digestKey(summary))
  } catch {
    // ignore
  }
}

/**
 * The digest for a card, loaded when `visible` becomes true (pass true to load immediately).
 */
export function useSceneDigest(services: AppServices, summary: SceneSummary, visible: boolean): { entry: DigestEntry | null; status: DigestStatus } {
  const key = digestKey(summary)
  const [result, setResult] = React.useState<{ key: string; entry: DigestEntry | null; failed: boolean }>(() => ({
    key,
    entry: peekDigest(key),
    failed: false,
  }))
  const current = result.key === key ? result : { key, entry: peekDigest(key), failed: false }

  const summaryRef = React.useRef(summary)
  React.useLayoutEffect(() => {
    summaryRef.current = summary
  })

  const have = current.entry !== null
  React.useEffect(() => {
    if (!visible || have) return
    let alive = true
    loadDigest(services, summaryRef.current).then(
      (entry) => alive && setResult({ key, entry, failed: false }),
      () => alive && setResult({ key, entry: null, failed: true })
    )
    return () => {
      alive = false
    }
  }, [services, key, visible, have])

  const status: DigestStatus = current.entry ? "ready" : current.failed ? "error" : visible ? "loading" : "idle"
  return { entry: current.entry, status }
}

/** True once the element has been on screen (IntersectionObserver; true without support). */
export function useSeenOnce<T extends Element>(): [React.RefCallback<T>, boolean] {
  const [seen, setSeen] = React.useState(() => typeof IntersectionObserver === "undefined")
  const observer = React.useRef<IntersectionObserver | null>(null)
  const ref = React.useCallback((el: T | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (!el || typeof IntersectionObserver === "undefined") return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true)
          io.disconnect()
        }
      },
      { rootMargin: "200px" }
    )
    io.observe(el)
    observer.current = io
  }, [])
  return [ref, seen]
}
