/**
 * Hero illustration: an exploded isometric view of a real multi-level sample scene — every storey
 * as a floating plate with its floors, extruded walls, glowing lights and tokens. Built from the
 * scene document in pure SVG (no three.js in the home bundle).
 */
import * as React from "react"

import { sampleById } from "@/core/scene/samples"
import { levelDigest, Palette, type LevelDigest } from "@/app/sceneDigest"
import { sortedLevels } from "@/core/scene/queries"
import { cn } from "@/lib/utils"

const COS = Math.cos(Math.PI / 6)
const SIN = 0.5
const WALL_H = 7

interface Plate {
  digest: LevelDigest
  base: number
}

interface IsoModel {
  plates: Plate[]
  palette: string[]
  bounds: { x: number; z: number; w: number; d: number }
  viewBox: [number, number, number, number]
}

function buildModel(sampleId: string): IsoModel | null {
  const sample = sampleById(sampleId)
  if (!sample) return null
  const scene = sample.build()
  const palette = new Palette()
  const levels = sortedLevels(scene)
  const digests = levels.map((l) => levelDigest(scene, l.id, palette))

  // Frame the building (walls and stairs), not the whole yard.
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (const d of digests) {
    for (const [x1, z1, x2, z2] of d.walls) {
      minX = Math.min(minX, x1, x2)
      maxX = Math.max(maxX, x1, x2)
      minZ = Math.min(minZ, z1, z2)
      maxZ = Math.max(maxZ, z1, z2)
    }
  }
  if (!Number.isFinite(minX)) return null
  const m = 7
  const bounds = { x: minX - m, z: minZ - m, w: maxX - minX + 2 * m, d: maxZ - minZ + 2 * m }
  const plateH = (bounds.w + bounds.d) * SIN
  const gap = plateH * 0.62 + 10
  const plates = digests.map((digest, i) => ({ digest, base: i * gap }))

  const corners = [
    [bounds.x, bounds.z],
    [bounds.x + bounds.w, bounds.z],
    [bounds.x, bounds.z + bounds.d],
    [bounds.x + bounds.w, bounds.z + bounds.d],
  ]
  let vx0 = Infinity
  let vx1 = -Infinity
  let vy0 = Infinity
  let vy1 = -Infinity
  for (const p of plates) {
    for (const [x, z] of corners) {
      for (const y of [p.base, p.base + WALL_H]) {
        const [sx, sy] = iso(x, z, y)
        vx0 = Math.min(vx0, sx)
        vx1 = Math.max(vx1, sx)
        vy0 = Math.min(vy0, sy)
        vy1 = Math.max(vy1, sy)
      }
    }
  }
  const pad = 6
  return { plates, palette: palette.colors, bounds, viewBox: [vx0 - pad, vy0 - pad, vx1 - vx0 + 2 * pad, vy1 - vy0 + 2 * pad] }
}

function iso(x: number, z: number, y: number): [number, number] {
  return [(x - z) * COS, (x + z) * SIN - y]
}

function pts(list: Array<[number, number]>): string {
  return list.map(([a, b]) => `${a.toFixed(2)},${b.toFixed(2)}`).join(" ")
}

function clipRect(x: number, z: number, w: number, d: number, b: IsoModel["bounds"]): [number, number, number, number] | null {
  const x0 = Math.max(x, b.x)
  const z0 = Math.max(z, b.z)
  const x1 = Math.min(x + w, b.x + b.w)
  const z1 = Math.min(z + d, b.z + b.d)
  return x1 > x0 && z1 > z0 ? [x0, z0, x1 - x0, z1 - z0] : null
}

export const IsoLevels = React.memo(function IsoLevels({ className, sampleId = "crooked-lantern" }: { className?: string; sampleId?: string }) {
  const model = React.useMemo(() => buildModel(sampleId), [sampleId])
  const uid = React.useId().replace(/[^A-Za-z0-9_-]/g, "")
  if (!model) return null
  const { plates, palette, bounds, viewBox } = model
  const color = (i: number) => palette[i] ?? "#888888"

  return (
    <svg viewBox={viewBox.join(" ")} className={cn("block h-auto w-full", className)} aria-hidden="true">
      <defs>
        {palette.map((c, i) => (
          <radialGradient key={i} id={`${uid}-c${i}`}>
            <stop offset="0" stopColor={c} stopOpacity="0.9" />
            <stop offset="0.4" stopColor={c} stopOpacity="0.35" />
            <stop offset="1" stopColor={c} stopOpacity="0" />
          </radialGradient>
        ))}
      </defs>
      {plates.map(({ digest, base }, li) => {
        const plate: Array<[number, number]> = [
          iso(bounds.x, bounds.z, base),
          iso(bounds.x + bounds.w, bounds.z, base),
          iso(bounds.x + bounds.w, bounds.z + bounds.d, base),
          iso(bounds.x, bounds.z + bounds.d, base),
        ]
        const walls = digest.walls
          .map(([x1, z1, x2, z2]) => ({ x1, z1, x2, z2, depth: (x1 + x2 + z1 + z2) / 2 }))
          .filter(
            (w) =>
              Math.max(w.x1, w.x2) >= bounds.x &&
              Math.min(w.x1, w.x2) <= bounds.x + bounds.w &&
              Math.max(w.z1, w.z2) >= bounds.z &&
              Math.min(w.z1, w.z2) <= bounds.z + bounds.d
          )
          .sort((a, b) => a.depth - b.depth)
        const labelAt = iso(bounds.x, bounds.z + bounds.d, base)
        return (
          <g
            key={digest.levelId}
            className="animate-in duration-700 fade-in-0 fill-mode-both slide-in-from-bottom-3"
            style={{ animationDelay: `${li * 120}ms` }}
          >
            {/* Plate */}
            <polygon points={pts(plate)} className="fill-card stroke-foreground" fillOpacity={0.55} strokeOpacity={0.14} strokeWidth={0.6} />
            {/* Floors */}
            {digest.floors.map(([x, z, w, d, c], i) => {
              const r = clipRect(x, z, w, d, bounds)
              if (!r) return null
              const [rx, rz, rw, rd] = r
              return (
                <polygon
                  key={i}
                  points={pts([iso(rx, rz, base), iso(rx + rw, rz, base), iso(rx + rw, rz + rd, base), iso(rx, rz + rd, base)])}
                  fill={color(c)}
                  fillOpacity={0.5}
                />
              )
            })}
            <polygon points={pts(plate)} className="fill-background" fillOpacity={0.35} />
            {/* Light pools on the floor */}
            <g style={{ mixBlendMode: "screen" }}>
              {digest.lights.map(([x, z, dim, , c], i) => {
                const [cx, cy] = iso(x, z, base)
                const r = Math.min(dim, 30)
                return <ellipse key={i} cx={cx} cy={cy} rx={r * 1.2247} ry={r * 0.7071} fill={`url(#${uid}-c${c})`} opacity={0.9} />
              })}
            </g>
            {/* Walls, far to near */}
            {walls.map((w, i) => {
              const a = iso(w.x1, w.z1, base)
              const b = iso(w.x2, w.z2, base)
              const at = iso(w.x1, w.z1, base + WALL_H)
              const bt = iso(w.x2, w.z2, base + WALL_H)
              return (
                <g key={i}>
                  <polygon points={pts([a, b, bt, at])} className="fill-foreground" fillOpacity={0.13} />
                  <line
                    x1={at[0]}
                    y1={at[1]}
                    x2={bt[0]}
                    y2={bt[1]}
                    className="stroke-foreground"
                    strokeOpacity={0.75}
                    strokeWidth={0.9}
                    strokeLinecap="round"
                  />
                </g>
              )
            })}
            {/* Fixtures */}
            {digest.lights.map(([x, z, , , c], i) => {
              const [cx, cy] = iso(x, z, base + 4)
              return (
                <g key={i} className="animate-pulse" style={{ animationDuration: `${2.2 + (i % 5) * 0.37}s` }}>
                  <circle cx={cx} cy={cy} r={3.2} fill={`url(#${uid}-c${c})`} />
                  <circle cx={cx} cy={cy} r={0.85} fill={color(c)} />
                </g>
              )
            })}
            {/* Tokens */}
            {digest.tokens.map(([x, z, r, c], i) => {
              const [cx, cy] = iso(x, z, base)
              return (
                <g key={i}>
                  <ellipse cx={cx} cy={cy} rx={r * 1.2247} ry={r * 0.7071} fill={color(c)} className="stroke-background" strokeWidth={0.5} />
                  <line x1={cx} y1={cy} x2={cx} y2={cy - 4} stroke={color(c)} strokeWidth={0.8} />
                  <circle cx={cx} cy={cy - 4.6} r={1.1} fill={color(c)} />
                </g>
              )
            })}
            <text x={labelAt[0] - 4} y={labelAt[1] + 1.5} textAnchor="end" className="fill-muted-foreground font-sans" fontSize={6.4} letterSpacing={0.3}>
              {digest.name}
            </text>
          </g>
        )
      })}
    </svg>
  )
})
