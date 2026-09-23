/**
 * GLSL of the post-processing passes (render/post/pipeline.ts). All passes draw one full-screen triangle
 * (vertex shader FULLSCREEN_VERTEX) with GLSL3 ShaderMaterials.
 */

export const FULLSCREEN_VERTEX = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

const LUMA = /* glsl */ `
float ppLuma(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}
`

/**
 * Bloom prefilter + first downsample (full → half resolution): soft-knee threshold on the brightest
 * channel (only emissive flames and glows exceed it; lit surfaces stay below) and a Karis-weighted 4-tap
 * average against fireflies.
 */
export const BLOOM_PREFILTER_FRAGMENT = /* glsl */ `
layout(location = 0) out highp vec4 ppOut;
in vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
// x = threshold, y = soft knee, z = max brightness (clamp), w = unused
uniform vec4 uThreshold;
${LUMA}
vec3 ppPrefilter(vec3 c) {
  c = min(c, vec3(uThreshold.z));
  float br = max(c.r, max(c.g, c.b));
  float k = uThreshold.y;
  float soft = clamp(br - uThreshold.x + k, 0.0, 2.0 * k);
  soft = soft * soft / (4.0 * k + 1e-5);
  return c * (max(soft, br - uThreshold.x) / max(br, 1e-5));
}
void main() {
  vec3 a = ppPrefilter(texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb);
  vec3 b = ppPrefilter(texture(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb);
  vec3 c = ppPrefilter(texture(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb);
  vec3 d = ppPrefilter(texture(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb);
  float wa = 1.0 / (1.0 + ppLuma(a));
  float wb = 1.0 / (1.0 + ppLuma(b));
  float wc = 1.0 / (1.0 + ppLuma(c));
  float wd = 1.0 / (1.0 + ppLuma(d));
  ppOut = vec4((a * wa + b * wb + c * wc + d * wd) / (wa + wb + wc + wd), 1.0);
}
`

/** 4 bilinear taps on the diagonals (a 4×4 texel box) for each halving of the bloom chain. */
export const BLOOM_DOWN_FRAGMENT = /* glsl */ `
layout(location = 0) out highp vec4 ppOut;
in vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
void main() {
  vec3 s = texture(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  s += texture(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  s += texture(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  s += texture(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  ppOut = vec4(s * 0.25, 1.0);
}
`

/** 9-tap tent upsample, blended additively into the next larger level (weight uWeight). */
export const BLOOM_UP_FRAGMENT = /* glsl */ `
layout(location = 0) out highp vec4 ppOut;
in vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uWeight;
void main() {
  vec2 t = uTexel;
  vec3 s = texture(tSrc, vUv).rgb * 4.0;
  s += (texture(tSrc, vUv + vec2(-t.x, 0.0)).rgb + texture(tSrc, vUv + vec2(t.x, 0.0)).rgb + texture(tSrc, vUv + vec2(0.0, -t.y)).rgb + texture(tSrc, vUv + vec2(0.0, t.y)).rgb) * 2.0;
  s += texture(tSrc, vUv + vec2(-t.x, -t.y)).rgb + texture(tSrc, vUv + vec2(t.x, -t.y)).rgb + texture(tSrc, vUv + vec2(-t.x, t.y)).rgb + texture(tSrc, vUv + vec2(t.x, t.y)).rgb;
  ppOut = vec4(s * (uWeight / 16.0), 1.0);
}
`

/**
 * Screen-space ambient obscurance (Alchemy / SAO style) from the resolved depth buffer, at half
 * resolution: view-space positions from depth (perspective or orthographic via the inverse projection),
 * normals from the flatter of the neighbouring depth differences, 12 spiral taps within a world radius.
 */
export const AO_FRAGMENT = /* glsl */ `
layout(location = 0) out highp vec4 ppOut;
in vec2 vUv;
uniform sampler2D tDepth;
uniform mat4 uProj;
uniform mat4 uProjInv;
// x = radius (ft), y = intensity, z = bias (ft), w = unused
uniform vec4 uAo;
// Full-resolution depth texel size.
uniform vec2 uTexel;

vec3 ppViewPos(vec2 uv) {
  float d = texture(tDepth, uv).r;
  vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return v.xyz / v.w;
}

void main() {
  float d0 = texture(tDepth, vUv).r;
  if (d0 >= 0.99999) {
    ppOut = vec4(1.0);
    return;
  }
  vec3 p = ppViewPos(vUv);
  vec3 l = ppViewPos(vUv - vec2(uTexel.x, 0.0));
  vec3 r = ppViewPos(vUv + vec2(uTexel.x, 0.0));
  vec3 b = ppViewPos(vUv - vec2(0.0, uTexel.y));
  vec3 t = ppViewPos(vUv + vec2(0.0, uTexel.y));
  vec3 dx = abs(r.z - p.z) < abs(p.z - l.z) ? r - p : p - l;
  vec3 dy = abs(t.z - p.z) < abs(p.z - b.z) ? t - p : p - b;
  vec3 n = normalize(cross(dx, dy));
  // Screen radius of the world radius at p.
  vec4 c0 = uProj * vec4(p, 1.0);
  vec4 c1 = uProj * vec4(p + vec3(uAo.x, 0.0, 0.0), 1.0);
  float rUv = abs(c1.x / c1.w - c0.x / c0.w) * 0.5;
  rUv = min(rUv, 0.1);
  if (rUv < uTexel.x * 1.5) {
    ppOut = vec4(1.0);
    return;
  }
  float a = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) * 6.2831853;
  float sum = 0.0;
  float r2 = uAo.x * uAo.x;
  for (int i = 0; i < 12; i++) {
    float fi = (float(i) + 0.5) / 12.0;
    float ang = a + float(i) * 2.39996323;
    vec2 o = vec2(cos(ang), sin(ang)) * rUv * fi;
    vec3 q = ppViewPos(vUv + o);
    vec3 v = q - p;
    float vv = dot(v, v);
    float fall = max(0.0, 1.0 - vv / r2);
    sum += fall * max(0.0, dot(v, n) - uAo.z) / (vv + 0.05);
  }
  float ao = max(0.0, 1.0 - sum * uAo.y * (2.0 / 12.0));
  ppOut = vec4(ao, ao, ao, 1.0);
}
`

/** Separable depth-aware blur of the AO (direction uDir in texels of the AO target). */
export const AO_BLUR_FRAGMENT = /* glsl */ `
layout(location = 0) out highp vec4 ppOut;
in vec2 vUv;
uniform sampler2D tAo;
uniform sampler2D tDepth;
uniform vec2 uDir;
uniform vec2 uNear;
float ppLinear(float d) {
  // Only relative differences matter: 1 / (1 - d) grows with distance for perspective depth.
  return 1.0 / max(1.0 - d, 1e-5);
}
void main() {
  float d0 = ppLinear(texture(tDepth, vUv).r);
  float sum = 0.0;
  float wsum = 0.0;
  for (int i = -3; i <= 3; i++) {
    vec2 uv = vUv + uDir * float(i);
    float d = ppLinear(texture(tDepth, uv).r);
    float w = exp(-float(i * i) * 0.18) * max(0.0, 1.0 - abs(d - d0) / (d0 * 0.02 + 1e-4));
    sum += texture(tAo, uv).r * w;
    wsum += w;
  }
  float ao = wsum > 1e-4 ? sum / wsum : texture(tAo, vUv).r;
  ppOut = vec4(ao, ao, ao, 1.0);
}
`

/**
 * Final composite to the canvas: AO, bloom (gated so it never lights pure-black unexplored pixels in
 * player fog mode), exposure, tone mapping (Reinhard like the direct path, or the ultra tier's filmic
 * curve with a subtle night grade), vignette, film grain, dithering. Writes the scene's depth so the
 * overlay pass that follows is depth-tested against the world.
 */
export const OUTPUT_FRAGMENT = /* glsl */ `
layout(location = 0) out highp vec4 ppOut;
in vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tBloom;
uniform sampler2D tAo;
uniform sampler2D tDepth;
// x = bloom strength, y = AO strength, z = vignette, w = grain
uniform vec4 uPost;
// x = exposure, y = tone curve (0 Reinhard, 1 filmic), z = fog gate (1 = player fog of war), w = time
uniform vec4 uPost2;
// Drawing buffer size (px).
uniform vec2 uResolution;
// Debug view: 0 = final, 1 = AO, 2 = bloom.
uniform int uDebug;
${LUMA}
float ppHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

// Hue-preserving luminance curve in the darks and mids (extended Reinhard, white point W), per-channel
// roll-off in the highlights so bright flames desaturate toward white; a gentle perceptual S-curve.
vec3 ppFilmic(vec3 x) {
  const float W2 = 36.0;
  float l = ppLuma(x);
  float lt = l * (1.0 + l / W2) / (1.0 + l);
  vec3 hue = x * (lt / max(l, 1e-6));
  vec3 chan = x * (1.0 + x / W2) / (1.0 + x);
  vec3 c = clamp(mix(hue, chan, smoothstep(0.2, 0.85, lt)), 0.0, 1.0);
  vec3 s = sqrt(c);
  s = mix(s, s * s * (3.0 - 2.0 * s), 0.22);
  c = s * s;
  // Night grade: a touch of blue in the shadows, warmth in the highlights.
  float y = ppLuma(c);
  c *= 1.0 + vec3(-0.05, -0.01, 0.07) * (1.0 - smoothstep(0.02, 0.25, y)) + vec3(0.05, 0.015, -0.05) * smoothstep(0.45, 1.0, y);
  return c;
}

void main() {
  vec3 c = texture(tScene, vUv).rgb;
  float gate = uPost2.z > 0.5 ? smoothstep(0.0, 0.003, ppLuma(c)) : 1.0;
  if (uPost.y > 0.0) c *= mix(1.0, texture(tAo, vUv).r, uPost.y);
  if (uPost.x > 0.0) c += texture(tBloom, vUv).rgb * (uPost.x * gate);
  c *= uPost2.x;
  c = uPost2.y > 0.5 ? ppFilmic(c) : c / (1.0 + c);
  vec2 q = (vUv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
  c *= 1.0 - uPost.z * smoothstep(0.3, 1.15, length(q));
  float lit = step(1e-6, max(c.r, max(c.g, c.b)));
  vec4 o = linearToOutputTexel(vec4(max(c, 0.0), 1.0));
  if (uPost.w > 0.0) {
    // Film grain in display space, strongest in the mid-tones (pure black stays black).
    float y = ppLuma(o.rgb);
    float g = ppHash(gl_FragCoord.xy + fract(uPost2.w * 7.13) * 431.0) - 0.5;
    o.rgb += g * uPost.w * (0.15 + 3.4 * y * (1.0 - y)) * lit * gate;
  }
  // ±0.5 LSB dither against banding in the dark gradients (pure black stays black).
  o.rgb += (ppHash(gl_FragCoord.xy * 1.37 + 11.0) - 0.5) / 255.0 * lit;
  if (uDebug == 1) o = vec4(vec3(texture(tAo, vUv).r), 1.0);
  if (uDebug == 2) o = linearToOutputTexel(vec4(texture(tBloom, vUv).rgb * uPost.x * 4.0, 1.0));
  ppOut = o;
  gl_FragDepth = texture(tDepth, vUv).r;
}
`
