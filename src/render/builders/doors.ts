/**
 * Door leaves: separate meshes that animate between closed (t = 0) and open (t = 1) per
 * DOOR_STYLES[style].motion. Geometry is built in the leaf's pivot frame: +x runs from the hinge to
 * the free edge, +y up from the wall base, z across the wall. Secret doors use the host wall's
 * material and full thickness so a closed secret door reads as plain wall.
 *
 * Only the visual leaf animates; occluders follow the authoritative state instantly (§4.2).
 */
import { DOOR_STYLES, MATERIAL_COLORS } from "@/core/scene/defaults"
import type { DoorObject, Id, Vec3 } from "@/core/scene/types"

import type { BuildContext } from "./context"
import { hexToLinear, materialColor, scaleRgb, tint, type RGB } from "./color"
import { writeBox } from "./shapes"
import type { BucketBuild, DoorLeafBuild } from "./types"
import { openingSpan, wallFrame, type WallFrame } from "./walls"
import { MeshWriter } from "./writer"

export interface DoorLeaf {
  doorId: Id
  /** 0 for single doors; 0 (hinged at the opening start) and 1 (at its end) for double doors. */
  index: number
  motion: "swing" | "lift" | "slide"
  /** Hinge point on the wall centreline at the wall base (world). */
  pivot: Vec3
  /** Yaw (rotation about +Y, three.js convention) mapping pivot-local +x onto hinge → free edge. */
  yaw: number
  /** Swing: the pivot yaw at open fraction t is yaw + openSign·(π/2)·t. */
  openSign: 1 | -1
  width: number
  /** Lift: vertical travel at t = 1. */
  lift: number
}

export interface LeafPose {
  x: number
  y: number
  z: number
  yaw: number
}

/** Seconds for a full open/close animation. */
export const DOOR_ANIMATION_SECONDS = 0.45

/** Pose of a leaf's pivot at open fraction t ∈ [0, 1]. */
export function doorLeafPose(leaf: DoorLeaf, t: number): LeafPose {
  const k = t < 0 ? 0 : t > 1 ? 1 : t
  // Ease in-out so leaves start and stop gently.
  const e = k * k * (3 - 2 * k)
  const { x, y, z } = leaf.pivot
  switch (leaf.motion) {
    case "swing":
      return { x, y, z, yaw: leaf.yaw + leaf.openSign * (Math.PI / 2) * e }
    case "lift":
      return { x, y: y + leaf.lift * e, z, yaw: leaf.yaw }
    case "slide": {
      // Slide back past the hinge into the wall beside the opening.
      const ux = Math.cos(leaf.yaw)
      const uz = -Math.sin(leaf.yaw)
      const d = leaf.width * 0.95 * e
      return { x: x - ux * d, y, z: z - uz * d, yaw: leaf.yaw }
    }
  }
}

/** Yaw mapping local +x onto the ground direction (dx, dz) (three.js rotation.y). */
export const yawFromDir = (dx: number, dz: number): number => Math.atan2(-dz, dx)

/**
 * Leaves of a door on its host wall. Swing geometry: the free edge moves toward the side
 * `door.swing` (+1 = the wall's left normal, wallNormal()).
 */
export function doorLeaves(f: WallFrame, door: DoorObject): DoorLeaf[] {
  const [u0, u1] = openingSpan(f, door)
  if (u1 - u0 < 1e-3) return []
  const motion = (DOOR_STYLES[door.style] ?? DOOR_STYLES.wood).motion
  const height = Math.min(Math.max(door.height, 0), f.wall.height)
  const hinges: { u: number; sign: 1 | -1 }[] =
    door.leaves === "double"
      ? [
          { u: u0, sign: 1 },
          { u: u1, sign: -1 },
        ]
      : [door.hinge === "end" ? { u: u1, sign: -1 } : { u: u0, sign: 1 }]
  const width = (u1 - u0) / hinges.length
  return hinges.map((h, index) => {
    // Hinge → free-edge direction along the wall.
    const ux = f.dir.x * h.sign
    const uz = f.dir.z * h.sign
    // Local +z is the left normal of u; the wall's left normal is local +z when u = dir, −z otherwise.
    const swingLocal = door.swing * h.sign
    return {
      doorId: door.id,
      index,
      motion,
      pivot: { x: f.wall.a.x + f.dir.x * h.u, y: f.baseY, z: f.wall.a.z + f.dir.z * h.u },
      yaw: yawFromDir(ux, uz),
      // rotation.y = −π/2 maps local +x onto local +z, so swinging toward +z needs a negative angle.
      openSign: swingLocal > 0 ? -1 : 1,
      width,
      lift: height * 0.9,
    }
  })
}

const METAL: RGB = hexToLinear(MATERIAL_COLORS.metal)
const WOOD: RGB = hexToLinear(MATERIAL_COLORS.wood)

/** Leaf geometry in its pivot frame. */
export function doorLeafGeometry(f: WallFrame, door: DoorObject, leaf: DoorLeaf): MeshWriter {
  const w = new MeshWriter()
  const W = leaf.width
  const y0 = f.bottomY - f.baseY
  const y1 = Math.min(Math.max(door.height, 0), f.wall.height)
  const wallT = f.wall.thickness
  const key = `${door.id}:${leaf.index}`
  w.begin(door.id)
  switch (door.style) {
    case "secret": {
      // Flush with the wall faces and full width: indistinguishable from the wall when closed.
      const c = materialColor(f.wall.material)
      const t = wallT / 2 - 0.002
      writeBox(w, 0, y0, -t, W, y1, t, (face) => (face === 3 ? scaleRgb(c, 0.88) : c))
      break
    }
    case "iron": {
      const t = Math.min(0.09, wallT * 0.3)
      writeBox(w, 0.02, y0, -t, W - 0.02, y1 - 0.02, t, (face) => tint(METAL, `${key}:${face}`, 0.03))
      const strap = scaleRgb(METAL, 0.6)
      for (const fy of [0.2, 0.5, 0.8]) {
        const y = fy * y1
        writeBox(w, 0.05, y - 0.15, -t - 0.03, W - 0.05, y + 0.15, t + 0.03, strap)
      }
      break
    }
    case "portcullis": {
      const t = 0.07
      const iron = scaleRgb(METAL, 0.55)
      const n = Math.max(2, Math.round(W / 0.5))
      for (let k = 0; k <= n; k++) {
        const x = 0.06 + ((W - 0.12) * k) / n
        writeBox(w, x - 0.06, y0, -t, x + 0.06, y1 - 0.02, t, iron)
      }
      for (let y = 0.8; y < y1 - 0.2; y += 1.1) writeBox(w, 0, y - 0.06, -t * 0.7, W, y + 0.06, t * 0.7, iron)
      break
    }
    case "bars": {
      const t = 0.06
      const iron = scaleRgb(METAL, 0.6)
      const n = Math.max(2, Math.round(W / 0.4))
      for (let k = 0; k <= n; k++) {
        const x = 0.05 + ((W - 0.1) * k) / n
        writeBox(w, x - 0.05, Math.max(y0, 0), -t, x + 0.05, y1 - 0.05, t, iron)
      }
      for (const y of [0.3, y1 / 2, y1 - 0.3]) writeBox(w, 0, y - 0.07, -t, W, y + 0.07, t, iron)
      break
    }
    default: {
      // Wooden door: vertical planks, two braces on each face and a handle near the free edge.
      const t = Math.min(0.1, wallT * 0.3)
      const n = Math.max(2, Math.round(W / 0.55))
      for (let k = 0; k < n; k++) {
        const xa = 0.02 + ((W - 0.04) * k) / n
        const xb = 0.02 + ((W - 0.04) * (k + 1)) / n
        writeBox(w, xa, y0, -t, xb - 0.01, y1 - 0.02, t, (face) => tint(WOOD, `${key}:${k}:${face}`, 0.07))
      }
      const brace = scaleRgb(WOOD, 0.7)
      for (const fy of [0.22, 0.78]) {
        const y = fy * y1
        writeBox(w, 0.08, y - 0.2, -t - 0.04, W - 0.08, y + 0.2, t + 0.04, brace)
      }
      writeBox(w, W - 0.45, 3.1, -t - 0.12, W - 0.3, 3.3, t + 0.12, METAL)
    }
  }
  w.end()
  return w
}

/** Door leaves of every door hosted by the level's walls. */
export function buildDoorsBucket(ctx: BuildContext, levelId: Id): BucketBuild {
  const meshes: DoorLeafBuild[] = []
  for (const door of ctx.ofType(levelId, "door")) {
    const host = ctx.object(door.wallId)
    if (!host || host.type !== "wall" || host.levelId !== levelId) continue
    const f = wallFrame(ctx, host)
    if (!f) continue
    for (const leaf of doorLeaves(f, door)) {
      const geometry = doorLeafGeometry(f, door, leaf).build()
      if (geometry) meshes.push({ kind: "door", name: `door:${door.id}:${leaf.index}`, slot: "world", leaf, geometry })
    }
  }
  return { meshes }
}
