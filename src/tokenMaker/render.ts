/**
 * Token Maker compositor (ARCHITECTURE §11): draws a TokenDesign with Canvas 2D.
 *
 * Per layer, bottom to top: its content (image with its transform, or a fill) is drawn on a scratch
 * canvas and cut by its mask (shape + pop-out region, then the strokes in order: reveal paints, hide
 * erases). A disc-masked layer that breaks out is split: what lies outside its disc, in its pop-out
 * region or under a reveal stroke (a head breaking out of the frame) is drawn in a second pass above
 * every layer; the rest stays in place (under the frame and its inner shadow).
 */
import { breaksOut, layerDisc, layerSize, popOutRect } from "@/core/tokenMaker/design"
import type { MaskStroke, TokenDesign, TokenLayer } from "@/core/tokenMaker/types"
import { canvasToBlob, context2d, makeCanvas, type Canvas2D } from "@/net/assets/import"

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

/** Decoded images by id (a layer whose image is missing draws nothing). */
export type ImageLookup = (imageId: string) => CanvasImageSource | null | undefined

export interface RenderOptions {
  /** Draw only this layer's content, unmasked (e.g. the mask painter's ghost). */
  solo?: string
  /** Multiplies every layer's opacity (default 1). */
  alpha?: number
}

/** Reusable scratch canvases, grown to the largest size asked for. */
class Scratch {
  private readonly canvases: Canvas2D[] = []

  get(k: number, size: number): { canvas: Canvas2D; ctx: Ctx2D } {
    let c = this.canvases[k]
    if (!c || c.width !== size || c.height !== size) {
      c = makeCanvas(size, size)
      this.canvases[k] = c
    }
    const ctx = context2d(c)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = "source-over"
    ctx.clearRect(0, 0, size, size)
    return { canvas: c, ctx }
  }
}

const scratch = new Scratch()

function drawContent(ctx: Ctx2D, layer: TokenLayer, size: number, images: ImageLookup): boolean {
  ctx.setTransform(size, 0, 0, size, 0, 0)
  if (layer.source.type === "fill") {
    ctx.fillStyle = layer.source.color
    ctx.fillRect(0, 0, 1, 1)
    return true
  }
  const img = images(layer.source.imageId)
  if (!img) return false
  const t = layer.transform
  const { w, h } = layerSize(layer)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  ctx.translate(t.x, t.y)
  ctx.rotate((t.rotation * Math.PI) / 180)
  if (t.flipX) ctx.scale(-1, 1)
  ctx.drawImage(img, -w / 2, -h / 2, w, h)
  return true
}

function strokePath(ctx: Ctx2D, stroke: MaskStroke): void {
  const p = stroke.points
  ctx.beginPath()
  if (p.length === 2) {
    ctx.arc(p[0], p[1], stroke.size / 2, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.lineWidth = stroke.size
  ctx.lineCap = "round"
  ctx.lineJoin = "round"
  ctx.moveTo(p[0], p[1])
  for (let k = 2; k < p.length; k += 2) ctx.lineTo(p[k], p[k + 1])
  ctx.stroke()
}

/** Paint a layer's mask (white = shown) on a cleared canvas. */
export function drawMask(ctx: Ctx2D, design: TokenDesign, layer: TokenLayer, size: number, extraStroke?: MaskStroke | null): void {
  ctx.setTransform(size, 0, 0, size, 0, 0)
  ctx.globalCompositeOperation = "source-over"
  ctx.fillStyle = "#fff"
  ctx.strokeStyle = "#fff"
  if (layer.mask.shape === "none") {
    ctx.fillRect(0, 0, 1, 1)
  } else {
    const d = layerDisc(design, layer)
    ctx.beginPath()
    ctx.arc(d.cx, d.cy, d.r, 0, Math.PI * 2)
    ctx.fill()
    const pop = popOutRect(design, layer)
    if (pop) ctx.fillRect(pop.x, pop.y, pop.w, pop.h)
  }
  const strokes = extraStroke ? [...layer.mask.strokes, extraStroke] : layer.mask.strokes
  for (const s of strokes) {
    ctx.globalCompositeOperation = s.mode === "reveal" ? "source-over" : "destination-out"
    strokePath(ctx, s)
  }
  ctx.globalCompositeOperation = "source-over"
}

/**
 * The part of a disc-masked layer drawn in FRONT of every layer (white = front): everything outside
 * its disc, the pop-out region, and wherever a reveal stroke went. Broken-out parts (a head over the
 * ring, a revealed shield) are drawn whole in front, so the frame's inner shadow never cuts across them.
 */
function drawFront(ctx: Ctx2D, design: TokenDesign, layer: TokenLayer, size: number, extraStroke: MaskStroke | null): void {
  const d = layerDisc(design, layer)
  ctx.setTransform(size, 0, 0, size, 0, 0)
  ctx.fillStyle = "#fff"
  ctx.strokeStyle = "#fff"
  ctx.fillRect(0, 0, 1, 1)
  ctx.globalCompositeOperation = "destination-out"
  ctx.beginPath()
  ctx.arc(d.cx, d.cy, d.r, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalCompositeOperation = "source-over"
  const pop = popOutRect(design, layer)
  if (pop) ctx.fillRect(pop.x, pop.y, pop.w, pop.h)
  for (const s of extraStroke ? [...layer.mask.strokes, extraStroke] : layer.mask.strokes) if (s.mode === "reveal") strokePath(ctx, s)
}

/**
 * Composite `design` onto `out` (a `size`×`size` pixel area at its origin; the caller clears it).
 * `pending` is a stroke being painted on layer `pendingLayer`, shown before it is committed.
 */
export function renderDesign(
  out: Ctx2D,
  design: TokenDesign,
  images: ImageLookup,
  size: number,
  opts: RenderOptions & { pending?: { layerId: string; stroke: MaskStroke } | null } = {}
): void {
  const px = Math.max(1, Math.round(size))
  const alpha = opts.alpha ?? 1
  const later: Array<{ canvas: Canvas2D; opacity: number }> = []
  let slot = 2
  out.save()
  out.setTransform(1, 0, 0, 1, 0, 0)
  for (const layer of design.layers) {
    if (opts.solo !== undefined && layer.id !== opts.solo) continue
    if (!layer.visible || layer.opacity <= 0) continue
    const content = scratch.get(0, px)
    if (!drawContent(content.ctx, layer, px, images)) continue
    if (opts.solo === undefined) {
      const mask = scratch.get(1, px)
      const pending = opts.pending && opts.pending.layerId === layer.id ? opts.pending.stroke : null
      drawMask(mask.ctx, design, layer, px, pending)
      content.ctx.setTransform(1, 0, 0, 1, 0, 0)
      content.ctx.globalCompositeOperation = "destination-in"
      content.ctx.drawImage(mask.canvas, 0, 0)
      content.ctx.globalCompositeOperation = "source-over"
      if (layer.mask.shape === "disc" && (breaksOut(layer) || pending?.mode === "reveal")) {
        // Split the masked layer into what stays behind (in its place) and what goes in front.
        const front = scratch.get(slot++, px)
        mask.ctx.setTransform(1, 0, 0, 1, 0, 0)
        mask.ctx.clearRect(0, 0, px, px)
        drawFront(mask.ctx, design, layer, px, pending)
        front.ctx.drawImage(content.canvas, 0, 0)
        front.ctx.globalCompositeOperation = "destination-in"
        front.ctx.drawImage(mask.canvas, 0, 0)
        content.ctx.globalCompositeOperation = "destination-out"
        content.ctx.drawImage(mask.canvas, 0, 0)
        content.ctx.globalCompositeOperation = "source-over"
        later.push({ canvas: front.canvas, opacity: layer.opacity * alpha })
      }
    }
    out.globalAlpha = layer.opacity * alpha
    out.drawImage(content.canvas, 0, 0)
  }
  for (const l of later) {
    out.globalAlpha = l.opacity
    out.drawImage(l.canvas, 0, 0)
  }
  out.restore()
}

/** Render to a new `size`×`size` image (PNG by default; WebP when asked and supported). */
export async function exportDesign(
  design: TokenDesign,
  images: ImageLookup,
  size: number,
  type: "image/png" | "image/webp" = "image/png",
  quality = 0.92
): Promise<Blob> {
  const canvas = makeCanvas(size, size)
  const ctx = context2d(canvas)
  renderDesign(ctx, design, images, size)
  const blob = await canvasToBlob(canvas, type, quality)
  if (blob.type === type || type === "image/png") return blob
  // No WebP encoder (Safari): PNG.
  return canvasToBlob(canvas, "image/png")
}
