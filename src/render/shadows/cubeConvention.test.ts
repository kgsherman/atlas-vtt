/**
 * The re-encode pass samples the WebGLCubeRenderTarget written by THREE.CubeCamera with the plain
 * world direction (`texture(uCube, dir)`), with no face flips. This verifies that assumption against the
 * GL cube-map face selection rules (OpenGL ES 3.0 §3.8.10, table 3.21) and the cameras CubeCamera
 * builds for the WebGL coordinate system: the texel a lookup of `dir` reads is exactly where that
 * face's camera rasterised the world point `origin + dir`.
 */
import * as THREE from "three"
import { describe, expect, it } from "vitest"

/** GL face selection: face index (+X, −X, +Y, −Y, +Z, −Z) and (s, t) ∈ [0, 1]² for a direction. */
function glCubeLookup(x: number, y: number, z: number): { face: number; s: number; t: number } {
  const ax = Math.abs(x)
  const ay = Math.abs(y)
  const az = Math.abs(z)
  let face: number
  let sc: number
  let tc: number
  let ma: number
  if (ax >= ay && ax >= az) {
    ma = ax
    if (x > 0) [face, sc, tc] = [0, -z, -y]
    else [face, sc, tc] = [1, z, -y]
  } else if (ay >= az) {
    ma = ay
    if (y > 0) [face, sc, tc] = [2, x, z]
    else [face, sc, tc] = [3, x, -z]
  } else {
    ma = az
    if (z > 0) [face, sc, tc] = [4, x, -y]
    else [face, sc, tc] = [5, -x, -y]
  }
  return { face, s: 0.5 * (sc / ma + 1), t: 0.5 * (tc / ma + 1) }
}

describe("CubeCamera face convention", () => {
  it("renders each direction where a direct world-direction lookup reads it", () => {
    const target = new THREE.WebGLCubeRenderTarget(8)
    const cube = new THREE.CubeCamera(0.05, 100, target)
    cube.coordinateSystem = THREE.WebGLCoordinateSystem
    cube.updateCoordinateSystem()
    cube.position.set(3, 4, -2)
    cube.updateMatrixWorld(true)
    const cameras = cube.children as THREE.PerspectiveCamera[]

    let seed = 11
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 4294967296 - 0.5
    }
    for (let k = 0; k < 500; k++) {
      const d = new THREE.Vector3(rnd(), rnd(), rnd()).normalize()
      const { face, s, t } = glCubeLookup(d.x, d.y, d.z)
      const cam = cameras[face]
      cam.updateMatrixWorld(true)
      const ndc = d.clone().multiplyScalar(10).add(cube.position).project(cam)
      expect(Math.abs(ndc.x)).toBeLessThanOrEqual(1 + 1e-9)
      expect(Math.abs(ndc.y)).toBeLessThanOrEqual(1 + 1e-9)
      expect((ndc.x + 1) / 2).toBeCloseTo(s, 9)
      expect((ndc.y + 1) / 2).toBeCloseTo(t, 9)
    }
    target.dispose()
  })
})
