import { describe, expect, it } from "vitest"

import { createWall } from "./factory"

describe("createWall", () => {
  it("follows the terrain by default; options may override it", () => {
    expect(createWall("L", { x: 0, z: 0 }, { x: 10, z: 0 }).followTerrain).toBe(true)
    expect(createWall("L", { x: 0, z: 0 }, { x: 10, z: 0 }, { followTerrain: false }).followTerrain).toBe(false)
  })
})
