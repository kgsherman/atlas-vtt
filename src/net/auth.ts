/**
 * Identity. Online, every user (DM or player) is a Supabase user; people who have not signed up are
 * anonymous users ("guests", `signInAnonymously`), persisted in localStorage so a reload keeps the
 * identity (and with it session membership). Display names live in `profiles` (own row only) and are
 * Atlas's own: they never follow the name of a linked sign-in account.
 *
 * Permanent accounts: a guest links a provider identity (`linkAccount`, Discord) and keeps its user id,
 * so everything it owns stays. Someone who already has an account signs in to it instead
 * (`signInWithProvider`). Both leave the page for the provider and come back through the PKCE code
 * handled by `parseAuthCallback` / `exchangeAuthCode` (orchestrated by app/account.ts).
 *
 * Local-only mode has no server identity: `localIdentity()` hands out a random per-TAB id so two
 * tabs of one browser can play DM and player over the (insecure, dev-only) LocalTransport.
 */
import { isAuthApiError, isAuthRetryableFetchError, type User, type UserIdentity } from "@supabase/supabase-js"

import { isSupabaseConfigured } from "./env"
import { getSupabase, NetError, unwrap, type AtlasClient } from "./supabase"

export interface AtlasIdentity {
  userId: string
  isAnonymous: boolean
  displayName: string | null
  mode: "supabase" | "local"
  /** The sign-in account of a permanent user; absent for guests and in local mode. */
  account?: AtlasAccount
}

/** OAuth providers Atlas offers for permanent accounts. */
export const ACCOUNT_PROVIDERS = ["discord"] as const
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number]

export interface AtlasAccount {
  /** "discord", or another Supabase provider ("email", …) for accounts made outside the app. */
  provider: string
  /** The provider's name for the user. Shown only as "signed in as"; players see `displayName`. */
  name: string | null
  /** https avatar from the provider, if any. */
  avatarUrl: string | null
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
  if (code === "manual_linking_disabled") return new NetError("linking_disabled", message, { cause: err })
  if (code === "identity_already_exists") return new NetError("identity_exists", message, { cause: err })
  if (code === "provider_disabled" || code === "oauth_provider_not_supported") return new NetError("provider_disabled", message, { cause: err })
  if (code === "access_denied") return new NetError("auth_cancelled", message, { cause: err })
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
  } else if (user.is_anonymous) {
    user = await refreshIfLinked(client, user)
  }
  return {
    userId: user.id,
    isAnonymous: user.is_anonymous ?? false,
    displayName: await fetchDisplayName(client, user.id),
    mode: "supabase",
    ...withAccount(accountFromUser(user)),
  }
}

/**
 * A stored guest session may be stale: the server links the identity before redirecting back, so a
 * link whose callback never completed here (or finished in another tab) leaves a permanent user behind
 * a token that still says anonymous. Ask the server, and refresh the token so its claims match.
 * Failures keep the stored user.
 */
async function refreshIfLinked(client: AtlasClient, user: User): Promise<User> {
  const fresh = await client.auth.getUser()
  if (fresh.error || !fresh.data.user || fresh.data.user.is_anonymous) return user
  const refreshed = await client.auth.refreshSession()
  return refreshed.data.user ?? fresh.data.user
}

function withAccount(account: AtlasAccount | undefined): { account?: AtlasAccount } {
  return account ? { account } : {}
}

type AccountUser = Pick<User, "is_anonymous" | "email" | "user_metadata"> & { identities?: Pick<UserIdentity, "provider" | "identity_data">[] }

function firstText(...values: unknown[]): string | null {
  for (const v of values) if (typeof v === "string" && v.trim()) return v.trim()
  return null
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null
  try {
    return new URL(value).protocol === "https:" ? value : null
  } catch {
    return null
  }
}

/** The sign-in account of a Supabase user; undefined for anonymous users. */
export function accountFromUser(user: AccountUser): AtlasAccount | undefined {
  if (user.is_anonymous) return undefined
  const identity = user.identities?.find((i) => i.provider !== "anonymous")
  const data: Record<string, unknown> = { ...user.user_metadata, ...identity?.identity_data }
  const claims = data.custom_claims && typeof data.custom_claims === "object" ? (data.custom_claims as Record<string, unknown>) : {}
  return {
    provider: identity?.provider ?? "email",
    // Discord: custom_claims.global_name / full_name is the display name, name the unique username.
    name: firstText(claims.global_name, data.full_name, data.name, data.user_name, user.email),
    avatarUrl: httpsUrl(data.avatar_url ?? data.picture),
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

/** Subscribe to sign-in/out and account changes (a guest linking an account in another tab). */
export function onAuthChange(cb: (user: { id: string; isAnonymous: boolean } | null) => void, client: AtlasClient = getSupabase()): () => void {
  const { data } = client.auth.onAuthStateChange((_event, session) =>
    cb(session ? { id: session.user.id, isAnonymous: session.user.is_anonymous ?? false } : null)
  )
  return () => data.subscription.unsubscribe()
}

// ---------------------------------------------------------------------------
// Permanent accounts (OAuth)
// ---------------------------------------------------------------------------

export interface OAuthRedirectOptions {
  /** Absolute URL the provider returns to (must be in the project's redirect allow list). */
  redirectTo: string
  /** Skip the provider's consent screen when the user has already authorised Atlas (Discord `prompt=none`). */
  silent?: boolean
}

/**
 * Link a provider identity to the current (guest) user, making it permanent under the same user id.
 * Navigates to the provider. Needs "Allow manual linking" in the project (else `linking_disabled`); if
 * the provider account already belongs to another user, the callback carries `identity_already_exists`.
 */
export async function linkAccount(provider: AccountProvider, opts: OAuthRedirectOptions, client: AtlasClient = getSupabase()): Promise<void> {
  const { error } = await client.auth.linkIdentity({ provider, options: { redirectTo: opts.redirectTo } })
  if (error) throw mapAuthError(error)
}

/** Sign in to (or sign up with) a provider account, replacing the current session. Navigates away. */
export async function signInWithProvider(provider: AccountProvider, opts: OAuthRedirectOptions, client: AtlasClient = getSupabase()): Promise<void> {
  const { error } = await client.auth.signInWithOAuth({
    provider,
    options: { redirectTo: opts.redirectTo, ...(opts.silent ? { queryParams: { prompt: "none" } } : {}) },
  })
  if (error) throw mapAuthError(error)
}

export type AuthCallback = { kind: "code"; code: string } | { kind: "error"; error: NetError }

/**
 * Read an OAuth redirect URL: a PKCE `code`, or an error (`error_code` / `error` +
 * `error_description`, in the query or, for some failures, the fragment). null when neither.
 */
export function parseAuthCallback(href: string): AuthCallback | null {
  const url = new URL(href)
  const query = url.searchParams
  const hash = new URLSearchParams(url.hash.replace(/^#/, ""))
  const get = (key: string) => query.get(key) ?? hash.get(key)
  const errorCode = get("error_code") ?? get("error")
  if (errorCode) return { kind: "error", error: mapAuthError({ code: errorCode, message: get("error_description") ?? errorCode }) }
  const code = query.get("code")
  return code ? { kind: "code", code } : null
}

/** Exchange a PKCE code (from /auth/callback) for a session in this browser. */
export async function exchangeAuthCode(code: string, client: AtlasClient = getSupabase()): Promise<void> {
  const { error } = await client.auth.exchangeCodeForSession(code)
  if (error) throw mapAuthError(error)
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
