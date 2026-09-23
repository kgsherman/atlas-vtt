import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { fitDirectionalFrame } from "./directionalShadow"

describe("fitDirectionalFrame", () => {
  const bounds = new THREE.Box3(new THREE.Vector3(0, -2, 0), new THREE.Vector3(200, 30, 150))

  for (const [name, dir] of [
    ["oblique sun", new THREE.Vector3(0.4, 0.8, -0.3)],
    ["straight down (sky)", new THREE.Vector3(0, 1, 0)],
    ["low sun", new THREE.Vector3(-0.99, 0.1, 0.05)],
  ] as const) {
    it(`maps every bound corner into [0,1]³ (${name})`, () => {
      const f = fitDirectionalFrame(bounds, dir)
      const p = new THREE.Vector3()
      for (let k = 0; k < 8; k++) {
        p.set(k & 1 ? 200 : 0, k & 2 ? 30 : -2, k & 4 ? 150 : 0).applyMatrix4(f.matrix)
        for (const c of p.toArray()) {
          expect(c).toBeGreaterThan(0)
          expect(c).toBeLessThan(1)
        }
      }
    })

    it(`depth increases away from the light (${name})`, () => {
      const f = fitDirectionalFrame(bounds, dir)
      const d = dir.clone().normalize()
      const a = new THREE.Vector3(100, 10, 75)
      const toward = a.clone().addScaledVector(d, 5)
      const za = a.clone().applyMatrix4(f.matrix)
      const zt = toward.clone().applyMatrix4(f.matrix)
      expect(zt.z).toBeLessThan(za.z)
      // Moving along the light direction does not change the texel.
      expect(zt.x).toBeCloseTo(za.x, 9)
      expect(zt.y).toBeCloseTo(za.y, 9)
    })
  }

  it("matches the camera it describes", () => {
    const f = fitDirectionalFrame(bounds, new THREE.Vector3(0.3, 0.9, 0.2))
    const cam = new THREE.OrthographicCamera(f.left, f.right, f.top, f.bottom, f.near, f.far)
    cam.position.copy(f.position)
    cam.up.copy(f.up)
    cam.lookAt(f.target)
    cam.updateMatrixWorld(true)
    const p = new THREE.Vector3(37, 4, 91)
    const ndc = p.clone().project(cam)
    const tex = p.clone().applyMatrix4(f.matrix)
    expect(tex.x).toBeCloseTo(ndc.x * 0.5 + 0.5, 9)
    expect(tex.y).toBeCloseTo(ndc.y * 0.5 + 0.5, 9)
    expect(tex.z).toBeCloseTo(ndc.z * 0.5 + 0.5, 9)
  })
})
