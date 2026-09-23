/**
 * Static cached directional depth maps (ARCHITECTURE §4.2): the sun/moon shadow map (2048²) and the
 * sky-exposure map (straight down). Orthographic over the scene bounds, rendered from the LIGHT-layer
 * occluder proxies BackSide, re-rendered only when occluders, bounds or the direction change. Sampled
 * with hardware PCF (DepthTexture + compareFunction → sampler2DShadow).
 *
 * The shader matrix is computed here with a standard (non-reversed) projection; when the renderer uses a
 * reversed depth buffer the shader compares 1 − depth with GreaterEqual instead (uSunParams.z).
 */
import * as THREE from "three"

export interface DirectionalFrame {
  position: THREE.Vector3
  target: THREE.Vector3
  up: THREE.Vector3
  left: number
  right: number
  bottom: number
  top: number
  near: number
  far: number
  /** World → [0, 1]³ (u, v, standard depth). */
  matrix: THREE.Matrix4
}

const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1)

/** Fit an orthographic light frame around `bounds` looking along −dirToLight. */
export function fitDirectionalFrame(bounds: THREE.Box3, dirToLight: THREE.Vector3, pad = 1): DirectionalFrame {
  const dir = dirToLight.clone().normalize()
  const center = bounds.getCenter(new THREE.Vector3())
  const radius = bounds.getSize(new THREE.Vector3()).length() / 2 + pad
  const position = center.clone().addScaledVector(dir, radius + 10)
  const up = Math.abs(dir.y) > 0.99 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0)
  const view = new THREE.Matrix4().lookAt(position, center, up)
  view.setPosition(position)
  const viewInverse = view.clone().invert()
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  const p = new THREE.Vector3()
  for (let k = 0; k < 8; k++) {
    p.set(k & 1 ? bounds.max.x : bounds.min.x, k & 2 ? bounds.max.y : bounds.min.y, k & 4 ? bounds.max.z : bounds.min.z).applyMatrix4(viewInverse)
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    minZ = Math.min(minZ, p.z)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
    maxZ = Math.max(maxZ, p.z)
  }
  const left = minX - pad
  const right = maxX + pad
  const bottom = minY - pad
  const top = maxY + pad
  // The camera looks down −Z: distances along the view are −z.
  const near = Math.max(0.01, -maxZ - pad)
  const far = -minZ + pad
  const projection = new THREE.Matrix4().makeOrthographic(left, right, top, bottom, near, far, THREE.WebGLCoordinateSystem, false)
  const matrix = BIAS.clone().multiply(projection).multiply(viewInverse)
  return { position, target: center, up, left, right, bottom, top, near, far, matrix }
}

export class DirectionalShadowMap {
  readonly target: THREE.WebGLRenderTarget
  readonly camera = new THREE.OrthographicCamera()
  readonly matrix = new THREE.Matrix4()
  readonly size: number
  /** World size of one texel (max of both axes), for the receiver normal offset. */
  texelWorld = 1
  /** Depth range of the frame (feet), to convert a bias in feet to depth units. */
  depthRange = 1

  constructor(size: number, name: string) {
    this.size = size
    const depthTexture = new THREE.DepthTexture(size, size, THREE.UnsignedIntType)
    depthTexture.minFilter = THREE.LinearFilter
    depthTexture.magFilter = THREE.LinearFilter
    depthTexture.compareFunction = THREE.LessEqualCompare
    depthTexture.name = `${name}-depth`
    this.target = new THREE.WebGLRenderTarget(size, size, {
      depthTexture,
      depthBuffer: true,
      stencilBuffer: false,
      format: THREE.RedFormat,
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    })
    this.target.texture.name = name
    this.camera.matrixAutoUpdate = true
  }

  get depthTexture(): THREE.DepthTexture {
    return this.target.depthTexture!
  }

  /**
   * Render the occluder proxies (layer mask `layerMask`) with the depth-only material. Changes the
   * renderer's render target; the caller restores it.
   */
  render(
    renderer: THREE.WebGLRenderer,
    proxyScene: THREE.Scene,
    depthMaterial: THREE.Material,
    bounds: THREE.Box3,
    dirToLight: THREE.Vector3,
    layerMask: number
  ): void {
    const f = fitDirectionalFrame(bounds, dirToLight)
    const cam = this.camera
    cam.left = f.left
    cam.right = f.right
    cam.top = f.top
    cam.bottom = f.bottom
    cam.near = f.near
    cam.far = f.far
    cam.position.copy(f.position)
    cam.up.copy(f.up)
    cam.lookAt(f.target)
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld(true)
    cam.layers.mask = layerMask
    this.matrix.copy(f.matrix)
    this.texelWorld = Math.max(f.right - f.left, f.top - f.bottom) / this.size
    this.depthRange = f.far - f.near

    const reversed = renderer.state.buffers.depth.getReversed()
    const compare = reversed ? THREE.GreaterEqualCompare : THREE.LessEqualCompare
    if (this.depthTexture.compareFunction !== compare) {
      this.depthTexture.compareFunction = compare
      this.depthTexture.needsUpdate = true
    }

    proxyScene.overrideMaterial = depthMaterial
    renderer.setRenderTarget(this.target)
    try {
      renderer.render(proxyScene, cam)
    } finally {
      proxyScene.overrideMaterial = null
    }
  }

  dispose(): void {
    this.target.depthTexture?.dispose()
    this.target.dispose()
  }
}
