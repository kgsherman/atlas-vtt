/**
 * Anti-aliased screen-space line segments for overlays (selection / hover / hidden outlines, light radius
 * rings, tool preview outlines). The canvas has no MSAA (engine.ts), so 1-px GL lines were jagged; each
 * segment is instead a quad expanded in clip space to `uWidth` CSS pixels (+ half a pixel per side),
 * whose across coordinate fades over one pixel at the nominal edge with fwidth (edgeAAMaterial's rule).
 * Widths are constant in pixels at every zoom. Segments that cross the camera's near plane are trimmed
 * to it (perspective), like three's LineSegments2. Segment ends are not capped or faded, so the segments
 * of a polyline join without gaps; the few overlapping pixels at a joint are invisible at overlay widths.
 */
import * as THREE from "three"

export const AA_LINE_VERTEX = /* glsl */ `
attribute vec3 aStart;
attribute vec3 aEnd;
// x: 0 = start, 1 = end; y: side (-1 / +1).
attribute vec2 aCorner;
uniform vec4 uViewport;
uniform float uWidth;
varying float vAcross;

// Move \`end\` along the segment onto the near plane (view space, perspective): three's trimSegment.
void atTrimToNear(const in vec4 start, inout vec4 end) {
  float a = projectionMatrix[2][2];
  float b = projectionMatrix[3][2];
  float nearEstimate = -0.5 * b / a;
  float alpha = (nearEstimate - start.z) / (end.z - start.z);
  end.xyz = mix(start.xyz, end.xyz, alpha);
}

void main() {
  vec4 s = modelViewMatrix * vec4(aStart, 1.0);
  vec4 e = modelViewMatrix * vec4(aEnd, 1.0);
  if (projectionMatrix[2][3] == -1.0) {
    if (s.z < 0.0 && e.z >= 0.0) atTrimToNear(s, e);
    else if (e.z < 0.0 && s.z >= 0.0) atTrimToNear(e, s);
  }
  vec4 cs = projectionMatrix * s;
  vec4 ce = projectionMatrix * e;
  vec2 px = uViewport.zw * 0.5;
  // Screen-space (pixel) direction and normal of the segment.
  vec2 d = ce.xy / ce.w * px - cs.xy / cs.w * px;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 normal = vec2(-dir.y, dir.x);
  vec4 clip = aCorner.x < 0.5 ? cs : ce;
  float hw = 0.5 * uWidth + 0.5;
  clip.xy += normal * (aCorner.y * hw) / px * clip.w;
  vAcross = aCorner.y;
  gl_Position = clip;
}
`

export const AA_LINE_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAcross;
void main() {
  float a = uOpacity * clamp((1.0 - abs(vAcross)) / max(fwidth(vAcross), 1e-6), 0.0, 1.0);
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}
`

export interface AALineMaterialOptions {
  /** Line width in CSS pixels (default 1.5). */
  width?: number
  opacity?: number
  /** Default false: overlays draw through geometry. */
  depthTest?: boolean
}

const _viewport = new THREE.Vector4()

/** Transparent, unlit overlay material for aaLineGeometry. */
export function createAALineMaterial(color: THREE.ColorRepresentation, opts: AALineMaterialOptions = {}): THREE.ShaderMaterial {
  const uniforms = {
    uColor: { value: new THREE.Color(color) },
    uOpacity: { value: opts.opacity ?? 1 },
    uWidth: { value: opts.width ?? 1.5 },
    uViewport: { value: new THREE.Vector4(0, 0, 1, 1) },
  }
  const width = uniforms.uWidth.value
  const m = new THREE.ShaderMaterial({
    name: "atlas-overlay-aa-line",
    vertexShader: AA_LINE_VERTEX,
    fragmentShader: AA_LINE_FRAGMENT,
    uniforms,
    transparent: true,
    depthTest: opts.depthTest ?? false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  })
  // The drawing-buffer viewport (physical pixels) of the pass being drawn, and the width scaled from CSS
  // pixels by the renderer's pixel ratio.
  m.onBeforeRender = (renderer) => {
    const r = renderer as Partial<THREE.WebGLRenderer>
    if (typeof r.getCurrentViewport === "function") uniforms.uViewport.value.copy(r.getCurrentViewport.call(renderer, _viewport))
    const ratio = typeof r.getPixelRatio === "function" ? r.getPixelRatio.call(renderer) : 1
    uniforms.uWidth.value = width * ratio
    m.uniformsNeedUpdate = true
  }
  return m
}

/**
 * Quad geometry of line segments given as point pairs (LineSegments layout: [x0 y0 z0 x1 y1 z1] per
 * segment). `position` holds the segment's own end per vertex, so bounds and frustum tests stay right.
 */
export function aaLineGeometry(pairs: ArrayLike<number>): THREE.BufferGeometry {
  const n = Math.floor(pairs.length / 6)
  const start = new Float32Array(n * 12)
  const end = new Float32Array(n * 12)
  const position = new Float32Array(n * 12)
  const corner = new Float32Array(n * 8)
  const index = new Uint32Array(n * 6)
  // Corners (end, side): (0, -1), (0, 1), (1, 1), (1, -1). Flat loops: overlays merge thousands of segments.
  for (let k = 0; k < n; k++) {
    const p = k * 6
    for (let v = 0; v < 4; v++) {
      const o = (k * 4 + v) * 3
      const atEnd = v >= 2 ? 3 : 0
      for (let c = 0; c < 3; c++) {
        start[o + c] = pairs[p + c]
        end[o + c] = pairs[p + 3 + c]
        position[o + c] = pairs[p + atEnd + c]
      }
      corner[(k * 4 + v) * 2] = v >= 2 ? 1 : 0
      corner[(k * 4 + v) * 2 + 1] = v === 1 || v === 2 ? 1 : -1
    }
    const b = k * 4
    const i = k * 6
    index[i] = b
    index[i + 1] = b + 1
    index[i + 2] = b + 2
    index[i + 3] = b
    index[i + 4] = b + 2
    index[i + 5] = b + 3
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute("position", new THREE.BufferAttribute(position, 3))
  g.setAttribute("aStart", new THREE.BufferAttribute(start, 3))
  g.setAttribute("aEnd", new THREE.BufferAttribute(end, 3))
  g.setAttribute("aCorner", new THREE.BufferAttribute(corner, 2))
  g.setIndex(new THREE.BufferAttribute(index, 1))
  return g
}

/** Segment pairs of a polyline (closed: the last point joins the first). */
export function polylinePairs(points: readonly { x: number; y: number; z: number }[], closed = false): Float32Array {
  const n = points.length
  const segs = closed ? n : Math.max(0, n - 1)
  const out = new Float32Array(segs * 6)
  for (let k = 0; k < segs; k++) {
    const a = points[k]
    const b = points[(k + 1) % n]
    out.set([a.x, a.y, a.z, b.x, b.y, b.z], k * 6)
  }
  return out
}
