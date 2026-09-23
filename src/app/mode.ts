/**
 * Which backend the app runs against.
 *
 * - "supabase" (Cloud) when VITE_SUPABASE_* are configured.
 * - "local" otherwise, or when forced with `?local=1` (persisted per tab in sessionStorage so in-app
 *   navigation keeps it; `?local=0` clears it). Local mode is dev/testing only: IndexedDB library,
 *   BroadcastChannel transport between tabs of one browser, one identity per tab.
 */
import { isSupabaseConfigured } from "@/net/env"

export type AppMode = "supabase" | "local"

export const FORCE_LOCAL_KEY = "atlas-vtt:force-local"

export interface ModeResolution {
  mode: AppMode
  /** Local mode was chosen explicitly although Supabase is configured. */
  forcedLocal: boolean
  /** Supabase is configured (Cloud mode is possible). */
  cloudAvailable: boolean
}

/** The subset of Web Storage used here (injectable for tests). */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

function parseFlag(value: string): boolean {
  return value === "" || value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes"
}

/**
 * Resolve the mode from the URL search string, the Supabase configuration and the per-tab flag.
 * A `local` query parameter updates the persisted flag.
 */
export function resolveAppMode(search: string, cloudAvailable: boolean, storage: KeyValueStorage | null): ModeResolution {
  const raw = new URLSearchParams(search).get("local")
  let forced: boolean | null = raw === null ? null : parseFlag(raw)
  if (forced !== null) {
    try {
      if (forced) storage?.setItem(FORCE_LOCAL_KEY, "1")
      else storage?.removeItem(FORCE_LOCAL_KEY)
    } catch {
      // Storage can throw (privacy mode): the URL flag still applies to this page load.
    }
  } else {
    try {
      forced = storage?.getItem(FORCE_LOCAL_KEY) === "1"
    } catch {
      forced = false
    }
  }
  const local = !cloudAvailable || forced
  return { mode: local ? "local" : "supabase", forcedLocal: cloudAvailable && forced, cloudAvailable }
}

function sessionStorageOrNull(): KeyValueStorage | null {
  try {
    return globalThis.sessionStorage ?? null
  } catch {
    return null
  }
}

let cached: ModeResolution | null = null

/** The mode for this page load (resolved once; switching modes reloads the page). */
export function currentMode(): ModeResolution {
  if (!cached) {
    const search = typeof location === "undefined" ? "" : location.search
    cached = resolveAppMode(search, isSupabaseConfigured(), sessionStorageOrNull())
  }
  return cached
}

/** URL that switches to `target` mode (full reload required: services are created once). */
export function modeSwitchUrl(target: AppMode, href: string): string {
  const url = new URL(href)
  url.searchParams.set("local", target === "local" ? "1" : "0")
  return url.toString()
}

/** Append `?local=1` to an in-app link when running in forced local mode (for links opened in new tabs). */
export function withModeParam(path: string, resolution: ModeResolution = currentMode()): string {
  if (resolution.mode !== "local" || !resolution.cloudAvailable) return path
  return `${path}${path.includes("?") ? "&" : "?"}local=1`
}
