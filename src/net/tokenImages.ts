/**
 * Token images for games (ARCHITECTURE §11): the Token Maker uploads the finished token to the PUBLIC
 * Storage bucket `token-images` under the user's folder (`{userId}/{sha256}.{png|webp}`, migration
 * *_token_maker.sql: own folder only, per-user quota), and the game token's `imageUrl` becomes its
 * public URL, which every client at the table can load without a grant. Names are content hashes, so
 * applying the same image twice stores it once.
 *
 * Local mode has no store (`available` false): tokens can be downloaded, not applied to a game.
 */
import { TOKEN_IMAGE_NAME_RE, tokenImageUrl } from "@/core/session/tokenImages"

import { supabaseEnv } from "./env"
import { NetError, toNetError, type AtlasClient } from "./supabase"

export const TOKEN_IMAGES_BUCKET = "token-images"
/** Largest upload (the bucket's file_size_limit). */
export const MAX_TOKEN_IMAGE_BYTES = 4 * 1024 * 1024

export interface TokenImageStore {
  readonly available: boolean
  /** Public URL prefix of the bucket, ending in "/" (what the host checks player images against). */
  readonly publicBase: string | null
  /** Store a PNG / WebP token image; returns its public URL. */
  put(image: Blob): Promise<string>
}

/** The public URL prefix of the token image bucket for a Supabase project URL. */
export function tokenImagesBase(projectUrl: string): string {
  return `${projectUrl.replace(/\/+$/, "")}/storage/v1/object/public/${TOKEN_IMAGES_BUCKET}/`
}

async function contentName(image: Blob, ext: "png" | "webp"): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await image.arrayBuffer()))
  let hex = ""
  for (let i = 0; i < 16; i++) hex += digest[i].toString(16).padStart(2, "0")
  return `${hex}.${ext}`
}

export function createRemoteTokenImageStore(client: AtlasClient, userId: string, base = tokenImagesBase(supabaseEnv()?.url ?? "")): TokenImageStore {
  return {
    available: true,
    publicBase: base,
    async put(image) {
      const ext = image.type === "image/webp" ? "webp" : image.type === "image/png" ? "png" : null
      if (!ext) throw new NetError("invalid_argument", "token images are PNG or WebP")
      if (image.size > MAX_TOKEN_IMAGE_BYTES) throw new NetError("payload_too_large", "the token image is larger than 4 MB")
      const name = await contentName(image, ext)
      if (!TOKEN_IMAGE_NAME_RE.test(name)) throw new NetError("unknown", "could not name the token image")
      const { error } = await client.storage.from(TOKEN_IMAGES_BUCKET).upload(`${userId}/${name}`, image, {
        contentType: image.type,
        cacheControl: "31536000",
        upsert: false,
      })
      // Content-addressed: "already exists" is the same bytes.
      if (error && !/exist|duplicate/i.test(error.message)) {
        if (/row-level security|policy/i.test(error.message)) throw new NetError("quota_exceeded", "you have stored too many token images", { cause: error })
        throw toNetError(error)
      }
      return tokenImageUrl(base, userId, name)
    },
  }
}

export function createLocalTokenImageStore(): TokenImageStore {
  return {
    available: false,
    publicBase: null,
    put: () => Promise.reject(new NetError("unsupported_offline", "applying tokens to a game needs Atlas Cloud")),
  }
}
