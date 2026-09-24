import { describe, expect, it } from "vitest"

import {
  closestPointOnAxis,
  GIZMO_SHAFT_END_PX,
  GIZMO_SHAFT_START_PX,
  gizmoHandles,
  gizmoRing,
  GIZMO_RING_PX,
  heightFollowParams,
  heightFromPointer,
  hitGizmo,
  pointToSegmentDistancePx,
  ringAngle,
  ringDistancePx,
  ringPoint,
  wrapAngle,
  type HeightFollowState,
  type Projector,
  type ScreenPoint,
} from "./gizmo"
import type { Vec3 } from "../scene/types"

const W = 800
const H = 600

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z })
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
const add = (a: Vec3, b: Vec3, s = 1): Vec3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s })
const norm = (a: Vec3): Vec3 => {
  const l = Math.sqrt(dot(a, a))
  return { x: a.x / l, y: a.y / l, z: a.z / l }
}
const up = (p: Vec3, h: number): Vec3 => ({ x: p.x, y: p.y + h, z: p.z })

interface Camera {
  project: Projector
  ray(c: ScreenPoint): { origin: Vec3; direction: Vec3 }
}

/**
 * Camera basis for a view tilted `tiltDeg` from straight down, yawed `yawDeg` about +Y: forward f, screen
 * right r, screen up u (world +Y projects to screen up when tilted).
 */
function basis(tiltDeg: number, yawDeg = 0): { f: Vec3; r: Vec3; u: Vec3 } {
  const t = (tiltDeg * Math.PI) / 180
  const y = (yawDeg * Math.PI) / 180
  const f0 = { x: 0, y: -Math.cos(t), z: -Math.sin(t) }
  const u0 = { x: 0, y: Math.sin(t), z: -Math.cos(t) }
  const rot = (v: Vec3): Vec3 => ({ x: v.x * Math.cos(y) + v.z * Math.sin(y), y: v.y, z: -v.x * Math.sin(y) + v.z * Math.cos(y) })
  return { f: rot(f0), r: rot({ x: 1, y: 0, z: 0 }), u: rot(u0) }
}

/** Orthographic camera centred on `target`, `pxPerFt` screen pixels per foot. */
function ortho(target: Vec3, tiltDeg: number, pxPerFt: number, yawDeg = 0): Camera {
  const { f, r, u } = basis(tiltDeg, yawDeg)
  return {
    project: (p) => {
      const v = sub(p, target)
      return { x: W / 2 + dot(v, r) * pxPerFt, y: H / 2 - dot(v, u) * pxPerFt, visible: true }
    },
    ray: (c) => ({ origin: add(add(add(target, r, (c.x - W / 2) / pxPerFt), u, -(c.y - H / 2) / pxPerFt), f, -500), direction: f }),
  }
}

/** Perspective camera `dist` feet from `target` along −forward, vertical field of view `fovDeg`. */
function perspective(target: Vec3, tiltDeg: number, dist: number, fovDeg = 50): Camera {
  const { f, r, u } = basis(tiltDeg)
  const eye = add(target, f, -dist)
  const fpx = H / 2 / Math.tan((fovDeg * Math.PI) / 360)
  return {
    project: (p) => {
      const v = sub(p, eye)
      const z = dot(v, f)
      return { x: W / 2 + (fpx * dot(v, r)) / z, y: H / 2 - (fpx * dot(v, u)) / z, visible: z > 0.1 }
    },
    ray: (c) => ({ origin: eye, direction: norm(add(add(f, r, (c.x - W / 2) / fpx), u, -(c.y - H / 2) / fpx)) }),
  }
}

const px = (cam: Camera, p: Vec3): ScreenPoint => {
  const q = cam.project(p)!
  return { x: q.x, y: q.y }
}

describe("gizmoHandles", () => {
  const at = { x: 30, y: 2, z: 40 }

  it("hides Y seen end-on (tilt 0) and lays X / Z shafts from 14 to 70 px", () => {
    const cam = ortho(at, 0, 10)
    const g = gizmoHandles(cam.project, at)
    expect(g.y.visible).toBe(false)
    expect(g.y.unitPx).toBeCloseTo(0, 9)
    expect(g.x.visible).toBe(true)
    expect(g.x.unitPx).toBeCloseTo(10, 9)
    expect(g.x.dir.x).toBeCloseTo(1, 9)
    expect(g.x.from.x - g.x.origin.x).toBeCloseTo(GIZMO_SHAFT_START_PX, 9)
    expect(g.x.to.x - g.x.origin.x).toBeCloseTo(GIZMO_SHAFT_END_PX, 9)
    expect(g.x.to.y).toBeCloseTo(H / 2, 9)
    // +Z points down the screen in this view.
    expect(g.z.visible).toBe(true)
    expect(g.z.dir.y).toBeCloseTo(1, 9)
    expect(g.z.to.y - g.z.origin.y).toBeCloseTo(GIZMO_SHAFT_END_PX, 9)
  })

  it("shows Y (pointing up the screen) at tilt 15°", () => {
    const g = gizmoHandles(ortho(at, 15, 10).project, at)
    expect(g.y.visible).toBe(true)
    expect(g.y.unitPx).toBeCloseTo(10 * Math.sin((15 * Math.PI) / 180), 9)
    expect(g.y.dir.y).toBeCloseTo(-1, 9)
    expect(g.y.dir.x).toBeCloseTo(0, 9)
  })

  it("hides an axis below 2 px per foot only when it is also foreshortened relative to the others", () => {
    // 2° tilt at 10 px/ft: Y is 0.35 px/ft, < 2 px and < 10% of X → hidden.
    expect(gizmoHandles(ortho(at, 2, 10).project, at).y.visible).toBe(false)
    // Zoomed far out (0.5 px/ft): X and Z stay usable; Y at tilt 0 stays hidden.
    const far = gizmoHandles(ortho(at, 0, 0.5).project, at)
    expect(far.x.visible).toBe(true)
    expect(far.z.visible).toBe(true)
    expect(far.y.visible).toBe(false)
    expect(far.x.to.x - far.x.origin.x).toBeCloseTo(GIZMO_SHAFT_END_PX, 9)
    // 15° at 5 px/ft: Y is 1.3 px/ft (< 2) but 26% of X → shown.
    expect(gizmoHandles(ortho(at, 15, 5).project, at).y.visible).toBe(true)
  })

  it("shows all three axes in a 45° perspective view, and none behind the camera", () => {
    const cam = perspective(at, 45, 80)
    const g = gizmoHandles(cam.project, at)
    expect([g.x.visible, g.y.visible, g.z.visible]).toEqual([true, true, true])
    for (const h of [g.x, g.y, g.z]) expect(Math.hypot(h.dir.x, h.dir.y)).toBeCloseTo(1, 9)
    const behind = add(at, basis(45).f, -200)
    const gb = gizmoHandles(cam.project, behind)
    expect([gb.x.visible, gb.y.visible, gb.z.visible]).toEqual([false, false, false])
    expect(gizmoHandles(() => null, at).x.visible).toBe(false)
  })

  it("hides the more foreshortened of two handles pointing the same way on screen, so the drawn one is the one hit", () => {
    // Top-down camera at tilt 15° turned half a turn: Y and Z both point up the screen (Z is the longer one).
    const half = gizmoHandles(ortho(at, 15, 10, 180).project, at)
    expect(half.y.dir.y).toBeCloseTo(-1, 9)
    expect(half.z.dir.y).toBeCloseTo(-1, 9)
    expect([half.x.visible, half.y.visible, half.z.visible]).toEqual([true, false, true])
    const mid = (h: { from: ScreenPoint; to: ScreenPoint }) => ({ x: (h.from.x + h.to.x) / 2, y: (h.from.y + h.to.y) / 2 })
    expect(hitGizmo(half, mid(half.z))).toBe("z")
    expect(hitGizmo(half, { x: mid(half.z).x + 3, y: mid(half.z).y })).toBe("z")
    // Turned a quarter the other way: X and Y coincide, Y is hidden.
    const quarter = gizmoHandles(ortho(at, 15, 10, -90).project, at)
    expect(quarter.x.dir.y).toBeCloseTo(-1, 9)
    expect([quarter.x.visible, quarter.y.visible, quarter.z.visible]).toEqual([true, false, true])
    expect(hitGizmo(quarter, mid(quarter.x))).toBe("x")
    // Opposite directions do not overlap: at yaw 0, Y points up and Z down, both shown.
    const g = gizmoHandles(ortho(at, 15, 10).project, at)
    expect([g.x.visible, g.y.visible, g.z.visible]).toEqual([true, true, true])
  })

  it("hit-tests the visible shafts within the radius", () => {
    const g = gizmoHandles(ortho(at, 0, 10).project, at)
    const o = g.x.origin
    expect(hitGizmo(g, { x: o.x + 40, y: o.y })).toBe("x")
    expect(hitGizmo(g, { x: o.x + 40, y: o.y - 6 })).toBe("x")
    expect(hitGizmo(g, { x: o.x + 40, y: o.y - 8 })).toBe(null)
    expect(hitGizmo(g, { x: o.x + 40, y: o.y - 8 }, 10)).toBe("x")
    expect(hitGizmo(g, { x: o.x, y: o.y + 50 })).toBe("z")
    // The centre is not a handle (shafts start 14 px out); hidden Y is never hit.
    expect(hitGizmo(g, o)).toBe(null)
    expect(hitGizmo(g, { x: o.x, y: o.y - 40 })).toBe(null)
    // Nearest shaft wins where two radii overlap.
    expect(hitGizmo(g, { x: o.x + 13, y: o.y + 15 }, 20)).toBe("z")
    expect(hitGizmo(g, { x: o.x + 15, y: o.y + 13 }, 20)).toBe("x")
  })
})

describe("rotate ring", () => {
  const at = { x: 10, y: 4, z: -3 }

  it("is a horizontal circle of constant screen size, hidden when seen edge-on", () => {
    const top = gizmoRing(ortho(at, 0, 10).project, at)
    expect(top.visible).toBe(true)
    expect(top.radius).toBeCloseTo(GIZMO_RING_PX / 10, 9)
    const o = px(ortho(at, 0, 10), at)
    for (const q of top.points) expect(Math.hypot(q.x - o.x, q.y - o.y)).toBeCloseTo(GIZMO_RING_PX, 6)
    expect(gizmoRing(ortho(at, 0, 40).project, at).radius).toBeCloseTo(GIZMO_RING_PX / 40, 9)
    expect(gizmoRing(ortho(at, 35, 10).project, at).visible).toBe(true)
    expect(gizmoRing(perspective(at, 45, 80).project, at).visible).toBe(true)
    // Almost level with the ring: an ellipse too flat to drag around.
    expect(gizmoRing(ortho(at, 85, 10).project, at).visible).toBe(false)
  })

  it("hit-tests its polyline and measures the pointer's angle on its plane (+Z towards +X)", () => {
    for (const cam of [ortho(at, 15, 10), perspective(at, 45, 80)]) {
      const ring = gizmoRing(cam.project, at)
      const k = 64 / 8 // 45°
      const onRing = px(cam, ringPoint(at, ring.radius, k))
      expect(ringDistancePx(ring, onRing)).toBeLessThan(0.5)
      expect(ringDistancePx(ring, px(cam, at))).toBeGreaterThan(40)
      expect(ringAngle(cam.ray(onRing), at)).toBeCloseTo(Math.PI / 4, 6)
      expect(ringAngle(cam.ray(px(cam, ringPoint(at, ring.radius, 48))), at)).toBeCloseTo(-Math.PI / 2, 6)
    }
    expect(ringDistancePx({ visible: false, radius: 0, points: [] }, { x: 0, y: 0 })).toBe(Infinity)
    // A ray parallel to the plane has no angle.
    expect(ringAngle({ origin: { x: 0, y: 4, z: 0 }, direction: { x: 1, y: 0, z: 0 } }, at)).toBe(null)
  })

  it("wraps angles into (−π, π]", () => {
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI, 12)
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI, 12)
    expect(wrapAngle((3 * Math.PI) / 2)).toBeCloseTo(-Math.PI / 2, 12)
    expect(wrapAngle(-0.25)).toBeCloseTo(-0.25, 12)
  })
})

describe("pointToSegmentDistancePx", () => {
  it("measures to the segment, its ends and degenerate segments", () => {
    expect(pointToSegmentDistancePx({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3, 12)
    expect(pointToSegmentDistancePx({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5, 12)
    expect(pointToSegmentDistancePx({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5, 12)
    expect(pointToSegmentDistancePx({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(5, 12)
  })
})

describe("closestPointOnAxis", () => {
  it("finds the axis parameter nearest to the ray", () => {
    const r = closestPointOnAxis({ origin: { x: 3, y: 10, z: 5 }, direction: { x: 0, y: -1, z: 0 } }, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })
    expect(r!.s).toBeCloseTo(3, 12)
    expect(r!.point).toEqual({ x: 3, y: 0, z: 0 })
    const y = closestPointOnAxis({ origin: { x: -10, y: 7, z: 3 }, direction: { x: 1, y: 0, z: 0 } }, { x: 1, y: 2, z: 3 }, { x: 0, y: 1, z: 0 })
    expect(y!.s).toBeCloseTo(5, 12)
  })

  it("returns null for a ray parallel to the axis", () => {
    expect(closestPointOnAxis({ origin: { x: 0, y: 10, z: 0 }, direction: { x: 0, y: -1, z: 0 } }, { x: 1, y: 0, z: 1 }, { x: 0, y: 1, z: 0 })).toBe(null)
  })

  it("follows the cursor along a constrained axis through a camera", () => {
    const at = { x: 20, y: 0, z: 20 }
    for (const cam of [ortho(at, 15, 10), perspective(at, 45, 60)]) {
      for (const [axis, dir] of [
        ["x", { x: 1, y: 0, z: 0 }],
        ["z", { x: 0, y: 0, z: 1 }],
        ["y", { x: 0, y: 1, z: 0 }],
      ] as const) {
        const target = add(at, dir, 4)
        const hit = closestPointOnAxis(cam.ray(px(cam, target)), at, dir)
        expect(hit, axis).not.toBe(null)
        expect(hit!.s).toBeCloseTo(4, 6)
      }
    }
  })
})

describe("heightFromPointer", () => {
  const A = { x: 25, y: 3, z: 35 }
  const start = (cam: Camera, c: ScreenPoint = px(cam, A)) => heightFromPointer(null, A, c, cam.project, cam.ray(c).direction)!
  const move = (s: HeightFollowState, cam: Camera, c: ScreenPoint, freeze = false) => heightFromPointer(s, A, c, cam.project, cam.ray(c).direction, { freeze })!

  it("is 0 at the release point wherever it is", () => {
    const cam = ortho(A, 15, 10)
    expect(start(cam).h).toBe(0)
    expect(start(cam, { x: 12, y: 700 }).h).toBe(0)
  })

  it("tracks the projected height 1:1 in a 15° top-down view", () => {
    const cam = ortho(A, 15, 10)
    const s = start(cam)
    expect(move(s, cam, px(cam, up(A, 5))).h).toBeCloseTo(5, 9)
    expect(move(s, cam, px(cam, up(A, -2.5))).h).toBeCloseTo(-2.5, 9)
    // Sideways motion (perpendicular to screen "up") does not change the height.
    const c = px(cam, A)
    expect(move(s, cam, { x: c.x + 100, y: c.y }).h).toBeCloseTo(0, 9)
  })

  it("uses screen up and a quarter of the ground scale at tilt 0 (straight down)", () => {
    const cam = ortho(A, 0, 10)
    const s = start(cam)
    expect(s.u).toEqual({ x: 0, y: -1 })
    expect(s.k).toBeCloseTo(2.5, 9)
    const c = px(cam, A)
    expect(move(s, cam, { x: c.x, y: c.y - 25 }).h).toBeCloseTo(10, 9)
    expect(move(s, cam, { x: c.x, y: c.y + 5 }).h).toBeCloseTo(-2, 9)
    // Rotated views too (camera right is perpendicular to the ray's horizontal part, or world X).
    const yawed = ortho(A, 0, 10, 90)
    expect(start(yawed).k).toBeCloseTo(2.5, 9)
  })

  it("straight-down perspective, off the centre: world up is a short radial vector; screenUpWhenFloored turns it into screen up", () => {
    // The anchor below and right of the screen centre: up projects outward (down-right), shorter than the floor.
    const cam = perspective({ x: A.x - 8, y: A.y, z: A.z - 8 }, 0, 60)
    const c = px(cam, A)
    const radial = heightFollowParams(cam.project, A, cam.ray(c).direction)!
    expect(radial.u.x).toBeGreaterThan(0)
    expect(radial.u.y).toBeGreaterThan(0)
    const floored = heightFollowParams(cam.project, A, cam.ray(c).direction, { screenUpWhenFloored: true })!
    expect(floored.u).toEqual({ x: 0, y: -1 })
    expect(floored.k).toBe(radial.k)
    let s = heightFromPointer(null, A, c, cam.project, cam.ray(c).direction, { screenUpWhenFloored: true })!
    s = heightFromPointer(s, A, { x: c.x, y: c.y - 30 }, cam.project, cam.ray({ x: c.x, y: c.y - 30 }).direction, { screenUpWhenFloored: true })!
    expect(s.h).toBeCloseTo(30 / radial.k, 9)
    // Where up is long enough (a tilted view) the option changes nothing.
    const tilted = perspective(A, 45, 60)
    const t0 = heightFollowParams(tilted.project, A, tilted.ray(px(tilted, A)).direction)!
    expect(heightFollowParams(tilted.project, A, tilted.ray(px(tilted, A)).direction, { screenUpWhenFloored: true })).toEqual(t0)
  })

  it("keeps the gain above a quarter of the ground scale at shallow tilts", () => {
    const cam = ortho(A, 5, 10)
    const s = start(cam)
    expect(s.k).toBeCloseTo(2.5, 9)
    expect(s.u.y).toBeCloseTo(-1, 9)
  })

  it("matches the true height at 1 ft in a 45° perspective view and stays close further up", () => {
    const cam = perspective(A, 45, 60)
    const s = start(cam)
    expect(move(s, cam, px(cam, up(A, 1))).h).toBeCloseTo(1, 9)
    expect(move(s, cam, px(cam, up(A, 3))).h).toBeCloseTo(3, 0)
  })

  it("is monotonic in cursor motion along screen up, in every camera", () => {
    const cams = [ortho(A, 0, 10), ortho(A, 15, 10), perspective(A, 45, 60), perspective({ x: A.x + 10, y: A.y, z: A.z + 8 }, 0, 60)]
    for (const cam of cams) {
      let s = start(cam)
      const c0 = px(cam, A)
      let prev = s.h
      for (let k = 1; k <= 20; k++) {
        s = move(s, cam, { x: c0.x + s.u.x * 3 * k, y: c0.y + s.u.y * 3 * k })
        expect(Number.isFinite(s.h)).toBe(true)
        expect(s.h).toBeGreaterThan(prev)
        prev = s.h
      }
    }
  })

  it("stays continuous when zooming or panning re-anchors, then follows the new scale", () => {
    const near = ortho(A, 15, 10)
    let s = start(near)
    const c1 = px(near, up(A, 4))
    s = move(s, near, c1)
    const h1 = s.h
    expect(h1).toBeCloseTo(4, 9)
    // Zoom 2× about the anchor: its projection stays put, k doubles.
    const zoomed = ortho(A, 15, 20)
    s = move(s, zoomed, c1)
    expect(s.h).toBeCloseTo(h1, 12)
    s = move(s, zoomed, { x: c1.x + s.u.x * 20 * Math.sin((15 * Math.PI) / 180), y: c1.y + s.u.y * 20 * Math.sin((15 * Math.PI) / 180) })
    expect(s.h).toBeCloseTo(h1 + 1, 9)
    // Pan: the anchor jumps on screen; the height does not.
    const h2 = s.h
    const panned = ortho({ x: A.x + 5, y: A.y, z: A.z }, 15, 20)
    s = move(s, panned, s.last)
    expect(s.h).toBeCloseTo(h2, 12)
  })

  it("freezes during camera drags and ignores the cursor's travel there", () => {
    const cam = ortho(A, 15, 10)
    let s = start(cam)
    s = move(s, cam, px(cam, up(A, 2)))
    const h = s.h
    const orbit = ortho(A, 25, 10, 30)
    s = move(s, orbit, { x: 700, y: 50 }, true)
    expect(s.h).toBe(h)
    s = move(s, orbit, { x: 700, y: 50 })
    expect(s.h).toBeCloseTo(h, 12)
    s = move(s, orbit, { x: 700 + s.u.x * 10, y: 50 + s.u.y * 10 })
    expect(s.h).toBeGreaterThan(h)
  })

  it("returns null only when the first call cannot project", () => {
    expect(heightFromPointer(null, A, { x: 0, y: 0 }, () => null, { x: 0, y: -1, z: 0 })).toBe(null)
    const cam = ortho(A, 15, 10)
    const s = move(start(cam), cam, px(cam, up(A, 1)))
    const lost = heightFromPointer(s, A, { x: 5, y: 5 }, () => null, { x: 0, y: -1, z: 0 })!
    expect(lost.h).toBe(s.h)
    expect(lost.cRef).toEqual({ x: 5, y: 5 })
  })
})
