// @vitest-environment jsdom
import * as React from "react"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it, vi } from "vitest"

import { overlayOpen, useAppHotkeys, type AppHotkey } from "./hotkeys"

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

function mount(html: string): void {
  document.body.innerHTML = html
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("overlayOpen", () => {
  it("is false on an empty page", () => {
    expect(overlayOpen()).toBe(false)
  })

  it("ignores a listbox kept mounted inside a hidden wrapper (closed Base UI Select)", () => {
    mount('<div hidden><div role="listbox"></div></div>')
    expect(overlayOpen()).toBe(false)
  })

  it("ignores a listbox inside an inert wrapper (closing popup)", () => {
    mount('<div inert><div role="listbox"></div></div>')
    expect(overlayOpen()).toBe(false)
  })

  it("counts a visible listbox", () => {
    mount('<div role="listbox"></div>')
    expect(overlayOpen()).toBe(true)
  })

  it("counts a visible dialog", () => {
    mount('<div data-slot="dialog-content"></div>')
    expect(overlayOpen()).toBe(true)
  })

  it("counts a live menu even when a hidden listbox is also mounted", () => {
    mount('<div hidden><div role="listbox"></div></div><div role="menu"></div>')
    expect(overlayOpen()).toBe(true)
  })

  it("checks only the given root", () => {
    const root = document.createElement("div")
    root.innerHTML = '<div role="menu"></div>'
    expect(overlayOpen(root)).toBe(true)
    expect(overlayOpen()).toBe(false)
  })
})

describe("useAppHotkeys", () => {
  function mountHotkeys(hotkeys: AppHotkey[]) {
    const root = createRoot(document.createElement("div"))
    const Harness = () => {
      useAppHotkeys(hotkeys)
      return null
    }
    act(() => root.render(React.createElement(Harness)))
    return () => act(() => root.unmount())
  }
  const press = (key: string, init: KeyboardEventInit = {}, type = "keydown") => {
    const e = new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init })
    document.body.dispatchEvent(e)
    return e
  }

  it("prevents the default only when the key was used", () => {
    let used = false
    const unmount = mountHotkeys([{ hotkey: "Tab", run: () => used }])
    expect(press("Tab").defaultPrevented).toBe(false)
    used = true
    expect(press("Tab").defaultPrevented).toBe(true)
    unmount()
  })

  it("fires once per press when repeat is off", () => {
    const run = vi.fn()
    const unmount = mountHotkeys([{ hotkey: "Q", repeat: false, run }])
    press("q")
    press("q", { repeat: true })
    expect(run).toHaveBeenCalledTimes(1)
    press("q", {}, "keyup")
    press("q")
    expect(run).toHaveBeenCalledTimes(2)
    unmount()
  })

  it("skips events another handler already handled", () => {
    const run = vi.fn()
    const unmount = mountHotkeys([{ hotkey: "G", run }])
    const e = new KeyboardEvent("keydown", { key: "g", bubbles: true, cancelable: true })
    e.preventDefault()
    document.body.dispatchEvent(e)
    expect(run).not.toHaveBeenCalled()
    unmount()
  })
})
