// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

import { OrbitCameraController } from "./orbit"

describe("OrbitCameraController", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("removes its document key listeners even when the canvas was detached first", () => {
    const canvas = document.createElement("canvas")
    document.body.appendChild(canvas)
    const added: { type: string; fn: EventListenerOrEventListenerObject | null; capture: boolean }[] = []
    const removed: { type: string; fn: EventListenerOrEventListenerObject | null; capture: boolean }[] = []
    const capture = (o?: boolean | AddEventListenerOptions | EventListenerOptions) => (typeof o === "boolean" ? o : !!o?.capture)
    const add = document.addEventListener.bind(document)
    const remove = document.removeEventListener.bind(document)
    vi.spyOn(document, "addEventListener").mockImplementation((type, fn, o) => {
      added.push({ type, fn, capture: capture(o) })
      add(type, fn, o)
    })
    vi.spyOn(document, "removeEventListener").mockImplementation((type, fn, o) => {
      removed.push({ type, fn, capture: capture(o) })
      remove(type, fn, o)
    })
    const orbit = new OrbitCameraController(canvas)
    // A Control press also registers the keyup interceptor on the document.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Control" }))
    const captured = added.filter((a) => a.capture)
    expect(captured.map((a) => a.type).sort()).toEqual(["keydown", "keyup"])
    // React removes the DOM before effect cleanups run.
    canvas.remove()
    orbit.dispose()
    for (const a of captured) expect(removed.some((r) => r.type === a.type && r.fn === a.fn && r.capture)).toBe(true)
  })

  it("pans along the ground with held WASD, relative to the view", () => {
    const canvas = document.createElement("canvas")
    document.body.appendChild(canvas)
    const orbit = new OrbitCameraController(canvas)
    orbit.active = true
    orbit.setAngles(0, Math.PI / 4) // looking toward −Z
    const key = (type: string, code: string, init: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent(type, { code, ...init }))
    const t0 = orbit.getTarget()
    const y0 = orbit.camera.position.y

    /** Frames until the glide has stopped (it stops below a pixel per second). */
    const settle = () => {
      for (let i = 0; i < 100; i++) orbit.update(1 / 60)
    }

    key("keydown", "KeyW")
    orbit.update(0.1)
    key("keyup", "KeyW")
    settle()
    const t1 = orbit.getTarget()
    expect(t1.z).toBeLessThan(t0.z - 1)
    expect(t1.x).toBeCloseTo(t0.x)
    expect(t1.y).toBeCloseTo(t0.y)
    expect(orbit.camera.position.y).toBeCloseTo(y0)

    orbit.setAngles(Math.PI / 2, Math.PI / 4) // from +X, looking toward −X: D moves toward −Z
    key("keydown", "KeyD", { shiftKey: true })
    orbit.update(0.1)
    key("keyup", "KeyD")
    settle()
    const t2 = orbit.getTarget()
    expect(t2.z).toBeLessThan(t1.z - 1)
    expect(t2.x).toBeCloseTo(t1.x)

    // Arrows nudge the selection; modified keys are shortcuts; nothing pans while input is off.
    key("keydown", "ArrowUp")
    key("keydown", "KeyS", { ctrlKey: true })
    orbit.update(0.1)
    expect(orbit.getTarget()).toEqual(t2)
    orbit.enabled = false
    key("keydown", "KeyA")
    orbit.update(0.1)
    expect(orbit.getTarget()).toEqual(t2)

    canvas.remove()
    orbit.dispose()
  })

  it("eases key panning in and glides to a stop after release", () => {
    const canvas = document.createElement("canvas")
    document.body.appendChild(canvas)
    const orbit = new OrbitCameraController(canvas)
    orbit.active = true
    orbit.setViewport(1200, 800)
    orbit.setAngles(0, Math.PI / 4)
    const z = () => orbit.getTarget().z
    const step = () => {
      const before = z()
      orbit.update(1 / 60)
      return before - z()
    }

    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }))
    const first = step()
    for (let i = 0; i < 60; i++) step()
    const cruise = step()
    expect(first).toBeGreaterThan(0)
    expect(first).toBeLessThan(cruise / 2) // eases in
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW" }))
    const glide = step()
    expect(glide).toBeGreaterThan(0) // keeps moving after release…
    expect(glide).toBeLessThan(cruise)
    for (let i = 0; i < 120; i++) step()
    expect(step()).toBe(0) // …and comes to rest

    // A programmatic move takes over from a glide.
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }))
    for (let i = 0; i < 30; i++) step()
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW" }))
    const goal = { x: 10, y: 0, z: 10 }
    orbit.setTarget(goal, false)
    for (let i = 0; i < 300; i++) orbit.update(1 / 60)
    expect(orbit.getTarget()).toEqual(goal)

    canvas.remove()
    orbit.dispose()
  })
})
