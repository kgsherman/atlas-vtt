/**
 * HTML markers over the map, placed with Engine.project on every frame (no React render per frame):
 *  - PingLayer: pings as expanding rings with the pinger's name; one off screen shows at the edge with
 *    an arrow toward it. A "look here" ping (the DM's Shift + long press) also centres the camera;
 *  - TokenBadges: health bars under tokens and condition icons at their top-right (clear of the turn
 *    marker's label above the acting token);
 *  - TurnMarker: a slowly turning ring around the token whose turn it is (following it as it walks),
 *    under the HUD panels (z-5; the HUD is z-10). Pings stay above them (z-15): they are brief.
 */
import * as React from "react"
import { ArrowUp } from "lucide-react"

import { useEngine } from "@/components/canvas/engineContext"
import { CONDITION_LABELS } from "@/core/scene/tokenStatus"
import type { Id, SceneLike, Vec3 } from "@/core/scene/types"
import { cn } from "@/lib/utils"
import { groundY } from "@/play"

import { HealthBar } from "./health"
import type { BadgeToken } from "./healthModel"
import { CONDITION_ICONS } from "./healthStyle"

export interface MapPing {
  levelId: Id
  x: number
  z: number
  name: string
  /** The pinger's colour ("" for our own: the accent colour). */
  color: string
  focus: boolean
  mine: boolean
}

/** How long a ping stays on screen (ms). */
export const PING_LIFETIME_MS = 2600
/** Keep edge markers this far inside the canvas (CSS px). */
const EDGE = 28

interface LivePing {
  key: number
  ping: MapPing
  at: Vec3
}

export function PingLayer({
  subscribe,
  scene,
  onFocus,
}: {
  subscribe: (cb: (p: MapPing) => void) => () => void
  scene: SceneLike | null
  /** A focus ping arrived: centre the camera there. */
  onFocus?: (point: Vec3) => void
}) {
  const { engine, canvas } = useEngine()
  const [pings, setPings] = React.useState<LivePing[]>([])
  const sceneRef = React.useRef(scene)
  const focusRef = React.useRef(onFocus)
  React.useEffect(() => {
    sceneRef.current = scene
    focusRef.current = onFocus
  })
  const nodes = React.useRef(new Map<number, HTMLDivElement>())

  React.useEffect(() => {
    let next = 0
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const off = subscribe((ping) => {
      const s = sceneRef.current
      const y = s ? groundY(s, ping.levelId, { x: ping.x, z: ping.z }) : 0
      const live: LivePing = {
        key: ++next,
        ping,
        at: { x: ping.x, y, z: ping.z },
      }
      setPings((list) => [...list.slice(-15), live])
      if (ping.focus && !ping.mine) focusRef.current?.(live.at)
      const t = setTimeout(() => {
        timers.delete(t)
        setPings((list) => list.filter((p) => p.key !== live.key))
      }, PING_LIFETIME_MS)
      timers.add(t)
    })
    return () => {
      off()
      for (const t of timers) clearTimeout(t)
    }
  }, [subscribe])

  React.useEffect(() => {
    if (!engine || !canvas || pings.length === 0) return
    const place = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      for (const p of pings) {
        const el = nodes.current.get(p.key)
        if (!el) continue
        const s = engine.project(p.at)
        const inside =
          s.visible &&
          s.x >= EDGE &&
          s.y >= EDGE &&
          s.x <= w - EDGE &&
          s.y <= h - EDGE
        let x = s.x
        let y = s.y
        if (!inside) {
          // Behind the camera the projection mirrors: point from the centre the other way.
          const dx = (s.visible ? s.x : w - s.x) - w / 2
          const dy = (s.visible ? s.y : h - s.y) - h / 2
          const k = Math.min(
            (w / 2 - EDGE) / Math.max(Math.abs(dx), 1e-6),
            (h / 2 - EDGE) / Math.max(Math.abs(dy), 1e-6)
          )
          x = w / 2 + dx * k
          y = h / 2 + dy * k
          el.style.setProperty(
            "--ping-angle",
            `${Math.atan2(dy, dx) + Math.PI / 2}rad`
          )
        }
        el.dataset.edge = inside ? "false" : "true"
        el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
        el.style.visibility = "visible"
      }
    }
    place()
    return engine.onFrame(place)
  }, [engine, canvas, pings])

  return (
    <div
      className="pointer-events-none absolute inset-0 z-[15] overflow-hidden"
      aria-live="polite"
    >
      {pings.map((p) => {
        const color = p.ping.color || "var(--sidebar-primary)"
        return (
          <div
            key={p.key}
            ref={(el) => {
              if (el) nodes.current.set(p.key, el)
              else nodes.current.delete(p.key)
            }}
            className="group absolute top-0 left-0"
            style={{ visibility: "hidden", ["--ping-color" as string]: color }}
            data-slot="map-ping"
          >
            <span className="absolute -top-5 -left-5 size-10 animate-[ping_1.1s_cubic-bezier(0,0,0.2,1)_infinite] rounded-full border-2 border-[color:var(--ping-color)] group-data-[edge=true]:hidden" />
            <span className="absolute -top-5 -left-5 size-10 animate-[ping_1.1s_cubic-bezier(0,0,0.2,1)_0.35s_infinite] rounded-full border-2 border-[color:var(--ping-color)] opacity-70 group-data-[edge=true]:hidden" />
            <span className="absolute -top-1.5 -left-1.5 size-3 rounded-full bg-[var(--ping-color)] shadow-[0_0_12px_var(--ping-color)]" />
            <span className="absolute -top-4 -left-4 hidden size-8 place-items-center rounded-full bg-card/85 shadow-md ring-2 ring-[color:var(--ping-color)] group-data-[edge=true]:grid">
              <ArrowUp
                className="size-4 text-[color:var(--ping-color)]"
                style={{ transform: "rotate(var(--ping-angle, 0rad))" }}
              />
            </span>
            <span className="absolute top-5 left-0 -translate-x-1/2 rounded-full bg-card/85 px-2 py-0.5 text-[0.6875rem] font-medium whitespace-nowrap text-foreground shadow-md">
              {p.ping.mine ? "You" : p.ping.name}
              {p.ping.focus ? " · look here" : ""}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The ring around the acting token. `radiusFt`: the token's footprint radius. `showOn`: whether a level
 * is drawn right now (cutaway), else the ring hides.
 */
export function TurnMarker({
  tokenId,
  radiusFt,
  label,
  mine,
  showOn,
}: {
  tokenId: Id | null
  radiusFt: number
  label: string
  mine: boolean
  showOn: (levelId: Id) => boolean
}) {
  const { engine, canvas } = useEngine()
  const ref = React.useRef<HTMLDivElement>(null)
  const showRef = React.useRef(showOn)
  React.useEffect(() => {
    showRef.current = showOn
  })

  React.useEffect(() => {
    if (!engine || !canvas || !tokenId) return
    const place = () => {
      const el = ref.current
      if (!el) return
      const at = engine.tokenDrawnAt(tokenId)
      if (!at || !showRef.current(at.levelId)) {
        el.style.visibility = "hidden"
        return
      }
      const c = engine.project(at.position)
      const e = engine.project({
        x: at.position.x + radiusFt,
        y: at.position.y,
        z: at.position.z,
      })
      if (!c.visible) {
        el.style.visibility = "hidden"
        return
      }
      // Outside the engine's selection ring, so both show.
      const r = Math.max(16, Math.hypot(e.x - c.x, e.y - c.y) * 1.3 + 6)
      el.style.transform = `translate(${Math.round(c.x)}px, ${Math.round(c.y)}px)`
      el.style.setProperty("--turn-r", `${r}px`)
      el.style.visibility = "visible"
    }
    place()
    return engine.onFrame(place)
  }, [engine, canvas, tokenId, radiusFt])

  if (!tokenId) return null
  return (
    <div
      ref={ref}
      className="pointer-events-none absolute top-0 left-0 z-[5]"
      style={{ visibility: "hidden" }}
      data-slot="turn-marker"
    >
      <span
        className={cn(
          "absolute animate-[spin_9s_linear_infinite] rounded-full border-2 border-dashed",
          mine ? "border-sidebar-primary" : "border-foreground/80"
        )}
        style={{
          top: "calc(var(--turn-r) * -1)",
          left: "calc(var(--turn-r) * -1)",
          width: "calc(var(--turn-r) * 2)",
          height: "calc(var(--turn-r) * 2)",
        }}
      />
      <span
        className={cn(
          "absolute left-0 -translate-x-1/2 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium whitespace-nowrap shadow-md",
          mine
            ? "bg-sidebar-primary text-sidebar-primary-foreground"
            : "bg-card/85 text-foreground"
        )}
        style={{ top: "calc(var(--turn-r) * -1 - 1.4rem)" }}
      >
        {label}
      </span>
    </div>
  )
}

/** Condition icons shown above a token; beyond this, "+n". */
const MAX_BADGE_ICONS = 4

/**
 * Health bars under tokens and condition icons above them (DM: every token's exact hit points; players:
 * their own exactly, others as the band the host sends). Under the HUD (z-5), placed every frame.
 * Pass a memoised `tokens` array (a new one re-registers the frame callback).
 */
export function TokenBadges({
  tokens,
  showOn,
}: {
  tokens: readonly BadgeToken[]
  showOn: (levelId: Id) => boolean
}) {
  const { engine, canvas } = useEngine()
  const nodes = React.useRef(new Map<Id, HTMLDivElement>())
  const showRef = React.useRef(showOn)
  React.useEffect(() => {
    showRef.current = showOn
  })
  const shown = React.useMemo(
    () =>
      tokens.filter(
        (t) => t.hp || t.band || (t.conditions && t.conditions.length > 0)
      ),
    [tokens]
  )

  React.useEffect(() => {
    if (!engine || !canvas || shown.length === 0) return
    const place = () => {
      for (const t of shown) {
        const el = nodes.current.get(t.id)
        if (!el) continue
        const at = engine.tokenDrawnAt(t.id)
        const c = at ? engine.project(at.position) : null
        if (!at || !c || !c.visible || !showRef.current(at.levelId)) {
          el.style.visibility = "hidden"
          continue
        }
        const e = engine.project({
          x: at.position.x + t.radiusFt,
          y: at.position.y,
          z: at.position.z,
        })
        const r = Math.max(10, Math.hypot(e.x - c.x, e.y - c.y))
        el.style.transform = `translate(${Math.round(c.x)}px, ${Math.round(c.y)}px)`
        el.style.setProperty("--badge-r", `${Math.round(r)}px`)
        el.style.visibility = "visible"
      }
    }
    place()
    return engine.onFrame(place)
  }, [engine, canvas, shown])

  if (shown.length === 0) return null
  return (
    <div
      className="pointer-events-none absolute inset-0 z-[5] overflow-hidden"
      data-slot="token-badges"
    >
      {shown.map((t) => {
        const conditions = t.conditions ?? []
        const extra = conditions.length - MAX_BADGE_ICONS
        return (
          <div
            key={t.id}
            ref={(el) => {
              if (el) nodes.current.set(t.id, el)
              else nodes.current.delete(t.id)
            }}
            className="absolute top-0 left-0"
            style={{ visibility: "hidden" }}
            data-token={t.id}
          >
            {t.hp || t.band ? (
              <div
                className="absolute"
                style={{
                  top: "calc(var(--badge-r) + 3px)",
                  left: "calc(clamp(24px, var(--badge-r) * 2, 96px) / -2)",
                  width: "clamp(24px, calc(var(--badge-r) * 2), 96px)",
                }}
              >
                <HealthBar
                  hp={t.hp}
                  band={t.band}
                  className="h-1 shadow-sm ring-1 ring-background/60"
                />
              </div>
            ) : null}
            {conditions.length > 0 ? (
              <div
                className="absolute flex items-center gap-0.5 rounded-full bg-card/85 px-1 py-0.5 shadow-sm"
                style={{
                  left: "calc(var(--badge-r) * 0.5)",
                  bottom: "calc(var(--badge-r) * 0.6)",
                }}
                aria-label={conditions
                  .map((c) => CONDITION_LABELS[c])
                  .join(", ")}
              >
                {conditions.slice(0, MAX_BADGE_ICONS).map((c) => {
                  const Icon = CONDITION_ICONS[c]
                  return (
                    <Icon
                      key={c}
                      className="size-3 text-foreground"
                      aria-hidden
                    />
                  )
                })}
                {extra > 0 ? (
                  <span className="text-[0.5625rem] font-medium">+{extra}</span>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
