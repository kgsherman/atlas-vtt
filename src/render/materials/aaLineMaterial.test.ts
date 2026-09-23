import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { AA_LINE_VERTEX, aaLineGeometry, createAALineMaterial, polylinePairs } from "./aaLineMaterial"

describe("anti-aliased overlay lines", () => {
  it("expands each segment into a quad with start / end / side attributes", () => {
    const g = aaLineGeometry([0, 0, 0, 10, 0, 0, 5, 1, 5, 5, 2, 5])
    expect(g.getAttribute("position").count).toBe(8)
    expect(g.getIndex()!.count).toBe(12)
    const s = g.getAttribute("aStart")
    const e = g.getAttribute("aEnd")
    const c = g.getAttribute("aCorner")
    for (let v = 0; v < 4; v++) {
      expect([s.getX(v), s.getY(v), s.getZ(v)]).toEqual([0, 0, 0])
      expect([e.getX(v), e.getY(v), e.getZ(v)]).toEqual([10, 0, 0])
      expect([s.getX(4 + v), s.getY(4 + v), e.getY(4 + v)]).toEqual([5, 1, 2])
    }
    // Two corners per end, one on each side.
    const corners = Array.from({ length: 4 }, (_, v) => [c.getX(v), c.getY(v)])
    expect(corners.sort()).toEqual([
      [0, -1],
      [0, 1],
      [1, -1],
      [1, 1],
    ])
    // Positions are the segment's own end points (bounds stay right).
    g.computeBoundingBox()
    expect(g.boundingBox!.max.x).toBe(10)
    expect(g.boundingBox!.max.y).toBe(2)
  })

  it("turns polylines into segment pairs, closed on request", () => {
    const pts = [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 1, y: 0, z: 1 },
    ]
    expect(Array.from(polylinePairs(pts))).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1])
    expect(polylinePairs(pts, true).length).toBe(18)
    expect(polylinePairs([pts[0]]).length).toBe(0)
  })

  it("sizes lines in CSS pixels scaled by the pixel ratio, against the pass' viewport", () => {
    const m = createAALineMaterial("#ff0000", { width: 2, opacity: 0.5 })
    expect(m.transparent).toBe(true)
    expect(m.depthWrite).toBe(false)
    const renderer = {
      getCurrentViewport: (v: THREE.Vector4) => v.set(0, 0, 1600, 900),
      getPixelRatio: () => 2,
    } as unknown as THREE.WebGLRenderer
    m.onBeforeRender(renderer, new THREE.Scene(), new THREE.Camera(), new THREE.BufferGeometry(), new THREE.Object3D(), null as unknown as THREE.Group)
    expect(m.uniforms.uWidth.value).toBe(4)
    expect(m.uniforms.uViewport.value.toArray()).toEqual([0, 0, 1600, 900])
    expect(m.uniforms.uOpacity.value).toBe(0.5)
    // Near-plane trimming for perspective cameras, half a pixel of feather per side.
    expect(AA_LINE_VERTEX).toMatch(/projectionMatrix\[2\]\[3\] == -1\.0/)
    expect(AA_LINE_VERTEX).toMatch(/float hw = 0\.5 \* uWidth \+ 0\.5;/)
  })
})
