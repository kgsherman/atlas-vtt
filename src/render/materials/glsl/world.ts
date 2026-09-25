/**
 * World material GLSL (ARCHITECTURE §4.1): one forward pass doing lighting (ambient/sky fill, sun with a
 * cached shadow map, ≤ 32 shadowed point lights), perception (host grade + optional GPU line-of-sight
 * refinement) and fog (explored memory / black) — no discard, no gl_FragDepth, so early-Z stays on.
 *
 * Albedo = vertex / instance colour, then the level's battlemap backdrop (§9: planar XZ projection over
 * its rect, premultiplied alpha × opacity over the material colour, on walkable fragments and — with
 * tintWalls — on caps and faces), then procedural surface detail (glsl/detail.ts, tier ≥ medium) faded
 * where the backdrop covers. High / ultra also bump-map the detail and add glossy highlights.
 *
 * Variants (defines): AT_GHOST (translucent editor ghost, alpha = uOpacity), AT_DEPTH_ONLY (ghost depth
 * pre-pass: trivial fragment work, colour writes disabled on the material). AT_TIER (0 low … 3 ultra) is
 * set by the lighting system; changing it recompiles once.
 */
import { COMMON_FUNCTIONS_GLSL, SHARED_UNIFORMS_GLSL, VERTEX_TRANSFORM_GLSL } from "./common"
import { DETAIL_GLSL } from "./detail"

export const WORLD_VERTEX_SHADER = /* glsl */ `
// three declares position/normal/uv, instanceMatrix/instanceColor (when instanced) and the matrices.
in vec3 color;
in float aSurf;
in float aMat;

out vec3 vWorldPos;
out vec3 vNormal;
out vec3 vAlbedo;
flat out float vSurf;
flat out float vMat;

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
  vMat = aMat;
  gl_Position = projectionMatrix * (modelViewMatrix * local);
}
`

export const WORLD_FRAGMENT_SHADER = /* glsl */ `
layout(location = 0) out highp vec4 atFragColor;

in vec3 vWorldPos;
in vec3 vNormal;
in vec3 vAlbedo;
flat in float vSurf;
flat in float vMat;

${SHARED_UNIFORMS_GLSL}

// Per level: this level's layer in uMasks (-1 = none).
uniform int uLevelLayer;
// Ghost variant opacity.
uniform float uOpacity;
// Per level battlemap backdrop (a transparent 1×1 placeholder when the level has none).
uniform sampler2D uBackdrop;
// x0, z0 of the image rect (feet), 1 / width, 1 / depth.
uniform vec4 uBackdropRect;
// x = opacity (0 = no image), y = tint walls (0/1), z = unused, w = unused.
uniform vec4 uBackdropParams;

${COMMON_FUNCTIONS_GLSL}
${DETAIL_GLSL}

// Backdrop colour over the material albedo; returns the coverage (image alpha × opacity).
float atApplyBackdrop(vec3 p, vec3 n, float surf, vec2 gx, vec2 gy, inout vec3 albedo) {
  if (uBackdropParams.x <= 0.0 || (surf > 0.5 && uBackdropParams.y < 0.5)) return 0.0;
  // Faces sample just inside their own solid (the wall as drawn on the map), caps and floors under p.
  vec2 xz = surf > 0.5 && surf < 1.5 ? p.xz - n.xz * 0.2 : p.xz;
  vec2 uv = (xz - uBackdropRect.xy) * uBackdropRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  vec4 t = textureGrad(uBackdrop, uv, gx, gy);
  float op = uBackdropParams.x;
  // Premultiplied alpha "over".
  albedo = albedo * (1.0 - t.a * op) + t.rgb * op;
  return t.a * op;
}

void main() {
#ifdef AT_DEPTH_ONLY
  atFragColor = vec4(0.0, 0.0, 0.0, 1.0);
#else
  vec3 p = vWorldPos;
  vec3 n = atSafeNormal(vNormal);
  vec3 albedo = vAlbedo;
  bool cap = vSurf > 1.5;

  // Derivatives first (uniform control flow): backdrop gradients and the pixel footprint.
  vec2 buv = p.xz * uBackdropRect.zw;
  vec2 bgx = dFdx(buv);
  vec2 bgy = dFdy(buv);
  float fw = max(length(dFdx(p)), length(dFdy(p)));
  float cover = atApplyBackdrop(p, n, vSurf, bgx, bgy, albedo);

  vec3 nb = n;
  float gloss = 0.0;
#if AT_TIER >= 1
  float relief;
  // Painted battlemaps carry their own detail: covered fragments skip the procedural one.
  vec4 detail = atSurfaceDetail(p, n, vMat, fw, 1.0 - cover, relief);
  albedo *= detail.rgb;
  gloss = detail.a;
#if AT_TIER >= 2
  nb = atBumpNormal(p, n, relief);
#endif
#endif

  // Perception (§4.1 step 3): host grade and masks, GPU refinement may only remove perception.
  float perceived = 1.0;
  float explored = 1.0;
  float sunlit = 1.0;
  float grade = 3.0;
  // Darkvision in range by the rules (per-pixel edge AT_SENSE_EDGE), and the weight of its colour lift.
  float dvIn = 0.0;
  float dvLift = 0.0;
  bool gridFog = uFogGrid > 0.5;
  if (uVisionMode != 0) {
    vec2 maskAt;
    vec4 m = atSurfaceMask(p, n, vSurf, uLevelLayer, grade, maskAt);
    dvIn = atSenseWeight(p, 0, AT_SENSE_EDGE);
    dvLift = dvIn > 0.0 ? atSenseWeight(p, 0, AT_DV_FEATHER) : 0.0;
    sunlit = smoothstep(0.5, 1.0, m.b);
    if (gridFog) {
      // Grid fog: whole cells at the host's grade, nothing refined per pixel.
      perceived = grade > 0.5 ? atCellEdge(m.r) : 0.0;
      explored = atCellEdge(m.g);
    } else {
      // Smooth fog: the band (r = 0.5, one sub-cell around the host's perceived sub-cells) counts as
      // perceived only while every eye's GPU line of sight can confirm it per pixel, and precisely enough
      // (atBandTrust); then the edge is the real shadow line (and light / sense range) instead of the
      // host's sub-cell staircase. Elsewhere it follows a smooth fit of the host's sub-cells (atHostFields),
      // as the explored edge always does.
      bool los = uViewersAll > 0.5 && atLosReady();
      // Only near an edge of either mask do the 16 taps of the smooth host fields matter.
      bool edge = (m.r > 0.01 && m.r < 0.99) || (m.g > 0.01 && m.g < 0.99);
      vec2 host = edge ? atHostFields(maskAt, uLevelLayer) : vec2(step(0.5, m.r), step(0.5, m.g));
      perceived = grade > 0.5 ? atFogEdge(m.r, host.x, los ? atBandTrust(p) : 0.0) : 0.0;
      explored = smoothstep(0.38, 0.62, host.y);
      if (perceived > 0.0) perceived *= atViewerLos(p, n, vSurf);
      // Darkvision (grade 2) and blindsight (grade 1) end at their range per pixel (only removes
      // perception): the host's cells and sub-cells drew the range as a staircase. A viewer's own
      // footprint stays perceived by touch.
      if (perceived > 0.0 && grade < 2.5 && uViewersAll > 0.5 && !atTouched(p)) perceived *= grade > 1.5 ? dvIn : atSenseWeight(p, 1, AT_SENSE_EDGE);
    }
  }

  vec3 col;
  if (uVisionMode == 1 && perceived <= 0.0) {
    // Fog (§4.1 step 4): explored memory without any light term (stale lights can't make memory look lit),
    // with static top/side shading so furniture keeps its shape; else black.
    col = atMemory(albedo) * (explored * atSenseShade(n));
  } else {
    // Player mode clamps the local sun shadow by the host's sunlit mask (unexplored occluders are missing).
    float sunGate = uVisionMode == 1 ? sunlit : 1.0;
    float lightsLit;
    vec3 v = atViewDir(p);
    vec3 spec = vec3(0.0);
    vec3 fill = atFill(p, n, cap);
#if AT_TIER >= 1
    // Soft hemispheric shaping of the fill: faces a little darker than floors, relief reads under ambient.
    fill *= 0.82 + 0.18 * max(nb.y, 0.0);
#endif
    vec3 light = fill + atSunTerm(p, n, nb, cap, v, gloss, spec) * sunGate + atPointLights(p, n, nb, true, cap, lightsLit, v, gloss, spec);
    vec3 lit = albedo * light;
    if (uVisionMode == 0) {
      col = atDmColour(albedo, light, max(lightsLit, atEnvLit(p, 1.0))) + spec;
    } else {
      vec3 seen = atGradeColour(grade, albedo, light, dvLift, n);
      if (grade > 2.5) seen += spec;
      vec3 unseen = uVisionMode == 1 ? atMemory(albedo) * (explored * atSenseShade(n)) : atPreviewDark(lit, albedo);
      // Per-pixel refinement of a colour cell on walkable surfaces (where the host samples): colour needs
      // light >= dim HERE, so colour / darkvision grey / unseen follow the light's radius and shadows
      // instead of 5 ft cell steps. Only ever lowers the host grade. Smooth fog only.
      if (grade > 2.5 && vSurf < 0.5 && !gridFog) {
        float litHere = max(lightsLit, atEnvLit(p, sunGate));
        if (litHere < 1.0) {
          vec3 low = atBlindsightAt(p) ? atGradeColour(1.0, albedo, light, 0.0, n) : unseen;
          if (dvIn > 0.0) low = mix(low, atGradeColour(2.0, albedo, light, 0.0, n), dvIn);
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
