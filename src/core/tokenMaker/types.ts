/**
 * Token Maker designs (ARCHITECTURE §11): a stack of layers composited into a square token image.
 *
 * Coordinates are "canvas units": the output square is [0, 1] × [0, 1], x to the right, y DOWN (image
 * convention), so a design renders the same at any output size. The token disc is centred at
 * (0.5, 0.5) with radius `TokenDesign.radius` (the frame's opening); layer masks clip to it.
 *
 * Image bytes never live in the design: an image layer names its image by id, and the editor keeps the
 * blobs beside the design (the draft store, net/tokenImages uploads).
 */

export const TOKEN_DESIGN_VERSION = 1 as const

export interface CanvasPoint {
  x: number
  y: number
}

export interface LayerTransform {
  /** Centre of the layer's image, canvas units. */
  x: number
  y: number
  /** Displayed width of the image, canvas units (its height follows the image's aspect ratio). */
  scale: number
  /** Clockwise, degrees. */
  rotation: number
  /** Mirrored left ↔ right (about the layer's own centre, before rotation). */
  flipX: boolean
}

export type LayerSource =
  /** An image the editor holds under `imageId` (upload, free asset, background-removed result). */
  | { type: "image"; imageId: string; width: number; height: number }
  /** A solid colour filling the whole canvas (masks still apply). */
  | { type: "fill"; color: string }

export type MaskShape =
  /** The whole canvas. */
  | "none"
  /** The token disc (grown or shrunk by `LayerMask.grow`). */
  | "disc"

export type StrokeMode = "reveal" | "hide"

/** A painted mask edit: a round brush dragged through `points` (flat [x0, y0, x1, y1, …], canvas units). */
export interface MaskStroke {
  mode: StrokeMode
  /** Brush diameter, canvas units. */
  size: number
  points: number[]
}

/**
 * What part of a layer shows. The mask starts as `shape` (plus the pop-out region), then the strokes
 * are painted over it in order ("reveal" adds, "hide" removes).
 *
 * With shape "disc", the parts that break out are drawn in a second pass above every layer: whatever
 * the final mask keeps outside the disc, in the pop-out region, or under a reveal stroke. A character's
 * head breaking out of the frame lies over the frame in one piece, while the rest stays inside it
 * (under the frame's inner shadow).
 */
export interface LayerMask {
  shape: MaskShape
  /** Disc radius offset for this layer, canvas units (e.g. a background reaching under the ring). */
  grow: number
  /** shape "disc": everything above the disc's centre line, as wide as the disc, shows too. */
  popOut: boolean
  strokes: MaskStroke[]
}

export interface TokenLayer {
  id: string
  name: string
  source: LayerSource
  transform: LayerTransform
  /** 0..1 */
  opacity: number
  visible: boolean
  mask: LayerMask
}

export interface TokenDesign {
  version: typeof TOKEN_DESIGN_VERSION
  /** Radius of the token disc (the frame's opening), canvas units. */
  radius: number
  /** Bottom to top. */
  layers: TokenLayer[]
}

/** The role a new layer is created for: it picks the default fit and mask. */
export type LayerRole = "background" | "frame" | "subject"
