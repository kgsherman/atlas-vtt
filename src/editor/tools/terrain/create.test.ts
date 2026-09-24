import { describe, expect, it } from "vitest"

import { createScene } from "@/core/scene/factory"
import { sampleHeight } from "@/core/scene/heightmap"
import { blockShape } from "@/core/scene/terrainShapes"
import type { Vec3 } from "@/core/scene/types"

import { key, orthoCamera, perspectiveCamera, type TestCamera } from "../../test-utils"
import { NO_FLOOR_HINT } from "./create"
import { terrainHarness, type TerrainHarness } from "./harness"

const xyz = (pts: readonly Vec3[]) => pts.map((p) => [p.x, p.y, p.z])

/** Draw a base from world (x0, z0) to (x1, z1) and release; returns the release event. */
function drawBase(t: TerrainHarness, x0: number, z0: number, x1: number, z1: number, y = 0) {
  t.tool.onPointerDown!(t.at(x0, y, z0))
  t.tool.onPointerMove!(t.at((x0 + x1) / 2, y, (z0 + z1) / 2))
  const release = t.at(x1, y, z1)
  t.tool.onPointerMove!(release)
  t.tool.onPointerUp!(release)
  return release
}

describe("terrain shape creation", () => {
  it("block: drag the base, move to set the height, click to confirm (one undo step, baked, selected)", () => {
    const t = terrainHarness({ sub: "block" })
    const { store, levelId, tool } = t
    const before = store.getState().scene
    tool.onPointerDown!(t.at(20.4, 0, 19.2))
    expect(tool.capturesPointer).toBe(true)
    tool.onPointerMove!(t.at(26, 0, 24))
    const release = t.at(30.8, 0, 29.6)
    tool.onPointerMove!(release)
    // Base phase: a zero-height prism, corners on grid vertices; no terrain preview yet.
    let o = t.overlay()
    expect(xyz(o.draft!.shape.points)).toEqual([
      [20, 0, 20],
      [30, 0, 20],
      [30, 0, 30],
      [20, 0, 30],
    ])
    expect(o.draft!.valid).toBe(true)
    expect(o.label?.text).toBe("10 × 10 ft")
    expect(tool.hint()).toMatch(/base/)
    expect(t.previews).toHaveLength(0)

    tool.onPointerUp!(release)
    expect(tool.capturesPointer).toBe(false)
    expect(tool.cursor!()).toBe("ns-resize")
    expect(tool.hint()).toMatch(/click to confirm/)
    // Height follows the cursor relatively: nothing at the release point…
    expect(t.overlay().label?.text).toBe("0 ft")
    // …and 7.5 ft when the cursor moved 7.5 ft of screen "up" at the corner.
    tool.onPointerMove!(t.heightAt({ x: 30, y: 0, z: 30 }, release, 7.4))
    o = t.overlay()
    expect(o.label?.text).toBe("+7.5 ft · Add")
    expect(o.draft!.shape.points.every((p) => p.y === 7.5)).toBe(true)
    expect(o.label!.at.y).toBe(7.5)
    // The engine previews the level baked with the draft; the document is untouched.
    const last = t.previews.at(-1)!
    expect(last.levelId).toBe(levelId)
    expect(t.previewHeight(last, 25, 25)).toBe(7.5)
    expect(t.previewHeight(last, 40, 40)).toBe(0)
    expect(store.getState().scene).toBe(before)

    const pushed = t.previews.length
    tool.onPointerDown!(t.at(50, 0, 50))
    const s = store.getState()
    expect(s.history).toMatchObject({ undoDepth: 1, undoLabel: "Add terrain block" })
    const [shape] = t.shapes()
    expect(shape).toMatchObject({ kind: "block", op: "add", order: 0, base: 0 })
    expect(xyz(shape.points)).toEqual([
      [20, 7.5, 20],
      [30, 7.5, 20],
      [30, 7.5, 30],
      [20, 7.5, 30],
    ])
    expect(sampleHeight(s.scene.levels[levelId].heightmap, 5, 25, 25, s.scene.grid)).toBe(7.5)
    expect(s.terrainSelection).toEqual({ levelId, shapeIds: [shape.id], elements: [] })
    // The commit changed the heightmap: no clearPreview (updateScene drops it without a flash).
    expect(t.previews).toHaveLength(pushed)

    // The confirming press is swallowed until release: no new base.
    tool.onPointerMove!(t.at(60, 0, 60))
    expect(t.overlay().draft).toBeNull()
    tool.onPointerUp!(t.at(60, 0, 60))
    expect(t.shapes()).toHaveLength(1)
    // The sub-tool stays active: the next press starts a new base.
    tool.onPointerDown!(t.at(60, 0, 60))
    expect(t.overlay().draft).not.toBeNull()
    tool.cancel!()

    store.getState().undo()
    expect(store.getState().scene.levels[levelId].heightmap).toBeNull()
    expect(store.getState().scene.levels[levelId].terrainEdits).toBeUndefined()
  })

  it("a click makes a one-cell base; moving down carves; Enter confirms", () => {
    const t = terrainHarness({ sub: "block" })
    const { tool, store, levelId } = t
    tool.onPointerDown!(t.at(12, 0, 13))
    const release = t.at(12.1, 0, 13)
    tool.onPointerUp!(release)
    expect(xyz(t.overlay().draft!.shape.points).map(([x, , z]) => [x, z])).toEqual([
      [10, 10],
      [15, 10],
      [15, 15],
      [10, 15],
    ])
    tool.onPointerMove!(t.heightAt({ x: 10, y: 0, z: 15 }, release, -3.1))
    expect(t.overlay().label?.text).toBe("−3 ft · Carve")
    expect(tool.onKeyDown!(key("Enter", { action: { type: "confirm" } }))).toBe(true)
    const [shape] = t.shapes()
    expect(shape).toMatchObject({ op: "carve", base: 0 })
    expect(shape.points.every((p) => p.y === -3)).toBe(true)
    expect(t.height(12.5, 12.5)).toBe(-3)
    expect(store.getState().terrainSelection?.shapeIds).toEqual([shape.id])
    // Enter with nothing to confirm is not consumed.
    expect(tool.onKeyDown!(key("Enter", { action: { type: "confirm" } }))).toBe(false)
    expect(store.getState().scene.levels[levelId].terrainEdits).toBeDefined()
  })

  it("right-click and Escape cancel; a zero height creates nothing", () => {
    const t = terrainHarness({ sub: "block" })
    const { tool, store } = t
    let release = drawBase(t, 20, 20, 30, 30)
    tool.onPointerMove!(t.heightAt({ x: 30, y: 0, z: 30 }, release, 5))
    expect(t.previews.length).toBeGreaterThan(0)
    tool.onPointerDown!(t.at(30, 0, 30, { button: 2 }))
    expect(t.overlay().draft).toBeNull()
    expect(t.previews.at(-1)!.heights).toBeNull()
    expect(store.getState().history.canUndo).toBe(false)

    release = drawBase(t, 20, 20, 30, 30)
    tool.onPointerMove!(t.heightAt({ x: 30, y: 0, z: 30 }, release, 5))
    expect(tool.onKeyDown!(key("Escape"))).toBe(true)
    expect(t.overlay().draft).toBeNull()
    expect(store.getState().history.canUndo).toBe(false)

    release = drawBase(t, 20, 20, 30, 30)
    tool.onPointerMove!(t.heightAt({ x: 30, y: 0, z: 30 }, release, 0.1))
    tool.onPointerDown!(t.at(30, 0, 30))
    tool.onPointerUp!(t.at(30, 0, 30))
    expect(t.shapes()).toEqual([])
    expect(store.getState().history.canUndo).toBe(false)
  })

  it("ramps rise along the dominant drag axis (away from the camera for a click); R turns them", () => {
    const t = terrainHarness({ sub: "ramp" })
    const { tool } = t
    // Drag mostly along +X: rises toward +X.
    let release = drawBase(t, 20, 20, 40, 30)
    tool.onPointerMove!(t.heightAt({ x: 40, y: 0, z: 30 }, release, 4))
    let pts = t.overlay().draft!.shape.points
    expect(pts.filter((p) => p.y === 4).every((p) => p.x === 40)).toBe(true)
    expect(pts.filter((p) => p.y === 0).every((p) => p.x === 20)).toBe(true)
    // R: a quarter turn (+X → −Z); Shift+R back.
    expect(tool.onKeyDown!(key("r", { action: { type: "rotate", turns: 1 } }))).toBe(true)
    pts = t.overlay().draft!.shape.points
    expect(pts.filter((p) => p.y === 4).every((p) => p.z === 20)).toBe(true)
    expect(tool.onKeyDown!(key("R", { shift: true, action: { type: "rotate", turns: -1 } }))).toBe(true)
    tool.onKeyDown!(key("R", { shift: true, action: { type: "rotate", turns: -1 } }))
    tool.onPointerDown!(t.at(0, 0, 0))
    tool.onPointerUp!(t.at(0, 0, 0))
    const [ramp] = t.shapes()
    expect(ramp.kind).toBe("ramp")
    // −1 from +X is +Z: the high edge at z 30.
    expect(ramp.points.filter((p) => p.y === 4).every((p) => p.z === 30)).toBe(true)
    expect(t.height(30, 30)).toBeCloseTo(4)
    expect(t.height(30, 20)).toBeCloseTo(0)

    // A click: the camera looks toward −Z (tilted from the +Z side), so the ramp rises toward −Z.
    tool.onPointerDown!(t.at(72, 0, 72))
    release = t.at(72, 0, 72)
    tool.onPointerUp!(release)
    tool.onPointerMove!(t.heightAt({ x: 70, y: 0, z: 70 }, release, 2))
    pts = t.overlay().draft!.shape.points
    expect(pts.filter((p) => p.y === 2).every((p) => p.z === 70)).toBe(true)
  })

  it("cylinders: centre on the snap mode, radius in half cells, sides from the settings", () => {
    const t = terrainHarness({ sub: "cylinder" })
    const { tool, store } = t
    store.getState().setToolSettings("terrain", { cylinderSides: 8 })
    tool.onPointerDown!(t.at(51, 0, 49))
    const release = t.at(52.5 + 7.2, 0, 47.5)
    tool.onPointerMove!(release)
    expect(t.overlay().label?.text).toBe("r 7.5 ft")
    tool.onPointerUp!(release)
    tool.onPointerMove!(t.heightAt({ x: 52.5 + 7.2, y: 0, z: 47.5 }, release, 5))
    tool.onPointerDown!(t.at(0, 0, 0))
    const [c] = t.shapes()
    expect(c).toMatchObject({ kind: "cylinder", op: "add" })
    expect(c.points).toHaveLength(8)
    for (const p of c.points) {
      expect(Math.hypot(p.x - 52.5, p.z - 47.5)).toBeCloseTo(7.5)
      expect(p.y).toBe(5)
    }
    // A click: half a cell of radius.
    tool.onPointerUp!(t.at(0, 0, 0))
    tool.onPointerDown!(t.at(20, 0, 20))
    tool.onPointerUp!(t.at(20, 0, 20))
    expect(Math.hypot(t.overlay().draft!.shape.points[0].x - 22.5, t.overlay().draft!.shape.points[0].z - 22.5)).toBeCloseTo(2.5)
  })

  it("the height follows the cursor with every camera (ortho top-down and tilted, perspective, straight down)", () => {
    const cameras: [string, TestCamera][] = [
      ["ortho 0°", orthoCamera({ tilt: 0 })],
      ["ortho 15°", orthoCamera({ tilt: 15 })],
      ["perspective 45°", perspectiveCamera({ tilt: 45 })],
      ["perspective straight down", perspectiveCamera({ tilt: 0, distance: 150 })],
    ]
    for (const [name, camera] of cameras) {
      const t = terrainHarness({ sub: "block", camera })
      const release = drawBase(t, 20, 20, 30, 30)
      for (const h of [2, 6.5, -4]) {
        t.tool.onPointerMove!(t.heightAt({ x: 30, y: 0, z: 30 }, release, h))
        expect(t.overlay().draft!.shape.points[0].y, `${name} h=${h}`).toBe(h)
      }
      t.tool.onPointerMove!(t.heightAt({ x: 30, y: 0, z: 30 }, release, 3))
      t.tool.onPointerDown!(t.at(0, 0, 0))
      expect(t.shapes()[0].points[0].y, name).toBe(3)
    }
  })

  it("without a projector the height comes from the ray's closest point on the vertical", () => {
    const t = terrainHarness({ sub: "block", project: false, camera: perspectiveCamera({ tilt: 45 }) })
    const release = drawBase(t, 20, 20, 30, 30)
    const target = t.camera.project({ x: 30, y: 6, z: 30 })
    const r = t.camera.project({ x: 30, y: 0, z: 30 })
    t.tool.onPointerMove!(t.px(release.canvasX! + target.x - r.x, release.canvasY! + target.y - r.y))
    expect(t.overlay().label?.text).toBe("+6 ft · Add")
  })

  it("freezes the height while the camera is dragged and re-anchors afterwards", () => {
    const t = terrainHarness({ sub: "block" })
    const release = drawBase(t, 20, 20, 30, 30)
    t.tool.onPointerMove!(t.heightAt({ x: 30, y: 0, z: 30 }, release, 2))
    // Orbiting (right button held): the cursor travels, the height does not.
    t.tool.onPointerMove!(t.heightAt({ x: 30, y: 0, z: 30 }, release, 9, { buttons: 2 }))
    expect(t.overlay().label?.text).toBe("+2 ft · Add")
    // Afterwards the height continues from there.
    const moved = t.heightAt({ x: 30, y: 0, z: 30 }, release, 9)
    t.tool.onPointerMove!(t.heightAt({ x: 30, y: 0, z: 30 }, moved, 1.5))
    expect(t.overlay().label?.text).toBe("+3.5 ft · Add")
  })

  it("snaps to the height step, Alt frees it without a move; re-bakes only when the snapped draft changes", () => {
    const t = terrainHarness({ sub: "block" })
    const { tool, store } = t
    const release = drawBase(t, 20, 20, 30, 30)
    tool.onPointerMove!(t.heightAt({ x: 30, y: 0, z: 30 }, release, 7.3))
    expect(t.overlay().label?.text).toBe("+7.5 ft · Add")
    const n = t.previews.length
    const overlay = t.overlay()
    tool.onPointerMove!(t.heightAt({ x: 30, y: 0, z: 30 }, release, 7.4))
    tool.onPointerMove!(t.heightAt({ x: 30, y: 0, z: 30 }, release, 7.6))
    expect(t.previews).toHaveLength(n)
    // Same snapped draft: no redraw at all (the overlay is the same object).
    expect(t.overlay()).toBe(overlay)
    store.getState().setAltHeld(true)
    expect(t.overlay().label?.text).toBe("+7.6 ft · Add")
    expect(t.previews).toHaveLength(n + 1)
    store.getState().setAltHeld(false)
    store.getState().setToolSettings("terrain", { heightStep: 2 })
    expect(t.overlay().label?.text).toBe("+8 ft · Add")
  })

  it("releasing Alt without moving re-snaps the height, and the commit uses it", () => {
    const t = terrainHarness({ sub: "block" })
    const { tool, store } = t
    const release = drawBase(t, 20, 20, 30, 30)
    store.getState().setAltHeld(true)
    tool.onPointerMove!(t.heightAt({ x: 30, y: 0, z: 30 }, release, 7.37, { alt: true }))
    expect(t.overlay().label?.text).toBe("+7.37 ft · Add")
    store.getState().setAltHeld(false)
    expect(t.overlay().label?.text).toBe("+7.5 ft · Add")
    tool.onKeyDown!(key("Enter", { action: { type: "confirm" } }))
    expect(t.shapes()[0].points.map((p) => p.y)).toEqual([7.5, 7.5, 7.5, 7.5])
  })

  it("the idle hint comes back when the confirming click is released", () => {
    const t = terrainHarness({ sub: "block" })
    const { tool } = t
    const release = drawBase(t, 20, 20, 30, 30)
    tool.onPointerMove!(t.heightAt({ x: 30, y: 0, z: 30 }, release, 4))
    tool.onPointerDown!(t.at(50, 0, 50))
    expect(tool.hint()).toBeNull()
    const n = t.invalidations()
    tool.onPointerUp!(t.at(50, 0, 50))
    expect(t.invalidations()).toBeGreaterThan(n)
    expect(tool.hint()).toBe("Drag to draw the base (click: one cell)")
  })

  it("straight-down perspective: moving the cursor up raises the block wherever the corner is on screen", () => {
    for (const [target, from, to] of [
      // The finding's case: the release corner below and right of the screen centre.
      [{ x: 30, y: 0, z: 30 }, [40, 40], [50, 50]],
      // Close to the centre: "up" projects to a tiny radial vector.
      [{ x: 30.3, y: 0, z: 30 }, [25, 25], [35, 30]],
    ] as const) {
      const camera = perspectiveCamera({ tilt: 0, target })
      for (const [dx, dy, sign] of [
        [0, -40, 1],
        [0, 40, -1],
        [40, 0, 0],
        [-40, 0, 0],
      ] as const) {
        const t = terrainHarness({ sub: "block", camera })
        const release = drawBase(t, from[0], from[1], to[0], to[1])
        t.tool.onPointerMove!(t.px(release.canvasX! + dx, release.canvasY! + dy))
        const h = t.overlay().draft!.shape.points[0].y
        expect(Math.sign(h), `corner ${to} move (${dx}, ${dy}): ${h}`).toBe(sign)
      }
    }
  })

  it("the height label stays at the cursor where the corner barely moves on screen (top-down, tilt 0)", () => {
    const camera = orthoCamera({ tilt: 0, scale: 3 })
    const t = terrainHarness({ sub: "block", camera })
    const release = drawBase(t, 20, 20, 35, 35)
    const cursor = t.px(release.canvasX!, release.canvasY! - 80)
    t.tool.onPointerMove!(cursor)
    const o = t.overlay()
    expect(o.label?.text).toMatch(/^\+\d+(\.\d+)? ft · Add$/)
    const at = camera.project(o.label!.at)
    expect(Math.hypot(at.x - cursor.canvasX!, at.y - cursor.canvasY!)).toBeLessThan(0.5)
    expect(o.label!.at.y).toBe(o.draft!.shape.points[0].y)
  })

  it("the label on the pointer ray follows sideways moves within one height step (top-down, tilt 0)", () => {
    const camera = orthoCamera({ tilt: 0 })
    const t = terrainHarness({ sub: "block", camera })
    const release = drawBase(t, 45, 45, 55, 55)
    const up = t.px(release.canvasX!, release.canvasY! - 40)
    t.tool.onPointerMove!(up)
    const text = t.overlay().label!.text
    expect(text).toMatch(/^\+\d+(\.\d+)? ft · Add$/)
    for (const dx of [30, 60, 120]) {
      const side = t.px(release.canvasX! + dx, release.canvasY! - 40)
      const n = t.invalidations()
      t.tool.onPointerMove!(side)
      expect(t.invalidations(), `dx ${dx}`).toBeGreaterThan(n)
      const o = t.overlay()
      expect(o.label!.text).toBe(text)
      const at = camera.project(o.label!.at)
      expect(Math.hypot(at.x - side.canvasX!, at.y - side.canvasY!), `dx ${dx}`).toBeLessThan(1)
    }
  })

  it("starts on the baked ground under the first corner and drags on that plane", () => {
    const t = terrainHarness({ sub: "block" })
    t.add(blockShape("first", { x: 20, z: 20, w: 20, d: 20 }, 0, 5, 0))
    // Press on the block's top at (25, 25): y0 = 5; the far corner on the plane y = 5.
    const release = drawBase(t, 25.3, 24.6, 35.2, 34.9, 5)
    t.tool.onPointerMove!(t.heightAt({ x: 35, y: 5, z: 35 }, release, 2))
    t.tool.onPointerDown!(t.at(0, 0, 0))
    const created = t.shapes().find((s) => s.id !== "first")!
    expect(created).toMatchObject({ base: 5, order: 1, op: "add" })
    expect(xyz(created.points)).toEqual([
      [25, 7, 25],
      [35, 7, 25],
      [35, 7, 35],
      [25, 7, 35],
    ])
    expect(t.height(30, 30)).toBe(7)
    expect(t.height(22.5, 22.5)).toBe(5)
  })

  it("clamps the base to the scene extent", () => {
    const t = terrainHarness({ sub: "block" })
    drawBase(t, 90, 90, 130, 120)
    expect(xyz(t.overlay().draft!.shape.points).map(([x, , z]) => [x, z])).toEqual([
      [90, 90],
      [100, 90],
      [100, 100],
      [90, 100],
    ])
  })

  it("skips the terrain preview where no floor is drawn (hint), and still commits", () => {
    const t = terrainHarness({ sub: "block", scene: createScene({ width: 20, depth: 20, groundFloor: false }) })
    const release = drawBase(t, 20, 20, 30, 30)
    t.tool.onPointerMove!(t.heightAt({ x: 30, y: 0, z: 30 }, release, 4))
    expect(t.previews).toHaveLength(0)
    expect(t.tool.hint()).toBe(NO_FLOOR_HINT)
    t.tool.onPointerDown!(t.at(0, 0, 0))
    expect(t.height(25, 25)).toBe(4)
    expect(t.previews).toHaveLength(0)
  })

  it("does nothing when read-only", () => {
    const t = terrainHarness({ sub: "block" })
    t.store.getState().loadScene(t.store.getState().scene, { readOnly: true })
    t.tool.onPointerDown!(t.at(20, 0, 20))
    t.tool.onPointerMove!(t.at(30, 0, 30))
    expect(t.overlay().draft).toBeNull()
    expect(t.tool.capturesPointer).toBe(false)
  })
})

describe("terrain polygon", () => {
  const click = (t: TerrainHarness, x: number, z: number, init: { button?: number; alt?: boolean } = {}) => {
    const e = t.at(x, 0, z, init)
    t.tool.onPointerMove!(e)
    t.tool.onPointerDown!(e)
    t.tool.onPointerUp!(e)
    return e
  }
  const corners = (t: TerrainHarness) => t.overlay().outline?.points.map((p) => [p.x, p.z])

  it("click corners, right-click to finish, move and click to set the height (one undo step)", () => {
    const t = terrainHarness({ sub: "polygon" })
    const { tool, store, levelId } = t
    // Idle: the snapped point a click would place; no keys next to the cursor yet.
    tool.onPointerMove!(t.at(10.4, 0, 9.7))
    expect(corners(t)).toEqual([[10, 10]])
    expect(tool.cursorKeys!()).toBeNull()
    expect(tool.hint()).toMatch(/first corner/)

    click(t, 10.4, 9.7)
    expect(tool.capturesPointer).toBe(false)
    const keys = tool.cursorKeys!()
    expect(keys?.map((k) => k.label)).toEqual(["Add corner", "Finish, set height", "Remove last corner", "Cancel"])
    expect(keys?.[1]).toMatchObject({ mouse: "Right-click", commands: ["confirm"] })
    // The same list while nothing changes (the canvas re-renders on a new identity).
    expect(tool.cursorKeys!()).toBe(keys)
    click(t, 40.2, 10.3)
    // The pending corner follows the pointer; with three the closing edge and a zero-height fill show.
    tool.onPointerMove!(t.at(39.6, 0, 20.2))
    let o = t.overlay()
    expect(corners(t)).toEqual([
      [10, 10],
      [40, 10],
      [40, 20],
    ])
    expect(o.outline).toMatchObject({ valid: true, closing: "ok" })
    expect(o.draft?.shape.kind).toBe("polygon")
    expect(o.label?.text).toBe("10 ft")
    // Enter with two corners placed: not yet.
    expect(tool.onKeyDown!(key("Enter", { action: { type: "confirm" } }))).toBe(true)
    expect(tool.hint()).toBe("Place at least 3 corners")
    click(t, 39.6, 20.2)
    click(t, 25, 20)
    click(t, 25, 30)
    click(t, 10, 30)
    expect(corners(t)).toHaveLength(6)
    expect(tool.hint()).toMatch(/right-click, Enter or click the first corner/)

    // Right-click finishes (it places no corner); the height is anchored at the corner nearest the pointer.
    const release = t.at(11.3, 0, 28.8, { button: 2 })
    tool.onPointerDown!(release)
    expect(tool.cursor!()).toBe("ns-resize")
    expect(tool.cursorKeys!()?.map((k) => k.label)).toEqual(["Confirm height", "Cancel"])
    tool.onPointerMove!(t.heightAt({ x: 10, y: 0, z: 30 }, release, 4.1))
    o = t.overlay()
    expect(o.outline).toBeNull()
    expect(o.label?.text).toBe("+4 ft · Add")
    tool.onPointerDown!(t.at(0, 0, 0))
    tool.onPointerUp!(t.at(0, 0, 0))

    const [shape] = t.shapes()
    expect(shape).toMatchObject({ kind: "polygon", op: "add", base: 0 })
    expect(shape.points.map((p) => [p.x, p.y, p.z])).toEqual([
      [10, 4, 10],
      [40, 4, 10],
      [40, 4, 20],
      [25, 4, 20],
      [25, 4, 30],
      [10, 4, 30],
    ])
    expect(store.getState().history).toMatchObject({ undoDepth: 1, undoLabel: "Add terrain polygon" })
    expect(store.getState().terrainSelection?.shapeIds).toEqual([shape.id])
    expect(t.height(15, 25)).toBe(4)
    expect(t.height(35, 25)).toBe(0)
    expect(tool.cursorKeys!()).toBeNull()
    expect(store.getState().scene.levels[levelId].terrainEdits).toBeDefined()
  })

  it("closes on the first corner or a double-click; Enter finishes too", () => {
    const t = terrainHarness({ sub: "polygon" })
    click(t, 10, 10)
    click(t, 20, 10)
    click(t, 20, 20)
    click(t, 10.2, 9.9)
    expect(t.tool.cursor!()).toBe("ns-resize")
    t.tool.cancel!()

    click(t, 10, 10)
    click(t, 20, 10)
    const e = t.at(15, 0, 20)
    t.tool.onPointerDown!(e)
    t.tool.onPointerDown!({ ...e, detail: 2 })
    expect(t.tool.cursor!()).toBe("ns-resize")
    t.tool.cancel!()

    click(t, 10, 10)
    click(t, 20, 10)
    click(t, 15, 20)
    expect(t.tool.onKeyDown!(key("Enter", { action: { type: "confirm" } }))).toBe(true)
    expect(t.tool.cursor!()).toBe("ns-resize")
    expect(t.shapes()).toHaveLength(0)
  })

  it("Backspace removes the last corner, a crossing corner is refused, Esc cancels", () => {
    const t = terrainHarness({ sub: "polygon" })
    const { tool, store } = t
    const before = store.getState().scene
    click(t, 10, 10)
    click(t, 30, 10)
    click(t, 30, 30)
    // Back across the first edge: refused, with a notice.
    click(t, 20, 0)
    expect(tool.hint()).toBe("That edge would cross the outline")
    tool.onPointerMove!(t.at(10, 0, 30))
    expect(corners(t)).toHaveLength(4)
    expect(tool.onKeyDown!(key("Backspace", { action: { type: "delete" } }))).toBe(true)
    tool.onPointerMove!(t.at(10, 0, 30))
    expect(corners(t)).toEqual([
      [10, 10],
      [30, 10],
      [10, 30],
    ])
    // The document is untouched by corner edits.
    expect(store.getState().scene).toBe(before)
    // A "Z": the open chain is fine, but its closing edge crosses: drawn red, and it cannot finish yet.
    click(t, 10, 30)
    click(t, 30, 30)
    expect(t.overlay().outline).toMatchObject({ valid: true, closing: "crossing" })
    expect(t.overlay().draft).toBeNull()
    tool.onPointerDown!(t.at(30, 0, 30, { button: 2 }))
    expect(tool.hint()).toMatch(/can't cross itself/)
    expect(tool.cursor!()).not.toBe("ns-resize")
    expect(tool.onKeyDown!(key("Escape", { action: { type: "escape" } }))).toBe(true)
    expect(t.overlay().outline ?? null).toBeNull()
    expect(tool.cursorKeys!()).toBeNull()

    // Removing every corner ends the gesture.
    click(t, 10, 10)
    tool.onKeyDown!(key("Backspace", { action: { type: "delete" } }))
    expect(tool.cursorKeys!()).toBeNull()
    expect(store.getState().scene).toBe(before)
  })
})
