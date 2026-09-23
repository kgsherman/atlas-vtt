/**
 * Post-processing for the medium, high and ultra tiers (ARCHITECTURE §10): the main pass renders into a
 * half-float MSAA target with a depth texture; then (ultra) screen-space ambient obscurance at half
 * resolution with a depth-aware blur, bloom (high / ultra: threshold → 6-level down/up chain) and a final
 * composite to the canvas (tone mapping, vignette, grain, dithering) that also writes the scene depth, so
 * overlays drawn afterwards are depth-tested against the world. Low renders straight to the canvas.
 *
 * The canvas has no MSAA (engine.ts): the scene target is the only MSAA, so it follows the tier at runtime.
 * Medium is the "lite" preset: MSAA + Reinhard (c / (1 + c), identical to three's ReinhardToneMapping at
 * exposure 1, which low uses in the materials) + sRGB + dither, without bloom, AO, vignette or grain.
 *
 * Fog awareness: the composite never adds bloom or grain onto pure-black pixels while `fog` is set
 * (player fog of war: unexplored stays black), AO and vignette only darken. Flames of unperceived
 * fixtures are transparent in the main pass, so they never reach the bloom chain.
 */
import * as THREE from "three"

import type { Quality } from "../contracts"
import { MSAA_SAMPLES } from "../engine/quality"
import { createFullscreenTriangle } from "../materials/occluderMaterials"
import { AO_BLUR_FRAGMENT, AO_FRAGMENT, BLOOM_DOWN_FRAGMENT, BLOOM_PREFILTER_FRAGMENT, BLOOM_UP_FRAGMENT, FULLSCREEN_VERTEX, OUTPUT_FRAGMENT } from "./shaders"

export interface PostSettings {
  /** MSAA samples of the HDR scene target. */
  samples: number
  bloom: { strength: number; threshold: number; knee: number } | null
  ao: { radius: number; intensity: number; strength: number } | null
  vignette: number
  grain: number
  tone: "reinhard" | "filmic"
  exposure: number
  /** Emissive scale of flames / glows in the HDR main pass, and the glow sprites' strength. */
  emissive: number
  glow: number
}

/** Direct-path (no post) flame / glow parameters; medium's lite post keeps the same look. */
export const DIRECT_EMISSIVE = { emissive: 1, glow: 0.55 }

/** Post-processing per tier; null = direct rendering to the canvas (tone mapping in the materials). */
export const POST_SETTINGS: Record<Quality, PostSettings | null> = {
  low: null,
  // Lite: only the MSAA target and the composite (tone mapping, sRGB, dither, scene depth for overlays).
  medium: {
    samples: MSAA_SAMPLES.medium,
    bloom: null,
    ao: null,
    vignette: 0,
    grain: 0,
    tone: "reinhard",
    exposure: 1,
    emissive: DIRECT_EMISSIVE.emissive,
    glow: DIRECT_EMISSIVE.glow,
  },
  high: {
    samples: MSAA_SAMPLES.high,
    bloom: { strength: 0.8, threshold: 1.5, knee: 0.6 },
    ao: null,
    vignette: 0.22,
    grain: 0,
    tone: "reinhard",
    exposure: 1,
    emissive: 2.8,
    glow: 0.35,
  },
  ultra: {
    samples: MSAA_SAMPLES.ultra,
    bloom: { strength: 0.85, threshold: 1.5, knee: 0.6 },
    ao: { radius: 3, intensity: 1.5, strength: 0.8 },
    vignette: 0.26,
    grain: 0.018,
    tone: "filmic",
    exposure: 1.08,
    emissive: 3,
    glow: 0.35,
  },
}

const BLOOM_LEVELS = 6

function passMaterial(fragmentShader: string, uniforms: Record<string, THREE.IUniform>, opts: Partial<THREE.ShaderMaterialParameters> = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: FULLSCREEN_VERTEX,
    fragmentShader,
    uniforms,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
    ...opts,
  })
}

function colorTarget(w: number, h: number, type: THREE.TextureDataType = THREE.HalfFloatType): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, {
    type,
    format: THREE.RGBAFormat,
    depthBuffer: false,
    stencilBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    colorSpace: THREE.NoColorSpace,
  })
}

export class PostPipeline {
  private readonly renderer: THREE.WebGLRenderer
  private settings: PostSettings
  private width = 0
  private height = 0
  private sceneTarget: THREE.WebGLRenderTarget | null = null
  private readonly bloomTargets: THREE.WebGLRenderTarget[] = []
  private aoTargets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null
  private readonly quad: THREE.Mesh
  private readonly quadScene = new THREE.Scene()
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly prefilter: THREE.ShaderMaterial
  private readonly down: THREE.ShaderMaterial
  private readonly up: THREE.ShaderMaterial
  private readonly aoMaterial: THREE.ShaderMaterial
  private readonly aoBlur: THREE.ShaderMaterial
  readonly output: THREE.ShaderMaterial
  private readonly black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
  private readonly white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)

  constructor(renderer: THREE.WebGLRenderer, settings: PostSettings) {
    this.renderer = renderer
    this.settings = settings
    this.black.needsUpdate = true
    this.white.needsUpdate = true
    this.prefilter = passMaterial(BLOOM_PREFILTER_FRAGMENT, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: new THREE.Vector4(1.6, 0.6, 64, 0) } })
    this.down = passMaterial(BLOOM_DOWN_FRAGMENT, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } })
    this.up = passMaterial(BLOOM_UP_FRAGMENT, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uWeight: { value: 1 } }, { blending: THREE.AdditiveBlending, transparent: true })
    this.aoMaterial = passMaterial(AO_FRAGMENT, {
      tDepth: { value: null },
      uProj: { value: new THREE.Matrix4() },
      uProjInv: { value: new THREE.Matrix4() },
      uAo: { value: new THREE.Vector4(3, 1, 0.05, 0) },
      uTexel: { value: new THREE.Vector2() },
    })
    this.aoBlur = passMaterial(AO_BLUR_FRAGMENT, { tAo: { value: null }, tDepth: { value: null }, uDir: { value: new THREE.Vector2() }, uNear: { value: new THREE.Vector2() } })
    this.output = passMaterial(
      OUTPUT_FRAGMENT,
      {
        tScene: { value: null },
        tBloom: { value: this.black },
        tAo: { value: this.white },
        tDepth: { value: null },
        uPost: { value: new THREE.Vector4() },
        uPost2: { value: new THREE.Vector4(1, 0, 0, 0) },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uDebug: { value: 0 },
      },
      // Writes gl_FragDepth for every pixel (depth test "always").
      { depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth }
    )
    this.quad = new THREE.Mesh(createFullscreenTriangle(), this.output)
    this.quad.frustumCulled = false
    this.quadScene.add(this.quad)
    this.quadScene.matrixWorldAutoUpdate = false
  }

  get current(): PostSettings {
    return this.settings
  }

  /** The HDR MSAA target the main pass renders into (allocated by setSize). */
  get target(): THREE.WebGLRenderTarget | null {
    return this.sceneTarget
  }

  configure(settings: PostSettings): void {
    const realloc = settings.samples !== this.settings.samples || !!settings.ao !== !!this.settings.ao || !!settings.bloom !== !!this.settings.bloom
    this.settings = settings
    if (realloc && this.width > 0) this.allocate(this.width, this.height, true)
  }

  /** Debug view: 0 = final, 1 = AO only, 2 = bloom only (tuning). */
  debugView = 0

  /** Drawing-buffer size in physical pixels. */
  setSize(width: number, height: number): void {
    this.allocate(width, height, false)
  }

  private allocate(width: number, height: number, force: boolean): void {
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    if (!force && w === this.width && h === this.height && this.sceneTarget) return
    this.width = w
    this.height = h
    this.disposeTargets()
    const depth = new THREE.DepthTexture(w, h, THREE.UnsignedIntType)
    depth.minFilter = THREE.NearestFilter
    depth.magFilter = THREE.NearestFilter
    // R11F_G11F_B10F: HDR at half the bandwidth of RGBA16F (the scene needs no alpha).
    const t = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedInt101111Type,
      format: THREE.RGBFormat,
      depthBuffer: true,
      stencilBuffer: false,
      samples: this.settings.samples,
      depthTexture: depth,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      colorSpace: THREE.NoColorSpace,
    })
    t.texture.name = "atlas-post-scene"
    this.sceneTarget = t
    if (this.settings.bloom) {
      let bw = Math.max(1, w >> 1)
      let bh = Math.max(1, h >> 1)
      for (let k = 0; k < BLOOM_LEVELS; k++) {
        const bt = colorTarget(bw, bh)
        bt.texture.name = `atlas-post-bloom-${k}`
        this.bloomTargets.push(bt)
        bw = Math.max(1, bw >> 1)
        bh = Math.max(1, bh >> 1)
      }
    }
    if (this.settings.ao) {
      const aw = Math.max(1, w >> 1)
      const ah = Math.max(1, h >> 1)
      this.aoTargets = [colorTarget(aw, ah, THREE.UnsignedByteType), colorTarget(aw, ah, THREE.UnsignedByteType)]
    }
  }

  private pass(material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null, clear = true): void {
    this.quad.material = material
    const r = this.renderer
    r.setRenderTarget(target)
    const auto = r.autoClear
    r.autoClear = clear
    r.render(this.quadScene, this.quadCamera)
    r.autoClear = auto
  }

  /**
   * After the main pass rendered into `target`: AO, bloom and the composite onto the canvas (render
   * target null). `fog` = player fog of war (bloom / grain gated off pure black).
   */
  finish(camera: THREE.Camera, fog: boolean, timeSec: number): void {
    const scene = this.sceneTarget
    if (!scene) return
    const s = this.settings
    const r = this.renderer
    const out = this.output.uniforms

    // Ambient obscurance (half resolution, blurred twice).
    if (s.ao && this.aoTargets && scene.depthTexture) {
      const [a, b] = this.aoTargets
      const u = this.aoMaterial.uniforms
      u.tDepth.value = scene.depthTexture
      ;(u.uProj.value as THREE.Matrix4).copy(camera.projectionMatrix)
      ;(u.uProjInv.value as THREE.Matrix4).copy(camera.projectionMatrixInverse)
      ;(u.uAo.value as THREE.Vector4).set(s.ao.radius, s.ao.intensity, 0.04, 0)
      ;(u.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height)
      this.pass(this.aoMaterial, a)
      const bu = this.aoBlur.uniforms
      bu.tDepth.value = scene.depthTexture
      bu.tAo.value = a.texture
      ;(bu.uDir.value as THREE.Vector2).set(1 / a.width, 0)
      this.pass(this.aoBlur, b)
      bu.tAo.value = b.texture
      ;(bu.uDir.value as THREE.Vector2).set(0, 1 / a.height)
      this.pass(this.aoBlur, a)
      out.tAo.value = a.texture
    } else {
      out.tAo.value = this.white
    }

    // Bloom chain.
    if (s.bloom && this.bloomTargets.length > 0) {
      const t = this.bloomTargets
      const pu = this.prefilter.uniforms
      pu.tSrc.value = scene.texture
      ;(pu.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height)
      ;(pu.uThreshold.value as THREE.Vector4).set(s.bloom.threshold, s.bloom.knee, 64, 0)
      this.pass(this.prefilter, t[0])
      const du = this.down.uniforms
      for (let k = 1; k < t.length; k++) {
        du.tSrc.value = t[k - 1].texture
        ;(du.uTexel.value as THREE.Vector2).set(1 / t[k - 1].width, 1 / t[k - 1].height)
        this.pass(this.down, t[k])
      }
      const uu = this.up.uniforms
      for (let k = t.length - 1; k > 0; k--) {
        uu.tSrc.value = t[k].texture
        ;(uu.uTexel.value as THREE.Vector2).set(1 / t[k].width, 1 / t[k].height)
        uu.uWeight.value = 1
        this.pass(this.up, t[k - 1], false)
      }
      out.tBloom.value = t[0].texture
    } else {
      out.tBloom.value = this.black
    }

    out.tScene.value = scene.texture
    out.tDepth.value = scene.depthTexture
    ;(out.uPost.value as THREE.Vector4).set(s.bloom ? s.bloom.strength / BLOOM_LEVELS : 0, s.ao ? s.ao.strength : 0, s.vignette, s.grain)
    ;(out.uPost2.value as THREE.Vector4).set(s.exposure, s.tone === "filmic" ? 1 : 0, fog ? 1 : 0, timeSec % 1000)
    ;(out.uResolution.value as THREE.Vector2).set(this.width, this.height)
    out.uDebug.value = this.debugView
    this.pass(this.output, null)
    r.setRenderTarget(null)
  }

  private disposeTargets(): void {
    this.sceneTarget?.depthTexture?.dispose()
    this.sceneTarget?.dispose()
    this.sceneTarget = null
    for (const t of this.bloomTargets) t.dispose()
    this.bloomTargets.length = 0
    if (this.aoTargets) for (const t of this.aoTargets) t.dispose()
    this.aoTargets = null
  }

  dispose(): void {
    this.disposeTargets()
    for (const m of [this.prefilter, this.down, this.up, this.aoMaterial, this.aoBlur, this.output]) m.dispose()
    this.quad.geometry.dispose()
    this.black.dispose()
    this.white.dispose()
  }
}
