/**
 * World material GLSL (ARCHITECTURE §4.1): one forward pass doing lighting (ambient/sky fill, sun with a
 * cached shadow map, ≤ 32 shadowed point lights), perception (host grade + optional GPU line-of-sight
 * refinement) and fog (explored memory / black) — no discard, no gl_FragDepth, so early-Z stays on.
 *
 * Variants (defines): AT_GHOST (translucent editor ghost, alpha = uOpacity), AT_DEPTH_ONLY (ghost depth
 * pre-pass: trivial fragment work, colour writes disabled on the material).
 */
import { COMMON_FUNCTIONS_GLSL, SHARED_UNIFORMS_GLSL, VERTEX_TRANSFORM_GLSL } from "./common"

export const WORLD_VERTEX_SHADER = /* glsl */ `
// three declares position/normal/uv, instanceMatrix/instanceColor (when instanced) and the matrices.
in vec3 color;
in float aSurf;

out vec3 vWorldPos;
out vec3 vNormal;
out vec3 vAlbedo;
flat out float vSurf;

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
  vSurf = aSurf;
  gl_Position = projectionMatrix * (modelViewMatrix * local);
}
`

export const WORLD_FRAGMENT_SHADER = /* glsl */ `
layout(location = 0) out highp vec4 atFragColor;

in vec3 vWorldPos;
in vec3 vNormal;
in vec3 vAlbedo;
flat in float vSurf;

${SHARED_UNIFORMS_GLSL}

// Per level: this level's layer in uMasks (-1 = none).
uniform int uLevelLayer;
// Ghost variant opacity.
uniform float uOpacity;

${COMMON_FUNCTIONS_GLSL}

void main() {
#ifdef AT_DEPTH_ONLY
  atFragColor = vec4(0.0, 0.0, 0.0, 1.0);
#else
  vec3 p = vWorldPos;
  vec3 n = atSafeNormal(vNormal);
  vec3 albedo = vAlbedo;

  // Perception (§4.1 step 3): host grade and masks, GPU refinement may only remove perception.
  float perceived = 1.0;
  float explored = 1.0;
  float sunlit = 1.0;
  float grade = 3.0;
  bool darkvision = false;
  if (uVisionMode != 0) {
    vec4 m = atSurfaceMask(p, n, vSurf, uLevelLayer, grade);
    perceived = grade > 0.5 ? smoothstep(0.5, 1.0, m.r) : 0.0;
    explored = smoothstep(0.5, 1.0, m.g);
    sunlit = smoothstep(0.5, 1.0, m.b);
    if (perceived > 0.0) perceived *= atViewerLos(p, n, vSurf);
    darkvision = atDarkvisionAt(p);
  }

  vec3 col;
  if (uVisionMode == 1 && perceived <= 0.0) {
    // Fog (§4.1 step 4): explored memory without any light term (stale lights can't make memory look lit),
    // with static top/side shading so furniture keeps its shape; else black.
    col = atMemory(albedo) * (explored * atSenseShade(n));
  } else {
    // Player mode clamps the local sun shadow by the host's sunlit mask (unexplored occluders are missing).
    float sunGate = uVisionMode == 1 ? sunlit : 1.0;
    bool cap = vSurf > 1.5;
    float lightsLit;
    vec3 light = atFill(p, n, cap) + atSunTerm(p, n, cap) * sunGate + atPointLights(p, n, true, cap, lightsLit);
    vec3 lit = albedo * light;
    if (uVisionMode == 0) {
      col = atDmColour(albedo, light);
    } else {
      vec3 seen = atGradeColour(grade, albedo, light, darkvision, n);
      vec3 unseen = uVisionMode == 1 ? atMemory(albedo) * (explored * atSenseShade(n)) : atPreviewDark(lit, albedo);
      // Per-pixel refinement of a colour cell on walkable surfaces (where the host samples): colour needs
      // light >= dim HERE, so colour / darkvision grey / unseen follow the light's radius and shadows
      // instead of 5 ft cell steps. Only ever lowers the host grade.
      if (grade > 2.5 && vSurf < 0.5) {
        float litHere = max(lightsLit, atEnvLit(p, sunGate));
        if (litHere < 1.0) {
          vec3 low = darkvision ? atGradeColour(2.0, albedo, light, false, n) : atBlindsightAt(p) ? atGradeColour(1.0, albedo, light, false, n) : unseen;
          seen = mix(low, seen, litHere);
        }
      }
      col = mix(unseen, seen, perceived);
    }
  }

#ifdef AT_GHOST
  atFragColor = atOutput(col, uOpacity);
#else
  atFragColor = atOutput(col, 1.0);
#endif
#endif
}
`
