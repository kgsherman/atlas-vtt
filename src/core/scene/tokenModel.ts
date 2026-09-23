/**
 * Token models (Token.model): a reference to the 3D figure a token is drawn with. Today the only
 * source is the free asset catalog ("free:<assetId>", category "token-models", ARCHITECTURE §4.3);
 * other sources (e.g. models uploaded with a scene) would get their own prefix.
 */

/** Asset ids: lowercase slugs (public.free_assets.id). */
export const FREE_ASSET_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export const TOKEN_MODEL_REF_RE = /^free:[a-z0-9][a-z0-9-]{0,63}$/

export type TokenModelSource = { source: "free"; assetId: string }

/** The reference of a free token model, or null for an invalid asset id. */
export function freeTokenModelRef(assetId: string): string | null {
  return FREE_ASSET_ID_RE.test(assetId) ? `free:${assetId}` : null
}

/** Where a reference points, or null when it is malformed. */
export function parseTokenModelRef(ref: unknown): TokenModelSource | null {
  if (typeof ref !== "string" || !TOKEN_MODEL_REF_RE.test(ref)) return null
  return { source: "free", assetId: ref.slice("free:".length) }
}
