import { describe, expect, it } from "vitest"

import { freeTokenModelRef, parseTokenModelRef } from "./tokenModel"

describe("token model references", () => {
  it("round-trip free asset ids", () => {
    expect(freeTokenModelRef("elf-archer")).toBe("free:elf-archer")
    expect(parseTokenModelRef("free:elf-archer")).toEqual({ source: "free", assetId: "elf-archer" })
  })

  it("refuse anything else", () => {
    for (const id of ["", "Elf", "-x", "a b", "a".repeat(65)]) expect(freeTokenModelRef(id), id).toBeNull()
    for (const ref of [undefined, null, 1, "", "free:", "elf-archer", "http://x/y.glb", "free:Elf"]) expect(parseTokenModelRef(ref), String(ref)).toBeNull()
  })
})
