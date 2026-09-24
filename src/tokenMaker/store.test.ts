import { afterEach, describe, expect, it, vi } from "vitest"

import { addLayer, createLayer, emptyDesign, setMask, setTransform } from "@/core/tokenMaker/design"
import type { TokenDesign } from "@/core/tokenMaker/types"

import { downloadName, insertIndex, nameFromFile } from "./actions"
import { createTokenMaker } from "./store"

const blob = () => new Blob([new Uint8Array([1])], { type: "image/png" })
const image = (width = 100, height = 200) => ({ blob: blob(), width, height })

afterEach(() => vi.useRealTimers())

describe("token maker store", () => {
  it("adds layers by role and selects them", () => {
    const { store } = createTokenMaker()
    const s = () => store.getState()
    const bg = s().addFillLayer("#223344", "Backdrop", "background", 0)!
    const ring = s().addImageLayer(image(512, 512), "Ring", "frame")!
    const hero = s().addImageLayer(image(), "Hero", "subject", insertIndex(s().design, "subject"))!
    expect(s().design.layers.map((l) => l.id)).toEqual([bg, hero, ring])
    expect(s().selectedId).toBe(hero)
    expect(Object.keys(s().images)).toHaveLength(2)
    expect(s().past).toHaveLength(3)
  })

  it("merges commits that share a key into one undo step, and undo / redo walk the history", () => {
    vi.useFakeTimers()
    const { store } = createTokenMaker()
    const s = () => store.getState()
    const id = s().addImageLayer(image(), "Hero", "subject")!
    const start = s().design
    for (let k = 1; k <= 5; k++) {
      const l = s().design.layers[0]
      s().commit(setTransform(s().design, id, { ...l.transform, x: 0.5 + k / 100 }), "drag")
      vi.advanceTimersByTime(100)
    }
    expect(s().past).toHaveLength(2)
    // A pause ends the gesture: the next commit is a new step.
    vi.advanceTimersByTime(1000)
    s().commit(setMask(s().design, id, { popOut: true }), "drag")
    expect(s().past).toHaveLength(3)

    s().undo()
    expect(s().design.layers[0].mask.popOut).toBe(false)
    expect(s().design.layers[0].transform.x).toBeCloseTo(0.55)
    s().undo()
    expect(s().design).toBe(start)
    s().redo()
    expect(s().design.layers[0].transform.x).toBeCloseTo(0.55)
    // A new edit drops the redo branch.
    s().setRadius(0.3)
    expect(s().future).toEqual([])
  })

  it("clears the selection when its layer goes away and restores it with undo", () => {
    const { store } = createTokenMaker()
    const s = () => store.getState()
    const id = s().addImageLayer(image(), "Hero", "subject")!
    s().commit({ ...s().design, layers: [] })
    expect(s().selectedId).toBeNull()
    s().select(null)
    s().undo()
    expect(s().design.layers[0].id).toBe(id)
    s().load(emptyDesign(), {})
    expect(s().past).toEqual([])
    expect(s().design.layers).toEqual([])
  })

  it("tracks long operations per layer", () => {
    const { store } = createTokenMaker()
    store.getState().setWorking("a", "Removing the background…")
    expect(store.getState().working).toEqual({ a: "Removing the background…" })
    store.getState().setWorking("a", null)
    expect(store.getState().working).toEqual({})
  })
})

describe("token maker helpers", () => {
  function stack(): TokenDesign {
    let d = emptyDesign()
    d = addLayer(d, createLayer("bg", "Backdrop", { type: "fill", color: "#000000" }, "background"))
    d = addLayer(d, createLayer("hero", "Elf Ranger", { type: "image", imageId: "i", width: 10, height: 20 }, "subject"))
    return addLayer(d, createLayer("ring", "Ring", { type: "image", imageId: "r", width: 10, height: 10 }, "frame"))
  }

  it("places new layers by role", () => {
    const d = stack()
    expect(insertIndex(d, "background")).toBe(0)
    expect(insertIndex(d, "frame")).toBe(3)
    // Character art goes under the frame.
    expect(insertIndex(d, "subject")).toBe(2)
    expect(insertIndex(emptyDesign(), "subject")).toBe(0)
  })

  it("names layers and downloads", () => {
    expect(nameFromFile("elf_ranger-final.png")).toBe("elf ranger-final")
    expect(nameFromFile(".png")).toBe("Image")
    expect(downloadName(stack(), 512)).toBe("elf-ranger-512px.png")
    expect(downloadName(emptyDesign(), 256)).toBe("token-256px.png")
  })
})
