/**
 * GLSL shared by the world and token fragment shaders (GLSL ES 3.00 via ShaderMaterial + GLSL3).
 * three.js prepends precision (highp float/int/samplers), `viewMatrix`, `cameraPosition`,
 * `linearToOutputTexel()`, `luminance()` and, when tone mapping is on, `TONE_MAPPING` + `toneMapping()`.
 * Every identifier here is prefixed `at`/`AT_`/`u` so nothing collides with those.
 *
 * TypeScript mirrors (keep in sync): render/shadows/octahedral.ts (atOctEncode, atPcf, normal offset),
 * render/lighting/lightModel.ts (atLightFalloff, atSoftLambert, atLuma), render/lighting/uniforms.ts
 * (uLights / uViewers layouts), render/fog/maskExpand.ts (uMasks channels).
 */

/** Shared uniforms: declarations must match createSharedUniforms() one-to-one. */
export const SHARED_UNIFORMS_GLSL = /* glsl */ `
#define AT_MAX_LIGHTS 32
#define AT_MAX_VIEWERS 8
#define AT_SQRT_4PI 3.5449077018110318
#define AT_DIST_EPS 0.05

// Point lights, 4 vec4 per slot (see render/lighting/uniforms.ts):
//   [0] position.xyz, dimRadius  [1] radiance.rgb, brightRadius
//   [2] tile.xy, tile size (0 = unshadowed), flags (1 = wide PCF, 2 = hi-res atlas, 4 = soft shadows)
//   [3] capture origin.xyz, source radius (ft, soft shadows)
uniform vec4 uLights[AT_MAX_LIGHTS * 4];
uniform int uLightCount;
uniform sampler2D uLightAtlas;
// Ultra tier: 1024² tiles of the highest-priority lights (flag 2); a 1×1 placeholder otherwise.
uniform sampler2D uLightAtlasHi;
// Per-cell slot mask (lighting/lightMask.ts): bit i = slot i's dim disc reaches the cell. Grid: world XZ
// of its corner, 1 / cell size, w = 1 when bound (0: every slot is tested).
uniform highp usampler2D uLightMask;
uniform vec4 uLightMaskGrid;

// Ambient fill under cover / under open sky, sky exposure map (straight-down depth map).
uniform vec3 uAmbient;
uniform vec3 uSkyAmbient;
uniform mat4 uSkyMatrix;
uniform sampler2DShadow uSkyShadow;
uniform vec4 uSkyParams; // texel, depth bias, normal offset (ft), enabled

// Sun / moon.
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform mat4 uSunMatrix;
uniform sampler2DShadow uSunShadow;
uniform vec4 uSunParams; // texel, depth bias, reversed depth (0/1), normal offset (ft)

// Rules light levels (0 dark, 1 dim, 2 bright): ambient, sky, sun grants, flags (+1 sky map, +2 sun map).
uniform vec4 uEnvLevels;

// Viewers (line-of-sight refinement), 3 vec4 per slot:
//   [0] eye.xyz, darkvision  [1] tile.xy, tile size (0 = no tile), blindsight
//   [2] capture origin.xyz, touch half-extent (the square around the eye over its own footprint cells)
uniform vec4 uViewers[AT_MAX_VIEWERS * 3];
uniform int uViewerCount;
// 1 when uViewers holds every viewer; per-pixel tests that remove perception need all of them.
uniform float uViewersAll;
uniform sampler2D uViewerAtlas;

// Vision: 0 = off, 1 = fog (player), 2 = preview (DM).
uniform int uVisionMode;
uniform float uGpuRefine;
// Host masks, one RGBA layer per level: r = perceived, g = explored, b = sunlit, a = grade / 3.
uniform sampler2DArray uMasks;
uniform vec4 uMaskGrid; // 1/(width·cell), 1/(depth·cell), texture width, texture height

// Seconds (wrapped), for animated surfaces (water).
uniform float uTime;
// x = emissive scale of flames / glows (> 1 when the main pass renders HDR for bloom), y = glow sprite
// strength, z = 1 when the main pass renders into the HDR post target, w = unused.
uniform vec4 uRenderParams;
// World Y of the cutaway plane (underside of the slab above the active level); 1e9 = no cutaway.
uniform float uCutawayY;
// DM dark vision (vision off only): x = on (0/1), y = stripe period in drawing-buffer pixels.
uniform vec2 uDarkVision;
`

export const COMMON_FUNCTIONS_GLSL = /* glsl */ `
// Quality tier (0 low, 1 medium, 2 high, 3 ultra), defined per material by the lighting system.
#ifndef AT_TIER
#define AT_TIER 0
#endif
#define AT_DIM_FLOOR 0.22
#define AT_BRIGHT_FLOOR 0.5
// Monochrome senses, scaled by atSenseTone (0.25 to 1): darkness seen by darkvision reads as dim light, so its
// grey stays below a darkvision-lifted colour cell (AT_BRIGHT_FLOOR × albedo, raised to the grey's luma
// for dark albedo, see atGradeColour); blindsight is darker.
#define AT_DARKVISION_LEVEL 0.16
// Darkvision raises a lit colour toward that grey by scaling it (hue kept) up to this gain; only the
// rest is added as grey. Flat grey on dark, night-painted battlemaps read as a milky disc.
#define AT_DV_MAX_GAIN 3.0
// The darkvision lift fades out over the last AT_DV_FEATHER ft of its range (a look, not a rule), and
// the monochrome senses' perception ends per pixel over the last AT_SENSE_EDGE ft (see world.ts).
#define AT_DV_FEATHER 1.5
#define AT_SENSE_EDGE 0.5
#define AT_BLINDSIGHT_LEVEL 0.11
#define AT_BLINDSIGHT_TINT vec3(0.02, 0.05, 0.09)
#define AT_MEMORY_SCALE 0.17
#define AT_PREVIEW_SCALE 0.3
// DM views (vision off): unlit areas keep this much reflected light so dark rooms stay readable, and
// lit ones (a light, the sky or the sun/moon reaches them) at least AT_DM_LIT_FLOOR — between a
// normal-sighted player's dim colour (AT_DIM_FLOOR) and darkvision's (AT_BRIGHT_FLOOR): the DM reads a
// moonlit battlemap at least as well as their players, and still sees where the light ends.
#define AT_DM_FLOOR 0.08
#define AT_DM_LIT_FLOOR 0.4
// DM dark vision (editor toggle, uDarkVision): what is dark by the rules (litHere < 1) is lifted to
// AT_DM_DV_FLOOR instead of AT_DM_FLOOR, so a level built dark stays workable, and marked as such
// (desaturated, tinted blue, striped in screen space) by how dark it is. Lit areas look as without it.
#define AT_DM_DV_FLOOR 0.5
#define AT_DM_DV_DESAT 0.55
#define AT_DM_DV_TINT vec3(0.8, 0.92, 1.18)
#define AT_DM_DV_STRIPE 0.22
// Caps (surface class 2: tops of walls, doors, pillars, props) are tested for light / sky / sun from
// AT_CAP_INSET ft inside their solid, with a strict comparison (AT_CAP_EPS), instead of the outward
// normal offset: a cap touching the underside of a slab lies ON the slab's back face (the stored
// "second depth"), so the offset would read it as lit through the floor above (§4.2 deviation, see
// render/shadows/octahedral.ts receiverOffset).
// Cutaway views: a shadowed light of the hidden storey above never lights a cap that lies above the
// cutaway plane (atPointLights). The inset rule cannot save those caps: with the storey hidden its wall
// bases sit over the cap with WALL_BOTTOM_MARGIN below the inset point, the coverage probe steps off a
// wall-width footprint, and the stored depth's error at grazing angles exceeds the inset, which together
// gave a texel sawtooth of light along every wall top under a lit storey that no inset or margin removes.
#define AT_CAP_INSET 0.03
#define AT_CAP_EPS 0.01
// Depth bias of the directional maps in feet (lighting/system.ts DIRECTIONAL_BIAS_FT): uSunParams.y /
// uSkyParams.y hold it in depth units, so AT_CAP_EPS converts with their ratio.
#define AT_DIR_BIAS_FT 0.05
// Depth of the cap line-of-sight test point below the cap (ARCHITECTURE §4.1 says 0.1; deeper keeps
// it clear of the top edge for eyes below the cap at the viewer atlas' texel size).
#define AT_CAP_LOS_INSET 0.25

float atLuma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 atSafeNormal(vec3 n) {
  float l = length(n);
  return l > 1e-5 ? n / l : vec3(0.0, 1.0, 0.0);
}

// Unit horizontal part of v (zero when v is vertical).
vec3 atHoriz(vec3 v) {
  float l = length(v.xz);
  return l > 1e-4 ? vec3(v.x / l, 0.0, v.z / l) : vec3(0.0);
}

float atSmoothstepSafe(float e0, float e1, float x) {
  float t = clamp((x - e0) / max(e1 - e0, 1e-4), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

// 1 at the source, 0.5 at the bright radius, 0 at the dim radius (lightModel.ts lightFalloff).
float atLightFalloff(float d, float bright, float dim) {
  if (d >= dim) return 0.0;
  if (d <= bright && bright > 0.0) {
    float r = d / bright;
    return 1.0 - 0.5 * r * r;
  }
  return 0.5 * (1.0 - atSmoothstepSafe(bright, dim, d));
}

// Gated, softened Lambert (lightModel.ts softLambert).
float atSoftLambert(float ndl) {
  if (ndl <= 0.0) return 0.0;
  return atSmoothstepSafe(0.0, 0.2, ndl) * (0.6 + 0.4 * min(ndl, 1.0));
}

// Octahedral encoding with −Y at the centre (octahedral.ts octEncode).
vec2 atOctEncode(vec3 d) {
  vec3 n = d / (abs(d.x) + abs(d.y) + abs(d.z));
  if (n.y <= 0.0) return n.xz;
  vec2 s = vec2(n.x >= 0.0 ? 1.0 : -1.0, n.z >= 0.0 ? 1.0 : -1.0);
  return (1.0 - abs(n.zx)) * s;
}

// Octahedral decode / wrap (octahedral.ts octDecode / octWrap; the re-encode shader has its own copy).
vec3 atOctDecode(vec2 uv) {
  float t = 1.0 - abs(uv.x) - abs(uv.y);
  vec2 xz = uv;
  if (t < 0.0) {
    xz = vec2((1.0 - abs(uv.y)) * (uv.x >= 0.0 ? 1.0 : -1.0), (1.0 - abs(uv.x)) * (uv.y >= 0.0 ? 1.0 : -1.0));
  }
  return normalize(vec3(xz.x, -t, xz.y));
}

vec2 atOctWrap(vec2 uv) {
  if (abs(uv.x) > 1.0) uv = vec2((uv.x >= 0.0 ? 1.0 : -1.0) * (2.0 - abs(uv.x)), -uv.y);
  if (abs(uv.y) > 1.0) uv = vec2(-uv.x, (uv.y >= 0.0 ? 1.0 : -1.0) * (2.0 - abs(uv.y)));
  return uv;
}

// Distance along the centre direction of interior texel i to the receiver's tangent plane (q, n)
// (octahedral.ts planeDistance), for atCapCovered; dist when the texel runs parallel to the plane.
float atPlaneDist(vec2 i, float s, vec3 q, vec3 n, float dist) {
  vec3 dir = atOctDecode(atOctWrap(((i + 0.5) / s) * 2.0 - 1.0));
  float dn = dot(dir, n);
  if (dn > -1e-3) return dist;
  float t = dot(q, n) / dn;
  return t > 0.0 ? clamp(t, dist * 0.9, dist * 1.1) : dist;
}

// Distance atlases for the filters below. They take an atlas id rather than a sampler: one inlined copy
// of each filter for all atlases (GLSL cannot pick a sampler at runtime, so a sampler parameter meant a
// copy per atlas, and each copy of the point-shadow filters cost D3D's compiler ~0.5 s per world program).
#define AT_ATLAS_LIGHT 0
#define AT_ATLAS_HI 1
#define AT_ATLAS_VIEWER 2

float atTexel(int atlas, ivec2 c) {
#if AT_TIER >= 3
  if (atlas == AT_ATLAS_HI) return texelFetch(uLightAtlasHi, c, 0).r;
#endif
  if (atlas == AT_ATLAS_VIEWER) return texelFetch(uViewerAtlas, c, 0).r;
  return texelFetch(uLightAtlas, c, 0).r;
}

// Distance-map PCF (octahedral.ts pcfSample). tile = (atlas x, atlas y, size incl. guard ring); q is the
// receiver relative to the capture origin. Returns the fraction of taps with |q| <= stored + eps.
float atPcf(int atlas, vec3 tile, vec3 q, float eps, bool wide) {
  float dist = length(q);
  if (dist < 1e-4) return 1.0;
  vec2 uv = atOctEncode(q / dist);
  float s = tile.z - 2.0;
  vec2 f = clamp((uv * 0.5 + 0.5) * s - 0.5, vec2(-0.5), vec2(s - 0.5));
  ivec2 base = ivec2(tile.xy) + ivec2(1);
  if (!wide) {
    vec2 i0 = floor(f);
    vec2 wt = f - i0;
    ivec2 c = base + ivec2(i0);
    float s00 = step(dist, atTexel(atlas, c) + eps);
    float s10 = step(dist, atTexel(atlas, c + ivec2(1, 0)) + eps);
    float s01 = step(dist, atTexel(atlas, c + ivec2(0, 1)) + eps);
    float s11 = step(dist, atTexel(atlas, c + ivec2(1, 1)) + eps);
    return mix(mix(s00, s10, wt.x), mix(s01, s11, wt.x), wt.y);
  }
  // 3x3 taps, 2-texel box filter: per-axis weights (0.5 - o, 1, 0.5 + o), total weight 4.
  vec2 cc = clamp(floor(f + 0.5), vec2(0.0), vec2(s - 1.0));
  vec2 o = f - cc;
  vec3 wx = vec3(0.5 - o.x, 1.0, 0.5 + o.x);
  vec3 wy = vec3(0.5 - o.y, 1.0, 0.5 + o.y);
  ivec2 c = base + ivec2(cc);
  float sum = 0.0;
  for (int j = 0; j < 3; j++) {
    for (int i = 0; i < 3; i++) {
      float stored = atTexel(atlas, c + ivec2(i - 1, j - 1));
      sum += step(dist, stored + eps) * wx[i] * wy[j];
    }
  }
  return sum * 0.25;
}

// Is the cap receiver q covered? The texel under q compared on the cap's own plane (octahedral.ts
// capCovered): robust at grazing angles, where the back-face plane of a slab resting on the cap moves
// by more than the inset from one texel to the next.
bool atCapCovered(int atlas, vec3 tile, vec3 q, vec3 n) {
  float dist = length(q);
  if (dist < 1e-4) return false;
  float s = tile.z - 2.0;
  vec2 f = clamp((atOctEncode(q / dist) * 0.5 + 0.5) * s - 0.5, vec2(0.0), vec2(s - 1.0));
  vec2 i = floor(f + 0.5);
  float stored = atTexel(atlas, ivec2(tile.xy) + ivec2(1) + ivec2(i));
  return atPlaneDist(i, s, q, n, dist) > stored - AT_CAP_EPS;
}

#if AT_TIER >= 3
// Soft-shadow taps on a golden-angle (Vogel) disc: tap i of n at radius sqrt((i + 0.5) / n), each one
// AT_GOLDEN further round from the per-pixel start direction. Computed, not read from a const array:
// ANGLE's HLSL for the array lookups in these unrolled loops cost ~0.7 s of D3D compile per world program.
const mat2 AT_GOLDEN = mat2(-0.7373688, 0.6754903, -0.6754903, -0.7373688);

// Interleaved gradient noise (per-pixel tap rotation; the grain hides the pattern).
float atIgn(vec2 px) {
  return fract(52.9829189 * fract(dot(px, vec2(0.06711056, 0.00583715))));
}

// PCSS-style soft shadow in a distance tile: a blocker search over the directions through which the
// light's disc (radius srcRadius ft) can be hidden from q, then a PCF disc sized by the penumbra
// estimate srcRadius·(d − dBlocker)/dBlocker (contact-hardening). Taps are clamped to the tile
// interior. Returns the lit fraction, or a fallback for the caller's atPcf: -1 = no blocker in the search
// disc (2x2 bilinear), -2 = penumbra under 1.25 texels (3x3). Calling atPcf from here instead inlined the
// filter twice more per atlas; D3D's compiler (ANGLE on Windows) took seconds per world program.
float atPcss(int atlas, vec3 tile, vec3 q, float eps, float srcRadius) {
  float dist = length(q);
  if (dist < 1e-4) return 1.0;
  vec2 uv = atOctEncode(q / dist);
  float s = tile.z - 2.0;
  vec2 f = (uv * 0.5 + 0.5) * s - 0.5;
  ivec2 base = ivec2(tile.xy) + ivec2(1);
  // Radians per texel of the octahedral map (average; the map is close to equal-area).
  float texAng = AT_SQRT_4PI / s;
  float a = atIgn(gl_FragCoord.xy) * 6.2831853;
  vec2 start = vec2(cos(a), sin(a));
  float searchTex = clamp(2.0 * srcRadius / (dist * texAng), 1.0, 16.0);
  float sum = 0.0;
  float n = 0.0;
  vec2 dir = start;
  for (int i = 0; i < 8; i++) {
    vec2 o = dir * (sqrt((float(i) + 0.5) / 8.0) * searchTex);
    dir = AT_GOLDEN * dir;
    float d = atTexel(atlas, base + ivec2(clamp(floor(f + o + 0.5), vec2(0.0), vec2(s - 1.0))));
    if (d + eps < dist) {
      sum += d;
      n += 1.0;
    }
  }
  if (n < 0.5) return -1.0;
  float dB = sum / n;
  float r = clamp(srcRadius * (dist - dB) / max(dB, 0.05) / (dist * texAng), 0.0, 14.0);
  if (r < 1.25) return -2.0;
  float lit = 0.0;
  dir = start;
  for (int i = 0; i < 12; i++) {
    vec2 o = dir * (sqrt((float(i) + 0.5) / 12.0) * r);
    dir = AT_GOLDEN * dir;
    float d = atTexel(atlas, base + ivec2(clamp(floor(f + o + 0.5), vec2(0.0), vec2(s - 1.0))));
    lit += step(dist, d + eps);
  }
  return lit / 12.0;
}
#endif

// Point-light shadow in one atlas: receiver normal offset q = p + n·k·d, k = 1.5·sqrt(4π)/(tile − 2),
// measured from the tile's capture origin (l3.xyz). Taps compare the receiver's own distance: receiver-plane
// distances would leak light at contacts (a floor's plane runs under the wall standing on it, and taps aimed
// there pass). Caps use the inset rule (AT_CAP_INSET): covered (probed on the cap's plane, see atCapCovered)
// → dark, else the same filter. l2 = (tile x, tile y, tile size, flags), l3.w = source radius. In cutaway
// views atPointLights skips this for caps above the cutaway plane lit from above it (see AT_CAP_INSET).
float atShadowIn(int atlas, vec4 l2, vec4 l3, vec3 p, vec3 n, bool cap) {
  vec3 rel = p - l3.xyz;
  float d = length(rel);
  float k = 1.5 * AT_SQRT_4PI / (l2.z - 2.0);
  int flags = int(l2.w + 0.5);
  bool wide = (flags & 1) != 0;
  // One atPcf call site: every inlined copy costs compile time on D3D (see atPcss).
  vec3 q;
  float eps;
  if (cap) {
    vec3 qc = rel - n * AT_CAP_INSET;
    // Probe coverage one filter footprint toward the light (octahedral.ts capCoverageProbe): a covering
    // slab extends past the cap, while a free cap's own far edge no longer reaches the probed texel.
    float sinA = max(dot(-rel, n) / max(d, 1e-4), 0.15);
    vec3 probe = qc + atHoriz(-rel) * min(0.5, k * d / sinA);
    if (atCapCovered(atlas, l2.xyz, probe, n)) return 0.0;
    q = qc;
    eps = -AT_CAP_EPS;
  } else {
    q = rel + n * (k * d);
    eps = AT_DIST_EPS;
#if AT_TIER >= 3
    if ((flags & 4) != 0) {
      float soft = atPcss(atlas, l2.xyz, q, eps, l3.w);
      if (soft >= 0.0) return soft;
      wide = soft < -1.5;
    }
#endif
  }
  return atPcf(atlas, l2.xyz, q, eps, wide);
}

float atPointShadow(vec4 l2, vec4 l3, vec3 p, vec3 n, bool cap) {
  int atlas = AT_ATLAS_LIGHT;
#if AT_TIER >= 3
  if ((int(l2.w + 0.5) & 2) != 0) atlas = AT_ATLAS_HI;
#endif
  return atShadowIn(atlas, l2, l3, p, n, cap);
}

// Slot bits of the point lights whose dim disc reaches p's cell (XZ, conservative: the loop still tests
// the 3D distance); every bit without a mask, none outside its grid (no disc reaches there).
uint atLightMaskAt(vec3 p) {
  if (uLightMaskGrid.w < 0.5) return 0xFFFFFFFFu;
  ivec2 size = textureSize(uLightMask, 0);
  ivec2 c = ivec2(floor((p.xz - uLightMaskGrid.xy) * uLightMaskGrid.z));
  if (c.x < 0 || c.y < 0 || c.x >= size.x || c.y >= size.y) return 0u;
  return texelFetch(uLightMask, c, 0).r;
}

// Sum of point-light radiance at p (culled by dim radius and N·L before any shadow tap). "lit" returns
// how surely some light grants at least dim light at p by the rules (static dim radius, not shadowed;
// softened over the last 0.5 ft and by the shadow filter), for the perception refinement.
// n = geometric normal (culling, shadow offsets); nb = shading normal (bump-mapped detail, or n).
// gloss > 0 adds a Blinn-Phong highlight toward the view direction v into spec (water, metal, marble).
vec3 atPointLights(vec3 p, vec3 n, vec3 nb, bool shadows, bool cap, out float lit, vec3 v, float gloss, inout vec3 spec) {
  vec3 sum = vec3(0.0);
  lit = 0.0;
  float specPow = 12.0 + 180.0 * gloss * gloss;
  // Slots whose dim disc misses this cell skip the uniform fetches (the same result as d >= dim below).
  uint mask = atLightMaskAt(p);
  // A uniform bound, not AT_MAX_LIGHTS + break: D3D's HLSL compiler (ANGLE on Windows) may unroll a
  // constant-bound loop, 32 copies of both shadow filters. With the constant bound, each world program
  // took ~2.4 s to compile on Firefox / D3D11 (serial: no parallel compile, see engine.ts).
  int count = min(uLightCount, AT_MAX_LIGHTS);
  for (int i = 0; i < count; i++) {
    if (((mask >> uint(i)) & 1u) == 0u) continue;
    vec4 l0 = uLights[i * 4];
    vec3 toL = l0.xyz - p;
    float d = length(toL);
    if (d >= l0.w) continue;
    float inRange = 1.0 - atSmoothstepSafe(l0.w - 0.5, l0.w, d);
    vec4 l2 = uLights[i * 4 + 2];
    vec3 L = toL / max(d, 1e-4);
    float lam = atSoftLambert(dot(n, L));
    if (lam <= 0.0) {
      // No light term. By the rules an unshadowed light still counts (it shines through everything); a
      // shadowed one would have to come through the surface's own solid.
      if (l2.z < 0.5) lit = max(lit, inRange);
      continue;
    }
#if AT_TIER >= 2
    lam = atSoftLambert(dot(nb, L)) * min(1.0, lam * 8.0);
#endif
    vec4 l1 = uLights[i * 4 + 1];
    float fall = atLightFalloff(d, l1.w, l0.w);
    float a = fall * lam;
    float sh = 1.0;
    // Caps strictly above the cutaway plane (walls reaching into the hidden storey's slab) get no light
    // from shadowed lights above it; walkable and vertical surfaces keep light coming down stairwells.
    if (shadows && l2.z > 0.5) sh = (cap && p.y > uCutawayY + AT_CAP_INSET && l0.y > uCutawayY) ? 0.0 : atPointShadow(l2, uLights[i * 4 + 3], p, n, cap);
    lit = max(lit, inRange * sh);
    sum += l1.rgb * (a * sh);
#if AT_TIER >= 2
    if (gloss > 0.0 && sh > 0.0) {
      float nh = max(dot(nb, normalize(L + v)), 0.0);
      spec += l1.rgb * (fall * sh * gloss * pow(nh, specPow) * (specPow + 8.0) * 0.04);
    }
#endif
  }
  return sum;
}

// Directional depth map with hardware PCF (sampler2DShadow, LINEAR → 2x2 per tap). m maps world to
// [0,1]^3 (standard depth); reversed depth buffers compare 1 - depth. Outside the map: lit. The
// receiver is looked up at p + n·normalOffset and compared at depth − bias (caps pass a negative
// offset and bias: from inside the solid, strictly).
float atDirShadow(sampler2DShadow map, mat4 m, vec3 p, vec3 n, float texel, float bias, float normalOffset, float reversed, bool fourTaps) {
  vec4 sc = m * vec4(p + n * normalOffset, 1.0);
  vec3 c = sc.xyz / sc.w;
  if (c.x <= 0.0 || c.y <= 0.0 || c.x >= 1.0 || c.y >= 1.0 || c.z >= 1.0) return 1.0;
  float ref = c.z - bias;
  ref = reversed > 0.5 ? 1.0 - ref : ref;
  if (!fourTaps) return texture(map, vec3(c.xy, ref));
  float h = 0.5 * texel;
  float s = texture(map, vec3(c.xy + vec2(-h, -h), ref));
  s += texture(map, vec3(c.xy + vec2(h, -h), ref));
  s += texture(map, vec3(c.xy + vec2(-h, h), ref));
  s += texture(map, vec3(c.xy + vec2(h, h), ref));
  return s * 0.25;
}

#if AT_TIER >= 3
// Wide, rotated Vogel-disc PCF on a directional depth map (soft shadows of the sun / moon on ultra).
float atDirShadowSoft(sampler2DShadow map, mat4 m, vec3 p, vec3 n, float texel, float bias, float normalOffset, float reversed) {
  vec4 sc = m * vec4(p + n * normalOffset, 1.0);
  vec3 c = sc.xyz / sc.w;
  if (c.x <= 0.0 || c.y <= 0.0 || c.x >= 1.0 || c.y >= 1.0 || c.z >= 1.0) return 1.0;
  float ref = c.z - bias;
  ref = reversed > 0.5 ? 1.0 - ref : ref;
  float a = atIgn(gl_FragCoord.xy) * 6.2831853;
  vec2 dir = vec2(cos(a), sin(a));
  float s = 0.0;
  for (int i = 0; i < 12; i++) {
    s += texture(map, vec3(c.xy + dir * (sqrt((float(i) + 0.5) / 12.0) * texel * 2.2), ref));
    dir = AT_GOLDEN * dir;
  }
  return s / 12.0;
}
#endif

// Ambient fill: mix of covered and sky-exposed fill by the sky exposure map (disabled in fog mode,
// where unexplored roofs are missing from the player's scene).
vec3 atFill(vec3 p, vec3 n, bool cap) {
  if (uSkyParams.w < 0.5) return uAmbient;
  // Caps: inset lookup, strict compare (bias in depth units scales like the positive one).
  float offset = cap ? -AT_CAP_INSET : uSkyParams.z;
  float bias = cap ? -uSkyParams.y * (AT_CAP_EPS / AT_DIR_BIAS_FT) : uSkyParams.y;
  float exposure = atDirShadow(uSkyShadow, uSkyMatrix, p, n, uSkyParams.x, bias, offset, uSunParams.z, false);
  return mix(uAmbient, uSkyAmbient, exposure);
}

vec3 atSunTerm(vec3 p, vec3 n, vec3 nb, bool cap, vec3 v, float gloss, inout vec3 spec) {
  if (uSunColor.r + uSunColor.g + uSunColor.b <= 0.0) return vec3(0.0);
  float lam = atSoftLambert(dot(n, uSunDir));
  if (lam <= 0.0) return vec3(0.0);
#if AT_TIER >= 2
  lam = atSoftLambert(dot(nb, uSunDir)) * min(1.0, lam * 8.0);
#endif
  // Caps: hardware PCF compares one depth against 2x2 texels, so a cap on an occluder's back-face plane
  // needs an inset that grows with the slope (1.5 texels × cot(elevation), uSunParams.w = 1.5 texels).
  float slope = min(length(uSunDir.xz) / max(uSunDir.y, 0.1), 10.0);
  float offset = cap ? -(AT_CAP_INSET + uSunParams.w * slope) : uSunParams.w;
  float bias = cap ? -uSunParams.y * (AT_CAP_EPS / AT_DIR_BIAS_FT) : uSunParams.y;
#if AT_TIER >= 3
  // Ultra: soft moon / sun shadows (12 rotated Vogel-disc taps of hardware PCF, ~3 texels wide); caps keep
  // the narrow filter their inset rule is tuned for.
  float sh = cap ? atDirShadow(uSunShadow, uSunMatrix, p, n, uSunParams.x, bias, offset, uSunParams.z, true) : atDirShadowSoft(uSunShadow, uSunMatrix, p, n, uSunParams.x, bias, offset, uSunParams.z);
#else
  float sh = atDirShadow(uSunShadow, uSunMatrix, p, n, uSunParams.x, bias, offset, uSunParams.z, true);
#endif
#if AT_TIER >= 2
  if (gloss > 0.0 && sh > 0.0) {
    float pw = 16.0 + 240.0 * gloss * gloss;
    spec += uSunColor * (sh * gloss * pow(max(dot(nb, normalize(uSunDir + v)), 0.0), pw) * (pw + 8.0) * 0.04);
  }
#endif
  return uSunColor * (lam * sh);
}

// Unit vector from p toward the viewer (orthographic cameras: the camera's back axis).
vec3 atViewDir(vec3 p) {
  if (isOrthographic) return normalize(vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]));
  return normalize(cameraPosition - p);
}

// ---- Masks & viewers --------------------------------------------------------------------------

// Filtered (perceived, explored, sunlit, grade/3) at a ground point, plus the nearest-texel grade.
vec4 atMaskSample(vec2 xz, int layer, out float grade) {
  grade = 0.0;
  if (layer < 0) return vec4(0.0);
  vec2 uv = xz * uMaskGrid.xy;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x >= 1.0 || uv.y >= 1.0) return vec4(0.0);
  ivec2 t = ivec2(min(floor(uv * uMaskGrid.zw), uMaskGrid.zw - 1.0));
  grade = floor(texelFetch(uMasks, ivec3(t, layer), 0).a * 3.0 + 0.5);
  return texture(uMasks, vec3(uv, float(layer)));
}

int atNearestViewer(vec3 p) {
  int best = -1;
  float bestD = 1e30;
  for (int v = 0; v < min(uViewerCount, AT_MAX_VIEWERS); v++) {
    vec3 dv = uViewers[v * 3].xyz - p;
    float d2 = dot(dv, dv);
    if (d2 < bestD) {
      bestD = d2;
      best = v;
    }
  }
  return best;
}

// How surely the environment grants at least dim light at p by the rules (ambient under cover, sky
// where exposed, the sun/moon where it reaches; tested 0.25 ft above the surface like the CPU samples).
// An upper bound: without a rendered map, or when unsure, it answers 1.
float atEnvLit(vec3 p, float sunGate) {
  if (uEnvLevels.x >= 1.0) return 1.0;
  float flags = uEnvLevels.w;
  float lit = 0.0;
  vec3 up = vec3(0.0, 1.0, 0.0);
  if (uEnvLevels.y >= 1.0) {
    if (mod(flags, 2.0) < 0.5) return 1.0;
    float e = atDirShadow(uSkyShadow, uSkyMatrix, p, up, uSkyParams.x, uSkyParams.y, 0.25, uSunParams.z, false);
    lit = min(e * 2.0, 1.0);
  }
  if (uEnvLevels.z >= 1.0 && lit < 1.0) {
    if (flags < 1.5) return 1.0;
    float sh = atDirShadow(uSunShadow, uSunMatrix, p, up, uSunParams.x, uSunParams.y, 0.25, uSunParams.z, true);
    lit = max(lit, min(sh * 2.0, 1.0) * sunGate);
  }
  return lit;
}

// Some viewer with blindsight has p within range.
bool atBlindsightAt(vec3 p) {
  for (int v = 0; v < min(uViewerCount, AT_MAX_VIEWERS); v++) {
    float r = uViewers[v * 3 + 1].w;
    if (r > 0.0 && distance(uViewers[v * 3].xyz, p) <= r) return true;
  }
  return false;
}

// Some viewer with darkvision has p within range ("dim is treated as bright").
bool atDarkvisionAt(vec3 p) {
  for (int v = 0; v < min(uViewerCount, AT_MAX_VIEWERS); v++) {
    vec4 v0 = uViewers[v * 3];
    if (v0.w > 0.0 && distance(v0.xyz, p) <= v0.w) return true;
  }
  return false;
}

// Strongest sense range at p over the viewers: 1 closer than range − edge, 0 beyond the range (3D from
// the eye, like the host's samples). slot 0 = darkvision, 1 = blindsight.
float atSenseWeight(vec3 p, int slot, float edge) {
  float best = 0.0;
  for (int v = 0; v < min(uViewerCount, AT_MAX_VIEWERS); v++) {
    float r = uViewers[v * 3 + slot].w;
    if (r > 0.0) best = max(best, 1.0 - atSmoothstepSafe(r - edge, r, distance(uViewers[v * 3].xyz, p)));
  }
  return best;
}

// p lies over some viewer's own footprint cells, which it perceives by touch (grade >= 1) whatever its
// senses (uViewers[3v + 2].w: half-extent of the square around the eye that covers them).
bool atTouched(vec3 p) {
  for (int v = 0; v < min(uViewerCount, AT_MAX_VIEWERS); v++) {
    vec2 d = abs(p.xz - uViewers[v * 3].xz);
    if (max(d.x, d.y) <= uViewers[v * 3 + 2].w) return true;
  }
  return false;
}

// GPU line of sight can veto perception right now: refinement on and every viewer has a captured tile.
bool atLosReady() {
  if (uGpuRefine < 0.5 || uViewerCount <= 0) return false;
  for (int v = 0; v < min(uViewerCount, AT_MAX_VIEWERS); v++) {
    if (uViewers[v * 3 + 1].z < 0.5) return false;
  }
  return true;
}

// Host masks for a world surface (ARCHITECTURE §4.1 step 3): walkable → at p; other faces → the cell the
// face faces (p.xz + n.xz·0.3); caps → the cell on the nearest viewer's side (0.6 ft toward it). That
// suits thin caps (wall tops), but for a table, bed or tree canopy it lands under the object, which the
// viewer usually cannot see, and the top would render as a hole. So when GPU line of sight is active
// (it then tests the cap itself and removes perception it cannot confirm), perception may also come
// from 2.5 and 5 ft toward the viewer (the near edge of props up to ~10 ft across). Explored / sunlit
// always come from the 0.6 ft cell: farther lookups could cross a wall.
vec4 atSurfaceMask(vec3 p, vec3 n, float surf, int layer, out float grade) {
  if (surf < 0.5) return atMaskSample(p.xz, layer, grade);
  if (surf > 1.5) {
    int v = atNearestViewer(p);
    if (v >= 0) {
      vec3 h = atHoriz(uViewers[v * 3].xyz - p);
      if (dot(h, h) > 0.5) {
        vec4 best = atMaskSample(p.xz + h.xz * 0.6, layer, grade);
        if (best.r < 1.0 && atLosReady()) {
          for (int k = 0; k < 2; k++) {
            float g;
            vec4 m = atMaskSample(p.xz + h.xz * (k == 0 ? 2.5 : 5.0), layer, g);
            if (m.r > best.r) {
              best.r = m.r;
              best.a = m.a;
              grade = g;
            }
          }
        }
        return best;
      }
    }
  }
  return atMaskSample(p.xz + n.xz * 0.3, layer, grade);
}

// Per-pixel line of sight against the viewer atlas (only ever REMOVES host perception). Returns the
// best visible fraction over viewers; 1 when refinement is off or a viewer has no tile yet.
float atViewerLos(vec3 p, vec3 n, float surf) {
  if (uGpuRefine < 0.5 || uViewerCount <= 0) return 1.0;
  float best = 0.0;
  for (int v = 0; v < min(uViewerCount, AT_MAX_VIEWERS); v++) {
    vec4 v1 = uViewers[v * 3 + 1];
    if (v1.z < 0.5) return 1.0;
    vec3 eye = uViewers[v * 3 + 2].xyz;
    vec3 test;
    if (surf < 0.5) {
      test = p + vec3(0.0, 0.25, 0.0);
    } else if (surf < 1.5) {
      if (dot(n, eye - p) <= 0.0) continue;
      test = p - n * 0.05;
    } else {
      test = p - n * AT_CAP_LOS_INSET + atHoriz(eye - p) * 0.1;
    }
    vec3 rel = test - eye;
    float d = length(rel);
    float k = 1.5 * AT_SQRT_4PI / (v1.z - 2.0);
    // Caps keep their test point inside the solid (no outward normal offset): pushed up past the top
    // it would sit in free space the eye can only reach through the wall, and flicker.
    vec3 q = surf > 1.5 ? rel : rel + n * (k * d);
    float vis = atPcf(AT_ATLAS_VIEWER, v1.xyz, q, AT_DIST_EPS, false);
    best = max(best, vis);
    if (best >= 1.0) break;
  }
  return best;
}

// Albedo luma compressed toward the middle, for the monochrome senses: dark materials (barrels,
// iron, dark wood) stay readable instead of vanishing into black.
float atSenseTone(vec3 albedo) {
  float a = atLuma(albedo);
  return 0.25 + 0.75 * a / (a + 0.15);
}

// Form shading for the monochrome senses (no light direction): tops brighter than sides.
float atSenseShade(vec3 n) {
  return 0.82 + 0.18 * max(n.y, 0.0);
}

// Perceived colour by grade: 3 colour (dim lifted to bright for darkvision), 2 greyscale darkvision,
// 1 blindsight (desaturated + tint). dv = darkvision weight at p (1 in range, fading to 0 over the last
// AT_DV_FEATHER ft, so the lift has no hard arc at the range edge).
vec3 atGradeColour(float grade, vec3 albedo, vec3 light, float dv, vec3 n) {
  vec3 lit = albedo * light;
  float tone = atSenseTone(albedo) * atSenseShade(n);
  if (grade > 2.5) {
    // Lift by the light the surface actually reflects (a blue moon barely lights brown dirt), so the
    // floor is the same for every hue.
    float received = atLuma(lit) / max(atLuma(albedo), 1e-3);
    float lift = max(mix(AT_DIM_FLOOR, AT_BRIGHT_FLOOR, dv) - received, 0.0);
    vec3 c = lit + albedo * lift;
    // Darkvision: a lit surface never reads darker than the same surface in darkness (its grey). With
    // dark albedo (night-painted battlemaps) AT_BRIGHT_FLOOR × albedo falls below the tone-compressed grey,
    // and the edge of a light would show dark colour next to brighter grey. The colour is scaled toward
    // the grey's luma (hue kept) up to AT_DV_MAX_GAIN, and only what that cannot reach is added as grey:
    // adding all of it as flat grey washed painted night maps out into a milky disc.
    float target = AT_DARKVISION_LEVEL * tone;
    float l = atLuma(c);
    if (dv > 0.0 && l < target) {
      vec3 raised = c * min(target / max(l, 1e-4), AT_DV_MAX_GAIN);
      raised += vec3(max(target - atLuma(raised), 0.0));
      c = mix(c, raised, dv);
    }
    return c;
  }
  if (grade > 1.5) return vec3(max(atLuma(lit), AT_DARKVISION_LEVEL * tone));
  return vec3(AT_BLINDSIGHT_LEVEL * tone) + AT_BLINDSIGHT_TINT;
}

// DM dark vision look of a lifted colour c, weighted by w (0 = untouched): desaturated, blue, striped.
vec3 atDarkVisionLook(vec3 c, float w) {
  vec3 dv = mix(c, vec3(atLuma(c)), AT_DM_DV_DESAT) * AT_DM_DV_TINT;
  // Diagonal hatch lines a third of the period wide: triangle wave across them, edges smoothed over
  // about a pixel.
  float period = max(uDarkVision.y, 3.0);
  float t = abs(fract((gl_FragCoord.x + gl_FragCoord.y) / period) - 0.5) * 2.0;
  float e = 2.0 / period;
  dv *= 1.0 - AT_DM_DV_STRIPE * smoothstep(0.67 - e, 0.67 + e, t);
  return mix(c, dv, w);
}

// DM colour (vision off): the lit colour, lifted to AT_DM_LIT_FLOOR where at least dim-lit (litHere = 1)
// and to AT_DM_FLOOR elsewhere (AT_DM_DV_FLOOR, marked, with dark vision on).
vec3 atDmColour(vec3 albedo, vec3 light, float litHere) {
  vec3 lit = albedo * light;
  float received = atLuma(lit) / max(atLuma(albedo), 1e-3);
  float l = clamp(litHere, 0.0, 1.0);
  bool dv = uDarkVision.x > 0.5;
  vec3 c = lit + albedo * max(mix(dv ? AT_DM_DV_FLOOR : AT_DM_FLOOR, AT_DM_LIT_FLOOR, l) - received, 0.0);
  return dv ? atDarkVisionLook(c, 1.0 - l) : c;
}

// Explored memory: desaturated albedo x constant, no light terms.
vec3 atMemory(vec3 albedo) {
  return mix(albedo, vec3(atLuma(albedo)), 0.8) * AT_MEMORY_SCALE;
}

// DM preview of unperceived areas: darkened, never hidden.
vec3 atPreviewDark(vec3 lit, vec3 albedo) {
  return max(mix(lit, vec3(atLuma(lit)), 0.5) * AT_PREVIEW_SCALE, atMemory(albedo) * 0.8);
}

vec4 atOutput(vec3 col, float alpha) {
  vec4 c = vec4(col, alpha);
#ifdef TONE_MAPPING
  c.rgb = toneMapping(c.rgb);
#endif
  return linearToOutputTexel(c);
}
`

/**
 * World-space position / normal / albedo with instancing (three's USE_INSTANCING / USE_INSTANCING_COLOR
 * defines are set per object). Normals use the inverse-transpose trick for rotation × scale matrices.
 * Positions follow three's project_vertex order so depth matches built-in materials.
 */
export const VERTEX_TRANSFORM_GLSL = /* glsl */ `
vec3 atObjectNormal(vec3 objNormal) {
#ifdef USE_INSTANCING
  mat3 im = mat3(instanceMatrix);
  objNormal = im * (objNormal / vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2])));
#endif
  mat3 mm = mat3(modelMatrix);
  return mm * (objNormal / vec3(dot(mm[0], mm[0]), dot(mm[1], mm[1]), dot(mm[2], mm[2])));
}

vec4 atLocalPosition(vec3 pos) {
  vec4 local = vec4(pos, 1.0);
#ifdef USE_INSTANCING
  local = instanceMatrix * local;
#endif
  return local;
}
`
