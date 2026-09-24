import { afterEach, describe, expect, it, vi } from "vitest"

import { createBackgroundRemover, DEV_REMOVE_BACKGROUND_PATH, describeImageToolError, ImageToolError, parseImageToolReply } from "./imageTools"
import type { AtlasClient } from "./supabase"

const png = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })
const size = { width: 600, height: 900 }
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })

afterEach(() => vi.unstubAllGlobals())

describe("parseImageToolReply", () => {
  it("decodes the image", async () => {
    const blob = parseImageToolReply({ image: "CQgH", mime: "image/png", model: "openai:m" }, 200)
    expect(blob.type).toBe("image/png")
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([9, 8, 7])
  })

  it("turns errors into ImageToolErrors", () => {
    expect(() => parseImageToolReply({ error: "quota_exceeded", detail: "you have used your 10 image tool calls for today" }, 429)).toThrow(
      expect.objectContaining({ code: "quota_exceeded", message: "You have used your 10 image tool calls for today." })
    )
    expect(() => parseImageToolReply({ error: "weird" }, 500)).toThrow(expect.objectContaining({ code: "provider_error", message: "HTTP 500." }))
    expect(() => parseImageToolReply({ image: "CQgH", mime: "image/gif" }, 200)).toThrow(ImageToolError)
    expect(() => parseImageToolReply(null, 200)).toThrow(ImageToolError)
  })

  it("describes failures for people", () => {
    expect(describeImageToolError(new ImageToolError("not_configured", "x"))).toMatch(/isn't set up/)
    expect(describeImageToolError(new ImageToolError("network", "x"))).toMatch(/connection/)
    expect(describeImageToolError(new Error("boom"))).toBe("boom")
  })
})

describe("createBackgroundRemover", () => {
  it("uses the dev server's endpoint in dev", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ image: "AQID", mime: "image/png" }))
    vi.stubGlobal("fetch", fetchMock)
    const remover = createBackgroundRemover({ client: null, dev: true })
    expect(remover.available).toBe(true)
    const out = await remover.removeBackground(png, size)
    expect(out.size).toBe(3)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(DEV_REMOVE_BACKGROUND_PATH)
    const form = init!.body as FormData
    expect(form.get("width")).toBe("600")
    expect(form.get("height")).toBe("900")
    expect((form.get("image") as File).name).toBe("image.png")
  })

  it("falls through to the Edge Function when the dev server has no key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "not_configured", detail: "OPENAI_API_KEY is not set on the server" }, 503))
    )
    const invoke = vi.fn(async () => ({ data: { image: "AQID", mime: "image/png" }, error: null }))
    const client = { functions: { invoke } } as unknown as AtlasClient
    const out = await createBackgroundRemover({ client, dev: true }).removeBackground(png, size)
    expect(out.size).toBe(3)
    expect(invoke).toHaveBeenCalledWith("remove-background", expect.objectContaining({ body: expect.any(FormData) }))
  })

  it("is unavailable without Cloud or the dev server", async () => {
    const remover = createBackgroundRemover({ client: null, dev: false })
    expect(remover.available).toBe(false)
    await expect(remover.removeBackground(png, size)).rejects.toMatchObject({ code: "unavailable" })
    // A dev server without a key and no Cloud: not configured.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "not_configured", detail: "no key" }, 503))
    )
    await expect(createBackgroundRemover({ client: null, dev: true }).removeBackground(png, size)).rejects.toMatchObject({ code: "not_configured" })
  })
})
