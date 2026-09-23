import { describe, expect, it } from "vitest"

import { encodePayload, MAX_BROADCAST_BYTES, utf8Length, whenSubscribed, type ChannelStatus, type StatusEvent } from "./transport"

describe("utf8Length", () => {
  it.each(["", "abc", "é", "€", "𝄞", "a€𝄞é", "\u0000", "\ud800"])("matches TextEncoder for %j", (s) => {
    expect(utf8Length(s)).toBe(new TextEncoder().encode(s).length)
  })
})

describe("encodePayload (size guard)", () => {
  it("accepts payloads up to 200 KB", () => {
    const payload = { t: "snapshot", data: "x".repeat(MAX_BROADCAST_BYTES - 30) }
    const r = encodePayload(payload)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.bytes).toBeLessThanOrEqual(MAX_BROADCAST_BYTES)
  })

  it("rejects payloads over 200 KB with too-large", () => {
    const r = encodePayload({ t: "snapshot", data: "x".repeat(MAX_BROADCAST_BYTES) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.result).toMatchObject({ ok: false, reason: "too-large" })
  })

  it("counts UTF-8 bytes, not string length", () => {
    // 70k × "€" is 70k UTF-16 units but 210k UTF-8 bytes.
    const r = encodePayload({ s: "€".repeat(70_000) })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.result).toMatchObject({ reason: "too-large" })
  })

  it("rejects values that cannot be serialised", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const r = encodePayload(cyclic)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.result).toMatchObject({ reason: "error" })
    expect(encodePayload(undefined).ok).toBe(false)
  })
})

describe("whenSubscribed", () => {
  function fakeChannel(initial: ChannelStatus) {
    let status = initial
    const listeners = new Set<(ev: StatusEvent) => void>()
    return {
      topic: "t",
      status: () => status,
      onStatus: (cb: (ev: StatusEvent) => void) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      emit: (ev: StatusEvent) => {
        status = ev.status
        for (const l of listeners) l(ev)
      },
    }
  }

  it("resolves true immediately when already subscribed", async () => {
    await expect(whenSubscribed(fakeChannel("SUBSCRIBED"))).resolves.toBe(true)
  })

  it("resolves on SUBSCRIBED, false on a final CLOSED or timeout", async () => {
    const a = fakeChannel("JOINING")
    const pa = whenSubscribed(a)
    a.emit({ status: "CHANNEL_ERROR" })
    a.emit({ status: "SUBSCRIBED" })
    await expect(pa).resolves.toBe(true)

    const b = fakeChannel("JOINING")
    const pb = whenSubscribed(b)
    b.emit({ status: "CLOSED", willRetry: true })
    b.emit({ status: "CLOSED", willRetry: false })
    await expect(pb).resolves.toBe(false)

    await expect(whenSubscribed(fakeChannel("JOINING"), 10)).resolves.toBe(false)
  })
})
