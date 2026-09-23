// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TextLabel } from "./label"

function fakeCtx(): CanvasRenderingContext2D {
  const noop = () => {}
  return {
    font: "",
    fillStyle: "",
    textBaseline: "",
    textAlign: "",
    measureText: (t: string) => ({ width: t.length * 14 }),
    beginPath: noop,
    moveTo: noop,
    arcTo: noop,
    closePath: noop,
    fill: noop,
    fillText: noop,
    clearRect: noop,
  } as unknown as CanvasRenderingContext2D
}

describe("TextLabel", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(fakeCtx as never)
  })
  afterEach(() => vi.restoreAllMocks())

  it("reallocates the GL texture when the text changes the canvas size", () => {
    const label = new TextLabel()
    const tex = label.sprite.material.map!
    const disposed = vi.fn()
    tex.addEventListener("dispose", disposed)
    label.setText("5 ft")
    const n0 = disposed.mock.calls.length
    label.setText("25 ft")
    expect(disposed.mock.calls.length).toBe(n0 + 1)
    label.setText("35 ft")
    expect(disposed.mock.calls.length).toBe(n0 + 1)
    label.setText("125 ft (25 squares)")
    expect(disposed.mock.calls.length).toBe(n0 + 2)
    expect(label.sprite.material.map).toBe(tex)
  })
})
