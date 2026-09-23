/**
 * Unlit overlay GLSL for window glass, fixture flames and flame glows. Unlit, but NOT exempt from fog
 * (ARCHITECTURE §4.1 step 4: players see nothing they do not perceive): with vision on, the fragment's
 * cell on the object's level (uLevelLayer) decides what is drawn.
 *  - glass (default): perceived → its colour; explored only → memory style; unexplored → invisible;
 *  - flame (AT_FLAME): light, not static geometry, so never shown from memory: perceived → full,
 *    otherwise invisible (fog) or darkened (DM preview). Emissive: × uRenderParams.x, so the HDR post
 *    pipeline's bloom picks flames up (and only them: surfaces rarely exceed its threshold);
 *  - glow (AT_GLOW, AT_FLAME implied): a camera-facing soft sprite around each flame (additive), sharing
 *    the flames' instance matrices (so it flickers with them), strength uRenderParams.y. The perception
 *    lookup uses the flame's own cell, so a glow never lights up unperceived space.
 * Sight is needed (grade ≥ 2): blindsight does not see glass glint or flames.
 */
import { COMMON_FUNCTIONS_GLSL, SHARED_UNIFORMS_GLSL, VERTEX_TRANSFORM_GLSL } from "./common"

export const OVERLAY_VERTEX_SHADER = /* glsl */ `
in vec3 color;

out vec3 vWorldPos;
out vec3 vColor;
out vec2 vUv;

${VERTEX_TRANSFORM_GLSL}

// Glow sprite size relative to the flame's diameter (instance scale x).
#define AT_GLOW_SIZE 4.5

void main() {
  vec3 c = color;
#ifdef USE_INSTANCING_COLOR
  c *= instanceColor;
#endif
  vColor = c;
  vUv = uv;
#ifdef AT_GLOW
  vec4 centre = modelMatrix * atLocalPosition(vec3(0.0));
#ifdef USE_INSTANCING
  float size = max(length(instanceMatrix[0].xyz) * AT_GLOW_SIZE, 1.1);
#else
  float size = 1.5;
#endif
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vWorldPos = centre.xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(centre.xyz + (right * position.x + up * position.y) * size, 1.0);
#else
  vec4 local = atLocalPosition(position);
  vWorldPos = (modelMatrix * local).xyz;
  gl_Position = projectionMatrix * (modelViewMatrix * local);
#endif
}
`

export const OVERLAY_FRAGMENT_SHADER = /* glsl */ `
layout(location = 0) out highp vec4 atFragColor;

in vec3 vWorldPos;
in vec3 vColor;
in vec2 vUv;

${SHARED_UNIFORMS_GLSL}

uniform int uLevelLayer;
uniform float uOpacity;

${COMMON_FUNCTIONS_GLSL}

void main() {
  vec3 col = vColor;
  float alpha = uOpacity;
#ifdef AT_FLAME
  col *= uRenderParams.x;
#endif
#ifdef AT_GLOW
  // Soft falloff: bright core, long faint tail; additive, so alpha only scales the colour.
  float r = length(vUv - 0.5) * 2.0;
  float g = max(0.0, 1.0 - r);
  g = g * g * (0.35 + 0.65 * exp(-r * r * 9.0));
  col = vColor * (g * uRenderParams.y);
#endif
  if (uVisionMode != 0) {
    float grade;
    vec4 m = atMaskSample(vWorldPos.xz, uLevelLayer, grade);
    float seen = grade > 1.5 ? smoothstep(0.5, 1.0, m.r) : 0.0;
#ifdef AT_FLAME
    if (uVisionMode == 1) {
      alpha *= seen;
#ifdef AT_GLOW
      col *= seen;
#endif
    } else {
      col *= mix(AT_PREVIEW_SCALE, 1.0, seen);
    }
#else
    if (uVisionMode == 1) {
      float explored = smoothstep(0.5, 1.0, m.g);
      col = mix(atMemory(col), col, seen);
      alpha *= max(seen, explored);
    } else {
      col *= mix(AT_PREVIEW_SCALE, 1.0, seen);
    }
#endif
  }
  atFragColor = atOutput(col, alpha);
}
`
