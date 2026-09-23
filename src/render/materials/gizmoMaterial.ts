/**
 * Translate-gizmo arrows (terrain editing overlay) drawn in screen space so they match the tool's hit test
 * exactly (core/geometry/gizmo gizmoHandles: a shaft from GIZMO_SHAFT_START_PX to GIZMO_SHAFT_END_PX CSS px
 * along the axis' projected direction). One quad per axis around the mesh's origin (the gizmo centre):
 * the vertex shader projects the origin and offsets the corners by `aOffset` CSS pixels in the frame of
 * `uDir`, the axis' screen direction that the overlay copies from gizmoHandles every frame. The fragment
 * shader draws a capsule shaft and a triangular head as a signed distance in CSS pixels, anti-aliased
 * over one physical pixel (the canvas has no MSAA), with a faint dark halo for contrast. Constant screen
 * size at every zoom, no per-frame geometry.
 */
import * as THREE from "three"

import { GIZMO_SHAFT_END_PX, GIZMO_SHAFT_START_PX } from "@/core/geometry/gizmo"

export const GIZMO_ARROW_VERTEX = /* glsl */ `
// CSS px in the axis frame: x along the axis' screen direction, y across it.
attribute vec2 aOffset;
uniform vec4 uViewport;
uniform float uPixelRatio;
// Unit screen direction of the axis (CSS px, y down: gizmoHandles' dir).
uniform vec2 uDir;
varying vec2 vLocal;

void main() {
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  vec2 d = vec2(uDir.x, -uDir.y);
  vec2 n = vec2(-d.y, d.x);
  vec2 off = (d * aOffset.x + n * aOffset.y) * uPixelRatio;
  clip.xy += off / (uViewport.zw * 0.5) * clip.w;
  vLocal = aOffset;
  gl_Position = clip;
}
`

export const GIZMO_ARROW_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
// x: shaft start, y: tip, z: head length, w: head half-width (CSS px).
uniform vec4 uArrow;
uniform float uShaftHalf;
varying vec2 vLocal;

// Signed distance to the segment a-b thickened by r.
float atSdCapsule(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// Signed distance (mitred outside the corners) to the head: base at x = b, apex (t, 0), half-width w.
float atSdHead(vec2 p, float b, float t, float w) {
  vec2 n = normalize(vec2(w, t - b));
  return max(b - p.x, dot(vec2(p.x - t, abs(p.y)), n));
}

void main() {
  float base = uArrow.y - uArrow.z;
  float sd = min(atSdCapsule(vLocal, vec2(uArrow.x + uShaftHalf, 0.0), vec2(base + 1.0, 0.0), uShaftHalf), atSdHead(vLocal, base, uArrow.y, uArrow.w));
  // CSS px per physical pixel (the local frame is a scaled rotation of the screen).
  float px = max(length(vec2(dFdx(vLocal.x), dFdy(vLocal.x))), 1e-6);
  float fill = clamp(0.5 - sd / px, 0.0, 1.0);
  float halo = 0.45 * clamp(0.5 - (sd - 1.0) / px, 0.0, 1.0) * (1.0 - fill);
  float a = fill + halo;
  if (a * uOpacity < 0.002) discard;
  gl_FragColor = vec4((uColor * fill + vec3(0.035, 0.035, 0.043) * halo) / a, a * uOpacity);
  #include <colorspace_fragment>
}
`

/** Head length and half-width of an arrow (CSS px). */
export const GIZMO_HEAD_PX = { length: 13, halfWidth: 5.5 }
/** Half-width of the shaft (CSS px): normal and highlighted (hover / active). */
export const GIZMO_SHAFT_HALF_PX = { normal: 1.5, highlight: 2.25 }
/** Margin of the quad around the arrow (CSS px): room for the halo and the anti-aliasing ramp. */
const QUAD_MARGIN_PX = 3

const _viewport = new THREE.Vector4()

/** Material of one gizmo arrow (set `uDir` per frame, `uColor` / `uOpacity` / `uShaftHalf` per state). */
export function createGizmoArrowMaterial(color: THREE.ColorRepresentation): THREE.ShaderMaterial {
  const uniforms = {
    uColor: { value: new THREE.Color(color) },
    uOpacity: { value: 1 },
    uArrow: { value: new THREE.Vector4(GIZMO_SHAFT_START_PX, GIZMO_SHAFT_END_PX, GIZMO_HEAD_PX.length, GIZMO_HEAD_PX.halfWidth) },
    uShaftHalf: { value: GIZMO_SHAFT_HALF_PX.normal },
    uDir: { value: new THREE.Vector2(1, 0) },
    uPixelRatio: { value: 1 },
    uViewport: { value: new THREE.Vector4(0, 0, 1, 1) },
  }
  const m = new THREE.ShaderMaterial({
    name: "atlas-overlay-gizmo-arrow",
    vertexShader: GIZMO_ARROW_VERTEX,
    fragmentShader: GIZMO_ARROW_FRAGMENT,
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  // The drawing-buffer viewport (physical pixels) of the pass being drawn and the renderer's pixel ratio
  // (CSS px → physical px), as aaLineMaterial.
  m.onBeforeRender = (renderer) => {
    const r = renderer as Partial<THREE.WebGLRenderer>
    if (typeof r.getCurrentViewport === "function") uniforms.uViewport.value.copy(r.getCurrentViewport.call(renderer, _viewport))
    uniforms.uPixelRatio.value = typeof r.getPixelRatio === "function" ? r.getPixelRatio.call(renderer) : 1
    m.uniformsNeedUpdate = true
  }
  return m
}

/**
 * The quad every arrow is drawn on (shared by the three axes): `aOffset` corners in CSS px around the
 * arrow from GIZMO_SHAFT_START_PX to GIZMO_SHAFT_END_PX, `position` at the origin (bounds are meaningless:
 * the meshes are not frustum culled).
 */
export function gizmoArrowGeometry(): THREE.BufferGeometry {
  const x0 = GIZMO_SHAFT_START_PX - QUAD_MARGIN_PX
  const x1 = GIZMO_SHAFT_END_PX + QUAD_MARGIN_PX
  const h = Math.max(GIZMO_HEAD_PX.halfWidth, GIZMO_SHAFT_HALF_PX.highlight) + QUAD_MARGIN_PX
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3))
  g.setAttribute("aOffset", new THREE.BufferAttribute(new Float32Array([x0, -h, x1, -h, x1, h, x0, h]), 2))
  g.setIndex([0, 1, 2, 0, 2, 3])
  return g
}
