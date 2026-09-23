import { describe, expect, it } from "vitest"

import * as THREE from "three"

import { createLevel, createScene } from "@/core/scene/factory"

import {
  angleDelta,
  boundsCenter,
  damp,
  groundAxes,
  orthoFitViewHeight,
  perspectiveFitBoxDistance,
  perspectiveFitDistance,
  playerCameraOffset,
  sceneBounds,
  wheelPixels,
  wheelZoomFactor,
  zoomAboutPoint,
} from "./fit"

describe("camera math", () => {
  it("computes scene bounds from the grid and levels", () => {
    const scene = createScene({ width: 20, depth: 10 })
    const upper = createLevel({ elevation: 10, height: 12 })
    scene.levels[upper.id] = upper
    const b = sceneBounds(scene)
    expect(b.min).toEqual({ x: 0, y: -1, z: 0 })
    expect(b.max).toEqual({ x: 100, y: 22, z: 50 })
    expect(boundsCenter(b)).toEqual({ x: 50, y: 10.5, z: 25 })
  })

  it("puts -Z at the top of the screen at yaw 0 and rotates in quarter turns", () => {
    const a = groundAxes(0)
    expect(a.up.x).toBeCloseTo(0)
    expect(a.up.z).toBeCloseTo(-1)
    expect(a.right.x).toBeCloseTo(1)
    const q = groundAxes(Math.PI / 2)
    expect(q.up.x).toBeCloseTo(-1)
    expect(q.right.z).toBeCloseTo(-1)
    // Right and up are orthonormal for any yaw.
    const r = groundAxes(1.234)
    expect(r.right.x * r.up.x + r.right.z * r.up.z).toBeCloseTo(0)
  })

  it("places the tilted camera behind the target", () => {
    const top = playerCameraOffset(0, 0, 100)
    expect(top.x).toBeCloseTo(0)
    expect(top.y).toBeCloseTo(100)
    expect(top.z).toBeCloseTo(0)
    const tilted = playerCameraOffset(0, Math.PI / 6, 100)
    expect(tilted.z).toBeCloseTo(50)
    expect(tilted.y).toBeCloseTo(100 * Math.cos(Math.PI / 6))
  })

  it("fits a ground rect in an orthographic view", () => {
    expect(orthoFitViewHeight(100, 50, 1, 0, 0, 1)).toBeCloseTo(100)
    expect(orthoFitViewHeight(100, 50, 2, 0, 0, 1)).toBeCloseTo(50)
    expect(orthoFitViewHeight(100, 50, 4, Math.PI / 2, 0, 1)).toBeCloseTo(100)
    expect(orthoFitViewHeight(10, 100, 0.1, 0, Math.PI / 3, 1)).toBeCloseTo(100)
  })

  it("fits a sphere in a perspective view", () => {
    const d = perspectiveFitDistance(10, Math.PI / 2, 1, 1)
    expect(d).toBeCloseTo(10 / Math.sin(Math.PI / 4))
    // Narrow viewports use the horizontal fov.
    expect(perspectiveFitDistance(10, Math.PI / 2, 0.5, 1)).toBeGreaterThan(d)
  })

  it("zooms about the cursor", () => {
    const t = zoomAboutPoint({ x: 0, z: 0 }, { x: 10, z: 0 }, 100, 50)
    expect(t).toEqual({ x: 5, z: 0 })
    // The cursor point stays at the same screen offset relative to the view size.
    expect((10 - t.x) / 50).toBeCloseTo((10 - 0) / 100)
    expect(wheelZoomFactor(wheelPixels(3, 1))).toBeGreaterThan(1)
    expect(wheelZoomFactor(-100)).toBeLessThan(1)
  })

  it("smooths angles and values", () => {
    expect(angleDelta(0.1, 2 * Math.PI)).toBeCloseTo(0.1)
    expect(angleDelta(-3, 3)).toBeCloseTo(2 * Math.PI - 6)
    expect(damp(0, 10, 10, 1)).toBeCloseTo(10, 3)
    expect(damp(0, 10, 10, 0)).toBe(0)
  })

  it("fits a box's corners inside the perspective frustum, tighter than its bounding sphere", () => {
    const b = { min: { x: 0, y: -11, z: 0 }, max: { x: 200, y: 30, z: 150 } }
    const target = { x: 100, y: -9, z: 75 }
    const fov = THREE.MathUtils.degToRad(50)
    for (const aspect of [1.6, 0.7]) {
      for (const d of [new THREE.Vector3(0.45, 1.1, 0.8), new THREE.Vector3(-1, 0.4, 0.1), new THREE.Vector3(0, 1, 0.001)]) {
        const dir = d.normalize()
        const dist = perspectiveFitBoxDistance(b, target, { x: dir.x, y: dir.y, z: dir.z }, fov, aspect, 1.06)
        const cam = new THREE.PerspectiveCamera(50, aspect, 0.1, 10000)
        cam.position.set(target.x, target.y, target.z).addScaledVector(dir, dist)
        cam.lookAt(target.x, target.y, target.z)
        cam.updateMatrixWorld()
        let maxNdc = 0
        for (const x of [b.min.x, b.max.x]) {
          for (const y of [b.min.y, b.max.y]) {
            for (const z of [b.min.z, b.max.z]) {
              const p = new THREE.Vector3(x, y, z).project(cam)
              maxNdc = Math.max(maxNdc, Math.abs(p.x), Math.abs(p.y))
            }
          }
        }
        expect(maxNdc).toBeLessThanOrEqual(1 / 1.06 + 1e-6)
        // Tight: some corner touches the (margin-shrunk) frame.
        expect(maxNdc).toBeGreaterThan(0.9 / 1.06)
      }
    }
    const dir = new THREE.Vector3(0.45, 1.1, 0.8).normalize()
    const sphere = perspectiveFitDistance(Math.hypot(200, 41, 150) / 2, fov, 1.6, 1.05)
    expect(perspectiveFitBoxDistance(b, target, { x: dir.x, y: dir.y, z: dir.z }, fov, 1.6)).toBeLessThan(sphere)
  })
})
