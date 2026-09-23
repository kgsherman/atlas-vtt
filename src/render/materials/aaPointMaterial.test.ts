import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { GIZMO_SHAFT_END_PX, GIZMO_SHAFT_START_PX } from "@/core/geometry/gizmo"

import { AA_POINT_FRAGMENT, AA_POINT_VERTEX, aaPointGeometry, createAAPointMaterial } from "./aaPointMaterial"
import { createGizmoArrowMaterial, GIZMO_ARROW_FRAGMENT, GIZMO_ARROW_VERTEX, GIZMO_HEAD_PX, gizmoArrowGeometry } from "./gizmoMaterial"

const renderer = {
  getCurrentViewport: (v: THREE.Vector4) => v.set(0, 0, 1600, 900),
  getPixelRatio: () => 2,
} as unknown as THREE.WebGLRenderer

const beforeRender = (m: THREE.Material) =>
  m.onBeforeRender(renderer, new THREE.Scene(), new THREE.Camera(), new THREE.BufferGeometry(), new THREE.Object3D(), null as unknown as THREE.Group)

/** Static shader checks (no WebGL in vitest): uniforms provided, varyings matched, attributes on the geometry. */
function checkProgram(m: THREE.ShaderMaterial, vertex: string, fragment: string, geometry: THREE.BufferGeometry): void {
  for (const src of [vertex, fragment]) {
    for (const u of src.matchAll(/^\s*uniform\s+\w+\s+(\w+)\s*;/gm)) expect(Object.keys(m.uniforms)).toContain(u[1])
    let depth = 0
    for (const ch of src) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0
    expect(depth).toBe(0)
  }
  const varyings = (src: string) => [...src.matchAll(/^\s*varying\s+(\w+)\s+(\w+)\s*;/gm)].map((v) => `${v[1]} ${v[2]}`).sort()
  expect(varyings(vertex)).toEqual(varyings(fragment))
  for (const a of vertex.matchAll(/^\s*attribute\s+\w+\s+(\w+)\s*;/gm)) expect(geometry.getAttribute(a[1])).toBeTruthy()
  expect(geometry.getAttribute("position")).toBeTruthy()
}

describe("anti-aliased overlay points", () => {
  it("expands each point into a quad with corner attributes, positioned at the point", () => {
    const g = aaPointGeometry([1, 2, 3, 4, 5, 6])
    expect(g.getAttribute("position").count).toBe(8)
    expect(g.getIndex()!.count).toBe(12)
    const pos = g.getAttribute("position")
    const c = g.getAttribute("aCorner")
    for (let v = 0; v < 4; v++) {
      expect([pos.getX(v), pos.getY(v), pos.getZ(v)]).toEqual([1, 2, 3])
      expect([pos.getX(4 + v), pos.getY(4 + v), pos.getZ(4 + v)]).toEqual([4, 5, 6])
    }
    const corners = Array.from({ length: 4 }, (_, v) => [c.getX(v), c.getY(v)])
    expect(corners.sort()).toEqual([
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ])
    expect(aaPointGeometry([]).getAttribute("position").count).toBe(0)
  })

  it("sizes dots and outlines in CSS pixels scaled by the pixel ratio, against the pass' viewport", () => {
    const m = createAAPointMaterial("#ff0000", { size: 8, outline: 1.5, opacity: 0.5 })
    expect(m.transparent).toBe(true)
    expect(m.depthWrite).toBe(false)
    expect(m.depthTest).toBe(false)
    beforeRender(m)
    expect(m.uniforms.uSize.value).toBe(16)
    expect(m.uniforms.uOutline.value).toBe(3)
    expect(m.uniforms.uViewport.value.toArray()).toEqual([0, 0, 1600, 900])
    expect(m.uniforms.uOpacity.value).toBe(0.5)
    // Repeated frames do not compound the scaling.
    beforeRender(m)
    expect(m.uniforms.uSize.value).toBe(16)
    checkProgram(m, AA_POINT_VERTEX, AA_POINT_FRAGMENT, aaPointGeometry([0, 0, 0]))
    // Half a pixel of feather around the nominal radius, fwidth-based fade.
    expect(AA_POINT_VERTEX).toMatch(/float r = 0\.5 \* uSize \+ 0\.5;/)
    expect(AA_POINT_FRAGMENT).toMatch(/fwidth\(d\)/)
  })
})

describe("gizmo arrows", () => {
  it("covers the arrow from the shaft start to the tip with a margin, in the axis frame", () => {
    const g = gizmoArrowGeometry()
    const off = g.getAttribute("aOffset")
    const xs = Array.from({ length: 4 }, (_, v) => off.getX(v))
    const ys = Array.from({ length: 4 }, (_, v) => off.getY(v))
    expect(Math.min(...xs)).toBeLessThan(GIZMO_SHAFT_START_PX)
    expect(Math.max(...xs)).toBeGreaterThan(GIZMO_SHAFT_END_PX)
    expect(Math.max(...ys)).toBeGreaterThan(GIZMO_HEAD_PX.halfWidth)
    expect(Math.min(...ys)).toBe(-Math.max(...ys))
  })

  it("reads the viewport and pixel ratio of the pass, draws on top", () => {
    const m = createGizmoArrowMaterial("#60a5fa")
    expect(m.depthTest).toBe(false)
    expect(m.transparent).toBe(true)
    beforeRender(m)
    expect(m.uniforms.uViewport.value.toArray()).toEqual([0, 0, 1600, 900])
    expect(m.uniforms.uPixelRatio.value).toBe(2)
    expect((m.uniforms.uArrow.value as THREE.Vector4).toArray()).toEqual([
      GIZMO_SHAFT_START_PX,
      GIZMO_SHAFT_END_PX,
      GIZMO_HEAD_PX.length,
      GIZMO_HEAD_PX.halfWidth,
    ])
    checkProgram(m, GIZMO_ARROW_VERTEX, GIZMO_ARROW_FRAGMENT, gizmoArrowGeometry())
    // Screen y grows downward (gizmoHandles' dir), NDC y upward.
    expect(GIZMO_ARROW_VERTEX).toMatch(/vec2 d = vec2\(uDir\.x, -uDir\.y\);/)
  })
})
