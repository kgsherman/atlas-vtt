import { FunctionsFetchError, FunctionsHttpError } from "@supabase/supabase-js"
import { describe, expect, it, vi } from "vitest"

import { createMergeTicket, mergeGuest } from "./guestMerge"
import type { AtlasClient } from "./supabase"

const TICKET = "Ab3_-".repeat(8) + "xyz"

function clientWith(
  invoke: (name: string, opts: unknown) => Promise<{ data: unknown; error: unknown }>,
  rpc?: () => Promise<{ data: unknown; error: unknown }>
) {
  return { functions: { invoke: vi.fn(invoke) }, rpc: vi.fn(rpc ?? (async () => ({ data: TICKET, error: null }))) } as unknown as AtlasClient & {
    functions: { invoke: ReturnType<typeof vi.fn> }
  }
}

describe("guest merge client", () => {
  it("creates a ticket and rejects anything that isn't one", async () => {
    expect(await createMergeTicket(clientWith(async () => ({ data: null, error: null })))).toBe(TICKET)
    const bad = clientWith(
      async () => ({ data: null, error: null }),
      async () => ({ data: "short", error: null })
    )
    await expect(createMergeTicket(bad)).rejects.toMatchObject({ code: "unknown" })
    const refused = clientWith(
      async () => ({ data: null, error: null }),
      async () => ({ data: null, error: { message: "forbidden", code: "P0001", details: "only guest accounts can be merged" } })
    )
    await expect(createMergeTicket(refused)).rejects.toMatchObject({ code: "forbidden" })
  })

  it("redeems a ticket through the merge-guest function", async () => {
    const client = clientWith(async () => ({ data: { scenes: 3, sessions: 1, images: 7 }, error: null }))
    expect(await mergeGuest(TICKET, client)).toEqual({ scenes: 3, sessions: 1, images: 7 })
    expect(client.functions.invoke).toHaveBeenCalledWith("merge-guest", { body: { ticket: TICKET } })
  })

  it("maps the function's error codes", async () => {
    const http = (status: number, body: string) => clientWith(async () => ({ data: null, error: new FunctionsHttpError(new Response(body, { status })) }))
    await expect(mergeGuest(TICKET, http(409, JSON.stringify({ error: "quota_exceeded", detail: "too many scenes" })))).rejects.toMatchObject({
      code: "quota_exceeded",
      detail: "too many scenes",
    })
    await expect(mergeGuest(TICKET, http(404, JSON.stringify({ error: "not_found", detail: "" })))).rejects.toMatchObject({ code: "not_found" })
    // Not deployed: the platform's own 404 page.
    await expect(mergeGuest(TICKET, http(404, "Function not found"))).rejects.toMatchObject({ code: "unknown" })
    const offline = clientWith(async () => ({ data: null, error: new FunctionsFetchError(new TypeError("Failed to fetch")) }))
    await expect(mergeGuest(TICKET, offline)).rejects.toMatchObject({ code: "network" })
  })
})
