/**
 * Token images players put on their own tokens (ARCHITECTURE §11, the `token-image` request). A player
 * may only use an image from THEIR folder of the public token image store (Supabase Storage bucket
 * `token-images`, `{userId}/{name}.png|webp`), never an arbitrary URL: a URL from a request would make
 * every client at the table fetch whatever host the player chose. The DM sets any image (scene edits).
 */

/** Object names inside a user's folder. */
export const TOKEN_IMAGE_NAME_RE = /^[A-Za-z0-9_-]{1,64}\.(png|webp)$/

/** User ids as folder names (Supabase: uuids; local mode: the same id alphabet). */
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** Longest URL a request may carry (the scene schema caps strings at 2000 characters). */
export const MAX_TOKEN_IMAGE_URL = 2000

/**
 * The public URL of a user's token image. `base` is the store's public URL prefix, ending in "/"
 * (e.g. `https://<ref>.supabase.co/storage/v1/object/public/token-images/`).
 */
export function tokenImageUrl(base: string, userId: string, name: string): string {
  return `${base}${userId}/${name}`
}

/**
 * Whether `userId` may put `url` on a token they control: exactly `{base}{userId}/{name}` with a
 * well-formed name (no query, fragment, dot segments or further folders). No store (`base` null, e.g.
 * local mode) allows nothing.
 */
export function playerTokenImageAllowed(url: string, base: string | null, userId: string): boolean {
  if (!base || !base.endsWith("/") || !/^https?:\/\//i.test(base)) return false
  if (!USER_ID_RE.test(userId) || userId === "__proto__") return false
  if (typeof url !== "string" || url.length > MAX_TOKEN_IMAGE_URL) return false
  const prefix = `${base}${userId}/`
  if (!url.startsWith(prefix)) return false
  return TOKEN_IMAGE_NAME_RE.test(url.slice(prefix.length))
}
