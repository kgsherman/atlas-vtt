/**
 * Editor camera: perspective orbit around a target (three's OrbitControls). Left button is left to
 * the editor tools; right-drag orbits, middle-drag pans parallel to the ground, the wheel dollies
 * toward the cursor. Two-finger touch pans/zooms. near = 0.5 ft, far = 4 × scene diagonal.
 */
import * as THREE from "three"
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js"

import type { Vec3 } from "@/core/scene/types"

import { angleDelta, boundsCenter, boundsDiagonal, damp, perspectiveFitBoxDistance, perspectiveFitDistance, type Bounds3 } from "./fit"
import type { CameraController } from "./types"

const FOV = 50
const ANIM_LAMBDA = 10

export class OrbitCameraController implements CameraController {
  readonly kind = "orbit" as const
  readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private _enabled = true
  private _active = false
  private goalTarget: THREE.Vector3 | null = null
  private goalDistance: number | null = null
  private goalAzimuth: number | null = null
  private cssHeight = 1
  /** Where OrbitControls registered its capture-phase key listeners (the document while attached). */
  private readonly keyRoot: Node

  constructor(domElement: HTMLElement) {
    this.keyRoot = domElement.getRootNode()
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 4000)
    this.camera.position.set(60, 80, 140)
    this.controls = new OrbitControls(this.camera, domElement)
    const c = this.controls
    c.enableDamping = true
    c.dampingFactor = 0.15
    c.screenSpacePanning = false
    c.zoomToCursor = true
    c.maxPolarAngle = Math.PI * 0.495
    c.minDistance = 2
    c.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
    c.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_PAN }
    c.target.set(60, 0, 60)
    // Any user interaction cancels programmatic camera animations.
    c.addEventListener("start", () => {
      this.goalTarget = null
      this.goalDistance = null
      this.goalAzimuth = null
    })
    this.syncEnabled()
    c.update()
  }

  get enabled(): boolean {
    return this._enabled
  }

  set enabled(v: boolean) {
    this._enabled = v
    this.syncEnabled()
  }

  get active(): boolean {
    return this._active
  }

  set active(v: boolean) {
    this._active = v
    this.syncEnabled()
  }

  private syncEnabled(): void {
    this.controls.enabled = this._enabled && this._active
  }

  setViewport(cssWidth: number, cssHeight: number): void {
    this.cssHeight = Math.max(1, cssHeight)
    this.camera.aspect = Math.max(1, cssWidth) / this.cssHeight
    this.camera.updateProjectionMatrix()
  }

  setBounds(bounds: Bounds3): void {
    const diag = Math.max(50, boundsDiagonal(bounds))
    this.camera.near = 0.5
    this.camera.far = 4 * diag
    this.controls.maxDistance = 2 * diag
    this.camera.updateProjectionMatrix()
  }

  update(dt: number): void {
    const c = this.controls
    if (this.goalTarget || this.goalDistance !== null || this.goalAzimuth !== null) {
      const offset = this.camera.position.clone().sub(c.target)
      const sph = new THREE.Spherical().setFromVector3(offset)
      if (this.goalTarget) {
        c.target.set(
          damp(c.target.x, this.goalTarget.x, ANIM_LAMBDA, dt),
          damp(c.target.y, this.goalTarget.y, ANIM_LAMBDA, dt),
          damp(c.target.z, this.goalTarget.z, ANIM_LAMBDA, dt)
        )
        if (c.target.distanceTo(this.goalTarget) < 0.01) {
          c.target.copy(this.goalTarget)
          this.goalTarget = null
        }
      }
      if (this.goalDistance !== null) {
        sph.radius = damp(sph.radius, this.goalDistance, ANIM_LAMBDA, dt)
        if (Math.abs(sph.radius - this.goalDistance) < 0.01) {
          sph.radius = this.goalDistance
          this.goalDistance = null
        }
      }
      if (this.goalAzimuth !== null) {
        // Shortest way round: spherical theta is in (−π, π], goals accumulate quarter turns.
        const d = angleDelta(sph.theta, this.goalAzimuth) * Math.exp(-ANIM_LAMBDA * dt)
        sph.theta = this.goalAzimuth + d
        if (Math.abs(d) < 1e-3) {
          sph.theta = this.goalAzimuth
          this.goalAzimuth = null
        }
      }
      this.camera.position.copy(c.target).add(new THREE.Vector3().setFromSpherical(sph))
    }
    c.update(dt)
    this.camera.updateMatrixWorld()
  }

  getTarget(): Vec3 {
    const t = this.goalTarget ?? this.controls.target
    return { x: t.x, y: t.y, z: t.z }
  }

  setTarget(p: Vec3, immediate: boolean): void {
    const goal = new THREE.Vector3(p.x, p.y, p.z)
    if (immediate) {
      const offset = this.camera.position.clone().sub(this.controls.target)
      this.controls.target.copy(goal)
      this.camera.position.copy(goal).add(offset)
      this.goalTarget = null
      this.controls.update()
    } else {
      this.goalTarget = goal
    }
  }

  focus(point: Vec3, opts: { distance?: number; immediate?: boolean } = {}): void {
    this.setTarget(point, opts.immediate ?? false)
    if (opts.distance !== undefined) {
      const d = Math.max(this.controls.minDistance, opts.distance)
      if (opts.immediate) {
        const dir = this.camera.position.clone().sub(this.controls.target).normalize()
        this.camera.position.copy(this.controls.target).addScaledVector(dir, d)
        this.controls.update()
      } else this.goalDistance = d
    }
  }

  frame(bounds: Bounds3, immediate = false): void {
    const center = boundsCenter(bounds)
    const target = { x: center.x, y: bounds.min.y + Math.min(2, bounds.max.y - bounds.min.y), z: center.z }
    // A pleasant default angle when framing from scratch: from the south, slightly east (depth cues on
    // the walls), ~48° above the horizon, so a rectangular map fills the screen instead of standing on a
    // corner; otherwise keep the current viewing direction.
    const dir = immediate ? new THREE.Vector3(0.28, 1.15, 1.0).normalize() : this.camera.position.clone().sub(this.controls.target).normalize()
    const fovY = THREE.MathUtils.degToRad(FOV)
    // Fit the box's corners (tighter than its bounding sphere), never closer than the sphere-based
    // distance halved, so very flat scenes still keep some context.
    const sphere = perspectiveFitDistance(boundsDiagonal(bounds) / 2, fovY, this.camera.aspect, 1.05)
    const distance = Math.max(perspectiveFitBoxDistance(bounds, target, { x: dir.x, y: dir.y, z: dir.z }, fovY, this.camera.aspect, 1.06), sphere * 0.5)
    if (immediate) {
      this.controls.target.set(target.x, target.y, target.z)
      this.camera.position.set(target.x, target.y, target.z).addScaledVector(dir, distance)
      this.goalTarget = null
      this.goalDistance = null
      this.controls.update()
    } else {
      this.focus(target, { distance })
    }
  }

  /**
   * Place the camera around the current target at a compass azimuth (0 = from +Z, π/2 = from +X) and an
   * elevation above the horizon, keeping the distance (clamped to the controls' polar limit).
   */
  setAngles(azimuth: number, elevation: number): void {
    const c = this.controls
    const d = Math.max(c.minDistance, this.camera.position.distanceTo(c.target))
    const minEl = Math.PI / 2 - c.maxPolarAngle
    const el = Math.min(Math.max(elevation, minEl), Math.PI / 2 - 1e-3)
    this.camera.position.set(c.target.x + d * Math.cos(el) * Math.sin(azimuth), c.target.y + d * Math.sin(el), c.target.z + d * Math.cos(el) * Math.cos(azimuth))
    this.goalAzimuth = null
    this.goalDistance = null
    c.update()
    this.camera.updateMatrixWorld()
  }

  rotate(quarterTurns: number): void {
    const offset = this.camera.position.clone().sub(this.controls.target)
    const sph = new THREE.Spherical().setFromVector3(offset)
    this.goalAzimuth = (this.goalAzimuth ?? sph.theta) + (quarterTurns * Math.PI) / 2
  }

  worldPerPixel(): number {
    const d = this.camera.position.distanceTo(this.controls.target)
    return (2 * d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)) / this.cssHeight
  }

  viewRadius(): number {
    return Math.max(40, this.camera.position.distanceTo(this.controls.target) * 1.6)
  }

  dispose(): void {
    this.controls.dispose()
    // three's OrbitControls.disconnect() removes its capture-phase key listeners from
    // domElement.getRootNode(), which is no longer the document once the canvas has been detached, and
    // React removes the DOM before running effect cleanups. The listeners left on the document keep the
    // controls, the canvas and the whole WebGL context reachable, so remove them from the recorded root.
    const c = this.controls as unknown as { _interceptControlDown?: EventListener; _interceptControlUp?: EventListener }
    if (c._interceptControlDown) this.keyRoot.removeEventListener("keydown", c._interceptControlDown, { capture: true })
    if (c._interceptControlUp) this.keyRoot.removeEventListener("keyup", c._interceptControlUp, { capture: true })
  }
}
