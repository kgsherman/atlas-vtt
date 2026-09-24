/**
 * Token Maker design operations (ARCHITECTURE §11): factories, immutable layer edits, layer geometry
 * (placement, hit testing, zooming about a point) and the mask regions the renderer draws.
 * Every edit returns a new design; the input is never mutated.
 */
import type { CanvasPoint, LayerMask, LayerRole, LayerSource, LayerTransform, MaskStroke, TokenDesign, TokenLayer } from "./types"
import { TOKEN_DESIGN_VERSION } from "./types"

export const TOKEN_LIMITS = {
  maxLayers: 12,
  minRadius: 0.1,
  maxRadius: 0.5,
  maxGrow: 0.2,
  minScale: 0.02,
  maxScale: 20,
  /** |x|, |y| of a layer centre may leave the canvas by this much (canvas units). */
  maxOffset: 3,
  minBrush: 0.005,
  maxBrush: 0.5,
  maxStrokesPerLayer: 500,
  /** Coordinates (2 per point) over all of a layer's strokes. */
  maxStrokeCoordsPerLayer: 40_000,
  maxName: 64,
  /** Source image sides, pixels. */
  maxImageSide: 8192,
} as const

/** Square output sizes offered for downloads, pixels. */
export const TOKEN_OUTPUT_SIZES = [256, 512, 1024, 2048] as const
/** Size of the image applied to a game token (the renderer's portrait atlas slots are 256 px). */
export const GAME_TOKEN_SIZE = 512

export const DEFAULT_RADIUS = 0.42
/** A background reaches a little under the frame, so no gap shows at the ring's soft inner edge. */
export const BACKGROUND_GROW = 0.02

export const CENTRE: Readonly<CanvasPoint> = Object.freeze({ x: 0.5, y: 0.5 })

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export function emptyDesign(): TokenDesign {
  return { version: TOKEN_DESIGN_VERSION, radius: DEFAULT_RADIUS, layers: [] }
}

export function defaultMask(role: LayerRole): LayerMask {
  switch (role) {
    case "background":
      return { shape: "disc", grow: BACKGROUND_GROW, popOut: false, strokes: [] }
    case "frame":
      return { shape: "none", grow: 0, popOut: false, strokes: [] }
    case "subject":
      return { shape: "disc", grow: 0, popOut: false, strokes: [] }
  }
}

/**
 * Initial placement of an image: backgrounds cover the disc, frames fill the canvas, subjects fit
 * inside the canvas (so nothing is cropped until the user decides).
 */
export function fitTransform(width: number, height: number, role: LayerRole, radius = DEFAULT_RADIUS): LayerTransform {
  const aspect = height / width
  let scale: number
  if (role === "background") {
    // Cover the disc's bounding square (diameter + the background's grow on both sides).
    const side = 2 * (radius + BACKGROUND_GROW)
    scale = Math.max(side, side / aspect)
  } else {
    // Contain in the unit square.
    scale = Math.min(1, 1 / aspect)
  }
  return { x: 0.5, y: 0.5, scale: clampScale(scale), rotation: 0, flipX: false }
}

export function clampScale(scale: number): number {
  return clamp(scale, TOKEN_LIMITS.minScale, TOKEN_LIMITS.maxScale)
}

export function clampTransform(t: LayerTransform): LayerTransform {
  const o = TOKEN_LIMITS.maxOffset
  const rotation = ((((t.rotation + 180) % 360) + 360) % 360) - 180
  return { x: clamp(t.x, -o, 1 + o), y: clamp(t.y, -o, 1 + o), scale: clampScale(t.scale), rotation, flipX: t.flipX }
}

export function clampRadius(r: number): number {
  return clamp(r, TOKEN_LIMITS.minRadius, TOKEN_LIMITS.maxRadius)
}

export function createLayer(id: string, name: string, source: LayerSource, role: LayerRole, radius = DEFAULT_RADIUS): TokenLayer {
  const transform = source.type === "image" ? fitTransform(source.width, source.height, role, radius) : { x: 0.5, y: 0.5, scale: 1, rotation: 0, flipX: false }
  return { id, name: name.slice(0, TOKEN_LIMITS.maxName), source, transform, opacity: 1, visible: true, mask: defaultMask(role) }
}

// ---------------------------------------------------------------------------
// Layer list edits
// ---------------------------------------------------------------------------

export function layerIndex(design: TokenDesign, id: string): number {
  return design.layers.findIndex((l) => l.id === id)
}

export function findLayer(design: TokenDesign, id: string | null): TokenLayer | null {
  return id === null ? null : (design.layers.find((l) => l.id === id) ?? null)
}

/** Insert at `index` (default: on top). Refused (same design) past `maxLayers` or for a duplicate id. */
export function addLayer(design: TokenDesign, layer: TokenLayer, index = design.layers.length): TokenDesign {
  if (design.layers.length >= TOKEN_LIMITS.maxLayers || layerIndex(design, layer.id) >= 0) return design
  const layers = [...design.layers]
  layers.splice(clamp(Math.round(index), 0, layers.length), 0, layer)
  return { ...design, layers }
}

export function removeLayer(design: TokenDesign, id: string): TokenDesign {
  const i = layerIndex(design, id)
  if (i < 0) return design
  return { ...design, layers: design.layers.filter((l) => l.id !== id) }
}

/** Move a layer to `index` in the bottom-to-top list. */
export function moveLayer(design: TokenDesign, id: string, index: number): TokenDesign {
  const from = layerIndex(design, id)
  if (from < 0) return design
  const to = clamp(Math.round(index), 0, design.layers.length - 1)
  if (to === from) return design
  const layers = [...design.layers]
  const [layer] = layers.splice(from, 1)
  layers.splice(to, 0, layer)
  return { ...design, layers }
}

export function updateLayer(design: TokenDesign, id: string, update: (layer: TokenLayer) => TokenLayer): TokenDesign {
  const i = layerIndex(design, id)
  if (i < 0) return design
  const next = update(design.layers[i])
  if (next === design.layers[i]) return design
  const layers = [...design.layers]
  layers[i] = next
  return { ...design, layers }
}

export function setTransform(design: TokenDesign, id: string, transform: LayerTransform): TokenDesign {
  return updateLayer(design, id, (l) => ({ ...l, transform: clampTransform(transform) }))
}

export function setMask(design: TokenDesign, id: string, mask: Partial<LayerMask>): TokenDesign {
  return updateLayer(design, id, (l) => {
    const next = { ...l.mask, ...mask }
    next.grow = clamp(next.grow, -TOKEN_LIMITS.maxGrow, TOKEN_LIMITS.maxGrow)
    return { ...l, mask: next }
  })
}

/**
 * Replace a layer's image (e.g. with its background-removed version) keeping it where it was: the new
 * image covers the same box (same centre and displayed width; the height follows its own aspect ratio).
 */
export function replaceImage(design: TokenDesign, id: string, source: Extract<LayerSource, { type: "image" }>): TokenDesign {
  return updateLayer(design, id, (l) => ({ ...l, source }))
}

// ---------------------------------------------------------------------------
// Mask strokes
// ---------------------------------------------------------------------------

function strokeCoords(mask: LayerMask): number {
  let n = 0
  for (const s of mask.strokes) n += s.points.length
  return n
}

/** Round to 1e-4 canvas units (0.2 px at 2048 px): keeps saved strokes small. */
export function roundCoord(v: number): number {
  return Math.round(v * 1e4) / 1e4
}

/**
 * Append a point to a stroke being painted, skipping points closer than a quarter of the brush to the
 * last one (dense pointer events add nothing a round brush would not already cover).
 */
export function extendStroke(points: readonly number[], p: CanvasPoint, size: number): number[] {
  const x = roundCoord(p.x)
  const y = roundCoord(p.y)
  const n = points.length
  if (n >= 2 && Math.hypot(points[n - 2] - x, points[n - 1] - y) < size / 4) return points as number[]
  return [...points, x, y]
}

/** Add a finished stroke to a layer's mask. Refused (same design) past the per-layer stroke budgets. */
export function addStroke(design: TokenDesign, id: string, stroke: MaskStroke): TokenDesign {
  if (stroke.points.length < 2 || stroke.points.length % 2 !== 0) return design
  const size = clamp(stroke.size, TOKEN_LIMITS.minBrush, TOKEN_LIMITS.maxBrush)
  return updateLayer(design, id, (l) => {
    if (l.mask.strokes.length >= TOKEN_LIMITS.maxStrokesPerLayer) return l
    if (strokeCoords(l.mask) + stroke.points.length > TOKEN_LIMITS.maxStrokeCoordsPerLayer) return l
    return { ...l, mask: { ...l.mask, strokes: [...l.mask.strokes, { mode: stroke.mode, size, points: [...stroke.points] }] } }
  })
}

export function clearStrokes(design: TokenDesign, id: string): TokenDesign {
  return updateLayer(design, id, (l) => (l.mask.strokes.length === 0 ? l : { ...l, mask: { ...l.mask, strokes: [] } }))
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Displayed size of a layer, canvas units (fills cover the canvas). */
export function layerSize(layer: TokenLayer): { w: number; h: number } {
  if (layer.source.type === "fill") return { w: 1, h: 1 }
  const { width, height } = layer.source
  return { w: layer.transform.scale, h: (layer.transform.scale * height) / width }
}

/**
 * A canvas point in the layer's own unit square ((0, 0) = the image's top-left, (1, 1) its
 * bottom-right, flips and rotation undone). Fills map the canvas onto themselves.
 */
export function toLayerUv(layer: TokenLayer, p: CanvasPoint): { u: number; v: number } {
  if (layer.source.type === "fill") return { u: p.x, v: p.y }
  const t = layer.transform
  const { w, h } = layerSize(layer)
  const a = (-t.rotation * Math.PI) / 180
  const dx = p.x - t.x
  const dy = p.y - t.y
  // Undo the clockwise rotation (y down: a positive angle turns x toward y).
  let lx = dx * Math.cos(a) - dy * Math.sin(a)
  const ly = dx * Math.sin(a) + dy * Math.cos(a)
  if (t.flipX) lx = -lx
  return { u: lx / w + 0.5, v: ly / h + 0.5 }
}

export function pointInLayer(layer: TokenLayer, p: CanvasPoint): boolean {
  const { u, v } = toLayerUv(layer, p)
  return u >= 0 && u <= 1 && v >= 0 && v <= 1
}

/** The layer's four corners (top-left, top-right, bottom-right, bottom-left of the image), canvas units. */
export function layerCorners(layer: TokenLayer): CanvasPoint[] {
  const t = layer.source.type === "fill" ? { x: 0.5, y: 0.5, rotation: 0 } : layer.transform
  const { w, h } = layerSize(layer)
  const a = (t.rotation * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].map(([x, y]) => ({ x: t.x + x * c - y * s, y: t.y + x * s + y * c }))
}

export function translateLayer(t: LayerTransform, dx: number, dy: number): LayerTransform {
  return clampTransform({ ...t, x: t.x + dx, y: t.y + dy })
}

/** Scale by `factor` about canvas point `p` (the point under the pointer stays put). */
export function zoomLayerAt(t: LayerTransform, p: CanvasPoint, factor: number): LayerTransform {
  const scale = clampScale(t.scale * factor)
  const k = scale / t.scale
  return clampTransform({ ...t, scale, x: p.x + (t.x - p.x) * k, y: p.y + (t.y - p.y) * k })
}

/**
 * Topmost visible image layer under a canvas point whose image is opaque there (`opaqueAt` samples
 * the image's alpha at uv; without it the layer's box counts).
 */
export function pickLayer(design: TokenDesign, p: CanvasPoint, opaqueAt?: (layer: TokenLayer, u: number, v: number) => boolean): TokenLayer | null {
  for (let i = design.layers.length - 1; i >= 0; i--) {
    const l = design.layers[i]
    if (!l.visible || l.source.type !== "image") continue
    const { u, v } = toLayerUv(l, p)
    if (u < 0 || u > 1 || v < 0 || v > 1) continue
    if (!opaqueAt || opaqueAt(l, u, v)) return l
  }
  return null
}

// ---------------------------------------------------------------------------
// Mask regions (drawn by the renderer)
// ---------------------------------------------------------------------------

export interface Disc {
  cx: number
  cy: number
  r: number
}

/** The layer's disc: the token disc grown by the layer's `grow` (never below a hair). */
export function layerDisc(design: TokenDesign, layer: TokenLayer): Disc {
  return { cx: CENTRE.x, cy: CENTRE.y, r: Math.max(0.001, design.radius + layer.mask.grow) }
}

/**
 * The pop-out region of a disc-masked layer: from the canvas top down to the disc's centre line, as
 * wide as the disc (x, y, w, h in canvas units), or null when the layer does not pop out.
 */
export function popOutRect(design: TokenDesign, layer: TokenLayer): { x: number; y: number; w: number; h: number } | null {
  if (layer.mask.shape !== "disc" || !layer.mask.popOut) return null
  const d = layerDisc(design, layer)
  return { x: d.cx - d.r, y: 0, w: 2 * d.r, h: d.cy }
}

/** Whether a disc-masked layer has parts drawn in front of every layer (pop-out region, reveal strokes). */
export function breaksOut(layer: TokenLayer): boolean {
  return layer.visible && layer.mask.shape === "disc" && (layer.mask.popOut || layer.mask.strokes.some((s) => s.mode === "reveal"))
}

/**
 * The disc radius matching a frame layer's opening: `opening` is the opening's radius as a fraction
 * of the frame image's width (detectFrameOpening), scaled by how wide the layer is drawn. null when
 * the frame is not centred on the canvas (its opening would not be the token disc).
 */
export function radiusForFrame(layer: TokenLayer, opening: number): number | null {
  if (layer.source.type !== "image") return null
  const t = layer.transform
  if (Math.hypot(t.x - CENTRE.x, t.y - CENTRE.y) > 0.02) return null
  return clampRadius(opening * t.scale)
}
