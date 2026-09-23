import * as THREE from "three"
import { describe, expect, it } from "vitest"

import { createLevel, createLight, createScene, createToken } from "@/core/scene/factory"
import type { Scene } from "@/core/scene/types"

import { cullAndRankLights, cutawayPlaneY, linearColor, resolveLights, screenCoverage } from "./lights"
import { LIGHT_FLAG_HI_ATLAS, LIGHT_FLAG_SOFT, LIGHT_FLAG_WIDE_PCF, LIGHT_VEC4S, packLight, packViewer, VIEWER_VEC4S } from "./uniforms"

function twoLevelScene(): { scene: Scene; ground: string; upper: string } {
  const scene = createScene({ width: 40, depth: 40 })
  const ground = Object.keys(scene.levels)[0]
  const upperLevel = createLevel({ name: "Upper", elevation: 10, floorThickness: 1 })
  scene.levels[upperLevel.id] = upperLevel
  return { scene, ground, upper: upperLevel.id }
}

function topDownCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.5, 500)
  cam.position.set(100, 200, 100)
  cam.up.set(0, 0, -1)
  cam.lookAt(100, 0, 100)
  cam.updateMatrixWorld(true)
  return cam
}

function frustumOf(cam: THREE.Camera): THREE.Frustum {
  cam.updateMatrixWorld(true)
  const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
  return new THREE.Frustum().setFromProjectionMatrix(m)
}

describe("resolveLights", () => {
  it("skips off lights and hidden lights unless includeHidden", () => {
    const { scene, ground } = twoLevelScene()
    const on = createLight(ground, "torch", { x: 10, z: 10 })
    const off = createLight(ground, "torch", { x: 20, z: 10 }, { on: false })
    const hidden = createLight(ground, "torch", { x: 30, z: 10 }, { hidden: true })
    const token = createToken(ground, { x: 50, z: 50 }, { hidden: true })
    const carried = createLight(ground, "lantern", { x: 0, z: 0 }, { attachedTokenId: token.id })
    scene.tokens[token.id] = token
    for (const l of [on, off, hidden, carried]) scene.objects[l.id] = l

    const player = resolveLights(scene, { includeHidden: false }).map((l) => l.id)
    expect(player).toEqual([on.id])
    const dm = resolveLights(scene, { includeHidden: true }).map((l) => l.id).sort()
    expect(dm).toEqual([on.id, hidden.id, carried.id].sort())
  })

  it("resolves world position, level and linear colour; attached lights follow their token", () => {
    const { scene, ground, upper } = twoLevelScene()
    const token = createToken(upper, { x: 42.5, z: 17.5 })
    scene.tokens[token.id] = token
    const carried = createLight(ground, "torch", { x: 0, z: 0 }, { attachedTokenId: token.id, position: { x: 0, y: 4, z: 0 } })
    scene.objects[carried.id] = carried
    const [l] = resolveLights(scene, { includeHidden: false })
    expect(l.levelId).toBe(upper)
    expect(l.position).toEqual({ x: 42.5, y: 14, z: 17.5 })
    const [r, g, b] = linearColor("#ff9a3c")
    expect(l.color).toEqual([r, g, b])
    expect(r).toBeCloseTo(1, 6)
    // sRGB 0x9a = 154 → linear ≈ 0.3231
    expect(g).toBeCloseTo(0.3231, 3)
    expect(l.bright).toBe(20)
    expect(l.dim).toBe(40)
  })
})

describe("cullAndRankLights", () => {
  it("culls lights whose dim sphere is outside the frustum or above the cutaway", () => {
    const { scene, ground, upper } = twoLevelScene()
    const inView = createLight(ground, "torch", { x: 100, z: 100 })
    const edge = createLight(ground, "torch", { x: 170, z: 100 }) // centre off screen, sphere overlaps
    const far = createLight(ground, "torch", { x: 400, z: 100 })
    const upstairs = createLight(upper, "candle", { x: 100, z: 100 }) // y = 13, dim 10 → min y 3 < 9 (kept)
    const high = createLight(upper, "candle", { x: 110, z: 100 }, { position: { x: 110, y: 15, z: 100 } }) // min y 15 > 9
    for (const l of [inView, edge, far, upstairs, high]) scene.objects[l.id] = l
    const cam = topDownCamera()
    const cutawayY = cutawayPlaneY(scene, ground)
    expect(cutawayY).toBe(9)
    const ranked = cullAndRankLights(resolveLights(scene, { includeHidden: false }), {
      frustum: frustumOf(cam),
      camera: cam,
      cutawayY,
      maxLights: 32,
    })
    const ids = ranked.map((l) => l.id)
    expect(ids).toContain(inView.id)
    expect(ids).toContain(edge.id)
    expect(ids).toContain(upstairs.id)
    expect(ids).not.toContain(far.id)
    expect(ids).not.toContain(high.id)
    // Fully on-screen torch outranks the one mostly off screen.
    expect(ids.indexOf(inView.id)).toBeLessThan(ids.indexOf(edge.id))
    expect(cutawayPlaneY(scene, upper)).toBeNull()
  })

  it("keeps at most maxLights, highest score first", () => {
    const { scene, ground } = twoLevelScene()
    for (let k = 0; k < 40; k++) {
      const l = createLight(ground, "torch", { x: 60 + (k % 8) * 10, z: 60 + Math.floor(k / 8) * 10 }, { intensity: 0.5 + k / 40 })
      scene.objects[l.id] = l
    }
    const cam = topDownCamera()
    const ranked = cullAndRankLights(resolveLights(scene, { includeHidden: false }), {
      frustum: frustumOf(cam),
      camera: cam,
      cutawayY: null,
      maxLights: 32,
    })
    expect(ranked).toHaveLength(32)
    for (let k = 1; k < ranked.length; k++) expect(ranked[k].score).toBeLessThanOrEqual(ranked[k - 1].score)
  })
})

describe("screenCoverage", () => {
  it("is 1 inside the sphere, ~π/16·(2r)² on screen, 0 off screen (perspective and ortho)", () => {
    const persp = new THREE.PerspectiveCamera(60, 1, 0.5, 1000)
    persp.position.set(0, 0, 0)
    persp.lookAt(0, 0, -1)
    persp.updateMatrixWorld(true)
    expect(screenCoverage({ x: 0, y: 0, z: -1 }, 5, persp)).toBe(1)
    const c = screenCoverage({ x: 0, y: 0, z: -100 }, 5, persp)
    expect(c).toBeGreaterThan(0)
    expect(c).toBeLessThan(0.05)
    const ortho = topDownCamera()
    // Ortho half-height 50 → r = 10 → rNdc 0.2 → (0.4)²·π/16.
    expect(screenCoverage({ x: 100, y: 0, z: 100 }, 10, ortho)).toBeCloseTo((0.16 * Math.PI) / 16, 6)
    expect(screenCoverage({ x: 400, y: 0, z: 100 }, 10, ortho)).toBe(0)
  })
})

describe("uniform packing", () => {
  it("packs lights and viewers in the documented layout", () => {
    const lights = new Float32Array(32 * LIGHT_VEC4S * 4)
    packLight(lights, 2, {
      position: { x: 1, y: 2, z: 3 },
      dim: 40,
      bright: 20,
      radiance: [0.5, 0.25, 0.125],
      tile: { x: 512, y: 1024, size: 512 },
      capture: { x: 1.5, y: 2, z: 3 },
      widePcf: true,
    })
    expect(Array.from(lights.subarray(32, 48))).toEqual([1, 2, 3, 40, 0.5, 0.25, 0.125, 20, 512, 1024, 512, 1, 1.5, 2, 3, 0])
    packLight(lights, 0, { position: { x: 4, y: 5, z: 6 }, dim: 10, bright: 5, radiance: [1, 1, 1], tile: null, capture: null, widePcf: false })
    // Unshadowed: tile size 0; capture falls back to the position.
    expect(lights[10]).toBe(0)
    expect(Array.from(lights.subarray(12, 15))).toEqual([4, 5, 6])

    // Ultra: hi-res atlas and soft shadows are flag bits; the source radius rides in the capture slot's w.
    packLight(lights, 1, {
      position: { x: 0, y: 0, z: 0 },
      dim: 10,
      bright: 5,
      radiance: [1, 1, 1],
      tile: { x: 0, y: 0, size: 1024 },
      capture: null,
      widePcf: true,
      hiAtlas: true,
      softRadius: 0.5,
    })
    expect(lights[16 + 11]).toBe(LIGHT_FLAG_WIDE_PCF + LIGHT_FLAG_HI_ATLAS + LIGHT_FLAG_SOFT)
    expect(lights[16 + 15]).toBe(0.5)

    const viewers = new Float32Array(8 * VIEWER_VEC4S * 4)
    packViewer(viewers, 1, { eye: { x: 7, y: 8, z: 9 }, darkvision: 60, blindsight: 10, tile: { x: 1024, y: 0, size: 1024 }, capture: null, far: 500 })
    expect(Array.from(viewers.subarray(12, 24))).toEqual([7, 8, 9, 60, 1024, 0, 1024, 10, 7, 8, 9, 500])
  })
})
