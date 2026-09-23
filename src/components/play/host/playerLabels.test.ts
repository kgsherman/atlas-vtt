import { describe, expect, it } from "vitest"

import { duplicateNames, playerLabels } from "./playerLabels"

describe("playerLabels", () => {
  it("keeps unique names and numbers repeats in join order", () => {
    const labels = playerLabels([
      { userId: "a", displayName: "Theron" },
      { userId: "b", displayName: "Mira" },
      { userId: "c", displayName: "theron " },
      { userId: "d", displayName: "Theron" },
    ])
    expect([...labels]).toEqual([
      ["a", "Theron"],
      ["b", "Mira"],
      ["c", "theron (2)"],
      ["d", "Theron (3)"],
    ])
  })

  it("lists the names shared by several players", () => {
    expect(
      duplicateNames([
        { userId: "a", displayName: "Theron" },
        { userId: "b", displayName: "Mira" },
        { userId: "c", displayName: "THERON" },
      ])
    ).toEqual(["Theron"])
    expect(duplicateNames([{ userId: "a", displayName: "Theron" }])).toEqual([])
  })
})
