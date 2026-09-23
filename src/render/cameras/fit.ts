/**
 * Pure camera math shared by the editor orbit camera and the player 2.5D camera.
 *
 * Player camera convention: yaw 0 puts world −Z at the top of the screen and +X to the right; the
 * camera sits "behind" the target (toward the bottom of the screen) tilted `tilt` radians from
 * vertical. Quarter turns add π/2 to the yaw.
 */
import { heightRange } from "@/core/scene/heightmap"
import type { Level, SceneLike, Vec2, Vec3 } from "@/core/scene/types"

export interface Bounds3 {
  min: Vec3
  max: Vec3
}

/**
 * World bounds of a scene: the grid extent on XZ and every level's slab..ceiling in Y over its terrain.
 * `terrainRange` gives a level's relative terrain range (default: its heightmap's; the engine passes the
 * drawn one, terrain previews included).
 */
export function sceneBounds(
  scene: Pick<SceneLike, "grid" | "levels">,
  terrainRange: (level: Level) => { min: number; max: number } = (l) => heightRange(l.heightmap)
): Bounds3 {
  const w = scene.grid.width * scene.grid.cellSize
  const d = scene.grid.depth * scene.grid.cellSize
  let minY = Infinity
  let maxY = -Infinity
  for (const l of Object.values(scene.levels)) {
    const r = terrainRange(l)
    minY = Math.min(minY, l.elevation + r.min - l.floorThickness)
    maxY = Math.max(maxY, l.elevation + r.max + l.height)
  }
  if (minY === Infinity) {
    minY = 0
    maxY = 10
  }
  return { min: { x: 0, y: minY, z: 0 }, max: { x: w, y: maxY, z: d } }
}

export function boundsCenter(b: Bounds3): Vec3 {
  return { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 }
}

export function boundsDiagonal(b: Bounds3): number {
  return Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z)
}

/** Distance at which a sphere of `radius` fits a perspective view (vertical fov in radians). */
export function perspectiveFitDistance(radius: number, fovY: number, aspect: number, margin = 1.1): number {
  const fovX = 2 * Math.atan(Math.tan(fovY / 2) * Math.max(1e-3, aspect))
  const f = Math.min(fovY, fovX)
  return (Math.max(radius, 1e-3) * margin) / Math.sin(f / 2)
}

/**
 * Distance from `target` along the unit view direction `dir` (camera → target is −dir) at which every
 * corner of the box is inside a perspective frustum of vertical fov `fovY` (radians) and `aspect`,
 * with `margin` ≥ 1 of slack. Tighter than fitting the bounding sphere for flat, wide scenes.
 * `worldUp` defines the camera roll (default +Y).
 */
export function perspectiveFitBoxDistance(
  b: Bounds3,
  target: Vec3,
  dir: Vec3,
  fovY: number,
  aspect: number,
  margin = 1.05,
  worldUp: Vec3 = { x: 0, y: 1, z: 0 }
): number {
  // Camera basis: forward = −dir, right = forward × up, up' = right × forward.
  const f = { x: -dir.x, y: -dir.y, z: -dir.z }
  let r = { x: f.y * worldUp.z - f.z * worldUp.y, y: f.z * worldUp.x - f.x * worldUp.z, z: f.x * worldUp.y - f.y * worldUp.x }
  const rl = Math.hypot(r.x, r.y, r.z)
  r = rl > 1e-6 ? { x: r.x / rl, y: r.y / rl, z: r.z / rl } : { x: 1, y: 0, z: 0 }
  const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x }
  const tanY = Math.tan(fovY / 2) / Math.max(1, margin)
  const tanX = tanY * Math.max(1e-3, aspect)
  let d = 0
  for (const x of [b.min.x, b.max.x]) {
    for (const y of [b.min.y, b.max.y]) {
      for (const z of [b.min.z, b.max.z]) {
        const cx = x - target.x
        const cy = y - target.y
        const cz = z - target.z
        // Depth of the corner in front of a camera at target + dir·D is D − (c·dir).
        const along = cx * dir.x + cy * dir.y + cz * dir.z
        const sx = Math.abs(cx * r.x + cy * r.y + cz * r.z)
        const sy = Math.abs(cx * u.x + cy * u.y + cz * u.z)
        d = Math.max(d, along + sx / tanX, along + sy / tanY)
      }
    }
  }
  return d
}

/** Screen right / up directions on the ground plane for a player-camera yaw. */
export function groundAxes(yaw: number): { right: Vec2; up: Vec2 } {
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  return { right: { x: c, z: -s }, up: { x: -s, z: -c } }
}

/** Camera offset from its target for the player camera (unit distance scaled by `distance`). */
export function playerCameraOffset(yaw: number, tilt: number, distance: number): Vec3 {
  const { up } = groundAxes(yaw)
  const h = Math.sin(tilt) * distance
  return { x: -up.x * h, y: Math.cos(tilt) * distance, z: -up.z * h }
}

/**
 * Distance from its target at which the tilted orthographic player camera (tilt from vertical, `viewHeight`
 * world units tall) keeps every point up to `above` feet above the target at least `margin` in front of
 * it, anywhere on screen. A point h feet up at screen row s (world units from the centre, down < 0) lies
 * at depth D + s·tan(tilt) − h / cos(tilt): the bottom row of the screen is (viewHeight/2)·tan(tilt)
 * closer than the target, so a tilted, zoomed-out view needs the camera further back than one straight
 * down (else high terrain near the bottom edge crosses the near plane and is clipped away).
 */
export function orthoCameraDistance(above: number, viewHeight: number, tilt: number, margin = 30): number {
  const c = Math.max(0.2, Math.cos(tilt))
  return (Math.max(0, above) + margin) / c + (Math.max(0, viewHeight) / 2) * Math.tan(Math.min(Math.abs(tilt), 1.4))
}

/**
 * Orthographic view height (world units) that fits a w×d ground rect for a given yaw, tilt and
 * aspect ratio (width / height). Tilt foreshortens the ground's screen-vertical extent by cos(tilt).
 */
export function orthoFitViewHeight(w: number, d: number, aspect: number, yaw: number, tilt: number, margin = 1.1): number {
  const c = Math.abs(Math.cos(yaw))
  const s = Math.abs(Math.sin(yaw))
  const ex = w * c + d * s
  const ey = (w * s + d * c) * Math.cos(tilt)
  return Math.max(ey, ex / Math.max(1e-3, aspect), 1) * margin
}

/** Frame-rate independent exponential smoothing toward `target` (λ in 1/s). */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt)
}

/** Smallest signed angle a − b in (−π, π]. */
export function angleDelta(a: number, b: number): number {
  let d = (a - b) % (2 * Math.PI)
  if (d > Math.PI) d -= 2 * Math.PI
  if (d <= -Math.PI) d += 2 * Math.PI
  return d
}

/** Wheel delta in pixels (DOM deltaMode: 0 pixels, 1 lines, 2 pages). */
export function wheelPixels(deltaY: number, deltaMode: number): number {
  return deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 800 : deltaY
}

/** Multiplicative zoom factor for a wheel delta in pixels (positive = zoom out). */
export function wheelZoomFactor(pixels: number): number {
  return Math.exp(Math.max(-400, Math.min(400, pixels)) * 0.0015)
}

/**
 * Orthographic zoom about a fixed ground point p: the new target keeps p under the cursor when the
 * view height changes from h0 to h1.
 */
export function zoomAboutPoint(target: Vec2, p: Vec2, h0: number, h1: number): Vec2 {
  const k = h1 / h0
  return { x: p.x + (target.x - p.x) * k, z: p.z + (target.z - p.z) * k }
}
