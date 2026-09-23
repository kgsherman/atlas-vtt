/**
 * Anti-aliased screen-space dots for overlays (terrain shape vertices, the gizmo centre). The canvas has no
 * MSAA (engine.ts) and a world-space disc is squashed in oblique views, so each point is instead a quad
 * expanded in clip space around its projected centre to `uSize` CSS pixels (+ half a pixel per side), whose
 * radial coordinate fades over one pixel at the nominal rim with fwidth (aaLineMaterial's rule). An optional
 * outline ring (`outline` CSS px) keeps light dots readable over light fills. Sizes are constant in pixels
 * at every zoom; points behind the camera are not drawn.
 */
import * as THREE from "three"

export const AA_POINT_VERTEX = /* glsl */ `
// Quad corner (-1 / +1, -1 / +1).
attribute vec2 aCorner;
uniform vec4 uViewport;
uniform float uSize;
varying vec2 vPx;

void main() {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  if (clip.w <= 0.0) {
    // Behind a perspective camera: outside the clip volume.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vPx = vec2(0.0);
    return;
  }
  vec2 px = uViewport.zw * 0.5;
  float r = 0.5 * uSize + 0.5;
  clip.xy += aCorner * r / px * clip.w;
  // Physical pixels from the centre (linear: the four corners share w).
  vPx = aCorner * r;
  gl_Position = clip;
}
`

export const AA_POINT_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform vec3 uOutlineColor;
uniform float uOpacity;
uniform float uSize;
uniform float uOutline;
varying vec2 vPx;
void main() {
  float d = length(vPx);
  float w = max(fwidth(d), 1e-6);
  float r = 0.5 * uSize;
  float a = uOpacity * clamp((r + 0.5 - d) / w, 0.0, 1.0);
  if (a < 0.002) discard;
  // Outline ring: the inner disc fades into the outline colour over one pixel.
  float inner = clamp((r - uOutline + 0.5 - d) / w, 0.0, 1.0);
  gl_FragColor = vec4(mix(uOutlineColor, uColor, uOutline > 0.0 ? inner : 1.0), a);
  #include <colorspace_fragment>
}
`

export interface AAPointMaterialOptions {
  /** Dot diameter in CSS pixels (default 7). */
  size?: number
  opacity?: number
  /** Outline ring width in CSS pixels (default 0: none). */
  outline?: number
  outlineColor?: THREE.ColorRepresentation
  /** Default false: overlays draw through geometry. */
  depthTest?: boolean
}

const _viewport = new THREE.Vector4()

/** Transparent, unlit overlay material for aaPointGeometry. */
export function createAAPointMaterial(color: THREE.ColorRepresentation, opts: AAPointMaterialOptions = {}): THREE.ShaderMaterial {
  const uniforms = {
    uColor: { value: new THREE.Color(color) },
    uOutlineColor: { value: new THREE.Color(opts.outlineColor ?? "#09090b") },
    uOpacity: { value: opts.opacity ?? 1 },
    uSize: { value: opts.size ?? 7 },
    uOutline: { value: opts.outline ?? 0 },
    uViewport: { value: new THREE.Vector4(0, 0, 1, 1) },
  }
  const size = uniforms.uSize.value
  const outline = uniforms.uOutline.value
  const m = new THREE.ShaderMaterial({
    name: "atlas-overlay-aa-point",
    vertexShader: AA_POINT_VERTEX,
    fragmentShader: AA_POINT_FRAGMENT,
    uniforms,
    transparent: true,
    depthTest: opts.depthTest ?? false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  // The drawing-buffer viewport (physical pixels) of the pass being drawn, and the sizes scaled from CSS
  // pixels by the renderer's pixel ratio (as aaLineMaterial).
  m.onBeforeRender = (renderer) => {
    const r = renderer as Partial<THREE.WebGLRenderer>
    if (typeof r.getCurrentViewport === "function") uniforms.uViewport.value.copy(r.getCurrentViewport.call(renderer, _viewport))
    const ratio = typeof r.getPixelRatio === "function" ? r.getPixelRatio.call(renderer) : 1
    uniforms.uSize.value = size * ratio
    uniforms.uOutline.value = outline * ratio
    m.uniformsNeedUpdate = true
  }
  return m
}

const CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1]

/**
 * Quad geometry of points given as xyz triples: four vertices per point, all at the point (`position`, so
 * bounds and frustum tests stay right), with an `aCorner` attribute the shader expands them by.
 */
export function aaPointGeometry(points: ArrayLike<number>): THREE.BufferGeometry {
  const n = Math.floor(points.length / 3)
  const position = new Float32Array(n * 12)
  const corner = new Float32Array(n * 8)
  const index = new Uint32Array(n * 6)
  for (let k = 0; k < n; k++) {
    for (let v = 0; v < 4; v++) {
      const o = (k * 4 + v) * 3
      position[o] = points[k * 3]
      position[o + 1] = points[k * 3 + 1]
      position[o + 2] = points[k * 3 + 2]
    }
    corner.set(CORNERS, k * 8)
    const b = k * 4
    index.set([b, b + 1, b + 2, b, b + 2, b + 3], k * 6)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(position, 3))
  g.setAttribute("aCorner", new THREE.BufferAttribute(corner, 2))
  g.setIndex(new THREE.BufferAttribute(index, 1))
  return g
}
