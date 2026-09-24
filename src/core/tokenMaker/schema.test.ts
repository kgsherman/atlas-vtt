import { describe, expect, it } from "vitest"

import { addLayer, addStroke, createLayer, emptyDesign, setMask, TOKEN_LIMITS } from "./design"
import { designImageIds, parseTokenDesign } from "./schema"
import type { TokenDesign } from "./types"

function design(): TokenDesign {
  let d = emptyDesign()
  d = addLayer(d, createLayer("bg", "Background", { type: "fill", color: "#201a24" }, "background"))
  d = addLayer(d, createLayer("hero", "Hero", { type: "image", imageId: "img-1", width: 600, height: 900 }, "subject"))
  d = addLayer(d, createLayer("ring", "Ring", { type: "image", imageId: "img-2", width: 512, height: 512 }, "frame"))
  d = setMask(d, "hero", { popOut: true })
  return addStroke(d, "hero", { mode: "reveal", size: 0.05, points: [0.2, 0.8, 0.25, 0.85] })
}

describe("parseTokenDesign", () => {
  it("round-trips a valid design", () => {
    const d = design()
    expect(parseTokenDesign(JSON.parse(JSON.stringify(d)))).toEqual(d)
    expect(designImageIds(d)).toEqual(["img-1", "img-2"])
  })

  it("refuses anything malformed", () => {
    const bad = (mutate: (d: Record<string, unknown> & TokenDesign) => void) => {
      const d = JSON.parse(JSON.stringify(design()))
      mutate(d)
      expect(parseTokenDesign(d)).toBeNull()
    }
    bad((d) => (d.version = 2 as never))
    bad((d) => (d.radius = 0.9))
    bad((d) => (d.extra = true))
    bad((d) => (d.layers[1].transform.scale = Number.NaN))
    bad((d) => (d.layers[1].opacity = 2))
    bad((d) => (d.layers[1].id = "__bad id__"))
    bad((d) => (d.layers[2].id = "hero"))
    bad((d) => (d.layers[0].source = { type: "fill", color: "red" }))
    bad((d) => (d.layers[1].source = { type: "image", imageId: "x", width: 0, height: 10 }))
    bad((d) => (d.layers[1].mask.strokes[0].points = [0.1, 0.2, 0.3]))
    bad((d) => (d.layers[1].mask.shape = "star" as never))
    bad((d) => (d.layers = Array.from({ length: TOKEN_LIMITS.maxLayers + 1 }, (_, k) => ({ ...d.layers[0], id: `l${k}` }))))
    expect(parseTokenDesign(null)).toBeNull()
    expect(parseTokenDesign("design")).toBeNull()
  })
})
