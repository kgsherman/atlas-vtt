/**
 * Walls with openings (ARCHITECTURE §2 "Walls on terrain"): each wall stands on its base line from
 * core/scene/wallProfile (follow-terrain walls on the ground along the wall, others on the level
 * elevation; flat bottom just below the lowest ground under the joint-extended footprint), is extended
 * by thickness/2 at ends that meet another wall (joints) and is split around its doors and windows into
 * full-height pieces, door lintels, window sills and lintels. A piece whose top is constant is a box; a
 * piece under a sloped top line is a strip (one closed prism over the profile knots inside it). The
 * profile and opening heights are shared with core/occlusion, so what is drawn is what blocks.
 */
import { MATERIAL_COLORS } from "@/core/scene/defaults"
import type { Opening } from "@/core/scene/queries"
import type { Id, Vec2, WallObject } from "@/core/scene/types"
import { MIN_EXTENT, openingFrame, pieceKnots, wallProfile, type WallProfile } from "@/core/scene/wallProfile"

import { MAT, surfaceOf } from "../materials/surface"
import type { BuildContext } from "./context"
import { hexToLinear, materialColor, scaleRgb, tint, type RGB } from "./color"
import type { GroundSampler } from "./ground"
import { writeFrameBox, writeFrameStrip, type FaceColor } from "./shapes"
import type { BucketBuild, MeshBuild } from "./types"
import { MeshWriter } from "./writer"

export { WALL_BOTTOM_MARGIN } from "@/core/scene/wallProfile"

export interface WallFrame {
  wall: WallObject
  len: number
  /** Unit direction a→b. */
  dir: Vec2
  /** Joint extensions at a / b (thickness/2 or 0). */
  extA: number
  extB: number
  /** Base line, top and bottom (core/scene/wallProfile, the same as core/occlusion's). */
  profile: WallProfile
  /** Ground of the wall's level (door leaves reach down to it). */
  ground: GroundSampler
}

// Frames per build pass (the walls and doors buckets of a level share them).
const frameCache = new WeakMap<BuildContext, Map<Id, WallFrame | null>>()

export function wallFrame(ctx: BuildContext, wall: WallObject): WallFrame | null {
  let cache = frameCache.get(ctx)
  if (!cache) frameCache.set(ctx, (cache = new Map()))
  const hit = cache.get(wall.id)
  if (hit !== undefined && (hit === null || hit.wall === wall)) return hit
  const f = makeWallFrame(ctx, wall)
  cache.set(wall.id, f)
  return f
}

function makeWallFrame(ctx: BuildContext, wall: WallObject): WallFrame | null {
  const len = Math.hypot(wall.b.x - wall.a.x, wall.b.z - wall.a.z)
  if (len < MIN_EXTENT || !(wall.thickness > 0) || !(wall.height > 0) || !ctx.level(wall.levelId)) return null
  const ground = ctx.sampler(wall.levelId)
  const half = wall.thickness / 2
  const extA = ctx.isJoint(wall, wall.a) ? half : 0
  const extB = ctx.isJoint(wall, wall.b) ? half : 0
  const profile = wallProfile(wall, ground.flat ? null : ground, ground.elevation, { a: extA, b: extB })
  return { wall, len: profile.len, dir: profile.dir, extA, extB, profile, ground }
}

/** A hole cut through the wall: [u0, u1] × [y0, y1] (y0 = −∞ for holes reaching the bottom). */
export interface WallHole {
  u0: number
  u1: number
  y0: number
  y1: number
}

/**
 * A solid piece of a wall in wall-frame coordinates (u = feet from a along a→b, y = world Y): a box
 * [u0, u1] × [y0, y1], or a strip when `knots` is set: the flat bottom y0 under the top line through
 * (knots[i], tops[i]) (knots from u0 to u1, strictly increasing); y1 is then the highest top.
 */
export interface WallPiece {
  u0: number
  u1: number
  y0: number
  y1: number
  knots?: number[]
  tops?: number[]
}

/** Top of a piece at u (clamped to the piece). */
export function wallPieceTopAt(p: WallPiece, u: number): number {
  const k = p.knots
  const t = p.tops
  if (!k || !t) return p.y1
  const n = k.length
  if (!(u > k[0])) return t[0]
  if (u >= k[n - 1]) return t[n - 1]
  let i = 0
  while (i + 2 < n && k[i + 1] <= u) i++
  return t[i] + ((u - k[i]) / (k[i + 1] - k[i])) * (t[i + 1] - t[i])
}

/** Area of a piece in the wall's (u, y) plane (× thickness = its volume). */
export function wallPieceArea(p: WallPiece): number {
  const k = p.knots
  const t = p.tops
  if (!k || !t) return (p.u1 - p.u0) * (p.y1 - p.y0)
  let a = 0
  for (let i = 0; i + 1 < k.length; i++) a += ((k[i + 1] - k[i]) * (t[i] - p.y0 + t[i + 1] - p.y0)) / 2
  return a
}

/**
 * Hole of an opening (core/scene/wallProfile openingFrame): doors from the bottom to the head; windows
 * from the sill top (or the bottom when the window has no sill piece) to the head.
 */
export function openingHole(f: WallFrame, o: Opening): WallHole | null {
  const fr = openingFrame(f.profile, f.wall, o)
  if (!fr) return null
  return { u0: fr.u0, u1: fr.u1, y0: o.type === "window" && fr.hasSill ? fr.sillTop : -Infinity, y1: fr.head }
}

/**
 * Split the wall volume [u0, u1] × [bottomY, top] around holes into solid pieces. `top` is a constant
 * height or a wall profile (the top line topAt(u)). The u axis is cut at every hole boundary; in each
 * interval the solid spans are [bottomY, top] minus the union of the holes covering it; consecutive
 * intervals with identical spans are merged. A span reaching the top line is a box where the top is
 * constant over its piece, else a strip over the profile knots inside the piece.
 */
export function splitWall(u0: number, u1: number, bottomY: number, top: number | WallProfile, holes: readonly WallHole[]): WallPiece[] {
  const profile = typeof top === "number" ? null : top
  const maxTop = (a: number, b: number) => (profile ? profile.maxTop(a, b) : (top as number))
  const cuts = new Set<number>([u0, u1])
  for (const h of holes) {
    if (h.u0 > u0 && h.u0 < u1) cuts.add(h.u0)
    if (h.u1 > u0 && h.u1 < u1) cuts.add(h.u1)
  }
  const xs = [...cuts].sort((a, b) => a - b)
  // A span [lo, hi], or [lo, top line] when `topped`.
  type Span = { lo: number; hi: number; topped: boolean }
  const spansOf = (a: number, b: number): Span[] => {
    const topY = maxTop(a, b)
    const covering = holes
      .filter((h) => h.u0 <= a + 1e-9 && h.u1 >= b - 1e-9)
      .map((h) => [Math.max(bottomY, h.y0), Math.min(topY, h.y1)] as [number, number])
      .filter(([lo, hi]) => hi > lo)
      .sort((p, q) => p[0] - q[0])
    const out: Span[] = []
    let y = bottomY
    for (const [lo, hi] of covering) {
      if (lo > y + MIN_EXTENT) out.push({ lo: y, hi: lo, topped: false })
      y = Math.max(y, hi)
    }
    if (topY > y + MIN_EXTENT) out.push({ lo: y, hi: topY, topped: true })
    return out
  }
  const sameSpan = (p: Span, q: Span) => p.topped === q.topped && Math.abs(p.lo - q.lo) < 1e-9 && (p.topped || Math.abs(p.hi - q.hi) < 1e-9)
  const pieces: WallPiece[] = []
  let open: { u0: number; u1: number; spans: Span[] } | null = null
  const toppedPiece = (a: number, b: number, y0: number): WallPiece | null => {
    if (!profile) return { u0: a, u1: b, y0, y1: top as number }
    if (profile.topConstant(a, b)) return { u0: a, u1: b, y0, y1: profile.maxTop(a, b) }
    const knots = pieceKnots(profile, a, b)
    const tops = knots.map((u) => profile.topAt(u))
    let y1 = -Infinity
    for (const t of tops) if (t > y1) y1 = t
    return y1 - y0 < MIN_EXTENT ? null : { u0: a, u1: b, y0, y1, knots, tops }
  }
  const flush = () => {
    if (!open) return
    for (const s of open.spans) {
      const p = s.topped ? toppedPiece(open.u0, open.u1, s.lo) : { u0: open.u0, u1: open.u1, y0: s.lo, y1: s.hi }
      if (p) pieces.push(p)
    }
  }
  for (let k = 0; k + 1 < xs.length; k++) {
    const a = xs[k]
    const b = xs[k + 1]
    if (b - a < MIN_EXTENT) continue
    const spans = spansOf(a, b)
    const same = open !== null && open.spans.length === spans.length && open.spans.every((s, i) => sameSpan(s, spans[i]))
    if (same && open) open.u1 = b
    else {
      flush()
      open = { u0: a, u1: b, spans }
    }
  }
  flush()
  return pieces
}

/** All solid pieces of a wall (in wall-frame coordinates), joint extensions included. */
export function wallPieces(ctx: BuildContext, f: WallFrame): WallPiece[] {
  const holes: WallHole[] = []
  for (const o of ctx.openingsOf(f.wall.id)) {
    if (o.levelId !== f.wall.levelId) continue
    const h = openingHole(f, o)
    if (h) holes.push(h)
  }
  return splitWall(-f.extA, f.len + f.extB, f.profile.bottomY, f.profile, holes)
}

/** Write one piece of a wall (a box, or a strip under a sloped top line), full wall thickness. */
export function writeWallPiece(w: MeshWriter, wall: Pick<WallObject, "a" | "thickness">, dir: Vec2, p: WallPiece, color: FaceColor): void {
  const t = wall.thickness / 2
  if (p.knots && p.tops) writeFrameStrip(w, wall.a.x, wall.a.z, dir.x, dir.z, p.knots, p.tops, p.y0, -t, t, color)
  else writeFrameBox(w, wall.a.x, wall.a.z, dir.x, dir.z, p.u0, p.u1, p.y0, p.y1, -t, t, color)
}

const WINDOW_FRAME = 0.2
const GLASS_COLOR: RGB = [0.55, 0.72, 0.85]

/** Wall colour for a face: material albedo, subtle deterministic variation, darker caps. */
function wallFaceColor(base: RGB, key: string) {
  return (face: number): RGB => {
    const c = tint(base, `${key}:${face}`, 0.035)
    return face === 3 ? scaleRgb(c, 0.88) : c
  }
}

function writeWindow(walls: MeshWriter, glass: MeshWriter, f: WallFrame, o: Opening & { type: "window" }): void {
  const fr = openingFrame(f.profile, f.wall, o)
  if (!fr) return
  const { u0, u1 } = fr
  if (u1 - u0 < 2 * WINDOW_FRAME + MIN_EXTENT) return
  const yS = fr.sillTop
  const yH = fr.head
  if (yH - yS < 2 * WINDOW_FRAME) return
  const { wall, dir } = f
  const t = wall.thickness / 2
  const wood = scaleRgb(hexToLinear(MATERIAL_COLORS.wood), 0.75)
  const box = (a: number, b: number, y0: number, y1: number, v: number) =>
    writeFrameBox(walls, wall.a.x, wall.a.z, dir.x, dir.z, a, b, y0, y1, -v, v, (face) => tint(wood, `${o.id}:${a}:${face}`, 0.04))
  walls.begin(o.id)
  walls.material = MAT.WOOD
  // Jambs, head and (when raised) a protruding sill board; the mullion splits wide windows.
  box(u0, u0 + WINDOW_FRAME, yS, yH, t + 0.04)
  box(u1 - WINDOW_FRAME, u1, yS, yH, t + 0.04)
  box(u0, u1, yH - WINDOW_FRAME, yH, t + 0.04)
  if (fr.hasSill) box(u0 - 0.1, u1 + 0.1, yS - 0.12, yS + 0.05, t + 0.12)
  if (u1 - u0 > 2.5) box((u0 + u1) / 2 - 0.05, (u0 + u1) / 2 + 0.05, yS, yH - WINDOW_FRAME, 0.06)
  walls.end()
  glass.begin(o.id)
  writeFrameBox(glass, wall.a.x, wall.a.z, dir.x, dir.z, u0 + WINDOW_FRAME, u1 - WINDOW_FRAME, yS, yH - WINDOW_FRAME, -0.02, 0.02, GLASS_COLOR)
  glass.end()
}

/** Walls bucket of a level: merged wall pieces + window frames (world) and window glass (glass). */
export function buildWallsBucket(ctx: BuildContext, levelId: Id): BucketBuild {
  const walls = new MeshWriter()
  const glass = new MeshWriter()
  for (const wall of ctx.ofType(levelId, "wall")) {
    const f = wallFrame(ctx, wall)
    if (!f) continue
    const base = materialColor(wall.material)
    walls.begin(wall.id)
    walls.material = surfaceOf(wall.material)
    wallPieces(ctx, f).forEach((p, k) => writeWallPiece(walls, wall, f.dir, p, wallFaceColor(base, `${wall.id}:${k}`)))
    walls.end()
    for (const o of ctx.openingsOf(wall.id)) {
      if (o.type === "window" && o.levelId === levelId) writeWindow(walls, glass, f, o)
    }
  }
  const meshes: MeshBuild[] = []
  const wg = walls.build()
  if (wg) meshes.push({ kind: "merged", name: "walls", slot: "world", geometry: wg })
  const gg = glass.build()
  if (gg) meshes.push({ kind: "merged", name: "glass", slot: "glass", geometry: gg })
  return { meshes }
}
