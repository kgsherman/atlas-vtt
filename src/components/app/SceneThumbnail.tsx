/**
 * Top-down schematic of a scene level from its digest: floors tinted by material, a "night" veil,
 * light pools in their own colours, walls, doors, windows, props and tokens. When the level has a
 * map image, the image is the floor. Pure SVG (no three.js), crisp at any size.
 */
import * as React from "react"

import type { LevelDigest } from "@/app/sceneDigest"
import { cn } from "@/lib/utils"

export interface SceneThumbnailProps {
  level: LevelDigest
  palette: string[]
  cellSize: number
  /** Data URL of the level's map image (drawn under everything). */
  image?: string | null
  className?: string
  /** Darker veil + stronger light pools (hero), or the card default. */
  mood?: "card" | "night"
}

function svgId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9_-]/g, "")
}

export const SceneThumbnail = React.memo(function SceneThumbnail({ level, palette, cellSize, image, className, mood = "card" }: SceneThumbnailProps) {
  const uid = svgId(React.useId())
  const [bx, bz, bw, bd] = level.bounds
  const color = (i: number) => palette[i] ?? "#888888"
  const veil = image ? 0.16 : mood === "night" ? 0.62 : 0.5
  // Hairline widths scale with the map so small and huge scenes read alike.
  const hair = Math.max(bw, bd) / 400
  const hasFloors = level.floors.length > 0

  return (
    <svg
      viewBox={`${bx} ${bz} ${bw} ${bd}`}
      preserveAspectRatio="xMidYMid meet"
      className={cn("block size-full", className)}
      role="img"
      aria-label={`Top-down view of ${level.name || "the scene"}`}
    >
      <defs>
        <pattern id={`${uid}-grid`} width={cellSize} height={cellSize} patternUnits="userSpaceOnUse" x={0} y={0}>
          <path d={`M ${cellSize} 0 L 0 0 0 ${cellSize}`} fill="none" className="stroke-foreground" strokeOpacity={0.09} strokeWidth={hair * 0.8} />
        </pattern>
        {level.lights.map(([, , dim, bright, c], i) => {
          const b = dim > 0 ? Math.min(0.95, bright / dim) : 0.5
          return (
            <radialGradient key={i} id={`${uid}-l${i}`}>
              <stop offset="0" stopColor={color(c)} stopOpacity={mood === "night" ? 0.62 : 0.5} />
              <stop offset={b} stopColor={color(c)} stopOpacity={mood === "night" ? 0.26 : 0.2} />
              <stop offset="1" stopColor={color(c)} stopOpacity={0} />
            </radialGradient>
          )
        })}
      </defs>

      {/* Not clipped to the framing box: whatever surrounds it (a yard, the rest of the map) fills the
          letterbox when the frame's aspect differs from the card's. */}
      <g>
        {image && level.backdrop && (
          <image
            href={image}
            x={level.backdrop.rect[0]}
            y={level.backdrop.rect[1]}
            width={level.backdrop.rect[2]}
            height={level.backdrop.rect[3]}
            preserveAspectRatio="none"
          />
        )}
        {!image && level.floors.map(([x, z, w, d, c], i) => <rect key={i} x={x} y={z} width={w} height={d} fill={color(c)} fillOpacity={0.92} />)}
        {!image && hasFloors && level.floors.map(([x, z, w, d], i) => <rect key={`g${i}`} x={x} y={z} width={w} height={d} fill={`url(#${uid}-grid)`} />)}

        {/* Night veil, then light pools on top of it. */}
        <rect x={bx - bw * 2} y={bz - bd * 2} width={bw * 5} height={bd * 5} className="fill-background" fillOpacity={veil} />
        <g style={{ mixBlendMode: "screen" }}>
          {level.lights.map(([x, z, dim], i) => (
            <circle key={i} cx={x} cy={z} r={Math.max(dim, 1)} fill={`url(#${uid}-l${i})`} />
          ))}
        </g>

        {level.connectors.map(([x, z, w, d, style], i) => (
          <g key={`c${i}`}>
            <rect
              x={x}
              y={z}
              width={w}
              height={d}
              className="fill-foreground stroke-foreground"
              fillOpacity={0.08}
              strokeOpacity={0.45}
              strokeWidth={hair}
              strokeDasharray={style === 1 ? undefined : `${hair * 3} ${hair * 2}`}
            />
          </g>
        ))}

        {level.props.map(([x, z, w, d, deg, c], i) => (
          <rect
            key={`p${i}`}
            x={x - w / 2}
            y={z - d / 2}
            width={w}
            height={d}
            rx={Math.min(w, d) * 0.15}
            fill={color(c)}
            fillOpacity={image ? 0.55 : 0.9}
            transform={deg ? `rotate(${-deg} ${x} ${z})` : undefined}
            className="stroke-background"
            strokeOpacity={0.5}
            strokeWidth={hair * 0.6}
          />
        ))}

        <g className="stroke-foreground" strokeLinecap="square" strokeOpacity={image ? 0.4 : 0.88}>
          {level.walls.map(([x1, z1, x2, z2, t], i) => (
            <line key={`w${i}`} x1={x1} y1={z1} x2={x2} y2={z2} strokeWidth={Math.max(t, hair * 2.2)} />
          ))}
        </g>
        <g className="stroke-muted-foreground" strokeLinecap="butt" strokeOpacity={0.95}>
          {level.windows.map(([x1, z1, x2, z2, t], i) => (
            <line key={`n${i}`} x1={x1} y1={z1} x2={x2} y2={z2} strokeWidth={Math.max(t * 0.55, hair * 1.4)} />
          ))}
        </g>
        <g className="stroke-primary" strokeLinecap="butt">
          {level.doors.map(([x1, z1, x2, z2, t], i) => (
            <line key={`d${i}`} x1={x1} y1={z1} x2={x2} y2={z2} strokeWidth={Math.max(t * 1.25, hair * 2.6)} />
          ))}
        </g>
        <g className="fill-foreground" fillOpacity={0.8}>
          {level.pillars.map(([x, z, r, square], i) =>
            square ? <rect key={`q${i}`} x={x - r} y={z - r} width={r * 2} height={r * 2} /> : <circle key={`q${i}`} cx={x} cy={z} r={r} />
          )}
        </g>

        {/* Fixtures: a bright core for every light. */}
        {level.lights.map(([x, z, , , c], i) => (
          <circle key={`f${i}`} cx={x} cy={z} r={Math.max(hair * 2.5, 0.45)} fill={color(c)} />
        ))}

        {level.tokens.map(([x, z, r, c], i) => (
          <circle key={`t${i}`} cx={x} cy={z} r={r} fill={color(c)} className="stroke-background" strokeWidth={Math.max(r * 0.22, hair)} />
        ))}
      </g>
    </svg>
  )
})
