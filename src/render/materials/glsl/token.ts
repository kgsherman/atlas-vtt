/**
 * Token material GLSL: lit by the same light uniforms as the world (point lights, sun, fill), never
 * discards. Perception-aware: with the token's level known (uLevelLayer ≥ 0) and vision on, a token in a
 * darkvision / blindsight cell is drawn greyscale / tinted like the ground under it, and the sun is
 * gated by the host's sunlit mask in player mode. Dimmed tokens (DM preview: not visible to the
 * previewed token) get a dark desaturated tint (per instance `aDim`, or per object `uDim`).
 *
 * Readability: a view-dependent rim light in the token's own colour keeps tokens legible in dark rooms
 * (tokens are only ever in a scene when their viewer may see them). Portraits: per instance `aPortrait`
 * = (atlas u, v, scale, 1) samples the shared portrait atlas `uPortraits` with the mesh uv.
 */
import { COMMON_FUNCTIONS_GLSL, SHARED_UNIFORMS_GLSL, VERTEX_TRANSFORM_GLSL } from "./common"

export const TOKEN_VERTEX_SHADER = /* glsl */ `
in vec3 color;
// Per instance (InstancedBufferAttribute) or per vertex; absent → material defaults (0 / 1).
in float aDim;
in float aFade;
in vec4 aPortrait;

out vec3 vWorldPos;
out vec3 vNormal;
out vec3 vAlbedo;
out vec2 vUv;
flat out float vDim;
flat out float vFade;
flat out vec4 vPortrait;

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
  vPortrait = aPortrait;
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
flat in vec4 vPortrait;

${SHARED_UNIFORMS_GLSL}

uniform int uLevelLayer;
uniform float uDim;
uniform float uOpacity;
uniform sampler2D uMap;
uniform float uUseMap;
uniform sampler2D uPortraits;
// x = rim strength, y = rim exponent, z = emissive lift of the colour ring, w = unused.
uniform vec4 uTokenParams;

${COMMON_FUNCTIONS_GLSL}

void main() {
  vec3 p = vWorldPos;
  vec3 n = atSafeNormal(vNormal);
  vec3 albedo = vAlbedo;
  if (uUseMap > 0.5) albedo *= texture(uMap, vUv).rgb;
  // Portrait (sampled unconditionally: uniform control flow for the implicit derivatives).
  vec4 portrait = texture(uPortraits, vPortrait.xy + vUv * vPortrait.z);
  albedo = mix(albedo, portrait.rgb, portrait.a * step(0.5, vPortrait.w));

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
  vec3 v = atViewDir(p);
  vec3 spec = vec3(0.0);
  float gloss = AT_TIER >= 2 ? 0.25 : 0.0;
  vec3 light = atFill(p, n, false) + atSunTerm(p, n, n, false, v, gloss, spec) * sunGate + atPointLights(p, n, n, true, false, lightsLit, v, gloss, spec);
  vec3 col = uVisionMode == 0 ? atDmColour(albedo, light, max(lightsLit, atEnvLit(p, 1.0))) : atGradeColour(grade, albedo, light, atDarkvisionAt(p), n);
  if (grade > 2.5) col += spec * 0.5;

  // Rim light in the token's colour (greyscale for the monochrome senses), plus a faint self-lit floor.
  float rim = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), uTokenParams.y) * uTokenParams.x;
  vec3 rimCol = mix(albedo, vec3(1.0), 0.35);
  if (grade < 2.5) rimCol = vec3(atLuma(rimCol));
  col += rimCol * rim * 0.6 + albedo * uTokenParams.z;

  float dim = clamp(max(vDim, uDim), 0.0, 1.0);
  col = mix(col, vec3(atLuma(col)) * 0.35 + vec3(0.015, 0.015, 0.03), dim);

  atFragColor = atOutput(col, clamp(uOpacity * vFade, 0.0, 1.0));
}
`
