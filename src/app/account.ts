/**
 * Permanent accounts (Cloud mode only). Everyone starts as an anonymous guest. "Continue with Discord"
 * first tries to LINK Discord to the guest: the user id stays, so scenes, sessions and memberships are
 * kept and the guest simply becomes permanent. If that Discord account already belongs to another
 * Atlas user, the redirect comes back with `identity_exists` and the app SIGNS IN to that account
 * instead (AccountRedirectNotice). A guest that made something first takes a merge ticket along
 * (net/guestMerge.ts): after the sign-in, the account takes over the guest's scenes and games.
 *
 * OAuth leaves the page. What the user was doing (intent, provider, path to return to) survives the
 * round trip in sessionStorage; `finishAuthRedirect` consumes it on /auth/callback, exchanges the PKCE
 * code and puts the return path back in the address bar, all before services start (so the callback
 * page never signs in a fresh guest first).
 */
import { ACCOUNT_PROVIDERS, exchangeAuthCode, linkAccount, parseAuthCallback, signInWithProvider, type AccountProvider } from "@/net/auth"
import { MERGE_TICKET_RE, mergeGuest, type GuestMergeResult } from "@/net/guestMerge"
import { NetError, type AtlasClient } from "@/net/supabase"

import type { KeyValueStorage } from "./mode"

export const AUTH_CALLBACK_PATH = "/auth/callback"

const PENDING_KEY = "atlas-vtt:auth-pending"

export type AccountIntent = "link" | "sign_in"

interface PendingAuth {
  intent: AccountIntent
  provider: AccountProvider
  returnTo: string
  /** sign_in from a guest with scenes or games: the guest's merge ticket. */
  mergeTicket?: string
}

/** What happened to the guest a sign-in took a merge ticket for. */
export type GuestMergeOutcome = { ok: true; result: GuestMergeResult } | { ok: false; error: NetError; ticket: string }

export type AuthRedirectOutcome =
  /** A guest became permanent (same user id). */
  | { kind: "linked"; provider: AccountProvider }
  /** Signed in to an existing account (or created one without a guest to keep). */
  | { kind: "signed_in"; provider: AccountProvider; merge?: GuestMergeOutcome }
  | { kind: "error"; intent: AccountIntent | null; provider: AccountProvider; error: NetError }

/**
 * An in-app path to return to after the redirect: same-origin absolute paths only (no `//host`, no
 * scheme), never the callback itself. Anything else becomes "/".
 */
export function safeReturnPath(path: string | null | undefined): string {
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/\\")) return "/"
  let url: URL
  try {
    url = new URL(path, "https://atlas.invalid")
  } catch {
    return "/"
  }
  if (url.origin !== "https://atlas.invalid" || url.pathname === AUTH_CALLBACK_PATH) return "/"
  return `${url.pathname}${url.search}${url.hash}`
}

function sessionStorageOrNull(): KeyValueStorage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

function readPending(storage: KeyValueStorage | null): PendingAuth | null {
  let raw: string | null
  try {
    raw = storage?.getItem(PENDING_KEY) ?? null
    storage?.removeItem(PENDING_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<PendingAuth>
    if ((v.intent !== "link" && v.intent !== "sign_in") || !isAccountProvider(v.provider)) return null
    const pending: PendingAuth = { intent: v.intent, provider: v.provider, returnTo: safeReturnPath(v.returnTo) }
    if (v.intent === "sign_in" && typeof v.mergeTicket === "string" && MERGE_TICKET_RE.test(v.mergeTicket)) pending.mergeTicket = v.mergeTicket
    return pending
  } catch {
    return null
  }
}

export interface BeginAccountOptions {
  /** Path to come back to. Default: the current path. */
  returnTo?: string
  /** Skip the provider's consent screen (the user just authorised Atlas while trying to link). */
  silent?: boolean
  /** sign_in only: the current guest's merge ticket, redeemed once signed in. */
  mergeTicket?: string
  storage?: KeyValueStorage | null
}

/**
 * Leave for the provider: `link` makes the current guest permanent, `sign_in` switches to the
 * provider's account. Resolves just before the browser navigates; throws NetError (linking_disabled,
 * provider_disabled, network, …) without leaving.
 */
export async function beginAccountRedirect(
  client: AtlasClient,
  intent: AccountIntent,
  provider: AccountProvider,
  opts: BeginAccountOptions = {}
): Promise<void> {
  const storage = opts.storage === undefined ? sessionStorageOrNull() : opts.storage
  const pending: PendingAuth = {
    intent,
    provider,
    returnTo: safeReturnPath(opts.returnTo ?? `${location.pathname}${location.search}`),
    ...(intent === "sign_in" && opts.mergeTicket ? { mergeTicket: opts.mergeTicket } : {}),
  }
  try {
    storage?.setItem(PENDING_KEY, JSON.stringify(pending))
  } catch {
    // Storage blocked: the callback still signs in, then returns home.
  }
  const redirectTo = `${location.origin}${AUTH_CALLBACK_PATH}`
  try {
    if (intent === "link") await linkAccount(provider, { redirectTo }, client)
    else await signInWithProvider(provider, { redirectTo, silent: opts.silent }, client)
  } catch (err) {
    try {
      storage?.removeItem(PENDING_KEY)
    } catch {
      // see above
    }
    throw err
  }
}

export interface FinishAuthRedirectEnv {
  href: string
  replaceUrl(path: string): void
  storage: KeyValueStorage | null
  /** Default: the merge-guest Edge Function, as the account just signed in. */
  mergeGuest?(ticket: string): Promise<GuestMergeResult>
}

function browserEnv(): FinishAuthRedirectEnv {
  return {
    href: location.href,
    replaceUrl: (path) => history.replaceState(null, "", path),
    storage: sessionStorageOrNull(),
  }
}

function asNetError(err: unknown): NetError {
  return err instanceof NetError ? err : new NetError("unknown", String(err), { cause: err })
}

/**
 * On /auth/callback: exchange the code (or read the error), merge the guest the sign-in took a ticket
 * for, restore the path the user left from, and report what happened. null on any other page. Never
 * throws: failures come back as `error` outcomes (the existing session, if any, stays) or as a failed
 * `merge` (the ticket is returned so the user can retry within its hour).
 */
export async function finishAuthRedirect(client: AtlasClient, env: FinishAuthRedirectEnv = browserEnv()): Promise<AuthRedirectOutcome | null> {
  const url = new URL(env.href)
  if (url.pathname !== AUTH_CALLBACK_PATH) return null
  const pending = readPending(env.storage)
  const provider = pending?.provider ?? "discord"
  const intent = pending?.intent ?? null
  const callback = parseAuthCallback(env.href)
  let outcome: AuthRedirectOutcome
  if (!callback) {
    outcome = { kind: "error", intent, provider, error: new NetError("unknown", "the sign-in redirect carried no result") }
  } else if (callback.kind === "error") {
    outcome = { kind: "error", intent, provider, error: callback.error }
  } else {
    try {
      await exchangeAuthCode(callback.code, client)
      if (intent === "link") {
        outcome = { kind: "linked", provider }
      } else {
        outcome = { kind: "signed_in", provider }
        const ticket = pending?.mergeTicket
        if (ticket) {
          const merge = env.mergeGuest ?? ((t: string) => mergeGuest(t, client))
          try {
            outcome.merge = { ok: true, result: await merge(ticket) }
          } catch (err) {
            outcome.merge = { ok: false, error: asNetError(err), ticket }
          }
        }
      }
    } catch (err) {
      outcome = { kind: "error", intent, provider, error: asNetError(err) }
    }
  }
  // Drop the code / error from the address bar (and history) before the router sees the page.
  env.replaceUrl(pending?.returnTo ?? "/")
  return outcome
}

export function isAccountProvider(provider: unknown): provider is AccountProvider {
  return (ACCOUNT_PROVIDERS as readonly unknown[]).includes(provider)
}

const PROVIDER_LABELS: Record<AccountProvider, string> = {
  discord: "Discord",
}

/** Human name of a provider ("Discord"); unknown providers are capitalised. */
export function providerLabel(provider: string): string {
  if (isAccountProvider(provider)) return PROVIDER_LABELS[provider]
  return provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : "your account"
}
