/**
 * Token material GLSL: lit by the same light uniforms as the world (point lights, sun, fill), never
 * discards. Perception-aware: with the token's level known (uLevelLayer ≥ 0) and vision on, a token in a
 * darkvision / blindsight cell is drawn greyscale / tinted like the ground under it, and the sun is
 * gated by the host's sunlit mask in player mode. Dimmed tokens (DM preview: not visible to the
 * previewed token) get a dark desaturated tint (per instance `aDim`, or per object `uDim`).
 */
import { COMMON_FUNCTIONS_GLSL, SHARED_UNIFORMS_GLSL, VERTEX_TRANSFORM_GLSL } from "./common"

export const TOKEN_VERTEX_SHADER = /* glsl */ `
in vec3 color;
// Per instance (InstancedBufferAttribute) or per vertex; absent → material defaults (0 / 1).
in float aDim;
in float aFade;

out vec3 vWorldPos;
out vec3 vNormal;
out vec3 vAlbedo;
out vec2 vUv;
flat out float vDim;
flat out float vFade;

${VERTEX_TRANSFORM_GLSL}

void main() {
  vec4 local = atLocalPosition(position);
  vec3 albedo = color;
#ifdef USE_INSTANCING_COLOR
  albedo *= instanceColor;
#endif
  vWorldPos = (modelMatrix * local).xyz;
  vNormal = atObjectNormal(normal);
  vAlbedo = albedo;
  vUv = uv;
  vDim = aDim;
  vFade = aFade;
  gl_Position = projectionMatrix * (modelViewMatrix * local);
}
`

export const TOKEN_FRAGMENT_SHADER = /* glsl */ `
layout(location = 0) out highp vec4 atFragColor;

in vec3 vWorldPos;
in vec3 vNormal;
in vec3 vAlbedo;
in vec2 vUv;
flat in float vDim;
flat in float vFade;

${SHARED_UNIFORMS_GLSL}

uniform int uLevelLayer;
uniform float uDim;
uniform float uOpacity;
uniform sampler2D uMap;
uniform float uUseMap;

${COMMON_FUNCTIONS_GLSL}

void main() {
  vec3 p = vWorldPos;
  vec3 n = atSafeNormal(vNormal);
  vec3 albedo = vAlbedo;
  if (uUseMap > 0.5) albedo *= texture(uMap, vUv).rgb;

  float grade = 3.0;
  float sunGate = 1.0;
  if (uVisionMode != 0 && uLevelLayer >= 0) {
    float g;
    vec4 m = atMaskSample(p.xz, uLevelLayer, g);
    // Tokens are only present when visible: an unperceived cell (grade 0) keeps full colour.
    if (g > 0.5) grade = g;
    if (uVisionMode == 1) sunGate = smoothstep(0.5, 1.0, m.b);
  }

  float lightsLit;
  vec3 light = atFill(p, n, false) + atSunTerm(p, n, false) * sunGate + atPointLights(p, n, true, false, lightsLit);
  vec3 col = uVisionMode == 0 ? atDmColour(albedo, light) : atGradeColour(grade, albedo, light, atDarkvisionAt(p), n);

  float dim = clamp(max(vDim, uDim), 0.0, 1.0);
  col = mix(col, vec3(atLuma(col)) * 0.35 + vec3(0.015, 0.015, 0.03), dim);

  atFragColor = atOutput(col, clamp(uOpacity * vFade, 0.0, 1.0));
}
`
