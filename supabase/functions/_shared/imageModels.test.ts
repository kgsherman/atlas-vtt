import { afterEach, describe, expect, it, vi } from "vitest"

import {
  backgroundRemovalModel,
  bytesToBase64,
  errorBody,
  ImageToolError,
  imageResult,
  matchingSize,
  readImageForm,
  REMOVE_BACKGROUND_PROMPT,
} from "./imageModels"

const env =
  (vars: Record<string, string>) =>
  (name: string): string | undefined =>
    vars[name]

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

function form(fields: Record<string, string | Blob>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  return f
}

afterEach(() => vi.unstubAllGlobals())

describe("matchingSize", () => {
  it("keeps the aspect ratio in multiples of 16 within the model's bounds", () => {
    expect(matchingSize(1024, 1024)).toBe("1024x1024")
    expect(matchingSize(600, 900)).toBe("688x1024")
    expect(matchingSize(4000, 3000)).toBe("1536x1152")
    expect(matchingSize(2048, 800)).toBe("1536x608")
    expect(matchingSize(3000, 1000)).toBe("1536x512")
    // The short side stays ≥ 480.
    expect(matchingSize(1200, 450)).toBe("1280x480")
    expect(matchingSize(1000, 4000)).toBe("auto")
    expect(matchingSize(0, 10)).toBe("auto")
  })
})

describe("readImageForm", () => {
  it("reads the image and its size", async () => {
    const input = await readImageForm(form({ image: new Blob([PNG], { type: "image/png" }), width: "600", height: "900" }))
    expect(input).toMatchObject({ mime: "image/png", width: 600, height: 900 })
    expect([...input.bytes]).toEqual([...PNG])
  })

  it("refuses missing files, other types and bad sizes", async () => {
    const bad = async (fields: Record<string, string | Blob>, code: string) => {
      await expect(readImageForm(form(fields))).rejects.toMatchObject({ code })
    }
    const png = new Blob([PNG], { type: "image/png" })
    await bad({ width: "1", height: "1" }, "invalid_argument")
    await bad({ image: "text", width: "1", height: "1" }, "invalid_argument")
    await bad({ image: new Blob([PNG], { type: "image/gif" }), width: "1", height: "1" }, "invalid_argument")
    await bad({ image: png, width: "0", height: "1" }, "invalid_argument")
    await bad({ image: png, width: "1.5", height: "1" }, "invalid_argument")
    await bad({ image: png, width: "5000", height: "1" }, "invalid_argument")
    await bad({ image: new Blob([new Uint8Array(13 * 1024 * 1024)], { type: "image/png" }), width: "1", height: "1" }, "payload_too_large")
  })
})

describe("backgroundRemovalModel", () => {
  it("needs a known provider and its key", () => {
    expect(() => backgroundRemovalModel(env({}))).toThrow(ImageToolError)
    expect(() => backgroundRemovalModel(env({ IMAGE_MODEL_PROVIDER: "nope", OPENAI_API_KEY: "k" }))).toThrow(/unknown image model provider/)
    expect(() => backgroundRemovalModel(env({ IMAGE_MODEL_PROVIDER: "__proto__" }))).toThrow(/unknown/)
    expect(backgroundRemovalModel(env({ OPENAI_API_KEY: "k" })).id).toBe("openai:gpt-image-2.5-sunburst")
    expect(backgroundRemovalModel(env({ OPENAI_API_KEY: "k", OPENAI_IMAGE_MODEL: "gpt-image-1" })).id).toBe("openai:gpt-image-1")
  })

  it("asks OpenAI's edit endpoint for a transparent PNG", async () => {
    const out = new Uint8Array([9, 8, 7, 6])
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: bytesToBase64(out) }] }), { status: 200 })
    )
    vi.stubGlobal("fetch", fetchMock)
    const model = backgroundRemovalModel(env({ OPENAI_API_KEY: "sk-test" }))
    const res = await model.removeBackground({ bytes: PNG, mime: "image/png", width: 600, height: 900 })
    expect([...res.bytes]).toEqual([...out])
    expect(res.mime).toBe("image/png")

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://api.openai.com/v1/images/edits")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test")
    const body = init.body as FormData
    expect(body.get("model")).toBe("gpt-image-2.5-sunburst")
    expect(body.get("prompt")).toBe(REMOVE_BACKGROUND_PROMPT)
    expect(body.get("background")).toBe("transparent")
    expect(body.get("output_format")).toBe("png")
    expect(body.get("quality")).toBe("high")
    expect(body.get("size")).toBe("688x1024")
    expect(body.get("n")).toBe("1")
    expect(body.has("input_fidelity")).toBe(false)
    const image = body.get("image") as File
    expect(image.type).toBe("image/png")
    expect(image.name).toBe("image.png")
  })

  it("honours the size, quality, fidelity and base URL settings", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: "AAAA" }] })))
    vi.stubGlobal("fetch", fetchMock)
    const model = backgroundRemovalModel(
      env({
        OPENAI_API_KEY: "k",
        OPENAI_IMAGE_SIZE: "auto",
        OPENAI_IMAGE_QUALITY: "medium",
        OPENAI_INPUT_FIDELITY: "high",
        OPENAI_BASE_URL: "https://proxy.example/v1/",
      })
    )
    await model.removeBackground({ bytes: PNG, mime: "image/jpeg", width: 10, height: 10 })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("https://proxy.example/v1/images/edits")
    const body = init.body as FormData
    expect(body.get("size")).toBe("auto")
    expect(body.get("quality")).toBe("medium")
    expect(body.get("input_fidelity")).toBe("high")
    expect((body.get("image") as File).name).toBe("image.jpg")
  })

  it("maps refusals and failures", async () => {
    const model = backgroundRemovalModel(env({ OPENAI_API_KEY: "k" }))
    const input = { bytes: PNG, mime: "image/png" as const, width: 10, height: 10 }
    const reply = (status: number, body: unknown) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(body), { status }))
      )

    reply(400, { error: { message: "Your request was rejected by the safety system.", code: "moderation_blocked" } })
    await expect(model.removeBackground(input)).rejects.toMatchObject({ code: "rejected", status: 422 })
    reply(500, { error: { message: "server exploded" } })
    await expect(model.removeBackground(input)).rejects.toMatchObject({ code: "provider_error", message: /server exploded/ })
    reply(200, { data: [] })
    await expect(model.removeBackground(input)).rejects.toMatchObject({ code: "rejected" })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed")
      })
    )
    await expect(model.removeBackground(input)).rejects.toMatchObject({ code: "provider_error" })
  })
})

describe("responses", () => {
  it("encodes results and errors", () => {
    expect(imageResult({ bytes: new Uint8Array([1, 2, 3]), mime: "image/png" }, "openai:m")).toEqual({ image: "AQID", mime: "image/png", model: "openai:m" })
    expect(errorBody(new ImageToolError("quota_exceeded", "used up"))).toEqual({ status: 429, body: { error: "quota_exceeded", detail: "used up" } })
    expect(errorBody(new Error("boom"))).toEqual({ status: 500, body: { error: "provider_error", detail: "boom" } })
    const big = new Uint8Array(100_000).map((_, i) => i % 256)
    expect(Buffer.from(bytesToBase64(big), "base64").equals(Buffer.from(big))).toBe(true)
  })
})
