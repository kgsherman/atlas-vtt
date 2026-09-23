import { describe, expect, it } from "vitest"

import type { PatchOp } from "@/core/session/types"

import { hostEpochOfWire, makeWireEpoch, OpLog, RequestLimiter } from "./flush"

const op = (k: string): PatchOp => ({ op: "set", path: ["objects", k], value: k })

describe("OpLog", () => {
  it("concatenates the ops of every patch after a seq", () => {
    const log = new OpLog()
    log.push({ baseSeq: 0, seq: 1, ops: [op("a")], bytes: 10, at: 0 })
    log.push({ baseSeq: 1, seq: 2, ops: [op("b"), op("c")], bytes: 20, at: 1 })
    log.push({ baseSeq: 2, seq: 3, ops: [op("d")], bytes: 10, at: 2 })
    expect(log.since(0, 3)).toEqual([op("a"), op("b"), op("c"), op("d")])
    expect(log.since(1, 3)).toEqual([op("b"), op("c"), op("d")])
    expect(log.since(3, 3)).toEqual([])
    // Not covered / nonsense.
    expect(log.since(5, 3)).toBeNull()
    expect(log.since(-1, 3)).toBeNull()
    expect(log.since(0, 4)).toBeNull()
  })

  it("drops the oldest patches beyond the size cap and after the maximum age", () => {
    const log = new OpLog({ maxBytes: 25, minAgeMs: 10, maxAgeMs: 100 })
    log.push({ baseSeq: 0, seq: 1, ops: [op("a")], bytes: 10, at: 0 })
    log.push({ baseSeq: 1, seq: 2, ops: [op("b")], bytes: 10, at: 1 })
    log.push({ baseSeq: 2, seq: 3, ops: [op("c")], bytes: 10, at: 2 })
    expect(log.size).toBe(2)
    expect(log.bytes).toBe(20)
    expect(log.since(0, 3)).toBeNull()
    expect(log.since(1, 3)).toEqual([op("b"), op("c")])
    log.trim(500)
    expect(log.size).toBe(0)
    expect(log.since(2, 3)).toBeNull()
  })

  it("restarts on a gap (a snapshot reset the sequence)", () => {
    const log = new OpLog()
    log.push({ baseSeq: 0, seq: 1, ops: [op("a")], bytes: 1, at: 0 })
    log.push({ baseSeq: 4, seq: 5, ops: [op("e")], bytes: 1, at: 0 })
    expect(log.size).toBe(1)
    expect(log.since(0, 5)).toBeNull()
    expect(log.since(4, 5)).toEqual([op("e")])
  })
})

describe("RequestLimiter", () => {
  it("allows a burst of 16 then about 8 per second", () => {
    let t = 0
    const lim = new RequestLimiter({ ratePerSecond: 8, burst: 16 }, () => t)
    let ok = 0
    for (let k = 0; k < 40; k++) if (lim.tryTake()) ok++
    expect(ok).toBe(16)
    t += 1000
    ok = 0
    for (let k = 0; k < 40; k++) if (lim.tryTake()) ok++
    expect(ok).toBe(8)
    t += 125
    expect(lim.tryTake()).toBe(true)
    expect(lim.tryTake()).toBe(false)
  })
})

describe("wire epoch", () => {
  it("is random per start and carries the fencing epoch", () => {
    const a = makeWireEpoch(7)
    const b = makeWireEpoch(7)
    expect(a).not.toBe(b)
    expect(hostEpochOfWire(a)).toBe(7)
    expect(hostEpochOfWire(makeWireEpoch(123456))).toBe(123456)
    // Printable ASCII ≤ 64 characters: accepted by the client protocol's token schema.
    expect(a).toMatch(/^[\x21-\x7e]{1,64}$/)
    for (const bad of [null, 3, "", "epoch-1", "x.y", "1.", ".abc", "1.a b"]) expect(hostEpochOfWire(bad)).toBeNull()
  })
})
