/**
 * Viewer eyes and token test points (docs/ARCHITECTURE.md §5.2 "Viewer eye" and "Tokens").
 * The renderer uses resolveViewerEye too, so CPU and GPU line of sight start from the same point.
 */
import { primitiveContains, pushOutOfPrimitive } from "../occlusion/primitives"
import type { OcclusionWorld, SegmentQueryOptions } from "../occlusion/types"
import { SIZE_FOOTPRINT } from "../scene/defaults"
import type { Token, Vec3 } from "../scene/types"

/** Eyes and test points stay this far below the ceiling found by the upward sight ray (feet). */
export const CEILING_MARGIN = 0.25
/** Distance an eye is pushed past the nearest face of a blocker it ended up in (feet). */
export const EYE_PUSH_MARGIN = 0.3
/** Upward ceiling rays start this far above the ground (clear of the floor slab). */
export const FEET_OFFSET = 0.1
/** Token test-point corners are inset this far from the footprint edges (feet). */
export const TOKEN_POINT_INSET = 0.5

const SIGHT: SegmentQueryOptions = { channel: "sight" }

/**
 * Y of the first sight blocker above (x, feetY, z) up to `topY`, or Infinity. Blockers containing
 * the feet point are ignored (ENTRY semantics).
 */
export function ceilingAbove(world: OcclusionWorld, x: number, feetY: number, z: number, topY: number): number {
  if (!(topY > feetY)) return Infinity
  const hit = world.raycast({ x, y: feetY, z }, { x, y: topY, z }, SIGHT)
  return hit ? feetY + hit.t * (topY - feetY) : Infinity
}

/**
 * Clamped eye for a token standing on `ground` (world Y): ground + eyeHeight, kept CEILING_MARGIN
 * below the ceiling found by an upward sight ray from the feet, then pushed out of any sight blocker
 * containing it that does not also contain the feet (a creature standing inside a bush keeps its eye
 * there; that bush is then ignored by rays from the eye).
 */
export function eyeAtGround(world: OcclusionWorld, ground: number, token: Pick<Token, "position" | "eyeHeight">): Vec3 {
  const x = token.position.x
  const z = token.position.z
  const feet = ground + FEET_OFFSET
  const nominal = ground + token.eyeHeight
  let y = nominal
  const ceiling = ceilingAbove(world, x, feet, z, nominal + CEILING_MARGIN)
  if (ceiling < Infinity) y = Math.min(y, ceiling - CEILING_MARGIN)
  // Never below the feet (a ceiling lower than the margin would otherwise sink the eye into the floor).
  y = Math.max(y, Math.min(nominal, feet))
  let eye: Vec3 = { x, y, z }
  const start: Vec3 = { x, y: feet, z }
  for (const p of world.containing(eye, "sight")) {
    if (primitiveContains(p, start)) continue
    eye = pushOutOfPrimitive(p, eye, EYE_PUSH_MARGIN)
  }
  return eye
}

/** Test-point columns (XZ offsets from the token centre): centre, 4 inset corners, + 4 edge midpoints for ≥ 3-cell footprints. */
export function tokenPointColumns(cellSize: number, size: Token["size"]): [number, number][] {
  const cells = SIZE_FOOTPRINT[size] ?? 1
  const h = Math.max(0, (cells * cellSize) / 2 - TOKEN_POINT_INSET)
  const cols: [number, number][] = [[0, 0]]
  if (h <= 0) return cols
  cols.push([-h, -h], [h, -h], [-h, h], [h, h])
  if (cells >= 3) cols.push([0, -h], [h, 0], [0, h], [-h, 0])
  return cols
}

/**
 * Token visibility test points for a token standing on `ground`: columns × heights (ground + 0.25,
 * height / 2, height − 0.1), each capped CEILING_MARGIN below its column's ceiling. Off-centre
 * points whose segment from the centre point at the same height is sight-blocked are skipped (a
 * corner poking through a wall does not make the token visible). Centre points come first.
 */
export function tokenPointsAtGround(
  world: OcclusionWorld,
  cellSize: number,
  ground: number,
  token: Pick<Token, "position" | "size" | "height">
): Vec3[] {
  const height = Math.max(token.height, 0.35)
  const rel = [0.25, height / 2, height - 0.1]
  const feet = ground + FEET_OFFSET
  const out: Vec3[] = []
  const centre: Vec3[] = []
  for (const [dx, dz] of tokenPointColumns(cellSize, token.size)) {
    const x = token.position.x + dx
    const z = token.position.z + dz
    const ceiling = ceilingAbove(world, x, feet, z, ground + height + CEILING_MARGIN)
    for (let k = 0; k < rel.length; k++) {
      const nominal = ground + rel[k]
      const y = Math.max(Math.min(nominal, ceiling - CEILING_MARGIN), Math.min(nominal, feet))
      const p = { x, y, z }
      if (dx === 0 && dz === 0) {
        centre.push(p)
        out.push(p)
        continue
      }
      if (world.segmentBlocked(centre[k], p, SIGHT)) continue
      out.push(p)
    }
  }
  return out
}
