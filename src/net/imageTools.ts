/**
 * AI image tools for the Token Maker (ARCHITECTURE §11): background removal by whatever image model the
 * server is configured with (supabase/functions/_shared/imageModels.ts). The client never names a
 * provider or holds a key; it sends the image and gets a transparent PNG back.
 *
 * Endpoints, in order:
 *  - `npm run dev`: the dev server's POST /api/image-tools/remove-background (dev/imageToolsApi.ts),
 *    configured by OPENAI_API_KEY in .env.local. When it answers `not_configured`, Cloud mode falls
 *    through to the Edge Function.
 *  - Cloud: the Edge Function `remove-background` (signed-in user, daily allowance).
 *  - Otherwise (local mode, production build): unavailable.
 */
import { FunctionsFetchError, FunctionsHttpError } from "@supabase/supabase-js"

import type { AtlasClient } from "./supabase"

export const DEV_REMOVE_BACKGROUND_PATH = "/api/image-tools/remove-background"

export type ImageToolErrorCode =
  | "unavailable"
  | "not_configured"
  | "invalid_argument"
  | "payload_too_large"
  | "not_authenticated"
  | "quota_exceeded"
  | "rejected"
  | "provider_error"
  | "network"

export class ImageToolError extends Error {
  readonly code: ImageToolErrorCode

  constructor(code: ImageToolErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "ImageToolError"
    this.code = code
  }
}

const KNOWN = new Set<string>(["not_configured", "invalid_argument", "payload_too_large", "not_authenticated", "quota_exceeded", "rejected", "provider_error"])

/** A short user-facing sentence for a failed image tool call. */
export function describeImageToolError(err: unknown): string {
  if (!(err instanceof ImageToolError)) return err instanceof Error ? err.message : "Something went wrong."
  switch (err.code) {
    case "unavailable":
    case "not_configured":
      return "Background removal isn't set up on this server."
    case "quota_exceeded":
      return err.message || "You've used today's background removals. Try again tomorrow."
    case "rejected":
      return err.message || "The image model couldn't use this image."
    case "payload_too_large":
      return "That image is too large to send."
    case "not_authenticated":
      return "You're not signed in."
    case "network":
      return "Couldn't reach the server. Check your connection."
    default:
      return err.message || "Background removal failed."
  }
}

export interface BackgroundRemover {
  readonly available: boolean
  /** A transparent-background version of `image` (PNG / JPEG / WebP, its pixel size given). */
  removeBackground(image: Blob, size: { width: number; height: number }, signal?: AbortSignal): Promise<Blob>
}

function formFor(image: Blob, size: { width: number; height: number }): FormData {
  const form = new FormData()
  const ext = image.type === "image/jpeg" ? "jpg" : image.type === "image/webp" ? "webp" : "png"
  form.append("image", image, `image.${ext}`)
  form.append("width", String(Math.round(size.width)))
  form.append("height", String(Math.round(size.height)))
  return form
}

/** Parse an endpoint's JSON answer (success or `{ error, detail }`). */
export function parseImageToolReply(body: unknown, status: number): Blob {
  const b = (body ?? {}) as Record<string, unknown>
  if (status >= 200 && status < 300 && typeof b.image === "string" && (b.mime === "image/png" || b.mime === "image/webp")) {
    let bin: string
    try {
      bin = atob(b.image)
    } catch (err) {
      throw new ImageToolError("provider_error", "The server sent an unreadable image.", { cause: err })
    }
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new Blob([bytes], { type: b.mime })
  }
  const code = typeof b.error === "string" && KNOWN.has(b.error) ? (b.error as ImageToolErrorCode) : "provider_error"
  const detail = typeof b.detail === "string" ? b.detail : `HTTP ${status}`
  throw new ImageToolError(code, sentence(detail))
}

const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".") : s)

async function viaDevServer(image: Blob, size: { width: number; height: number }, signal?: AbortSignal): Promise<Blob> {
  let res: Response
  try {
    res = await fetch(DEV_REMOVE_BACKGROUND_PATH, { method: "POST", body: formFor(image, size), signal })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new ImageToolError("network", "Couldn't reach the dev server.", { cause: err })
  }
  // Not our endpoint (e.g. a preview server): treat as not configured.
  if (!(res.headers.get("Content-Type") ?? "").includes("application/json")) throw new ImageToolError("not_configured", "No image tools endpoint.")
  return parseImageToolReply(await res.json(), res.status)
}

async function viaEdgeFunction(client: AtlasClient, image: Blob, size: { width: number; height: number }, signal?: AbortSignal): Promise<Blob> {
  const { data, error } = await client.functions.invoke("remove-background", { body: formFor(image, size), signal })
  if (!error) return parseImageToolReply(data, 200)
  if (error instanceof FunctionsHttpError) {
    const response = error.context as Response
    const body = await response.json().catch(() => null)
    // Not the function's JSON (e.g. the function is not deployed).
    if (!body || typeof (body as { error?: unknown }).error !== "string") {
      throw new ImageToolError(response.status === 404 ? "not_configured" : "provider_error", `Background removal failed (HTTP ${response.status}).`, {
        cause: error,
      })
    }
    return parseImageToolReply(body, response.status)
  }
  if (error instanceof FunctionsFetchError) throw new ImageToolError("network", "Couldn't reach the server.", { cause: error })
  throw new ImageToolError("provider_error", error instanceof Error ? error.message : "Background removal failed.", { cause: error })
}

export function createBackgroundRemover(opts: { client: AtlasClient | null; dev: boolean }): BackgroundRemover {
  const { client, dev } = opts
  return {
    available: dev || client !== null,
    async removeBackground(image, size, signal) {
      if (dev) {
        try {
          return await viaDevServer(image, size, signal)
        } catch (err) {
          if (!(err instanceof ImageToolError && err.code === "not_configured" && client)) throw err
        }
      }
      if (!client) throw new ImageToolError("unavailable", "Background removal needs Atlas Cloud or the dev server.")
      return viaEdgeFunction(client, image, size, signal)
    },
  }
}
