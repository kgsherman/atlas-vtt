/**
 * Strict validation of a saved token design (the Token Maker's autosaved draft). Anything that does not
 * match exactly (shape, bounds, budgets) is refused, and the editor starts from a fresh design.
 */
import { z } from "zod"

import { TOKEN_LIMITS } from "./design"
import type { TokenDesign } from "./types"
import { TOKEN_DESIGN_VERSION } from "./types"

const finite = z.number().refine(Number.isFinite, "expected a finite number")
const unit = finite.min(0).max(1)
const coord = finite.min(-TOKEN_LIMITS.maxOffset).max(1 + TOKEN_LIMITS.maxOffset)
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)
const side = z.int().min(1).max(TOKEN_LIMITS.maxImageSide)

const transformSchema = z.strictObject({
  x: coord,
  y: coord,
  scale: finite.min(TOKEN_LIMITS.minScale).max(TOKEN_LIMITS.maxScale),
  rotation: finite.min(-180).max(180),
  flipX: z.boolean(),
})

const sourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("image"), imageId: idSchema, width: side, height: side }),
  z.strictObject({ type: z.literal("fill"), color: colorSchema }),
])

const strokeSchema = z.strictObject({
  mode: z.enum(["reveal", "hide"]),
  size: finite.min(TOKEN_LIMITS.minBrush).max(TOKEN_LIMITS.maxBrush),
  points: z
    .array(coord)
    .min(2)
    .refine((p) => p.length % 2 === 0, "points come in x, y pairs"),
})

const maskSchema = z
  .strictObject({
    shape: z.enum(["none", "disc"]),
    grow: finite.min(-TOKEN_LIMITS.maxGrow).max(TOKEN_LIMITS.maxGrow),
    popOut: z.boolean(),
    strokes: z.array(strokeSchema).max(TOKEN_LIMITS.maxStrokesPerLayer),
  })
  .refine((m) => m.strokes.reduce((n, s) => n + s.points.length, 0) <= TOKEN_LIMITS.maxStrokeCoordsPerLayer, "too many stroke points")

const layerSchema = z.strictObject({
  id: idSchema,
  name: z.string().max(TOKEN_LIMITS.maxName),
  source: sourceSchema,
  transform: transformSchema,
  opacity: unit,
  visible: z.boolean(),
  mask: maskSchema,
})

export const tokenDesignSchema = z
  .strictObject({
    version: z.literal(TOKEN_DESIGN_VERSION),
    radius: finite.min(TOKEN_LIMITS.minRadius).max(TOKEN_LIMITS.maxRadius),
    layers: z.array(layerSchema).max(TOKEN_LIMITS.maxLayers),
  })
  .refine((d) => new Set(d.layers.map((l) => l.id)).size === d.layers.length, "duplicate layer ids")

/** The design, or null when `json` is not a valid current design. */
export function parseTokenDesign(json: unknown): TokenDesign | null {
  try {
    const r = tokenDesignSchema.safeParse(json)
    return r.success ? (r.data as TokenDesign) : null
  } catch {
    return null
  }
}

/** Image ids an image layer of the design uses. */
export function designImageIds(design: TokenDesign): string[] {
  const ids = new Set<string>()
  for (const l of design.layers) if (l.source.type === "image") ids.add(l.source.imageId)
  return [...ids]
}
