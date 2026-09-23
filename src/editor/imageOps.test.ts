/**
 * Editor image commands against the real editor store (one undo step each, validated documents).
 */
import { describe, expect, it } from "vitest"

import { createScene } from "@/core/scene/factory"
import type { TraceImage } from "@/core/scene/imageTrace"
import { floorRects } from "@/core/scene/queries"
import { parseScene } from "@/core/scene/schema"
import type { FloorObject, Vec2, WallObject } from "@/core/scene/types"
import type { ImportedImage } from "@/net/assets/import"
import type { AssetMeta } from "@/net/assets/types"

import { addBackdrop, floorFromImage, removeBackdrop, updateBackdrop, wallsFromImage } from "./imageOps"
import { makeStore } from "./test-utils"

/** RGBA image (width×height px) opaque inside `inside(px, py)` (pixel centres). */
function image(width: number, height: number, inside: (x: number, y: number) => boolean): TraceImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const k = (y * width + x) * 4
      data[k] = 120
      data[k + 1] = 100
      data[k + 2] = 80
      data[k + 3] = inside(x + 0.5, y + 0.5) ? 255 : 0
    }
  }
  return { width, height, data }
}

/** A rotated L-shaped storey on a 20×20-cell (100 ft) map drawn at 4 px per ft. */
function lStorey(): TraceImage {
  const c = Math.cos(0.3)
  const s = Math.sin(0.3)
  return image(400, 400, (x, y) => {
    // Rotate the pixel back into the L's frame about the centre.
    const u = (x - 200) * c + (y - 200) * s + 200
    const v = -(x - 200) * s + (y - 200) * c + 200
    const inA = u > 100 && u < 300 && v > 80 && v < 200
    const inB = u > 100 && u < 200 && v >= 200 && v < 320
    return inA || inB
  })
}

function imported(pixels: TraceImage, rect = { x: 0, z: 0, w: 100, d: 100 }): ImportedImage {
  return {
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/webp" }),
    width: pixels.width,
    height: pixels.height,
    mime: "image/webp",
    pxPerCell: pixels.width / (rect.w / 5),
    pixels: { width: pixels.width, height: pixels.height, data: new Uint8ClampedArray(pixels.data) },
    rect,
  }
}

const meta = (id: string): AssetMeta => ({ id, kind: "image", name: `${id}.webp`, mime: "image/webp", width: 400, height: 400, bytes: 3 })

describe("addBackdrop / updateBackdrop / removeBackdrop", () => {
  it("adds asset metadata and the backdrop in one undo step", () => {
    const store = makeStore(createScene({ width: 20, depth: 20 }))
    const levelId = store.getState().activeLevelId
    const img = imported(lStorey())
    expect(addBackdrop(store, levelId, img, meta("imgA"), { opacity: 0.8 })).toBe(true)
    let scene = store.getState().scene
    expect(scene.assets).toEqual({ imgA: meta("imgA") })
    expect(scene.levels[levelId].backdrop).toEqual({ assetId: "imgA", rect: { x: 0, z: 0, w: 100, d: 100 }, opacity: 0.8, tintWalls: false })
    expect(parseScene(JSON.parse(JSON.stringify(scene))).ok).toBe(true)
    expect(store.getState().history.undoDepth).toBe(1)

    // Replacing the image drops the old metadata in the same step.
    expect(addBackdrop(store, levelId, img, meta("imgB"))).toBe(true)
    scene = store.getState().scene
    expect(Object.keys(scene.assets!)).toEqual(["imgB"])
    store.getState().undo()
    expect(store.getState().scene.assets).toEqual({ imgA: meta("imgA") })
    store.getState().undo()
    expect(store.getState().scene.assets).toBeUndefined()
    expect(store.getState().scene.levels[levelId].backdrop).toBeUndefined()
  })

  it("refuses unknown levels and read-only documents", () => {
    const store = makeStore(createScene({ width: 20, depth: 20 }))
    expect(addBackdrop(store, "nope", imported(lStorey()), meta("imgA"))).toBe(false)
    store.getState().loadScene(createScene({ width: 20, depth: 20 }), { readOnly: true })
    expect(addBackdrop(store, store.getState().activeLevelId, imported(lStorey()), meta("imgA"))).toBe(false)
    expect(store.getState().scene.assets).toBeUndefined()
  })

  it("coalesces opacity edits and removes the backdrop with its metadata", () => {
    const store = makeStore(createScene({ width: 20, depth: 20 }))
    const levelId = store.getState().activeLevelId
    addBackdrop(store, levelId, imported(lStorey()), meta("imgA"))
    updateBackdrop(store, levelId, { opacity: 0.5 })
    updateBackdrop(store, levelId, { opacity: 0.4 })
    expect(store.getState().scene.levels[levelId].backdrop?.opacity).toBe(0.4)
    expect(store.getState().history.undoDepth).toBe(2)
    expect(updateBackdrop(store, levelId, { tintWalls: true })).toBe(true)
    expect(removeBackdrop(store, levelId)).toBe(true)
    expect(store.getState().scene.levels[levelId].backdrop).toBeNull()
    expect(store.getState().scene.assets).toBeUndefined()
    store.getState().undo()
    expect(store.getState().scene.levels[levelId].backdrop?.tintWalls).toBe(true)
  })
})

describe("floorFromImage", () => {
  it("adds a masked floor covering the opaque storey (one undo step)", () => {
    const store = makeStore(createScene({ width: 20, depth: 20, groundFloor: false }))
    const levelId = store.getState().activeLevelId
    const img = imported(lStorey())
    const id = floorFromImage(store, levelId, img.pixels, img)!
    expect(id).toBeTruthy()
    const floor = store.getState().scene.objects[id] as FloorObject
    expect(floor.mask).toBeDefined()
    // L area: 50×30 + 25×30 ft = 2250 ft² (± the boundary cells).
    const area = floorRects(floor).reduce((s, r) => s + r.w * r.d, 0)
    expect(Math.abs(area - 2250)).toBeLessThan(150)
    expect(store.getState().history.undoDepth).toBe(1)
    store.getState().undo()
    expect(store.getState().scene.objects[id]).toBeUndefined()
  })

  it("replaces the level's floors when asked, and returns null for transparent images", () => {
    const store = makeStore(createScene({ width: 20, depth: 20 }))
    const levelId = store.getState().activeLevelId
    const blank = imported(image(40, 40, () => false))
    expect(floorFromImage(store, levelId, blank.pixels, blank)).toBeNull()
    const full = imported(image(40, 40, () => true))
    const id = floorFromImage(store, levelId, full.pixels, full, { replace: true, material: "wood" })!
    const floors = Object.values(store.getState().scene.objects).filter((o) => o.type === "floor")
    expect(floors.map((f) => f.id)).toEqual([id])
    // Fully opaque → a plain rect floor.
    expect((floors[0] as FloorObject).mask).toBeUndefined()
    expect((floors[0] as FloorObject).material).toBe("wood")
  })
})

describe("wallsFromImage", () => {
  it("adds the outline walls in one undo step, at the level height", () => {
    const store = makeStore(createScene({ width: 20, depth: 20 }))
    const levelId = store.getState().activeLevelId
    const img = imported(lStorey())
    const ids = wallsFromImage(store, levelId, img.pixels, img)
    expect(ids).toHaveLength(6)
    const walls = ids.map((id) => store.getState().scene.objects[id] as WallObject)
    expect(walls.every((w) => w.height === 10 && w.thickness === 1)).toBe(true)
    // A closed outline: every endpoint is shared by two walls (so corners form joints).
    const count = new Map<string, number>()
    const key = (p: Vec2) => `${p.x},${p.z}`
    for (const w of walls) for (const p of [w.a, w.b]) count.set(key(p), (count.get(key(p)) ?? 0) + 1)
    expect([...count.values()].every((n) => n === 2)).toBe(true)
    expect(store.getState().history.undoDepth).toBe(1)
    store.getState().undo()
    expect(ids.every((id) => !(id in store.getState().scene.objects))).toBe(true)
  })

  it("returns [] for images without an outline", () => {
    const store = makeStore(createScene({ width: 20, depth: 20 }))
    const blank = imported(image(40, 40, () => false))
    expect(wallsFromImage(store, store.getState().activeLevelId, blank.pixels, blank)).toEqual([])
  })
})
