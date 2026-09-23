/**
 * Test helpers for the editor: a small two-level fixture scene, a store without a system clipboard,
 * builders for synthetic ToolPointerEvents and synthetic cameras (orthographic / perspective projectors
 * with pointer rays, the frame of ToolDeps.project and ToolPointerEvent.canvasX/Y).
 */
import { matchesKeyboardEvent } from "@tanstack/hotkeys"

import { createConnector, createDoor, createFloor, createLevel, createScene, createWall, createWindow } from "@/core/scene/factory"
import type { Id, Scene, SceneObject, Vec2, Vec3 } from "@/core/scene/types"
import type { KeyOverrides } from "@/lib/keymap"

import type { EditorController } from "./controller"
import { editorBindings, type ShortcutAction } from "./shortcuts"
import { createEditorStore, type CreateEditorStoreOptions } from "./store"
import type { ToolKeyEvent, ToolPointerEvent } from "./tools/types"

export interface Fixture {
  scene: Scene
  groundId: Id
  upperId: Id
  /** Ground-level wall (10,10)→(30,10) with a door at offset 5 and a window at offset 14. */
  wallId: Id
  doorId: Id
  windowId: Id
  /** Stairs from ground to upper at x 40..50, z 40..60. */
  stairsId: Id
}

/** 20×20-cell scene: "ground" (elevation 0, full floor) and "upper" (elevation 10, full floor). */
export function fixtureScene(): Fixture {
  const scene = createScene({ width: 20, depth: 20 })
  const groundId = Object.keys(scene.levels)[0]
  const upper = createLevel({ id: "upper", name: "Upper", elevation: 10 })
  scene.levels[upper.id] = upper
  const add = <T extends SceneObject>(o: T): T => {
    scene.objects[o.id] = o
    return o
  }
  add(createFloor(upper.id, { x: 0, z: 0, w: 100, d: 100 }, "wood"))
  const wall = add(createWall(groundId, { x: 10, z: 10 }, { x: 30, z: 10 }))
  const door = add(createDoor(wall, 5))
  const win = add(createWindow(wall, 14))
  const stairs = add(createConnector(groundId, upper.id, { x: 40, z: 40, w: 10, d: 20 }, 0))
  return { scene, groundId, upperId: upper.id, wallId: wall.id, doorId: door.id, windowId: win.id, stairsId: stairs.id }
}

export function makeStore(scene?: Scene, opts: Omit<CreateEditorStoreOptions, "scene"> = {}) {
  return createEditorStore({ systemClipboard: null, ...opts, scene: scene ?? fixtureScene().scene })
}

export interface PointerInit {
  ground?: Vec2 | null
  /** World height of the ground pick (default 0). */
  groundY?: number
  objectId?: Id | null
  tokenId?: Id | null
  hitPoint?: Vec3 | null
  button?: number
  shift?: boolean
  alt?: boolean
  ctrl?: boolean
  clientX?: number
  clientY?: number
  canvasX?: number
  canvasY?: number
  buttons?: number
  ray?: { origin: Vec3; direction: Vec3 } | null
}

/**
 * A synthetic ToolPointerEvent. clientX/clientY default to the ground point scaled by 10 px/ft so
 * pixel-distance thresholds behave like a real canvas.
 */
export function pointer(init: PointerInit = {}): ToolPointerEvent {
  const ground = init.ground === undefined ? null : init.ground
  const e: ToolPointerEvent = {
    pick: {
      ground: ground ? { x: ground.x, y: init.groundY ?? 0, z: ground.z } : null,
      objectId: init.objectId ?? null,
      tokenId: init.tokenId ?? null,
      hitPoint: init.hitPoint ?? null,
    },
    snapped: ground,
    ground,
    button: init.button ?? 0,
    shift: init.shift ?? false,
    alt: init.alt ?? false,
    ctrl: init.ctrl ?? false,
    clientX: init.clientX ?? (ground ? ground.x * 10 : 0),
    clientY: init.clientY ?? (ground ? ground.z * 10 : 0),
  }
  if (init.ray !== undefined) e.pick.ray = init.ray
  if (init.canvasX !== undefined) e.canvasX = init.canvasX
  if (init.canvasY !== undefined) e.canvasY = init.canvasY
  if (init.buttons !== undefined) e.buttons = init.buttons
  return e
}

export const at = (x: number, z: number, init: Omit<PointerInit, "ground"> = {}) => pointer({ ...init, ground: { x, z } })

/** A key event as the controller passes it to a tool (`action`: the keymap action bound to the key, if any). */
export const key = (k: string, mods: { shift?: boolean; alt?: boolean; ctrl?: boolean; action?: ShortcutAction } = {}): ToolKeyEvent => {
  const e: ToolKeyEvent = { key: k, shift: mods.shift ?? false, alt: mods.alt ?? false, ctrl: mods.ctrl ?? false }
  if (mods.action) e.action = mods.action
  return e
}

/**
 * A key press as the app delivers it: TanStack Hotkeys matches the event against the editor bindings
 * (Linux platform: Mod = Ctrl) and the controller gets the bound action. Returns whether the key was
 * consumed; false also when nothing is bound to it. Needs a DOM (KeyboardEvent): jsdom tests only.
 */
export function pressKey(
  controller: EditorController,
  k: string,
  mods: { shift?: boolean; alt?: boolean; ctrl?: boolean } = {},
  overrides?: KeyOverrides
): boolean {
  const e = key(k, mods)
  const event = new KeyboardEvent("keydown", { key: k, shiftKey: e.shift, altKey: e.alt, ctrlKey: e.ctrl })
  const binding = editorBindings(overrides).find((b) => matchesKeyboardEvent(event, b.hotkey, "linux"))
  return binding ? controller.keyDown(e, binding.action) : false
}

// ---------------------------------------------------------------------------
// Synthetic cameras: projector + pointer rays (no WebGL)
// ---------------------------------------------------------------------------

export interface TestCamera {
  width: number
  height: number
  /** World → canvas CSS px (y down), like Engine.project; `visible` false behind the camera. */
  project(p: Vec3): { x: number; y: number; visible: boolean }
  /** The pointer ray (unit direction) through canvas pixel (x, y), like PickResult.ray. */
  ray(x: number, y: number): { origin: Vec3; direction: Vec3 }
}

export interface CameraOptions {
  /** World point at the canvas centre (default (50, 0, 50): the middle of a 20×20-cell scene). */
  target?: Vec3
  /** Tilt from straight down, degrees (0 = top-down; the camera sits on the +Z side, looking toward −Z). */
  tilt?: number
  /** Turn of the view about +Y, degrees (0: screen up = −Z, screen right = +X). */
  yaw?: number
  width?: number
  height?: number
}

const dot3 = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z
const add3 = (a: Vec3, b: Vec3, s = 1): Vec3 => ({ x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s })

/** Camera basis: forward (view direction), right and up (screen axes), all unit. */
function cameraBasis(tiltDeg: number, yawDeg: number): { f: Vec3; r: Vec3; u: Vec3 } {
  const t = (tiltDeg * Math.PI) / 180
  const y = (yawDeg * Math.PI) / 180
  const rot = (v: Vec3): Vec3 => ({ x: v.x * Math.cos(y) - v.z * Math.sin(y), y: v.y, z: v.x * Math.sin(y) + v.z * Math.cos(y) })
  return {
    f: rot({ x: 0, y: -Math.cos(t), z: -Math.sin(t) }),
    r: rot({ x: 1, y: 0, z: 0 }),
    u: rot({ x: 0, y: Math.sin(t), z: -Math.cos(t) }),
  }
}

/** Orthographic camera (like the top-down camera): `scale` px per foot. */
export function orthoCamera(opts: CameraOptions & { scale?: number } = {}): TestCamera {
  const { f, r, u } = cameraBasis(opts.tilt ?? 0, opts.yaw ?? 0)
  const T = opts.target ?? { x: 50, y: 0, z: 50 }
  const W = opts.width ?? 1000
  const H = opts.height ?? 800
  const s = opts.scale ?? 10
  return {
    width: W,
    height: H,
    project(p) {
      const d = add3(p, T, -1)
      return { x: W / 2 + s * dot3(d, r), y: H / 2 - s * dot3(d, u), visible: true }
    },
    ray(x, y) {
      const onPlane = add3(add3(T, r, (x - W / 2) / s), u, (H / 2 - y) / s)
      return { origin: add3(onPlane, f, -1000), direction: { ...f } }
    },
  }
}

/** Perspective camera (like the orbit camera) `distance` feet from the target, vertical field of view `fov`°. */
export function perspectiveCamera(opts: CameraOptions & { distance?: number; fov?: number } = {}): TestCamera {
  const { f, r, u } = cameraBasis(opts.tilt ?? 45, opts.yaw ?? 0)
  const T = opts.target ?? { x: 50, y: 0, z: 50 }
  const W = opts.width ?? 1000
  const H = opts.height ?? 800
  const C = add3(T, f, -(opts.distance ?? 120))
  const focal = H / 2 / Math.tan(((opts.fov ?? 50) * Math.PI) / 360)
  return {
    width: W,
    height: H,
    project(p) {
      const d = add3(p, C, -1)
      const z = dot3(d, f)
      if (z <= 0.01) return { x: 0, y: 0, visible: false }
      return { x: W / 2 + (focal * dot3(d, r)) / z, y: H / 2 - (focal * dot3(d, u)) / z, visible: true }
    },
    ray(x, y) {
      const d = add3(add3(f, r, (x - W / 2) / focal), u, (H / 2 - y) / focal)
      const len = Math.sqrt(dot3(d, d))
      return { origin: { ...C }, direction: { x: d.x / len, y: d.y / len, z: d.z / len } }
    },
  }
}

export interface ScreenPointerInit extends Omit<PointerInit, "ground" | "groundY" | "ray" | "canvasX" | "canvasY" | "clientX" | "clientY"> {
  /**
   * The ground the pick hits: a world height (default 0) or a height function of (x, z) marched along the
   * ray (e.g. the level's baked terrain); null = no ground (off the level).
   */
  groundY?: number | ((x: number, z: number) => number) | null
}

/** Where a ray meets the ground (plane, or a height function marched in 0.1 ft steps and refined). */
function rayGround(ray: { origin: Vec3; direction: Vec3 }, groundY: number | ((x: number, z: number) => number)): Vec3 | null {
  const { origin: o, direction: d } = ray
  if (typeof groundY === "number") {
    if (Math.abs(d.y) < 1e-9) return null
    const t = (groundY - o.y) / d.y
    return t >= 0 ? add3(o, d, t) : null
  }
  const above = (t: number) => {
    const p = add3(o, d, t)
    return p.y - groundY(p.x, p.z)
  }
  let prev = 0
  for (let t = 0.1; t < 5000; t += 0.1) {
    if (above(t) > 0) {
      prev = t
      continue
    }
    let lo = prev
    let hi = t
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2
      if (above(mid) > 0) lo = mid
      else hi = mid
    }
    return add3(o, d, hi)
  }
  return null
}

/**
 * A pointer event at canvas pixel (x, y) seen through `camera`: the pointer ray, canvas (= client)
 * coordinates, and the ground pick where the ray meets the ground (see ScreenPointerInit.groundY).
 */
export function screenPointer(camera: TestCamera, x: number, y: number, init: ScreenPointerInit = {}): ToolPointerEvent {
  const ray = camera.ray(x, y)
  const hit = init.groundY === null ? null : rayGround(ray, init.groundY ?? 0)
  const e = pointer({ ...init, ground: hit ? { x: hit.x, z: hit.z } : null, groundY: hit?.y, ray, canvasX: x, canvasY: y, clientX: x, clientY: y })
  return e
}

/** A pointer event over world point `p` (projected through the camera). */
export function worldPointer(camera: TestCamera, p: Vec3, init: ScreenPointerInit = {}): ToolPointerEvent {
  const q = camera.project(p)
  return screenPointer(camera, q.x, q.y, init)
}
