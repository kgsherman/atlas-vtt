/**
 * Unlit overlay GLSL for window glass and fixture flames. Unlit, but NOT exempt from fog (ARCHITECTURE
 * §4.1 step 4: players see nothing they do not perceive): with vision on, the fragment's cell on the
 * object's level (uLevelLayer) decides what is drawn.
 *  - glass (default): perceived → its colour; explored only → memory style; unexplored → invisible;
 *  - flame (AT_FLAME): light, not static geometry, so never shown from memory: perceived → full,
 *    otherwise invisible (fog) or darkened (DM preview).
 * Sight is needed (grade ≥ 2): blindsight does not see glass glint or flames.
 */
import { COMMON_FUNCTIONS_GLSL, SHARED_UNIFORMS_GLSL, VERTEX_TRANSFORM_GLSL } from "./common"

export const OVERLAY_VERTEX_SHADER = /* glsl */ `
in vec3 color;

out vec3 vWorldPos;
out vec3 vColor;

${VERTEX_TRANSFORM_GLSL}

void main() {
  vec4 local = atLocalPosition(position);
  vec3 c = color;
#ifdef USE_INSTANCING_COLOR
  c *= instanceColor;
#endif
  vWorldPos = (modelMatrix * local).xyz;
  vColor = c;
  gl_Position = projectionMatrix * (modelViewMatrix * local);
}
`

export const OVERLAY_FRAGMENT_SHADER = /* glsl */ `
layout(location = 0) out highp vec4 atFragColor;

in vec3 vWorldPos;
in vec3 vColor;

${SHARED_UNIFORMS_GLSL}

uniform int uLevelLayer;
uniform float uOpacity;

${COMMON_FUNCTIONS_GLSL}

void main() {
  vec3 col = vColor;
  float alpha = uOpacity;
  if (uVisionMode != 0) {
    float grade;
    vec4 m = atMaskSample(vWorldPos.xz, uLevelLayer, grade);
    float seen = grade > 1.5 ? smoothstep(0.5, 1.0, m.r) : 0.0;
#ifdef AT_FLAME
    if (uVisionMode == 1) alpha *= seen;
    else col *= mix(AT_PREVIEW_SCALE, 1.0, seen);
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
