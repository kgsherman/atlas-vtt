// @vitest-environment jsdom
import * as React from "react"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeAll, describe, expect, it } from "vitest"

import { TooltipProvider } from "@/components/ui/tooltip"
import { createScene } from "@/core/scene/factory"
import { blockShape } from "@/core/scene/terrainShapes"
import { createEditorController } from "@/editor/controller"
import type { EditorStore } from "@/editor/store"
import { makeStore } from "@/editor/test-utils"

import { EditorActionsContext, EditorContext, type EditorActions } from "../context"
import { createToolExtrasStore } from "../lib/toolExtras"
import { LevelList, TerrainSection } from "./LevelsPanel"
import { TerrainInspector } from "./TerrainInspector"

let root: Root | null = null
let host: HTMLDivElement | null = null
const disposers: (() => void)[] = []

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  for (const d of disposers.splice(0)) d()
  document.body.innerHTML = ""
})

const noop = () => {}
// Only the header's Focus button reads the page actions here.
const actions = new Proxy({}, { get: () => noop }) as EditorActions

function render(store: EditorStore, ui: React.ReactNode): HTMLElement {
  const controller = createEditorController(store, { now: () => 0 })
  disposers.push(() => controller.dispose())
  host = document.createElement("div")
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <EditorContext.Provider value={{ store, controller, extras: createToolExtrasStore() }}>
        <EditorActionsContext.Provider value={actions}>
          <TooltipProvider>{ui}</TooltipProvider>
        </EditorActionsContext.Provider>
      </EditorContext.Provider>
    )
  )
  return host
}

/** A store whose active (ground) level has terrain and one 2 ft block "b" that the painted ground lacks. */
function terrainStore() {
  const store = makeStore(createScene({ width: 12, depth: 12 }))
  const g = store.getState().activeLevelId
  expect(store.getState().enableTerrain(g)).toBe(true)
  expect(store.getState().applyTerrainEdit(g, { upsert: [blockShape("b", { x: 20, z: 15, w: 10, d: 10 }, 0, 2, 0)] }, "Add block")).toBe(true)
  return { store, g }
}

describe("LevelsPanel terrain section", () => {
  it("explains a disabled Flatten: its tooltip trigger is an element that still gets the hover", () => {
    // Only the shape raises the terrain: the painted ground is flat, so Flatten is disabled.
    const { store, g } = terrainStore()
    const el = render(store, <TerrainSection level={store.getState().scene.levels[g]} />)
    const flatten = [...el.querySelectorAll("button")].find((b) => b.textContent === "Flatten")!
    expect(flatten.disabled).toBe(true)
    // A disabled button gets no pointer events (native, and `disabled:pointer-events-none`) and no focus,
    // so it cannot be the trigger itself: an enabled wrapper around it is.
    const trigger = flatten.closest("[data-slot=tooltip-trigger]")
    expect(trigger).not.toBeNull()
    expect(trigger).not.toBe(flatten)
    expect(trigger!.matches(":disabled")).toBe(false)
    act(() => void trigger!.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false })))
    expect(document.body.textContent).toContain("The painted ground is already flat")
  })
})

describe("LevelsPanel level list", () => {
  const nameSpan = (el: HTMLElement, name: string) => [...el.querySelectorAll("[role=radio] span")].find((s) => s.textContent === name)!
  const type = (input: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
    input.dispatchEvent(new Event("input", { bubbles: true }))
  }

  it("renames a level in place on double-click; Escape cancels", () => {
    const store = makeStore(createScene({ width: 12, depth: 12 }))
    const g = store.getState().activeLevelId
    const before = store.getState().scene.levels[g].name
    const el = render(store, <LevelList />)

    act(() => void nameSpan(el, before).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })))
    let input = el.querySelector<HTMLInputElement>("input[aria-label='Level name']")!
    expect(document.activeElement).toBe(input)
    act(() => type(input, "Scrap"))
    act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    expect(el.querySelector("input[aria-label='Level name']")).toBeNull()
    expect(store.getState().scene.levels[g].name).toBe(before)

    act(() => void nameSpan(el, before).dispatchEvent(new MouseEvent("dblclick", { bubbles: true })))
    input = el.querySelector<HTMLInputElement>("input[aria-label='Level name']")!
    act(() => type(input, "  Courtyard  "))
    act(() => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
    expect(el.querySelector("input[aria-label='Level name']")).toBeNull()
    expect(store.getState().scene.levels[g].name).toBe("Courtyard")
  })
})

describe("TerrainInspector", () => {
  const HINT = "in the viewport; Delete"

  it("shows the element hint only where the tool edits elements (the Select sub-tool, advanced mode on)", () => {
    const { store, g } = terrainStore()
    const s = store.getState()
    s.setTool("terrain")
    s.setToolSettings("terrain", { sub: "select", advanced: true, element: "vertex" })
    s.setTerrainSelection({ levelId: g, shapeIds: ["b"], elements: [{ shapeId: "b", kind: "vertex", index: 0 }] })
    const el = render(store, <TerrainInspector />)
    expect(el.textContent).toContain("1 vertex selected: drag it in the viewport")
    expect(el.textContent).toContain("Delete dissolves vertices")
    // Brush and the create sub-tools keep the (hidden) vertex selection, but there Delete removes the shape.
    for (const sub of ["brush", "block", "ramp", "cylinder"] as const) {
      act(() => store.getState().setToolSettings("terrain", { sub }))
      expect(store.getState().terrainSelection?.elements).toHaveLength(1)
      expect(el.textContent).toContain("Block")
      expect(el.textContent).not.toContain(HINT)
    }
    // Back in Select the hint returns; with the advanced mode off (object mode) it goes again.
    act(() => store.getState().setToolSettings("terrain", { sub: "select" }))
    expect(el.textContent).toContain(HINT)
    act(() => store.getState().setToolSettings("terrain", { advanced: false }))
    expect(el.textContent).not.toContain(HINT)
  })
})
