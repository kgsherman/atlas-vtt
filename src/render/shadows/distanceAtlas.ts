/**
 * Octahedral linear-distance atlas (ARCHITECTURE §4.2), used for both point-light shadows (light atlas)
 * and viewer line of sight (viewer atlas).
 *
 * Capture of one tile:
 *  1. cube pass: THREE.CubeCamera renders the occluder proxies (one layer: LIGHT or SIGHT) BackSide
 *     into a WebGLCubeRenderTarget (R32F faces with depth, cleared to 1e6 by the proxy scene's
 *     background), writing the linear distance from the source; near 0.05 ft, far = capture range;
 *  2. re-encode pass: a full-screen triangle with viewport + scissor on the tile converts the cube to
 *     the octahedral layout (MIN of 4 taps per texel, guard ring through the octahedral wrap).
 * The tile records its capture origin and range; the shaders measure from that origin, so a moving
 * source lags (rather than breaks) until its tile is refreshed.
 */
import * as THREE from "three"

import type { DirtyRegion } from "@/core/occlusion/types"
import type { Vec3 } from "@/core/scene/types"
import { createFullscreenTriangle, EXCLUDE_NONE } from "../materials/occluderMaterials"
import { TileAllocator, type AtlasTile } from "./tileAllocator"

/** Near plane of the cube captures (feet). */
export const CAPTURE_NEAR = 0.05
/** Value a capture holds where no occluder was found. */
export const NO_OCCLUDER = 1e6
/** Source movement below this (feet) does not count as a move. */
export const MOVE_EPSILON = 0.01

export interface CaptureState {
  origin: Vec3
  far: number
  /** Invalidated by an occluder change since the capture. */
  dirty: boolean
}

export interface DistanceAtlasOptions {
  name: string
  width: number
  height: number
  tileSize: number
  cubeSize: number
}

export class DistanceAtlas {
  readonly target: THREE.WebGLRenderTarget
  readonly tiles: TileAllocator<CaptureState>
  readonly options: DistanceAtlasOptions
  /** At least one tile has been rendered since creation / reset (the render target is allocated). */
  captured = false
  private readonly cube: THREE.WebGLCubeRenderTarget
  private readonly cubeCamera: THREE.CubeCamera
  private readonly reencodeScene = new THREE.Scene()
  private readonly reencodeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly reencodeMesh: THREE.Mesh
  private readonly reencodeMaterial: THREE.ShaderMaterial

  constructor(options: DistanceAtlasOptions, reencodeMaterial: THREE.ShaderMaterial) {
    this.options = options
    this.target = new THREE.WebGLRenderTarget(options.width, options.height, {
      type: THREE.FloatType,
      format: THREE.RedFormat,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    })
    this.target.texture.name = `${options.name}-atlas`
    this.tiles = new TileAllocator<CaptureState>(options.width, options.height, options.tileSize)
    this.cube = new THREE.WebGLCubeRenderTarget(options.cubeSize, {
      type: THREE.FloatType,
      format: THREE.RedFormat,
      depthBuffer: true,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    })
    this.cube.texture.name = `${options.name}-cube`
    this.cubeCamera = new THREE.CubeCamera(CAPTURE_NEAR, 100, this.cube)
    this.cubeCamera.matrixWorldAutoUpdate = true
    this.reencodeMaterial = reencodeMaterial
    this.reencodeMesh = new THREE.Mesh(createFullscreenTriangle(), reencodeMaterial)
    this.reencodeMesh.frustumCulled = false
    this.reencodeScene.add(this.reencodeMesh)
    this.reencodeScene.matrixWorldAutoUpdate = false
  }

  get texture(): THREE.Texture {
    return this.target.texture
  }

  /** Whether a tile's capture is stale for a source now at `origin` with range `far`. */
  static moved(state: CaptureState | null, origin: Vec3, far: number): boolean {
    if (!state) return true
    const d = Math.hypot(state.origin.x - origin.x, state.origin.y - origin.y, state.origin.z - origin.z)
    return d > MOVE_EPSILON || Math.abs(state.far - far) > 1e-3
  }

  /**
   * Capture `tile` from `origin`. `layerMask` selects LIGHT or SIGHT proxies; `exclude` lists up to 4
   * numeric keys of primitives that contain the source. Leaves the renderer's render target changed:
   * the caller saves / restores renderer state around a batch of captures.
   */
  capture(
    renderer: THREE.WebGLRenderer,
    tile: AtlasTile<CaptureState>,
    origin: Vec3,
    far: number,
    layerMask: number,
    proxyScene: THREE.Scene,
    distanceMaterial: THREE.ShaderMaterial,
    exclude: readonly number[]
  ): void {
    const cam = this.cubeCamera
    cam.position.set(origin.x, origin.y, origin.z)
    cam.layers.mask = layerMask
    const range = Math.max(far, CAPTURE_NEAR * 4)
    for (const child of cam.children as THREE.PerspectiveCamera[]) {
      if (child.far !== range || child.near !== CAPTURE_NEAR) {
        child.near = CAPTURE_NEAR
        child.far = range
        child.updateProjectionMatrix()
      }
    }
    cam.updateMatrixWorld(true)

    const u = distanceMaterial.uniforms
    ;(u.uSource.value as THREE.Vector3).set(origin.x, origin.y, origin.z)
    ;(u.uExclude.value as THREE.Vector4).set(
      exclude[0] ?? EXCLUDE_NONE,
      exclude[1] ?? EXCLUDE_NONE,
      exclude[2] ?? EXCLUDE_NONE,
      exclude[3] ?? EXCLUDE_NONE
    )
    distanceMaterial.uniformsNeedUpdate = true
    // Proxies carry this material themselves; make sure no override from another pass is left behind.
    proxyScene.overrideMaterial = null
    cam.update(renderer, proxyScene)

    const t = this.target
    t.viewport.set(tile.x, tile.y, tile.size, tile.size)
    t.scissor.set(tile.x, tile.y, tile.size, tile.size)
    t.scissorTest = true
    renderer.setRenderTarget(t)
    const ru = this.reencodeMaterial.uniforms
    ru.uCube.value = this.cube.texture
    ;(ru.uTileOrigin.value as THREE.Vector2).set(tile.x, tile.y)
    ru.uTileSize.value = tile.size
    this.reencodeMaterial.uniformsNeedUpdate = true
    renderer.render(this.reencodeScene, this.reencodeCamera)

    tile.state = { origin: { x: origin.x, y: origin.y, z: origin.z }, far, dirty: false }
    this.captured = true
  }

  /** Mark tiles whose capture sphere intersects the region dirty. Returns how many were marked. */
  invalidateRegion(region: DirtyRegion): number {
    let n = 0
    for (const tile of this.tiles.owned()) {
      const s = tile.state
      if (!s || s.dirty) continue
      if (sphereIntersectsBox(s.origin, s.far, region.min, region.max)) {
        s.dirty = true
        n++
      }
    }
    return n
  }

  /** Every capture is stale (e.g. full scene rebuild). Tiles stay assigned and keep drawing until refreshed. */
  invalidateAll(): void {
    for (const tile of this.tiles.owned()) if (tile.state) tile.state.dirty = true
  }

  /** Drop every capture (context restored: the atlas contents are gone). */
  reset(): void {
    this.tiles.clear()
    this.captured = false
  }

  dispose(): void {
    this.target.dispose()
    this.cube.dispose()
    this.reencodeMesh.geometry.dispose()
  }
}

/** Closed sphere / AABB overlap. */
export function sphereIntersectsBox(c: Vec3, r: number, min: Vec3, max: Vec3): boolean {
  const dx = Math.max(min.x - c.x, 0, c.x - max.x)
  const dy = Math.max(min.y - c.y, 0, c.y - max.y)
  const dz = Math.max(min.z - c.z, 0, c.z - max.z)
  return dx * dx + dy * dy + dz * dz <= r * r
}
