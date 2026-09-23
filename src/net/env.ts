/**
 * Supabase configuration from Vite env (VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY, see
 * .env.example). Without a usable configuration the app runs in local-only mode
 * (IndexedDB library + BroadcastChannel transport).
 */

export interface SupabaseEnv {
  url: string
  publishableKey: string
}

type EnvSource = Record<string, string | boolean | undefined>

function viteEnv(): EnvSource {
  // import.meta.env is injected by Vite (and Vitest); it is absent in plain Node / workers without Vite.
  return (import.meta as ImportMeta & { env?: EnvSource }).env ?? {}
}

/** Placeholder values copied from .env.example count as "not configured". */
function isPlaceholder(value: string): boolean {
  return value.includes("<") || value.includes(">") || value.endsWith("...")
}

function normaliseUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1"
  // The key travels with every request: never over plain HTTP except to a local stack.
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null
  return url.origin
}

/** Read and validate the Supabase env; null when missing, placeholder or malformed. */
export function readSupabaseEnv(source: EnvSource = viteEnv()): SupabaseEnv | null {
  const rawUrl = source.VITE_SUPABASE_URL
  const rawKey = source.VITE_SUPABASE_PUBLISHABLE_KEY
  if (typeof rawUrl !== "string" || typeof rawKey !== "string") return null
  const urlText = rawUrl.trim()
  const key = rawKey.trim()
  if (!urlText || !key || isPlaceholder(urlText) || isPlaceholder(key)) return null
  const url = normaliseUrl(urlText)
  if (!url) return null
  return { url, publishableKey: key }
}

let cached: SupabaseEnv | null | undefined

/** The app's Supabase env (read once). */
export function supabaseEnv(): SupabaseEnv | null {
  if (cached === undefined) cached = readSupabaseEnv()
  return cached
}

/** True when Supabase is configured; false means local-only mode. */
export function isSupabaseConfigured(): boolean {
  return supabaseEnv() !== null
}
