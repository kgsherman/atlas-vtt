import { describe, expect, it } from "vitest"

import { createLevel, createScene } from "@/core/scene/factory"
import { createCellMask, createGradeMask, encodeGrades, encodeMask, setCell } from "@/core/vision/mask"

import type { HostLevelMasks } from "../contracts"
import { createSharedUniforms } from "../lighting/uniforms"
import { HostMaskTextures } from "./hostMaskTextures"
import { maskLayerBytes } from "./maskExpand"

function masksWith(width: number, depth: number, exploredCells: number[]): HostLevelMasks {
  const e = createCellMask(width, depth)
  for (const c of exploredCells) setCell(e, c)
  return { perception: encodeGrades(createGradeMask(width, depth)), explored: encodeMask(e) }
}

describe("HostMaskTextures", () => {
  it("creates one RGBA layer per level and shares per-level layer uniforms", () => {
    const scene = createScene({ width: 4, depth: 3 })
    const ground = Object.keys(scene.levels)[0]
    const upper = createLevel({ elevation: 10 })
    scene.levels[upper.id] = upper
    const shared = createSharedUniforms()
    const t = new HostMaskTextures(shared)
    const groundUniform = t.levelUniform(ground)
    expect(groundUniform.value).toBe(-1)
    expect(t.sync(scene, { [ground]: masksWith(4, 3, [0]) })).toBe(true)
    const tex = shared.uMasks.value as unknown as { image: { width: number; height: number; depth: number; data: Uint8Array }; layerUpdates: Set<number> }
    expect(tex.image.width).toBe(16)
    expect(tex.image.height).toBe(12)
    expect(tex.image.depth).toBe(2)
    expect(groundUniform.value).toBe(0)
    expect(t.levelUniform(upper.id).value).toBe(1)
    expect(t.layerOf(upper.id)).toBe(1)
    // Explored cell 0 of the ground level → G = 255 in layer 0; upper layer all zero.
    expect(tex.image.data[1]).toBe(255)
    expect(tex.image.data.subarray(maskLayerBytes(4, 3)).every((b) => b === 0)).toBe(true)
    expect(shared.uMaskGrid.value.toArray()).toEqual([1 / 20, 1 / 15, 16, 12])
    // First upload: all layers (no partial layer updates).
    expect(tex.layerUpdates.size).toBe(0)
  })

  it("re-uploads only levels whose masks changed", () => {
    const scene = createScene({ width: 4, depth: 3 })
    const ground = Object.keys(scene.levels)[0]
    const upper = createLevel({ elevation: 10 })
    scene.levels[upper.id] = upper
    const shared = createSharedUniforms()
    const t = new HostMaskTextures(shared)
    t.sync(scene, { [ground]: masksWith(4, 3, [0]) })
    const tex = shared.uMasks.value as unknown as {
      layerUpdates: Set<number>
      version: number
      onUpdate: (t: unknown) => void
      clearLayerUpdates: () => void
    }
    // What three does after uploading: partial uploads clear the queue, then onUpdate fires.
    const upload = () => {
      tex.clearLayerUpdates()
      tex.onUpdate(tex)
    }
    // Before the first upload, changes keep the full upload (no per-layer updates).
    t.sync(scene, { [ground]: masksWith(4, 3, [1]) })
    expect(tex.layerUpdates.size).toBe(0)
    expect(t.pendingFullUpload).toBe(true)
    upload()
    expect(t.pendingFullUpload).toBe(false)
    t.sync(scene, { [ground]: masksWith(4, 3, [0]) })
    expect([...tex.layerUpdates]).toEqual([0])
    upload()
    const v0 = tex.version
    // Same content, new objects: nothing to do.
    expect(t.sync(scene, { [ground]: masksWith(4, 3, [0]) })).toBe(false)
    expect(tex.version).toBe(v0)
    // Upper level changes only.
    expect(t.sync(scene, { [ground]: masksWith(4, 3, [0]), [upper.id]: masksWith(4, 3, [5]) })).toBe(true)
    expect([...tex.layerUpdates]).toEqual([1])
    expect(tex.version).toBe(v0 + 1)
  })

  it("re-creates the texture when the grid or level count changes", () => {
    const scene = createScene({ width: 4, depth: 3 })
    const shared = createSharedUniforms()
    const t = new HostMaskTextures(shared)
    t.sync(scene, {})
    const first = shared.uMasks.value
    scene.grid = { ...scene.grid, width: 6 }
    t.sync(scene, {})
    expect(shared.uMasks.value).not.toBe(first)
    t.dispose()
    expect(shared.uMasks.value?.name).toBe("atlas-placeholder-masks")
  })
})
