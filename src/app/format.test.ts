import { describe, expect, it } from "vitest"

import { formatRelativeTime, initials, plural } from "./format"
import { extractCodeFromText, inviteLink, parseRoomCodeInput } from "./roomCodeInput"

describe("formatRelativeTime", () => {
  const now = new Date(2026, 8, 23, 15, 0, 0).getTime()
  const ago = (ms: number) => new Date(now - ms).toISOString()

  it("formats recent times", () => {
    expect(formatRelativeTime(ago(10_000), now)).toBe("just now")
    expect(formatRelativeTime(ago(60_000), now)).toBe("1 min ago")
    expect(formatRelativeTime(ago(25 * 60_000), now)).toBe("25 min ago")
    expect(formatRelativeTime(ago(3 * 3_600_000), now)).toBe("3 h ago")
  })

  it("formats days and dates", () => {
    expect(formatRelativeTime(new Date(2026, 8, 22, 9, 0).toISOString(), now)).toBe("yesterday")
    expect(formatRelativeTime(new Date(2026, 8, 19, 9, 0).toISOString(), now)).toBe("4 days ago")
    expect(formatRelativeTime(new Date(2026, 2, 4, 9, 0).toISOString(), now, "en-US")).toBe("Mar 4")
    expect(formatRelativeTime(new Date(2025, 2, 4, 9, 0).toISOString(), now, "en-US")).toBe("Mar 4, 2025")
  })

  it("tolerates garbage and future times", () => {
    expect(formatRelativeTime("nope", now)).toBe("")
    expect(formatRelativeTime(new Date(now + 5000).toISOString(), now)).toBe("just now")
  })
})

describe("small formatters", () => {
  it("pluralises", () => {
    expect(plural(1, "level")).toBe("1 level")
    expect(plural(4, "level")).toBe("4 levels")
    expect(plural(1204, "object")).toBe("1,204 objects")
    expect(plural(2, "light", "lights")).toBe("2 lights")
  })

  it("builds initials", () => {
    expect(initials("Ser Brienne of Tarth")).toBe("ST")
    expect(initials("gandalf")).toBe("GA")
    expect(initials("  ")).toBe("?")
    expect(initials(null)).toBe("?")
  })
})

describe("parseRoomCodeInput", () => {
  it("formats as you type", () => {
    expect(parseRoomCodeInput("ab").display).toBe("AB")
    expect(parseRoomCodeInput("abcd").display).toBe("ABCD")
    expect(parseRoomCodeInput("abcd1").display).toBe("ABCD-1")
    const full = parseRoomCodeInput("abcd1234")
    expect(full).toEqual({ code: "ABCD1234", display: "ABCD-1234", rejected: [], complete: true })
  })

  it("is forgiving about separators, look-alikes and length", () => {
    expect(parseRoomCodeInput(" ab-cd 12_34 ").code).toBe("ABCD1234")
    expect(parseRoomCodeInput("oil0").code).toBe("0110")
    expect(parseRoomCodeInput("ABCD-1234-5678").code).toBe("ABCD1234")
  })

  it("reports characters that can never be in a code", () => {
    const r = parseRoomCodeInput("ABUC!")
    expect(r.code).toBe("ABC")
    expect(r.rejected).toEqual(["U", "!"])
  })

  it("accepts pasted invite links", () => {
    expect(extractCodeFromText("https://atlas.example/join/ABCD-1234?local=1")).toBe("ABCD-1234")
    expect(parseRoomCodeInput("https://atlas.example/join/abcd-1234").display).toBe("ABCD-1234")
    expect(parseRoomCodeInput("http://localhost:5173/join/ABCD1234#x").complete).toBe(true)
  })

  it("builds invite links", () => {
    expect(inviteLink("https://atlas.example", "abcd1234")).toBe("https://atlas.example/join/ABCD-1234")
    expect(inviteLink("http://localhost", "ABCD1234", "?local=1")).toBe("http://localhost/join/ABCD-1234?local=1")
  })
})
