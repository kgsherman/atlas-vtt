// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

import { OrbitCameraController } from "./orbit"

describe("OrbitCameraController", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("removes its document key listeners even when the canvas was detached first", () => {
    const canvas = document.createElement("canvas")
    document.body.appendChild(canvas)
    const added: { type: string; fn: EventListenerOrEventListenerObject | null; capture: boolean }[] = []
    const removed: { type: string; fn: EventListenerOrEventListenerObject | null; capture: boolean }[] = []
    const capture = (o?: boolean | AddEventListenerOptions | EventListenerOptions) => (typeof o === "boolean" ? o : !!o?.capture)
    const add = document.addEventListener.bind(document)
    const remove = document.removeEventListener.bind(document)
    vi.spyOn(document, "addEventListener").mockImplementation((type, fn, o) => {
      added.push({ type, fn, capture: capture(o) })
      add(type, fn, o)
    })
    vi.spyOn(document, "removeEventListener").mockImplementation((type, fn, o) => {
      removed.push({ type, fn, capture: capture(o) })
      remove(type, fn, o)
    })
    const orbit = new OrbitCameraController(canvas)
    // A Control press also registers the keyup interceptor on the document.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" }))
    const captured = added.filter((a) => a.capture)
    expect(captured.map((a) => a.type).sort()).toEqual(["keydown", "keyup"])
    // React removes the DOM before effect cleanups run.
    canvas.remove()
    orbit.dispose()
    for (const a of captured) expect(removed.some((r) => r.type === a.type && r.fn === a.fn && r.capture)).toBe(true)
  })
})
