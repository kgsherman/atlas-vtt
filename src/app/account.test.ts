import { describe, expect, it, vi } from "vitest"

import { NetError, type AtlasClient } from "@/net/supabase"

import { AUTH_CALLBACK_PATH, finishAuthRedirect, isAccountProvider, providerLabel, safeReturnPath, type FinishAuthRedirectEnv } from "./account"
import type { KeyValueStorage } from "./mode"

function memoryStorage(entries: Record<string, string> = {}): KeyValueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(entries))
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

function fakeClient(result: { error: unknown } = { error: null }) {
  const exchangeCodeForSession = vi.fn(async () => ({ data: {}, ...result }))
  return { client: { auth: { exchangeCodeForSession } } as unknown as AtlasClient, exchangeCodeForSession }
}

const pending = (intent: "link" | "sign_in", returnTo = "/join/ABCD1234") =>
  memoryStorage({ "atlas-vtt:auth-pending": JSON.stringify({ intent, provider: "discord", returnTo }) })

function env(query: string, storage: KeyValueStorage | null): FinishAuthRedirectEnv & { replaced: string[] } {
  const replaced: string[] = []
  return { href: `https://atlas.test${AUTH_CALLBACK_PATH}${query}`, replaceUrl: (p) => void replaced.push(p), storage, replaced }
}

describe("safeReturnPath", () => {
  it.each([
    ["/", "/"],
    ["/editor/abc?import=1", "/editor/abc?import=1"],
    ["/play/x#frag", "/play/x#frag"],
  ])("keeps in-app path %s", (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected)
  })

  it.each([
    null,
    undefined,
    "",
    "editor",
    "//evil.test/x",
    "/\\evil.test",
    "https://evil.test/",
    "javascript:alert(1)",
    AUTH_CALLBACK_PATH,
    `${AUTH_CALLBACK_PATH}?code=1`,
  ])("falls back to / for %j", (input) => {
    expect(safeReturnPath(input)).toBe("/")
  })
})

describe("finishAuthRedirect", () => {
  it("ignores other pages", async () => {
    const { client, exchangeCodeForSession } = fakeClient()
    const e = { ...env("", null), href: "https://atlas.test/join?code=abc" }
    expect(await finishAuthRedirect(client, e)).toBeNull()
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
  })

  it("exchanges the code of a link and returns to where the user was", async () => {
    const { client, exchangeCodeForSession } = fakeClient()
    const storage = pending("link")
    const e = env("?code=the-code", storage)
    expect(await finishAuthRedirect(client, e)).toEqual({ kind: "linked", provider: "discord" })
    expect(exchangeCodeForSession).toHaveBeenCalledWith("the-code")
    expect(e.replaced).toEqual(["/join/ABCD1234"])
    expect(storage.data.size).toBe(0)
  })

  it("reports a sign-in, and returns home without a pending record", async () => {
    const { client } = fakeClient()
    const e = env("?code=c", memoryStorage())
    expect(await finishAuthRedirect(client, e)).toEqual({ kind: "signed_in", provider: "discord" })
    expect(e.replaced).toEqual(["/"])
  })

  it("reports an identity that belongs to another user without exchanging anything", async () => {
    const { client, exchangeCodeForSession } = fakeClient()
    const e = env("?error=server_error&error_code=identity_already_exists&error_description=Identity+is+already+linked", pending("link", "/"))
    const outcome = await finishAuthRedirect(client, e)
    expect(outcome).toMatchObject({ kind: "error", intent: "link", provider: "discord" })
    expect(outcome?.kind === "error" && outcome.error.code).toBe("identity_exists")
    expect(exchangeCodeForSession).not.toHaveBeenCalled()
    expect(e.replaced).toEqual(["/"])
  })

  it("turns a failed exchange into an error outcome", async () => {
    const { client } = fakeClient({ error: { code: "bad_code_verifier", status: 400, message: "code verifier missing" } })
    const outcome = await finishAuthRedirect(client, env("?code=c", pending("sign_in")))
    expect(outcome).toMatchObject({ kind: "error", intent: "sign_in" })
  })

  it("ignores a tampered pending record", async () => {
    const { client } = fakeClient()
    const storage = memoryStorage({ "atlas-vtt:auth-pending": JSON.stringify({ intent: "link", provider: "discord", returnTo: "//evil.test" }) })
    const e = env("?code=c", storage)
    await finishAuthRedirect(client, e)
    expect(e.replaced).toEqual(["/"])
  })
})

describe("providers", () => {
  it("recognises only the providers Atlas offers", () => {
    expect(isAccountProvider("discord")).toBe(true)
    expect(isAccountProvider("email")).toBe(false)
    expect(isAccountProvider(undefined)).toBe(false)
  })

  it("labels known and unknown providers", () => {
    expect(providerLabel("discord")).toBe("Discord")
    expect(providerLabel("github")).toBe("Github")
    expect(providerLabel("")).toBe("your account")
  })
})

describe("finishAuthRedirect with a guest merge ticket", () => {
  const TICKET = "a".repeat(43)
  const withTicket = (intent: "link" | "sign_in", mergeTicket: string = TICKET) =>
    memoryStorage({ "atlas-vtt:auth-pending": JSON.stringify({ intent, provider: "discord", returnTo: "/", mergeTicket }) })

  it("merges the guest into the account it signed in to", async () => {
    const { client } = fakeClient()
    const mergeGuest = vi.fn(async () => ({ scenes: 2, sessions: 1, images: 5 }))
    const outcome = await finishAuthRedirect(client, { ...env("?code=c", withTicket("sign_in")), mergeGuest })
    expect(mergeGuest).toHaveBeenCalledWith(TICKET)
    expect(outcome).toEqual({ kind: "signed_in", provider: "discord", merge: { ok: true, result: { scenes: 2, sessions: 1, images: 5 } } })
  })

  it("keeps the ticket for a retry when the merge fails", async () => {
    const { client } = fakeClient()
    const mergeGuest = vi.fn(async () => {
      throw new NetError("quota_exceeded", "too many scenes")
    })
    const outcome = await finishAuthRedirect(client, { ...env("?code=c", withTicket("sign_in")), mergeGuest })
    expect(outcome?.kind === "signed_in" && outcome.merge).toMatchObject({ ok: false, ticket: TICKET, error: { code: "quota_exceeded" } })
  })

  it("never merges on a link, a failed sign-in or a malformed ticket", async () => {
    const mergeGuest = vi.fn(async () => ({ scenes: 0, sessions: 0, images: 0 }))
    await finishAuthRedirect(fakeClient().client, { ...env("?code=c", withTicket("link")), mergeGuest })
    await finishAuthRedirect(fakeClient().client, { ...env("?error=access_denied", withTicket("sign_in")), mergeGuest })
    await finishAuthRedirect(fakeClient({ error: { code: "bad_code_verifier", status: 400 } }).client, { ...env("?code=c", withTicket("sign_in")), mergeGuest })
    const outcome = await finishAuthRedirect(fakeClient().client, { ...env("?code=c", withTicket("sign_in", "not a ticket")), mergeGuest })
    expect(mergeGuest).not.toHaveBeenCalled()
    expect(outcome).toEqual({ kind: "signed_in", provider: "discord" })
  })
})
