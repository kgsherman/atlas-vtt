/**
 * The app's single Supabase client plus the typed error model shared by the repositories.
 *
 * Realtime runs with `worker: true` in browsers so heartbeats keep flowing while the DM's tab is in
 * the background (timers in hidden tabs are throttled). Node/Vitest have no `Worker`, so the flag
 * follows the environment there.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js"

import type { Database } from "./database.types"
import { supabaseEnv, type SupabaseEnv } from "./env"

export type AtlasClient = SupabaseClient<Database>

export interface AtlasClientOptions {
  /** Default: true when the environment has Web Workers (browsers). */
  worker?: boolean
  /** Default: true (localStorage). Tests use false (in-memory). */
  persistSession?: boolean
  storageKey?: string
}

export function createAtlasClient(env: SupabaseEnv, opts: AtlasClientOptions = {}): AtlasClient {
  const worker = opts.worker ?? typeof Worker !== "undefined"
  return createClient<Database>(env.url, env.publishableKey, {
    auth: {
      persistSession: opts.persistSession ?? true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      flowType: "pkce",
      ...(opts.storageKey ? { storageKey: opts.storageKey } : {}),
    },
    realtime: { worker },
  })
}

let appClient: AtlasClient | null | undefined

/** The app-wide client, or null in local-only mode. */
export function getSupabaseOrNull(): AtlasClient | null {
  if (appClient === undefined) {
    const env = supabaseEnv()
    appClient = env ? createAtlasClient(env) : null
  }
  return appClient
}

/** The app-wide client; throws NetError("not_configured") in local-only mode. */
export function getSupabase(): AtlasClient {
  const client = getSupabaseOrNull()
  if (!client) throw new NetError("not_configured", "Supabase is not configured (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY)")
  return client
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Stable codes raised by the SQL RPCs (`raise exception '<code>'`, see supabase/migrations) plus
 * client-side conditions.
 */
export const SERVER_ERROR_CODES = [
  "not_authenticated",
  "not_found",
  "forbidden",
  "invalid_argument",
  "payload_too_large",
  "version_conflict",
  "stale_epoch",
  "session_ended",
  "session_not_found",
  "invalid_room_code",
  "invalid_display_name",
  "is_dm",
  "kicked",
  "session_full",
  "too_many_sessions",
  "room_code_unavailable",
  "not_member",
  "quota_exceeded",
  "name_taken",
] as const

export type ServerErrorCode = (typeof SERVER_ERROR_CODES)[number]

export type NetErrorCode =
  | ServerErrorCode
  | "not_configured"
  | "anonymous_disabled"
  | "linking_disabled"
  | "identity_exists"
  | "provider_disabled"
  | "auth_cancelled"
  | "rate_limited"
  | "captcha_required"
  | "network"
  | "permission_denied"
  | "unsupported_offline"
  | "invalid_data"
  | "unknown"

export class NetError extends Error {
  readonly code: NetErrorCode
  readonly detail: string | undefined

  constructor(code: NetErrorCode, detail?: string, options?: { cause?: unknown }) {
    super(detail ? `${code}: ${detail}` : code, options)
    this.name = "NetError"
    this.code = code
    this.detail = detail
  }
}

export function isNetError(err: unknown, code?: NetErrorCode): err is NetError {
  return err instanceof NetError && (code === undefined || err.code === code)
}

const serverCodes = new Set<string>(SERVER_ERROR_CODES)

interface PostgrestLikeError {
  message?: unknown
  code?: unknown
  details?: unknown
}

/** Map a PostgREST / fetch / unknown error to a NetError. */
export function toNetError(err: unknown): NetError {
  if (err instanceof NetError) return err
  if (err && typeof err === "object") {
    const e = err as PostgrestLikeError
    const message = typeof e.message === "string" ? e.message : ""
    const code = typeof e.code === "string" ? e.code : ""
    const details = typeof e.details === "string" && e.details ? e.details : undefined
    if (serverCodes.has(message)) return new NetError(message as ServerErrorCode, details, { cause: err })
    if (code === "42501") return new NetError("permission_denied", message || details, { cause: err })
    if (code === "PGRST301" || code === "PGRST302" || /jwt/i.test(message)) return new NetError("not_authenticated", message, { cause: err })
    if (code === "PGRST116") return new NetError("not_found", message, { cause: err })
    if (/fetch|network|Failed to fetch|ECONN|ETIMEDOUT/i.test(message)) return new NetError("network", message, { cause: err })
    return new NetError("unknown", message || code || undefined, { cause: err })
  }
  return new NetError("unknown", typeof err === "string" ? err : undefined, { cause: err })
}

/** Unwrap a supabase-js `{ data, error }` result, throwing a NetError on failure. */
export function unwrap<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw toNetError(result.error)
  return result.data
}

/** Short user-facing explanation for an error code (UI copy). */
export function describeNetError(code: NetErrorCode): string {
  switch (code) {
    case "not_configured":
      return "Online features are unavailable: Supabase is not configured, so Atlas is running in local-only mode."
    case "anonymous_disabled":
      return "Anonymous sign-ins are disabled for this Supabase project. Enable them in the dashboard (Authentication → Sign In / Providers → Anonymous)."
    case "linking_disabled":
      return "Accounts can't be created yet: this Supabase project doesn't allow linking. Enable it in the dashboard (Authentication → Sign In / Providers → Allow manual linking)."
    case "identity_exists":
      return "That account already belongs to another Atlas user."
    case "provider_disabled":
      return "This sign-in method is not enabled for this Supabase project."
    case "auth_cancelled":
      return "Sign-in was cancelled."
    case "rate_limited":
      return "Too many requests. Please wait a moment and try again."
    case "captcha_required":
      return "Sign-in requires a CAPTCHA, which Atlas does not support. Disable CAPTCHA protection for anonymous sign-ins."
    case "network":
      return "Could not reach the server. Check your connection."
    case "not_authenticated":
      return "You are not signed in."
    case "permission_denied":
    case "forbidden":
      return "You do not have permission to do that."
    case "not_found":
      return "Not found (or you do not have access)."
    case "invalid_argument":
    case "invalid_data":
      return "The data was not valid."
    case "payload_too_large":
      return "The data is too large to save."
    case "version_conflict":
      return "This scene was saved elsewhere in the meantime."
    case "stale_epoch":
      return "Another window has taken over hosting this session."
    case "session_ended":
      return "This session has ended."
    case "session_not_found":
      return "No active session uses that room code."
    case "invalid_room_code":
      return "Room codes are 8 letters and digits."
    case "invalid_display_name":
      return "Names must be 1 to 32 characters."
    case "is_dm":
      return "You are the DM of this session: open it from your scene library instead."
    case "kicked":
      return "The DM removed you from this session."
    case "session_full":
      return "This session is full."
    case "too_many_sessions":
      return "You have too many active sessions. End one first."
    case "room_code_unavailable":
      return "Could not allocate a room code. Try again."
    case "not_member":
      return "That player is not an active member of the session."
    case "quota_exceeded":
      return "You have reached your storage limit. Delete old scenes, versions or map images first."
    case "name_taken":
      return "That name is taken in this session (by another player or the DM). Pick another one."
    case "unsupported_offline":
      return "This needs an online connection (Supabase)."
    case "unknown":
      return "Something went wrong."
  }
}
