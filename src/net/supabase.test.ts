import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js"
import { describe, expect, it, vi } from "vitest"

import { accountFromUser, ensureSession, localIdentity, mapAuthError, normalizeDisplayName, parseAuthCallback, setLocalDisplayName } from "./auth"
import { readSupabaseEnv } from "./env"
import { describeNetError, NetError, SERVER_ERROR_CODES, toNetError, unwrap, type AtlasClient } from "./supabase"

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

describe("permanent accounts", () => {
  it("maps linking and OAuth errors", () => {
    expect(mapAuthError({ code: "manual_linking_disabled", status: 404 }).code).toBe("linking_disabled")
    expect(mapAuthError({ code: "identity_already_exists", status: 422 }).code).toBe("identity_exists")
    expect(mapAuthError({ code: "provider_disabled" }).code).toBe("provider_disabled")
    expect(mapAuthError({ code: "access_denied" }).code).toBe("auth_cancelled")
    expect(describeNetError("linking_disabled")).toMatch(/manual linking/)
  })

  it("parses OAuth callbacks", () => {
    expect(parseAuthCallback("https://a.test/auth/callback?code=abc")).toEqual({ kind: "code", code: "abc" })
    const exists = parseAuthCallback("https://a.test/auth/callback?error=server_error&error_code=identity_already_exists&error_description=x")
    expect(exists?.kind === "error" && exists.error.code).toBe("identity_exists")
    const denied = parseAuthCallback("https://a.test/auth/callback#error=access_denied&error_description=denied")
    expect(denied?.kind === "error" && denied.error.code).toBe("auth_cancelled")
    expect(parseAuthCallback("https://a.test/auth/callback")).toBeNull()
  })

  it("reads the Discord account of a permanent user, never of a guest", () => {
    const discord = {
      is_anonymous: false,
      email: "morgana@example.com",
      user_metadata: { full_name: "Meta Name" },
      identities: [
        {
          provider: "discord",
          identity_data: {
            name: "morgana_42",
            full_name: "Morgana",
            custom_claims: { global_name: "Morgana" },
            avatar_url: "https://cdn.discordapp.com/avatars/1/a.png",
          },
        },
      ],
    }
    expect(accountFromUser(discord)).toEqual({ provider: "discord", name: "Morgana", avatarUrl: "https://cdn.discordapp.com/avatars/1/a.png" })
    expect(accountFromUser({ ...discord, is_anonymous: true })).toBeUndefined()
    const plainHttp = { ...discord, identities: [{ provider: "discord", identity_data: { avatar_url: "http://x.test/a.png" } }] }
    expect(accountFromUser(plainHttp)).toEqual({ provider: "discord", name: "Meta Name", avatarUrl: null })
  })

  describe("ensureSession with a stored guest session", () => {
    const guest = { id: "u1", is_anonymous: true, user_metadata: {}, identities: [] }
    const linked = {
      id: "u1",
      is_anonymous: false,
      user_metadata: {},
      identities: [{ provider: "discord", identity_data: { full_name: "Snoe", avatar_url: "https://cdn.discordapp.com/a.png" } }],
    }

    function fakeClient(serverUser: object | null, serverError: unknown = null) {
      const refreshSession = vi.fn(async () => ({ data: { user: serverUser }, error: null }))
      const profileQuery = { select: () => profileQuery, eq: () => profileQuery, maybeSingle: async () => ({ data: { display_name: "snoe" }, error: null }) }
      const client = {
        auth: {
          getSession: async () => ({ data: { session: { user: guest } }, error: null }),
          getUser: async () => ({ data: { user: serverUser }, error: serverError }),
          refreshSession,
          signInAnonymously: vi.fn(),
        },
        from: () => profileQuery,
      }
      return { client: client as unknown as AtlasClient, refreshSession }
    }

    it("picks up a link the server made but this browser never finished", async () => {
      const { client, refreshSession } = fakeClient(linked)
      const identity = await ensureSession(client)
      expect(refreshSession).toHaveBeenCalledOnce()
      expect(identity).toMatchObject({ userId: "u1", isAnonymous: false, displayName: "snoe", account: { provider: "discord", name: "Snoe" } })
    })

    it("keeps a real guest (and the stored user when the server can't be reached) without refreshing", async () => {
      for (const [serverUser, serverError] of [
        [guest, null],
        [null, { message: "Failed to fetch" }],
      ] as const) {
        const { client, refreshSession } = fakeClient(serverUser, serverError)
        const identity = await ensureSession(client)
        expect(refreshSession).not.toHaveBeenCalled()
        expect(identity.isAnonymous).toBe(true)
        expect(identity.account).toBeUndefined()
      }
    })
  })
})
