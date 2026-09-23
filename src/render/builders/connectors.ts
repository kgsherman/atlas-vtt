/**
 * Connectors: stairs (solid steps down to the lowest ground under the run), ramps (a solid wedge)
 * and ladders (two rails + rungs, no occluder). Heights follow connectorGround: the walking surface
 * rises linearly from the lower level's ground at the bottom edge to the upper level's ground at
 * the top edge. The stepped occluder (core/occlusion) stays at or below the visual steps.
 */
import { connectorForward, connectorGround } from "@/core/scene/queries"
import type { ConnectorObject, Id, Vec2 } from "@/core/scene/types"

import { SURF } from "../internal"
import type { BuildContext } from "./context"
import { materialColor, scaleRgb, tint } from "./color"
import { writeFrameBox, writeQuadOutward } from "./shapes"
import type { BucketBuild } from "./types"
import { MeshWriter, type V3 } from "./writer"

/** Target riser height of visual stairs (feet). */
export const STAIR_RISER = 0.75
const BOTTOM_MARGIN = 0.05

/**
 * Run frame of a connector: origin at a corner of the bottom edge, `f` the ascending direction,
 * `side` the direction across the run from that corner, run length and width.
 */
export function connectorFrame(c: Pick<ConnectorObject, "rect" | "direction">): { origin: Vec2; f: Vec2; side: Vec2; run: number; width: number } {
  const r = c.rect
  const f = connectorForward(c.direction)
  switch (c.direction) {
    case 0:
      return { origin: { x: r.x, z: r.z }, f, side: { x: 1, z: 0 }, run: r.d, width: r.w }
    case 1:
      return { origin: { x: r.x, z: r.z }, f, side: { x: 0, z: 1 }, run: r.w, width: r.d }
    case 2:
      return { origin: { x: r.x, z: r.z + r.d }, f, side: { x: 1, z: 0 }, run: r.d, width: r.w }
    case 3:
      return { origin: { x: r.x + r.w, z: r.z }, f, side: { x: 0, z: 1 }, run: r.w, width: r.d }
  }
}

/** Number of visual steps for a rise (at least 2). */
export function stairStepCount(rise: number): number {
  return Math.max(2, Math.round(Math.abs(rise) / STAIR_RISER))
}

function writeStairsOrRamp(w: MeshWriter, ctx: BuildContext, c: ConnectorObject): void {
  const fr = connectorFrame(c)
  if (!(fr.run > 1e-6 && fr.width > 1e-6)) return
  const scene = ctx.scene
  const lower = ctx.sampler(c.levelId)
  const r = c.rect
  const bottom = lower.rangeOverPolygon([
    { x: r.x, z: r.z },
    { x: r.x + r.w, z: r.z },
    { x: r.x + r.w, z: r.z + r.d },
    { x: r.x, z: r.z + r.d },
  ]).min - BOTTOM_MARGIN
  const at = (u: number, v: number): Vec2 => ({ x: fr.origin.x + fr.f.x * u + fr.side.x * v, z: fr.origin.z + fr.f.z * u + fr.side.z * v })
  // Nudge samples inside the rect so half-open containment never drops the far edge.
  const groundAt = (u: number, v: number) => connectorGround(scene, c, at(Math.min(Math.max(u, 1e-4), fr.run - 1e-4), v))
  const base = materialColor(c.material)
  const frameBox = (u0: number, u1: number, y0: number, y1: number, color: (face: number) => [number, number, number], walkable: boolean) => {
    // writeFrameBox's v axis is the left normal of f; `side` is either that normal or its opposite,
    // so the across range [0, width] maps to v ∈ [0, width] or [−width, 0].
    const left = { x: -fr.f.z, z: fr.f.x }
    const sign = left.x * fr.side.x + left.z * fr.side.z >= 0 ? 1 : -1
    const v0 = sign > 0 ? 0 : -fr.width
    const v1 = sign > 0 ? fr.width : 0
    writeFrameBox(w, fr.origin.x, fr.origin.z, fr.f.x, fr.f.z, u0, u1, y0, y1, v0, v1, color, { walkableTop: walkable })
  }
  if (c.style === "stairs") {
    const y0 = groundAt(0, fr.width / 2)
    const y1 = groundAt(fr.run, fr.width / 2)
    const n = stairStepCount(y1 - y0)
    for (let k = 0; k < n; k++) {
      const top = y0 + ((y1 - y0) * (k + 1)) / n
      const u0 = (fr.run * k) / n
      const u1 = (fr.run * (k + 1)) / n
      frameBox(u0, u1, bottom, Math.max(top, bottom + 0.05), (face) => {
        const c0 = tint(base, `${c.id}:${k}:${face}`, 0.05)
        return face === 3 ? c0 : scaleRgb(c0, 0.8)
      }, true)
    }
    return
  }
  // Ramp: sloped top from the bottom edge to the top edge; vertical sides; flat bottom.
  const v0 = 0
  const v1 = fr.width
  const p = (u: number, v: number, y: number): V3 => {
    const q = at(u, v)
    return [q.x, y, q.z]
  }
  const yb0 = groundAt(0, v0)
  const yb1 = groundAt(0, v1)
  const yt0 = groundAt(fr.run, v0)
  const yt1 = groundAt(fr.run, v1)
  const slope = tint(base, `${c.id}:top`, 0.03)
  const side = scaleRgb(base, 0.78)
  const centre = { x: fr.origin.x + fr.f.x * (fr.run / 2) + fr.side.x * (fr.width / 2), z: fr.origin.z + fr.f.z * (fr.run / 2) + fr.side.z * (fr.width / 2) }
  const midY = (bottom + Math.max(yb0, yt0)) / 2
  const out = (q: V3): V3 => [q[0] - centre.x, q[1] - midY, q[2] - centre.z]
  const top = [p(0, v0, yb0), p(fr.run, v0, yt0), p(fr.run, v1, yt1), p(0, v1, yb1)] as const
  writeQuadOutward(w, top[0], top[1], top[2], top[3], [0, 1, 0], slope, SURF.WALKABLE)
  const bot = [p(0, v0, bottom), p(fr.run, v0, bottom), p(fr.run, v1, bottom), p(0, v1, bottom)] as const
  writeQuadOutward(w, bot[0], bot[1], bot[2], bot[3], [0, -1, 0], side, SURF.FACE)
  // Side walls (trapezoids), the back (top edge) and a sliver at the bottom edge if it is raised.
  writeQuadOutward(w, bot[0], bot[1], top[1], top[0], out(p(fr.run / 2, v0, midY)), side, SURF.FACE)
  writeQuadOutward(w, bot[3], bot[2], top[2], top[3], out(p(fr.run / 2, v1, midY)), side, SURF.FACE)
  writeQuadOutward(w, bot[1], bot[2], top[2], top[1], [fr.f.x, 0, fr.f.z], side, SURF.FACE)
  writeQuadOutward(w, bot[0], bot[3], top[3], top[0], [-fr.f.x, 0, -fr.f.z], side, SURF.FACE)
}

function writeLadder(w: MeshWriter, ctx: BuildContext, c: ConnectorObject): void {
  const r = c.rect
  const centre = { x: r.x + r.w / 2, z: r.z + r.d / 2 }
  const f = connectorForward(c.direction)
  const halfRun = (Math.abs(f.x) > 0 ? r.w : r.d) / 2
  // The ladder stands near the far edge of its cell, facing back down the run.
  const planeU = Math.max(0, halfRun - 0.6)
  const bottomY = ctx.sampler(c.levelId).heightAt(centre.x, centre.z)
  const topY = ctx.level(c.toLevelId) ? ctx.sampler(c.toLevelId).heightAt(centre.x + f.x * halfRun, centre.z + f.z * halfRun) + 3 : bottomY + 10
  const lo = Math.min(bottomY, topY)
  const hi = Math.max(bottomY, topY)
  const color = scaleRgb(materialColor(c.material), 0.9)
  const ox = centre.x + f.x * planeU
  const oz = centre.z + f.z * planeU
  // Frame: u across the ladder (left normal of f), v along f.
  const ax = -f.z
  const az = f.x
  for (const s of [-0.8, 0.8]) writeFrameBox(w, ox, oz, ax, az, s - 0.1, s + 0.1, lo - 0.05, hi, -0.1, 0.1, (face) => tint(color, `${c.id}:rail:${s}:${face}`, 0.04))
  for (let y = lo + 1; y < hi - 0.3; y += 1) writeFrameBox(w, ox, oz, ax, az, -0.75, 0.75, y - 0.06, y + 0.06, -0.06, 0.06, color)
}

/** Connectors bucket of a level (connectors whose lower level is this level). */
export function buildConnectorsBucket(ctx: BuildContext, levelId: Id): BucketBuild {
  const w = new MeshWriter()
  for (const c of ctx.ofType(levelId, "connector")) {
    w.begin(c.id)
    if (c.style === "ladder") writeLadder(w, ctx, c)
    else if (ctx.level(c.toLevelId)) writeStairsOrRamp(w, ctx, c)
    w.end()
  }
  const g = w.build()
  return { meshes: g ? [{ kind: "merged", name: "connectors", slot: "world", geometry: g }] : [] }
}
