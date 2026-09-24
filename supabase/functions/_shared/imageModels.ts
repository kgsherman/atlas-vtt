// Atlas VTT: image models behind the Token Maker's AI tools (ARCHITECTURE §11).
//
// Model-agnostic: an endpoint asks `backgroundRemovalModel(env)` for the configured model and calls
// `removeBackground`; which provider and model run is configuration, never client input. Adding a
// provider means implementing `BackgroundRemovalModel` and registering it in PROVIDERS.
//
// Runtime-agnostic (fetch / FormData / Blob only): used by the Supabase Edge Function
// `remove-background` (Deno) and by the Vite dev server's /api endpoint (Node, dev/imageToolsApi.ts).
//
// Configuration (server-side secrets, never VITE_-prefixed):
//   IMAGE_MODEL_PROVIDER    "openai" (default)
//   OPENAI_API_KEY          required for "openai"
//   OPENAI_IMAGE_MODEL      default "gpt-image-2.5-sunburst"
//   OPENAI_IMAGE_QUALITY    low | medium | high | xhigh | max | auto (default "high")
//   OPENAI_IMAGE_SIZE       "match" (default: the input's aspect ratio, multiples of 16), "auto", or "WxH"
//   OPENAI_INPUT_FIDELITY   optional "high" | "low" (not sent unless set: some models always use high)
//   OPENAI_BASE_URL         default "https://api.openai.com/v1"

export type ImageToolErrorCode =
  /** No provider / key configured on the server. */
  | "not_configured"
  /** Malformed request (missing image, bad size). */
  | "invalid_argument"
  | "payload_too_large"
  | "not_authenticated"
  /** The caller's daily allowance is used up. */
  | "quota_exceeded"
  /** The model refused the image (moderation) or returned nothing usable. */
  | "rejected"
  /** The provider failed (outage, rate limit, bad configuration). */
  | "provider_error"

export class ImageToolError extends Error {
  readonly code: ImageToolErrorCode
  readonly status: number

  constructor(code: ImageToolErrorCode, message: string, status = STATUS[code]) {
    super(message)
    this.name = "ImageToolError"
    this.code = code
    this.status = status
  }
}

const STATUS: Record<ImageToolErrorCode, number> = {
  not_configured: 503,
  invalid_argument: 400,
  payload_too_large: 413,
  not_authenticated: 401,
  quota_exceeded: 429,
  rejected: 422,
  provider_error: 502,
}

export interface ImageInput {
  bytes: Uint8Array
  mime: "image/png" | "image/jpeg" | "image/webp"
  width: number
  height: number
}

export interface ImageOutput {
  bytes: Uint8Array
  mime: "image/png" | "image/webp"
}

export interface BackgroundRemovalModel {
  /** `provider:model`, for logs. */
  readonly id: string
  removeBackground(input: ImageInput, signal?: AbortSignal): Promise<ImageOutput>
}

export type EnvReader = (name: string) => string | undefined

export const REMOVE_BACKGROUND_PROMPT = "Remove the background of this image so that it is transparent. Keep the subject exactly as it is."

/** Uploads above this are refused before any model runs (the client sends ≤ 2048 px images). */
export const MAX_INPUT_BYTES = 12 * 1024 * 1024
export const MAX_INPUT_SIDE = 4096

const INPUT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"])

// ---------------------------------------------------------------------------
// Request parsing (shared by every endpoint)
// ---------------------------------------------------------------------------

/** The multipart request of `remove-background`: `image` (PNG / JPEG / WebP), `width`, `height`. */
export async function readImageForm(form: FormData): Promise<ImageInput> {
  const image = form.get("image")
  if (!image || typeof image === "string") throw new ImageToolError("invalid_argument", "expected an image file in the `image` field")
  if (!INPUT_TYPES.has(image.type)) throw new ImageToolError("invalid_argument", "the image must be PNG, JPEG or WebP")
  if (image.size > MAX_INPUT_BYTES) throw new ImageToolError("payload_too_large", `the image is larger than ${MAX_INPUT_BYTES / 1048576} MB`)
  const width = Number(form.get("width"))
  const height = Number(form.get("height"))
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_INPUT_SIDE || height > MAX_INPUT_SIDE) {
    throw new ImageToolError("invalid_argument", `width and height must be whole numbers from 1 to ${MAX_INPUT_SIDE}`)
  }
  return { bytes: new Uint8Array(await image.arrayBuffer()), mime: image.type as ImageInput["mime"], width, height }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const PROVIDERS: Record<string, (env: EnvReader) => BackgroundRemovalModel> = {
  openai: openAiModel,
}

/** The configured background removal model. Throws not_configured when the server has none. */
export function backgroundRemovalModel(env: EnvReader): BackgroundRemovalModel {
  const name = (env("IMAGE_MODEL_PROVIDER") ?? "openai").trim().toLowerCase()
  const make = Object.hasOwn(PROVIDERS, name) ? PROVIDERS[name] : undefined
  if (!make) throw new ImageToolError("not_configured", `unknown image model provider "${name}"`)
  return make(env)
}

const round16 = (v: number) => Math.max(16, Math.round(v / 16) * 16)

/**
 * An output size with the input's aspect ratio for gpt-image models (sides multiples of 16, 480..3840,
 * ratio ≤ 3:1): the long side is the input's, kept within 1024..1536 (the Token Maker never needs
 * more), the short side at least 480. "auto" when the ratio is out of range.
 */
export function matchingSize(width: number, height: number): string {
  const ratio = width / height
  if (!(ratio > 0) || ratio > 3 || ratio < 1 / 3) return "auto"
  const long = Math.min(1536, Math.max(1024, Math.max(width, height)))
  let w = ratio >= 1 ? long : long * ratio
  let h = ratio >= 1 ? long / ratio : long
  const short = Math.min(w, h)
  if (short < 480) {
    const k = 480 / short
    w *= k
    h *= k
  }
  return `${Math.min(3840, round16(w))}x${Math.min(3840, round16(h))}`
}

const QUALITIES = new Set(["low", "medium", "high", "xhigh", "max", "auto"])

function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** OpenAI GPT Image models through the Images edit endpoint, with a transparent PNG background. */
function openAiModel(env: EnvReader): BackgroundRemovalModel {
  const key = env("OPENAI_API_KEY")?.trim()
  if (!key) throw new ImageToolError("not_configured", "OPENAI_API_KEY is not set on the server")
  const model = env("OPENAI_IMAGE_MODEL")?.trim() || "gpt-image-2.5-sunburst"
  const qualityEnv = env("OPENAI_IMAGE_QUALITY")?.trim().toLowerCase()
  const quality = qualityEnv && QUALITIES.has(qualityEnv) ? qualityEnv : "high"
  const sizeEnv = env("OPENAI_IMAGE_SIZE")?.trim().toLowerCase() || "match"
  const fidelity = env("OPENAI_INPUT_FIDELITY")?.trim().toLowerCase()
  const base = (env("OPENAI_BASE_URL")?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "")

  return {
    id: `openai:${model}`,
    async removeBackground(input, signal) {
      const ext = input.mime === "image/jpeg" ? "jpg" : input.mime === "image/webp" ? "webp" : "png"
      const form = new FormData()
      form.append("model", model)
      form.append("image", new Blob([input.bytes.slice()], { type: input.mime }), `image.${ext}`)
      form.append("prompt", REMOVE_BACKGROUND_PROMPT)
      // Transparency needs an alpha-capable output format.
      form.append("background", "transparent")
      form.append("output_format", "png")
      form.append("quality", quality)
      form.append("size", sizeEnv === "match" ? matchingSize(input.width, input.height) : sizeEnv)
      form.append("n", "1")
      if (fidelity === "high" || fidelity === "low") form.append("input_fidelity", fidelity)

      let res: Response
      try {
        res = await fetch(`${base}/images/edits`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form, signal })
      } catch (err) {
        if (signal?.aborted) throw err
        throw new ImageToolError("provider_error", `could not reach the image model (${err instanceof Error ? err.message : String(err)})`)
      }
      const body = (await res.json().catch(() => null)) as {
        data?: Array<{ b64_json?: unknown }>
        error?: { message?: unknown; code?: unknown; type?: unknown }
      } | null
      if (!res.ok) {
        const message = typeof body?.error?.message === "string" ? body.error.message : `HTTP ${res.status}`
        const code = `${String(body?.error?.code ?? "")} ${String(body?.error?.type ?? "")}`
        if (/moderation|safety|content_policy/i.test(code)) throw new ImageToolError("rejected", `the image model refused this image: ${message}`)
        throw new ImageToolError("provider_error", `the image model failed: ${message}`)
      }
      const b64 = body?.data?.[0]?.b64_json
      if (typeof b64 !== "string" || b64.length === 0) throw new ImageToolError("rejected", "the image model returned no image")
      return { bytes: bytesFromBase64(b64), mime: "image/png" }
    },
  }
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = ""
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(bin)
}

/** The JSON body every endpoint answers with on success. */
export function imageResult(out: ImageOutput, model: string): { image: string; mime: string; model: string } {
  return { image: bytesToBase64(out.bytes), mime: out.mime, model }
}

/** `{ error, detail }` for a failure (ImageToolError or anything else). */
export function errorBody(err: unknown): { status: number; body: { error: string; detail: string } } {
  if (err instanceof ImageToolError) return { status: err.status, body: { error: err.code, detail: err.message } }
  return { status: 500, body: { error: "provider_error", detail: err instanceof Error ? err.message : String(err) } }
}
