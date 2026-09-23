/**
 * Cube → octahedral tile re-encode pass (ARCHITECTURE §4.2), mirrored by render/shadows/octahedral.ts
 * (tileTexelDirections / reencodeTexel). A full-screen triangle is drawn with viewport + scissor set to
 * one tile; every tile texel (including the 1-texel guard ring, filled through the octahedral wrap)
 * stores the MIN of 4 cube taps inside its footprint, which keeps the map conservative.
 *
 * The cube was written by THREE.CubeCamera (WebGL coordinate system), so a plain world direction
 * addresses it directly (verified in render/shadows/cubeConvention.test.ts).
 */

export const REENCODE_VERTEX_SHADER = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`

export const REENCODE_FRAGMENT_SHADER = /* glsl */ `
layout(location = 0) out highp vec4 atFragColor;

uniform samplerCube uCube;
// Atlas texel of the tile's lower-left corner (guard included) and tile size in texels.
uniform vec2 uTileOrigin;
uniform float uTileSize;

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

void main() {
  // Interior coordinate: -1 and S are the guard ring.
  vec2 i = floor(gl_FragCoord.xy) - uTileOrigin - 1.0;
  float s = uTileSize - 2.0;
  float m = 1e30;
  for (int k = 0; k < 4; k++) {
    vec2 sub = vec2((k == 1 || k == 3) ? 0.75 : 0.25, k >= 2 ? 0.75 : 0.25);
    vec2 uv = atOctWrap(((i + sub) / s) * 2.0 - 1.0);
    m = min(m, texture(uCube, atOctDecode(uv)).r);
  }
  atFragColor = vec4(m, 0.0, 0.0, 1.0);
}
`
