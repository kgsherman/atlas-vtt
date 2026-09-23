import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js"
import { describe, expect, it } from "vitest"

import { localIdentity, mapAuthError, normalizeDisplayName, setLocalDisplayName } from "./auth"
import { readSupabaseEnv } from "./env"
import { describeNetError, NetError, SERVER_ERROR_CODES, toNetError, unwrap } from "./supabase"

describe("readSupabaseEnv", () => {
  const url = "https://iuhhuurcoaefoshuhaxe.supabase.co"
  const key = "sb_publishable_abc123"

  it("accepts a valid configuration and normalises the URL", () => {
    expect(readSupabaseEnv({ VITE_SUPABASE_URL: `${url}/`, VITE_SUPABASE_PUBLISHABLE_KEY: ` ${key} ` })).toEqual({ url, publishableKey: key })
  })

  it.each([
    [{}],
    [{ VITE_SUPABASE_URL: url }],
    [{ VITE_SUPABASE_URL: "", VITE_SUPABASE_PUBLISHABLE_KEY: key }],
    // .env.example placeholders
    [{ VITE_SUPABASE_URL: "https://<project-ref>.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_..." }],
    [{ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_..." }],
    [{ VITE_SUPABASE_URL: "not a url", VITE_SUPABASE_PUBLISHABLE_KEY: key }],
    // keys never travel over plain HTTP except to a local stack
    [{ VITE_SUPABASE_URL: "http://iuhhuurcoaefoshuhaxe.supabase.co", VITE_SUPABASE_PUBLISHABLE_KEY: key }],
  ])("treats %j as local-only mode", (env) => {
    expect(readSupabaseEnv(env)).toBeNull()
  })

  it("allows http for a local Supabase stack", () => {
    expect(readSupabaseEnv({ VITE_SUPABASE_URL: "http://127.0.0.1:54321", VITE_SUPABASE_PUBLISHABLE_KEY: key })?.url).toBe("http://127.0.0.1:54321")
  })
})

describe("toNetError", () => {
  it("maps every RPC exception code", () => {
    for (const code of SERVER_ERROR_CODES) {
      const err = toNetError({ message: code, code: "P0001", details: "detail text", hint: null })
      expect(err.code).toBe(code)
      expect(err.detail).toBe("detail text")
    }
  })

  it("maps privilege, auth, missing-row and network failures", () => {
    expect(toNetError({ message: "permission denied for table scenes", code: "42501" }).code).toBe("permission_denied")
    expect(toNetError({ message: "JWT expired", code: "PGRST301" }).code).toBe("not_authenticated")
    expect(toNetError({ message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" }).code).toBe("not_found")
    expect(toNetError({ message: "TypeError: Failed to fetch", code: "" }).code).toBe("network")
    expect(toNetError("weird").code).toBe("unknown")
  })

  it("unwrap throws the mapped error and passes data through", () => {
    expect(unwrap({ data: 3, error: null })).toBe(3)
    expect(() => unwrap({ data: null, error: { message: "kicked", code: "P0001" } })).toThrow(NetError)
  })

  it("has user-facing copy for every code", () => {
    expect(describeNetError("anonymous_disabled")).toMatch(/Anonymous sign-ins are disabled/)
    expect(describeNetError("stale_epoch")).toMatch(/taken over/)
  })
})

describe("auth helpers", () => {
  it("explains disabled anonymous sign-ins", () => {
    const err = mapAuthError(new AuthApiError("Anonymous sign-ins are disabled", 422, "anonymous_provider_disabled"))
    expect(err.code).toBe("anonymous_disabled")
    expect(err.message).toMatch(/dashboard/)
  })

  it("maps rate limits, captcha and network errors", () => {
    expect(mapAuthError(new AuthApiError("Too many", 429, "over_request_rate_limit")).code).toBe("rate_limited")
    expect(mapAuthError(new AuthApiError("captcha", 400, "captcha_failed")).code).toBe("captcha_required")
    expect(mapAuthError(new AuthRetryableFetchError("fetch failed", 0)).code).toBe("network")
    expect(mapAuthError(new Error("boom")).code).toBe("unknown")
  })

  it("normalises display names like the SQL helper", () => {
    expect(normalizeDisplayName("  Sir   Galahad ")).toBe("Sir Galahad")
    expect(normalizeDisplayName("")).toBeNull()
    expect(normalizeDisplayName("x".repeat(33))).toBeNull()
    expect(normalizeDisplayName("🐉".repeat(32))).toBe("🐉".repeat(32))
    expect(normalizeDisplayName("bad\u0007name")).toBeNull()
  })

  it("gives local mode a stable per-tab identity", () => {
    const a = localIdentity()
    expect(a.mode).toBe("local")
    expect(a.userId).toMatch(/^[0-9a-f-]{36}$/)
    expect(localIdentity().userId).toBe(a.userId)
    setLocalDisplayName("  Tabby ")
    expect(localIdentity().displayName).toBe("Tabby")
  })
})
