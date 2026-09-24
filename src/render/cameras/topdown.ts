/**
 * Player 2.5D camera: orthographic, looking straight down, rotated in 90° steps. Input: right/middle-drag pans (the grabbed ground point stays under the cursor), the
 * wheel zooms about the cursor, WASD/arrow keys pan, two-finger touch pans and pinches. Left button
 * and single-finger touch are left to play controllers and tools.
 */
import * as THREE from "three"

import type { Vec2, Vec3 } from "@/core/scene/types"

import {
  angleDelta,
  boundsCenter,
  boundsDiagonal,
  damp,
  groundAxes,
  orthoFitViewHeight,
  wheelPixels,
  wheelZoomFactor,
  zoomAboutPoint,
  type Bounds3,
} from "./fit"
import { HeldPanKeys } from "./panKeys"
import type { CameraController } from "./types"

const LAMBDA = 12
const MIN_VIEW_HEIGHT = 12
const DRAG_THRESHOLD_PX = 4
export class TopDownCameraController implements CameraController {
  readonly kind = "topdown" as const
  readonly camera: THREE.OrthographicCamera
  enabled = true
  active = false
  /** Held WASD / arrow keys pan; set `panKeys.arrows = false` where arrows nudge (the editor). */
  readonly panKeys = new HeldPanKeys()

  private readonly dom: HTMLElement
  private target = new THREE.Vector3(60, 0, 60)
  private goal = new THREE.Vector3(60, 0, 60)
  private viewHeight = 80
  private goalViewHeight = 80
  private yaw = 0
  private goalYaw = 0
  private cssWidth = 1
  private cssHeight = 1
  private bounds: Bounds3 = { min: { x: 0, y: 0, z: 0 }, max: { x: 200, y: 10, z: 150 } }
  private drag: { pointerId: number; ground: THREE.Vector3; x: number; y: number; moved: boolean } | null = null
  private suppressContextMenu = false
  private touches = new Map<number, { x: number; y: number }>()
  private pinch: { dist: number; mid: { x: number; y: number } } | null = null
  private readonly raycaster = new THREE.Raycaster()
  private readonly listeners: [EventTarget, string, EventListener, AddEventListenerOptions?][] = []

  constructor(domElement: HTMLElement) {
    this.dom = domElement
    this.camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.1, 2000)
    this.listen(domElement, "pointerdown", this.onPointerDown as EventListener)
    this.listen(domElement, "pointermove", this.onPointerMove as EventListener)
    this.listen(domElement, "pointerup", this.onPointerUp as EventListener)
    this.listen(domElement, "pointercancel", this.onPointerUp as EventListener)
    this.listen(domElement, "wheel", this.onWheel as EventListener, { passive: false })
    this.listen(domElement, "contextmenu", this.onContextMenu as EventListener)
    this.listen(window, "keydown", this.onKeyDown as EventListener)
    this.listen(window, "keyup", this.onKeyUp as EventListener)
    this.listen(window, "blur", () => this.panKeys.clear())
    this.applyCamera()
  }

  private listen(t: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions): void {
    t.addEventListener(type, fn, opts)
    this.listeners.push([t, type, fn, opts])
  }

  private get interactive(): boolean {
    return this.enabled && this.active
  }

  setViewport(cssWidth: number, cssHeight: number): void {
    this.cssWidth = Math.max(1, cssWidth)
    this.cssHeight = Math.max(1, cssHeight)
    this.applyCamera()
  }

  setBounds(bounds: Bounds3): void {
    this.bounds = bounds
    this.clampGoal()
  }

  private maxViewHeight(): number {
    return Math.max(MIN_VIEW_HEIGHT * 2, boundsDiagonal(this.bounds) * 1.5)
  }

  private clampGoal(): void {
    const b = this.bounds
    const m = 20
    this.goal.x = Math.min(Math.max(this.goal.x, b.min.x - m), b.max.x + m)
    this.goal.z = Math.min(Math.max(this.goal.z, b.min.z - m), b.max.z + m)
    this.goalViewHeight = Math.min(Math.max(this.goalViewHeight, MIN_VIEW_HEIGHT), this.maxViewHeight())
  }

  update(dt: number): void {
    const dir = this.interactive ? this.panKeys.direction() : null
    if (dir) {
      const { right, up } = groundAxes(this.goalYaw)
      const speed = this.goalViewHeight * 0.9 * dt
      this.goal.x += (right.x * dir.x + up.x * dir.y) * speed
      this.goal.z += (right.z * dir.x + up.z * dir.y) * speed
      this.clampGoal()
    }
    this.target.set(damp(this.target.x, this.goal.x, LAMBDA, dt), damp(this.target.y, this.goal.y, LAMBDA, dt), damp(this.target.z, this.goal.z, LAMBDA, dt))
    this.viewHeight = damp(this.viewHeight, this.goalViewHeight, LAMBDA, dt)
    this.yaw = this.goalYaw + angleDelta(this.yaw, this.goalYaw) * Math.exp(-LAMBDA * dt)
    this.applyCamera()
  }

  private applyCamera(): void {
    const aspect = this.cssWidth / this.cssHeight
    const h = this.viewHeight / 2
    const cam = this.camera
    cam.left = -h * aspect
    cam.right = h * aspect
    cam.top = h
    cam.bottom = -h
    // Stand well above the highest geometry; the depth range covers the whole scene.
    const distance = Math.max(0, this.bounds.max.y - this.target.y) + 30
    cam.position.set(this.target.x, this.target.y + distance, this.target.z)
    const { up } = groundAxes(this.yaw)
    cam.up.set(up.x, 0, up.z)
    cam.lookAt(this.target)
    cam.near = 0.1
    cam.far = distance + boundsDiagonal(this.bounds) + (this.target.y - this.bounds.min.y) + 100
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
  }

  getTarget(): Vec3 {
    return { x: this.goal.x, y: this.goal.y, z: this.goal.z }
  }

  setTarget(p: Vec3, immediate: boolean): void {
    this.goal.set(p.x, p.y, p.z)
    this.clampGoal()
    if (immediate) {
      this.target.copy(this.goal)
      this.applyCamera()
    }
  }

  focus(point: Vec3, opts: { distance?: number; immediate?: boolean } = {}): void {
    if (opts.distance !== undefined) this.goalViewHeight = opts.distance
    this.setTarget(point, opts.immediate ?? false)
    if (opts.immediate) {
      this.viewHeight = this.goalViewHeight
      this.applyCamera()
    }
  }

  frame(bounds: Bounds3, immediate = false): void {
    this.bounds = bounds
    const c = boundsCenter(bounds)
    this.goalViewHeight = orthoFitViewHeight(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z, this.cssWidth / this.cssHeight, this.goalYaw, 1.08)
    this.goal.set(c.x, this.goal.y, c.z)
    this.clampGoal()
    if (immediate) {
      this.target.copy(this.goal)
      this.viewHeight = this.goalViewHeight
      this.applyCamera()
    }
  }

  rotate(quarterTurns: number): void {
    this.goalYaw += (quarterTurns * Math.PI) / 2
  }

  /** Current yaw (radians, animated). */
  getYaw(): number {
    return this.yaw
  }

  worldPerPixel(): number {
    return this.viewHeight / this.cssHeight
  }

  viewRadius(): number {
    return Math.max(30, this.viewHeight * 0.5 * Math.max(1, this.cssWidth / this.cssHeight) * 1.2)
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  /** Ground point (on the plane y = target.y) under a client position. */
  private groundAt(clientX: number, clientY: number): THREE.Vector3 | null {
    const rect = this.dom.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(ndc, this.camera)
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.target.y)
    return this.raycaster.ray.intersectPlane(plane, new THREE.Vector3())
  }

  private onPointerDown = (e: PointerEvent): void => {
    if (!this.interactive) return
    if (e.pointerType === "touch") {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (this.touches.size === 2) this.pinch = this.pinchState()
      return
    }
    if (e.button !== 1 && e.button !== 2) return
    const ground = this.groundAt(e.clientX, e.clientY)
    if (!ground) return
    this.drag = { pointerId: e.pointerId, ground, x: e.clientX, y: e.clientY, moved: false }
    this.suppressContextMenu = false
    this.dom.setPointerCapture?.(e.pointerId)
    if (e.button === 1) e.preventDefault()
  }

  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (this.touches.size === 2 && this.pinch && this.interactive) {
        const next = this.pinchState()
        if (next) {
          const before = this.groundAt(this.pinch.mid.x, this.pinch.mid.y)
          const after = this.groundAt(next.mid.x, next.mid.y)
          if (before && after) {
            this.goal.x += before.x - after.x
            this.goal.z += before.z - after.z
          }
          if (next.dist > 0 && this.pinch.dist > 0) this.goalViewHeight *= this.pinch.dist / next.dist
          this.clampGoal()
          this.pinch = next
        }
      }
      return
    }
    const d = this.drag
    if (!d || d.pointerId !== e.pointerId) return
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_THRESHOLD_PX) return
    d.moved = true
    const now = this.groundAt(e.clientX, e.clientY)
    if (!now) return
    // Keep the grabbed ground point under the cursor (no smoothing while dragging).
    this.goal.x += d.ground.x - now.x
    this.goal.z += d.ground.z - now.z
    this.clampGoal()
    this.target.x = this.goal.x
    this.target.z = this.goal.z
    this.applyCamera()
  }

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === "touch") {
      this.touches.delete(e.pointerId)
      if (this.touches.size < 2) this.pinch = null
      return
    }
    const d = this.drag
    if (!d || d.pointerId !== e.pointerId) return
    this.suppressContextMenu = d.moved
    this.drag = null
    this.dom.releasePointerCapture?.(e.pointerId)
  }

  private pinchState(): { dist: number; mid: { x: number; y: number } } | null {
    const pts = [...this.touches.values()]
    if (pts.length < 2) return null
    const [a, b] = pts
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
  }

  private onContextMenu = (e: Event): void => {
    // Only swallow the menu after a right-drag pan; plain right-clicks reach the app.
    if (this.suppressContextMenu || this.drag?.moved) e.preventDefault()
    this.suppressContextMenu = false
  }

  private onWheel = (e: WheelEvent): void => {
    if (!this.interactive) return
    e.preventDefault()
    const factor = wheelZoomFactor(wheelPixels(e.deltaY, e.deltaMode))
    const h0 = this.goalViewHeight
    const h1 = Math.min(Math.max(h0 * factor, MIN_VIEW_HEIGHT), this.maxViewHeight())
    const p = this.groundAt(e.clientX, e.clientY)
    if (p) {
      const t: Vec2 = zoomAboutPoint({ x: this.goal.x, z: this.goal.z }, { x: p.x, z: p.z }, h0, h1)
      this.goal.x = t.x
      this.goal.z = t.z
    }
    this.goalViewHeight = h1
    this.clampGoal()
  }

  private onKeyDown = (e: KeyboardEvent): void => this.panKeys.keyDown(e, this.interactive)

  private onKeyUp = (e: KeyboardEvent): void => this.panKeys.keyUp(e)

  dispose(): void {
    for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts)
    this.listeners.length = 0
    this.panKeys.clear()
  }
}
