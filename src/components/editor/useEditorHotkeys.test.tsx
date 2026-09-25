// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { setKeyOverrides } from "@/components/keybindings/keymapStore"
import { createEditorController, type EditorController } from "@/editor/controller"
import { fixtureScene, makeStore } from "@/editor/test-utils"

import { useEditorHotkeys, type EditorHotkeysOptions } from "./useEditorHotkeys"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function Harness({ controller, ...opts }: EditorHotkeysOptions & { controller: EditorController }) {
  useEditorHotkeys(controller, opts)
  return null
}

let root: Root
let controller: EditorController
const save = vi.fn()
const escape = vi.fn()

function render(opts: Partial<EditorHotkeysOptions> = {}) {
  act(() => root.render(<Harness controller={controller} enabled save={save} escape={escape} {...opts} />))
}

function press(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body, type = "keydown"): KeyboardEvent {
  const e = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init })
  act(() => void target.dispatchEvent(e))
  return e
}

beforeEach(() => {
  controller = createEditorController(makeStore(fixtureScene().scene), { now: () => 0 })
  root = createRoot(document.createElement("div"))
  save.mockReset()
  escape.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  controller.dispose()
  setKeyOverrides("editor", {})
  document.body.innerHTML = ""
})

describe("useEditorHotkeys", () => {
  it("runs bound keys and prevents their default", () => {
    render()
    expect(press("c").defaultPrevented).toBe(true)
    expect(controller.store.getState().tool).toBe("wall")
  })

  it("leaves unused keys to the browser", () => {
    render()
    const e = press("Delete")
    expect(e.defaultPrevented).toBe(false)
  })

  it("ignores keys typed into text fields and under dialogs, but saves from anywhere", () => {
    render()
    const input = document.body.appendChild(document.createElement("input"))
    press("w", {}, input)
    expect(controller.store.getState().tool).toBe("select")
    expect(press("s", { ctrlKey: true }, input).defaultPrevented).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
    document.body.insertAdjacentHTML("beforeend", '<div data-slot="dialog-content"></div>')
    press("w")
    expect(controller.store.getState().tool).toBe("select")
  })

  it("keeps navigation keys for a focused widget", () => {
    render()
    const button = document.body.appendChild(document.createElement("button"))
    expect(press("PageUp", {}, button).defaultPrevented).toBe(false)
    expect(press("c", {}, button).defaultPrevented).toBe(true)
  })

  it("passes an unused Escape to the page", () => {
    render()
    press("Escape")
    expect(escape).toHaveBeenCalledTimes(1)
  })

  it("is off while disabled, except save", () => {
    render({ enabled: false })
    press("w")
    expect(controller.store.getState().tool).toBe("select")
    press("s", { ctrlKey: true })
    expect(save).toHaveBeenCalledTimes(1)
  })

  it("tracks Alt for free placement", () => {
    render()
    press("Alt", { altKey: true })
    expect(controller.store.getState().altHeld).toBe(true)
    press("Alt", {}, document.body, "keyup")
    expect(controller.store.getState().altHeld).toBe(false)
  })

  it("fires toggle keys once per press, repeating keys on auto-repeat", () => {
    render()
    const keyDown = vi.spyOn(controller, "keyDown")
    const axis = () => keyDown.mock.calls.filter(([, a]) => a.type === "axis").length
    press("x")
    press("x", { repeat: true })
    press("x", { repeat: true })
    expect(axis()).toBe(1)
    press("x", {}, document.body, "keyup")
    press("x")
    expect(axis()).toBe(2)
    const nudges = () => keyDown.mock.calls.filter(([, a]) => a.type === "nudge").length
    press("ArrowUp")
    press("ArrowUp", { repeat: true })
    expect(nudges()).toBe(2)
  })

  it("leaves navigation keys to a focused widget", () => {
    render()
    const keyDown = vi.spyOn(controller, "keyDown")
    const button = document.body.appendChild(document.createElement("button"))
    expect(press("ArrowUp", {}, button).defaultPrevented).toBe(false)
    expect(keyDown).not.toHaveBeenCalled()
    press("ArrowUp")
    expect(keyDown.mock.calls.map(([, a]) => a.type)).toEqual(["nudge"])
  })

  it("Tab switches to Play (on a focused button too), never while typing; without a handler it stays with the browser", () => {
    render()
    const keyDown = vi.spyOn(controller, "keyDown")
    expect(press("Tab").defaultPrevented).toBe(false)
    press("Tab", {}, document.body, "keyup")
    const mode = vi.fn()
    render({ mode })
    press("Tab")
    press("Tab", {}, document.body, "keyup")
    const button = document.body.appendChild(document.createElement("button"))
    expect(press("Tab", {}, button).defaultPrevented).toBe(true)
    press("Tab", {}, button, "keyup")
    const input = document.body.appendChild(document.createElement("input"))
    expect(press("Tab", {}, input).defaultPrevented).toBe(false)
    expect(mode).toHaveBeenCalledTimes(2)
    // The terrain tool's advanced mode no longer has Tab.
    expect(keyDown).not.toHaveBeenCalled()
  })

  it("follows remaps live", () => {
    render()
    act(() => setKeyOverrides("editor", { "tool.wall": ["Shift+J"] }))
    press("c")
    expect(controller.store.getState().tool).toBe("select")
    press("J", { shiftKey: true })
    expect(controller.store.getState().tool).toBe("wall")
  })

  it("never binds the camera's pan keys", () => {
    render()
    act(() => setKeyOverrides("editor", { "tool.wall": ["W"], "tool.door": ["Shift+D", "J"] }))
    press("w")
    press("D", { shiftKey: true })
    expect(controller.store.getState().tool).toBe("select")
    press("c")
    expect(controller.store.getState().tool).toBe("wall")
    press("j")
    expect(controller.store.getState().tool).toBe("door")
  })
})
