/**
 * Startup quality pick (ARCHITECTURE §10): GPU renderer-string heuristics + a short timed render of a
 * synthetic, world-shader-like workload, mapped to the highest tier whose predicted main-pass cost
 * leaves headroom in a 60 fps frame. Adaptive quality (engine/quality.ts) corrects it at runtime.
 *
 *   const quality = await pickInitialQuality()     // cached per GPU for 30 days (localStorage)
 *   const engine = createEngine(canvas, { quality })
 *
 * The probe uses its own tiny WebGL2 context (released afterwards), so it can run before the engine
 * exists and never disturbs the engine's GL state. It takes ~100–300 ms on a first run (measured:
 * RTX 5070 Ti 110 ms → ultra, Radeon iGPU 190 ms → medium). The renderer string is read first
 * (readRendererInfo): a software renderer (SwiftShader, llvmpipe) is classified low without timing,
 * which would otherwise block its first load for 1–2 s.
 */
import type { Quality } from "../contracts"

export interface QualityProbe {
  tier: Quality
  renderer: string
  vendor: string
  /** Median GPU time per megapixel of the synthetic shader (ms, sync latency removed), null when not measured. */
  msPerMP: number | null
  /** Highest tier the renderer heuristics allow. */
  cap: Quality
  /** Short human-readable reason ("discrete GPU, 0.03 ms/MP"). */
  reason: string
  /** From the cache rather than measured now. */
  cached: boolean
}

const ORDER: readonly Quality[] = ["low", "medium", "high", "ultra"]
const rank = (q: Quality) => ORDER.indexOf(q)
const minQ = (a: Quality, b: Quality): Quality => (rank(a) <= rank(b) ? a : b)

export const PROBE_CACHE_KEY = "atlas:quality-probe:v2"
const CACHE_DAYS = 30

/** Renderer-string heuristics: a tier cap and a label. Unknown GPUs are allowed everything (the benchmark decides). */
export function classifyRenderer(renderer: string): { cap: Quality; label: string; software: boolean } {
  const r = renderer.toLowerCase()
  if (/swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/.test(r)) return { cap: "low", label: "software renderer", software: true }
  if (/mali|adreno|powervr|apple a\d|videocore/.test(r)) return { cap: "medium", label: "mobile GPU", software: false }
  if (/intel/.test(r)) {
    if (/arc/.test(r)) return { cap: "ultra", label: "Intel Arc", software: false }
    if (/iris/.test(r)) return { cap: "high", label: "Intel Iris", software: false }
    return { cap: "medium", label: "Intel HD/UHD", software: false }
  }
  if (/rtx|geforce|gtx|quadro|titan|radeon rx|radeon pro|rx \d{3,4}|\brx\d|arc a\d/.test(r)) return { cap: "ultra", label: "discrete GPU", software: false }
  if (/apple m\d|apple gpu/.test(r)) return { cap: "ultra", label: "Apple silicon", software: false }
  if (/radeon|vega/.test(r)) return { cap: "high", label: "integrated Radeon", software: false }
  return { cap: "ultra", label: "unknown GPU", software: false }
}

/** CPU / submission cost of a frame that does not scale with pixels (ms). */
export const PREDICTED_CPU_MS = 1.5

/**
 * Relative cost per megapixel of each tier's frame against the synthetic shader: shader features
 * (procedural detail; bump + specular; PCSS + hi-res tiles) and post-processing (HDR MSAA target,
 * bloom; AO, grain). Calibrated with the render harness at 1920×1080 on the heaviest sample
 * (crooked-lantern, dm-play): Radeon iGPU (1.93 ms/MP synthetic) measured 6.4 / 12.8 / 23.7 / 41.7 ms
 * for low / medium / high / ultra; RTX 5070 Ti (0.033 ms/MP) 1.7 / 2.3 / 2.5 ms at 1080p and 4.1 ms
 * for ultra at 4K — both reproduced by this model within ~15 %.
 */
export const TIER_COST_FACTOR: Record<Quality, number> = { low: 1.95, medium: 2.83, high: 5.56, ultra: 10.1 }

/** Predicted frame cost (ms) of each tier at the pixel counts the tiers render. */
export function predictTierMs(msPerMP: number, pixels: { low: number; medium: number; native: number }): Record<Quality, number> {
  const mp = (n: number) => n / 1e6
  const f = TIER_COST_FACTOR
  return {
    low: PREDICTED_CPU_MS + msPerMP * mp(pixels.low) * f.low,
    medium: PREDICTED_CPU_MS + msPerMP * mp(pixels.medium) * f.medium,
    high: PREDICTED_CPU_MS + msPerMP * mp(pixels.native) * f.high,
    ultra: PREDICTED_CPU_MS + msPerMP * mp(pixels.native) * f.ultra,
  }
}

/**
 * Frame cost the prediction must fit (ms): 14 ms leaves ~15 % for heavier scenes than the calibration
 * sample, overlays and vsync jitter under the 16.7 ms of 60 fps; adaptive quality handles the rest.
 */
export const PREDICTED_BUDGET_MS = 14

/** Highest tier ≤ cap whose predicted cost fits the budget (at least low). */
export function tierForCost(msPerMP: number, cap: Quality, pixels: { low: number; medium: number; native: number }): Quality {
  const cost = predictTierMs(msPerMP, pixels)
  let best: Quality = "low"
  for (const q of ORDER) if (rank(q) <= rank(cap) && cost[q] <= PREDICTED_BUDGET_MS) best = q
  return best
}

/** Screen pixels each tier would render for the current window. */
export function tierPixels(cssWidth: number, cssHeight: number, dpr: number): { low: number; medium: number; native: number } {
  const css = Math.max(1, cssWidth) * Math.max(1, cssHeight)
  const native = css * Math.min(2, Math.max(1, dpr)) ** 2
  return { low: Math.min(native, 1.3e6), medium: Math.min(native, 2.1e6), native: Math.min(native, 8.3e6) }
}

// ---------------------------------------------------------------------------------------------
// Synthetic benchmark (raw WebGL2)

const VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

// Roughly the world shader's shape: 8 lights with distance / falloff culling and 4 texelFetch taps
// each, value noise detail and a mask lookup.
const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uTex;
uniform float uSeed;
float hash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  vec3 p = vec3(vUv.x * 120.0, 0.0, vUv.y * 120.0);
  vec3 n = normalize(vec3(noise(p.xz * 0.7) - 0.5, 4.0, noise(p.zx * 0.7) - 0.5));
  vec3 sum = vec3(0.02);
  for (int i = 0; i < 8; i++) {
    float fi = float(i) + uSeed;
    vec3 lp = vec3(60.0 + 40.0 * sin(fi * 1.7), 6.0, 60.0 + 40.0 * cos(fi * 2.3));
    vec3 toL = lp - p;
    float d = length(toL);
    if (d > 45.0) continue;
    float lam = max(dot(n, toL / d), 0.0);
    vec2 uv = toL.xz / d * 0.5 + 0.5;
    ivec2 c = ivec2(uv * 510.0) + ivec2(i * 64 % 512, 0);
    float s = 0.0;
    s += step(d * 0.01, texelFetch(uTex, c, 0).r);
    s += step(d * 0.01, texelFetch(uTex, c + ivec2(1, 0), 0).r);
    s += step(d * 0.01, texelFetch(uTex, c + ivec2(0, 1), 0).r);
    s += step(d * 0.01, texelFetch(uTex, c + ivec2(1, 1), 0).r);
    sum += vec3(1.0, 0.8, 0.6) * lam * (1.0 - d / 45.0) * s * 0.25;
  }
  float detail = noise(p.xz * 2.0) * 0.5 + noise(p.xz * 4.1) * 0.25;
  outColor = vec4(sum * (0.8 + 0.4 * detail), 1.0);
}
`

function rendererStrings(gl: WebGL2RenderingContext): { renderer: string; vendor: string } {
  const dbg = gl.getExtension("WEBGL_debug_renderer_info")
  return {
    renderer: String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
    vendor: String(dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
  }
}

/** GPU renderer / vendor strings from a throwaway 1×1 WebGL2 context (released at once); null without WebGL2. */
export function readRendererInfo(): { renderer: string; vendor: string } | null {
  if (typeof document === "undefined") return null
  let gl: WebGL2RenderingContext | null = null
  try {
    const canvas = document.createElement("canvas")
    canvas.width = 1
    canvas.height = 1
    gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false, powerPreference: "high-performance" })
    return gl ? rendererStrings(gl) : null
  } catch {
    return null
  } finally {
    gl?.getExtension("WEBGL_lose_context")?.loseContext()
  }
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type)
  if (!s) return null
  gl.shaderSource(s, src)
  gl.compileShader(s)
  return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null
}

/**
 * Time the synthetic shader over a 1024² target, as GPU throughput rather than latency: the sync
 * round-trip (a 1-pixel readPixels, ~0.3–0.5 ms through ANGLE) is measured on empty frames and
 * subtracted, and the number of full-screen passes per frame doubles until a frame takes ≥ 6 ms (so a
 * fast GPU is not measured by its latency floor). Returns the median cost per megapixel.
 */
export function measureShaderCost(frames = 16): { msPerMP: number; renderer: string; vendor: string } | null {
  if (typeof document === "undefined") return null
  const canvas = document.createElement("canvas")
  canvas.width = 16
  canvas.height = 16
  const gl = canvas.getContext("webgl2", { antialias: false, depth: false, stencil: false, powerPreference: "high-performance" })
  if (!gl) return null
  const lose = gl.getExtension("WEBGL_lose_context")
  try {
    const { renderer, vendor } = rendererStrings(gl)
    const vs = compile(gl, gl.VERTEX_SHADER, VS)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FS)
    const prog = gl.createProgram()
    if (!vs || !fs || !prog) return null
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.bindAttribLocation(prog, 0, "aPos")
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
    gl.useProgram(prog)
    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    // Data texture (RGBA8 so no float extension is needed).
    const tex = gl.createTexture()
    const data = new Uint8Array(512 * 512 * 4)
    for (let k = 0; k < data.length; k++) data[k] = (k * 2654435761) >>> 24
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 512, 512, 0, gl.RGBA, gl.UNSIGNED_BYTE, data)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.uniform1i(gl.getUniformLocation(prog, "uTex"), 0)
    const seed = gl.getUniformLocation(prog, "uSeed")
    // Render target 1024² (1 MP).
    const size = 1024
    const rt = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, rt)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size)
    const fb = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, rt, 0)
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) return null
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.viewport(0, 0, size, size)
    const px = new Uint8Array(4)
    const frame = (passes: number, f: number): number => {
      const t0 = performance.now()
      for (let k = 0; k < passes; k++) {
        gl.uniform1f(seed, f * 0.37 + k)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
      return performance.now() - t0
    }
    const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
    // Warm-up (compilation), sync latency, then enough passes per frame to measure throughput.
    frame(2, 0)
    frame(2, 1)
    const latency = median(Array.from({ length: 5 }, (_, k) => frame(0, k)))
    let passes = 2
    while (passes < 64 && frame(passes, passes) - latency < 6) passes *= 2
    const times: number[] = []
    for (let f = 0; f < frames; f++) times.push(Math.max(0, frame(passes, f) - latency))
    return { msPerMP: median(times) / ((passes * size * size) / 1e6), renderer, vendor }
  } catch {
    return null
  } finally {
    lose?.loseContext()
  }
}

interface CacheEntry {
  renderer: string
  tier: Quality
  msPerMP: number | null
  cap: Quality
  reason: string
  at: number
}

function readCache(storage: Storage | null): CacheEntry | null {
  try {
    const raw = storage?.getItem(PROBE_CACHE_KEY)
    if (!raw) return null
    const e = JSON.parse(raw) as CacheEntry
    if (!ORDER.includes(e.tier) || Date.now() - e.at > CACHE_DAYS * 86400e3) return null
    return e
  } catch {
    return null
  }
}

export interface ProbeOptions {
  /** Cache (default localStorage when available; null disables caching). */
  storage?: Storage | null
  /** Ignore a cached result. */
  force?: boolean
  /** Window size used for the pixel counts (default: the current window). */
  cssWidth?: number
  cssHeight?: number
  dpr?: number
  /** Renderer-string reader (default readRendererInfo; tests inject one). */
  rendererInfo?: () => { renderer: string; vendor: string } | null
  /** Timed benchmark (default measureShaderCost; tests inject one). */
  measure?: () => { msPerMP: number; renderer: string; vendor: string } | null
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null
  } catch {
    return null
  }
}

/** Full probe result (tier + measurements); see pickInitialQuality for the tier alone. */
export async function probeQuality(opts: ProbeOptions = {}): Promise<QualityProbe> {
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage
  const cached = opts.force ? null : readCache(storage)
  // Yield once so a caller's first paint is not delayed by the benchmark.
  await new Promise((r) => setTimeout(r, 0))
  const w = opts.cssWidth ?? (typeof window !== "undefined" ? window.innerWidth : 1920)
  const h = opts.cssHeight ?? (typeof window !== "undefined" ? window.innerHeight : 1080)
  const dpr = opts.dpr ?? (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1)
  if (cached) {
    // Same GPU: re-derive the tier for this window size from the cached measurement.
    const tier = cached.msPerMP !== null ? tierForCost(cached.msPerMP, cached.cap, tierPixels(w, h, dpr)) : cached.tier
    return { tier, renderer: cached.renderer, vendor: "", msPerMP: cached.msPerMP, cap: cached.cap, reason: cached.reason, cached: true }
  }
  const store = (e: Omit<CacheEntry, "at">) => {
    try {
      storage?.setItem(PROBE_CACHE_KEY, JSON.stringify({ ...e, at: Date.now() } satisfies CacheEntry))
    } catch {
      // Storage full / blocked: no cache.
    }
  }
  // Classify before timing: a software renderer is low whatever it measures, and timing it costs 1–2 s.
  const info = (opts.rendererInfo ?? readRendererInfo)()
  if (info && classifyRenderer(info.renderer).software) {
    const reason = "software renderer"
    store({ renderer: info.renderer, tier: "low", msPerMP: null, cap: "low", reason })
    return { tier: "low", renderer: info.renderer, vendor: info.vendor, msPerMP: null, cap: "low", reason, cached: false }
  }
  const m = (opts.measure ?? measureShaderCost)()
  if (!m) {
    return { tier: "medium", renderer: "unknown", vendor: "", msPerMP: null, cap: "medium", reason: "no WebGL2 probe", cached: false }
  }
  const cls = classifyRenderer(m.renderer)
  const tier = cls.software ? "low" : minQ(cls.cap, tierForCost(m.msPerMP, cls.cap, tierPixels(w, h, dpr)))
  const reason = `${cls.label}, ${m.msPerMP.toFixed(2)} ms/MP`
  store({ renderer: m.renderer, tier, msPerMP: m.msPerMP, cap: cls.cap, reason })
  return { tier, renderer: m.renderer, vendor: m.vendor, msPerMP: m.msPerMP, cap: cls.cap, reason, cached: false }
}

/** The quality tier to start an engine with (cached per GPU; adaptive quality refines it at runtime). */
export async function pickInitialQuality(opts: ProbeOptions = {}): Promise<Quality> {
  return (await probeQuality(opts)).tier
}
