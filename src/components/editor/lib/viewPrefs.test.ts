import { describe, expect, it } from "vitest"

import { readEditorView, writeEditorView } from "./viewPrefs"

function memoryStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  }
}

describe("editor view prefs", () => {
  it("round-trips the camera and view toggles per scene", () => {
    const st = memoryStorage()
    writeEditorView(
      "s1",
      {
        camera: "topdown",
        showGrid: false,
        showHelpers: true,
        ghostAdjacent: false,
      },
      st
    )
    expect(readEditorView("s1", st)).toEqual({
      camera: "topdown",
      showGrid: false,
      showHelpers: true,
      ghostAdjacent: false,
    })
    expect(readEditorView("s2", st)).toBeNull()
  })

  it("ignores malformed or foreign values", () => {
    const st = memoryStorage()
    st.m.set(
      "atlas-editor:view:s1",
      JSON.stringify({
        camera: "fisheye",
        showGrid: "yes",
        ghostAdjacent: true,
      })
    )
    expect(readEditorView("s1", st)).toEqual({ ghostAdjacent: true })
    st.m.set("atlas-editor:view:s2", "{nope")
    expect(readEditorView("s2", st)).toBeNull()
    expect(readEditorView("s3", null)).toBeNull()
  })
})
