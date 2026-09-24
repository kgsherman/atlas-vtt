import { describe, expect, it } from "vitest"

import {
  addLayer,
  addStroke,
  BACKGROUND_GROW,
  breaksOut,
  clampTransform,
  clearStrokes,
  createLayer,
  DEFAULT_RADIUS,
  emptyDesign,
  extendStroke,
  fitTransform,
  layerCorners,
  layerDisc,
  moveLayer,
  pickLayer,
  pointInLayer,
  popOutRect,
  radiusForFrame,
  removeLayer,
  replaceImage,
  setMask,
  setTransform,
  TOKEN_LIMITS,
  toLayerUv,
  translateLayer,
  zoomLayerAt,
} from "./design"
import type { TokenDesign, TokenLayer } from "./types"

const img = (w: number, h: number, imageId = "img") => ({ type: "image" as const, imageId, width: w, height: h })

function sample(): TokenDesign {
  let d = emptyDesign()
  d = addLayer(d, createLayer("bg", "Background", img(1000, 500, "bg"), "background"))
  d = addLayer(d, createLayer("hero", "Hero", img(400, 800, "hero"), "subject"))
  d = addLayer(d, createLayer("ring", "Ring", img(512, 512, "ring"), "frame"))
  return d
}

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 9)

describe("layers", () => {
  it("creates layers with the role's fit and mask", () => {
    const d = sample()
    const [bg, hero, ring] = d.layers
    // Background covers the disc (+ grow) whatever its aspect ratio.
    const side = 2 * (DEFAULT_RADIUS + BACKGROUND_GROW)
    expect(bg.transform.scale).toBeCloseTo(2 * side)
    expect(bg.mask).toEqual({ shape: "disc", grow: BACKGROUND_GROW, popOut: false, strokes: [] })
    // Subject fits inside the canvas: 400×800 → height 1, width 0.5.
    expect(hero.transform.scale).toBeCloseTo(0.5)
    expect(hero.mask.shape).toBe("disc")
    // Frame fills the canvas unmasked.
    expect(ring.transform.scale).toBe(1)
    expect(ring.mask.shape).toBe("none")
    expect(fitTransform(200, 100, "subject").scale).toBe(1)
  })

  it("adds, moves and removes layers without mutating the input", () => {
    const d = sample()
    const snapshot = JSON.stringify(d)
    const moved = moveLayer(d, "ring", 0)
    expect(moved.layers.map((l) => l.id)).toEqual(["ring", "bg", "hero"])
    expect(moveLayer(d, "bg", 99).layers.map((l) => l.id)).toEqual(["hero", "ring", "bg"])
    expect(moveLayer(d, "nope", 0)).toBe(d)
    expect(moveLayer(d, "hero", 1)).toBe(d)
    expect(removeLayer(d, "hero").layers.map((l) => l.id)).toEqual(["bg", "ring"])
    expect(removeLayer(d, "nope")).toBe(d)
    expect(addLayer(d, createLayer("x", "X", { type: "fill", color: "#112233" }, "background"), 0).layers[0].id).toBe("x")
    expect(JSON.stringify(d)).toBe(snapshot)
  })

  it("refuses duplicate ids and layers past the limit", () => {
    const d = sample()
    expect(addLayer(d, createLayer("bg", "Again", img(10, 10), "subject"))).toBe(d)
    let full = emptyDesign()
    for (let k = 0; k < TOKEN_LIMITS.maxLayers + 3; k++) full = addLayer(full, createLayer(`l${k}`, "L", img(10, 10), "subject"))
    expect(full.layers).toHaveLength(TOKEN_LIMITS.maxLayers)
  })

  it("keeps a layer's box when its image is replaced", () => {
    const d = setTransform(sample(), "hero", { x: 0.4, y: 0.6, scale: 0.7, rotation: 10, flipX: true })
    const next = replaceImage(d, "hero", img(400, 800, "hero-cut"))
    const hero = next.layers[1]
    expect(hero.source).toEqual(img(400, 800, "hero-cut"))
    expect(hero.transform).toEqual(d.layers[1].transform)
    expect(hero.mask).toBe(d.layers[1].mask)
  })

  it("clamps transforms and mask growth", () => {
    const t = clampTransform({ x: 99, y: -99, scale: 1e9, rotation: 190, flipX: false })
    expect(t).toEqual({ x: 1 + TOKEN_LIMITS.maxOffset, y: -TOKEN_LIMITS.maxOffset, scale: TOKEN_LIMITS.maxScale, rotation: -170, flipX: false })
    expect(clampTransform({ x: 0, y: 0, scale: 0, rotation: -180, flipX: true }).rotation).toBe(-180)
    expect(setMask(sample(), "hero", { grow: 5 }).layers[1].mask.grow).toBe(TOKEN_LIMITS.maxGrow)
  })
})

describe("geometry", () => {
  const layer = (over: Partial<TokenLayer["transform"]> = {}): TokenLayer => ({
    ...createLayer("a", "A", img(200, 100), "subject"),
    transform: { x: 0.5, y: 0.5, scale: 0.4, rotation: 0, flipX: false, ...over },
  })

  it("maps canvas points into the layer's unit square", () => {
    const l = layer()
    // 0.4 wide, 0.2 tall, centred.
    const tl = toLayerUv(l, { x: 0.3, y: 0.4 })
    close(tl.u, 0)
    close(tl.v, 0)
    const uv = toLayerUv(l, { x: 0.7, y: 0.6 })
    close(uv.u, 1)
    close(uv.v, 1)
    expect(pointInLayer(l, { x: 0.5, y: 0.35 })).toBe(false)
    expect(pointInLayer(l, { x: 0.65, y: 0.55 })).toBe(true)
  })

  it("undoes rotation (clockwise, y down) and flips", () => {
    const r = layer({ rotation: 90 })
    // Rotated a quarter turn clockwise, the image's top edge faces +x: its top-left corner is at the right-top.
    const [tl, tr, br, bl] = layerCorners(r)
    close(tl.x, 0.6)
    close(tl.y, 0.3)
    close(tr.y, 0.7)
    close(br.x, 0.4)
    close(bl.x, 0.4)
    const uv = toLayerUv(r, tl)
    close(uv.u, 0)
    close(uv.v, 0)
    const f = layer({ flipX: true })
    const fuv = toLayerUv(f, { x: 0.3, y: 0.4 })
    close(fuv.u, 1)
    close(fuv.v, 0)
    // Every corner maps back to its own uv corner.
    for (const l of [layer({ rotation: 33 }), layer({ rotation: -120, flipX: true, x: 0.2 })]) {
      const cs = layerCorners(l)
      const want = l.transform.flipX
        ? [
            [1, 0],
            [0, 0],
            [0, 1],
            [1, 1],
          ]
        : [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ]
      cs.forEach((c, k) => {
        const p = toLayerUv(l, c)
        close(p.u, want[k][0])
        close(p.v, want[k][1])
      })
    }
  })

  it("zooms about a point that stays under the pointer", () => {
    const l = layer({ x: 0.3, y: 0.7 })
    const p = { x: 0.35, y: 0.72 }
    const before = toLayerUv(l, p)
    const z = zoomLayerAt(l.transform, p, 1.7)
    expect(z.scale).toBeCloseTo(0.68)
    const after = toLayerUv({ ...l, transform: z }, p)
    close(after.u, before.u)
    close(after.v, before.v)
    // Clamped scale: the anchor still holds.
    const huge = zoomLayerAt(l.transform, p, 1e6)
    expect(huge.scale).toBe(TOKEN_LIMITS.maxScale)
    const moved = translateLayer(l.transform, 0.1, -0.2)
    close(moved.x, 0.4)
    close(moved.y, 0.5)
  })

  it("picks the topmost visible image layer, optionally by opacity", () => {
    const d = sample()
    const centre = { x: 0.5, y: 0.5 }
    expect(pickLayer(d, centre)?.id).toBe("ring")
    // The ring is transparent in the middle: the hero below is picked.
    const opaque = (l: TokenLayer, u: number, v: number) => l.id !== "ring" || Math.hypot(u - 0.5, v - 0.5) > 0.4
    expect(pickLayer(d, centre, opaque)?.id).toBe("hero")
    const hidden = { ...d, layers: d.layers.map((l) => (l.id === "ring" ? { ...l, visible: false } : l)) }
    expect(pickLayer(hidden, centre)?.id).toBe("hero")
    expect(pickLayer(d, { x: 5, y: 5 })).toBeNull()
  })
})

describe("masks", () => {
  it("builds the disc and pop-out region of a layer", () => {
    const d = sample()
    const [bg, hero] = d.layers
    expect(layerDisc(d, bg)).toEqual({ cx: 0.5, cy: 0.5, r: DEFAULT_RADIUS + BACKGROUND_GROW })
    expect(popOutRect(d, hero)).toBeNull()
    expect(breaksOut(hero)).toBe(false)
    const popped = setMask(d, "hero", { popOut: true })
    const p = popOutRect(popped, popped.layers[1])!
    close(p.x, 0.5 - DEFAULT_RADIUS)
    close(p.w, 2 * DEFAULT_RADIUS)
    expect(p.y).toBe(0)
    expect(p.h).toBe(0.5)
    expect(breaksOut(popped.layers[1])).toBe(true)
    // Unmasked layers never pop out (they are not clipped in the first place).
    const ring = setMask(d, "ring", { popOut: true })
    expect(popOutRect(ring, ring.layers[2])).toBeNull()
    expect(breaksOut(ring.layers[2])).toBe(false)
  })

  it("records strokes within budget, and a reveal stroke breaks out", () => {
    const d = sample()
    const s = addStroke(d, "hero", { mode: "reveal", size: 0.05, points: [0.1, 0.1, 0.2, 0.2] })
    expect(s.layers[1].mask.strokes).toHaveLength(1)
    expect(breaksOut(s.layers[1])).toBe(true)
    expect(addStroke(d, "hero", { mode: "hide", size: 0.05, points: [0.1] })).toBe(d)
    expect(addStroke(d, "hero", { mode: "hide", size: 99, points: [0.1, 0.1] }).layers[1].mask.strokes[0].size).toBe(TOKEN_LIMITS.maxBrush)
    const big = Array.from({ length: TOKEN_LIMITS.maxStrokeCoordsPerLayer }, () => 0.5)
    const full = addStroke(d, "hero", { mode: "hide", size: 0.05, points: big })
    expect(full.layers[1].mask.strokes).toHaveLength(1)
    expect(addStroke(full, "hero", { mode: "hide", size: 0.05, points: [0.1, 0.1] })).toBe(full)
    expect(clearStrokes(full, "hero").layers[1].mask.strokes).toEqual([])
    expect(clearStrokes(d, "hero")).toBe(d)
  })

  it("thins dense pointer samples", () => {
    let pts: number[] = []
    pts = extendStroke(pts, { x: 0.1, y: 0.1 }, 0.04)
    pts = extendStroke(pts, { x: 0.105, y: 0.1 }, 0.04)
    expect(pts).toEqual([0.1, 0.1])
    pts = extendStroke(pts, { x: 0.123456789, y: 0.1 }, 0.04)
    expect(pts).toEqual([0.1, 0.1, 0.1235, 0.1])
  })

  it("fits the disc to a centred frame's opening", () => {
    const ring = setTransform(sample(), "ring", { x: 0.5, y: 0.5, scale: 0.9, rotation: 0, flipX: false }).layers[2]
    expect(radiusForFrame(ring, 0.4)).toBeCloseTo(0.36)
    expect(radiusForFrame({ ...ring, transform: { ...ring.transform, x: 0.3 } }, 0.4)).toBeNull()
    expect(radiusForFrame(ring, 0.01)).toBe(TOKEN_LIMITS.minRadius)
  })
})
