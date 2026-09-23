// @vitest-environment jsdom
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"

import {
  ColorInput,
  FieldRow,
  NumberInput,
  Segmented,
  SelectInput,
  SliderInput,
  TextInput,
} from "./fields"

let root: Root | null = null
let host: HTMLDivElement | null = null

beforeAll(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom lacks ResizeObserver (Base UI's slider measures its control).
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

function render(ui: React.ReactNode): HTMLElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<TooltipProvider>{ui}</TooltipProvider>))
  return host
}

/** The text of the elements an aria-labelledby list points at. */
function labelledByText(el: Element): string {
  const ids = (el.getAttribute("aria-labelledby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
  return ids
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? `#${id}?`)
    .join(" ")
}

const noop = () => {}

describe("FieldRow labels its controls", () => {
  it("names a number input after the row", () => {
    const el = render(
      <FieldRow label="Elevation">
        <NumberInput value={10} onCommit={noop} />
      </FieldRow>
    )
    expect(labelledByText(el.querySelector("input")!)).toBe("Elevation")
  })

  it("keeps an explicit aria-label", () => {
    const el = render(
      <FieldRow label="Position">
        <NumberInput value={1} onCommit={noop} aria-label="X" />
      </FieldRow>
    )
    const input = el.querySelector("input")!
    expect(input.getAttribute("aria-label")).toBe("X")
    expect(input.hasAttribute("aria-labelledby")).toBe(false)
  })

  it("names text inputs, selects and segmented controls", () => {
    const el = render(
      <>
        <FieldRow label="Author">
          <TextInput value="" onCommit={noop} />
        </FieldRow>
        <FieldRow label="Diagonals">
          <SelectInput
            value="a"
            onValueChange={noop}
            options={[
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ]}
          />
        </FieldRow>
        <FieldRow label="Kind">
          <Segmented
            value="a"
            onValueChange={noop}
            options={[
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ]}
          />
        </FieldRow>
      </>
    )
    expect(labelledByText(el.querySelector("input")!)).toBe("Author")
    expect(labelledByText(el.querySelector('[role="combobox"]')!)).toBe(
      "Diagonals"
    )
    expect(
      labelledByText(
        el.querySelector(
          '[role="group"], [role="radiogroup"], [data-slot="toggle-group"]'
        )!
      )
    ).toBe("Kind")
  })

  it("names colour inputs (hex text and swatch)", () => {
    const el = render(
      <FieldRow label="Ambient fill">
        <ColorInput value="#112233" onChange={noop} />
      </FieldRow>
    )
    expect(labelledByText(el.querySelector('input[type="color"]')!)).toBe(
      "Ambient fill Pick colour"
    )
    expect(labelledByText(el.querySelector('input:not([type="color"])')!)).toBe(
      "Ambient fill"
    )
  })

  it("names sliders", () => {
    const el = render(
      <FieldRow label="Fill strength">
        <SliderInput value={0.5} onChange={noop} min={0} max={1} step={0.1} />
      </FieldRow>
    )
    expect(labelledByText(el.querySelector('input[type="range"]')!)).toBe(
      "Fill strength"
    )
  })

  it("leaves controls outside a row alone", () => {
    const el = render(<NumberInput value={1} onCommit={noop} />)
    expect(el.querySelector("input")!.hasAttribute("aria-labelledby")).toBe(
      false
    )
  })
})
