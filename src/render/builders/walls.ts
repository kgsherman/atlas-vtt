/**
 * Walls with openings (ARCHITECTURE §2): each wall is a box centred on a→b, extended by thickness/2
 * at ends that meet another wall (joints), split around its doors and windows into full-height
 * pieces, door lintels, window sills and lintels. Terrain rule: base = ground at the wall midpoint,
 * top = base + height, bottom = minimum ground over the (joint-extended) footprint − 0.05 ft. The
 * same rules drive core/occlusion, so what is drawn is what blocks.
 */
import { MATERIAL_COLORS } from "@/core/scene/defaults"
import { openingSegment, type Opening } from "@/core/scene/queries"
import type { Id, WallObject } from "@/core/scene/types"

import type { BuildContext } from "./context"
import { hexToLinear, materialColor, scaleRgb, tint, type RGB } from "./color"
import { orientedCorners } from "./ground"
import { writeFrameBox } from "./shapes"
import type { BucketBuild, MeshBuild } from "./types"
import { MeshWriter } from "./writer"

export const WALL_BOTTOM_MARGIN = 0.05
const MIN_EXTENT = 1e-6

export interface WallFrame {
  wall: WallObject
  len: number
  /** Unit direction a→b. */
  dir: { x: number; z: number }
  /** Ground at the wall midpoint; openings and the top measure from it. */
  baseY: number
  topY: number
  bottomY: number
  /** Joint extensions at a / b (thickness/2 or 0). */
  extA: number
  extB: number
}

export function wallFrame(ctx: BuildContext, wall: WallObject): WallFrame | null {
  const len = Math.hypot(wall.b.x - wall.a.x, wall.b.z - wall.a.z)
  if (len < MIN_EXTENT || !(wall.thickness > 0) || !(wall.height > 0) || !ctx.level(wall.levelId)) return null
  const dir = { x: (wall.b.x - wall.a.x) / len, z: (wall.b.z - wall.a.z) / len }
  const ground = ctx.sampler(wall.levelId)
  const mid = { x: (wall.a.x + wall.b.x) / 2, z: (wall.a.z + wall.b.z) / 2 }
  const baseY = ground.heightAt(mid.x, mid.z)
  const half = wall.thickness / 2
  // The bottom always uses the joint-extended footprint so it does not depend on neighbours.
  const bottomY = ground.rangeOverPolygon(orientedCorners(mid, len / 2 + half, half, dir)).min - WALL_BOTTOM_MARGIN
  return {
    wall,
    len,
    dir,
    baseY,
    topY: baseY + wall.height,
    bottomY,
    extA: ctx.isJoint(wall, wall.a) ? half : 0,
    extB: ctx.isJoint(wall, wall.b) ? half : 0,
  }
}

/** Opening span [u0, u1] along its host wall in feet from a, clamped to the wall. */
export function openingSpan(f: Pick<WallFrame, "wall" | "len" | "dir">, o: Pick<Opening, "offset" | "width">): [number, number] {
  const seg = openingSegment(f.wall, o)
  const u0 = (seg.a.x - f.wall.a.x) * f.dir.x + (seg.a.z - f.wall.a.z) * f.dir.z
  const u1 = (seg.b.x - f.wall.a.x) * f.dir.x + (seg.b.z - f.wall.a.z) * f.dir.z
  return [Math.max(0, Math.min(u0, u1)), Math.min(f.len, Math.max(u0, u1))]
}

/** A hole cut through the wall: [u0, u1] × [y0, y1] (y0 = −∞ for holes reaching the bottom). */
export interface WallHole {
  u0: number
  u1: number
  y0: number
  y1: number
}

export interface WallPiece {
  u0: number
  u1: number
  y0: number
  y1: number
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** Doors: from the bottom to base + height. Windows: sill → sill + height (sill 0 reaches the bottom). */
export function openingHole(f: WallFrame, o: Opening): WallHole | null {
  const [u0, u1] = openingSpan(f, o)
  if (u1 - u0 < MIN_EXTENT) return null
  const h = f.wall.height
  if (o.type === "door") return { u0, u1, y0: -Infinity, y1: f.baseY + clamp(o.height, 0, h) }
  const sill = clamp(o.sillHeight, 0, h)
  const head = clamp(o.sillHeight + o.height, sill, h)
  return { u0, u1, y0: sill > 0 ? f.baseY + sill : -Infinity, y1: f.baseY + head }
}

/**
 * Split the wall volume [u0, u1] × [bottomY, topY] around holes into solid boxes. The u axis is cut at
 * every hole boundary; in each interval the solid spans are [bottomY, topY] minus the union of the
 * holes covering it; consecutive intervals with identical spans are merged.
 */
export function splitWall(u0: number, u1: number, bottomY: number, topY: number, holes: readonly WallHole[]): WallPiece[] {
  const cuts = new Set<number>([u0, u1])
  for (const h of holes) {
    if (h.u0 > u0 && h.u0 < u1) cuts.add(h.u0)
    if (h.u1 > u0 && h.u1 < u1) cuts.add(h.u1)
  }
  const xs = [...cuts].sort((a, b) => a - b)
  const spansOf = (a: number, b: number): [number, number][] => {
    const covering = holes
      .filter((h) => h.u0 <= a + 1e-9 && h.u1 >= b - 1e-9)
      .map((h) => [Math.max(bottomY, h.y0), Math.min(topY, h.y1)] as [number, number])
      .filter(([lo, hi]) => hi > lo)
      .sort((p, q) => p[0] - q[0])
    const out: [number, number][] = []
    let y = bottomY
    for (const [lo, hi] of covering) {
      if (lo > y + MIN_EXTENT) out.push([y, lo])
      y = Math.max(y, hi)
    }
    if (topY > y + MIN_EXTENT) out.push([y, topY])
    return out
  }
  const pieces: WallPiece[] = []
  let open: { u0: number; u1: number; spans: [number, number][] } | null = null
  const flush = () => {
    if (!open) return
    for (const [y0, y1] of open.spans) pieces.push({ u0: open.u0, u1: open.u1, y0, y1 })
  }
  for (let k = 0; k + 1 < xs.length; k++) {
    const a = xs[k]
    const b = xs[k + 1]
    if (b - a < MIN_EXTENT) continue
    const spans = spansOf(a, b)
    const same =
      open !== null && open.spans.length === spans.length && open.spans.every((s, i) => Math.abs(s[0] - spans[i][0]) < 1e-9 && Math.abs(s[1] - spans[i][1]) < 1e-9)
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
  return splitWall(-f.extA, f.len + f.extB, f.bottomY, f.topY, holes)
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
  const [u0, u1] = openingSpan(f, o)
  if (u1 - u0 < 2 * WINDOW_FRAME + MIN_EXTENT) return
  const h = f.wall.height
  const sill = clamp(o.sillHeight, 0, h)
  const head = clamp(o.sillHeight + o.height, sill, h)
  if (head - sill < 2 * WINDOW_FRAME) return
  const { wall, dir } = f
  const t = wall.thickness / 2
  const wood = scaleRgb(hexToLinear(MATERIAL_COLORS.wood), 0.75)
  const yS = f.baseY + sill
  const yH = f.baseY + head
  const box = (a: number, b: number, y0: number, y1: number, v: number) =>
    writeFrameBox(walls, wall.a.x, wall.a.z, dir.x, dir.z, a, b, y0, y1, -v, v, (face) => tint(wood, `${o.id}:${a}:${face}`, 0.04))
  walls.begin(o.id)
  // Jambs, head and (when raised) a protruding sill board; the mullion splits wide windows.
  box(u0, u0 + WINDOW_FRAME, yS, yH, t + 0.04)
  box(u1 - WINDOW_FRAME, u1, yS, yH, t + 0.04)
  box(u0, u1, yH - WINDOW_FRAME, yH, t + 0.04)
  if (sill > 0) box(u0 - 0.1, u1 + 0.1, yS - 0.12, yS + 0.05, t + 0.12)
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
    wallPieces(ctx, f).forEach((p, k) => {
      writeFrameBox(walls, wall.a.x, wall.a.z, f.dir.x, f.dir.z, p.u0, p.u1, p.y0, p.y1, -wall.thickness / 2, wall.thickness / 2, wallFaceColor(base, `${wall.id}:${k}`))
    })
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
