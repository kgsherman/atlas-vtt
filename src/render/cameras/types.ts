import type * as THREE from "three"

import type { Vec3 } from "@/core/scene/types"

import type { CameraKind } from "../contracts"
import type { Bounds3 } from "./fit"

/** Common interface of the editor orbit camera and the player 2.5D camera. */
export interface CameraController {
  readonly kind: CameraKind
  readonly camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
  /** Input handling on/off (tools may need exclusive pointer). */
  enabled: boolean
  /** Only the active controller listens to input. */
  active: boolean
  setViewport(cssWidth: number, cssHeight: number): void
  setBounds(bounds: Bounds3): void
  /** Advance animations and input; updates the camera matrices. */
  update(dt: number): void
  getTarget(): Vec3
  /** Move the look-at point (immediate or animated). */
  setTarget(p: Vec3, immediate: boolean): void
  focus(point: Vec3, opts?: { distance?: number; immediate?: boolean }): void
  frame(bounds: Bounds3, immediate?: boolean): void
  rotate(quarterTurns: number): void
  /** World units per CSS pixel at the target (overlay sizing, grid fade). */
  worldPerPixel(): number
  /** Distance scale for fading overlays (grid) around the target. */
  viewRadius(): number
  dispose(): void
}
