import { describe, expect, it } from "vitest"

import { parseClientMessage, PROTOCOL_LIMITS } from "./protocol"

const step = (i: number, j: number, levelId = "L1") => ({ cell: { i, j }, levelId })

describe("parseClientMessage", () => {
  it("accepts well-formed messages of every kind", () => {
    expect(parseClientMessage({ t: "hello", nonce: "n-1", epoch: null, lastSeq: null })).toEqual({ t: "hello", nonce: "n-1", epoch: null, lastSeq: null })
    expect(parseClientMessage({ t: "hello", nonce: "n-1", epoch: "e.1:x", lastSeq: 12 })).not.toBeNull()
    const move = { t: "move", reqId: "r1", tokenId: "tok_1", path: [step(1, 1), step(2, 1)] }
    expect(parseClientMessage(move)).toEqual(move)
    expect(parseClientMessage({ t: "door", reqId: "r2", doorId: "d-9", action: "open" })).toEqual({ t: "door", reqId: "r2", doorId: "d-9", action: "open" })
  })

  it("rejects unknown keys anywhere (strict)", () => {
    expect(parseClientMessage({ t: "door", reqId: "r", doorId: "d", action: "open", userId: "someone-else" })).toBeNull()
    expect(parseClientMessage({ t: "move", reqId: "r", tokenId: "t", path: [{ cell: { i: 0, j: 0, k: 1 }, levelId: "L" }] })).toBeNull()
    expect(parseClientMessage({ t: "move", reqId: "r", tokenId: "t", path: [{ ...step(0, 0), extra: true }] })).toBeNull()
    expect(parseClientMessage({ t: "hello", nonce: "n", epoch: null, lastSeq: null, admin: true })).toBeNull()
  })

  it("rejects unknown message types and non-objects", () => {
    for (const raw of [null, undefined, 1, "hello", [], { t: "unlock", reqId: "r", doorId: "d" }, { t: "move" }]) {
      expect(parseClientMessage(raw)).toBeNull()
    }
  })

  it("enforces id limits and the id alphabet", () => {
    const long = "a".repeat(PROTOCOL_LIMITS.maxIdLength + 1)
    expect(parseClientMessage({ t: "door", reqId: "r", doorId: long, action: "open" })).toBeNull()
    expect(parseClientMessage({ t: "door", reqId: long, doorId: "d", action: "open" })).toBeNull()
    expect(parseClientMessage({ t: "door", reqId: "r", doorId: "__proto__", action: "open" })).toBeNull()
    expect(parseClientMessage({ t: "door", reqId: "r", doorId: "a b", action: "open" })).toBeNull()
    expect(parseClientMessage({ t: "door", reqId: "r", doorId: "", action: "open" })).toBeNull()
    expect(parseClientMessage({ t: "door", reqId: "r", doorId: "d", action: "unlock" })).toBeNull()
    expect(parseClientMessage({ t: "move", reqId: "r", tokenId: "t", path: [step(0, 0, "bad level")] })).toBeNull()
  })

  it("requires integer cells and bounded coordinates", () => {
    expect(parseClientMessage({ t: "move", reqId: "r", tokenId: "t", path: [step(0.5, 0)] })).toBeNull()
    expect(parseClientMessage({ t: "move", reqId: "r", tokenId: "t", path: [step(Number.NaN, 0)] })).toBeNull()
    expect(parseClientMessage({ t: "move", reqId: "r", tokenId: "t", path: [step(Infinity, 0)] })).toBeNull()
    expect(parseClientMessage({ t: "move", reqId: "r", tokenId: "t", path: [step(1e9, 0)] })).toBeNull()
    expect(parseClientMessage({ t: "move", reqId: "r", tokenId: "t", path: [step("1" as unknown as number, 0)] })).toBeNull()
    expect(parseClientMessage({ t: "move", reqId: "r", tokenId: "t", path: [step(-1, 0)] })).not.toBeNull()
  })

  it("accepts paths up to 256 steps (257 entries) and drops longer or empty ones", () => {
    const path = Array.from({ length: PROTOCOL_LIMITS.maxPathSteps + 1 }, (_, k) => step(k % 100, 0))
    expect(parseClientMessage({ t: "move", reqId: "r", tokenId: "t", path })).not.toBeNull()
    expect(parseClientMessage({ t: "move", reqId: "r", tokenId: "t", path: [...path, step(0, 0)] })).toBeNull()
    expect(parseClientMessage({ t: "move", reqId: "r", tokenId: "t", path: [] })).toBeNull()
    // Huge arrays are dropped before zod walks them.
    expect(parseClientMessage({ t: "move", reqId: "r", tokenId: "t", path: new Array(1_000_000).fill(step(0, 0)) })).toBeNull()
  })

  it("validates hello fields", () => {
    expect(parseClientMessage({ t: "hello", nonce: "", epoch: null, lastSeq: null })).toBeNull()
    expect(parseClientMessage({ t: "hello", nonce: "n", epoch: null, lastSeq: -1 })).toBeNull()
    expect(parseClientMessage({ t: "hello", nonce: "n", epoch: null, lastSeq: 1.5 })).toBeNull()
    expect(parseClientMessage({ t: "hello", nonce: "n", epoch: 5, lastSeq: null })).toBeNull()
    expect(parseClientMessage({ t: "hello", nonce: "n\u0000", epoch: null, lastSeq: null })).toBeNull()
  })

  it("drops messages whose getters throw", () => {
    const hostile = {
      t: "door",
      reqId: "r",
      get doorId(): string {
        throw new Error("boom")
      },
      action: "open",
    }
    expect(parseClientMessage(hostile)).toBeNull()
  })
})
