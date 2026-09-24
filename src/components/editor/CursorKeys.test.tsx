// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { EngineContext } from "@/components/canvas/engineContext"
import type { EditorController } from "@/editor/controller"
import type { CursorKey } from "@/editor/tools/types"

import { CursorKeys } from "./CursorKeys"

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

/** A controller stub: only what CursorKeys reads. */
function fakeController(initial: readonly CursorKey[] | null) {
  let keys = initial
  const listeners = new Set<() => void>()
  const controller = {
    subscribe(l: () => void) {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    toolCursorKeys: () => keys,
  } as unknown as EditorController
  return {
    controller,
    set(next: readonly CursorKey[] | null) {
      keys = next
      for (const l of listeners) l()
    },
  }
}

function mount(controller: EditorController) {
  const canvas = document.createElement("canvas")
  Object.defineProperty(canvas, "clientWidth", { value: 800 })
  Object.defineProperty(canvas, "clientHeight", { value: 600 })
  canvas.getBoundingClientRect = () => ({ left: 100, top: 50, right: 900, bottom: 650, width: 800, height: 600, x: 100, y: 50, toJSON: () => ({}) })
  host = document.createElement("div")
  document.body.append(host, canvas)
  root = createRoot(host)
  act(() =>
    root!.render(
      <EngineContext.Provider value={{ engine: null, canvas }}>
        <CursorKeys controller={controller} />
      </EngineContext.Provider>
    )
  )
  const box = () => host!.querySelector<HTMLElement>("[data-slot=cursor-keys]")
  const move = (clientX: number, clientY: number) => act(() => void canvas.dispatchEvent(new MouseEvent("pointermove", { clientX, clientY })))
  return { canvas, box, move }
}

const KEYS: readonly CursorKey[] = [
  { mouse: "Click", label: "Add corner" },
  { mouse: "Right-click", commands: ["confirm"], label: "Finish, set height" },
  { commands: ["escape"], label: "Cancel" },
]

describe("CursorKeys", () => {
  it("shows the tool's keys to the right of the pointer, with the keymap's key caps", () => {
    const { controller, set } = fakeController(null)
    const { box, move, canvas } = mount(controller)
    expect(box()).toBeNull()
    act(() => set(KEYS))
    // Hidden until the pointer is over the canvas.
    expect(box()!.style.visibility).toBe("hidden")
    move(300, 250)
    const el = box()!
    expect(el.style.visibility).toBe("visible")
    // Canvas-relative (200, 200) plus the offset.
    expect(el.style.transform).toBe("translate(220px, 214px)")
    expect(el.textContent).toContain("Add corner")
    expect(el.textContent).toContain("Right-click")
    expect([...el.querySelectorAll("kbd")].map((k) => k.textContent)).toEqual(["Click", "Right-click", "Enter", "Esc"])
    act(() => void canvas.dispatchEvent(new MouseEvent("pointerleave")))
    expect(el.style.visibility).toBe("hidden")
    act(() => set(null))
    expect(box()).toBeNull()
  })
})
