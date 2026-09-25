/**
 * Layout of the area chips over the map (TemplateLayer): chips whose anchors are close would cover each
 * other, so each one placed after another it would overlap moves up above it.
 */

/** Chips sit this far above their anchor (CSS px, matches the button's translate). */
export const CHIP_GAP = 10

export interface ChipRect {
  x: number
  y: number
  w: number
  h: number
}

/** `r` moved up until it clears every placed chip (with a 2 px gap). */
export function stackChip(placed: readonly ChipRect[], r: ChipRect): ChipRect {
  let y = r.y
  for (let pass = 0; pass < placed.length + 1; pass++) {
    const hit = placed.find(
      (p) =>
        r.x < p.x + p.w &&
        r.x + r.w > p.x &&
        y < p.y + p.h + 2 &&
        y + r.h + 2 > p.y
    )
    if (!hit) break
    y = hit.y - r.h - 2
  }
  return { ...r, y }
}
