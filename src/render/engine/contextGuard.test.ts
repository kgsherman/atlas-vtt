import { describe, expect, it } from "vitest"

import { contextGeneration, guardStaleDeletes } from "./contextGuard"

class FakeGl {
  deleted: object[] = []
  createTexture(): object {
    return { kind: "texture" }
  }
  deleteTexture(o: object | null): void {
    if (o) this.deleted.push(o)
  }
  createBuffer(): object {
    return { kind: "buffer" }
  }
  deleteBuffer(o: object | null): void {
    if (o) this.deleted.push(o)
  }
}

const restored = (canvas: EventTarget) => canvas.dispatchEvent(new Event("webglcontextrestored"))

describe("guardStaleDeletes", () => {
  it("drops deletes of objects created before a context restore, and only those", () => {
    const gl = new FakeGl()
    const canvas = new EventTarget()
    const early = gl.createTexture() // before the guard: generation 0
    const release = guardStaleDeletes(gl, canvas)
    const a = gl.createTexture()
    const buf = gl.createBuffer()
    gl.deleteTexture(a)
    expect(gl.deleted).toEqual([a])
    const lost = gl.createTexture()
    restored(canvas)
    expect(contextGeneration(gl)).toBe(1)
    const b = gl.createTexture()
    gl.deleteTexture(lost)
    gl.deleteBuffer(buf)
    gl.deleteTexture(early)
    gl.deleteTexture(null)
    expect(gl.deleted).toEqual([a])
    gl.deleteTexture(b)
    expect(gl.deleted).toEqual([a, b])
    // A second restore makes b stale too.
    const c = gl.createTexture()
    restored(canvas)
    gl.deleteTexture(c)
    expect(gl.deleted).toEqual([a, b])
    release()
  })

  it("is reference counted and removes its patch and listener with the last holder", () => {
    const gl = new FakeGl()
    const other = new FakeGl()
    const canvas = new EventTarget()
    const r1 = guardStaleDeletes(gl, canvas)
    const r2 = guardStaleDeletes(gl, canvas)
    expect(Object.hasOwn(gl, "deleteTexture")).toBe(true)
    // Only this context instance is patched.
    expect(Object.hasOwn(other, "deleteTexture")).toBe(false)
    r1()
    r1()
    expect(Object.hasOwn(gl, "deleteTexture")).toBe(true)
    const t = gl.createTexture()
    restored(canvas)
    gl.deleteTexture(t)
    expect(gl.deleted).toEqual([])
    r2()
    expect(Object.hasOwn(gl, "deleteTexture")).toBe(false)
    expect(Object.hasOwn(gl, "createTexture")).toBe(false)
    expect(contextGeneration(gl)).toBe(0)
    // Unpatched: every delete goes through again, and restores no longer count.
    restored(canvas)
    gl.deleteTexture(t)
    expect(gl.deleted).toEqual([t])
  })

  it("skips contexts without the create / delete pairs (test doubles)", () => {
    const gl = { getExtension: () => null }
    const release = guardStaleDeletes(gl, new EventTarget())
    expect(Object.keys(gl)).toEqual(["getExtension"])
    release()
  })
})
