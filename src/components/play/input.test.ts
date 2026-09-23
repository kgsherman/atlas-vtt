// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest"

import { overlayOpen } from "./input"

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
