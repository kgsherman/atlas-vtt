/**
 * Procedural surface detail for the world shader (quality tier ≥ medium; AT_TIER from the lighting
 * system): value noise in world space (feet), grout / seam patterns, per-stone and per-plank tint,
 * animated water. Output: an albedo multiplier, a gloss factor and a height (feet) that the tiers with
 * bump mapping turn into a perturbed shading normal via screen-space derivatives.
 *
 * Cost is fixed and branch-free: every material is a row of parameters (uMatTable) driving ONE
 * pattern (running bond / square / planks), 3 (medium) or 4 (high / ultra; 5 when zoomed in close)
 * noise texture taps and a handful of mixes; floors covered by a battlemap skip it entirely. (A chain
 * of per-material branches is flattened by some shader compilers — ANGLE's D3D backend — into running
 * every branch for every pixel, which cost ~8 ms at 2 MP on an integrated GPU.) Only high / ultra add
 * the few material "specials" (Voronoi cobbles, marble veins, water sparkle) in one small switch.
 *
 * Detail fades by pixel footprint (fw, world feet per pixel), so zoomed-out views never alias into
 * moiré: features smaller than a few pixels resolve to their average. Magnified past a few pixels per
 * lattice cell, the fine band (high / ultra) averages two rotated lattices, where one turns blocky.
 *
 * Material ids: materials/surface.ts MAT (mirrored by AT_MAT_* here).
 */

/** Rows of the material tables, in MAT id order (materials/surface.ts). */
export const DETAIL_MATERIAL_COUNT = 16

export const DETAIL_GLSL = /* glsl */ `
#define AT_MAT_NONE 0
#define AT_MAT_STONE 1
#define AT_MAT_BRICK 2
#define AT_MAT_WOOD 3
#define AT_MAT_PLASTER 4
#define AT_MAT_DIRT 5
#define AT_MAT_GRASS 6
#define AT_MAT_SAND 7
#define AT_MAT_WATER 8
#define AT_MAT_METAL 9
#define AT_MAT_MARBLE 10
#define AT_MAT_TILE 11
#define AT_MAT_COBBLE 12
#define AT_MAT_FOLIAGE 13
#define AT_MAT_FABRIC 14
#define AT_MAT_ROCK 15

// Material parameters (materials/surface.ts SURFACE_TABLE), AT_MAT_ROWS vec4 per material:
//   [0] pattern on up-facing surfaces: type (0 none, 1 running bond, 2 square, 3 planks), cell size x, y (ft), grout width (ft)
//   [1] the same for faces (uv = along the face, height)
//   [2] per-cell tint amount, grout colour multiplier, grout depth (ft), gloss
//   [3] macro amount (1 octave at 0.08 / ft), low-band scale, low-band amount, low-band relief (ft)
//   [4] fine noise scale u, v (anisotropic: wood grain, brushed metal), amount, feature size (ft)
//   [5] hue swing (warm ↔ cool; grass dry ↔ lush), flow speed (water, ft/s), -, -
// A uniform array: dynamic indexing of const arrays turns into compare chains on some backends.
#define AT_MAT_ROWS 6
uniform vec4 uMatTable[96];
// 256² RGBA random values, repeat-wrapped, bilinear (materials/surface.ts noiseTexture).
uniform sampler2D uNoise;


// Hash without sine (Dave Hoskins), stable for world coordinates up to a few thousand feet.
float atHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 atHash2(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// Value noise in [0, 1] with C1 interpolation from ONE bilinear fetch of a tiling 256² random texture
// (the smoothstep is applied to the texel coordinate). Four independent channels; hash-based value noise
// cost ~1.6 ms per evaluation at 2 MP on an integrated GPU, this is a single texture tap.
vec4 atNoise4(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return textureLod(uNoise, (i + f + 0.5) * (1.0 / 256.0), 0.0);
}

// 1 while a feature of world size s is resolved at pixel footprint fw, fading to 0 below ~2 pixels.
float atFeature(float s, float fw) {
  return 1.0 - atSmoothstepSafe(0.2 * s, 0.6 * s, fw);
}

// 0 while a noise lattice cell of world size s spans at most ~3 pixels at footprint fw, 1 from ~6.
float atMagnified(float s, float fw) {
  return atSmoothstepSafe(3.0 * fw, 6.0 * fw, s);
}

// Grout / seam coverage of a rectangular cell pattern: f = position in the cell (0..1 square), size =
// cell size (ft), g = grout width (ft). Anti-aliased by fw; sub-pixel grout resolves to its average.
float atGrout(vec2 f, vec2 size, float g, float fw) {
  vec2 d = min(f, 1.0 - f) * size;
  float e = min(d.x, d.y);
  float line = 1.0 - atSmoothstepSafe(g * 0.5 - fw * 0.5, g * 0.5 + fw * 0.5, e);
  float avg = min(1.0, g * (size.x + size.y) / (size.x * size.y));
  return mix(line, avg, atSmoothstepSafe(g * 0.75, g * 2.5, fw));
}

// Surface coordinates (ft): the ground plane for up/down-facing surfaces, (along the face, height) for
// faces (axis picked by the dominant horizontal normal component).
vec2 atSurfaceUv(vec3 p, vec3 n) {
  if (abs(n.y) > 0.7) return p.xz;
  return abs(n.x) > abs(n.z) ? vec2(p.z, p.y) : vec2(p.x, p.y);
}

#if AT_TIER >= 2
// Cellular (Voronoi) distances F1, F2 and the nearest cell id, for cobbles.
vec2 atVoronoi(vec2 uv, out vec2 id) {
  vec2 i = floor(uv);
  vec2 f = fract(uv);
  float f1 = 8.0;
  float f2 = 8.0;
  id = i;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = 0.15 + 0.7 * atHash2(i + g);
      float d = length(g + o - f);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = i + g;
      } else if (d < f2) {
        f2 = d;
      }
    }
  }
  return vec2(f1, f2);
}
#endif

// Surface detail of material m at p (geometric normal n). Returns (albedo multiplier, gloss) and the
// relief height in feet. weight scales everything (backdrop coverage fades it out).
vec4 atSurfaceDetail(vec3 p, vec3 n, float m, float fw, float weight, out float height) {
  height = 0.0;
  if (weight < 0.02 || m < 0.5) return vec4(1.0, 1.0, 1.0, 0.0);
  int mat = clamp(int(m + 0.5), 0, 15);
  bool up = abs(n.y) > 0.7;
  vec2 uv = atSurfaceUv(p, n);
  int row0 = mat * AT_MAT_ROWS;
  vec4 pat = uMatTable[row0 + (up ? 0 : 1)];
  vec4 cell = uMatTable[row0 + 2];
  vec4 lo = uMatTable[row0 + 3];
  vec4 hi = uMatTable[row0 + 4];
  vec4 misc = uMatTable[row0 + 5];

  // Pattern: running bond (odd rows shifted by half), planks (random stagger per row) or square.
  vec2 size = pat.yz;
  float row = floor(uv.y / size.y);
  float shift = pat.x < 1.5 ? 0.5 * mod(row, 2.0) : pat.x > 2.5 ? atHash(vec2(row, 7.3)) : 0.0;
  float x = uv.x / size.x + shift;
  vec2 id = vec2(floor(x), row);
  vec2 f = vec2(fract(x), fract(uv.y / size.y));
  float patterned = step(0.5, pat.x);
  float g = atGrout(f, size, pat.w, fw) * patterned;
  float h = atHash(id) * patterned + 0.5 * (1.0 - patterned);

  // Noise: a macro octave against tiling, a low band (2 octaves on high / ultra; animated for water) and
  // a fine band (high / ultra).
  vec2 flow = vec2(0.9, 0.55) * (misc.y * uTime);
  float macro = atNoise4(mat2(0.8, -0.6, 0.6, 0.8) * uv * 0.08 + 3.7).r;
  float n1 = atNoise4(uv * lo.y + flow + h * 13.0).g;
#if AT_TIER >= 2
  float n2 = atNoise4(mat2(0.8, 0.6, -0.6, 0.8) * uv * (lo.y * 2.03) - flow * 1.7 + 17.13).b;
  float nLo = n1 * 0.6667 + n2 * 0.3333;
  vec2 fuv = uv * hi.xy + h * 31.0 + flow * 2.0;
  float fine = atNoise4(fuv).a;
  // Magnified past ~3 px per lattice cell, value noise shows its square cells as blocks: blend in a
  // second tap on a rotated lattice (variance restored), like medium's low band. Only then: the branch
  // is coherent across the screen, so ordinary zooms skip the extra tap.
  float mag = atMagnified(1.0 / max(max(hi.x, hi.y), 1e-3), fw);
  if (mag > 0.0) {
    float fine2 = atNoise4(mat2(0.8, 0.6, -0.6, 0.8) * fuv + 11.3).a;
    fine = mix(fine, 0.5 + (fine + fine2 - 1.0) * 0.7071, mag);
  }
  float nHi = mix(0.5, fine, atFeature(hi.w, fw));
#else
  // Medium: one more tap of the low band on a rotated, rescaled lattice hides value noise's square cells.
  float n2 = atNoise4(mat2(0.8, 0.6, -0.6, 0.8) * uv * (lo.y * 1.73) + 41.7).b;
  float nLo = n1 * 0.6 + n2 * 0.4;
  float nHi = 0.5;
#endif

  float t = (1.0 + (h - 0.5) * cell.x) * (1.0 + (macro - 0.5) * lo.x * 2.0) * (1.0 + (nLo - 0.5) * lo.z * 2.0) * (1.0 + (nHi - 0.5) * hi.z * 2.0);
  // Hue swing: warm where the variation is high, cool where low (grass: dry ↔ lush).
  float swing = ((macro - 0.5) + (nLo - 0.5) * 0.5) * misc.x;
  vec3 tint = t * vec3(1.0 + swing, 1.0 + swing * 0.3, 1.0 - swing * 1.2);
  tint = mix(tint, vec3(cell.y), g);
  height = (1.0 - g) * cell.z + nLo * lo.w;
  float gloss = cell.w;

#if AT_TIER >= 2
  // Specials (high / ultra): rounded cobbles, marble veins, water sparkle.
  if (mat == AT_MAT_COBBLE) {
    vec2 vid;
    vec2 v = atVoronoi(uv * 1.05, vid);
    float edge = v.y - v.x;
    float vg = 1.0 - atSmoothstepSafe(0.05, 0.05 + fw * 2.2, edge);
    vg = mix(vg, 0.25, atSmoothstepSafe(0.15, 0.45, fw));
    float vh = atHash(vid);
    tint = vec3(1.0 + (vh - 0.5) * 0.34) * (1.0 + (nHi - 0.5) * 0.24);
    tint = mix(tint, vec3(0.42), vg);
    height = atSmoothstepSafe(0.0, 0.35, edge) * 0.07;
  } else if (mat == AT_MAT_MARBLE) {
    // Soft, irregular veins: a warped sine band, widened and faded by the fine noise.
    float veins = abs(sin(uv.x * 0.35 + uv.y * 0.22 + nLo * 4.0 + macro * 5.0));
    tint *= 1.0 - 0.28 * pow(1.0 - veins, 5.0) * (0.6 + 0.8 * nHi) * atFeature(0.3, fw);
  } else if (mat == AT_MAT_WATER) {
    tint = vec3(0.62, 0.72, 0.78) * (0.8 + 0.45 * nLo) + vec3(0.1, 0.14, 0.16) * pow(1.0 - abs(n2 * 2.0 - 1.0), 10.0) * atFeature(0.3, fw);
  }
#else
  if (mat == AT_MAT_WATER) tint = vec3(0.62, 0.72, 0.78) * (0.8 + 0.45 * nLo);
#endif

  float w = weight * step(0.5, float(mat));
  height *= w;
  return vec4(mix(vec3(1.0), tint, w), gloss * w);
}

#if AT_TIER >= 2
// Bump mapping from a scalar height (ft) with screen-space derivatives (Mikkelsen, "Bump Mapping
// Unparametrized Surfaces on the GPU"). Call in uniform control flow.
vec3 atBumpNormal(vec3 p, vec3 n, float h) {
  vec3 dpdx = dFdx(p);
  vec3 dpdy = dFdy(p);
  float dhx = dFdx(h);
  float dhy = dFdy(h);
  vec3 r1 = cross(dpdy, n);
  vec3 r2 = cross(n, dpdx);
  float det = dot(dpdx, r1);
  if (abs(det) < 1e-10) return n;
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  vec3 b = normalize(abs(det) * n - grad);
  // Keep the shading normal in the geometric hemisphere.
  return dot(b, n) > 0.2 ? b : n;
}
#endif
`
