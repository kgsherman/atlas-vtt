/**
 * Identity. Online, every user (DM or player) is a Supabase user; people who have not signed up are
 * anonymous users (`signInAnonymously`), persisted in localStorage so a reload keeps the identity
 * (and with it session membership). Display names live in `profiles` (own row only).
 *
 * Local-only mode has no server identity: `localIdentity()` hands out a random per-TAB id so two
 * tabs of one browser can play DM and player over the (insecure, dev-only) LocalTransport.
 */
import { isAuthApiError, isAuthRetryableFetchError, type User } from "@supabase/supabase-js"

import { isSupabaseConfigured } from "./env"
import { getSupabase, NetError, unwrap, type AtlasClient } from "./supabase"

export interface AtlasIdentity {
  userId: string
  isAnonymous: boolean
  displayName: string | null
  mode: "supabase" | "local"
}

export const DISPLAY_NAME_MAX = 32

/**
 * Mirrors private.normalize_display_name(): collapse whitespace, trim, 1..32 characters (code
 * points), no control characters. null when invalid.
 */
export function normalizeDisplayName(name: string): string | null {
  const n = name.replace(/\s+/gu, " ").trim()
  const length = [...n].length
  // eslint-disable-next-line no-control-regex
  if (length < 1 || length > DISPLAY_NAME_MAX || /[\u0000-\u001f\u007f]/u.test(n)) return null
  return n
}

/** Map an auth-js error to a typed NetError with an actionable code. */
export function mapAuthError(err: unknown): NetError {
  if (err instanceof NetError) return err
  const e = err as { code?: unknown; status?: unknown; message?: unknown } | null
  const code = typeof e?.code === "string" ? e.code : ""
  const status = typeof e?.status === "number" ? e.status : null
  const message = typeof e?.message === "string" ? e.message : undefined
  if (code === "anonymous_provider_disabled" || code === "signup_disabled") {
    return new NetError(
      "anonymous_disabled",
      "Anonymous sign-ins are disabled for this Supabase project: enable them in the dashboard under Authentication → Sign In / Providers → Anonymous sign-ins",
      { cause: err }
    )
  }
  if (code === "over_request_rate_limit" || status === 429) return new NetError("rate_limited", message, { cause: err })
  if (code === "captcha_failed") return new NetError("captcha_required", message, { cause: err })
  if (isAuthRetryableFetchError(err) || status === 0) return new NetError("network", message, { cause: err })
  return new NetError("unknown", message ?? code, { cause: err })
}

const inFlight = new WeakMap<AtlasClient, Promise<AtlasIdentity>>()

/**
 * Resolve the current user, signing in anonymously when there is no session. Concurrent callers
 * share one sign-in. Throws NetError: not_configured | anonymous_disabled | rate_limited |
 * captcha_required | network | unknown.
 */
export function ensureSession(client: AtlasClient = getSupabase()): Promise<AtlasIdentity> {
  let pending = inFlight.get(client)
  if (!pending) {
    pending = ensureSessionOnce(client).finally(() => inFlight.delete(client))
    inFlight.set(client, pending)
  }
  return pending
}

async function ensureSessionOnce(client: AtlasClient): Promise<AtlasIdentity> {
  let user: User | null = null
  const { data, error } = await client.auth.getSession()
  if (error) {
    // A stored session the server no longer accepts (refresh token revoked, user deleted): drop it
    // locally and start a fresh anonymous identity. Network failures are reported as such.
    if (!isAuthApiError(error)) throw mapAuthError(error)
    await client.auth.signOut({ scope: "local" })
  } else {
    user = data.session?.user ?? null
  }
  if (!user) {
    const res = await client.auth.signInAnonymously()
    if (res.error) throw mapAuthError(res.error)
    user = res.data.user
    if (!user) throw new NetError("unknown", "anonymous sign-in returned no user")
  }
  return {
    userId: user.id,
    isAnonymous: user.is_anonymous ?? false,
    displayName: await fetchDisplayName(client, user.id),
    mode: "supabase",
  }
}

async function fetchDisplayName(client: AtlasClient, userId: string): Promise<string | null> {
  const row = unwrap(await client.from("profiles").select("display_name").eq("id", userId).maybeSingle())
  return row?.display_name ?? null
}

/** Set the caller's profile display name (validated server-side too). Returns the stored name. */
export async function setDisplayName(name: string, client: AtlasClient = getSupabase()): Promise<string> {
  const normalized = normalizeDisplayName(name)
  if (!normalized) throw new NetError("invalid_display_name", `display names are 1 to ${DISPLAY_NAME_MAX} characters`)
  const stored = unwrap(await client.rpc("set_display_name", { p_display_name: normalized }))
  if (typeof stored !== "string") throw new NetError("unknown", "set_display_name returned no name")
  return stored
}

export async function signOut(client: AtlasClient = getSupabase()): Promise<void> {
  const { error } = await client.auth.signOut({ scope: "local" })
  if (error) throw mapAuthError(error)
}

/** Subscribe to sign-in/out. The callback receives the user id or null. */
export function onAuthChange(cb: (userId: string | null) => void, client: AtlasClient = getSupabase()): () => void {
  const { data } = client.auth.onAuthStateChange((_event, session) => cb(session?.user.id ?? null))
  return () => data.subscription.unsubscribe()
}

// ---------------------------------------------------------------------------
// Local-only mode
// ---------------------------------------------------------------------------

const LOCAL_USER_KEY = "atlas-vtt:local-user-id"
const LOCAL_NAME_KEY = "atlas-vtt:display-name"
const memoryStorage = new Map<string, string>()

function storageGet(kind: "session" | "local", key: string): string | null {
  try {
    const storage = kind === "session" ? globalThis.sessionStorage : globalThis.localStorage
    if (storage) return storage.getItem(key)
  } catch {
    // Storage can throw (privacy mode, sandboxed iframes): fall through to memory.
  }
  return memoryStorage.get(`${kind}:${key}`) ?? null
}

function storageSet(kind: "session" | "local", key: string, value: string): void {
  try {
    const storage = kind === "session" ? globalThis.sessionStorage : globalThis.localStorage
    if (storage) {
      storage.setItem(key, value)
      return
    }
  } catch {
    // see storageGet
  }
  memoryStorage.set(`${kind}:${key}`, value)
}

/** Per-tab identity for local-only mode (no authentication — dev/offline only). */
export function localIdentity(): AtlasIdentity {
  let id = storageGet("session", LOCAL_USER_KEY)
  if (!id) {
    id = crypto.randomUUID()
    storageSet("session", LOCAL_USER_KEY, id)
  }
  return { userId: id, isAnonymous: true, displayName: storageGet("local", LOCAL_NAME_KEY), mode: "local" }
}

export function setLocalDisplayName(name: string): string {
  const normalized = normalizeDisplayName(name)
  if (!normalized) throw new NetError("invalid_display_name", `display names are 1 to ${DISPLAY_NAME_MAX} characters`)
  storageSet("local", LOCAL_NAME_KEY, normalized)
  return normalized
}

/** Supabase identity when configured, otherwise the local per-tab identity. */
export async function ensureIdentity(): Promise<AtlasIdentity> {
  return isSupabaseConfigured() ? ensureSession() : localIdentity()
}
