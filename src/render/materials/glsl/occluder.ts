/**
 * Occluder proxy shaders (ARCHITECTURE §4.2):
 *  - distance: linear distance from the capture source, written to the R32F cube faces. Proxies are
 *    rendered BackSide, so each texel stores the far side of the nearest occluder ("second depth").
 *    Primitives containing the source are excluded by key: their vertices are moved outside the clip
 *    volume, so the whole triangle is clipped without a fragment-stage discard.
 *  - depth: the sun / sky depth pass (colour writes off), same transform and exclusion.
 */

export const OCCLUDER_VERTEX_SHADER = /* glsl */ `
// Per-instance (instanced boxes / prisms) or per-vertex (heightfield chunks) primitive key.
in float aKey;

// Keys of up to 4 primitives containing the capture source (-1 = unused).
uniform vec4 uExclude;

out vec3 vWorld;

void main() {
  vec4 local = vec4(position, 1.0);
#ifdef USE_INSTANCING
  local = instanceMatrix * local;
#endif
  vec4 world = modelMatrix * local;
  vWorld = world.xyz;
  vec4 dk = abs(vec4(aKey) - uExclude);
  bool excluded = min(min(dk.x, dk.y), min(dk.z, dk.w)) < 0.5;
  // z = 2w lies beyond the far plane for every vertex: the triangle is clipped away entirely.
  gl_Position = excluded ? vec4(0.0, 0.0, 2.0, 1.0) : projectionMatrix * (viewMatrix * world);
}
`

export const OCCLUDER_DISTANCE_FRAGMENT_SHADER = /* glsl */ `
layout(location = 0) out highp vec4 atFragColor;

uniform vec3 uSource;

in vec3 vWorld;

void main() {
  atFragColor = vec4(length(vWorld - uSource), 0.0, 0.0, 1.0);
}
`

export const OCCLUDER_DEPTH_FRAGMENT_SHADER = /* glsl */ `
layout(location = 0) out highp vec4 atFragColor;

in vec3 vWorld;

void main() {
  atFragColor = vec4(0.0, 0.0, 0.0, 1.0);
}
`
