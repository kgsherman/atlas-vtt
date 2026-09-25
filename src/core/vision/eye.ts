/**
 * Viewer eyes and token test points (docs/ARCHITECTURE.md §5.2 "Viewer eye" and "Tokens").
 * The renderer uses resolveViewerEye too, so CPU and GPU line of sight start from the same point.
 */
import { heightfieldSurfaceAt, primitiveContains, primitiveTopAt, pushOutOfPrimitive } from "../occlusion/primitives"
import type { OccluderPrimitive, OcclusionWorld, SegmentQueryOptions } from "../occlusion/types"
import { SIZE_FOOTPRINT } from "../scene/defaults"
import type { Token, Vec3, VisionOrigin } from "../scene/types"

/** Eyes and test points stay this far below the ceiling found by the upward sight ray (feet). */
export const CEILING_MARGIN = 0.25
/** Distance an eye is pushed past the nearest face of a blocker it ended up in (feet). */
export const EYE_PUSH_MARGIN = 0.3
/** Upward ceiling rays start this far above the ground (clear of the floor slab). */
export const FEET_OFFSET = 0.1
/** Token test-point corners are inset this far from the footprint edges (feet). */
export const TOKEN_POINT_INSET = 0.5
/** Corner eyes of "square" vision are inset this far from the footprint edges (feet). */
export const CORNER_EYE_INSET = 0.5

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

/**
 * Every eye a token sees from (ARCHITECTURE §5.2 "Viewer eyes"). The first is its clamped eye
 * (eyeAtGround). With `origin` "square", the 4 corners of its footprint inset CORNER_EYE_INSET follow, at
 * the eye's nominal height over the token's own ground (the head moves sideways, not with the terrain),
 * each clamped below its own column's ceiling and pushed out of blockers like the eye. A corner is dropped
 * when the segment from the eye to it is sight-blocked (a corner in or behind a wall must not see past it),
 * or when it coincides with the eye (a footprint too small for the inset).
 */
export function viewerEyesAtGround(
  world: OcclusionWorld,
  cellSize: number,
  ground: number,
  token: Pick<Token, "position" | "eyeHeight" | "size">,
  origin: VisionOrigin
): Vec3[] {
  const eye = eyeAtGround(world, ground, token)
  if (origin !== "square") return [eye]
  const h = ((SIZE_FOOTPRINT[token.size] ?? 1) * cellSize) / 2 - CORNER_EYE_INSET
  if (!(h > 0.01)) return [eye]
  const out = [eye]
  for (const [dx, dz] of CORNERS) {
    const corner = eyeAtGround(world, ground, { position: { x: token.position.x + dx * h, z: token.position.z + dz * h }, eyeHeight: token.eyeHeight })
    if (world.segmentBlocked(eye, corner, SIGHT)) continue
    out.push(corner)
  }
  return out
}

const CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
]

/** Push-out passes for a light origin (a pass may land in a neighbouring blocker, e.g. at a T-junction). */
const LIGHT_PUSH_PASSES = 4
/** A floor slab whose top is within this of the light's own ground is the light's own floor (feet). */
const OWN_FLOOR_TOLERANCE = 0.01

/** Push a point out of a floor / terrain slab vertically: up out of the light's own floor, down out of a ceiling. */
function pushOutOfSlab(p: OccluderPrimitive, q: Vec3, groundY: number): Vec3 {
  let top: number | null
  let bottom: number
  switch (p.shape) {
    case "heightfield":
      top = heightfieldSurfaceAt(p, q.x, q.z)
      bottom = top === null ? 0 : top - p.thickness
      break
    case "box":
      top = p.center.y + p.halfExtents.y
      bottom = p.center.y - p.halfExtents.y
      break
    case "cylinder":
      top = p.base.y + p.height
      bottom = p.base.y
      break
    case "strip":
      top = primitiveTopAt(p, q.x, q.z)
      bottom = p.bottom
      break
  }
  if (top === null) return pushOutOfPrimitive(p, q, EYE_PUSH_MARGIN)
  const y = top <= groundY + OWN_FLOOR_TOLERANCE ? top + EYE_PUSH_MARGIN : bottom - EYE_PUSH_MARGIN
  return { x: q.x, y, z: q.z }
}

/**
 * Light origin as vision uses it (renderers should shadow from the same point): `p` pushed
 * EYE_PUSH_MARGIN past the nearest face of every light blocker containing it. Containment uses the
 * segment ENTRY rule's EPS, since rays from a point inside (or on) a blocker ignore that blocker: a
 * candle on a slab would light the storey below, a torch inside a wall both of its sides. The query is
 * repeated so a push that lands in another blocker (a T-junction, a wall under a slab) is resolved too.
 * Unlike eyes there is no feet exception: a torch inside a wall has its foot inside the wall too.
 *
 * With `groundY` (the ground the light stands on, see lightWorldPosition), a light belongs to its
 * level: floor / terrain slabs push it vertically toward that level's space instead of to their
 * nearest face, UP out of its own floor (slab top ≤ ground) and DOWN out of any slab above the ground
 * (the next storey's floor): a lantern hung into the ceiling lights its own room, not the one above.
 */
export function resolveLightOrigin(world: OcclusionWorld, p: Vec3, groundY?: number): Vec3 {
  let q: Vec3 = { x: p.x, y: p.y, z: p.z }
  for (let pass = 0; pass < LIGHT_PUSH_PASSES; pass++) {
    const inside = world.containing(q, "light")
    if (inside.length === 0) return q
    for (const prim of inside) {
      const slab = groundY !== undefined && (prim.sourceType === "floor" || prim.sourceType === "terrain")
      q = slab ? pushOutOfSlab(prim, q, groundY) : pushOutOfPrimitive(prim, q, EYE_PUSH_MARGIN)
    }
  }
  return q
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
