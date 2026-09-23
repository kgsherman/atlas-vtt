/**
 * Unlit overlay material with analytic edge anti-aliasing. The canvas has no MSAA (engine.ts: MSAA
 * lives only in the post pipeline's scene target, so it can follow the tier), and overlays are drawn
 * onto the canvas after the composite, so flat overlay meshes (ruler, move paths, brush circles) fade
 * their own edges instead: geometry from overlays/ribbon.ts carries an `aEdge` (across, along)
 * coordinate that is ±1 on edges, and the fragment turns the distance to 1 into pixel coverage with
 * fwidth (a one-pixel ramp; builders widen shapes by half a pixel per side so it is centred on the
 * nominal edge). Same idea as the token rings (engine/tokens.ts RING_FRAGMENT).
 */
import * as THREE from "three"

import type { EdgeGeometryData } from "../overlays/ribbon"

export const EDGE_AA_VERTEX = /* glsl */ `
attribute vec2 aEdge;
varying vec2 vEdge;
void main() {
  vEdge = aEdge;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

export const EDGE_AA_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying vec2 vEdge;
// Coverage of a pixel by the shape where the edge coordinate v reaches ±1 on its border.
float atEdgeCoverage(float v) {
  return clamp((1.0 - abs(v)) / max(fwidth(v), 1e-6), 0.0, 1.0);
}
void main() {
  float a = uOpacity * atEdgeCoverage(vEdge.x) * atEdgeCoverage(vEdge.y);
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}
`

export interface EdgeAAMaterialOptions {
  opacity?: number
  /** Default false: overlays draw through geometry. */
  depthTest?: boolean
}

/** Transparent, unlit, double-sided overlay material for geometry with an `aEdge` attribute. */
export function createEdgeAAMaterial(color: THREE.ColorRepresentation, opts: EdgeAAMaterialOptions = {}): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: "atlas-overlay-aa",
    vertexShader: EDGE_AA_VERTEX,
    fragmentShader: EDGE_AA_FRAGMENT,
    uniforms: { uColor: { value: new THREE.Color(color) }, uOpacity: { value: opts.opacity ?? 1 } },
    transparent: true,
    depthTest: opts.depthTest ?? false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
}

/** BufferGeometry (position + aEdge) of edge-coordinate overlay geometry. */
export function edgeGeometry(data: EdgeGeometryData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(data.positions, 3))
  g.setAttribute("aEdge", new THREE.BufferAttribute(data.edges, 2))
  return g
}
